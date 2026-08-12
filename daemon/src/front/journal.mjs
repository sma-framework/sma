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
 * normalizeAttemptLogEntry(entry, {now}) → the row as it will be stored:
 * `{ts, line, subagent?, parentId?}`. PURE, never throws — a live log that could refuse a
 * line would be a live log that can stop the work it is describing.
 *
 * `subagent` and `parentId` are written ONLY when the line really came from a delegated
 * session (stream.mjs reads that off `parent_tool_use_id`), so an ordinary row stays two
 * fields wide and a reader never has to tell `false` from «this build did not know».
 *
 * `summary` is the SENTENCE A PERSON READS, built by the runner off the parsed frame before
 * the line was capped (runner/frame-summary.mjs). It is bounded here like everything else
 * that arrives from a worker: a closed number of parts, each field capped, every value
 * flattened to text. It is written only when there is something to say — a frame that means
 * nothing to a reader leaves the row exactly as wide as it was, and the screen falls back to
 * the raw line.
 *
 * @param {{line?:string, ts?:string, subagent?:boolean, parentId?:string, summary?:object[]}} entry
 * @param {{now?:()=>number}} [opts]
 * @returns {{ts:string, line:string, subagent?:true, parentId?:string, summary?:object[]}}
 */
export function normalizeAttemptLogEntry(entry = {}, { now } = {}) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const clock = typeof now === 'function' ? now : Date.now
  const ts = typeof e.ts === 'string' && e.ts ? e.ts : new Date(clock()).toISOString()
  const out = { ts, line: boundedText(e.line, ATTEMPT_LOG_LINE_CAP) }
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
