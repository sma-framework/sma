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
 *   api_fallback — nobody asked, but no seat existed anywhere and the money rule permitted
 *     the spend: the work CONTINUES, on the paid channel. A different fact from
 *     api_fallback_requested (nobody asked) and not a refusal at all, so it can be folded
 *     into neither — it is its own word;
 *   window_exhausted / day_priority_protected — nobody was selected and the task WAITS
 *     (routing never fails a task);
 *   worker_busy — nobody was selected because every eligible seat already has a LIVE
 *     attempt on it. The router has been naming this outcome since the busy filter landed;
 *     the vocabulary did not carry the word, so the sink dropped it and the card said «the
 *     route was never decided» about a route that had been. Kept apart from
 *     window_exhausted for the same reason the two money words are kept apart: a pool
 *     emptied by work in flight clears by itself, and telling its owner to wait for a
 *     window sends him to an account with nothing wrong with it;
 *   wait_for_window — the money rule refused to spend while a subscription seat may still
 *     free up shortly: the task waits and the paid channel was never touched;
 *   budget_stop — the month's paid-channel ceiling is spent. Kept apart from
 *     wait_for_window because the two ask a person for OPPOSITE things: wait, or raise the
 *     cap. Collapsing them would destroy exactly the information this vocabulary exists for;
 *   api_cap_unset — no ceiling was ever configured, so the paid channel is not set up at
 *     all. The honest third word: neither «the money ran out» nor «wait a moment»;
 *   budget_declined — nobody writes this code today. It stays in the set as the NAME for a
 *     refusal issued after routing has already named a target, should such a refusal appear.
 */
