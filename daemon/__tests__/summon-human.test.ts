/**
 * ЗОВ ЧЕЛОВЕКА — ПРОВОД ОТ «РАБОТА ВСТАЛА И БЕЗ ЧЕЛОВЕКА НЕ ДВИНЕТСЯ» ДО ОТПРАВКИ В ТЕЛЕГРАМ.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Обе двери существовали порознь и не были соединены. Работа умела
 * вставать на приёмку и умела парковаться в ожидании решения; телеграм умел говорить с
 * владельцем в обе стороны — сторож демона шлёт туда «упал» и «поднялся». Между ними не было
 * ничего, и работа простояла на приёмке двое суток по единственной причине: человек не знал,
 * что она там стоит. Второй случай той же природы: работник ждал решения о праве на запись, а
 * попытка тем временем жгла ходы.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ. Именно ПРОВОД, а не вычисление события: всюду, где сказано
 * «сообщение ушло», проверяется НАСТОЯЩИЙ вызов `sendMessage` через подставной транспорт —
 * тот же приём, которым снимается мост телеграма. Тик здесь настоящий, очередь настоящая
 * (образцовая), и состояние приёмки создаётся так же, как его создаёт работа: строку берут,
 * закрывают квитанцией — и она начинает ждать человека.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ДОКАЗЫВАЕТ. Он не проверяет ни клиент Bot API (`telegram-link`), ни
 * распознавание потолка ходов (`loop`), ни выбор двери очереди (`turn-cap-parks-wire`). Он
 * проверяет ровно четыре обещания: зов уходит; уходит ОДИН раз на одно ожидание; без
 * подключённого бота не происходит ничего; и в сообщении есть то, ради чего его читают, —
 * что ждёт, что требуется и сколько уже стоит, — и нет ни одной кнопки.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { createSummons, summonWords, waitWords, SUMMON_KINDS } from '../src/summon.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'

// ── подставной телеграм: НАСТОЯЩАЯ отправка, ненастоящий сокет ─────────────────────────────

const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const OWNER_CHAT = 424242

const okAnswer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })

/** Записывает КАЖДЫЙ вызов Bot API: и метод, и тело — на теле держится запрет на кнопки. */
function transport({ failWith }: { failWith?: Error } = {}) {
  const calls: Array<{ method: string; payload: any }> = []
  const fetchImpl = async (url: string, init: any) => {
    calls.push({
      method: String(url).split('/').pop() as string,
      payload: init && init.body ? JSON.parse(String(init.body)) : {},
    })
    if (failWith) throw failWith
    return okAnswer({ message_id: calls.length })
  }
  return { fetchImpl, calls, sent: () => calls.filter((c) => c.method === 'sendMessage') }
}

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const HOUR = 3600000

// ═══════════ 1 · ПРИЁМКА: РАБОТА ВСТАЛА — ЧЕЛОВЕКА ПОЗВАЛИ ═════════════════════════════════

/**
 * Мир, в котором одна работа уже стоит на приёмке. Строка попадает туда единственным
 * законным путём — её берут и закрывают квитанцией, — потому что провод обязан срабатывать на
 * том же состоянии, которое рождает работа, а не на подделке этого состояния.
 */
async function waitingWorld({ telegram = true, at = 2 * HOUR }: { telegram?: boolean; at?: number } = {}) {
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await queue.enqueue({
    id: 'BL-7',
    source: 'backlog',
    title: 'починить дверь склада',
    lane: 'prod',
    priority: 0,
    storyPoints: 2,
    acceptance: 'green targeted tests + a reverify receipt',
  })
  const claimed = await queue.claimNext('w1', {})
  await queue.complete('BL-7', { receiptRef: 'reverify:green', attemptToken: (claimed as any).attemptToken })

  const tg = transport()
  const config: any = {
    pipeline: { enabled: true },
    workers: [],
    agingHours: 24,
    ...(telegram ? { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' } } : {}),
  }
  const journal: any[] = []
  const summon = createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl })
  const deps: any = { adapter: queue, config, clock: c.clock, journal: (e: any) => journal.push(e), summon }

  // Работа стоит уже два часа — «сколько стоит» обязано быть числом, а не фигурой речи.
  c.advance(at)
  return { deps, tg, journal, queue, advance: c.advance, summon }
}

