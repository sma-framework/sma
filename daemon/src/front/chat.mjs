/**
 * chat.mjs — the engine behind the «Разговор» screen (D-9.7-13/15).
 *
 * WHAT IT IS: one door (`handleChatTurn`) for a question asked in plain words, and the
 * machinery that answers it. Not a chatbot bolted onto the daemon — a lane with three laws
 * built into its structure, so the sentence the screen prints under the input box is true by
 * construction and not by good intentions:
 *
 *     «Читает и предлагает. Ничего не запускает сам.»
 *
 * That formula is the UI contract (CHAT_BOUNDARY_FORMULA below — the screen renders this
 * exact string). Here is what makes it honest:
 *
 * ── LAW 1 · HYBRID (D-9.7-13). A factual question is not a job for a model. «Почему упала
 *    задача X» is a dictionary lookup over the SAME failure vocabulary the roster renders;
 *    «что съело лимит» is arithmetic over the spend book; «что с задачей» is a status read.
 *    Those three branches are pure functions over injected sources — instant, free, and
 *    incapable of spawning anything. Only a genuinely open question reaches a model session.
 *    A misclassification is SAFE by design: the free branch answers honestly too, just dearer.
 *
 * ── LAW 2 · HANDS TIED (D-9.7-13). The one «action» this engine can take is to put a task
 *    DRAFT in its answer — a card with a title, a proposed worker, a mode and acceptance.
 *    The human presses «Создать»; the SPA then posts the ordinary task-creation request that
 *    any screen posts. This module has NO path to the queue: it reads the adapter and never
 *    writes, and the queue-writing verb does not appear in this file at all. A capability that
 *    is absent cannot be smuggled — which is why the worst outcome of a successful prompt
 *    injection here is a draft a human declines.
 *
 * ── LAW 3 · OUTSIDE THE QUEUE (D-9.7-15). A conversation builds nothing, so it takes no
 *    queue slot, no worktree, no receipt, and never appears among the tasks. The free branch
 *    calls the spawn primitive DIRECTLY (see dispatchFreeTurn) — never the tick/claim path —
 *    and books its spend under a reserved task id (`chat-<ts>`), which is what makes the
 *    «Разговор» line on «Расходы» real instead of invisible.
 *
 * THE TRANSCRIPT IS NOT THE TRUTH. History is an append-only ndjson next to the daemon's
 * config, capped by turn count. It is a record of what was said; the truth about the park is
 * the derived state, always re-read. Stored turns are DATA: they are read back, never
 * executed, and never rendered as instructions to anything.
 *
 * Node built-ins only; every source (queue, spend book, clock, fs, spawner) is injected, so
 * the whole suite runs without a socket, a token or a child process. Zero deps.
 */

