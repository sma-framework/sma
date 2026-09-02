/**
 * ЗОВ ЧЕЛОВЕКА ПОСЛЕ ПЕРЕЗАПУСКА ДЕМОНА — И ОДНО СЛОВО ВМЕСТО ЗАЛПА.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Память зова жила в процессе и была объявлена хинтом: «потеря стоит
 * одного лишнего сообщения». Измерено 02.09: демон поднялся дважды за двадцать минут, и
 * владелец получил ДВА одинаковых залпа по десять сообщений — каждая работа, стоящая на его
 * решении, позвала заново, потому что процесс, помнивший о ней, кончился. Среди зовов были
 * работы, чьи карточки владелец закрыл руками днями раньше: очередь о них не знала и звала.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ — четыре обещания, и все на настоящем проводе:
 *   1. ДВА СТАРТА ПОДРЯД — ОДИН ЗАЛП. Второй объект зова собирается с нуля над тем же
 *      каталогом данных, ровно как это делает поднявшийся заново демон, и молчит.
 *   2. ЗАПИСЬ ДОЕЗЖАЕТ ДО ДИСКА. Файл читается настоящим `fs` и содержит повод, работу и
 *      момент, когда о ней сказали, — вычисленной памяти здесь не верят.
 *   3. ПРИЁМКА ГОВОРИТ ОДНИМ СООБЩЕНИЕМ. Три стоящие работы — одна отправка, со счётом,
 *      сроком старшей и именами.
 *   4. ЗАКРЫТОЕ НЕ ЗОВЁТ. Карточка, отмеченная в реестре сделанной, и кусок отменённой
 *      сборки молчат, хотя очередь всё ещё держит их ждущими человека.
 *
 * Всюду, где сказано «сообщение ушло», проверяется НАСТОЯЩИЙ вызов `sendMessage` через
 * подставной транспорт; очередь настоящая (образцовая), состояние приёмки создаётся тем же
 * путём, каким его создаёт работа, — строку берут и закрывают квитанцией.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { createSummons, summonDigestWords } from '../src/summon.mjs'
import { SUMMON_SAID_FILE, createSaidMemory } from '../src/summon-said.mjs'
import { createClosedCards, createGhostCheck } from '../src/summon-ghosts.mjs'
import { createMemoryQueue, BATCH_PARENT } from '../src/queue/adapter.mjs'

const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const OWNER_CHAT = 424242
const HOUR = 3600000

const okAnswer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })

/** Записывает КАЖДЫЙ вызов Bot API: на нём держится счёт сообщений и запрет на кнопки. */
function transport() {
  const calls: Array<{ method: string; payload: any }> = []
  const fetchImpl = async (url: string, init: any) => {
    calls.push({
      method: String(url).split('/').pop() as string,
      payload: init && init.body ? JSON.parse(String(init.body)) : {},
    })
    return okAnswer({ message_id: calls.length })
  }
  return { fetchImpl, calls, sent: () => calls.filter((c) => c.method === 'sendMessage') }
}

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const tmpDirs: string[] = []
const mkDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

const tgConfig = () => ({
  pipeline: { enabled: true },
  workers: [],
  agingHours: 24,
  telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' },
})

/** Реестр дома планирования — тот же адрес и та же грамматика, что читает приёмный сканер. */
function writeRegistry(root: string, lines: string[]) {
  mkdirSync(join(root, '.planning'), { recursive: true })
  writeFileSync(join(root, '.planning', 'BACKLOG.md'), ['## Backlog', '', ...lines, ''].join('\n'), 'utf8')
}

/**
 * Мир, в котором `n` работ уже стоят на приёмке. Каждая попадает туда единственным законным
 * путём — её берут и закрывают квитанцией, — и между ними проходит час, чтобы «старшая» было
 * не фигурой речи, а измеримым числом.
 */
async function waitingWorld({ n = 3, dataDir = '' }: { n?: number; dataDir?: string } = {}) {
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  for (let i = 1; i <= n; i += 1) {
    await queue.enqueue({
      id: `W-${i}`,
      source: 'backlog',
      title: `работа номер ${i}`,
      lane: 'prod',
      priority: 0,
      storyPoints: 2,
      acceptance: 'green targeted tests + a reverify receipt',
    })
    const claimed: any = await queue.claimNext('w1', {})
    await queue.complete(claimed.id, { receiptRef: `reverify:${i}`, attemptToken: claimed.attemptToken })
    c.advance(HOUR)
  }
  const tg = transport()
  const config: any = tgConfig()
  const journal: any[] = []
  const world = {
    c,
    queue,
    tg,
    config,
    journal,
    /** Новый объект зова над теми же данными — ровно то, что делает поднявшийся заново демон. */
    boot(extra: any = {}) {
      const summon = createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl, dataDir, ...extra })
      const deps: any = {
        adapter: queue,
        config,
        clock: c.clock,
        journal: (e: any) => journal.push(e),
        summon,
      }
      return { summon, deps }
    },
  }
  return world
}

