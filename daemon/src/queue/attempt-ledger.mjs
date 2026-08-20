/**
 * attempt-ledger.mjs — the sidecar per-attempt ledger for the durable queue: the
 * audit trail the queue itself cannot keep.
 *
 * WHY THIS EXISTS (Multica retry-as-child-row IDEA, own implementation — zero code
 * copied): pg-boss mutates a job row IN PLACE across retries — `retry_count`
 * advances but the per-attempt history (which provider ran, why it failed, which
 * receipt certified it) is overwritten. The roster's «3 попытки» card needs that
 * history durably, or a failed attempt can be denied after the fact. So every attempt appends ONE
 * immutable JSONL row to a sidecar ledger: pg-boss stays the queue truth, the ledger
 * is the durable per-attempt audit trail.
 *
 * STORAGE: one file per task id under `<ledgerDir>/<taskId>.jsonl`, append-only.
 * WHY O_APPEND (appendFileSync), NOT the fs-atomics temp+rename posture: journal.mjs
 * proved the pattern — a PER-ID file has NO shared-append race by construction (only
 * this one task's attempts ever write to its file, and attempts are serialized by the
 * queue lifecycle), so a plain append is atomic enough and strictly ordered. temp+
 * rename would REPLACE the whole file, discarding prior attempts — the wrong tool for
 * an append-only log.
 *
 * Node built-ins only; the ledger dir is caller-provided (DI). The reader is
 * FAIL-OPEN (a corrupt line is skipped, never thrown) — same posture as journal.mjs
 * parseFile. The writer uses an explicit-pick key allowlist (notify.mjs posture) so a
 * stray key can never leak into the durable record.
 *
 * ══════════════ THE DECISION JOURNAL RIDES HERE TOO ═════════════════════════════
 * The three explanation layers of an attempt — dispatcher reason code, the worker's
 * approach note, the memory trace — are appended by `appendJournalEntry` into a SIBLING
 * file `<taskId>.journal.jsonl` in this same dir, under this same append-only law: a row
 * is added, NEVER rewritten (no rewrite function exists in this module, by
 * construction). A sibling file, not extra rows in `<taskId>.jsonl`, because every existing
 * reader of the attempt rows (liveness sweep, the roster's attempt cards, the story-point
 * report) must keep seeing exactly the rows it saw before — the journal adds a layer, it
 * never edits the old one.
 *
 * THE APPROACH NOTE IS DATA. It is text a model wrote; it is capped and stored as data,
 * and wherever it later reaches a prompt it MUST ride inside the untrusted-data fence the
 * runner already uses for task titles and notes. The vocabularies and the
 * normalizer live in ../front/journal.mjs, which is an import-free leaf module — depending
 * on it here inverts no layer and closes no cycle.
 *
 * ═══════ THE ATTEMPT STAMP — THE WORLD AN ATTEMPT RAN IN ════════════════════════
 * Fleet invariant six (docs/FLEET-INVARIANTS.md): policy, memory snapshot, model and
 * harness version are fixed at the moment the attempt is created. Until now a row
 * recorded WHO ran the work and HOW it ended, and nothing about
 * the world it ran in — so a result could not be replayed against the state that produced
 * it. Seven names join the allowlist: policyVersion, memorySnapshotHash, planHash,
 * harnessVersion, stateMachineVersion, idempotencyKey and capabilityEnvelopeHash.
 *
 * THEY ARE ADDITIVE AND OPTIONAL. `recordAttempt` builds its row by iterating the allowlist
 * with an `if (attempt[k] !== undefined)` guard, so adding names IS the whole change on the
 * write side: a caller that passes none of them writes exactly the row every existing reader
 * already sees, and no second code path, spread or passthrough exists to keep in step. The
 * suite asserts that row byte-for-byte.
 *
 * ══════════════ THE LIVE ATTEMPT LOG RIDES HERE TOO ═════════════════════════════
 * `<attemptId>.log.ndjson`, a third sibling in this same dir, holds every line the worker
 * printed — appended WHILE the process is alive, so a screen can watch a running attempt
 * instead of reading a post-mortem. Same dir, same append-only law, same fail-open reader.
 *
 * PER ATTEMPT, NOT PER TASK, and that is the whole reason it is a separate file rather than
 * more rows in the journal: a retry of a task is a DIFFERENT transcript, and the screen asks
 * for one attempt at a time. The record's shape and its caps live in ../front/journal.mjs
 * with every other vocabulary; only the file lives here.
 *
 * THE WRITER IS FAIL-OPEN, WITHOUT EXCEPTION. A log is an observation of the work, never a
 * condition of it: an unwritable directory, a full disk or a revoked permission must cost
 * the founder the picture and nothing else. Every write is wrapped, `append` returns a
 * boolean instead of throwing, and the failure is handed to an injected `onError` so it can
 * reach the daemon's log — silence would be the one outcome worse than losing the lines.
 *
 * ONLY DIGESTS, NEVER THE THING ITSELF. A ledger row is read by anything that
 * reads the ledger — the liveness sweep, the roster cards, a human with `cat`. So the memory
 * snapshot is recorded as a digest and never as paths, file names or note text, and a
 * capability envelope is recorded as `envelopeHash(...)` and never as the envelope. A path
 * on an audit row is a disclosure channel bought for no benefit.
 *
 * WHERE THE VERSIONS COME FROM. `capabilityEnvelopeHash` is derived HERE, at the point of
 * recording, when a caller hands over the envelope the work ran under — one hash function,
 * no second implementation. `stateMachineVersion` and `idempotencyKey` are NOT defaulted
 * here and this module deliberately does not import the state machine to supply them: they
 * ride in on `applyTransition`'s result, whose shape state-machine.mjs designed for exactly
 * this call (`recordAttempt(ledgerDir, result)` works directly, and the suite proves it).
 * Stamping a state-machine version onto an attempt that never went through the state machine
 * would fabricate provenance, which is the one thing this stamp exists to prevent.
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  attemptIdFor,
  normalizeJournalPayload,
  normalizeAttemptLogEntry,
  attemptLogTail,
  attemptDigest,
  attemptRoles,
  parseApproachNote,
  approachLinesFrom,
} from '../front/journal.mjs'
import { envelopeHash } from './capability-envelope.mjs'
import { listNoteFiles } from '../../../scripts/sma/lib/generator.mjs'

/**
 * ATTEMPT_FILES_CAP — HOW MANY PATHS ONE ATTEMPT ROW MAY CARRY, declared ONCE.
 *
 * A refactor that touches a thousand files is ordinary, and a row carrying a thousand paths
 * would be a durable record nobody can open and a log line that pushes everything else out of
 * the window. So the list is bounded — and bounded HERE, in the module that owns the row's key
 * list, because a ceiling written twice is two ceilings: they agree the day they are typed and
 * drift the first time one of them is tuned. Every writer on this path imports this constant;
 * there is no second number anywhere along it.
 *
 * WHAT A CEILING MUST NEVER DO IS BE SILENT. Cutting a list without saying so turns «эти
 * файлы» into a claim that is quietly false, so the row carries `filesOverflow` and
 * `deletionsOverflow` beside the lists — counted SEPARATELY, because a silently truncated
 * deletion is exactly the asymmetric mistake the deletions were split out to prevent:
 * «изменён» read where «удалён» was true costs a person the rollback they came for.
 *
 * 200 is the working answer, not a law of nature: large enough that an ordinary attempt is
 * never cut at all, small enough that the row stays a thing a human opens.
 */