describe('работа встала на приёмку — человека зовут в телеграм', () => {
  it('первый же проход тика отправляет сообщение: проверяется сам вызов отправки, а не вычисленное событие', async () => {
    const w = await waitingWorld()
    await tick(w.deps)

    const sent = w.tg.sent()
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.chat_id).toBe(String(OWNER_CHAT))
    expect(w.journal.filter((e) => e.type === 'summon')).toHaveLength(1)
  })

  it('одно ожидание — одно сообщение: второй проход тика молчит', async () => {
    const w = await waitingWorld()
    await tick(w.deps)
    await tick(w.deps)
    await tick(w.deps)

    expect(w.tg.sent()).toHaveLength(1)
  })

  it('повтор бывает только за долгое ожидание: через час — тишина, через шесть — второе слово', async () => {
    const w = await waitingWorld()
    await tick(w.deps)
    expect(w.tg.sent()).toHaveLength(1)

    w.advance(HOUR)
    await tick(w.deps)
    expect(w.tg.sent()).toHaveLength(1)

    w.advance(6 * HOUR)
    await tick(w.deps)
    const sent = w.tg.sent()
    expect(sent).toHaveLength(2)
    // Повторный зов говорит, что работа ВСЁ ЕЩЁ стоит, и называет выросший срок.
    expect(sent[1].payload.text).toContain('уже 9 ч')
  })

  it('в сообщении названо, что ждёт, чего от человека хотят и сколько уже стоит', async () => {
    const w = await waitingWorld()
    await tick(w.deps)

    const text = w.tg.sent()[0].payload.text as string
    // ЧТО ждёт — работа по имени, и в каком она состоянии.
    expect(text).toContain('починить дверь склада')
    expect(text).toContain('на приёмке')
    // ЧЕГО от человека хотят — действие и место, где оно делается.
    expect(text).toContain('принять или вернуть')
    expect(text).toContain('в окне')
    // СКОЛЬКО стоит — срок, а не «событие произошло».
    expect(text).toContain('Стоит 2 ч')
  })

  it('кнопок подтверждения в сообщении нет — ни в теле запроса, ни в словах', async () => {
    const w = await waitingWorld()
    await tick(w.deps)

    const payload = w.tg.sent()[0].payload
    // Тело запроса — ровно две вещи. Клавиатура телеграма живёт в `reply_markup`, и её здесь
    // нет не потому, что автор сообщения о ней забыл, а потому, что канал её не умеет.
    expect(Object.keys(payload).sort()).toEqual(['chat_id', 'text'])
    expect(payload.reply_markup).toBeUndefined()
    expect(payload.text).toContain('Кнопок в этом чате нет')
  })
})

// ═══════════ 2 · БОТ НЕ ПОДКЛЮЧЁН — НИЧЕГО НЕ ПРОИСХОДИТ ═══════════════════════════════════

