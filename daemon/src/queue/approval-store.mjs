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
 * The status a row carries once a person has said the LAST WORD about it in words —
 * «устарело», «предмета нет», «сделано иначе» — instead of paying for another attempt.
 *
 * IT LIVES IN THIS TABLE AND NOWHERE ELSE, and that is the whole reason the door works at
 * all. The work is already over: pg-boss has closed its job, and closing it again is either
 * impossible (a completed job) or a lie (a re-open). What is NOT over is the daemon's own
 * question — «does this row still owe a person a word» — and that question has always lived
 * here. So the closing is an answer to it, written by the same UPSERT that asked it.
 */
export const CLOSED_BY_PERSON = 'closed'

/**
 * The one status this table refuses to overwrite: an approval whose merge ritual is RUNNING.
 * A closing word landing mid-merge would decide the outcome of a ritual still in flight.
 */
const APPROVING = 'approving'

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
         closed_reason text,
         updated_on timestamptz NOT NULL DEFAULT now()
       )`,
      [],
    )
    // THE COLUMN IS ADDED SEPARATELY BECAUSE THE TABLE ALREADY EXISTS EVERYWHERE. A machine
    // that has been running this daemon has the table from before the closing word existed,
    // and `CREATE TABLE IF NOT EXISTS` says nothing to it at all — the door would then write
    // into a column that is not there and every closing would die on «column does not exist».
    // Idempotent and fail-open exactly like the CREATE above.
    await execSql(`ALTER TABLE ${APPROVAL_TABLE} ADD COLUMN IF NOT EXISTS closed_reason text`, [])
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

/**
 * closeWithWords(execSql, taskId, {reason, note}) — a person's LAST WORD about a task that
 * will not be done: it is obsolete, its subject does not exist, or it was done another way.
 *
 * ═══════════ AN UPSERT, NOT A CAS, AND THE DIFFERENCE IS THE WHOLE POINT ═══════════
 * The approve and return doors compare-and-set FROM a named state, because both of them move
 * work that is still in play and must lose a race honestly. This one writes about work that
 * is already over, and the states it would have to name do not exist for half its cases: a
 * task parked at the turn ceiling never got an approval row at all (only `complete` writes
 * one), and a task returned once carries `returned`. That is why «вернуть» answered 409 «race
 * lost» over rows a person was staring at — measured 02.09.2026 on four of them. A word about
 * a finished task cannot lose a race to the past, so it does not pretend to run one.
 *
 * TWO STATES IT STILL REFUSES, and both refusals are about work that is NOT over:
 *   `approving` — a merge ritual is in flight and will write its own outcome; a closing word
 *                 landing on top of it would decide a ritual still running.
 *   `closed`    — the word is already said. A second press is not a second closing, and
 *                 overwriting would let a later word quietly replace the one a person read.
 * Neither is an error here: `false` is the honest «this row is not mine to close», and the
 * door turns it into a sentence.
 *
 * PG-BOSS IS NOT TOUCHED BY ANY OF THIS. The job stays exactly as it finished — completed,
 * failed or cancelled — because that is what actually happened to the WORK, and rewriting it
 * would put the daemon's opinion inside the library's own vocabulary (the pgboss-backend
 * header law). What changes is the daemon's own answer about whether a person still owes this
 * row a word, which is precisely what this table is for.
 *
 * @param {(sql:string, params:any[]) => Promise<any>} execSql
 * @param {string} taskId
 * @param {{reason:string, note?:string, log?:Function}} opts
 * @returns {Promise<{written:boolean, refused:boolean}>} `refused` — the row exists and is
 *   approving or already closed; `written:false, refused:false` — the database did not answer.
 */
export async function closeWithWords(execSql, taskId, { reason, note, log } = {}) {
  if (typeof execSql !== 'function' || !taskId || !reason) return { written: false, refused: false }
  try {
    const res = await execSql(
      `INSERT INTO ${APPROVAL_TABLE} (id, status, closed_reason, returned_note)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
              SET status = EXCLUDED.status,
                  closed_reason = EXCLUDED.closed_reason,
                  returned_note = EXCLUDED.returned_note,
                  updated_on = now()
            WHERE ${APPROVAL_TABLE}.status <> $5 AND ${APPROVAL_TABLE}.status <> $2
        RETURNING id`,
      [String(taskId), CLOSED_BY_PERSON, String(reason), note == null ? null : String(note), APPROVING],
    )
    const rows = res && Array.isArray(res.rows) ? res.rows : []
    return { written: rows.length === 1, refused: rows.length === 0 }
  } catch (err) {
    // FAIL-OPEN IN THE ONLY DIRECTION THAT IS HONEST: a database that would not answer has
    // NOT closed anything, and the door says so rather than reporting a closing that never
    // landed. `refused:false` keeps «I could not write» apart from «this row refuses to be
    // closed» — two different sentences for the person standing at the button.
    if (typeof log === 'function') log(`closing word not written for ${taskId}: ${String((err && err.message) || err)}`)
    return { written: false, refused: false }
  }
}