export const ATTEMPT_FILES_CAP = 200

/** The ONLY keys an attempt row carries — explicit-pick allowlist. */
export const ALLOWED_ATTEMPT_KEYS = Object.freeze([
  'taskId',
  'attempt',
  'workerId',
  'provider',
  'startedAt',
  'endedAt',
  'outcome',
  'failureReason',
  'receiptRef',
  // ── the attempt stamp (fleet invariant six) — additive, optional, digest-only ──
  'policyVersion',
  'memorySnapshotHash',
  'planHash',
  'harnessVersion',
  'stateMachineVersion',
  'idempotencyKey',
  'capabilityEnvelopeHash',
  // ── the worker's own session id ──
  // The identifier the CLI minted for the session this attempt ran in, read off the result
  // frame. It is kept because it is the ONE thing that cannot be recovered afterwards: with
  // it a later attempt can resume the session instead of paying for the same context twice,
  // and without it that option is gone the moment the process exits. It is an OPAQUE handle
  // and it stays on the audit row — the task-card read model is an explicit pick and does not
  // name it, so it never travels to a screen.
  'sessionId',
  // ── the provenance flag ──
  // `true` ONLY on a row appended by `reconcile.mjs` AFTER the fact, from the queue's own
  // retry count. Such a row is EVIDENCE THAT AN ATTEMPT EXISTED, and nothing more: nobody
  // watched it, so it carries no worker, no provider, no receipt, and its `recordedAt` is
  // the moment of reconciliation rather than the moment of the attempt. Absent on every
  // live-recorded row, so a reader never has to guess which kind it is holding.
  'reconstructed',
  // ── the copy the attempt ran in — its point of return ──
  // `base` is the commit the copy was branched from, `branch` the branch it was made on,
  // `worktreePath` where that copy lived on disk, `materialized` the list the provisioning
  // verb reported (one entry per manifest item: copied, linked, already tracked, skipped as
  // a secret), and `provisionMs` how long preparing the copy took.
  //
  // WHY THEY LIVE ON THE ATTEMPT ROW rather than in the operator log, where the base commit
  // used to be alone: "the work can be rolled back" and "it is visible WHAT to roll back to"
  // are two different guarantees, and only the second one survives a restart, a log rotation
  // or a month. The row is the durable record of the try, so it must carry the point of
  // return itself — for a FAILED attempt exactly as much as for a finished one, because a
  // failure is the case where somebody actually needs to roll something back. A stage that
  // ran with no copy at all (a documentary one) simply carries none of these keys.
  //
  // `cleanup` is written by a SEPARATE row of the same attempt — `{at, by, removedPath,
  // removedBranch, …}` and deliberately NO `endedAt`/`outcome`, so that folding the rows of
  // one attempt together neither stretches its duration to the moment of the sweep nor
  // overwrites how the try actually ended.
  'base',
  'branch',
  'worktreePath',
  'materialized',
  'provisionMs',
  'cleanup',
  // ── WHAT THE ATTEMPT ACTUALLY CHANGED, and what it made disappear ─────────────
  // `files` is the list git answers for `base..branch`: one entry per path, each carrying the
  // status letter and the name, and a rename carrying the name it had before. `deletions` is
  // the paths that are GONE — the deleted ones plus the old side of every rename.
  //
  // WHY THE SOURCE IS GIT AND NOT A WATCH ON THE TOOLS. A worker that deletes a file with
  // `rm`, rewrites one with a stream editor or drops one from the index with `git rm` did all
  // of that through a shell, and a list assembled from the NAMES of editing tools cannot see
  // any of it — not «usually misses it», cannot: no editing tool was called. Git compares two
  // trees and answers what actually differs, which is the only source that survives however
  // the change was made.
  //
  // WHY DELETIONS ARE A SEPARATE KEY rather than a status inside the list. The person reading
  // this row is reading it to undo something, and the cost of the two mistakes is not
  // symmetric: «изменён» misread where «удалён» was true sends them looking for a file that
  // is not there. The old side of a rename counts as vanished for the same reason — from
  // where that person stands, the path is gone.
  //
  // NAMES ONLY, NEVER CONTENT. This is a durable audit row and a diff body can carry a
  // secret; nothing here is ever produced with a patch flag.
  //
  // `filesOverflow` / `deletionsOverflow` — how many paths the ceiling (ATTEMPT_FILES_CAP
  // above) cut off, counted separately for the two lists and written only when non-zero. A
  // cut that says nothing is a record that lies quietly.
  //
  // ABSENT, NOT EMPTY, when nothing could be asked: no copy, no base commit, or a git that
  // refused. An empty array reads as «ничего не менялось», which is a different claim.
  'files',
  'deletions',
  'filesOverflow',
  'deletionsOverflow',
  // ── the session the worker was actually handed ────────────────────────────────
  // `personalLayer` is what the account held when this attempt ran, as the mirror reported
  // it: which directory it was taken from, a digest of the instructions file, how many hook
  // events and how many narrowing permission rules arrived, which overrides were applied and
  // which were dropped, and where the backup of the previous settings went. `mcpConfig` is
  // which servers the spawn was given — the path of the per-spawn file and the ids inside it.
  //
  // WHY THEY BELONG ON THE ROW rather than only in a log. Both answer a question that is asked
  // AFTER the fact and cannot be re-derived: an account's settings are overwritten by the next
  // attempt, and the per-spawn config file lives in a copy that gets swept. Without these two
  // keys «the worker ran with my rules» and «it had these servers and no others» are claims
  // nobody can check a week later — and they are exactly the claims a failed attempt turns on.
  // Both are DIGESTS AND NAMES, never contents: no rule text, no token name, no secret.
  'personalLayer',
  'mcpConfig',
  // ── what the approval carried out of the copy before it was removed ──────────
  // `memoryHarvest` is `{at, by, mode, copied, applied, drafted, refused, ok}`: which mode the
  // project's corpus is in (tracked by git, or ignored the way this product's own is), which
  // pipeline drafts had to be carried out of the copy by hand because a merge could not bring
  // them, which lessons the write pipeline actually admitted into the corpus, which approach
  // note was staged, and what it refused and why.
  //
  // WHY IT IS NOT A FIELD INSIDE `cleanup`. The two answer different questions — «what reached
  // the corpus» and «what was deleted from disk» — happen at different moments and fail
  // independently. Folded into one object they would one day explain a missing lesson by a
  // successful removal. Like `cleanup` it arrives on a SEPARATE row of the same attempt and
  // deliberately carries no `endedAt`/`outcome`, so folding the rows of one attempt neither
  // stretches its duration nor overwrites how the try ended.
  'memoryHarvest',
  // ── where the evidence of this try lives, and what a check made of it ──────────
  // `runDir` is the absolute path of `<projectDir>/.sma/runs/<attemptId>/` — the directory
  // holding what the attempt was given (the command line, the environment variable NAMES, the
  // envelope, the copy, the personal layer), what was watching it (the hooks that started and
  // answered, the tools a guard refused), a REFERENCE to its transcript in this ledger, and
  // how it ended. It is on the row rather than derived from an id and a convention because a
  // convention is not a record: the day the naming rule changes, every older row would point
  // at nothing and nobody would be able to tell that from a run that left no directory.
  //
  // `parity` is the verdict of the check made over that directory — «работник правда шёл под
  // теми же правилами, с той же памятью и за теми же стражами, что и человек». It is written
  // back beside the run rather than recomputed on every read, because the copy it describes
  // is swept after approval and the answer would stop being obtainable. `null` is a THIRD
  // state and it is deliberate: nobody has checked yet, which is not the same claim as
  // «checked and clean» and must never be renderable as one.
  'runDir',
  'parity',
  // ── what this row contradicts, if it contradicts anything ─────────────────────
  // `conflictsWith` names the terminal outcome ALREADY recorded for this same attempt number
  // when this row was appended — `'failed'` on a row saying `completed`, or the other way
  // round. It is written by the door below, never by a caller: the door is the only place
  // that can see both sides at once.
  //
  // ITS EXISTENCE IS THE WHOLE POINT OF NOT REFUSING. One physical try once landed in this
  // ledger under two numbers, and one of those numbers ended up carrying both `failed` and
  // `completed`; the cause is fixed at the source of the number now, but a ledger that
  // answered such a case by REFUSING the second row would have thrown away the only evidence
  // that the fault happened at all — and the row it refuses is, more often than not, the
  // tick's rich one: the single place `startedAt`, `sessionId`, the corpus digest, the run
  // directory and the receipt summary are written. So the row is written, and it is marked.
  'conflictsWith',
])