import {
  mkdirSync as fsMkdirSync,
  appendFileSync as fsAppendFileSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { REASON_LABELS } from '../queue/adapter.mjs'
import { readUsageRows } from '../runner/usage.mjs'

/** The sentence the screen prints under the input box — the boundary, in the founder's words. */
export const CHAT_BOUNDARY_FORMULA = 'Читает и предлагает. Ничего не запускает сам.'

/** Short RU chips for a task card. The card says what the park says, in human words. */
export const STATUS_LABELS = Object.freeze({
  queued: 'В очереди',
  claimed: 'В работе',
  awaiting_approval: 'Ждёт решения',
  completed: 'Готово',
  failed: 'Не получилось',
})

/** One-sentence status answers — «что с задачей» is answered in a line, then the card. */
const STATUS_SENTENCE = Object.freeze({
  queued: 'Ждёт в очереди.',
  claimed: 'Сейчас в работе.',
  awaiting_approval: 'Готово и ждёт Вашего решения.',
  completed: 'Готово.',
  failed: 'Не получилось.',
})

/** How many turns the transcript keeps. Older turns fall off — the file never grows forever. */
export const HISTORY_TURN_CAP = 200

/** The reserved task-id prefix for a conversation turn — the contract of the «Разговор» line. */
export const CHAT_TASK_ID_PREFIX = 'chat-'

/** How the spend answer names the conversation's own share. */
const CHAT_SPEND_LABEL = 'Разговор'

/** Where the spend answer sends the reader for the full picture. */
const SPEND_LINK = Object.freeze({ screen: 'spend', label: 'Подробнее на Расходах' })

// ── the classifier (dictionary patterns, never a model) ────────────────────────

/** «сколько потратили», «что съело лимит» — a spend question. */
const SPEND_RE = /съел|съед|потрат|расход|лимит|бюджет|сколько сто/i
/** «упала», «не получилось», «отказ» — a failure question (needs a task in sight, see below). */
const FAIL_RE = /упал|не получилось|не вышло|провал|отказ|сорвал|ошибк/i
/** «какой статус», «что с задачей», «как дела» — a status question. */
const STATUS_RE = /статус|что с |как дела|где сейчас|на чём/i
/** Something in the sentence points at a task — otherwise a failure word is just a mood. */
const TASK_REF_RE = /задач|карточк|про /i

/**
 * classifyTurn(text) → 'fail-reason' | 'spend' | 'status' | 'free'.
 *
 * Dictionary patterns over the founder's own phrasings, in a fixed order: spend, then a
 * failure question that actually names a task, then status, else free. No model is consulted
 * to decide whether a model is needed — that would defeat the point of the split.
 *
 * @param {string} text
 * @returns {'fail-reason'|'spend'|'status'|'free'}
 */
export function classifyTurn(text) {
  const s = String(text ?? '')
  if (!s.trim()) return 'free'
  if (SPEND_RE.test(s)) return 'spend'
  if (FAIL_RE.test(s) && TASK_REF_RE.test(s)) return 'fail-reason'
  if (STATUS_RE.test(s)) return 'status'
  return 'free'
}

// ── shared helpers for the fact models ─────────────────────────────────────────

/** Words too short or too common to identify a task by. */
const STOP_WORDS = new Set(['задача', 'задачу', 'задаче', 'задачи', 'задачей', 'про', 'что', 'почему', 'какой', 'как'])

/** Split a phrase into comparable stems (lowercased, punctuation dropped, short words out). */
function stems(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    .map((w) => w.slice(0, 5)) // a crude stem: RU inflection lives in the tail
}

/**
 * The rows, newest ACTIVITY first — the tiebreaker when the phrase names no task.
 *
 * Recency here means «last worked on», so only the work timestamps are read. The queueing
 * timestamp is deliberately NOT read in this module: its field name carries the queue-writing
 * verb, and the law of this lane is that the verb does not appear in this file at all — a
 * grep is a proof a reader can run, and it is worth more than a sharper tiebreak for a
 * question that named no task. A row nobody has touched yet therefore sorts last.
 */
function byRecency(rows) {
  const ts = (r) => Number(r.completedAt ?? r.claimedAt ?? 0) || 0
  return [...rows].sort((a, b) => ts(b) - ts(a))
}

/**
 * findTask(text, rows) → the row the phrase is about, or null. Scores each title by how many
 * of its stems the question repeats; ties and misses fall back to the most recent row. Wrong
 * guesses are visible, not silent: the answer always carries the CARD of the task it read, so
 * the human sees immediately if the engine picked the wrong one.
 */
function findTask(text, rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return null
  const asked = new Set(stems(text))
  let best = null
  let bestScore = 0
  for (const r of byRecency(list)) {
    const score = stems(r.title).filter((w) => asked.has(w)).length
    if (score > bestScore) {
      best = r
      bestScore = score
    }
  }
  return best ?? byRecency(list)[0] ?? null
}

/** taskCard(row) → the grey link-card the answer carries beside its sentence. */
function taskCard(row) {
  if (!row) return null
  return {
    id: row.id ?? null,
    title: row.title ?? null,
    status: row.status ?? null,
    statusLabel: STATUS_LABELS[row.status] ?? null,
  }
}

/** Capitalize the first letter of a dictionary label so it reads as a sentence. */
function sentence(label) {
  const s = String(label ?? '').trim()
  if (!s) return ''
  return `${s[0].toUpperCase()}${s.slice(1)}.`
}

// ── fact model 1: «почему упала задача X» ──────────────────────────────────────

/**
 * answerFailReason({text, rows}) → the one-phrase reason + the task card. The phrase comes
 * from the SAME failure dictionary the roster's red card renders (imported, not restated), so
 * the conversation and the screens can never tell the founder two different stories.
 *
 * @param {{text?:string, rows?:object[]}} args
 * @returns {{kind:'fact', text:string, taskRef:(object|null)}}
 */
export function answerFailReason({ text, rows } = {}) {
  const failed = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'failed')
  const row = findTask(text, failed)
  if (!row) {
    return { kind: 'fact', text: 'Пока ни одна задача не возвращалась с отказом.', taskRef: null }
  }
  const label = REASON_LABELS[row.failure_reason] ?? 'причина не записана'
  return { kind: 'fact', text: sentence(label), taskRef: taskCard(row) }
}