export const DISPATCH_REASONS = Object.freeze({
  per_task_override: 'маршрут задан на самой задаче',
  per_worker_override: 'маршрут задан на работнике',
  lane_default: 'маршрут по умолчанию для полосы',
  api_fallback_requested: 'передано в окно API по требованию задачи',
  api_fallback: 'окон нет — передано в платное окно API (в пределах лимита)',
  window_exhausted: 'отложено: нет открытого окна',
  day_priority_protected: 'отложено: активные часы основателя, его счёт защищён',
  worker_busy: 'отложено: все подходящие работники заняты живыми попытками',
  wait_for_window: 'отложено: ждёт окна подписки — платный канал не задействован',
  budget_stop: 'остановлено: месячный лимит платного канала выбран',
  api_cap_unset: 'отложено: платный канал не настроен — ждёт окна подписки',
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
 * ═══════════ THE LIVE ATTEMPT LOG — what the worker is saying WHILE it says it ═══════
 * The three layers above explain an attempt AFTER it decided something. The live log is the
 * other half: every line of the worker's stdout, appended as it arrives, so the screen can
 * show a running attempt instead of a spinner. It is the same law in a different tense.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT — the same split the decision journal already made:
 * this module owns the RECORD (its shape, its caps, how a tail is selected) and stays a
 * leaf; `queue/attempt-ledger.mjs` owns the FILE, because the ledger dir and the
 * `<id>` → filename rule live there and a second copy of that rule is how two answers start.
 *
 * THE LINE IS DATA, EXACTLY AS THE NOTE IS. It is text a worker printed and a screen will
 * render. It is capped, flattened to one line (an NDJSON row is one line by definition) and
 * stored verbatim otherwise — this module does NOT interpret it, does NOT strip markup and
 * does NOT decide it is safe. Whatever renders it renders it as TEXT, never as markup.
 */

/** One line of worker output, capped — the same posture as the approach note. */
export const ATTEMPT_LOG_LINE_CAP = 4096
/**
 * TWO FRAMES ARE NOT «A LINE OF OUTPUT», AND THEY HAVE THEIR OWN CEILING.
 *
 * `init` says what the session was armed with — how many tools, which CONNECTIONS, which
 * model — and `result` says how it ended. They are the two frames a person opens a transcript
 * FOR, and they are read whole or not at all. Under the 4096 of an ordinary line both were
 * being cut: in a measurement of three hundred rows, fourteen were clipped and these two were
 * among them. The cure is not a bigger cap for everything — an ordinary line nobody will
 * finish reading is not worth an unbounded journal — but a SECOND, still FINITE ceiling for a
 * closed vocabulary of two.
 */
export const ATTEMPT_LOG_FRAME_CAP = 65536
/**
 * The closed vocabulary of frames read whole. Closed on purpose: a row can only claim the
 * larger ceiling by naming one of these two, so no future frame silently inherits it.
 */
export const ATTEMPT_LOG_WHOLE_FRAMES = Object.freeze(['init', 'result'])
/** How many parts of ONE frame a row may carry: a glance is a glance, not a transcript. */
export const ATTEMPT_LOG_SUMMARY_CAP = 8
/** How many entries a tail read returns when the caller names no number. */
export const ATTEMPT_LOG_TAIL_DEFAULT = 200
/** The hard ceiling on one tail read — a growing log can never become a growing response. */
export const ATTEMPT_LOG_TAIL_MAX = 1000

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

/**
 * The line markers that close an attempt's THIRD condition: what it taught.
 *
 * A finished attempt owes three things — a receipt (the work holds), an approach note (why it
 * was done that way) and a lesson (what the next attempt should know). The first two had words
 * in the prompt and a parser here; the third had neither, and the memory corpus kept a flat
 * zero of worker lessons while the product promised a flywheel turning in both directions.
 *
 * Either the worker names the draft its `memory write` produced, or it says in one line why
 * this task taught nothing worth keeping. «Nothing» is a legitimate answer — «nothing, and no
 * reason» is not, which is why the reason travels with the marker instead of beside it.
 */
export const LESSON_MARKERS = Object.freeze({
  written: 'LESSON_WRITTEN:',
  none: 'LESSON_NONE:',
})

/**
 * How long a stated «no lesson» reason may be. Short on purpose: this is one sentence for a
 * person to read on a card, not a place to paste a session. The text is DATA — stored capped,
 * fenced wherever a later prompt shows it.
 */
export const LESSON_REASON_CAP = 512

/**
 * How long ANY sentence the memory layer carries may be — the stated «no lesson» reason and
 * the path of a written one. The same number as the marker's own cap and for the same reason:
 * this layer stores what was READ and WHY, never what was read.
 */
export const MEMORY_REASON_CAP = 512

/** Where the reflexes of an attempt were read from — a closed set, never free text. */
export const MEMORY_REFLEX_SOURCES = Object.freeze(['sma-journal', 'none'])

/** Whether the attempt left an approach note in this journal — a closed set. */
export const MEMORY_APPROACH_MARKS = Object.freeze(['journaled', 'absent'])

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
  return clipText(value, cap).text
}

/**
 * clipText(value, cap) → `{text, originalLength, clipped}` — the same flattening and the same
 * cut as before, plus the one fact the cut used to swallow: HOW LONG THE TEXT WAS.
 *
 * A SILENT TRUNCATION IS A LIE OF OMISSION. A reader shown a clipped line has no way to tell
 * it from a line that simply ended there, so they read a part believing they read the whole.
 * The length is measured AFTER the newlines are flattened and the ends trimmed — that is the
 * text the cap is applied to, and reporting the length of anything else would be a second
 * number that does not describe the first.
 */
function clipText(value, cap) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ').trim()
  if (s.length <= cap) return { text: s, originalLength: s.length, clipped: false }
  return { text: s.slice(0, cap), originalLength: s.length, clipped: true }
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
  const out = { notes: ids(p.notes), reflexes: ids(p.reflexes) }

  // ── WHAT THE ATTEMPT REALLY TOUCHED, and why the layer grew these fields ──
  // The layer used to be written only for a worker that had a role file, and it carried the
  // NAME OF THAT ROLE — a declaration made before the session started, not an observation of
  // it. Every field below is read off the attempt's own trace instead: which corpus files the
  // session opened, how many times it asked the memory pipeline for notes, which reflexes
  // fired under its session identity, what it left behind as a lesson. Still IDS AND MARKS
  // ONLY: the widened shape carries no note body, only names, counts and closed vocabularies.
  //
  // EVERY NEW KEY IS OPTIONAL BY CONSTRUCTION. A payload of the old shape returns the old two
  // fields and nothing else, so rows written before this revision and rows written after it
  // read identically to the card that renders them.
  if (p.loaded && typeof p.loaded === 'object' && !Array.isArray(p.loaded)) {
    const n = Number(p.loaded.loadCalls)
    out.loaded = {
      // The index is the corpus's front door: opening it is a different act from opening one
      // note, and a card says so in different words.
      index: p.loaded.index === true,
      reads: ids(p.loaded.reads),
      loadCalls: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    }
  }
  if (MEMORY_REFLEX_SOURCES.includes(p.reflexSource)) out.reflexSource = p.reflexSource
  // The account's OWN memory, kept apart from the project's on purpose: those files belong to
  // the machine the worker ran on, not to the corpus a person reviews, and merging the two
  // lists would let «the session read something» pass for «the project's memory was used».
  if (Array.isArray(p.autoMemoryReads)) out.autoMemoryReads = ids(p.autoMemoryReads)
  const lesson = p.lesson && typeof p.lesson === 'object' && !Array.isArray(p.lesson) ? p.lesson : null
  if (lesson) {
    const written = boundedText(lesson.written, MEMORY_REASON_CAP)
    const none = boundedText(lesson.none, MEMORY_REASON_CAP)
    // Exactly one of the three, in the order of what it claims: a draft, a stated «nothing to
    // teach», or the absence of both — which is the answer that failed the attempt.
    if (written) out.lesson = { written }
    else if (none) out.lesson = { none }
    else if (lesson.missing === true) out.lesson = { missing: true }
  }
  if (MEMORY_APPROACH_MARKS.includes(p.approach)) out.approach = p.approach
  return out
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
 * normalizeAttemptLogEntry(entry, {now}) → the row as it will be stored:
 * `{ts, line, truncated?, originalLength?, subagent?, parentId?}`. PURE, never throws — a live
 * log that could refuse a line would be a live log that can stop the work it is describing.
 *
 * `frame` on the ENTRY (never stored) names the parsed frame this line was: one of
 * ATTEMPT_LOG_WHOLE_FRAMES gets the frame ceiling, everything else the line ceiling.
 * `truncated`/`originalLength` are written when — and only when — the text really was cut, on
 * EITHER ceiling. Truncation used to be silent, which made a clipped line indistinguishable
 * from a line that ended there.
 *
 * `subagent` and `parentId` are written ONLY when the line really came from a delegated
 * session (stream.mjs reads that off `parent_tool_use_id`), so an ordinary row stays two
 * fields wide and a reader never has to tell `false` from «this build did not know».
 *
 * `frame` is a ROUTING HINT, not a field of the record: `'init'` or `'result'` selects the
 * frame cap for this row and is then dropped, so a reader of the transcript never has to know
 * the marker existed and an older row stays exactly as wide as it was. An unknown marker is no
 * marker — the cap only widens for the two kinds that are evidence.
 *
 * `summary` is the SENTENCE A PERSON READS, built by the runner off the parsed frame before
 * the line was capped (runner/frame-summary.mjs). It is bounded here like everything else
 * that arrives from a worker: a closed number of parts, each field capped, every value
 * flattened to text. It is written only when there is something to say — a frame that means
 * nothing to a reader leaves the row exactly as wide as it was, and the screen falls back to
 * the raw line.
 *
 * @param {{line?:string, ts?:string, frame?:string, subagent?:boolean, parentId?:string, summary?:object[]}} entry
 * @param {{now?:()=>number}} [opts]
 * @returns {{ts:string, line:string, truncated?:true, originalLength?:number, subagent?:true, parentId?:string, summary?:object[]}}
 */
export function normalizeAttemptLogEntry(entry = {}, { now } = {}) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const clock = typeof now === 'function' ? now : Date.now
  const ts = typeof e.ts === 'string' && e.ts ? e.ts : new Date(clock()).toISOString()
  // WHICH CEILING THIS ROW GETS is decided by ONE fact — `frame`, put on the entry by the
  // point that parsed the frame and therefore actually knows. Anything not in the closed
  // vocabulary is an ordinary line and keeps the ordinary cap.
  const whole = typeof e.frame === 'string' && ATTEMPT_LOG_WHOLE_FRAMES.includes(e.frame)
  const clip = clipText(e.line, whole ? ATTEMPT_LOG_FRAME_CAP : ATTEMPT_LOG_LINE_CAP)
  const out = { ts, line: clip.text }
  // The mark rides ONLY on a row that was really cut: a row that fits stays exactly as wide as
  // it was, and a reader never has to tell «not clipped» from «this build did not know».
  if (clip.clipped) {
    out.truncated = true
    out.originalLength = clip.originalLength
  }
  if (e.subagent === true) {
    out.subagent = true
    const parentId = boundedText(e.parentId, STRUCT_FIELD_CAP)
    if (parentId) out.parentId = parentId
  }
  const summary = boundedSummary(e.summary)
  if (summary.length) out.summary = summary
  return out
}

