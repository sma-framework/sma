/**
 * encoding.mjs — the queue database's character encoding: detected at boot, named when it
 * is wrong, and migrated by one command.
 *
 * WHY THIS FILE EXISTS. PostgreSQL fixes a database's encoding when the database is
 * created, and a cluster initialised by the Windows `initdb` defaults to the machine's ANSI
 * code page — WIN1252 on a Western install. A database created on such a cluster inherits
 * it, and it then CANNOT store a task title written in Cyrillic, Greek, Japanese, or an
 * emoji: the server refuses the INSERT with SQLSTATE 22P05 («no equivalent in encoding
 * WIN1252»). People name their work in their own language, so this is not an exotic edge —
 * it is the first task a non-English team types. Until this module the product answered
 * that with a driver stack trace and no way out.
 *
 * THREE THINGS LIVE HERE, AND THEY ARE THE SAME SUBJECT:
 *
 *   1. DETECTION. One read-only question at boot — what encoding is this database, and what
 *      encoding is this session speaking. A wrong answer is LOGGED, never fatal: a daemon
 *      that has been running for months on a WIN1252 database must not stop booting because
 *      the product learned to notice. The diagnosis names the database, what will happen to
 *      a non-ASCII title, and the exact command that fixes it.
 *
 *   2. THE REFUSAL, IN WORDS. When an enqueue is refused for the encoding, the driver's
 *      byte-sequence message is turned into an instruction. The raw error is kept as the
 *      cause; what reaches the person is what to do.
 *
 *   3. THE MIGRATION. A database's encoding cannot be altered in place, so the fix is:
 *      build a new one over `template0` with an explicit UTF8, carry the work that is still
 *      pending plus the daemon's own attempt rows into it, and swap the names. The old
 *      database is RENAMED, never dropped — this module contains no DROP.
 *
 * ═══════════ WHY `client_encoding` IS PART OF THIS AND NOT A DETAIL ═══════════════════
 * node-postgres decodes everything the server sends as UTF-8 unconditionally, but it does
 * NOT ask the server for UTF-8 unless it is told to: with no `client_encoding` in the
 * connection it inherits the server's. On a WIN1252 database the server therefore sends
 * WIN1252 bytes and the driver reads them as UTF-8 — every accented character comes back
 * mangled, silently, on a path that never errors. Asking for UTF8 explicitly makes the
 * SERVER transcode on the wire, which is also what makes this migration correct: text
 * already stored in the old encoding arrives intact and lands intact in the new database.
 *
 * NOTHING IS DELETED, AND WHAT DOES NOT TRAVEL IS PRINTED. A migration that quietly loses
 * the queue's history would be worse than the fault it repairs, so the report carries an
 * explicit `notCarried` list and the caller prints it.
 *
 * DI EVERYWHERE, NO LIVE POSTGRES IN THE SUITE: `execSql(sql, params) -> {rows}` (the same
 * seam cas.mjs and the pg-boss backend's read-only list() use), an admin executor for the
 * two statements that must run outside the database being replaced, and a factory that
 * opens the target. Node built-ins only — in fact none.
 */

/** The only encoding this product asks for, everywhere. */
export const UTF8 = 'UTF8'

/** SQLSTATE for «this character has no equivalent in the target encoding». */
export const UNTRANSLATABLE_CHARACTER = '22P05'

/** The command a person is told to run. One string, so the docs and the logs cannot drift. */
export const MIGRATE_COMMAND = 'node supervisor/queue-utf8-migrate.mjs --apply'

/** A plain PostgreSQL identifier: what may be interpolated into DDL that cannot take a parameter. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/
const MAX_IDENTIFIER = 63

/** Named error for every encoding fault this module reports — one type the callers can catch. */
export class QueueEncodingError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'QueueEncodingError'
  }
}

/**
 * assertIdentifier(name) — a database name is interpolated into DDL because PostgreSQL
 * accepts no parameter there. It therefore has to be proven to be an identifier first: this
 * name comes out of a connection string a human wrote, which is a trust boundary like any
 * other. Returns the name so it can be used inline.
 */
