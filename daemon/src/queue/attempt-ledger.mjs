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
  parseApproachNote,
} from '../front/journal.mjs'
import { envelopeHash } from './capability-envelope.mjs'
import { listNoteFiles } from '../../../scripts/sma/lib/generator.mjs'

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
])

/** The ONE rule for turning an id into a filename in this dir. An id is a queue id WE mint
 *  ('BL-…'/'R-…'/'F-…', or '<taskId>#<attempt>'); it is still sanitized (defense in depth —
 *  never a path traversal). Every file in this module goes through here, so the three
 *  siblings of one task can never come to disagree about what its name is. */
function safeName(id) {
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
 *          capabilityEnvelopeHash?:string, capabilityEnvelope?:object}} attempt
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
 * readAttemptLog({dir, attemptId, tail}) → `{attemptId, entries, total, truncated, note}` — the
 * LAST `tail` lines of one attempt (default 200, hard ceiling 1000), with `truncated` saying
 * that older lines exist. A missing log reads as an EMPTY log, never an error, and a corrupt
 * row is skipped — the same fail-open posture as every other reader here.
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
 * @returns {{attemptId:string, entries:object[], total:number, truncated:boolean, note:object|null}}
 */
export function readAttemptLog({ dir, attemptId, tail, fsImpl } = {}) {
  const id = String(attemptId ?? '')
  const empty = { attemptId: id, entries: [], total: 0, truncated: false, note: null }
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
  // The note is read off EVERY row, before the tail is taken — see the header.
  const note = parseApproachNote(rows.map((r) => String((r && r.line) || '')))
  return { attemptId: id, ...attemptLogTail(rows, tail), note }
}