/** The parts of a row's summary, bounded: at most ATTEMPT_LOG_SUMMARY_CAP, each field text. */
function boundedSummary(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const part of value) {
    if (out.length >= ATTEMPT_LOG_SUMMARY_CAP) break
    if (!part || typeof part !== 'object') continue
    const kind = boundedText(part.kind, STRUCT_FIELD_CAP)
    if (!kind) continue
    const row = { kind }
    const tool = boundedText(part.tool, STRUCT_FIELD_CAP)
    if (tool) row.tool = tool
    const detail = boundedText(part.detail, STRUCT_FIELD_CAP)
    if (detail) row.detail = detail
    const subagent = boundedText(part.subagent, STRUCT_FIELD_CAP)
    if (subagent) row.subagent = subagent
    if (typeof part.ok === 'boolean') row.ok = part.ok
    out.push(row)
  }
  return out
}

/**
 * attemptLogTail(rows, tail) → `{entries, total, truncated}` — the LAST `tail` rows, with
 * `truncated` saying out loud that older lines exist. `tail` is clamped into
 * [1, ATTEMPT_LOG_TAIL_MAX]; anything unreadable falls back to the default. PURE.
 *
 * @param {object[]} rows
 * @param {number} [tail]
 * @returns {{entries:object[], total:number, truncated:boolean}}
 */