function assertIdentifier(name) {
  const s = String(name ?? '')
  if (!IDENTIFIER_RE.test(s) || s.length > MAX_IDENTIFIER) {
    throw new QueueEncodingError(
      `"${s}" is not a plain database name (letters, digits and underscores, up to ${MAX_IDENTIFIER} characters)`,
    )
  }
  return s
}

/** The one read-only question: what is this database, and what is this session speaking. */
const ENCODING_SQL = `SELECT current_database() AS database,
       pg_encoding_to_char(encoding) AS server_encoding,
       current_setting('client_encoding') AS client_encoding
  FROM pg_database WHERE datname = current_database()`

/**
 * readQueueEncoding(execSql) → `{database, serverEncoding, clientEncoding}` or NULL.
 *
 * Null is an honest absence, not an error: a seam that cannot answer (a restricted role, a
 * fake in a unit test, a connection that has just died) must not turn a boot into a crash
 * over a diagnostic question.
 *
 * @param {(sql:string, params:any[]) => Promise<{rows:any[]}>} execSql
 * @returns {Promise<{database:string, serverEncoding:string, clientEncoding:string}|null>}
 */
export async function readQueueEncoding(execSql) {
  if (typeof execSql !== 'function') return null
  try {
    const res = await execSql(ENCODING_SQL, [])
    const row = res && Array.isArray(res.rows) ? res.rows[0] : null
    if (!row || !row.server_encoding) return null
    return {
      database: row.database ?? null,
      serverEncoding: String(row.server_encoding),
      clientEncoding: row.client_encoding ? String(row.client_encoding) : null,
    }
  } catch {
    return null // asking is optional; answering wrongly is not
  }
}

/**
 * describeEncoding(info) → the lines a person needs, or NULL when there is nothing to say.
 *
 * Silent on UTF8 by design: a diagnosis printed on a healthy install is noise, and noise is
 * how a real warning stops being read. When it does speak it carries all three parts — the
 * FACT (which database, which encoding), the CONSEQUENCE (what happens to a title that is
 * not plain ASCII), and the ACTION (the command).
 *
 * @param {{database?:string, serverEncoding?:string, clientEncoding?:string}|null} info
 * @returns {string[]|null}
 */
export function describeEncoding(info) {
  if (!info || !info.serverEncoding || info.serverEncoding.toUpperCase() === UTF8) return null
  const db = info.database ?? 'the queue database'
  return [
    `the queue database ${db} was created with encoding ${info.serverEncoding}, not ${UTF8}.`,
    `A task title that is not plain ASCII — Cyrillic, Greek, Japanese, an emoji, an accented`,
    `letter outside ${info.serverEncoding} — will be REFUSED by the database, and the task will`,
    `not be stored at all. Existing tasks are untouched and everything else keeps working.`,
    `To move the queue onto ${UTF8}, with the tasks that are still waiting: ${MIGRATE_COMMAND}`,
  ]
}

/**
 * describeUntranslatable(err, info) → the readable refusal for an encoding rejection, or
 * NULL when this is not one. It never dresses up an error it does not understand: a unique
 * violation is a unique violation and must reach the caller as itself.
 *
 * @param {any} err
 * @param {{database?:string, serverEncoding?:string}} [info]
 * @returns {string|null}
 */
export function describeUntranslatable(err, info = {}) {
  if (!err || err.code !== UNTRANSLATABLE_CHARACTER) return null
  const db = info.database ?? 'the queue database'
  const enc = info.serverEncoding ? ` (${info.serverEncoding})` : ''
  return (
    `the queue database ${db}${enc} cannot store this text: it contains characters that do not ` +
    `exist in its encoding, so the task was not saved. This is the database's encoding, not the ` +
    `text — move the queue onto ${UTF8} and the same task will be accepted: ${MIGRATE_COMMAND}`
  )
}

/**
 * createDatabaseStatement(name) — a new database in UTF8 over `template0`.
 *
 * `template0` is the point: `template1` carries the cluster's own encoding and a CREATE
 * DATABASE over it cannot change that, which is exactly how the ANSI default propagates to
 * every database on a Windows cluster. The C collation is chosen for the same reason the
 * starter chooses it — it is available on every cluster, and a queue orders by numbers and
 * timestamps, never by a locale's alphabet.
 *
 * @param {string} name
 * @returns {string}
 */