// ═══════════ 1 · ПЕРЕЗАПУСК ДЕМОНА НЕ ПОВТОРЯЕТ СКАЗАННОГО ═════════════════════════════════

describe('память зовов переживает перезапуск демона', () => {
  it('два старта подряд с теми же стоящими работами — один залп, а не два', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 3, dataDir })

    const first = w.boot()
    await tick(first.deps)
    expect(w.tg.sent()).toHaveLength(1)

    // ДЕМОН ПОДНЯЛСЯ ЗАНОВО: объект зова другой, каталог данных тот же. Прежде здесь уходил
    // второй такой же залп — по сообщению на каждую стоящую работу.
    const second = w.boot()
    expect(second.summon).not.toBe(first.summon)
    await tick(second.deps)
    await tick(second.deps)

    expect(w.tg.sent()).toHaveLength(1)
  })

  it('без каталога данных память честно называет себя недолговечной, а не притворяется', async () => {
    const w = await waitingWorld({ n: 2, dataDir: '' })
    const first = w.boot()
    expect(first.summon.durable).toBe(false)
    await tick(first.deps)
    expect(w.tg.sent()).toHaveLength(1)

    // Тот же перезапуск без данных демона — прежнее поведение, названное вслух.
    await tick(w.boot().deps)
    expect(w.tg.sent()).toHaveLength(2)
  })

  it('запись «сказано» доезжает до диска и читается новым процессом', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 2, dataDir })
    await tick(w.boot().deps)
    expect(w.tg.sent()).toHaveLength(1)

    // ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ: файл открывается настоящим fs и читается глазами.
    const file = join(dataDir, SUMMON_SAID_FILE)
    expect(existsSync(file)).toBe(true)
    const records = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
    const said = records.filter((r) => r.op === 'said')
    expect(said.map((r) => r.taskId).sort()).toEqual(['W-1', 'W-2'])
    for (const r of said) {
      expect(r.kind).toBe('approval') // ПРИЧИНА
      expect(r.lastSentAt).toBe(w.c.clock()) // КОГДА СКАЗАНО
      expect(typeof r.at).toBe('string')
    }

    // И новый читатель поднимает то же самое, не спрашивая прежний процесс.
    const reread = createSaidMemory({ dataDir })
    expect(reread.durable).toBe(true)
    expect(reread.get('approval:W-1')?.lastSentAt).toBe(w.c.clock())
  })

  it('работа ушла с приёмки — запись о ней стирается с диска, а не копится вечно', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 2, dataDir })
    const boot = w.boot()
    await tick(boot.deps)
    expect(boot.summon.pending).toBe(2)

    // Человек ответил по одной из них — очередь больше не держит её на приёмке, и следующий
    // проход подрезает память по живому списку ровно так же, как это делает тик.
    boot.summon.keepOnly('approval', ['W-2'])

    expect(createSaidMemory({ dataDir }).get('approval:W-1')).toBeUndefined()
    expect(createSaidMemory({ dataDir }).get('approval:W-2')).toBeTruthy()
  })
})

// ═══════════ 2 · ОДИН ПРОХОД — ОДНО СЛОВО ══════════════════════════════════════════════════

