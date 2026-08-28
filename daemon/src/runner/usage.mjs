/**
 * usage.mjs — usage capture into the spend book, incl. the Codex gap.
 *
 * WHAT IT IS: the runner's OWN honest usage ledger. Every worker session — Claude or
 * Codex, subscription or API — books a canonical usage row so subscription work is NEVER
 * counted as $0 («Subscriptions as $0 in budgets» — our differentiator). The
 * window/budget layer and the roster window bars read these
 * rows; this module is their data source.
 *
 * THE SEAM (researcher left it open — decided here): the runner books its OWN canonical
 * rows under `<dataDir>/usage/` rather than extending ADAPTER_VERSIONS in
 * scripts/sma/lib/spend-adapter.mjs. Rationale: keep scripts/sma/lib (the zero-dep
 * substrate) UNTOUCHED by daemon concerns; a future spend-adapter entry can ingest these
 * rows if the two sources ever merge. This is a runner-side canonical event, append-only.
 *
 * ЦЕННИК ОБЩИЙ, И ЭТО ЕДИНСТВЕННОЕ, ЧТО ОТСЮДА БЕРЁТСЯ У ПОДЛОЖКИ. Своя книга — да, свой
 * список ставок — нет: `priceUsd` приходит из scripts/sma/lib/pricing.mjs, того же, по
 * которому считает командная строка. Второй список согласен с первым ровно один день — тот,
 * в который его написали, — а расходятся они молча, и узнаёт об этом человек по счёту.
 * Зависимость односторонняя: демон знает про подложку, подложка про демона — никогда.
 *
 * TWO INDEPENDENT SOURCES, reconciled at the roster:
 *   1. THIS module — the runner books per-session rows from the parsed stream/final events.
 *   2. The EXISTING `sma spend` ledger — because args.mjs sets SMA_SPEND_LOGS_DIR per
 *      worker env, the ledger's adapter also sees each Claude account's session JSONL.
 *   The roster displays both; they cross-check each other. Codex has no vendor JSONL the
 *   `sma spend` adapter understands (the GAP), so for Codex THIS module is the only source.
 *
 * COST HONESTY: a Claude `result` event carries `total_cost_usd` verbatim
 * (source 'stream-result'). A Codex `turn.completed` event carries token counts (source
 * 'codex-final'). When the final event LACKS tokens — or never arrives at all, because the
 * process was killed or the provider cut the connection — we book a time-based estimate
 * (source 'estimate') — a non-zero row, never a blind $0, and never a silence. A line that is
 * absent reads to a person as «that attempt cost nothing», and it did not.
 *
 * WHICH ATTEMPT: every row names the attempt it belongs to, not only the task. That is what
 * makes «did every attempt of mine leave a line» a query instead of an argument.
 *
 * SECURITY: a usage row carries ids + token counts + optional cost ONLY — never an OAuth
 * token, never task content, never an env-var name.
 *
 * Node built-ins only; fs is dependency-injectable so tests never touch a real ledger.
 * Zero deps; zero network.
 */

import { appendFileSync as fsAppend, readFileSync as fsRead, mkdirSync as fsMkdir } from 'node:fs'
import { join } from 'node:path'

import { priceUsd } from '../../../scripts/sma/lib/pricing.mjs'

/** Coarse time-based token rate for the estimate fallback (documented heuristic, A4). */
const EST_OUTPUT_TOKENS_PER_SEC = 20

/** The longest span this module will accept AS a session. Beyond it the pair is broken, not long. */
const MAX_ESTIMABLE_MS = 24 * 60 * 60 * 1000

/** One calendar day, for the rolling window the cost view reads. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The reserved task-id prefix a conversation books its spend under.
 *
 * It lives HERE, next to the book that stores it, because the book is the only place the
 * prefix is ever read back from: the conversation writes rows under `chat-<ts>`, and both
 * the conversation's own «что съело лимит» answer and the cost series group by exactly this
 * prefix. One definition, one law — a second copy is how the two readers start disagreeing
 * about what the conversation cost.
 */
