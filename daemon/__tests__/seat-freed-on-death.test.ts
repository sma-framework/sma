/**
 * МЕСТО ДЕРЖИТ ЖИВОЙ ПРОЦЕСС — И ОТДАЁТСЯ ОНО В МОМЕНТ ЕГО СМЕРТИ.
 *
 * ═══════════════ ЧТО ЛОМАЛОСЬ, ИЗМЕРЕННОЕ НА ЖИВОМ ДНЕ ══════════════════════════════
 * Две идущие попытки были сняты дверью отмены. Дверь ответила про каждую «строка закрыта,
 * ребёнок убит, попытка закрылась»; процессы добиты рукой, в системе не осталось ни одного.
 * И следующие три минуты тик писал одну и ту же строку 282 раза: «идущих попыток 4 при
 * потолке 4 — задача не берётся». Пять строк ждали в очереди, третий работник стоял
 * свободным, конвейер стоял.
 *
 * ДИАГНОЗ. «Попытка закрылась» в ответе двери и «идущих попыток» в тике были ДВА РАЗНЫХ
 * СЧЁТА одного факта. Место отдавалось ТОЛЬКО последним `finally` прохода, то есть после
 * ворот — маркера, квитанции, переповерки, коммитов, свода, — а ворота идут минутами, и
 * процесса на них уже нет. Пока счётчики совпадали, второй казался безобидным; разошлись
 * они ровно в тот момент, когда от них зависело, поедет ли работа вообще.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ ЗДЕСЬ. Не «есть функция», а ПРОВОД в обе стороны от одного выражения:
 * (1) ответ двери «попытка закрылась» и свободное место — одно и то же событие;
 * (2) следующий проход тика берёт задачу из очереди на это освободившееся место;
 * (3) тик отдаёт место на смерти ребёнка, а не после ворот, — замерено изнутри ворот;
 * (4) «останавливать было нечего» переживает окно между захватом и запуском: ход,
 *     родившийся после снятия, умирает при рождении, а не работает час невидимым.
 *
 * Ни сети, ни базы, ни настоящих процессов: дом мест, реестр ручек, дверь и тик — настоящие,
 * работник — подделка, которая говорит и выходит.
 */

import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { createTurnRegistry } from '../src/front/chat.mjs'
import { createInFlight, confirmProcessGone } from '../src/queue/in-flight.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const TOKEN = 'a'.repeat(64)
const PROJECT = '/repo'
const COPY = '/copies/wt-R-1788000000002'
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'

// ── дверь: тот же минимум запроса и ответа, каким её гоняет сторож поверхности ──

function mkReq(o: any = {}) {
  const payload = o.body == null ? [] : [Buffer.from(JSON.stringify(o.body))]
  const req: any = Readable.from(payload)
  req.method = o.method ?? 'GET'
  req.url = o.url ?? '/'
  req.headers = { ...(o.headers ?? {}) }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    setHeader(k: string, v: any) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function cancel(front: any, taskId: string) {
  const req = mkReq({
    method: 'POST',
    url: '/api/task/cancel',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: { taskId },
  })
  const res = mkRes()
  await front.handle(req, res)
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') }
}

// ── тик: тот же минимум зависимостей, каким его гоняют соседние сквозные дела ──

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const queuedTask = (over: Record<string, unknown> = {}) => ({
  id: 'R-1788000000002',
  source: 'roster',
  title: 'написать разбор',
  lane: 'paperwork',
  priority: 0,
  storyPoints: 3,
  acceptance: 'разбор написан',
  data: { kind: 'document', stage: 'plan', phase: '20' },
  ...over,
})

/** Работник, который открывает сессию, говорит и выходит. Ручка умеет умирать и отвечать о жизни. */
function fakeWorker(o: { onSpawn?: () => void } = {}) {
  return (spec: any) => {
    o.onSpawn?.()
    let alive = true
    spec.onLine?.(JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }))
    spec.onLine?.('APPROACH_NOTE: прямой путь')
    spec.onLine?.('LESSON_NONE: подставной работник')
    spec.onExit?.({ code: 0, signal: null })
    alive = false
    return { pid: 4242, kill: () => (alive = false), alive: () => alive }
  }
}