export function createDatabaseStatement(name) {
  const db = assertIdentifier(name)
  return `CREATE DATABASE "${db}" ENCODING '${UTF8}' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`
}

/** `ALTER DATABASE "a" RENAME TO "b"` — both names proven to be identifiers first. */
function renameStatement(from, to) {
  return `ALTER DATABASE "${assertIdentifier(from)}" RENAME TO "${assertIdentifier(to)}"`
}

/** A compact, sortable stamp for the two derived database names: 20260806T100000. */
function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
}

/** Jobs still owing work: queued, waiting to retry, or held by a worker. */
const PENDING_SQL = `SELECT id, name, data, state, retry_count
  FROM pgboss.job
 WHERE name LIKE 'sma.task.%' AND state IN ('created', 'retry', 'active')
 ORDER BY created_on`

/** The daemon's own row per task — what is waiting for a person (approval-store.mjs). */
const APPROVALS_SQL = `SELECT id, status, dispatched_at, returned_note, merge_receipt FROM sma_task_attempts`

/** Everything else connected to the database that is about to be replaced. */
const CONNECTIONS_SQL = `SELECT count(*)::int AS others FROM pg_stat_activity
 WHERE datname = $1 AND pid <> pg_backend_pid()`

const APPROVAL_INSERT_SQL = `INSERT INTO sma_task_attempts (id, status, dispatched_at, returned_note, merge_receipt)
 VALUES ($1, $2, $3, $4, $5)
 ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, dispatched_at = EXCLUDED.dispatched_at,
   returned_note = EXCLUDED.returned_note, merge_receipt = EXCLUDED.merge_receipt`

/**
 * WHAT DOES NOT COME OVER. Printed by the caller, every time, so the person who runs this
 * knows what they are trading before the swap rather than discovering it afterwards.
 */
const NOT_CARRIED = Object.freeze([
  'the finished and dead-lettered jobs — the queue history stays in the archived database',
  'when each task was queued, claimed and completed: the carried tasks are new rows with new times',
  "the queue's internal job ids and its retry counters (the task's own attempt NUMBER is carried)",
  'a task a worker was holding at that moment comes back as queued, and that run is lost',
])

/** The task, as it should be re-enqueued: the payload, with the attempt number it had reached. */
function taskFromJob(row) {
  const data = (row && row.data) || {}
  const attempt = (Number(data.attempt) || 1) + (Number(row && row.retry_count) || 0)
  return { ...data, attempt }
}

/**
 * migrateQueueEncoding(opts) — move the queue onto a UTF8 database, or say why it will not.
 *
 * DRY RUN BY DEFAULT (`apply:false`): it reads, counts and reports. Nothing is created,
 * nothing is renamed, nothing is written.
 *
 * IT REFUSES WHILE ANYTHING ELSE IS CONNECTED. The rename at the end cannot run against a
 * database in use, and a half-done swap is the one outcome nobody could recover from
 * quickly; so the check happens before any work rather than as the failure of the last step.
 *
 * THE ORDER IS CHOSEN FOR WHAT SURVIVES A CRASH AT EVERY LINE: read everything, hand the
 * whole export to `snapshot` (a file outside the database) BEFORE any DDL, then build the
 * new database, fill it, and only then touch the names. If the second rename fails the first
 * one is put back, so the daemon's own database name is never left pointing at nothing.
 *
 * @param {{database:string, sourceSql:Function, adminSql:Function, openTarget:Function,
 *          snapshot?:Function, apply?:boolean, clock?:Function, log?:Function}} opts
 * @returns {Promise<object>} the report
 */