export function attemptLogTail(rows, tail) {
  const all = Array.isArray(rows) ? rows : []
  const asked = Number(tail)
  const n = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), ATTEMPT_LOG_TAIL_MAX) : ATTEMPT_LOG_TAIL_DEFAULT
  const entries = all.length > n ? all.slice(all.length - n) : all
  return { entries, total: all.length, truncated: entries.length < all.length }
}

// ══════════════════ WHAT THE WHOLE ATTEMPT ADDED UP TO ══════════════════════════════
//
// A transcript answers «what happened next». It does not answer the four questions a person
// actually arrives with — WHICH TOOLS did it use, WHICH FILES did it touch, did it reach any
// of my CONNECTIONS or turn on a SKILL, and what did the session COST — because those answers
// are spread over three hundred rows and nobody reads three hundred rows to count them.
//
// So they are counted once, over the WHOLE log rather than over the tail that fits on screen,
// and shown as one block under it. Every figure is derived from the per-row summaries the
// runner already built: this adds no second reading of a frame and invents nothing. A row the
// runner could not read contributes nothing rather than a guess — which is why the block says
// «шагов: N» (the rows that carried a summary) and never claims to be a census of the stream.
//
// IT IS AGGREGATION, NOT INTERPRETATION. Names of tools, files, skills and connections travel
// out of here exactly as they were stored — bounded text, no markup, rendered as text nodes —
// and the money figure is passed through as the vendor's own sentence rather than re-derived
// into a claim about which channel paid for it. What the counter says and what it means are
// two different facts, and this layer owns only the first.

/** How many names of one kind (files, tools) the block carries before it says «and N more». */
export const ATTEMPT_DIGEST_LIST_CAP = 12

/** Which tools touch a file, and which of the two lists that file belongs in. */
const FILE_TOOLS = Object.freeze({
  Read: 'read',
  NotebookRead: 'read',
  Write: 'changed',
  Edit: 'changed',
  MultiEdit: 'changed',
  NotebookEdit: 'changed',
})