function tickDeps(over: any = {}) {
  const journalled: unknown[] = []
  const c = over.clockObj ?? mkClock()
  const deps = {
    adapter: over.adapter,
    ledger: { recordAttempt: (a: unknown) => a, readAttempts: () => [] },
    config: {
      workers: [{ id: 'max-1', lane: 'paperwork', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      repoDir: PROJECT,
      pipeline: { enabled: true },
      laneRouting: { paperwork: { provider: 'claude' } },
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'написать разбор' }),
    verbRunner: async (_bin: string, argsArray: string[]) => {
      if (argsArray[1] === 'worktree') {
        return { code: 0, stdout: JSON.stringify({ ok: true, path: COPY, branch: 'wt/R-1788000000002', expectedBase: 'base1234' }) }
      }
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: over.spawnWorker ?? fakeWorker(),
    report: async () => {},
    clock: c.clock,
    journal: (e: unknown) => journalled.push(e),
    ...over.deps,
  }
  return { deps, journalled }
}

describe('снятая дверью попытка отдаёт своё место', () => {
  it('ответ «попытка закрылась» и свободное место — ОДНО событие, а не два согласованных', async () => {
    const house = createInFlight()
    const turns = createTurnRegistry()
    const seat = house.reserve(1)
    house.name(seat, 'R-1788000000001', 'max-1')
    // Живой ребёнок: ручка умеет убивать и умеет отвечать, что он больше не жив.
    let alive = true
    turns.register('R-1788000000001', () => (alive = false), () => alive)

    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { async cancelTask() { return true } },
        attemptTurns: turns,
        inFlight: house,
        sleep: async () => {},
      },
    })

    expect(house.size(), 'до снятия место занято живой попыткой').toBe(1)
    const res = await cancel(front, 'R-1788000000001')

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ cancelled: true, killed: true, attemptClosed: true })
    expect(
      house.size(),
      'дверь сказала «попытка закрылась» — значит места этой попытки в доме больше нет',
    ).toBe(0)
  })

  it('и СЛЕДУЮЩИЙ ПРОХОД ТИКА берёт задачу из очереди на освободившееся место', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300_000 })
    await adapter.enqueue(queuedTask())

    const house = createInFlight()
    const turns = createTurnRegistry()
    // Единственное место занято попыткой, которую сейчас снимут.
    const seat = house.reserve(1)
    house.name(seat, 'R-1788000000001', 'max-1')
    let alive = true
    turns.register('R-1788000000001', () => (alive = false), () => alive)

    let spawns = 0
    const before = tickDeps({
      adapter,
      clockObj: c,
      config: { maxConcurrentAttempts: 1 },
      spawnWorker: fakeWorker({ onSpawn: () => (spawns += 1) }),
      deps: { inFlight: house, attemptTurns: turns },
    })
    // ДО снятия дом полон — очередь не спрашивается вовсе, и это правильно.
    const idle: any = await tick(before.deps)
    expect(idle.concurrencyCap, 'простой обязан быть ИМЕННО по потолку, а не по любой другой причине').toMatchObject({
      inFlight: 1,
      cap: 1,
    })
    expect(spawns, 'при полном доме работник не запускается').toBe(0)

    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter, attemptTurns: turns, inFlight: house, sleep: async () => {} },
    })
    await cancel(front, 'R-1788000000001')

    const after = tickDeps({
      adapter,
      clockObj: c,
      config: { maxConcurrentAttempts: 1 },
      spawnWorker: fakeWorker({ onSpawn: () => (spawns += 1) }),
      deps: { inFlight: house, attemptTurns: turns },
    })
    await tick(after.deps)

    expect(
      spawns,
      'место освободилось — ждавшая строка обязана поехать следующим же проходом',
    ).toBe(1)
  })

  /**
   * ДВА ПРАВИЛА О МЕСТЕ ЖИВУТ ВМЕСТЕ, И ЭТО НЕ СОВПАДЕНИЕ ИХ КОДА.
   *
   * Одно говорит, СКОЛЬКО мест раздаётся: не больше, чем работников, — иначе строка берётся
   * при всех занятых и уезжает занятому (один работник, две живые сессии). Другое говорит,
   * КОГДА место возвращается: в момент подтверждённой смерти процесса, а не в конце прохода.
   * Правила сходятся на одном жетоне, и сходятся они здесь: потолок объявлен вчетверо больше
   * числа работников, поэтому границу держит ИМЕННО счёт работников, — и освобождает её
   * ИМЕННО смерть процесса. Сломай любое из двух, и это дело покраснеет.
   */
  it('мест не больше, чем работников, — и освобождает их смерть процесса, а не конец прохода', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300_000 })
    await adapter.enqueue(queuedTask())

    const house = createInFlight()
    const turns = createTurnRegistry()
    const seat = house.reserve(4)
    house.name(seat, 'R-1788000000001', 'max-1')
    let alive = true
    turns.register('R-1788000000001', () => (alive = false), () => alive)

    let spawns = 0
    // Потолок — четыре, работник — ОДИН. По потолку место ещё есть; по работникам его нет.
    const busy = tickDeps({
      adapter,
      clockObj: c,
      config: { maxConcurrentAttempts: 4 },
      spawnWorker: fakeWorker({ onSpawn: () => (spawns += 1) }),
      deps: { inFlight: house, attemptTurns: turns },
    })
    const idle: any = await tick(busy.deps)
    expect(idle.concurrencyCap, 'границу держит счёт работников, а не объявленный потолок').toMatchObject({
      inFlight: 1,
      cap: 4,
      seats: 1,
    })
    expect(spawns, 'единственный работник ведёт попытку — второй ей взяться неоткуда').toBe(0)

    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter, attemptTurns: turns, inFlight: house, sleep: async () => {} },
    })
    await cancel(front, 'R-1788000000001')

    const free = tickDeps({
      adapter,
      clockObj: c,
      config: { maxConcurrentAttempts: 4 },
      spawnWorker: fakeWorker({ onSpawn: () => (spawns += 1) }),
      deps: { inFlight: house, attemptTurns: turns },
    })
    await tick(free.deps)

    expect(spawns, 'работник освободился смертью своего процесса — очередь обязана поехать').toBe(1)
  })
})

