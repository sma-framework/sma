/**
 * ТИШИНА — НЕ СМЕРТЬ: ПРОВОД ОТ ЖИВОГО ПРОЦЕССА ДО РЕШЕНИЯ СТОРОЖА.
 *
 * ПОВОД. Три попытки владельца подряд сгорели в `failed`, пока работник ЧЕСТНО ДУМАЛ. Аренда
 * продлевалась ровно из одного места — потока вывода (loop.mjs, `touch` внутри onLine), — а
 * сторож (liveness.mjs) читал только часы: `lastTouch = leaseRenewedAt ?? claimedAt` против
 * `expireMs`. Признака «ЖИВ ЛИ ПРОЦЕСС» у него не было вовсе, поэтому работник, молчавший
 * дольше срока аренды, был неотличим от повисшего — и его хоронили за работой.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ. Не «есть флаг alive» и не «свёртка умеет ветвиться» — ПРОВОД:
 * настоящий дочерний процесс, настоящий `spawnWorker`, настоящий реестр ручек, настоящий
 * `steeredSpawn` и настоящая свёртка `livenessSweep`. Между ними нет ни одной заглушки:
 * заглушен только сток (fake adapter — тот же, что у соседнего сьюта, он повторяет семантику
 * pg-boss «провал → та же строка обратно в очередь с attempt+1»).
 *
 * ПОЧЕМУ ПРОЦЕСС НАСТОЯЩИЙ. Подделанный `alive: () => true` доказал бы, что свёртка читает
 * поле, которое сама же и получила, — то есть ничего. Здесь живость приходит от ОС: ребёнок
 * рождается, молчит, потом умирает, и `alive()` меняет ответ потому, что изменился мир, а не
 * потому, что тест переписал переменную.
 *
 * ЧЕТЫРЕ СЛУЧАЯ — ПО ОДНОМУ НА КАЖДЫЙ ИСХОД:
 *   (1) ЖИВ + НОЛЬ ВЫВОДА  → аренда продлена, попытка не тронута, в леджере пусто;
 *   (2) МЁРТВ              → перевыдана, и причина названа своим именем `worker_process_gone`,
 *                            а НЕ общим ярлыком `liveness_killed`;
 *   (3) ЖИВ, но перерос потолок MAX_ATTEMPT_LIFETIME_MS → `attempt_lifetime_exceeded`, и
 *                            ребёнок ДЕЙСТВИТЕЛЬНО остановлен — молчание не становится вечным;
 *   (4) ручка НЕИЗВЕСТНА (чужая машина, переживший рестарт демон) → `liveness_killed`: слово,
 *                            которым этот случай назывался и раньше, за ним и остаётся.
 *
 * И ДВА СЛУЧАЯ, ДОБАВЛЕННЫЕ ПОСЛЕ 31.08, — оба про то, как живой процесс переживал вердикт:
 *   (5) ЖИВ, но ПРОБА СЛОМАНА (хелпер не запустился) → приговора нет вовсе, процесс не тронут;
 *   (6) ЖИВ и ОСТАНОВКА ЕГО НЕ УБИЛА → строка не закрывается, место остаётся занятым — учёт и
 *                            машина не расходятся.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { livenessSweep, MAX_ATTEMPT_LIFETIME_MS, PROBE_BROKEN } from '../src/queue/liveness.mjs'
import { spawnWorker } from '../src/runner/spawn.mjs'
import { createInFlight } from '../src/queue/in-flight.mjs'
import { createTurnRegistry } from '../src/front/chat.mjs'
import { steeredSpawn } from '../src/loop.mjs'
import { FAIL_REASONS, REASON_LABELS } from '../src/queue/adapter.mjs'

// ── временный мир и уборка настоящих детей ─────────────────────────────────────────────────

const dirs: string[] = []
const kids: Array<{ kill: () => void }> = []
const mkDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'liveness-wire-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const k of kids) {
    try {
      k.kill()
    } catch {
      /* уборка не роняет сьют */
    }
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// Тот же сток, что у соседнего сьюта: провал = та же строка обратно в очередь с attempt+1,
// плюс durable-строка попытки через леджер — ровно то, что делает pgboss-backend.fail().
function makeFakeAdapter({ clock, ledger }: { clock: () => number; ledger?: any }) {
  const now = () => clock()
  const recs = new Map<string, any>()
  const failCalls: Array<{ id: string; reason: string }> = []
  return {
    _seed(rec: any) {
      recs.set(rec.id, { ...rec })
    },
    _failCalls: failCalls,
    async list() {
      return [...recs.values()].map((r) => ({ ...r }))
    },
    async fail(id: string, reason: string) {
      failCalls.push({ id, reason }) // ЧЕМ позвали очередь — первая половина провода
      const r = recs.get(id)
      if (!r) return false
      if (ledger && typeof ledger.recordAttempt === 'function') {
        ledger.recordAttempt({ taskId: id, attempt: r.attempt, outcome: 'failed', failureReason: reason })
      }
      if (r.attempt < (r.maxAttempts ?? 3)) {
        r.status = 'queued'
        r.attempt += 1
        r.claimedAt = null
        r.leaseRenewedAt = null
      } else {
        r.status = 'failed'
        r.failure_reason = reason
      }
      return true
    },
    async touch(id: string) {
      const r = recs.get(id)
      if (r && r.status === 'claimed') {
        r.leaseRenewedAt = now()
        return true
      }
      return false
    },
  }
}

