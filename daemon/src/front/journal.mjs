/**
 * journal.mjs — THE DECISION JOURNAL: the read model over the three layers every attempt
 * must carry, plus the closed vocabularies those layers are written in.
 *
 * ═══════════════════════ THE LAW OF THREE LAYERS ═════════════════════════════════
 * Every attempt explains ITSELF, at the moment it happens, in three appended layers:
 *   (a) dispatcher — WHY the router chose this lane/worker/window. Written BY the router
 *       at the decision point, as a CODE from the closed DISPATCH_REASONS vocabulary —
 *       never a sentence assembled afterwards. A free-text reason cannot be filtered,
 *       aggregated or translated; a code with a human подпись can (the same device the
 *       failure taxonomy already uses).
 *   (b) approach  — the worker's note: what was chosen, what was REJECTED, what rules and
 *       notes influenced it.
 *   (c) memory    — which corpus notes were loaded and which reflexes fired: IDS ONLY,
 *       never the content of a note.
 *
 * ═══════════════════════ AN ATTEMPT WITHOUT A NOTE IS INCOMPLETE ═════════════════
 * The approach note is mandatory by exactly the law that makes a receipt mandatory: the
 * pipeline's completion gate asks `journalComplete` next to where it asks for the receipt,
 * and a missing note fails the attempt down the same path — it does not warn into a log.
 *
 * ═══════════════════════ THE NOTE IS DATA, NEVER INSTRUCTIONS ════════════════════
 * The approach note is text a MODEL wrote and another model may later read. It is stored
 * as DATA and is capped (APPROACH_NOTE_CAP). Wherever it reaches a prompt it MUST travel
 * inside the untrusted-data fence the runner already uses for task titles and notes
 * (args.mjs `fencedBlock`) — the same containment, no exception.
 *
 * ═══════════════════════ SUBSTRATE ═══════════════════════════════════════════════
 * The journal rides the EXISTING per-task attempt ledger — the same directory, the same
 * append-only JSONL discipline, one sibling file per task. No new store: the product's
 * substrate law (files and git are the truth, the daemon is not) and the derive-never-store
 * doctrine both hold. This module is IMPORT-FREE by construction: it is a leaf of pure
 * vocabulary + pure aggregation, so the ledger (queue layer) may depend on it without any
 * layer inversion, and the read model takes its ledger as an injected seam.
 *
 * NAME NOTE: `scripts/sma/lib/journal.mjs` is a DIFFERENT, unrelated artifact (the
 * multi-terminal coordination journal). Nothing imports both.
 */

/** The three layers of one attempt — a closed set. */
export const JOURNAL_LAYERS = Object.freeze(['dispatcher', 'approach', 'memory'])

/**
 * The dispatcher's closed reason vocabulary: code → RU подпись. The router writes the
 * CODE; a card renders the подпись. Every routing outcome has exactly one code.
 *   per_task_override / per_worker_override / lane_default — a worker WAS selected, and
 *     this names the precedence level that decided it;
 *   api_fallback_requested — the task itself asked for the API window;
 *   window_exhausted / day_priority_protected — nobody was selected and the task WAITS
 *     (routing never fails a task);
 *   budget_declined — reserved for the budget gate, which declines a route after routing
 *     has already named a target.
 */
export const DISPATCH_REASONS = Object.freeze({
  per_task_override: 'маршрут задан на самой задаче',
  per_worker_override: 'маршрут задан на работнике',
  lane_default: 'маршрут по умолчанию для полосы',
  api_fallback_requested: 'передано в окно API по требованию задачи',
  window_exhausted: 'отложено: нет открытого окна',
  day_priority_protected: 'отложено: активные часы основателя, его счёт защищён',
  budget_declined: 'отказано по бюджету',
})

/** The approach note cap — the note is DATA and data is bounded. */
export const APPROACH_NOTE_CAP = 4096
/** How many rejected alternatives / influences one note may carry. */
export const APPROACH_LIST_CAP = 12
/** Per-item cap inside those lists. */
export const APPROACH_ITEM_CAP = 512
/** How many ids one memory-layer entry may carry. */
export const MEMORY_ID_CAP = 64
/** Cap on a dispatcher structural field (lane / workerId / windowId / provider). */
export const STRUCT_FIELD_CAP = 200