export const CHAT_TASK_ID_PREFIX = 'chat-'

/** Finite non-negative token count (else 0). */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * WHICH ATTEMPT SPENT THIS — a positive whole number, or an honest null.
 *
 * A row used to name only the task, and a task may hold many attempts. That made the one
 * question worth asking of this book — «did every attempt of mine leave a line» — impossible to
 * ANSWER: the best available check was «rows are not fewer than attempts», which is a guess
 * dressed as a check and passes just as well when two attempts share one row. With the number
 * on the row the check is a join, and a missing line becomes visible instead of arguable.
 *
 * Null rather than 1 when nobody said: the conversation books rows that belong to no attempt at
 * all, and inventing a first attempt for them would put a fact into an audit book that nothing
 * in the world corresponds to.
 */
function attemptNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * ЧЕТЫРЕ ЧИСЛА ОДНОЙ ПОПЫТКИ — вход, выход, чтение кэша, запись кэша.
 *
 * ЗАЧЕМ ИХ ЧЕТЫРЕ, А НЕ ДВА. Строка книги трат несёт вход и выход, потому что книга отвечает
 * на вопрос «сколько потрачено». У попытки вопрос другой — «из чего сложился этот счёт», — и
 * ответ на него без кэша не читается вовсе: сессия, у которой миллион прочитан из кэша, и
 * сессия, у которой тот же миллион отправлен заново, стоят по-разному в разы, а по двум
 * числам выглядят одинаково.
 *
 * ЭТО ТЕЛЕМЕТРИЯ ПРОВАЙДЕРА, А НЕ НАШ РАСЧЁТ. Здесь ничего не оценивается и не выводится:
 * что кадр сказал, то и записано. Оценка живёт в `estimateUsage` и называется оценкой; у
 * попытки, чей кадр так и не пришёл, четырёх чисел просто НЕТ (вызывающий пишет отсутствие),
 * потому что догадка в поле «провайдер сообщил» — это ложь, а не приближение.
 *
 * ОБА НАПИСАНИЯ ПОЛЕЙ. Кадр приходит от внешней командной строки, и она за свою историю
 * писала счётчики и camelCase, и snake_case. Читаются оба — читатель, знающий одно, молча
 * возвращает нули на потоке, который вообще-то всё сказал.
 *
 * @param {{modelUsage?:object|null}} resultEvent — parseClaudeEvent output for a `result` frame
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}}
 */
export function claudeTokensFromResult(resultEvent = {}) {
  const modelUsage = resultEvent && typeof resultEvent.modelUsage === 'object' ? resultEvent.modelUsage : {}
  const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  // ОДНА ПОПЫТКА — ОДИН СЧЁТ, сколько бы моделей в ней ни говорило: сессия, сменившая модель
  // на середине, потратила сумму, а не последнее из двух чисел.
  for (const k of Object.keys(modelUsage || {})) {
    const mu = modelUsage[k] || {}
    counts.input += num(mu.inputTokens ?? mu.input_tokens)
    counts.output += num(mu.outputTokens ?? mu.output_tokens)
    counts.cacheRead += num(mu.cacheReadInputTokens ?? mu.cache_read_input_tokens)
    counts.cacheWrite += num(mu.cacheCreationInputTokens ?? mu.cache_creation_input_tokens)
  }
  return counts
}

/**
 * codexTokensFromFinal(finalEvent) → те же четыре числа с финального кадра Codex.
 *
 * ЗАПИСЬ КЭША У ЭТОГО ПОСТАВЩИКА НЕ СООБЩАЕТСЯ ВОВСЕ — его `usage` знает про кэш только
 * прочитанное. Ноль здесь означает «поставщик про это не говорит», и это ровно тот случай,
 * когда ноль честнее пропуска: четвёрка полей у попытки одна на обоих поставщиков, иначе
 * читателю пришлось бы знать, чьей попытке принадлежит квитанция, прежде чем её прочесть.
 *
 * @param {{usage?:object}} finalEvent — parseCodexEvent output for a `turn.completed` frame
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}}
 */
