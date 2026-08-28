/**
 * Tests for the cost history the «Расходы» screen draws.
 *
 * `usageSeries` fills a seam the state derive declared from its first line and nothing had
 * filled: without it the cost view is permanently empty, whatever the park actually spent.
 * The load-bearing invariants:
 *   - one point per day, per account, per LANE — so the payload stays small no matter how
 *     many tasks a day held,
 *   - the conversation is its own lane: rows booked under the reserved `chat-` prefix never
 *     land in the ordinary point of the same day and account, and the conversation's point
 *     carries a real booking id so the screen can find it by that same prefix,
 *   - TOKENS travel beside the euros: a subscription row books no dollar cost, and a series
 *     that carried money alone would show a night of real work as a flat zero,
 *   - the window is a rolling number of days, and the account list narrows it,
 *   - a missing or corrupt book yields fewer points, never an error.
 *
 * The book is injected as a string, so the suite never touches a real ledger.
 */

import { describe, it, expect } from 'vitest'

import { CHAT_TASK_ID_PREFIX, usageSeries, bookUsage, estimateUsage } from '../src/runner/usage.mjs'
// ОБЩИЙ ЦЕННИК — тот же модуль, по которому считает командная строка (см. последний случай
// первого раздела): цена, сверенная с ним, а не с переписанными в тест ставками.
import { priceUsd } from '../../scripts/sma/lib/pricing.mjs'
// Настоящий тик, настоящая очередь и настоящий маршрутизатор — для случаев в конце файла, где
// доказывается не расчёт строки, а ПРОВОД до писателя книги: обе половины были зелены по
// отдельности всё то время, пока оборванная попытка не оставляла в книге ничего.
import { tick } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const NOW = Date.parse('2026-08-01T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

/** The local calendar day of a moment, the way the series names it. */
function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function book(rows: object[]) {
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return { readFileSync: () => text }
}

function row(over: Record<string, unknown> = {}) {
  return {
    ts: new Date(NOW).toISOString(),
    accountName: 'клод-основной',
    provider: 'claude',
    taskId: 'task-1',
    model: 'sonnet',
    inputTokens: 100,
    outputTokens: 50,
    source: 'stream-result',
    ...over,
  }
}

const call = (fsImpl: object, over: Record<string, unknown> = {}) =>
  usageSeries({ dataDir: '/data', clock: () => NOW, fsImpl, ...over })

describe('usageSeries — one point per day, per account, per lane', () => {
  it('sums the rows of one account-day into a single point', () => {
    const series = call(book([row(), row({ taskId: 'task-2', inputTokens: 20, outputTokens: 5 })]))
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({ account: 'клод-основной', day: dayOf(NOW), tokensIn: 120, tokensOut: 55 })
  })

  it('keeps different days and different accounts apart', () => {
    const series = call(
      book([
        row(),
        row({ ts: new Date(NOW - 2 * DAY).toISOString() }),
        row({ accountName: 'кодекс' }),
      ]),
    )
    expect(series).toHaveLength(3)
    expect(new Set(series.map((p: any) => p.day)).size).toBe(2)
    expect(new Set(series.map((p: any) => p.account)).size).toBe(2)
  })

  it('carries the token counts a subscription row books, with euros honestly zero', () => {
    const series = call(book([row()])) // no costUsd — a subscription session
    expect(series[0].eur).toBe(0)
    expect(series[0].tokensIn + series[0].tokensOut).toBeGreaterThan(0)
  })

  it('sums the api-fallback money when the rows carry it, rounded to cents', () => {
    const series = call(
      book([row({ costUsd: 0.014, channel: 'api' }), row({ taskId: 'task-2', costUsd: 0.019, channel: 'api' })]),
    )
    expect(series[0].eur).toBe(0.03)
  })

  it('keeps a subscription estimate OUT of the euro column — the plan absorbed it (QA D4)', () => {
    // One chat message on a subscription window used to render as «платный канал сегодня
    // 0,12 €» directly above the line saying the paid channel is silent.
    const series = call(book([row({ costUsd: 0.12 }), row({ taskId: 'task-2', costUsd: 0.05, channel: 'api' })]))
    expect(series[0].eur).toBe(0.05)
    expect(series[0].tokensIn).toBeGreaterThan(0) // the work itself still shows, in tokens
  })
})

/**
 * ═══ ЧЕТЫРЕ ЧИСЛА, ИМЯ МОДЕЛИ И ЦЕНА «КАК ЕСЛИ БЫ ПО API» ═════════════════════════════════
 *
 * Читатель кадра возвращал все четыре числа и раньше, а точка несла два: кэш падал на пол
 * между книгой и экраном. Без него «почему этот день дорогой» не отвечается вовсе — миллион
 * из кэша и миллион, отправленный заново, стоят по-разному в разы, — и цена по ценнику не
 * считается совсем. Здесь проверяется и провод, и арифметика по ОБЩЕМУ ценнику.
 */
describe('usageSeries — четыре числа, модель и справочная цена', () => {
  it('несёт вход, выход, чтение и запись кэша по отдельности', () => {
    const series = call(
      book([
        row({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 200 }),
        row({ taskId: 'task-2', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      ]),
    )
    expect(series[0]).toMatchObject({ tokensIn: 101, tokensOut: 52, cacheRead: 4003, cacheWrite: 204 })
  })

  it('называет модель, через которую прошло большинство токенов дня', () => {
    const series = call(
      book([
        row({ model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 1 }),
        row({ taskId: 'task-2', model: 'claude-opus-5', inputTokens: 1000, outputTokens: 100 }),
      ]),
    )
    expect(series[0].model).toBe('claude-opus-5')
  })

  it('модели не назвал никто — честное отсутствие, а не подставленное имя', () => {
    expect(call(book([row({ model: null })]))[0].model).toBeNull()
  })

  it('считает цену «как если бы по API» по ставкам своей модели, построчно', () => {
    // opus: 5 / 25 / 6,25 / 0,50 за миллион → 5 + 5 + 2,5 + 1 = 13,50.
    const series = call(
      book([
        row({
          model: 'claude-opus-5',
          inputTokens: 1_000_000,
          outputTokens: 200_000,
          cacheWriteTokens: 400_000,
          cacheReadTokens: 2_000_000,
        }),
      ]),
    )
    expect(series[0].apiEquivalentEur).toBe(13.5)
  })

  it('день из двух моделей оценивается по обеим, а не по одной последней', () => {
    // sonnet 1M входа = 2,00; haiku 1M выхода = 5,00 → 7,00. По ставкам одной модели вышло бы
    // другое число, и именно это молча случается, когда цену считают по «модели точки».
    const series = call(
      book([
        row({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0 }),
        row({ taskId: 'task-2', model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 1_000_000 }),
      ]),
    )
    expect(series[0].apiEquivalentEur).toBe(7)
  })

  it('модель вне ценника — цены НЕТ, а токены названы отдельно (не тихий ноль)', () => {
    const series = call(book([row({ model: 'gpt-нечто', inputTokens: 1_000_000, outputTokens: 1_000_000 })]))
    expect(series[0].apiEquivalentEur).toBe(0)
    expect(series[0].unpricedTokens).toBe(2_000_000)
  })

  it('справочная цена и настоящие евро — разные поля: подписку не выставляют счётом', () => {
    const series = call(book([row({ model: 'claude-opus-5', inputTokens: 1_000_000 })])) // без costUsd
    expect(series[0].eur).toBe(0) // счёта не было
    expect(series[0].apiEquivalentEur).toBe(5) // а по ценнику это стоило бы 5,00
  })

  it('считает по ТОМУ ЖЕ ценнику, что и командная строка, а не по своей копии', () => {
    const counts = { input: 123_456, output: 7_890, cacheRead: 654_321, cacheWrite: 12_345 }
    const series = call(
      book([
        row({
          model: 'claude-opus-5',
          inputTokens: counts.input,
          outputTokens: counts.output,
          cacheReadTokens: counts.cacheRead,
          cacheWriteTokens: counts.cacheWrite,
        }),
      ]),
    )
    // Число берётся у общего модуля цен, а не переписывается сюда: тест, знающий ставки
    // наизусть, разрешил бы демону иметь свои — лишь бы совпали в день написания.
    const expected = Math.round((priceUsd({ model: 'claude-opus-5', ...counts }) as number) * 100) / 100
    expect(series[0].apiEquivalentEur).toBe(expected)
  })
})

describe('usageSeries — the conversation is its own lane (the «Разговор» line)', () => {
  it('never mixes a conversation turn into the ordinary point of the same account-day', () => {
    const series = call(book([row(), row({ taskId: `${CHAT_TASK_ID_PREFIX}1754000000000`, inputTokens: 7, outputTokens: 3 })]))
    expect(series).toHaveLength(2)
    const chat = series.find((p: any) => String(p.taskId ?? '').startsWith(CHAT_TASK_ID_PREFIX))
    const tasks = series.find((p: any) => p.taskId === undefined)
    expect(chat).toMatchObject({ tokensIn: 7, tokensOut: 3 })
    expect(tasks).toMatchObject({ tokensIn: 100, tokensOut: 50 })
  })

  it('identifies the conversation point with a REAL booking id, and leaves task points anonymous', () => {
    const series = call(
      book([
        row({ taskId: `${CHAT_TASK_ID_PREFIX}1`, inputTokens: 1, outputTokens: 1 }),
        row({ taskId: `${CHAT_TASK_ID_PREFIX}2`, inputTokens: 1, outputTokens: 1 }),
        row(),
      ]),
    )
    const chat = series.find((p: any) => p.taskId !== undefined)
    expect(chat.taskId).toBe(`${CHAT_TASK_ID_PREFIX}2`)
    expect(chat.tokensIn).toBe(2) // the point is the day's total, not one turn
    expect(series.find((p: any) => p.taskId === undefined).taskId).toBeUndefined()
  })

  it('shows no conversation point at all when nothing was said', () => {
    const series = call(book([row(), row({ taskId: 'task-2' })]))
    expect(series.every((p: any) => p.taskId === undefined)).toBe(true)
  })
})

describe('usageSeries — the window, the account filter and the fail-open posture', () => {
  it('drops rows older than the asked-for number of days', () => {
    const series = call(book([row(), row({ ts: new Date(NOW - 20 * DAY).toISOString() })]), { days: 14 })
    expect(series).toHaveLength(1)
  })

  it('narrows to the asked-for accounts', () => {
    const series = call(book([row(), row({ accountName: 'кодекс' })]), { accounts: ['кодекс'] })
    expect(series).toHaveLength(1)
    expect(series[0].account).toBe('кодекс')
  })

  it('is empty — never a throw — when the book is missing', () => {
    const series = usageSeries({
      dataDir: '/data',
      clock: () => NOW,
      fsImpl: {
        readFileSync: () => {
          throw new Error('ENOENT')
        },
      },
    })
    expect(series).toEqual([])
  })

  it('skips a corrupt row and keeps the rest', () => {
    const fsImpl = { readFileSync: () => `${JSON.stringify(row())}\n{not json\n` }
    expect(call(fsImpl)).toHaveLength(1)
  })

  it('skips a row whose moment cannot be read at all', () => {
    expect(call(book([row({ ts: 'вчера' })]))).toEqual([])
  })
})

/**
 * ═══ ОБОРВАННАЯ ПОПЫТКА ТОЖЕ ПОТРАТИЛА ДЕНЬГИ ══════════════════════════════════════════════
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ И ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ДОКАЗАННОГО ВЫШЕ. Выше — разбор книги,
 * которая УЖЕ написана. Ниже — что она вообще пишется в том случае, ради которого всё и
 * затевалось: поток работника оборвался и финального кадра в нём нет. Снятие учёта шло циклом
 * с конца потока и при ненайденном кадре ВОЗВРАЩАЛОСЬ МОЛЧА — строка не появлялась вовсе, а
 * строка, которой нет, читается человеком ровно как «попытка ничего не стоила». Живая проверка
 * на машине: во всей истории 89 строк учёта, и все до одной сняты с финального кадра — ни
 * одной оценочной за всё время, потому что писать её было нечему.
 *
 * ПОЧЕМУ ЗДЕСЬ ГОНЯЕТСЯ НАСТОЯЩИЙ ТИК. Дыра была не в расчёте, а в проводе: обе половины —
 * и оценка, и писатель книги — существовали и были зелены по отдельности. Утверждение про
 * расчёт снова ничего бы не поймало, поэтому случаи ниже гоняют тик и смотрят, что доехало до
 * писателя книги.
 */

const tickClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const usageTask = (over: Record<string, unknown> = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

const GREEN_REVERIFY = {
  code: 0,
  stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }),
}
const RED_REVERIFY = { code: 1, stdout: JSON.stringify({ verdict: 'red' }) }

const verbRunnerOf = (responses: Record<string, unknown>) => async (_bin: string, argsArray: string[]) =>
  (responses as Record<string, unknown>)[argsArray[1]] ?? { code: 0, stdout: '{}' }

const verbs = (reverify: unknown = GREEN_REVERIFY) =>
  verbRunnerOf({
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
    reverify,
  })

const NOTE_LINES = ['APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник']

const RESULT_FRAME = JSON.stringify({
  type: 'result',
  session_id: '9f8e7d6c-1234-4abc-8def-0123456789ab',
  total_cost_usd: 0.42,
  modelUsage: { 'claude-x': { inputTokens: 1200, outputTokens: 300 } },
})

/**
 * Один тик с настоящим маршрутизатором и настоящей очередью; из внешнего мира подделаны только
 * порождение процесса и вербы. `booked` — то, что ДОШЛО до писателя книги расходов.
 */
async function tickWithBook(over: any = {}) {
  const c = over.clockObj ?? tickClock()
  const adapter = over.adapter ?? createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  if (!over.adapter) await adapter.enqueue(usageTask(over.task))
  const booked: any[] = []
  const deps: any = {
    adapter,
    ledger: { recordAttempt: (a: any) => a, readAttempts: () => [] },
    config: {
      workers: [
        {
          id: 'max-2',
          lane: 'prod',
          provider: over.provider ?? 'claude',
          account: { configDir: '/x', name: 'клод-основной' },
          enabled: true,
        },
      ],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: '/repo',
      pipeline: { enabled: true },
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: verbs(over.reverify),
    spawnWorker: (spec: any) => {
      for (const l of over.lines ?? ['stream line', ...NOTE_LINES]) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: () => {},
    bookUsage: (row: any) => booked.push(row),
    ...over.deps,
  }
  const res = await tick(deps)
  return { res, booked, adapter, clock: c }
}

describe('оборванная попытка тоже попадает в книгу расходов', () => {
  it('поток без финального кадра — строка есть, помечена оценкой', async () => {
    const { booked } = await tickWithBook({ lines: ['stream line', ...NOTE_LINES] })

    expect(booked, 'оборванная попытка не оставила в книге ни строки').toHaveLength(1)
    expect(booked[0].source).toBe('estimate')
    expect(booked[0].outputTokens).toBeGreaterThan(0) // никогда не слепой ноль
    expect(booked[0].taskId).toBe('BL-1')
  })

  it('строка оборванной попытки НАЗЫВАЕТ попытку — без номера сверка «попытка ↔ строка» невозможна', async () => {
    const { booked } = await tickWithBook({ lines: ['stream line', ...NOTE_LINES] })
    expect(booked[0].attempt).toBe(1)
  })

  it('поток С финальным кадром пишется как раньше — оценка не подменяет измерение', async () => {
    const { booked } = await tickWithBook({ lines: [RESULT_FRAME, ...NOTE_LINES] })

    expect(booked).toHaveLength(1)
    expect(booked[0]).toMatchObject({
      source: 'stream-result',
      provider: 'claude',
      costUsd: 0.42,
      inputTokens: 1200,
      outputTokens: 300,
    })
    expect(booked[0].attempt).toBe(1)
  })

  it('путь исключения тика тоже пишет учёт — упавшая в исключение попытка потратила столько же', async () => {
    const { res, booked } = await tickWithBook({
      lines: [RESULT_FRAME, ...NOTE_LINES],
      deps: {
        // Бросок ПОСЛЕ порождения процесса и ДО снятия учёта: ровно тот случай, в котором тик
        // честно падает в runtime_offline, а деньги уже потрачены.
        attemptTurns: {
          register: () => {},
          done: () => {
            throw new Error('тик умер после порождения процесса')
          },
        },
      },
    })

    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'runtime_offline' })
    expect(booked, 'исключение тика съело строку расходов').toHaveLength(1)
    expect(booked[0].attempt).toBe(1)
  })

  it('строка пишется РОВНО ОДИН раз: исключение после снятия учёта не удваивает расход', async () => {
    const { booked } = await tickWithBook({
      lines: [RESULT_FRAME, ...NOTE_LINES],
      // Бросок ПОЗЖЕ — на отчёте, когда учёт уже снят.
      deps: {
        report: async () => {
          throw new Error('отчёт умер после снятия учёта')
        },
      },
    })
    expect(booked).toHaveLength(1)
  })

  it('у задачи с тремя попытками ровно три строки, и номера различны', async () => {
    const c = tickClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(usageTask())
    // ТРИЖДЫ УБИТЫЙ ДЕМОН, а не три вежливых провала: исход не записывается вовсе (обе двери
    // записи — заглушки), поэтому строка остаётся захваченной и очередь возвращает её сама по
    // истечении аренды, с номером на единицу больше. Это ровно тот случай, ради которого весь
    // план: попытка была, деньги ушли, а закрыть её никто не успел.
    const killedDaemon = { ...adapter, complete: async () => true, fail: async () => true }
    const all: any[] = []
    for (let i = 0; i < 3; i += 1) {
      const { booked } = await tickWithBook({
        adapter: killedDaemon,
        clockObj: c,
        lines: ['stream line', ...NOTE_LINES], // финального кадра нет ни разу
        reverify: RED_REVERIFY,
      })
      all.push(...booked)
      c.advance(10000) // аренда протухла — очередь возвращает задачу с номером +1
    }

    expect(all).toHaveLength(3)
    expect(all.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(all.every((r) => r.source === 'estimate')).toBe(true)
  })
})

describe('оценка не врёт о провайдере', () => {
  it('провайдер берётся у вызывающего, а не объявлен жёстко одним значением', () => {
    expect(estimateUsage({ provider: 'claude', startedAt: 1000, endedAt: 61000 }).provider).toBe('claude')
    expect(estimateUsage({ provider: 'codex', startedAt: 1000, endedAt: 61000 }).provider).toBe('codex')
  })

  it('провайдер неизвестен — честное отсутствие, а не подстановка чужого имени', () => {
    expect(estimateUsage({ startedAt: 1000, endedAt: 61000 }).provider).toBeNull()
  })

  it('провайдер маршрута доезжает до строки оборванной попытки', async () => {
    const { booked } = await tickWithBook({ lines: ['stream line', ...NOTE_LINES] })
    expect(booked[0].provider).toBe('claude')
  })
})

describe('форма строки книги несёт номер попытки', () => {
  it('bookUsage кладёт номер попытки в записанную строку', () => {
    const written: string[] = []
    const written_row = bookUsage({
      dataDir: '/data',
      event: { taskId: 'BL-1', attempt: 7, source: 'estimate' },
      clock: () => NOW,
      fsImpl: { mkdirSync: () => {}, appendFileSync: (_p: string, text: string) => written.push(text) },
    })
    expect(written_row.attempt).toBe(7)
    expect(JSON.parse(written[0]).attempt).toBe(7)
  })

  it('номера у строки нет — поле честно пустое, а не выдуманная единица', () => {
    const written_row = bookUsage({
      dataDir: '/data',
      event: { taskId: 'chat-1' },
      clock: () => NOW,
      fsImpl: { mkdirSync: () => {}, appendFileSync: () => {} },
    })
    expect(written_row.attempt).toBeNull()
  })
})