function makeFakeLedger() {
  const rows: any[] = []
  return {
    recordAttempt: (a: any) => (rows.push(a), a),
    readAttempts: (taskId: string) => rows.filter((r) => r.taskId === taskId),
  }
}

/**
 * Настоящий ребёнок через настоящий `spawnWorker`, зарегистрированный настоящим `steeredSpawn`
 * в настоящем реестре ручек — то есть ровно та цепочка, которой собирается демон.
 *
 * `script` — тело для `node -e`. Молчащий ребёнок НИЧЕГО не печатает: это и есть условие задачи
 * («нулевой вывод»), и `lines` рядом доказывает, что вывода действительно не было.
 */
function liveAttempt(taskId: string, script: string) {
  const registry = createTurnRegistry()
  const lines: string[] = []
  const exited = { done: false }
  let handle: any = null
  const waitExit = new Promise<void>((resolve) => {
    const spawn = steeredSpawn({ attemptTurns: registry }, taskId, spawnWorker)
    handle = spawn({
      bin: process.execPath,
      args: ['-e', script],
      cwd: mkDir(),
      env: { ...process.env },
      onLine: (l: string) => lines.push(l),
      onExit: () => {
        exited.done = true
        resolve()
      },
    })
    kids.push(handle)
  })
  return { registry, lines, waitExit, exited, handle }
}

const claimed = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'x',
  lane: 'prod',
  status: 'claimed',
  attempt: 1,
  claimedAt: 1000,
  leaseRenewedAt: 1000,
  ...over,
})