export function codexTokensFromFinal(finalEvent = {}) {
  const usage = finalEvent && typeof finalEvent.usage === 'object' ? finalEvent.usage || {} : {}
  return {
    input: num(usage.input_tokens ?? usage.inputTokens),
    output: num(usage.output_tokens ?? usage.outputTokens),
    cacheRead: num(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens),
    cacheWrite: 0,
  }
}

/**
 * claudeUsageFromResult(resultEvent, ctx) → a canonical usage row from a parsed Claude
 * `result` event (parseClaudeEvent output). Sums the modelUsage token counts and carries
 * the event's total_cost_usd verbatim. source: 'stream-result'.
 *
 * ОДИН ЧИТАТЕЛЬ КАДРА НА КНИГУ И НА КВИТАНЦИЮ: суммирование живёт в `claudeTokensFromResult`
 * выше и зовётся отсюда. Две копии одного разбора согласны в день, когда их написали, и
 * расходятся в день, когда поставщик переименует поле в одной из них.
 *
 * ЧЕТЫРЕ ЧИСЛА КЛАДУТСЯ В СТРОКУ ЦЕЛИКОМ, А НЕ ДВА ИЗ ЧЕТЫРЁХ. Читатель кадра возвращал все
 * четыре и с самого начала, а строка книги брала вход и выход и роняла кэш на пол — то есть
 * ровно ту половину, без которой «сколько это стоило бы по ценнику» не считается вовсе:
 * прочитанный из кэша миллион и отправленный заново миллион отличаются в цене в разы, а по
 * двум числам выглядят одинаково.
 *
 * @param {{totalCostUsd?:number|null, modelUsage?:object|null}} resultEvent
 * @param {{accountName?:string, taskId?:string, attempt?:number, model?:string}} [ctx]
 * @returns {object}
 */
export function claudeUsageFromResult(resultEvent = {}, { accountName, taskId, attempt, model, channel } = {}) {
  const modelUsage = resultEvent && typeof resultEvent.modelUsage === 'object' ? resultEvent.modelUsage : {}
  const modelKeys = Object.keys(modelUsage || {})
  const modelName = model ?? modelKeys[0] ?? null

  const {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
  } = claudeTokensFromResult(resultEvent)

  const row = {
    accountName: accountName ?? null,
    provider: 'claude',
    taskId: taskId ?? null,
    attempt: attemptNumber(attempt),
    model: modelName,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    source: 'stream-result',
    ...(channel !== undefined ? { channel } : {}),
  }
  const cost = Number(resultEvent && resultEvent.totalCostUsd)
  if (Number.isFinite(cost)) row.costUsd = cost
  return row
}

/**
 * codexUsageFromFinal(finalEvent, ctx) → a canonical usage row from a parsed Codex
 * `turn.completed` event (parseCodexEvent output). When the event carries token counts →
 * source 'codex-final'. When it does NOT (the A4 gap) → falls back to estimateUsage
 * (source 'estimate') so the row is never a blind $0.
 *
 * @param {{usage?:object}} finalEvent
 * @param {{accountName?:string, taskId?:string, model?:string, startedAt?:number, endedAt?:number}} [ctx]
 * @returns {object}
 */