/** Which tools run something on the machine — counted apart, because that is the risky kind. */
const COMMAND_TOOLS = Object.freeze(['Bash', 'PowerShell'])

/** How a connection's tools are named on the wire: `mcp__<server>__<operation>`. */
const MCP_TOOL_PREFIX = 'mcp__'

/**
 * attemptDigest(rows) → the roll-up of one attempt, or null when there is nothing to roll up.
 * PURE, never throws, reads the stored per-row summaries and nothing else.
 *
 * WHY IT ALSO READS THE OLDER SHAPE. Rows written before the runner learned to tell a
 * connection from an ordinary tool carry `kind:'tool'` with the wire name `mcp__server__op`,
 * and a skill as `kind:'tool'` named `Skill`. Both are recognised here too, so the block is
 * right about the transcripts that already exist and not only about the ones written from now
 * on — a roll-up that was wrong about last week's attempt would be worse than no roll-up.
 *
 * @param {object[]} rows stored attempt-log rows (`{ts, line, summary?}`)
 * @returns {{steps:number, calls:number, tools:Array<{name:string,count:number}>, toolsMore:number,
 *   filesRead:string[], filesReadMore:number, filesChanged:string[], filesChangedMore:number,
 *   commands:number, skills:string[], connections:string[], agents:string[], handoffs:number,
 *   failures:number, denied:number, session:(string|null), apiKey:(string|null),
 *   subscriptionWindow:boolean}|null}
 */
export function attemptDigest(rows) {
  const all = Array.isArray(rows) ? rows : []
  const toolCount = new Map()
  const filesRead = new Set()
  const filesChanged = new Set()
  const skills = new Set()
  const connections = new Set()
  const agents = new Set()
  let steps = 0
  let calls = 0
  let commands = 0
  let handoffs = 0
  let failures = 0
  let denied = 0
  let session = null
  let apiKey = null
  let subscriptionWindow = false

  for (const row of all) {
    const parts = row && Array.isArray(row.summary) ? row.summary : []
    if (parts.length) steps += 1
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const kind = boundedText(part.kind, STRUCT_FIELD_CAP)
      const tool = boundedText(part.tool, STRUCT_FIELD_CAP)
      const detail = boundedText(part.detail, STRUCT_FIELD_CAP)

      if (kind === 'tool_result') {
        if (part.ok === false) failures += 1
        continue
      }
      if (kind === 'denied') {
        denied += 1
        continue
      }
      if (kind === 'limit') {
        subscriptionWindow = true
        continue
      }
      if (kind === 'result') {
        if (detail) session = detail
        continue
      }
      if (kind === 'apikey') {
        if (detail) apiKey = detail
        continue
      }
      if (kind === 'handoff') {
        calls += 1
        handoffs += 1
        const who = boundedText(part.subagent, STRUCT_FIELD_CAP)
        if (who) agents.add(who)
        continue
      }
      if (kind === 'mcp') {
        calls += 1
        if (tool) connections.add(tool)
        continue
      }
      if (kind === 'skill') {
        calls += 1
        if (tool) skills.add(tool)
        continue
      }
      if (kind !== 'tool' || !tool) continue

      calls += 1
      // The two older shapes, read as what they are — see the note above.
      if (tool.startsWith(MCP_TOOL_PREFIX)) {
        const rest = tool.slice(MCP_TOOL_PREFIX.length)
        const cut = rest.indexOf('__')
        const server = cut === -1 ? rest : rest.slice(0, cut)
        if (server) connections.add(server)
        continue
      }
      if (tool === 'Skill') {
        if (detail) skills.add(detail)
        continue
      }
      toolCount.set(tool, (toolCount.get(tool) || 0) + 1)
      if (COMMAND_TOOLS.includes(tool)) commands += 1
      const bucket = Object.prototype.hasOwnProperty.call(FILE_TOOLS, tool) ? FILE_TOOLS[tool] : ''
      if (bucket && detail) (bucket === 'read' ? filesRead : filesChanged).add(detail)
    }
  }

  if (steps === 0) return null

  const tools = [...toolCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const capped = (set) => [...set].slice(0, ATTEMPT_DIGEST_LIST_CAP)
  const overflow = (set) => Math.max(0, set.size - ATTEMPT_DIGEST_LIST_CAP)

  return {
    steps,
    calls,
    tools: tools.slice(0, ATTEMPT_DIGEST_LIST_CAP),
    toolsMore: Math.max(0, tools.length - ATTEMPT_DIGEST_LIST_CAP),
    filesRead: capped(filesRead),
    filesReadMore: overflow(filesRead),
    filesChanged: capped(filesChanged),
    filesChangedMore: overflow(filesChanged),
    commands,
    skills: capped(skills),
    connections: capped(connections),
    agents: capped(agents),
    handoffs,
    failures,
    denied,
    session,
    apiKey,
    subscriptionWindow,
  }
}