/**
 * What an id may look like in the memory layer. Deliberately narrow: a note BODY (spaces,
 * punctuation, newlines) cannot match, so content can never ride into the journal disguised
 * as an identifier.
 */
const MEMORY_ID_RE = /^[A-Za-z0-9._/@-]{1,120}$/

/** The dispatcher layer's structural fields — an explicit-pick allowlist, no free text. */
const DISPATCH_FIELDS = Object.freeze(['lane', 'workerId', 'windowId', 'provider'])

/** The line markers a worker uses to leave its note on the session stream (soft protocol). */
export const APPROACH_MARKERS = Object.freeze({
  approach: 'APPROACH_NOTE:',
  rejected: 'APPROACH_REJECTED:',
  influences: 'APPROACH_INFLUENCES:',
})

/** Named error for any refused journal entry (the caller maps it; nothing is written). */
export class InvalidJournalEntryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidJournalEntryError'
  }
}

/** The stable identity of one attempt: `<taskId>#<attempt>`. */
export function attemptIdFor(taskId, attempt) {
  const n = Number.isFinite(Number(attempt)) ? Number(attempt) : 1
  return `${String(taskId)}#${n}`
}

/** Coerce to a bounded single-line string (no newline ever splits a JSONL row). */
function boundedText(value, cap) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ').trim()
  return s.length > cap ? s.slice(0, cap) : s
}

/** Bounded list of bounded items. */
function boundedList(value, itemCap, listCap) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const v of value) {
    const t = boundedText(v, itemCap)
    if (t) out.push(t)
    if (out.length >= listCap) break
  }
  return out
}

/**
 * normalizeJournalPayload(layer, payload) → the payload as it will be stored.
 * PURE. Throws InvalidJournalEntryError on an unknown layer, an out-of-vocabulary
 * dispatcher code or an empty approach note. Unknown keys are DROPPED (explicit-pick,
 * the ledger's posture) so a stray field can never reach the durable record.
 */
export function normalizeJournalPayload(layer, payload = {}) {
  if (!JOURNAL_LAYERS.includes(layer)) {
    throw new InvalidJournalEntryError(`unknown journal layer "${layer}" — one of ${JOURNAL_LAYERS.join('|')}`)
  }
  const p = payload && typeof payload === 'object' ? payload : {}

  if (layer === 'dispatcher') {
    const code = String(p.code ?? '')
    if (!Object.prototype.hasOwnProperty.call(DISPATCH_REASONS, code)) {
      throw new InvalidJournalEntryError(
        `dispatcher code "${code}" is not one of ${Object.keys(DISPATCH_REASONS).join('|')} — the dispatcher never writes free text`,
      )
    }
    const out = { code }
    for (const f of DISPATCH_FIELDS) {
      if (p[f] !== undefined && p[f] !== null) {
        const t = boundedText(p[f], STRUCT_FIELD_CAP)
        if (t) out[f] = t
      }
    }
    return out
  }

  if (layer === 'approach') {
    const raw = String(p.approach ?? '')
    const trimmed = raw.replace(/\r?\n/g, ' ').trim()
    if (!trimmed) throw new InvalidJournalEntryError('approach note is empty — an attempt without a note is not complete')
    const approach = trimmed.length > APPROACH_NOTE_CAP ? trimmed.slice(0, APPROACH_NOTE_CAP) : trimmed
    const out = { approach }
    if (approach.length < trimmed.length) out.truncated = true
    const rejected = boundedList(p.rejected, APPROACH_ITEM_CAP, APPROACH_LIST_CAP)
    const influences = boundedList(p.influences, APPROACH_ITEM_CAP, APPROACH_LIST_CAP)
    if (rejected.length) out.rejected = rejected
    if (influences.length) out.influences = influences
    return out
  }

  // memory — IDS ONLY. Anything that does not read as an identifier is dropped, so a note
  // body can never travel in the journal.
  const ids = (value) => {
    if (!Array.isArray(value)) return []
    const out = []
    for (const v of value) {
      const t = String(v ?? '').trim()
      if (MEMORY_ID_RE.test(t)) out.push(t)
      if (out.length >= MEMORY_ID_CAP) break
    }
    return out
  }
  return { notes: ids(p.notes), reflexes: ids(p.reflexes) }
}

