/**
 * approval-store.mjs — the daemon-owned row the front's approve/return CAS against
 * (the `sma_task_attempts` table named by cas.mjs and by the front's `taskTable` default).
 *
 * WHY A SIDE TABLE, NOT A pg-boss COLUMN: pg-boss owns the job lifecycle vocabulary
 * (created/active/completed/failed) and this backend never UPDATEs a boss table (the
 * pgboss-backend header law). «Waiting for a person» is NOT a job state — it is what the
 * daemon does AFTER pg-boss is done: the work is finished, the receipt exists, and the
 * task now owes a human a word. So it lives in its OWN one-row-per-task table the daemon
 * created and the daemon owns, and the CAS-UPDATE (cas.mjs) runs against THAT.
 *
 * WHY IT EXISTS AT ALL: without it `deps.casExec` has nothing to compare-and-set — the
 * approve/return handlers were shipped CASing a table nobody ever created, so every
 * approve would have died on «relation does not exist». One table, two columns of state,
 * created idempotently at boot beside the queues it belongs to.
 *
 * FAIL-OPEN, ALWAYS. Neither function may ever fail a boot or fail a task that did its
 * work: a restricted database (no CREATE right) or an unreachable one degrades to a
 * logged warning, and approve then answers its honest «already handled» instead of
 * crashing the daemon. Truth about the WORK still lives in pg-boss + the attempt ledger.
 *
 * DI: the SQL executor is injected — `execSql(sql, params) -> {rows}` — the SAME seam
 * cas.mjs and the pg-boss backend's read-only list() use. Tests feed a recorder; no live
 * Postgres is ever required. Node built-ins only (in fact none needed).
 */

/** The one table this module owns. Matches the front's `taskTable` default (server.mjs). */
export const APPROVAL_TABLE = 'sma_task_attempts'

/** The status a finished task carries until a human approves or returns it. */
export const AWAITING_APPROVAL = 'awaiting_approval'

/**
 * ensureApprovalTable(execSql, {log}) — create the approval table if it is not there yet.
 * Idempotent (IF NOT EXISTS), fail-open (a refused CREATE is logged, never thrown).
 *
 * @param {(sql:string, params:any[]) => Promise<any>} execSql
 * @param {{log?:Function}} [opts]
 * @returns {Promise<boolean>} true when the table is known to exist
 */
export async function ensureApprovalTable(execSql, { log } = {}) {
  if (typeof execSql !== 'function') return false
  try {
    await execSql(
      `CREATE TABLE IF NOT EXISTS ${APPROVAL_TABLE} (
         id text PRIMARY KEY,
         status text NOT NULL,
         dispatched_at bigint,
         returned_note text,
         merge_receipt text,
         updated_on timestamptz NOT NULL DEFAULT now()
       )`,
      [],
    )
    return true
  } catch (err) {
    if (typeof log === 'function') log(`approval table unavailable: ${String((err && err.message) || err)}`)
    return false
  }
}

/**
 * markAwaitingApproval(execSql, taskId, {log}) — record that a finished task is now
 * waiting for a person. Upsert, so a returned-and-redone task lands back in the same row.
 * Fail-open: a task that DID the work is never failed because its approval row could not
 * be written (the receipt is already durable in pg-boss + the attempt ledger).
 *
 * @param {(sql:string, params:any[]) => Promise<any>} execSql
 * @param {string} taskId
 * @param {{log?:Function}} [opts]
 * @returns {Promise<boolean>} true when the row was written
 */
export async function markAwaitingApproval(execSql, taskId, { log } = {}) {
  if (typeof execSql !== 'function' || !taskId) return false
  try {
    await execSql(
      `INSERT INTO ${APPROVAL_TABLE} (id, status) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, returned_note = NULL, updated_on = now()`,
      [String(taskId), AWAITING_APPROVAL],
    )
    return true
  } catch (err) {
    if (typeof log === 'function') log(`approval row not written for ${taskId}: ${String((err && err.message) || err)}`)
    return false
  }
}