/**
 * The outcomes that END a try. `running` is not one of them: a try that reported it is alive
 * and then reported how it finished is one try speaking twice, which is ordinary and must
 * never be marked as a contradiction.
 */
export const TERMINAL_OUTCOMES = Object.freeze(['completed', 'failed'])

/** The ONE rule for turning an id into a filename in this dir. An id is a queue id WE mint
 *  ('BL-…'/'R-…'/'F-…', or '<taskId>#<attempt>'); it is still sanitized (defense in depth —
 *  never a path traversal). Every file in this module goes through here, so the three
 *  siblings of one task can never come to disagree about what its name is.
 *
 *  EXPORTED because the attempt's run directory is named by the SAME rule: a directory called
 *  after an attempt and a transcript called after the same attempt that disagreed by one
 *  character would be two records nobody could join. One rule, one name, three callers. */
export function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** `<ledgerDir>/<safeTaskId>.jsonl` — the attempt rows of one task. */
function ledgerFile(ledgerDir, taskId) {
  return join(ledgerDir, `${safeName(taskId)}.jsonl`)
}

/**
 * recordAttempt(ledgerDir, attempt) — append ONE JSONL row for a single task attempt.
 * Returns the written (normalized) row. Throws only on programmer errors (missing
 * ledgerDir / taskId), never on a normal append.
 *
 * @param {string} ledgerDir
 * THE CAPABILITY ENVELOPE MAY ARRIVE AS THE OBJECT. A caller that hands
 * over `capabilityEnvelope` gets its digest stamped as `capabilityEnvelopeHash`; the
 * envelope itself is NOT an allowlist member, so it can never reach the durable row. An
 * explicitly supplied `capabilityEnvelopeHash` wins — a receipt must be able to record the
 * digest of what actually ran, not of what a caller reconstructed afterwards.
 *
 * @param {{taskId:string, attempt?:number, workerId?:string, provider?:string,
 *          startedAt?:string, endedAt?:string, outcome?:string,
 *          failureReason?:string, receiptRef?:string, recordedAt?:string,
 *          policyVersion?:string, memorySnapshotHash?:string, planHash?:string,
 *          harnessVersion?:string, stateMachineVersion?:string, idempotencyKey?:string,
 *          capabilityEnvelopeHash?:string, capabilityEnvelope?:object,
 *          base?:string, branch?:string, worktreePath?:string,
 *          materialized?:object[], provisionMs?:number,
 *          cleanup?:{at:string, by:string, removedPath?:string, removedBranch?:string,
 *                    branchTip?:string, unlinked?:string[], dirtyFiles?:string[],
 *                    forced?:boolean, ok?:boolean, error?:string}} attempt
 * @returns {object} the appended row
 */