export function codexUsageFromFinal(finalEvent = {}, ctx = {}) {
  // ТОТ ЖЕ ЧИТАТЕЛЬ КАДРА, что у квитанции попытки — см. `claudeUsageFromResult` о двух копиях
  // одного разбора.
  const {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
  } = codexTokensFromFinal(finalEvent)

  if (inputTokens === 0 && outputTokens === 0) {
    // A4 gap — book a time-based estimate, never blind $0. The provider is NAMED on the way in:
    // the estimate no longer declares one of its own (see estimateUsage), because it is now
    // written for any provider, not only for the one case it was born in.
    return estimateUsage({ ...ctx, provider: ctx.provider ?? 'codex' })
  }

  return {
    accountName: ctx.accountName ?? null,
    provider: 'codex',
    taskId: ctx.taskId ?? null,
    attempt: attemptNumber(ctx.attempt),
    model: ctx.model ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    // Запись кэша этот поставщик не сообщает вовсе (см. `codexTokensFromFinal`): ноль здесь
    // значит «про это не говорят», и четвёрка полей у строки одна на обоих поставщиков.
    cacheWriteTokens,
    source: 'codex-final',
    ...(ctx.channel !== undefined ? { channel: ctx.channel } : {}),
  }
}

/**
 * estimateUsage(ctx) → a time-based usage row (source 'estimate') when no token counts
 * are available. Books a NON-ZERO output-token estimate from the session duration so
 * subscription work is never silently $0. Coarse by design; LABELED honestly — a coarse
 * estimate called an estimate is a record, and the same figure called a measurement is a lie,
 * which is why `source` is not negotiable and no caller may overwrite it.
 *
 * THE PROVIDER COMES FROM THE CALLER. It used to be declared here as one fixed name, because
 * this row was born for one case: the vendor whose final frame sometimes arrives without token
 * counts. Now the same row is written for ANY attempt whose stream simply ended — a killed
 * process, a cut connection — and a row that names the wrong vendor is worse than a row that
 * admits it does not know. Unknown stays null.
 *
 * @param {{accountName?:string, taskId?:string, attempt?:number, provider?:string, model?:string, startedAt?:number, endedAt?:number}} [ctx]
 * @returns {object}
 */
export function estimateUsage({ accountName, taskId, attempt, provider, model, startedAt, endedAt, channel } = {}) {
  // A DURATION IS ONLY A DURATION WHEN BOTH ENDS ARE REAL.
  //
  // This subtracted a missing start from an epoch-millisecond end and called the result a
  // session length: fifty-six years, booked as tokens, into the same book the spending cap
  // reads. The guard is not «clamp it smaller» — it is «refuse to invent»: without a
  // believable pair the estimate falls to its floor, which is what «we do not know, and it
  // was not free» honestly looks like. An attempt longer than a day is not a long attempt,
  // it is a broken pair.
  const from = Number(startedAt)
  const to = Number(endedAt)
  const believable = Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from && to - from <= MAX_ESTIMABLE_MS
  const durationMs = believable ? to - from : 0
  const estOutputTokens = Math.max(1, Math.round((durationMs / 1000) * EST_OUTPUT_TOKENS_PER_SEC))
  return {
    accountName: accountName ?? null,
    provider: provider ?? null,
    taskId: taskId ?? null,
    attempt: attemptNumber(attempt),
    model: model ?? null,
    inputTokens: 0,
    outputTokens: estOutputTokens,
    // Кэш оценке неоткуда взять: он не выводится из длительности ничем. Нули здесь — это
    // «поставщик не сказал», и строка всё равно помечена оценкой, поэтому в справочную цену
    // она попадает как оценка, а не как измерение.
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: 'estimate',
    ...(channel !== undefined ? { channel } : {}),
  }
}

/**
 * bookUsage({dataDir, event, clock, fsImpl}) → the written row. Appends ONE canonical
 * usage row to the append-only `<dataDir>/usage/usage.jsonl`. Missing fields are
 * normalized; `ts` defaults to the injected clock. No secret ever enters the row.
 *
 * @param {{dataDir:string, event:object, clock?:Function, fsImpl?:object}} opts
 * @returns {object} the row written
 */