/** Read the raw entries out of whatever ledger seam the caller injected (fail-open). */
function entriesFrom({ taskId, ledger, entries }) {
  if (Array.isArray(entries)) return entries
  if (ledger && typeof ledger.readJournalEntries === 'function') {
    try {
      const rows = ledger.readJournalEntries(taskId)
      return Array.isArray(rows) ? rows : []
    } catch {
      return [] // a missing/unreadable journal is an EMPTY journal, never an error
    }
  }
  return []
}

/** Stable chronological order: recordedAt, then the order the rows were appended in. */
function chronological(rows) {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.row && a.row.recordedAt) || 0
      const tb = Date.parse(b.row && b.row.recordedAt) || 0
      return ta === tb ? a.i - b.i : ta - tb
    })
    .map((x) => x.row)
}

/**
 * readJournal({taskId, ledger, entries}) → the whole decision journal of ONE task:
 * every entry in time order plus the same entries grouped per attempt into the three
 * layers. A task with no journal (anything created before this revision) yields an EMPTY
 * result — never an exception (backward compatibility is a hard requirement).
 *
 * @param {{taskId:string, ledger?:{readJournalEntries?:Function}, entries?:object[]}} args
 * @returns {{taskId:string, entries:object[], attempts:Array<{attemptId:string, attempt:number, dispatcher:object[], approach:object[], memory:object[]}>}}
 */
export function readJournal({ taskId, ledger, entries } = {}) {
  const rows = chronological(entriesFrom({ taskId, ledger, entries }).filter((r) => r && typeof r === 'object'))
  const attempts = []
  for (const row of rows) {
    const attempt = Number.isFinite(Number(row.attempt)) ? Number(row.attempt) : 1
    const attemptId = row.attemptId || attemptIdFor(row.taskId ?? taskId, attempt)
    let bucket = attempts.find((a) => a.attemptId === attemptId)
    if (!bucket) {
      bucket = { attemptId, attempt, dispatcher: [], approach: [], memory: [] }
      attempts.push(bucket)
    }
    if (JOURNAL_LAYERS.includes(row.layer)) bucket[row.layer].push(row)
  }
  attempts.sort((a, b) => a.attempt - b.attempt)
  return { taskId: String(taskId ?? ''), entries: rows, attempts }
}

/**
 * journalComplete({attemptId | taskId+attempt, ledger, entries}) → does THIS attempt carry
 * an approach note? This is the predicate the completion gate asks next to the receipt
 * check. Missing journal → false (never an exception).
 *
 * @param {{attemptId?:string, taskId?:string, attempt?:number, ledger?:object, entries?:object[]}} args
 * @returns {boolean}
 */
export function journalComplete({ attemptId, taskId, attempt, ledger, entries } = {}) {
  const wanted = attemptId || attemptIdFor(taskId, attempt)
  const rows = entriesFrom({ taskId, ledger, entries })
  for (const row of rows) {
    if (!row || row.layer !== 'approach') continue
    const rowId = row.attemptId || attemptIdFor(row.taskId ?? taskId, row.attempt)
    if (rowId === wanted && row.payload && String(row.payload.approach ?? '').trim()) return true
  }
  return false
}

/**
 * parseApproachNote(lines) → {approach, rejected[], influences[]} | null.
 * Reads the worker's note off the session stream lines it already collects — the SAME soft
 * marker protocol shape the failure markers use. PURE, zero-dep, never throws. The text it
 * returns is DATA: the caller stores it, and any later prompt must fence it.
 *
 * @param {string[]} lines
 * @returns {{approach:string, rejected:string[], influences:string[]}|null}
 */
export function parseApproachNote(lines) {
  if (!Array.isArray(lines)) return null
  let approach = ''
  const rejected = []
  const influences = []
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw.trim() : ''
    if (!line) continue
    if (line.startsWith(APPROACH_MARKERS.approach)) {
      const v = line.slice(APPROACH_MARKERS.approach.length).trim()
      if (v && !approach) approach = v
    } else if (line.startsWith(APPROACH_MARKERS.rejected)) {
      const v = line.slice(APPROACH_MARKERS.rejected.length).trim()
      if (v) rejected.push(v)
    } else if (line.startsWith(APPROACH_MARKERS.influences)) {
      const v = line.slice(APPROACH_MARKERS.influences.length).trim()
      if (v) influences.push(v)
    }
  }
  if (!approach) return null
  return { approach, rejected, influences }
}