export function recordAttempt(ledgerDir, attempt) {
  if (!ledgerDir) throw new Error('recordAttempt requires a ledgerDir')
  if (!attempt || typeof attempt !== 'object') throw new Error('recordAttempt requires an attempt object')
  if (!attempt.taskId || typeof attempt.taskId !== 'string') {
    throw new Error('recordAttempt requires a string taskId')
  }
  mkdirSync(ledgerDir, { recursive: true })
  const row = {}
  for (const k of ALLOWED_ATTEMPT_KEYS) if (attempt[k] !== undefined) row[k] = attempt[k]
  // The envelope is hashed at the point of recording and only its digest is kept. A
  // malformed envelope is not fatal to the attempt — the stamp is simply not written,
  // because a wrong digest is worse than an absent one.
  if (row.capabilityEnvelopeHash === undefined && attempt.capabilityEnvelope !== undefined) {
    try {
      row.capabilityEnvelopeHash = envelopeHash(attempt.capabilityEnvelope)
    } catch {
      /* an unhashable envelope leaves no stamp (fail-open on the AUDIT field, never on the gate) */
    }
  }
  // ── THE CONTRADICTION LOCK: it MARKS, it never refuses ──────────────────────────────
  // Before a terminal row joins the file, the door looks at what this attempt number already
  // says. A DIFFERENT terminal outcome under the SAME number means two writers are describing
  // one try in two incompatible ways, and the row is stamped with what it contradicts.
  //
  // WHY A MARK AND NOT A REFUSAL. This file is an audit log. A row that was refused vanishes
  // without a trace, and with it the evidence of the very failure the log exists to remember —
  // and the refused row is typically the tick's, the only one carrying the start time, the
  // session id, the corpus digest, the run directory and the receipt summary. So the lock
  // costs a row nothing: it adds a word.
  //
  // FAIL-OPEN ON THE READ. A ledger file that cannot be read leaves the mark off and the write
  // untouched — reading somebody else's file may never cost an attempt the record of its own.
  // THE DOOR OWNS THIS KEY. A caller cannot declare what it contradicts — only the place that
  // sees both sides can, and a caller-supplied value would be a claim nobody checked.
  delete row.conflictsWith
  if (Number.isFinite(row.attempt) && TERMINAL_OUTCOMES.includes(row.outcome)) {
    try {
      const prior = readAttempts(ledgerDir, attempt.taskId).find(
        (r) => r && r.attempt === row.attempt && TERMINAL_OUTCOMES.includes(r.outcome) && r.outcome !== row.outcome,
      )
      if (prior) row.conflictsWith = prior.outcome
    } catch {
      /* unreadable history -> no mark, and the write goes on (fail-open on the AUDIT field) */
    }
  }
  row.recordedAt = attempt.recordedAt ?? new Date().toISOString()
  appendFileSync(ledgerFile(ledgerDir, attempt.taskId), `${JSON.stringify(row)}\n`)
  return row
}