export function bookUsage({ dataDir, event = {}, clock = Date.now, fsImpl } = {}) {
  const appendFileSync = fsImpl?.appendFileSync ?? fsAppend
  const mkdirSync = fsImpl?.mkdirSync ?? fsMkdir

  const dir = join(dataDir, 'usage')
  mkdirSync(dir, { recursive: true })

  const row = {
    ts: event.ts ?? new Date(clock()).toISOString(),
    accountName: event.accountName ?? null,
    provider: event.provider ?? null,
    taskId: event.taskId ?? null,
    // WHICH ATTEMPT — see attemptNumber above. This is the field that turns «на задачу строк не
    // меньше, чем попыток» into a join a person can run.
    attempt: attemptNumber(event.attempt),
    model: event.model ?? null,
    inputTokens: num(event.inputTokens),
    outputTokens: num(event.outputTokens),
    // ЧЕТЫРЕ ЧИСЛА, А НЕ ДВА — иначе цена «как если бы по API» не считается по этой книге:
    // кэш стоит своих ставок, и строка без него занижает счёт молча. Строка, записанная до
    // этого, кэша не несёт вовсе, и ноль читается как «не записано», а не как «не было».
    cacheReadTokens: num(event.cacheReadTokens),
    cacheWriteTokens: num(event.cacheWriteTokens),
    source: event.source ?? 'unknown',
    // WHICH MONEY THIS IS. A subscription session carries a real costUsd — that is the
    // «subscriptions are never $0» differentiator — but that figure is what the plan
    // absorbed, not an invoice. Without this field the two kinds summed into one number,
    // and one chat message showed up as «платный канал сегодня 0,12 €» directly above the
    // line «платный канал не используется вовсе» (QA D4, 11.08.2026). Absent on old rows →
    // read as 'subscription', which is what every row before the paid channel ever engaged
    // actually was.
    channel: event.channel === 'api' ? 'api' : 'subscription',
  }
  if (Number.isFinite(Number(event.costUsd))) row.costUsd = Number(event.costUsd)

  appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify(row) + '\n', 'utf8')
  return row
}

/**
 * readUsageRows({dataDir, accountName, windowMs, clock, fsImpl}) → the raw canonical rows,
 * filtered by account and/or rolling window. THE ONE PARSER of the book's format: every
 * consumer that needs rows (the window totals below, the spend screen, the conversation's
 * «что съело лимит» answer) goes through this function, so the book is never re-parsed by a
 * second reader that could drift from the writer above. A missing/corrupt book yields fewer
 * rows, never an error (fail-open — a spend view must not take the daemon down).
 *
 * @param {{dataDir:string, accountName?:string, windowMs?:number, clock?:Function, fsImpl?:object}} opts
 * @returns {object[]}
 */
export function readUsageRows({ dataDir, accountName, windowMs, clock = Date.now, fsImpl } = {}) {
  const readFileSync = fsImpl?.readFileSync ?? fsRead

  let text = ''
  try {
    text = readFileSync(join(dataDir, 'usage', 'usage.jsonl'), 'utf8')
  } catch {
    return [] // no book yet → nothing spent, never an error
  }

  const cutoff = windowMs ? clock() - windowMs : Number.NEGATIVE_INFINITY
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue // a corrupt row is skipped, never fatal
    }
    if (accountName && r.accountName !== accountName) continue
    if (windowMs) {
      const t = Date.parse(r.ts)
      if (Number.isFinite(t) && t < cutoff) continue
    }
    out.push(r)
  }
  return out
}

