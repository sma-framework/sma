/**
 * attempt-ledger.mjs — the sidecar per-attempt ledger for the durable queue
 * (Phase 9.5 Plan 03, Task 2; D-9.5-07 audit note).
 *
 * WHY THIS EXISTS (Multica retry-as-child-row IDEA, own implementation — zero code
 * copied): pg-boss mutates a job row IN PLACE across retries — `retry_count`
 * advances but the per-attempt history (which provider ran, why it failed, which
 * receipt certified it) is overwritten. The roster's «3 попытки» card needs that
 * history durably (T-9.5-07 repudiation mitigation). So every attempt appends ONE
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
 * ══════════════ THE DECISION JOURNAL RIDES HERE TOO (D-9.7-14) ══════════════════
 * The three explanation layers of an attempt — dispatcher reason code, the worker's
 * approach note, the memory trace — are appended by `appendJournalEntry` into a SIBLING
 * file `<taskId>.journal.jsonl` in this same dir, under this same append-only law: a row
 * is added, NEVER rewritten (no rewrite function exists in this module, by construction —
 * T-9-09). A sibling file, not extra rows in `<taskId>.jsonl`, because every existing
 * reader of the attempt rows (liveness sweep, the roster's attempt cards, the story-point
 * report) must keep seeing exactly the rows it saw before — the journal adds a layer, it
 * never edits the old one.
 *
 * THE APPROACH NOTE IS DATA. It is text a model wrote; it is capped and stored as data,
 * and wherever it later reaches a prompt it MUST ride inside the untrusted-data fence the
 * runner already uses for task titles and notes (T-9-08). The vocabularies and the
 * normalizer live in ../front/journal.mjs, which is an import-free leaf module — depending
 * on it here inverts no layer and closes no cycle.
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { attemptIdFor, normalizeJournalPayload } from '../front/journal.mjs'

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
])

/** `<ledgerDir>/<safeTaskId>.jsonl`. taskId is a queue id WE mint ('BL-…'/'R-…'/'F-…');
 *  still sanitize it to a safe filename (defense in depth — never a path traversal). */
function ledgerFile(ledgerDir, taskId) {
  const safe = String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(ledgerDir, `${safe}.jsonl`)
}

/**
 * recordAttempt(ledgerDir, attempt) — append ONE JSONL row for a single task attempt.
 * Returns the written (normalized) row. Throws only on programmer errors (missing
 * ledgerDir / taskId), never on a normal append.
 *
 * @param {string} ledgerDir
 * @param {{taskId:string, attempt?:number, workerId?:string, provider?:string,
 *          startedAt?:string, endedAt?:string, outcome?:string,
 *          failureReason?:string, receiptRef?:string, recordedAt?:string}} attempt
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

// ── the decision journal: three layers, strictly appended (D-9.7-14) ────────────

/** The ONLY keys a journal row carries — explicit-pick allowlist, same law as above. */
export const ALLOWED_JOURNAL_KEYS = Object.freeze(['taskId', 'attempt', 'attemptId', 'layer', 'payload', 'recordedAt'])

/** `<ledgerDir>/<safeTaskId>.journal.jsonl` — the attempt rows' sibling, same dir. */
function journalFile(ledgerDir, taskId) {
  const safe = String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(ledgerDir, `${safe}.journal.jsonl`)
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