/**
 * readAttempts(ledgerDir, taskId) — every recorded attempt for one task, ordered by
 * attempt number (stable). A missing ledger file yields `[]` (fail-open). Corrupt
 * lines are skipped, never thrown.
 *
 * @param {string} ledgerDir
 * @param {string} taskId
 * @returns {object[]}
 */
export function readAttempts(ledgerDir, taskId) {
  let raw
  try {
    raw = readFileSync(ledgerFile(ledgerDir, taskId), 'utf8')
  } catch {
    return [] // missing ledger -> no attempts yet (fail-open)
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* skip corrupt line (fail-open) */
    }
  }
  rows.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))
  return rows
}

/** A stored mark as milliseconds — a number stays, an ISO string parses, anything else is NaN. */
function stampMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string') return Date.parse(v)
  return NaN
}

/** Of two marks of the same kind, the earlier / later one — an unparseable mark never wins. */
function pickStamp(a, b, wantEarlier) {
  const ma = stampMs(a)
  const mb = stampMs(b)
  if (!Number.isFinite(ma)) return b
  if (!Number.isFinite(mb)) return a
  return (wantEarlier ? ma <= mb : ma >= mb) ? a : b
}

/**
 * foldAttemptRows(rows) → ONE RECORD PER TRY, for everything that COUNTS or SHOWS attempts.
 *
 * WHY THIS EXISTS. Two writers append for the same attempt — the state machine puts down the
 * transition, the tick puts down who ran it, on what and how it ended — so the ledger holds two
 * rows per try. That is correct for an append-only audit log (two hands wrote, two rows stand,
 * and `readAttempts` still returns every one of them), and it was wrong everywhere the ROWS were
 * counted as tries: a card said «6 подходов» over three, and a timeline printed «Подход 3»
 * twice. The count is fixed at the READING seam, once, so no consumer has to know the ledger
 * writes twice — and the file itself is never rewritten to make a number come out right.
 *
 * MERGE RULE. Rows sharing an attempt number become one record: the EARLIEST start mark and the
 * LATEST end mark (the try began when its first row says and ended when its last one does — a
 * length assembled from one row's start and the other's end is the honest length of the try),
 * and for every other field the last non-empty value wins, so the tick's richer row fills what
 * the transition row left blank without erasing what only the transition row knows.
 *
 * A ROW WITH NO ATTEMPT NUMBER IS NEVER FOLDED INTO ANOTHER. Silently gathering unnumbered rows
 * would merge tries nobody said were the same; they stay separate records, in the order they
 * arrived.
 *
 * AND IT NO LONGER PICKS A WINNER IN SILENCE. «Last non-empty wins» was designed for «two
 * writers, ONE outcome», and on two DIFFERENT terminal outcomes it has neither a rule nor a
 * right to choose — yet it chose, quietly, and a try that had been recorded as failed read as
 * a clean success with a stray failure reason attached. A record whose rows disagree now
 * carries `conflict: {outcomes:[…], rows:N}`, naming BOTH outcomes in the order they were
 * recorded and how many rows were folded into it. Everything else about the merge is unchanged.
 *
 * THE FLAG IS COMPUTED FROM THE ROWS THEMSELVES, not from the writer's mark. The rows that
 * matter most are the ones already on disk, written before the mark existed — and this ledger
 * is never rewritten to make an old record look tidier than it was.
 *
 * @param {object[]} rows — ledger rows as `readAttempts` returns them
 * @returns {object[]} one record per attempt number, first-appearance order
 */