describe('место отдаётся на смерти ребёнка, а не после ворот', () => {
  it('пока тик считает коммиты после смерти работника, место УЖЕ свободно', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300_000 })
    await adapter.enqueue(queuedTask())

    const house = createInFlight()
    const turns = createTurnRegistry()
    let died = false
    // Каждый вопрос к git запоминает, был ли он задан после смерти ребёнка и сколько мест
    // в этот миг занято. Ворота идут ПОСЛЕ выхода процесса — там и меряем.
    const looks: Array<{ afterDeath: boolean; busy: number }> = []

    const { deps } = tickDeps({
      adapter,
      clockObj: c,
      spawnWorker: (spec: any) => {
        let alive = true
        spec.onLine?.(JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }))
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: подставной работник')
        spec.onExit?.({ code: 0, signal: null })
        alive = false
        died = true
        return { pid: 4242, kill: () => (alive = false), alive: () => alive }
      },
      deps: {
        inFlight: house,
        attemptTurns: turns,
        execGit: () => {
          looks.push({ afterDeath: died, busy: house.size() })
          return 'beef123\n'
        },
      },
    })

    await tick(deps)

    const alive = looks.filter((l) => !l.afterDeath)
    const dead = looks.filter((l) => l.afterDeath)
    expect(alive.length, 'до смерти работника тик обязан был спросить git хотя бы раз').toBeGreaterThan(0)
    expect(dead.length, 'после смерти работника ворота обязаны были спросить git хотя бы раз').toBeGreaterThan(0)
    expect(
      alive.every((l) => l.busy === 1),
      'пока ребёнок жив, его место занято — иначе потолок не держит ничего',
    ).toBe(true)
    expect(
      dead.every((l) => l.busy === 0),
      'ребёнка нет — место обязано быть свободным ещё до конца прохода',
    ).toBe(true)
    expect(house.size(), 'и после прохода дом пуст — прежний закон в силе').toBe(0)
  })

  it('молчание о жизни процесса местом не распоряжается — оно не подтверждение', () => {
    const house = createInFlight()
    const seat = house.reserve(2)
    house.name(seat, 'R-1788000000003', 'max-1')
    // Реестр держит ручку БЕЗ пробника: «сказать нечего» — не «мёртв».
    const turns = createTurnRegistry()
    turns.register('R-1788000000003', () => {})

    expect(confirmProcessGone({ attemptTurns: turns, inFlight: house }, 'R-1788000000003')).toBe(false)
    expect(house.size(), 'место, отданное под живым процессом, — это второй процесс на ту же подписку').toBe(1)
  })
})