describe('приёмка зовёт одним сводным сообщением, а не по сообщению на работу', () => {
  it('три стоящие работы — одна отправка, а не три', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 3, dataDir })
    await tick(w.boot().deps)
    await tick(w.boot().deps)

    expect(w.tg.sent()).toHaveLength(1)
    expect(w.journal.filter((e) => e.type === 'summon')).toHaveLength(1)
    expect(w.journal.find((e) => e.type === 'summon')?.count).toBe(3)
  })

  it('сводка называет счёт, срок старшей и имена — и ни одной кнопки', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 3, dataDir })
    await tick(w.boot().deps)

    const payload = w.tg.sent()[0].payload
    const text = payload.text as string
    expect(text).toContain('На приёмке 3 работы')
    expect(text).toContain('Старшая ждёт 3 ч')
    expect(text).toContain('работа номер 1')
    expect(text).toContain('работа номер 3')
    expect(text).toContain('принять или вернуть')
    // Тело запроса — ровно две вещи: клавиатуры канал не умеет.
    expect(Object.keys(payload).sort()).toEqual(['chat_id', 'text'])
  })

  it('повтор не раньше выдержки — и тоже одним сообщением', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 3, dataDir })
    await tick(w.boot().deps)
    expect(w.tg.sent()).toHaveLength(1)

    w.c.advance(5 * HOUR)
    await tick(w.boot().deps)
    expect(w.tg.sent()).toHaveLength(1) // выдержка держит, и перезапуск её не сбрасывает

    w.c.advance(2 * HOUR)
    await tick(w.boot().deps)
    const sent = w.tg.sent()
    expect(sent).toHaveLength(2) // ОДНО сообщение на все три работы, а не три
    expect(sent[1].payload.text).toContain('На приёмке 3 работы')
  })

  it('осталась одна работа — она зовёт своим полным текстом, а не сводкой из одной строки', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const w = await waitingWorld({ n: 1, dataDir })
    await tick(w.boot().deps)

    const text = w.tg.sent()[0].payload.text as string
    expect(text).toContain('Работа «работа номер 1» стоит на приёмке')
    expect(text).not.toContain('На приёмке 1')
  })

  it('длинный список называет первых поимённо и дальше переходит на счёт', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ taskId: `W-${i + 1}`, title: `работа ${i + 1}`, since: 0 }))
    const text = summonDigestWords({ kind: 'approval', items, now: 3 * HOUR })
    expect(text).toContain('На приёмке 8 работ')
    expect(text).toContain('…и ещё 3')
  })
})

// ═══════════ 3 · СВЕРКА ПЕРЕД ЗОВОМ ════════════════════════════════════════════════════════

describe('закрытое не зовёт: сверка перед словом', () => {
  it('работа, чья карточка в реестре отмечена сделанной, не зовётся', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const planning = mkDir('sma-summon-plan-')
    writeRegistry(planning, ['- [ ] **W-1** · живая строка `sp:2`', '- [x] **W-2** · закрытая строка `sp:2`'])

    const w = await waitingWorld({ n: 2, dataDir })
    const isGhost = createGhostCheck({
      adapter: w.queue,
      closedCards: createClosedCards({ backlogRoot: planning, clock: w.c.clock }),
    })
    await tick(w.boot({ isGhost }).deps)

    const sent = w.tg.sent()
    expect(sent).toHaveLength(1)
    const text = sent[0].payload.text as string
    expect(text).toContain('работа номер 1')
    expect(text).not.toContain('работа номер 2') // призрак закрытой карточки молчит
  })

  it('закрытая карточка не помечается сказанной: слова о ней не было', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const planning = mkDir('sma-summon-plan-')
    writeRegistry(planning, ['- [x] **W-1** · закрытая строка `sp:2`'])

    const w = await waitingWorld({ n: 1, dataDir })
    const isGhost = createGhostCheck({
      adapter: w.queue,
      closedCards: createClosedCards({ backlogRoot: planning, clock: w.c.clock }),
    })
    await tick(w.boot({ isGhost }).deps)
    expect(w.tg.calls).toHaveLength(0)

    // Карточку снова открыли — зов состоится, а не окажется «уже сказанным».
    writeRegistry(planning, ['- [ ] **W-1** · снова открытая строка `sp:2`'])
    w.c.advance(7 * HOUR)
    await tick(w.boot({ isGhost }).deps)
    expect(w.tg.sent()).toHaveLength(1)
  })

  it('кусок сборки, которую владелец отменил, не зовётся', async () => {
    const dataDir = mkDir('sma-summon-data-')
    const c = mkClock()
    const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await queue.enqueue({ id: 'A-1-1', source: 'roster', title: 'кусок сборки', lane: 'prod', batchId: 'A-1' })
    await queue.enqueue({
      id: 'A-1',
      source: 'roster',
      title: 'сборка',
      lane: 'prod',
      batchId: 'A-1',
      data: { batch: BATCH_PARENT },
    })
    const claimed: any = await queue.claimNext('w1', {})
    await queue.complete(claimed.id, { receiptRef: 'reverify:1', attemptToken: claimed.attemptToken })
    c.advance(2 * HOUR)

    // Владелец бросил сборку. Кусок, УЖЕ ждущий человека, отмена не трогает — у него своя
    // дверь; но звать о нём после отмены уже не о чем.
    expect(await queue.resolveBatch('A-1', { cancel: true })).toBe(true)
    expect((await queue.list({ status: 'awaiting_approval' })).map((r: any) => r.id)).toEqual(['A-1-1'])

    const tg = transport()
    const config: any = tgConfig()
    const summon = createSummons({
      config,
      now: c.clock,
      fetchImpl: tg.fetchImpl,
      dataDir,
      isGhost: createGhostCheck({ adapter: queue }),
    })
    await tick({ adapter: queue, config, clock: c.clock, journal: () => {}, summon } as any)

    expect(tg.calls).toHaveLength(0)
  })
})
