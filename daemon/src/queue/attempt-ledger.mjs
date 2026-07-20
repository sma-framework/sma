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
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