describe('сторож живости не убивает честное молчание — провод от живого процесса', () => {
  it('(1) ЖИВОЙ процесс при НУЛЕВОМ выводе продлевает аренду: попытка не тронута, в леджере пусто', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-think' }))

    // Настоящий ребёнок, который ДУМАЕТ МОЛЧА: живёт и не печатает ни строки.
    const a = liveAttempt('BL-think', 'setTimeout(() => {}, 60000)')
    // Живость — от ОС, через настоящую ручку; это НЕ флаг, поставленный тестом.
    expect(a.registry.alive('BL-think'), 'настоящий живой ребёнок не опознан как живой').toBe(true)

    // Молчание ДОЛЬШЕ СРОКА АРЕНДЫ — ровно тот случай, что хоронил работников.
    c.advance(500000) // expireMs = 120000

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: a.registry,
    })

    // ВЫВОДА НЕ БЫЛО ВОВСЕ — иначе доказывали бы не то: продление из потока и так работало.
    expect(a.lines, 'ребёнок что-то напечатал — тогда это не случай «нулевого вывода»').toEqual([])
    expect(res.requeued, 'живого молчуна перевыдали — это и есть починяемый дефект').toBe(0)
    expect(res.renewed).toBe(1)
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed') // попытка осталась своей
    expect(row.attempt).toBe(1) // и её не перевыдавали
    expect(row.leaseRenewedAt, 'аренда не продлена — сторож промолчал вместо продления').toBe(c.clock())
    // Ни одной строки попытки: провала не было, значит и хоронить нечего.
    expect(ledger.readAttempts('BL-think')).toHaveLength(0)
    expect(adapter._failCalls).toEqual([])
  })

  it('(2) МЁРТВЫЙ процесс перевыдаётся, и причина названа СВОИМ именем — worker_process_gone', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-dead' }))

    // Настоящий ребёнок, который СРАЗУ УМИРАЕТ; ждём подтверждения от ОС, а не таймера.
    const a = liveAttempt('BL-dead', '')
    await a.waitExit
    expect(a.registry.alive('BL-dead'), 'ОС сообщила о смерти, а ручка этого не заметила').toBe(false)

    c.advance(500000)

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: a.registry,
    })

    expect(res.requeued).toBe(1)
    expect(res.renewed).toBe(0) // мёртвому аренду НЕ продлевают
    // ПРОВОД ЦЕЛИКОМ: с чем позвали очередь — то и лежит в durable-строке, которую прочитает человек.
    expect(adapter._failCalls).toEqual([{ id: 'BL-dead', reason: 'worker_process_gone' }])
    const [attemptRow] = ledger.readAttempts('BL-dead')
    expect(attemptRow.failureReason).toBe('worker_process_gone')
    // И это НЕ общий ярлык: смерть процесса и молчание неопознанного — разные факты.
    expect(attemptRow.failureReason).not.toBe('liveness_killed')
    expect(attemptRow.failureReason).not.toBe('runtime_offline')
  })

  it('(3) ЖИВОЙ, но переросший потолок, останавливается своим именем — молчание не становится вечным', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-forever' }))

    const a = liveAttempt('BL-forever', 'setTimeout(() => {}, 60000)')
    expect(a.registry.alive('BL-forever')).toBe(true)

    // Переваливаем ЗА потолок: попытка всё ещё жива, но своё время выбрала.
    c.advance(MAX_ATTEMPT_LIFETIME_MS + 60000)

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: a.registry,
    })

    expect(res.renewed, 'потолок не сработал — живой продлевался бы вечно').toBe(0)
    expect(res.requeued).toBe(1)
    expect(adapter._failCalls).toEqual([{ id: 'BL-forever', reason: 'attempt_lifetime_exceeded' }])
    // И РЕБЁНОК ДЕЙСТВИТЕЛЬНО ОСТАНОВЛЕН, а не только объявлен мёртвым: закрытая строка при
    // живом процессе — та самая форма, из-за которой два работника берутся за одну задачу.
    await a.waitExit
    expect(a.exited.done).toBe(true)
    expect(a.registry.alive('BL-forever')).not.toBe(true)
  })

  it('(4) ручка НЕИЗВЕСТНА (чужая машина / переживший рестарт демон) → прежнее слово liveness_killed', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-orphan' }))

    // Реестр НАСТОЯЩИЙ, но эту попытку он не регистрировал — ровно как после рестарта демона.
    const registry = createTurnRegistry()
    expect(registry.alive('BL-orphan'), '«не знаю» подменено на «мёртв» — это стоит чужой работы').toBe(null)

    c.advance(500000)

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, attemptTurns: registry })

    expect(res.requeued).toBe(1)
    expect(adapter._failCalls).toEqual([{ id: 'BL-orphan', reason: 'liveness_killed' }])
  })

  it('(5) СЛОМАННАЯ ПРОБА при ЖИВОМ процессе — попытка не объявляется мёртвой, и процесс остаётся жив', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-probe' }))

    // Настоящий живой ребёнок — и НАСТОЯЩИЙ реестр, в котором пробник БРОСАЕТ. Ровно то, что
    // случилось 31.08: под хелпером исчез склад модулей, проба перестала состояться, а процесс
    // работал. Ручка остановки при этом рабочая: сторож МОГ БЫ убить — и не должен.
    const registry = createTurnRegistry()
    const child = spawnWorker({
      bin: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: mkDir(),
      env: { ...process.env },
    })
    kids.push(child)
    registry.register(
      'BL-probe',
      () => child.kill(),
      () => {
        throw new Error('пробник не запустился: нет модулей склада')
      },
    )
    // ПЕРВАЯ ПОЛОВИНА ПРОВОДА: реестр называет поломку пробы своим словом, а не «не знаю».
    expect(registry.alive('BL-probe'), 'сломанная проба снова выдаёт себя за «сказать нечего»').toBe(PROBE_BROKEN)

    c.advance(500000) // молчит дольше срока аренды

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: registry,
      sleep: async () => {},
    })

    // ВТОРАЯ ПОЛОВИНА: приговора нет вовсе — ни перевыдачи, ни строки попытки.
    expect(res.probeBroken).toBe(1)
    expect(res.requeued, 'живую попытку снова похоронили по часам, потому что сломался пробник').toBe(0)
    expect(adapter._failCalls).toEqual([])
    expect(ledger.readAttempts('BL-probe')).toHaveLength(0)
    // И ПРОЦЕСС ЖИВ: сторож его не тронул. Проверяется у ОС через ту же ручку, что и везде.
    expect(child.alive(), 'процесс убит по несостоявшейся пробе — это и есть сожжённое окно').toBe(true)
    child.kill()
  })

  it('(6) остановка НЕ убила — строка остаётся своей, место и доска не расходятся', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-stubborn' }))

    // Дом мест — НАСТОЯЩИЙ, и место занято этой самой задачей: «занято 1 из 1».
    const house = createInFlight()
    const seat = house.reserve(1)
    house.name(seat, 'BL-stubborn', 'max-1')

    // Живой ребёнок, настоящая проба — и ОСТАНОВКА, КОТОРАЯ НЕ УБИВАЕТ. Ровно та форма, что
    // видел человек: дверь ответила «killed», а процесс на машине остался.
    const registry = createTurnRegistry()
    const child = spawnWorker({
      bin: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: mkDir(),
      env: { ...process.env },
    })
    kids.push(child)
    registry.register(
      'BL-stubborn',
      () => {
        /* остановка, которая не доходит до процесса */
      },
      () => child.alive() === true,
    )

    c.advance(MAX_ATTEMPT_LIFETIME_MS + 60000) // за потолком: приговор законен, гашение — нет

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: registry,
      sleep: async () => {},
    })

    expect(res.killUnconfirmed).toBe(1)
    expect(res.requeued).toBe(0)
    expect(adapter._failCalls).toEqual([])
    expect(child.alive()).toBe(true) // процесс правда пережил остановку — иначе дело не про это
    // МЕСТО И СТРОКА ГОВОРЯТ ОДНО И ТО ЖЕ. Освобождение места — дело конца процесса (тик отдаёт
    // его в своём `finally`), и вердикт сторожа его не трогает: разошлись бы они ровно тогда,
    // когда строка закрыта, а процесс жив, — то есть в единственном случае, где это дорого.
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed')
    expect(house.size(), 'место отдано по вердикту, а не по смерти процесса').toBe(1)
    expect(house.workers().has('max-1')).toBe(true)
    child.kill()
  })

  it('потолок жизни попытки — ОДНО число в ОДНОМ месте, и все три слова признаны словарём', () => {
    // Одно место: свёртка экспортирует его, и никто рядом не держит собственную копию.
    expect(MAX_ATTEMPT_LIFETIME_MS).toBe(4 * 60 * 60 * 1000)
    // Слова закрытого словаря: `fail()` бросает на неизвестном, поэтому непризнанный
    // приговор уронил бы весь обход — и каждое несёт человеческую подпись для карточки.
    for (const w of ['worker_process_gone', 'attempt_lifetime_exceeded', 'liveness_killed']) {
      expect(FAIL_REASONS, `слово ${w} не признано словарём`).toContain(w)
      expect(REASON_LABELS[w], `у слова ${w} нет подписи для карточки`).toBeTruthy()
    }
    // И подписи РАЗНЫЕ: одинаковый текст вернул бы человека к общему ярлыку.
    expect(REASON_LABELS.worker_process_gone).not.toBe(REASON_LABELS.liveness_killed)
    expect(REASON_LABELS.attempt_lifetime_exceeded).not.toBe(REASON_LABELS.liveness_killed)
  })
})