describe('телеграм не подключён — продукт ведёт себя ровно как до провода', () => {
  it('ни отправки, ни исключения, ни строки об ошибке в журнале', async () => {
    const w = await waitingWorld({ telegram: false })
    const res = await tick(w.deps)
    await tick(w.deps)

    expect(w.tg.calls).toHaveLength(0)
    expect(res).toBeTruthy()
    expect(w.journal.filter((e) => e.type === 'summon-error')).toHaveLength(0)
    expect(w.journal.filter((e) => e.type === 'summon')).toHaveLength(0)
  })

  it('ожидание не помечается позванным: бота подключили позже — зов состоится, а не окажется «уже сказанным»', async () => {
    const w = await waitingWorld({ telegram: false })
    await tick(w.deps)
    expect(w.tg.calls).toHaveLength(0)

    // Владелец подключает бота из окна — конфиг ЖИВОЙ, перезапуска демона не было.
    w.deps.config.telegram = { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' }
    await tick(w.deps)

    expect(w.tg.sent()).toHaveLength(1)
  })

  it('отказ телеграма не превращается в долбёжку: следующая попытка не на ближайшем тике', async () => {
    const c = mkClock()
    const tg = transport({ failWith: new Error('сеть недоступна') })
    const config: any = { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' } }
    const summon = createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl })

    const first = await summon.raise({ kind: 'approval', taskId: 'BL-8', title: 'дверь', since: c.clock() })
    expect(first.sent).toBe(false)
    expect(tg.calls).toHaveLength(1)

    c.advance(30000)
    await summon.raise({ kind: 'approval', taskId: 'BL-8', title: 'дверь', since: c.clock() })
    expect(tg.calls).toHaveLength(1) // выдержка держит

    c.advance(6 * 60000)
    await summon.raise({ kind: 'approval', taskId: 'BL-8', title: 'дверь', since: c.clock() })
    expect(tg.calls).toHaveLength(2) // и отпускает, но минутами, а не тиками
  })
})

// ═══════════ 3 · ПАМЯТЬ ОЖИДАНИЙ — ХИНТ, КОТОРЫЙ ПОДРЕЗАЮТ ═════════════════════════════════

describe('память ожиданий описывает очередь как она есть сейчас', () => {
  it('работа ушла с приёмки — ожидание забыто, а не хранится вечно', async () => {
    const c = mkClock()
    const tg = transport()
    const config: any = { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' } }
    const summon = createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl })

    await summon.raise({ kind: 'approval', taskId: 'BL-1', title: 'раз', since: c.clock() })
    await summon.raise({ kind: 'approval', taskId: 'BL-2', title: 'два', since: c.clock() })
    expect(summon.pending).toBe(2)

    summon.keepOnly('approval', ['BL-2'])
    expect(summon.pending).toBe(1)
  })

  it('незнакомый повод молчит, а не выдумывает себе текст', async () => {
    const c = mkClock()
    const tg = transport()
    const config: any = { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' } }
    const summon = createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl })

    const out = await summon.raise({ kind: 'что-то-новое', taskId: 'BL-1' } as any)
    expect(out.sent).toBe(false)
    expect(tg.calls).toHaveLength(0)
    expect([...SUMMON_KINDS]).toEqual(['approval', 'parked', 'stopped'])
  })
})

// ═══════════ 4 · СЛОВА: ТРИ ВЕЩИ И НИ ОДНОЙ ЛИШНЕЙ ═════════════════════════════════════════

describe('сообщение — вопрос, на который человек отвечает', () => {
  it('срок произносится так, как его произносят вслух: от «меньше минуты» до суток', () => {
    expect(waitWords(12)).toBe('меньше минуты')
    expect(waitWords(600)).toBe('10 мин')
    expect(waitWords(3600)).toBe('1 ч')
    expect(waitWords(7500)).toBe('2 ч 5 мин')
    expect(waitWords(2 * 24 * 3600)).toBe('2 сут')
    expect(waitWords(null)).toBe('неизвестно сколько')
  })

  it('остановленной работе названа её причина и её выход — словами очереди, а не кодом', () => {
    const text = summonWords({
      kind: 'parked',
      taskId: 'BL-3',
      title: 'разобрать почту',
      reason: 'turns_exhausted',
      since: 0,
      now: 600000,
    })
    expect(text).toContain('разобрать почту')
    expect(text).toContain('поднять потолок ходов')
    expect(text).toContain('Нужно ваше решение')
    expect(text).toContain('Стоит 10 мин')
    expect(text).not.toContain('turns_exhausted')
  })

  it('работа без имени зовёт по своему ярлыку, а не пустотой', () => {
    expect(summonWords({ kind: 'approval', taskId: 'BL-4', since: 0, now: 0 })).toContain('«BL-4»')
  })
})