export function foldAttemptRows(rows) {
  if (!Array.isArray(rows)) return []
  const merged = new Map()
  /** key -> {outcomes:string[], rows:number} — what each folded record was assembled from. */
  const seen = new Map()
  let unnumbered = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const key = Number.isFinite(row.attempt) ? `attempt:${row.attempt}` : `unnumbered:${unnumbered++}`
    const tally = seen.get(key) || { outcomes: [], rows: 0 }
    tally.rows += 1
    if (TERMINAL_OUTCOMES.includes(row.outcome) && !tally.outcomes.includes(row.outcome)) {
      tally.outcomes.push(row.outcome)
    }
    seen.set(key, tally)
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...row })
      continue
    }
    const next = { ...prev }
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === '') continue
      next[k] = v
    }
    if (prev.startedAt != null && row.startedAt != null) next.startedAt = pickStamp(prev.startedAt, row.startedAt, true)
    if (prev.endedAt != null && row.endedAt != null) next.endedAt = pickStamp(prev.endedAt, row.endedAt, false)
    merged.set(key, next)
  }
  // The anomaly, said out loud on the record it belongs to — after the merge, because it is a
  // property of the ROWS and not of any one of them.
  for (const [key, record] of merged) {
    const tally = seen.get(key)
    if (tally && tally.outcomes.length > 1) {
      record.conflict = { outcomes: [...tally.outcomes], rows: tally.rows }
    }
  }
  return [...merged.values()]
}

// ── the memory snapshot digest (fleet invariant six) ───────────────────────────

/**
 * What a row carries when there was no corpus to snapshot. A DECLARED absence, not a
 * digest: hashing nothing would produce a real-looking value and an audit reader would
 * have no way to tell "the worker knew nothing" from "the worker knew this exact empty
 * set". Deliberately short, lowercase and separator-free so it can never be mistaken for a
 * hex digest and never leaks a path.
 */
export const MEMORY_SNAPSHOT_ABSENT = 'absent'

/**
 * memorySnapshotHash({corpusDir, fsImpl}) → a 64-char hex digest of the canonical memory
 * records, or `MEMORY_SNAPSHOT_ABSENT`.
 *
 * WHAT IT COVERS AND WHY: exactly the corpus's canonical records — the files
 * `generator.mjs` calls notes. The membership question is asked THROUGH `listNoteFiles`
 * rather than re-derived from a directory listing, because that module owns the one
 * definition of what counts as a note and states that a consumer must ask it (a second
 * idea of "what is structural" is how two answers start). Generated artifacts — MEMORY.md,
 * ARCHIVE.md, TAGS.md, the per-area INDEX-*.md — are therefore excluded for free: an index
 * rebuild must not move this digest, because the digest answers «what did the worker know»
 * and a derived index is not knowledge.
 *
 * Both the file NAME and the file CONTENT enter the hash, length-prefixed, in
 * `listNoteFiles`'s stable sorted order — so renaming a record moves the digest, and no
 * choice of separator inside a file can make two different corpora hash alike. The corpus
 * PATH does not enter: two identical corpora in different directories are the same
 * knowledge, and the absolute path of a machine has no business in a durable audit row.
 *
 * A missing corpus, an unreadable one, and one holding only generated artifacts all return
 * the declared absent value. Never throws: an attempt must still be recordable when the
 * corpus is not there.
 *
 * SEAM BOUNDARY, stated so nobody trips on it: `fsImpl` overrides CONTENT reads
 * only. The membership question always goes to `listNoteFiles`, which asks the
 * REAL filesystem — that module owns the one definition of "what is a note" and
 * re-deriving it here against a fake fs would be the second definition it warns
 * against. A test injecting a fully virtual fs therefore gets
 * MEMORY_SNAPSHOT_ABSENT; back the corpus with a real temp dir instead.
 *
 * @param {string|{corpusDir?:string, fsImpl?:object}} input — the corpus dir, or options
 * @returns {string} 64 hex chars, or MEMORY_SNAPSHOT_ABSENT
 */
export function memorySnapshotHash(input) {
  const opts = typeof input === 'string' ? { corpusDir: input } : input && typeof input === 'object' ? input : {}
  const { corpusDir, fsImpl } = opts
  if (!corpusDir || typeof corpusDir !== 'string') return MEMORY_SNAPSHOT_ABSENT

  let files
  try {
    files = listNoteFiles(corpusDir)
  } catch {
    return MEMORY_SNAPSHOT_ABSENT
  }
  if (!Array.isArray(files) || files.length === 0) return MEMORY_SNAPSHOT_ABSENT

  const read = (fsImpl && fsImpl.readFileSync) || readFileSync
  const hash = createHash('sha256')
  let counted = 0
  for (const file of files) {
    let text
    try {
      text = String(read(join(corpusDir, file), 'utf8'))
    } catch {
      continue // an unreadable record is not knowledge the worker had
    }
    hash.update(`${file.length}:${file}`).update(`${text.length}:${text}`)
    counted += 1
  }
  return counted === 0 ? MEMORY_SNAPSHOT_ABSENT : hash.digest('hex')
}