// ══════════════════ WHO WAS IN THE SESSION, AND WHAT EACH ONE DID ═══════════════════════
//
// An attempt is not one voice. The executor works, and it hands pieces of the work to
// subagents — and the transcript already knows which lines belong to which of them: the runner
// marks a delegated line with the vendor's parent id, and the frame parse names the subagent at
// the moment the executor starts it. Both facts were being computed and thrown away: the log
// showed a flat stream of lines, and the card had nothing to draw the tree the design asks for.
//
// THIS COUNTS, IT DOES NOT PARSE. Every field below is read off the per-row summaries the
// runner already built — no second reading of a frame, no new parser, and frame-summary.mjs is
// not touched. What is not in those summaries is `null` here: a subagent whose lines carry no
// readable timestamp has NO duration rather than a zero, and a delegation nobody named has NO
// name rather than «подагент 2».
//
// WHY THE NAMES ARE MATCHED BY ORDER, said out loud because it is the one soft spot. The
// executor's handoff names its subagent; the delegated lines carry an opaque parent id; and the
// tool-call id that would tie the two together is NOT kept by the frame parse. So the k-th
// delegation to speak is given the k-th name the executor handed out. When the two counts
// disagree the surplus is reported honestly instead of paired up: a group with no name left
// over gets `name: null`, and a name whose lines never arrived gets a row of its own with no
// duration and no steps — it was started, and that is the whole of what is known about it.

/** How many voices one attempt will name before it says «and N more». */
export const ATTEMPT_ROLES_CAP = 12

/** The key the executor's own lines group under — a delegated line has a parent id instead. */
const EXECUTOR_KEY = ''

/** Which model the session announced, read back out of the sentence the frame parse composed. */
const MODEL_IN_SESSION = /модель:\s*([^·]+)/

/** The kinds that say what somebody was DOING. A counter frame is not a deed. */
const DEED_KINDS = Object.freeze(['tool', 'mcp', 'skill', 'handoff', 'text', 'denied'])

/** Two readable marks make a length; one mark makes none. */
function spanMs(first, last) {
  const a = Date.parse(first)
  const b = Date.parse(last)
  if (!Number.isFinite(a) || !Number.isFinite(b) || first === last) return null
  const ms = b - a
  return ms >= 0 ? ms : null
}

/**
 * attemptRoles(rows) → `{list, more}` — who was in this attempt, the executor first, then each
 * delegation in the order it first spoke. PURE, never throws, reads the stored per-row
 * summaries and the stored delegation marks and nothing else.
 *
 * Each entry: `{role:'executor'|'subagent', name, model, steps, durationMs, detail}`. `name` is
 * null on the executor — this reader knows the attempt's lines, not which worker holds the task;
 * the roster and the task door are where a worker has a name.
 *
 * NO ORDINAL TRAVELS FROM HERE, deliberately. The log door numbers delegations over the WINDOW
 * it is sending, while these are counted over the WHOLE log — so a number issued here would
 * disagree with the number beside the lines on screen exactly when the tail was cut, which is
 * the case a person is most likely to be looking at.
 *
 * @param {object[]} rows stored attempt-log rows (`{ts, line, subagent?, parentId?, summary?}`)
 * @returns {{list:Array<object>, more:number}}
 */