/** The local calendar day of a moment, as `YYYY-MM-DD` — the day the reader lived, not UTC. */
function dayOf(ms) {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Cents, never fractions of one — money on the glass is rounded once, here. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * usageSeries({dataDir, days, accounts, clock, fsImpl}) → the cost history the «Расходы»
 * screen draws: one point per day, per account, per LANE.
 *
 * Two things about it are deliberate.
 *
 * TOKENS AND MONEY BOTH TRAVEL. A subscription session books no dollar cost — it is paid
 * for by the plan, not by the invoice — so a series that carried euros alone would show a
 * night of real work as a flat zero (in the one place a founder actually looks
 * for it). Every point therefore carries the token counts it is made of; the euro figure is
 * the API-fallback money, and it is honestly zero when nothing was billed.
 *
 * THE CONVERSATION IS ITS OWN LANE. Rows booked under the reserved `chat-` prefix are kept
 * apart from the ordinary task rows of the same day and account, and the point carries the
 * booking id it came from, so the screen can group them into their own line by the same
 * prefix the conversation writes. Splitting by lane — rather than by task — is what keeps
 * the payload small: at most two points per account per day, whatever the park did.
 *
 * ЧЕТЫРЕ ЧИСЛА И ЦЕНА «КАК ЕСЛИ БЫ ПО API». Точка несёт вход, выход, чтение кэша и запись
 * кэша по отдельности, потому что вопрос экрана — не только «сколько», но и «из чего»: день,
 * у которого миллион прочитан из кэша, и день, у которого тот же миллион отправлен заново,
 * стоят по-разному в разы, а по двум числам выглядят одинаково. Рядом едет `apiEquivalentEur`
 * — что этот же расход стоил бы по ценнику платформы, посчитанное ПОСТРОЧНО, каждая строка по
 * ставкам СВОЕЙ модели: день, в середине которого сменили модель, иначе оценивался бы по
 * последней из них.
 *
 * ЭТО СПРАВОЧНАЯ ЦИФРА, А НЕ СЧЁТ. Работа идёт по подписке, которая уже оплачена; сложить её
 * с `eur` значило бы выставить себе счёт дважды, поэтому это ОТДЕЛЬНОЕ поле, а обязанность
 * назвать его словами лежит на экране. `unpricedTokens` — та часть токенов, чью модель ценник
 * не знает: без неё справочная цена молча занижается, а выглядит точной.
 *
 * `model` — имя модели, через которую прошло БОЛЬШИНСТВО токенов полосы за день. Точка — это
 * сумма дня, а не один ход, и одно имя на ней отвечает на вопрос «чем это делалось», не
 * притворяясь, что модель была ровно одна.
 *
 * A missing or corrupt book yields fewer points, never an error.
 *
 * @param {{dataDir:string, days?:number, accounts?:string[], clock?:Function, fsImpl?:object}} opts
 * @returns {{day:string, account:string, tokensIn:number, tokensOut:number, cacheRead:number,
 *   cacheWrite:number, model:string|null, eur:number, apiEquivalentEur:number,
 *   unpricedTokens:number, taskId?:string}[]}
 */
export function usageSeries({ dataDir, days = 14, accounts, clock = Date.now, fsImpl } = {}) {
  const span = Math.max(1, Math.floor(Number(days) || 14))
  const rows = readUsageRows({ dataDir, windowMs: span * DAY_MS, clock, fsImpl })
  const wanted = Array.isArray(accounts) && accounts.length > 0 ? new Set(accounts.map(String)) : null

  const points = new Map()
  /** Сколько токенов прошло через каждую модель — по точке; из этого выбирается имя на выходе. */
  const models = new Map()
  for (const r of rows) {
    const at = Date.parse(r.ts)
    if (!Number.isFinite(at)) continue // an unstampable row belongs to no day
    const account = r.accountName == null ? 'unknown' : String(r.accountName)
    if (wanted && !wanted.has(account)) continue

    const taskId = String(r.taskId ?? '')
    const conversation = taskId.startsWith(CHAT_TASK_ID_PREFIX)
    const day = dayOf(at)
    const key = `${day}\u0000${account}\u0000${conversation ? 'chat' : 'task'}`

    let point = points.get(key)
    if (!point) {
      point = {
        day,
        account,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        model: null,
        eur: 0,
        apiEquivalentEur: 0,
        unpricedTokens: 0,
      }
      points.set(key, point)
      models.set(key, new Map())
    }

    const counts = {
      input: num(r.inputTokens),
      output: num(r.outputTokens),
      cacheRead: num(r.cacheReadTokens),
      cacheWrite: num(r.cacheWriteTokens),
    }
    point.tokensIn += counts.input
    point.tokensOut += counts.output
    point.cacheRead += counts.cacheRead
    point.cacheWrite += counts.cacheWrite

    const model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null
    const rowTokens = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    if (model) {
      const tally = models.get(key)
      tally.set(model, (tally.get(model) ?? 0) + rowTokens)
    }

    // ЦЕНА СЧИТАЕТСЯ ПО ОБЩЕМУ ЦЕННИКУ (scripts/sma/lib/pricing.mjs) — тому же, по которому
    // считает командная строка. Модель ценнику неизвестна → цены НЕТ, и токены уходят в
    // `unpricedTokens`: ноль на этом месте назвал бы бесплатной работу, которую просто некому
    // оценить.
    const usd = priceUsd({ model, ...counts })
    if (usd == null) point.unpricedTokens += rowTokens
    else point.apiEquivalentEur += usd

    // The point's euro figure is what this file's own header promises: «the API-fallback
    // money, honestly zero when nothing was billed». Subscription rows ride the token
    // counts; their estimate never lands in a euro column (QA D4).
    if (r.channel === 'api' && Number.isFinite(Number(r.costUsd))) point.eur += Number(r.costUsd)
    // The lane is identified by one of its own real bookings — the latest one seen. The
    // point is a day's total, not one turn, and the id says only which lane it belongs to.
    if (conversation) point.taskId = taskId
  }

  return [...points.entries()]
    .map(([key, p]) => ({
      ...p,
      model: dominantModel(models.get(key)),
      eur: round2(p.eur),
      apiEquivalentEur: round2(p.apiEquivalentEur),
    }))
    .sort((a, b) => (a.day === b.day ? a.account.localeCompare(b.account) : a.day.localeCompare(b.day)))
}

/**
 * Имя модели, через которую прошло больше всего токенов точки — или null, когда ни одна строка
 * модели не назвала. Ничья решается именем, чтобы одна и та же книга давала один и тот же
 * ответ при каждом чтении: показание, зависящее от порядка строк, — это не показание.
 */
function dominantModel(tally) {
  if (!tally || tally.size === 0) return null
  let best = null
  let bestTokens = -1
  for (const [model, tokens] of tally) {
    if (tokens > bestTokens || (tokens === bestTokens && model.localeCompare(best) < 0)) {
      best = model
      bestTokens = tokens
    }
  }
  return best
}

/**
 * readUsage({dataDir, accountName, windowMs, clock, fsImpl}) → per-account rolling-window
 * totals. Sums input/output tokens + cost over rows for `accountName` whose `ts` falls
 * inside [now - windowMs, now]. A missing book → all-zero totals (fail-open, never throws).
 * This is the input for the window bars.
 *
 * @param {{dataDir:string, accountName?:string, windowMs?:number, clock?:Function, fsImpl?:object}} opts
 * @returns {{accountName:string|undefined, inputTokens:number, outputTokens:number, costUsd:number, apiCostUsd:number, rows:number, windowMs:number|undefined}}
 */
export function readUsage({ dataDir, accountName, windowMs, clock = Date.now, fsImpl } = {}) {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let rows = 0

  let apiCostUsd = 0
  for (const r of readUsageRows({ dataDir, accountName, windowMs, clock, fsImpl })) {
    inputTokens += num(r.inputTokens)
    outputTokens += num(r.outputTokens)
    if (Number.isFinite(Number(r.costUsd))) {
      costUsd += Number(r.costUsd)
      // The paid-channel share, separately: this is the ONLY figure a screen may put under
      // a label that says «платный канал». A row without a channel predates the field and
      // was subscription work by construction (QA D4).
      if (r.channel === 'api') apiCostUsd += Number(r.costUsd)
    }
    rows += 1
  }

  return { accountName, inputTokens, outputTokens, costUsd, apiCostUsd, rows, windowMs }
}