// ═══════════ 5 · РАБОТНИК УПЁРСЯ — ЗОВ ИЗ САМОГО ПРОВАЛА ═══════════════════════════════════

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

const RESULT_MAX_TURNS = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  num_turns: 80,
  total_cost_usd: 0.9,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
})

const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 12,
  total_cost_usd: 0.1,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
})

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) }
const RED_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'red', receiptRef: 'reverify:red', diffStat: '+1 -1' }) }

/** Настоящий тик над настоящей очередью: прогон кончается так, как велит `over`. */
async function runTickOverAttempt(over: any = {}) {
  const projectDir = mkDir('sma-summon-proj-')
  const ledgerDir = mkDir('sma-summon-ledger-')
  const workDir = mkDir('sma-summon-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await queue.enqueue({
    id: 'BL-5',
    source: 'backlog',
    title: 'перебрать крышу',
    lane: 'prod',
    priority: 0,
    storyPoints: 3,
    acceptance: 'green targeted tests + a reverify receipt',
  })

  const tg = transport()
  const config: any = {
    workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { name: 'local-1', configDir: '/x' }, enabled: true }],
    agingHours: 24,
    backlogScanMinutes: 60,
    repoDir: projectDir,
    pipeline: { enabled: true },
    telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' },
  }
  const deps: any = {
    adapter: queue,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config,
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: () => ({ bin: 'claude', args: buildClaudeArgs({}), env: { PATH: '/usr/bin' }, prompt: 'сделай дело' }),
    verbRunner: async (_bin: string, argsArray: string[]) => {
      const verb = argsArray[1]
      if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
      if (verb === 'worktree') {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            path: workDir,
            branch: 'wt/BL-5',
            materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 812 }],
          }),
        }
      }
      if (verb === 'reverify') return over.reverify ?? GREEN_REVERIFY
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: any) => {
      for (const l of over.lines ?? [RESULT_MAX_TURNS]) spec.onLine?.(l)
      spec.onExit?.({ code: over.exitCode ?? 1, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: () => {},
    report: async () => {},
    clock: c.clock,
    journal: () => {},
    execGit: (args: string[]) => {
      const verb = args[0]
      if (verb === 'rev-parse') return 'base0000'
      if (verb === 'rev-list') return '1'
      if (verb === 'diff') return 'M\tdaemon/src/loop.mjs'
      return ''
    },
    summon: createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl }),
  }

  const res = await tick(deps)
  return { res, tg, queue }
}

describe('попытка кончилась тем, что может решить только человек — его зовут', () => {
  it('упор в потолок ходов уходит в телеграм вопросом, а не кодом причины', async () => {
    const { res, tg } = await runTickOverAttempt()
    expect((res as any).failed?.reason).toBe('turns_exhausted')

    const sent = tg.sent()
    expect(sent).toHaveLength(1)
    const text = sent[0].payload.text as string
    expect(text).toContain('перебрать крышу')
    expect(text).toContain('ждёт вас')
    expect(text).toContain('поднять потолок ходов')
    expect(text).not.toContain('turns_exhausted')
    expect(Object.keys(sent[0].payload).sort()).toEqual(['chat_id', 'text'])
  })

  /**
   * ГРАНИЦА, БЕЗ КОТОРОЙ КАНАЛ СТАНОВИТСЯ ШУМОМ. Обычный провал повторяется сам: следующую
   * попытку заведёт демон, и человеку в этот момент решать нечего. Канал, звонящий о работе,
   * которая и без него продолжится, перестают читать — и тогда он молчит уже про всё.
   */
  it('обычный провал, за которым стоит следующая попытка, человека НЕ зовёт', async () => {
    const { res, tg } = await runTickOverAttempt({
      lines: [RESULT_OK, 'APPROACH_NOTE: прямой путь', 'LESSON_NONE: чистое чтение'],
      reverify: RED_REVERIFY,
      exitCode: 0,
    })
    expect((res as any).failed?.reason).toBe('tests_red')
    expect(tg.calls).toHaveLength(0)
  })
})