// ── fact model 2: «что съело лимит» ────────────────────────────────────────────

/** The display name of the worker sitting on an account, else the account's own name. */
function workerLabel(accountName, workers) {
  const w = (Array.isArray(workers) ? workers : []).find((x) => (x.account ?? x.id) === accountName)
  if (!w) return String(accountName ?? 'без имени')
  return w.name ?? w.title ?? w.id ?? String(accountName)
}

/**
 * answerSpend({rows, workers, limit}) → the three percentage lines and the link to «Расходы».
 * Shares are computed over TOKENS, the one figure every row carries (a subscription row books
 * no dollar cost — counting money here would silently drop the very work the founder is asking
 * about). Turns of the conversation itself are grouped under «Разговор» by their reserved task
 * id, so the lane pays for itself in public.
 *
 * @param {{rows?:object[], workers?:object[], limit?:number}} args
 * @returns {{kind:'fact', text:string, spend:object[], link:object}}
 */
export function answerSpend({ rows, workers, limit = 3 } = {}) {
  const totals = new Map()
  let grand = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    const tokens = (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0)
    if (tokens <= 0) continue
    const isChat = String(r.taskId ?? '').startsWith(CHAT_TASK_ID_PREFIX)
    const key = isChat ? CHAT_SPEND_LABEL : String(r.accountName ?? 'unknown')
    const prev = totals.get(key) ?? { key, label: isChat ? CHAT_SPEND_LABEL : workerLabel(key, workers), tokens: 0 }
    prev.tokens += tokens
    totals.set(key, prev)
    grand += tokens
  }

  if (!grand) {
    return { kind: 'fact', text: 'Пока ничего не потрачено — окно не тронуто.', spend: [], link: SPEND_LINK }
  }

  const spend = [...totals.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
    .map((e) => ({ id: e.key, label: e.label, percent: Math.round((e.tokens / grand) * 100) }))

  const text = spend.map((e) => `${e.label} ${e.percent} процентов`).join('\n')
  return { kind: 'fact', text, spend, link: SPEND_LINK }
}

// ── fact model 3: «что с задачей X» ────────────────────────────────────────────

/**
 * answerStatus({text, rows}) → the status sentence + the task card.
 *
 * @param {{text?:string, rows?:object[]}} args
 * @returns {{kind:'fact', text:string, taskRef:(object|null)}}
 */
export function answerStatus({ text, rows } = {}) {
  const row = findTask(text, rows)
  if (!row) {
    return { kind: 'fact', text: 'Такой задачи не нашлось — весь список на «Сегодня».', taskRef: null }
  }
  return { kind: 'fact', text: STATUS_SENTENCE[row.status] ?? 'Статус неизвестен.', taskRef: taskCard(row) }
}

// ── the transcript (append-only ndjson, capped) ────────────────────────────────

/** The transcript lives beside the daemon's config, under the same directory discipline. */
function historyFile(dir) {
  return join(dir, 'chat', 'history.ndjson')
}

/**
 * appendTurn({dir, turn, fsImpl, clock, cap}) → the stored record. Appends ONE line and, when
 * the file has outgrown `cap` turns, rewrites it with the newest `cap` lines: append-only in
 * reading order, bounded in size. The turn's text is stored verbatim as DATA — no
 * interpretation, no execution, ever.
 *
 * @param {{dir:string, turn:object, fsImpl?:object, clock?:Function, cap?:number}} args
 * @returns {object} the record written
 */
export function appendTurn({ dir, turn = {}, fsImpl, clock = Date.now, cap = HISTORY_TURN_CAP } = {}) {
  if (!dir) throw new Error('appendTurn: dir is required')
  const mkdirSync = fsImpl?.mkdirSync ?? fsMkdirSync
  const appendFileSync = fsImpl?.appendFileSync ?? fsAppendFileSync
  const readFileSync = fsImpl?.readFileSync ?? fsReadFileSync
  const writeFileSync = fsImpl?.writeFileSync ?? fsWriteFileSync

  const record = {
    ts: turn.ts ?? new Date(clock()).toISOString(),
    conversationId: turn.conversationId ?? null,
    role: turn.role ?? 'user',
    kind: turn.kind ?? null,
    text: String(turn.text ?? ''),
  }
  if (turn.taskRef) record.taskRef = turn.taskRef
  if (turn.draft) record.draft = turn.draft
  if (turn.error) record.error = String(turn.error)

  const file = historyFile(dir)
  mkdirSync(join(dir, 'chat'), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')

  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return record // unreadable right after writing → leave the file alone, never throw
  }
  if (lines.length > cap) {
    writeFileSync(file, `${lines.slice(lines.length - cap).join('\n')}\n`, 'utf8')
  }
  return record
}