// ── the decision journal: three layers, strictly appended ──────────────────────

/** The ONLY keys a journal row carries — explicit-pick allowlist, same law as above. */
export const ALLOWED_JOURNAL_KEYS = Object.freeze(['taskId', 'attempt', 'attemptId', 'layer', 'payload', 'recordedAt'])

/** `<ledgerDir>/<safeTaskId>.journal.jsonl` — the attempt rows' sibling, same dir. */
function journalFile(ledgerDir, taskId) {
  return join(ledgerDir, `${safeName(taskId)}.journal.jsonl`)
}

/**
 * appendJournalEntry(ledgerDir, entry) — append ONE journal row for one layer of one
 * attempt. STRICTLY ADD-ONLY: there is no counterpart that edits or removes a row.
 * The payload is normalized by the layer's own rule (closed dispatcher vocabulary, capped
 * approach note, ids-only memory trace); a refused entry throws and writes NOTHING.
 * Returns the written (normalized) row.
 *
 * @param {string} ledgerDir
 * @param {{taskId:string, attempt?:number, attemptId?:string, layer:string, payload?:object,
 *          recordedAt?:string, clock?:()=>number, fsImpl?:object}} entry
 * @returns {object} the appended row
 */
export function appendJournalEntry(ledgerDir, entry = {}) {
  if (!ledgerDir) throw new Error('appendJournalEntry requires a ledgerDir')
  if (!entry || typeof entry !== 'object') throw new Error('appendJournalEntry requires an entry object')
  if (!entry.taskId || typeof entry.taskId !== 'string') {
    throw new Error('appendJournalEntry requires a string taskId')
  }
  // normalize FIRST — a refused entry must not create a file or a partial row
  const payload = normalizeJournalPayload(entry.layer, entry.payload)

  const attempt = Number.isFinite(Number(entry.attempt)) ? Number(entry.attempt) : 1
  const clock = typeof entry.clock === 'function' ? entry.clock : Date.now
  const fs = entry.fsImpl || {}
  const mkdir = fs.mkdirSync || mkdirSync
  const append = fs.appendFileSync || appendFileSync

  const row = {
    taskId: entry.taskId,
    attempt,
    attemptId: entry.attemptId || attemptIdFor(entry.taskId, attempt),
    layer: entry.layer,
    payload,
    recordedAt: entry.recordedAt ?? new Date(clock()).toISOString(),
  }
  mkdir(ledgerDir, { recursive: true })
  append(journalFile(ledgerDir, entry.taskId), `${JSON.stringify(row)}\n`)
  return row
}

/**
 * readJournalEntries(ledgerDir, taskId) — every journal row of one task, in the order it
 * was appended. A missing journal yields `[]` (fail-open — every task created before this
 * revision has none, and that is not an error). Corrupt lines are skipped, never thrown.
 *
 * @param {string} ledgerDir
 * @param {string} taskId
 * @param {{fsImpl?:object}} [opts]
 * @returns {object[]}
 */
export function readJournalEntries(ledgerDir, taskId, { fsImpl } = {}) {
  const read = (fsImpl && fsImpl.readFileSync) || readFileSync
  let raw
  try {
    raw = String(read(journalFile(ledgerDir, taskId), 'utf8'))
  } catch {
    return [] // no journal yet (fail-open)
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* skip corrupt line (fail-open) */
    }
  }
  return rows
}

// ── the live attempt log: the worker's stdout, while the worker is still alive ──

/** `<ledgerDir>/<safeAttemptId>.log.ndjson` — the transcript of ONE attempt. */
function attemptLogFile(dir, attemptId) {
  return join(dir, `${safeName(attemptId)}.log.ndjson`)
}

/**
 * createAttemptLogWriter({dir, attemptId, …}) → `{append, attemptId, file}`.
 * `append(entry)` writes ONE normalized NDJSON row and returns `true` / `false` — it NEVER
 * throws, whatever the filesystem does (see THE WRITER IS FAIL-OPEN above). A missing dir or
 * attemptId yields a writer whose `append` is an honest `false`, so a caller never needs a
 * null check around a line of logging.
 *
 * The directory is made ONCE here rather than per row: a stream is thousands of lines and a
 * mkdir per line is a syscall bought for nothing.
 *
 * @param {{dir?:string, attemptId?:string, fsImpl?:object, clock?:()=>number,
 *          onError?:(err:Error)=>void}} [o]
 * @returns {{append:(entry:object)=>boolean, attemptId:string, file:(string|null)}}
 */