describe('«останавливать было нечего» переживает окно между захватом и запуском', () => {
  it('ход, родившийся после снятия строки, умирает при рождении — а не работает невидимым', async () => {
    const house = createInFlight()
    const turns = createTurnRegistry()
    // Место взято и названо задачей — захват состоялся, работник ещё не запущен.
    const seat = house.reserve(1)
    house.name(seat, 'R-1788000000004', 'max-1')

    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { async cancelTask() { return true } },
        attemptTurns: turns,
        inFlight: house,
        sleep: async () => {},
      },
    })
    const res = await cancel(front, 'R-1788000000004')

    // Ответ не врёт: живого ребёнка в эту секунду действительно не было.
    expect(res.body).toEqual({ cancelled: true, killed: false, attemptClosed: null })

    // …А теперь запуск состоялся и зарегистрировал свою ручку — с опозданием на провизию копии.
    let killed = false
    turns.register('R-1788000000004', () => (killed = true), () => !killed)

    expect(killed, 'снятая строка не имеет права оставить за собой живую сессию').toBe(true)
    expect(turns.has('R-1788000000004'), 'приговорённый ход не остаётся в реестре живых').toBe(false)
  })

  it('приговор одноразовый — законная следующая попытка той же работы не страдает', async () => {
    const turns = createTurnRegistry()
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { async cancelTask() { return true } }, attemptTurns: turns, sleep: async () => {} },
    })
    await cancel(front, 'R-1788000000005')

    let firstKilled = false
    turns.register('R-1788000000005', () => (firstKilled = true))
    expect(firstKilled).toBe(true)

    let secondKilled = false
    turns.register('R-1788000000005', () => (secondKilled = true))
    expect(secondKilled, 'приговор относится к снятой попытке, а не к имени задачи навсегда').toBe(false)
    expect(turns.has('R-1788000000005'), 'вторая ручка живёт обычной жизнью').toBe(true)
  })

  it('приговор с давностью: работа, вернувшаяся в очередь много позже, запускается как обычно', async () => {
    const c = mkClock()
    const turns = createTurnRegistry({ clock: c.clock })
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { async cancelTask() { return true } }, attemptTurns: turns, sleep: async () => {} },
    })
    await cancel(front, 'R-1788000000006')

    c.advance(10 * 60 * 1000) // человек вернул работу в очередь спустя десять минут

    let killed = false
    turns.register('R-1788000000006', () => (killed = true))
    expect(killed, 'приговор, переживший свой срок, убил бы чужую работу').toBe(false)
    expect(turns.has('R-1788000000006')).toBe(true)
  })
})