/**
 * readHistory({dir, conversationId, limit, fsImpl}) → the tail of the transcript, oldest
 * first. A missing or corrupt book yields fewer turns, never an error. Every returned turn is
 * DATA for rendering; nothing here is ever handed to a shell, a queue or a prompt unfenced.
 *
 * @param {{dir:string, conversationId?:string, limit?:number, fsImpl?:object}} args
 * @returns {object[]}
 */
export function readHistory({ dir, conversationId, limit = 50, fsImpl } = {}) {
  const readFileSync = fsImpl?.readFileSync ?? fsReadFileSync
  let text = ''
  try {
    text = readFileSync(historyFile(dir), 'utf8')
  } catch {
    return [] // no transcript yet — an empty conversation, not an error
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue // a torn line is skipped, never fatal
    }
    if (conversationId && r.conversationId !== conversationId) continue
    out.push(r)
  }
  return out.slice(Math.max(0, out.length - limit))
}

// ── the single door ────────────────────────────────────────────────────────────

/** A conversation id is minted from the clock — readable, sortable, no dependency. */
function newConversationId(clock) {
  return `conv-${clock()}`
}

/**
 * handleChatTurn({text, conversationId, deps}) → {conversationId, kind, answer}.
 *
 * The ONE entry point: classify, answer (from the read-models or, for an open question, from
 * the free branch), record both turns, return. Reading the park happens here so the fact
 * models stay pure functions a test can call directly.
 *
 * deps: { adapter (list only), readUsageRows|dataDir, config, historyDir, clock, fsImpl,
 *         dispatchFree, ...the free branch's own spawn dependencies }
 *
 * @param {{text:string, conversationId?:string, deps?:object}} args
 * @returns {Promise<{conversationId:string, kind:string, answer:object}>}
 */
export async function handleChatTurn({ text, conversationId, deps = {} } = {}) {
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const convId = conversationId || newConversationId(clock)
  const kind = classifyTurn(text)

  let answer
  if (kind === 'free') {
    const dispatch = deps.dispatchFree ?? dispatchFreeTurn
    answer = await dispatch({ text, conversationId: convId, deps })
  } else if (kind === 'spend') {
    answer = answerSpend({ rows: await spendRows(deps), workers: (deps.config && deps.config.workers) || [] })
  } else {
    const rows = await parkRows(deps)
    answer = kind === 'fail-reason' ? answerFailReason({ text, rows }) : answerStatus({ text, rows })
  }

  const dir = deps.historyDir
  if (dir) {
    appendTurn({ dir, clock, fsImpl: deps.fsImpl, turn: { conversationId: convId, role: 'user', kind, text } })
    appendTurn({
      dir,
      clock,
      fsImpl: deps.fsImpl,
      turn: {
        conversationId: convId,
        role: 'assistant',
        kind: answer.kind,
        text: answer.text ?? '',
        taskRef: answer.taskRef,
        draft: answer.draft,
        error: answer.error,
      },
    })
  }

  return { conversationId: convId, kind, answer }
}

/** The park as the queue reports it — READ ONLY; a failure here is an empty park, not a 500. */
async function parkRows(deps) {
  try {
    return (await deps.adapter.list({})) || []
  } catch {
    return []
  }
}

/** The spend book rows — injected in tests, read through the book's own parser in production. */
async function spendRows(deps) {
  if (typeof deps.readUsageRows === 'function') return (await deps.readUsageRows()) || []
  if (!deps.dataDir) return []
  return readUsageRows({ dataDir: deps.dataDir, windowMs: deps.spendWindowMs, clock: deps.clock, fsImpl: deps.fsImpl })
}

/**
 * dispatchFreeTurn — the open-question branch (a short session outside the queue). Wired in
 * the next slice of this plan; until then the door is honest about it rather than pretending
 * to think.
 */
export async function dispatchFreeTurn() {
  return { kind: 'text', text: 'Не получилось ответить — попробуйте ещё раз.', error: 'not-wired' }
}