export function attemptRoles(rows) {
  const all = Array.isArray(rows) ? rows : []
  const groups = new Map() // key → {firstTs, lastTs, steps, model, detail}
  const handoffNames = []

  for (const row of all) {
    if (!row || typeof row !== 'object') continue
    const delegated = row.subagent === true
    const parentId = boundedText(row.parentId, STRUCT_FIELD_CAP)
    const key = delegated && parentId ? parentId : EXECUTOR_KEY
    const ts = typeof row.ts === 'string' ? row.ts : ''
    let g = groups.get(key)
    if (!g) {
      g = { firstTs: ts, lastTs: ts, steps: 0, model: null, detail: null }
      groups.set(key, g)
    }
    if (ts) {
      if (!g.firstTs) g.firstTs = ts
      g.lastTs = ts
    }

    const parts = Array.isArray(row.summary) ? row.summary : []
    if (parts.length) g.steps += 1
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const kind = boundedText(part.kind, STRUCT_FIELD_CAP)
      const tool = boundedText(part.tool, STRUCT_FIELD_CAP)
      const detail = boundedText(part.detail, STRUCT_FIELD_CAP)
      if (kind === 'session') {
        const m = MODEL_IN_SESSION.exec(detail)
        if (m && m[1].trim()) g.model = m[1].trim()
        continue
      }
      // WHOM the executor started, and with what brief. Collected off the PARENT's row,
      // because that is where the handoff is spoken.
      if (kind === 'handoff' && key === EXECUTOR_KEY) {
        const who = boundedText(part.subagent, STRUCT_FIELD_CAP)
        handoffNames.push({ name: who || null, detail: detail || null })
      }
      if (!DEED_KINDS.includes(kind)) continue
      const said = [tool, detail].filter(Boolean).join(' · ')
      if (said) g.detail = boundedText(said, STRUCT_FIELD_CAP)
    }
  }

  const entryOf = (role, g, name) => ({
    role,
    name: name ?? null,
    model: g.model,
    steps: g.steps,
    durationMs: spanMs(g.firstTs, g.lastTs),
    detail: g.detail,
  })

  const list = []
  const executor = groups.get(EXECUTOR_KEY)
  // THE EXECUTOR IS FIRST AND IS NAMED EVEN WHEN IT SAID NOTHING ITSELF: an attempt whose only
  // stored lines came from a delegation still ran inside an executor's session, and a tree whose
  // root was missing would read as though the subagents had started themselves.
  if (executor || groups.size) {
    list.push(entryOf('executor', executor ?? { firstTs: '', lastTs: '', steps: 0, model: null, detail: null }, null))
  }

  let taken = 0
  for (const [key, g] of groups) {
    if (key === EXECUTOR_KEY) continue
    const named = handoffNames[taken]
    taken += 1
    list.push(entryOf('subagent', g, named ? named.name : null))
  }
  // A brief that was handed out and whose lines never arrived — started, and nothing more known.
  for (const left of handoffNames.slice(taken)) {
    list.push({ role: 'subagent', name: left.name, model: null, steps: 0, durationMs: null, detail: left.detail })
  }

  return { list: list.slice(0, ATTEMPT_ROLES_CAP), more: Math.max(0, list.length - ATTEMPT_ROLES_CAP) }
}