export function createAttemptLogWriter({ dir, attemptId, fsImpl, clock, onError } = {}) {
  const fs = fsImpl || {}
  const mkdir = fs.mkdirSync || mkdirSync
  const append = fs.appendFileSync || appendFileSync
  const id = String(attemptId ?? '')
  const file = dir && id ? attemptLogFile(dir, id) : null

  // One failure is reported once. A stream that cannot be written produces a line per line
  // of output otherwise, and the real reason drowns in its own repetition.
  let reported = false
  const complain = (err) => {
    if (reported) return
    reported = true
    if (typeof onError === 'function') {
      try {
        onError(err)
      } catch {
        /* even the complaint is fail-open */
      }
    }
  }

  let ready = false
  if (file) {
    try {
      mkdir(dir, { recursive: true })
      ready = true
    } catch (err) {
      complain(err)
    }
  }

  return {
    attemptId: id,
    file,
    append(entry) {
      if (!file || !ready) return false
      try {
        append(file, `${JSON.stringify(normalizeAttemptLogEntry(entry, { now: clock }))}\n`)
        return true
      } catch (err) {
        complain(err)
        return false
      }
    },
  }
}

/**
 * readAttemptLog({dir, attemptId, tail}) → `{attemptId, entries, total, truncated, note, digest,
 * roles, rolesMore}` — the LAST `tail` lines of one attempt (default 200, hard ceiling 1000),
 * with `truncated` saying that older lines exist, `digest` — the roll-up of the WHOLE attempt
 * (tools, files, connections, cost) — and `roles` — who was in the session, the executor and
 * each delegation, also over the whole attempt (../front/journal.mjs owns both). A missing log
 * reads as an EMPTY log, never an error, and a corrupt row is skipped — the same fail-open
 * posture as every other reader.
 *
 * THE ENTRIES ARE DATA AND ARE RETURNED AS THEY WERE STORED. This reader does not interpret
 * a line, does not strip anything out of it and makes no claim that it is safe: it is worker
 * output, and whatever shows it shows it as TEXT.
 *
 * WHY THE NOTE IS TAKEN HERE AND NOT BY THE CALLER. The worker states its approach on the
 * SAME stream, in the first minutes of the attempt — so a caller who parsed the returned
 * `entries` would be parsing a TAIL, and would report «no note» for exactly the long attempt
 * a person most wants explained. This function already holds every row in memory one line
 * above, so the note costs nothing extra and there is one place, not two, that reads the
 * file. It is the same soft marker protocol the tick reads to fill the decision journal, so
 * a running attempt and a finished one answer the same sentence.
 *
 * COST, STATED HONESTLY: the file is read whole and the tail is taken in memory. That is
 * bounded by the log of ONE attempt and is the cheap correct thing today; if an attempt's
 * transcript ever grows past comfort, the fix is a reverse chunked reader here — the
 * signature already hides it.
 *
 * @param {{dir?:string, attemptId?:string, tail?:number, fsImpl?:object}} [o]
 * @returns {{attemptId:string, entries:object[], total:number, truncated:boolean,
 *   note:object|null, digest:object|null, roles:object[], rolesMore:number}}
 */
export function readAttemptLog({ dir, attemptId, tail, fsImpl } = {}) {
  const id = String(attemptId ?? '')
  // An attempt with no log has nobody in it either: an EMPTY list of voices, never a lone
  // executor row a card would draw as «работал один» about a session that has not printed yet.
  const empty = { attemptId: id, entries: [], total: 0, truncated: false, note: null, digest: null, roles: [], rolesMore: 0 }
  if (!dir || !id) return empty
  const read = (fsImpl && fsImpl.readFileSync) || readFileSync
  let raw
  try {
    raw = String(read(attemptLogFile(dir, id), 'utf8'))
  } catch {
    return empty // no log yet (fail-open) — an attempt that printed nothing is not an error
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* skip corrupt line (fail-open) */
    }
  }
  // The note is read off EVERY row, before the tail is taken — see the header. The roll-up is
  // taken here for exactly the same reason and no other: counting tools, files and money off
  // the RETURNED rows would count the tail, and would quietly report «два инструмента» about
  // an attempt that used forty. Both readings are already holding every row in memory.
  // …and it is read off the lines UNWRAPPED, exactly as the tick reads them. A stored line is
  // a JSON frame with the worker's words inside it, so the markers are never at the start of a
  // line: this call passed the raw lines and the panel «что работник собирался сделать» was
  // therefore empty on every attempt — including the ones the tick had already accepted the
  // note of, through the same parser, over the same stream, unwrapped.
  const note = parseApproachNote(approachLinesFrom(rows.map((r) => String((r && r.line) || ''))))
  const digest = attemptDigest(rows)
  // WHO WAS IN THE SESSION — counted here for the third time for the same one reason: a
  // delegation whose lines all fell outside the tail would otherwise vanish from the tree, and
  // an executor's own length would be measured from wherever the window happens to start.
  const roles = attemptRoles(rows)
  return { attemptId: id, ...attemptLogTail(rows, tail), note, digest, roles: roles.list, rolesMore: roles.more }
}