export async function migrateQueueEncoding({
  database,
  sourceSql,
  adminSql,
  openTarget,
  snapshot,
  apply = false,
  clock = Date.now,
  log = () => {},
} = {}) {
  assertIdentifier(database)
  if (typeof sourceSql !== 'function' || typeof adminSql !== 'function' || typeof openTarget !== 'function') {
    throw new QueueEncodingError('migrateQueueEncoding needs sourceSql, adminSql and openTarget')
  }

  const info = await readQueueEncoding(sourceSql)
  const encoding = info && info.serverEncoding ? info.serverEncoding : null
  if (!encoding) {
    return { database, encoding: null, applied: false, reason: 'unknown_encoding', notCarried: [...NOT_CARRIED] }
  }
  if (encoding.toUpperCase() === UTF8) {
    log(`${database} is already ${UTF8} — nothing to migrate`)
    return { database, encoding, applied: false, reason: 'already_utf8', notCarried: [] }
  }

  const busy = await sourceSql(CONNECTIONS_SQL, [database])
  const others = Number((busy && busy.rows && busy.rows[0] && busy.rows[0].others) || 0)
  if (others > 0) {
    log(`${others} other connection(s) are using ${database} — stop the daemon first, then run this again`)
    return { database, encoding, applied: false, reason: 'in_use', otherConnections: others, notCarried: [...NOT_CARRIED] }
  }

  const pendingRows = ((await sourceSql(PENDING_SQL, [])) || {}).rows || []
  const approvalRows = ((await sourceSql(APPROVALS_SQL, [])) || {}).rows || []
  const tasks = pendingRows.map(taskFromJob)

  const stamp = stampOf(clock())
  const target = `${database}_utf8_${stamp}`
  const archive = `${database}_pre_utf8_${stamp}`
  const base = {
    database,
    encoding,
    pending: tasks.length,
    approvals: approvalRows.length,
    targetDatabase: target,
    archivedAs: archive,
    notCarried: [...NOT_CARRIED],
  }

  if (!apply) return { ...base, applied: false, reason: 'dry_run' }

  // The export leaves the database BEFORE any DDL: from here on there is a copy of the work
  // on disk that no rename can take away.
  let snapshotPath = null
  if (typeof snapshot === 'function') {
    snapshotPath = (await snapshot({ database, encoding, stamp, tasks, approvals: approvalRows })) ?? null
  }

  await adminSql(createDatabaseStatement(target), [])

  let carriedTasks = 0
  let carriedApprovals = 0
  const opened = await openTarget(target)
  try {
    for (const task of tasks) {
      try {
        await opened.enqueue(task)
      } catch (err) {
        // STOP HERE, BEFORE THE NAMES MOVE. Right now the new database is merely an extra
        // database and every task is still where it was; a swap completed around a task that
        // could not be carried would leave a queue that looks healthy and one task simply
        // gone. So the run fails, names the task, and says which half-built database to
        // remove by hand — this module drops nothing on its own.
        throw new QueueEncodingError(
          `task ${task && task.id} could not be written into ${target}, so nothing was renamed and ` +
            `${database} is untouched. Remove the half-built ${target} by hand once the task is understood.`,
          { cause: err },
        )
      }
      carriedTasks += 1
    }
    for (const row of approvalRows) {
      await opened.execSql(APPROVAL_INSERT_SQL, [
        row.id,
        row.status,
        row.dispatched_at ?? null,
        row.returned_note ?? null,
        row.merge_receipt ?? null,
      ])
      carriedApprovals += 1
    }
  } finally {
    if (opened && typeof opened.stop === 'function') await opened.stop()
  }

  await adminSql(renameStatement(database, archive), [])
  try {
    await adminSql(renameStatement(target, database), [])
  } catch (err) {
    // The old database is out of the way and the new one did not take its place: put the old
    // name back, so what the daemon connects to is the database it had before this ran.
    await adminSql(renameStatement(archive, database), [])
    throw new QueueEncodingError(
      `${target} could not take the name ${database}; the original database was put back under its own name and nothing was lost`,
      { cause: err },
    )
  }

  log(`${database} is now ${UTF8}; the previous database is kept as ${archive}`)
  return {
    ...base,
    applied: true,
    reason: 'migrated',
    carried: { tasks: carriedTasks, approvals: carriedApprovals },
    snapshotPath,
  }
}