/**
 * markerLinesFrom(streamLines, prefixes) → the lines ANY marker parser can actually read.
 *
 * THE STREAM IS NOT TEXT. Every line a CLI emits is a JSON frame, and the worker's words live
 * INSIDE it (`message.content[].text`, or `result` on the final frame). `parseApproachNote`
 * below matches on `line.startsWith(MARKER)`, so a marker sitting inside a frame is never at
 * the start of a line and the note is never found — no matter how faithfully the worker
 * printed it. Measured 12.08.2026: three attempts in a row printed the markers, all three
 * were failed as «attempt never explained», and the gate's own log showed a green receipt
 * beside each one.
 *
 * It lives HERE, beside the parser, for the reason it was written at all: the unwrapping and
 * the parsing are one act, and the two callers that must not disagree are the tick (which
 * gates the attempt on the note) and the read model (which shows it on the card). It was
 * private to the tick for half a day, and in that half-day the card kept reading raw frames
 * and kept showing an empty panel beside an attempt whose note the tick had already accepted.
 * One function, one place.
 *
 * Raw lines are kept as well: a plain-text stream (tests, other runners) must keep working
 * exactly as before. This only ADDS the unwrapped text.
 *
 * WHY IT TAKES THE PREFIXES. It used to unwrap frames containing `APPROACH_` and nothing else.
 * The lesson markers arrive by the very same road — inside a frame, at the end of the run — so
 * a second family reading raw lines would have found NOTHING, every time, and every attempt
 * that dutifully wrote its lesson would have been failed for not writing one. One unwrapping
 * for every marker protocol; the cheap guard stays, it just asks about the caller's prefixes.
 *
 * @param {string[]} streamLines
 * @param {string[]} [prefixes] — marker families to unwrap for (default: the approach note's)
 * @returns {string[]}
 */
export function markerLinesFrom(streamLines, prefixes = ['APPROACH_']) {
  const out = []
  if (!Array.isArray(streamLines)) return out
  const wanted = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter((p) => typeof p === 'string' && p)
  for (const raw of streamLines) {
    if (typeof raw !== 'string') continue
    out.push(raw)
    if (!wanted.some((p) => raw.includes(p))) continue // cheap guard: only unwrap frames that can matter
    try {
      const frame = JSON.parse(raw)
      const content = frame && frame.message && frame.message.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part.text === 'string') out.push(...part.text.split(/\r?\n/))
        }
      }
      if (typeof (frame && frame.result) === 'string') out.push(...frame.result.split(/\r?\n/))
    } catch {
      /* not a frame — the raw line above is all there is, and it was already pushed */
    }
  }
  return out
}

/**
 * approachLinesFrom(streamLines) — the note's own unwrapping, kept by name.
 * Every caller that only cares about the approach note keeps reading exactly what it read
 * before; the generalization above changed the machinery, never this contract.
 *
 * @param {string[]} streamLines
 * @returns {string[]}
 */
export function approachLinesFrom(streamLines) {
  return markerLinesFrom(streamLines, ['APPROACH_'])
}

/**
 * parseLessonMarker(lines) → {written:path} | {none:reason} | null.
 *
 * The worker-side half of the third condition. PURE, zero-dep, never throws — it reads the same
 * soft marker protocol the approach note reads, off the same unwrapped lines.
 *
 * THE LAST MARKER WINS. A worker that wrote a draft and then reconsidered (or whose pipeline
 * refused after it had already announced a path) says so at the end of the run, and the end of
 * the run is what happened. Nothing here judges the answer: the path is checked against the
 * disk by the gate, and the reason is checked by a person on the card.
 *
 * What it refuses: an empty path, an empty reason. «No lesson» must carry its reason — a bare
 * marker is not an answer, and treating it as one would turn the whole condition into a word a
 * worker types to get past the gate.
 *
 * @param {string[]} lines
 * @returns {{written:string}|{none:string}|null}
 */
export function parseLessonMarker(lines) {
  if (!Array.isArray(lines)) return null
  let last = null
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw.trim() : ''
    if (!line) continue
    if (line.startsWith(LESSON_MARKERS.written)) {
      const v = unwrapMarkerValue(line.slice(LESSON_MARKERS.written.length))
      if (v) last = { written: v }
    } else if (line.startsWith(LESSON_MARKERS.none)) {
      const v = unwrapMarkerValue(line.slice(LESSON_MARKERS.none.length))
      if (v) last = { none: v.length > LESSON_REASON_CAP ? v.slice(0, LESSON_REASON_CAP) : v }
    }
  }
  return last
}

/**
 * Trim a marker's value and drop the quotes or backticks a worker wraps a path in. Models
 * quote paths by habit, and a leading backtick is the difference between a file the gate finds
 * and a file it reports missing — a refusal over punctuation nobody meant to type.
 */
function unwrapMarkerValue(raw) {
  let v = String(raw).trim()
  while (v.length >= 2 && ((v.startsWith('`') && v.endsWith('`')) || (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v
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
