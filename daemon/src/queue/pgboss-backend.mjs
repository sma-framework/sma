/**
 * pgboss-backend.mjs — the durable QueueAdapter over pg-boss.
 *
 * WHAT: a certified QueueAdapter (the adapter.mjs contract) whose task truth lives
 * ENTIRELY in Postgres via pg-boss. The daemon holds NO task state — kill it at any
 * line and no task is lost. This backend re-runs the SAME
 * `queueAdapterContractSuite` the in-memory reference passes: a backend
 * that passes the suite IS a conforming adapter; nothing else certifies it.
 *
 * WHERE THE QUEUE DB LIVES: a **LOCAL Postgres owned by the
 * daemon host** (Homebrew postgresql@16 on the Mac mini for the pilot). The connection
 * string comes from config `queueUrl`. A production application's `DATABASE_URI`
 * MUST NEVER appear in this file or its config — SMA is a standalone product, and
 * worker churn (fetch polling, touch ticks) never belongs in a production medical CRM.
 *
 * PER-LANE QUEUES: pg-boss `fetch` cannot filter by payload, and a
 * `fetch` IS a claim — one shared queue would force fetch-then-unfetch to honour lane
 * eligibility. So each lane is its OWN queue `sma.task.<lane>` (prod / research /
 * paperwork / forge), sharing one deadLetter `sma.task.dead`. claimNext fetches the
 * eligible lanes in a documented stable order (prod → research → paperwork → forge), so
 * a claimed task is BY CONSTRUCTION one an open worker can run. The same property is what
 * carries the batch: the REQUEST of a batch is sent to a queue of its own (BATCH_PARENT_QUEUE)
 * which claimNext never fetches, so «a worker is never handed the request» needs no filter.
 *
 * READ-ONLY-BY-CONTRACT list(): the roster feed + the flow
 * timestamps need to enumerate jobs with their payloads across states — which no
 * pg-boss API exposes. So list() is ONE read-only SELECT over the pg-boss job tables
 * via an injected `execSql` (the SAME DI seam as cas.mjs), and taskId→job resolution
 * for touch/complete/fail is likewise a read-only SELECT. This backend NEVER UPDATEs
 * boss tables directly — every MUTATION goes through the boss API (send / fetch /
 * touch / complete / fail). stats() stays API-first via getQueueStats summed over the
 * four lane queues — under the LIBRARY's key names (QUEUE_STATS_KEYS), and only for the three
 * things the library actually counts; finished and broken work is counted where it is
 * recorded, in the attempt journal. The ONE table this backend does write is not pg-boss's: the daemon's
 * own approval row (approval-store.mjs), provisioned at start() and stamped at complete()
 * so the front's approve/return have a durable state to compare-and-set against.
 *
 * ...AND THAT ROW IS READ BACK. Writing it was only ever half the sentence: for as long as
 * list() read the job table alone, work that had finished and was waiting for a person was
 * indistinguishable from work a person had already accepted, so the screen that shows what
 * is waiting had nothing to draw and its counter said zero while the pile grew. list() now
 * joins the approval row onto the job it belongs to, and stats() asks a second statement
 * for the count `getQueueStats` cannot know. Both are FAIL-OPEN: a side table that will not
 * answer costs the rows their waiting-for-a-person reading, never the rows themselves.
 *
 * STATELESSNESS NOTE: the only in-process state is a SOFT coalesce-display counter
 * (how many times a still-pending item was re-requested). It is NOT task truth —
 * losing it on a restart resets pending counts to 1 and loses NO task. All
 * authoritative state (existence, status, retries, timestamps) lives in pg-boss.
 *
 * LIVENESS (Paperclip contract, falls out of the library): every send carries
 * `expireInSeconds` (derived from `expireMs`, default 900s) + `retryLimit`/
 * `retryBackoff` — a silent worker's job expires and pg-boss requeues it («замолчал —
 * задача вернулась в очередь»). The explicit sweep (liveness.mjs) is the belt-and-
 * suspenders audit on top.
 *
 * LOGGING: task ids + masked errors ONLY — never task payloads, never the
 * connection string (agent-run-queue maskSecrets discipline).
 *
 * DI: `boss` (a pg-boss instance or a fake), `execSql`, `clock`, and `ledgerDir` are
 * all injectable. When `boss` is injected NO connection is opened and pg-boss is never
 * imported — EVERY unit test runs against a fake. pg-boss is imported LAZILY inside
 * start() only when we own the connection.
 *
 * ═══════ THE STATUS CHANGES ARE ROUTED THROUGH THE STATE MACHINE ══════════════════════
 * Until 2026-08-05 nothing in production called `applyTransition`: the fleet's fine
 * vocabulary was a formal reference the tests held the code to, and the four coarse queue
 * statuses moved without ever passing it. Now each of the three mutations names the fine
 * transition it stands for and mints it through the machine, whose result supplies the two
 * stamp fields only it can supply — `idempotencyKey` and `stateMachineVersion` — which then
 * ride onto the durable attempt row:
 *
 *   claimNext  READY   -> CLAIMED    (dispatcher)  the fetch IS the claim
 *   complete   RUNNING -> PRODUCED   (worker)      the work exists and is certified
 *   fail       RUNNING -> RETRYABLE  (supervisor)  the attempt did not produce
 *
 * WHAT IS DELIBERATELY EXEMPT, AND WHY — stated here rather than left as silence:
 *   - RETRYABLE -> READY and RETRYABLE -> DEAD_LETTER. Which of the two a failure takes is
 *     decided INSIDE pg-boss by `retryLimit` during the very `boss.fail` call above, and
 *     this backend never observes the branch. Naming one would be a claim about something
 *     it did not see.
 *   - PRODUCED -> VERIFYING -> ACCEPTED. `complete()` is not acceptance: it hands the task
 *     to a human (`markAwaitingApproval`), and the front's approve path is where a
 *     disposition appears. Routing a completion through ACCEPTED would need the fleet's
 *     invariant 1's receipt AND authorized disposition, and manufacturing the disposition
 *     here is exactly the self-certification that invariant exists to forbid.
 *
 * THE MACHINE IS CONSULTED, THE QUEUE IS NOT GATED ON IT. A refusal is LOGGED by name and
 * the stamp is then absent from the row; the durable mutation still happens. That is
 * deliberate: the queue is the coarse truth, and an audit layer that could strand a
 * finished task by refusing to record it would be a worse fault than the one it detects.
 * The refusal text carries state names, actor names and ids only (state-machine.mjs's own
 * law), so it is safe in a log line.
 */

import {
  validateTask,
  validateWords,
  isBatchParent,
  batchHeldOf,
  waveAddressOf,
  waveHeldOf,
  batchDecisionsOf,
  DEFAULT_EXPIRE_MS,
  // The attempt border and the queue's own last word about a row it will not hand out again —
  // one name for both backends, for the same reason the token above is one name.
  retryLimitOf,
  ATTEMPTS_EXHAUSTED,
  FAIL_REASONS,
  NoReceiptError,
  InvalidFailReasonError,
  UnknownTaskError,
  // The fencing token of an attempt: minted, judged and named in ONE place for both backends
  // — a second expression here would be a second promise, and the two would disagree in
  // silence the first time either was touched.
  mintAttemptToken,
  attemptTokenIsStale,
  refuseStaleAttempt,
} from './adapter.mjs'
import {
  QueueEncodingError,
  describeEncoding,
  describeUntranslatable,
  readQueueEncoding,
  UTF8,
} from './encoding.mjs'
import { countTerminalOutcomes, recordAttempt } from './attempt-ledger.mjs'
import { APPROVAL_TABLE, AWAITING_APPROVAL, ensureApprovalTable, markAwaitingApproval } from './approval-store.mjs'
import { applyTransition } from './state-machine.mjs'
import { defaultEnvelope } from './capability-envelope.mjs'
import { attemptIdFor } from '../front/journal.mjs'

/** The four execution lanes, in the documented stable claim order. */
export const TASK_QUEUE_LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/** Shared dead-letter queue for exhausted retries → the roster's red «не справился» card. */
export const DEAD_LETTER_QUEUE = 'sma.task.dead'

/**
 * THE QUEUE THE REQUEST OF A BATCH LIVES IN — and the reason it is a queue of its own rather
 * than a flag on a lane row.
 *
 * A batch parent may never be handed to a worker (adapter.mjs states why). This backend cannot
 * enforce that with a filter: `fetch` IS the claim, it cannot select on the payload, and a job
 * recognised as a parent AFTER the fetch is already checked out — un-fetching it is exactly the
 * dance the per-lane design exists to avoid. So the parent is not put where a fetch can reach
 * it. `claimNext` walks the LANE queues and nothing else, which makes «the parent is never
 * claimed» a property of the layout instead of a check somebody could later delete.
 *
 * It is read back with the lanes in list() — a reader has to see the request to draw the batch
 * — and deliberately NOT summed in stats(), which counts work waiting for a worker.
 */
export const BATCH_PARENT_QUEUE = 'sma.batch'

/**
 * WHERE A PIECE OF A BATCH WAITS FOR ITS TURN — in the job row it already has, deferred to a
 * date no clock will reach, and moved to «now» by `releaseBatchTurns` when its turn comes.
 *
 * A DATE RATHER THAN A DELAY, deliberately: `start_after` is what a person reads in the table
 * when he asks why a piece is sitting there, and «2999» says «somebody is holding this» in a
 * way «now + 3153600000s» never would. The value is not a deadline and is never waited for —
 * a held piece is released by the turn rule or by the owner's word, never by time passing.
 */
export const HELD_UNTIL = '2999-01-01T00:00:00.000Z'

/**
 * THE KEYS THIS BACKEND READS OFF `getQueueStats`, WRITTEN DOWN ONCE AND CHECKED AGAINST THE
 * REAL LIBRARY.
 *
 * `stats()` used to ask pg-boss for `queued`, `created`, `active`, `claimed`, `completed` and
 * `failed` — OUR vocabulary, spoken at a library that answers in its own: `deferredCount`,
 * `queuedCount`, `activeCount`, `totalCount`. Six names, none of them in the reply, every one
 * of them resolving to `undefined ?? 0`. The board therefore showed a confident zero for work
 * that had been done all day, and a wrong number does not look wrong — «сделано: 0» reads as
 * «сегодня ничего не сделали», which is why nobody went looking for a bug.
 *
 * The map is EXPORTED so a test can hold it against the statement pg-boss actually sends to
 * the database (`pg-boss/src/plans.js` → `getQueueStats`, whose `as "…"` aliases ARE the keys
 * of the returned row). A hand-written list checked against another hand-written list is two
 * copies of the same belief; this one is checked against the library's own SQL, so the day
 * pg-boss renames a column the test fails instead of the board.
 *
 * WHAT IS DELIBERATELY ABSENT: there is no entry for `completed` or `failed`, because pg-boss
 * counts neither. Those two come from the attempt journal (attempt-ledger.mjs), which does.
 */
export const QUEUE_STATS_KEYS = Object.freeze({
  queued: 'queuedCount',
  claimed: 'activeCount',
  total: 'totalCount',
})

/**
 * The names this backend must NEVER ask pg-boss for again — the exact six it used to ask for.
 * Kept beside the map it replaced so the regression has a name and a test, rather than living
 * only in a commit message nobody reads.
 */
export const QUEUE_STATS_KEYS_NEVER = Object.freeze([
  'queued',
  'created',
  'active',
  'claimed',
  'completed',
  'failed',
])

/**
 * THE SESSION SPEAKS UTF-8, AND IT HAS TO BE SAID OUT LOUD. node-postgres decodes every byte
 * it receives as UTF-8 unconditionally, but it never ASKS the server for an encoding: with
 * no `client_encoding` in the connection the session runs on whatever the CLUSTER'S
 * CONFIGURATION decides. Where that is not UTF-8 — a cluster left at its own defaults over a
 * database in the Windows ANSI code page — the server sends WIN1252 bytes and the driver
 * reads them as UTF-8, so accented text comes back mangled on a path that never errors.
 *
 * MEASURED, NOT ASSUMED: on the reference WIN1252 database the session already reported
 * UTF8, because that cluster is configured that way. Which is the whole argument for saying
 * it explicitly — it was a property of one machine's configuration, not a guarantee. Asked
 * for by name, the SERVER transcodes, and text stored in an older encoding arrives intact
 * on any cluster.
 */
const CLIENT_ENCODING = Object.freeze({ client_encoding: UTF8 })

/** `sma.task.<lane>` — one durable queue per lane. */
const laneQueue = (lane) => `sma.task.${lane}`

/** Where a task is SENT: its own lane, unless it is the request of a batch (see above). */
const queueFor = (task) => (isBatchParent(task) ? BATCH_PARENT_QUEUE : laneQueue(task.lane))

/** Every queue a READ has to look in: the four lanes plus the batch requests. */
const readQueues = () => [...TASK_QUEUE_LANES.map(laneQueue), BATCH_PARENT_QUEUE]

/** pg-boss job.state → our QueueAdapter status vocabulary. */
const STATE_TO_STATUS = Object.freeze({
  created: 'queued',
  retry: 'queued',
  active: 'claimed',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
})

/**
 * The approval-row statuses that mean «this task still owes a PERSON a word», and the ONLY
 * ones allowed to overrule what pg-boss says about a job.
 *
 * The side table's full vocabulary is wider — a decided task reads `approved` or
 * `returned`, and `approving` is the in-flight claim of a decision being made. Those two
 * decided values are deliberately NOT surfaced: the adapter contract has a closed
 * five-status vocabulary, and a row answering `approved` would leave it — vanishing from
 * every screen that filters by the five, including the one that shows the night's finished
 * work. What a decision produced is the approval path's own subject, and the front reads it
 * from the row it CASes; the queue's job is the coarse truth, and the coarse truth about a
 * decided task is that pg-boss finished it.
 */
const AWAITING_APPROVAL_STATUSES = Object.freeze([AWAITING_APPROVAL, 'approving'])

/**
 * Module-scoped guard against duplicate createQueue / worker init for a real (owned)
 * connection in one process (agent-run-queue init discipline). Keyed by queueUrl.
 * Bypassed entirely when `boss` is injected (tests always inject).
 */
const startedUrls = new Set()

/** Mask a connection string out of any error text before it reaches a log. */
function maskError(err) {
  const s = err && err.message ? String(err.message) : String(err)
  return s.replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, 'postgres://[masked]')
}

/**
 * attemptNumberOf(data, retryCount, {unclaimed}) → the attempt now in flight, or NaN.
 *
 * THE ONE PLACE THE NUMBER IS COMPUTED. `claimNext`, `mapRow` and `resolveActiveJob` all call
 * it and none of them keeps an expression of its own — the promise this comment used to make
 * and did not keep, which is how the three came to disagree in the first place.
 *
 * THE COUNT IT READS IS THE ONE TAKEN WHEN THE WORK WAS CLAIMED, not the one the queue holds
 * while the work is being finished. The live retry count is the wrong source at the moment of
 * a mutation, and the reason is a record that exists: between the claim and the finish a lease
 * can lapse and the queue can hand the row out again, so the counter moves under an attempt
 * that never noticed. The tick had taken its number at the claim and carried it unchanged;
 * this backend recomputed from the moved counter — and one physical try landed in the audit
 * trail as two, with one attempt number carrying both `failed` and `completed`. The claim
 * count therefore rides in the job's own payload (`claimedAtRetry`, written by stampClaimedAt
 * beside the claim time), and both writers read that one value.
 *
 * AN ABSENT MARK IS AN ABSENCE, NEVER A LICENCE TO INVENT A NUMBER. A job claimed before the
 * mark existed — or one whose fail-open stamp did not land — falls back to the live count,
 * which is exactly what such a row recorded before this existed: unchanged behaviour rather
 * than a guess.
 *
 * `unclaimed` says «no attempt is in flight under this mark» and is the one case where the mark
 * must be ignored, because there it belongs to the try that came BEFORE. Two callers mean it:
 * the fetch itself, whose payload still carries the previous attempt's mark (stampClaimedAt
 * writes the new one immediately after), and a row that lost its lease and is waiting to be
 * handed out again — whose next try is the live count plus one, which is what «вернулась в
 * очередь, попытка +1» means on a screen. Reading the mark in either place would report a
 * re-issued job as attempt one forever.
 *
 * NaN when the caller could not read the job's payload — an attempt number that was not
 * observed is left absent rather than defaulted to 1, because a wrong number on a durable
 * audit row is worse than a missing one.
 */
function attemptNumberOf(data, retryCount, { unclaimed = false } = {}) {
  if (!data || typeof data !== 'object') return NaN
  const stamped = unclaimed ? undefined : data.claimedAtRetry
  const retries = stamped === undefined || stamped === null ? retryCount : stamped
  return (Number(data.attempt) || 1) + (Number(retries) || 0)
}

/**
 * tokenOfJob(job) → THE FENCING TOKEN THE ROW ITSELF CARRIES, or null.
 *
 * The one reader of that field, so «where the token is kept» is stated once. Null covers two
 * different absences on purpose, because both mean the same thing to a caller: a row claimed
 * before this mark existed, and a row whose stamp did not land. Neither is a licence to invent
 * a token, and neither may be a reason to refuse the worker holding the attempt — an absence is
 * an absence, exactly as it is for the attempt number beside it.
 */
function tokenOfJob(job) {
  const data = job && job.data && typeof job.data === 'object' ? job.data : null
  const token = data && typeof data.attemptToken === 'string' ? data.attemptToken : ''
  return token === '' ? null : token
}

/** The pg-boss states in which NO attempt is in flight: the row is waiting to be handed out,
 *  so the claim mark in its payload describes the try that already ended. */
const WAITING_STATES = Object.freeze(['created', 'retry'])

/**
 * THE LIBRARY'S OWN WORD when it closes a row whose lease ran out and whose re-issues are
 * spent. Copied here from its expiry plan LITERALLY (`failJobsByTimeout` writes
 * `{"value":{"message":"job timed out"}}`), because that is the only handle the row gives us:
 * it carries no `reason`, which is the field every reader of ours takes a cause from.
 *
 * It is a string of THEIRS, so it is pinned in one place and read exactly once (see
 * exhaustedReasonOf). If a future version of the library changes the wording, this stops
 * matching and such rows go back to saying nothing — which is what they said before, rather
 * than something wrong.
 */
const LIBRARY_TIMEOUT_MESSAGE = 'job timed out'

/**
 * transitionStamp({from, to, actor, taskId, attempt, log}) → `{idempotencyKey,
 * stateMachineVersion}` for a status change routed through the fleet state machine, or
 * `null` when it could not be minted.
 *
 * Null has exactly two causes and both are honest absences: the attempt number was not
 * observable (no truthful `attemptId`, and `idempotencyKey` refuses an invented one), or
 * the machine REFUSED the transition — which is logged by name and never swallowed.
 */
function transitionStamp({ from, to, actor, taskId, attempt, log }) {
  if (!Number.isFinite(attempt)) return null
  const result = applyTransition({
    state: from,
    to,
    actor,
    taskId,
    attemptId: attemptIdFor(taskId, attempt),
    attempt,
  })
  if (!result.applied && !result.alreadyApplied) {
    log(`transition refused ${from}->${to} task=${taskId}: ${result.refusal}`)
    return null
  }
  return { idempotencyKey: result.idempotencyKey, stateMachineVersion: result.stateMachineVersion }
}

/**
 * createPgBossQueue(opts) — a QueueAdapter over pg-boss.
 *
 * @param {{queueUrl?:string, boss?:object, execSql?:Function, clock?:Function|number,
 *          expireMs?:number, ledgerDir?:string, log?:Function}} [opts]
 * @returns {object} a QueueAdapter (+ start/stop lifecycle)
 */
export function createPgBossQueue({
  queueUrl,
  boss,
  execSql,
  clock = Date.now,
  expireMs = DEFAULT_EXPIRE_MS,
  ledgerDir,
  log: logLine,
} = {}) {
  const ownBoss = !boss
  let bossInstance = boss || null
  const now = () => (typeof clock === 'function' ? clock() : clock)
  const expireInSeconds = Math.max(1, Math.ceil(expireMs / 1000))
  /** SOFT display counter (taskId -> coalesce count) — NOT task truth (see header). */
  const coalesce = new Map()
  /** What the database answered about its encoding at start(); null until then / unknown. */
  let encodingInfo = null

  // Lazy default execSql over a pg Pool for real use; tests inject a fake execSql and
  // never touch this path (pg is never imported).
  let poolPromise = null
  async function defaultExecSql(sql, params) {
    if (!queueUrl) throw new Error('list()/resolve require queueUrl or an injected execSql')
    if (!poolPromise) {
      poolPromise = import('pg').then(({ default: pg }) => {
        const pool = new pg.Pool({ connectionString: queueUrl, ...CLIENT_ENCODING })
        // AN IDLE CLIENT'S DEATH IS AN EVENT, NOT A VERDICT. When Postgres goes away
        // (a restart, the machine shutting down under us), the pool EMITS 'error' for the
        // idle connection that died — and an EventEmitter with no listener turns that emit
        // into a throw on the event loop. Measured 27.08.2026: that throw was the whole
        // daemon's death — «Connection terminated unexpectedly», no line in its own voice,
        // and a crash dump in a log file named for another day. The pool replaces dead idle
        // clients by itself; the next query gets a fresh one or fails in ITS caller's hands,
        // where every caller already answers for a bad queue. So: name it, and live.
        pool.on('error', (err) => log(`pool error: ${maskError(err)} — простаивавшее соединение очереди умерло, пул заменит его сам`))
        return pool
      })
    }
    const pool = await poolPromise
    return pool.query(sql, params)
  }
  const runSql = execSql || defaultExecSql

  const log = typeof logLine === 'function' ? logLine : (msg) => console.log(`[SmaQueue] ${msg}`) // ids only, never payloads

  async function start() {
    if (ownBoss) {
      if (startedUrls.has(queueUrl)) return true // duplicate in-process init guard
      const { default: PgBoss } = await import('pg-boss') // LAZY — only when we own the connection
      // pg-boss hands its whole option object to `pg.Pool`, so the session encoding above
      // reaches the queue's own connections too — one rule for every connection we open.
      bossInstance = new PgBoss({ connectionString: queueUrl, ...CLIENT_ENCODING })
      bossInstance.on('error', (err) => log(`boss error: ${maskError(err)}`))
      await bossInstance.start()
    } else if (typeof bossInstance.on === 'function') {
      bossInstance.on('error', (err) => log(`boss error: ${maskError(err)}`))
    }
    // Idempotent queue provisioning: the shared dead-letter FIRST — pg-boss v11 rejects a
    // lane queue whose deadLetter target does not exist yet (the pilot fresh-boot
    // finding) — then the per-lane queues.
    await bossInstance.createQueue(DEAD_LETTER_QUEUE)
    for (const lane of TASK_QUEUE_LANES) {
      await bossInstance.createQueue(laneQueue(lane), { deadLetter: DEAD_LETTER_QUEUE })
    }
    // The batch requests: provisioned like a lane queue, fetched like none of them. Nothing
    // is ever expected to fail here (no worker reaches it), and it still shares the one dead
    // letter — one rule for every queue this backend owns beats an exception nobody can date.
    await bossInstance.createQueue(BATCH_PARENT_QUEUE, { deadLetter: DEAD_LETTER_QUEUE })
    // The daemon's OWN approval row (approval-store.mjs) — provisioned in the same breath
    // as the queues, because the front's approve/return CAS against it from the first
    // request. Fail-open by construction: a database that refuses the CREATE logs and
    // boots anyway (the queue itself is what a boot cannot do without).
    await ensureApprovalTable(runSql, { log })
    // WHAT ENCODING IS THIS DATABASE? Asked once, at boot, and answered in words when the
    // answer is not UTF8: a database created by a Windows `initdb` default cannot store a
    // task title written in Cyrillic, and the founder deserves to learn that from a sentence
    // with a command in it rather than from a driver error months later. NEVER fatal — a
    // daemon that has been running on such a database must not stop booting because the
    // product learned to notice.
    encodingInfo = await readQueueEncoding(runSql)
    for (const line of describeEncoding(encodingInfo) ?? []) log(line)
    if (ownBoss) startedUrls.add(queueUrl)
    return true
  }

  async function stop() {
    if (ownBoss && bossInstance && typeof bossInstance.stop === 'function') {
      await bossInstance.stop()
      startedUrls.delete(queueUrl)
    }
    // The lazy pool above is OURS, and stopping pg-boss does not touch it. A stop() that
    // leaves it open hands the caller a lie: it has awaited the shutdown and still holds
    // live connections to the database. That is not theoretical — it is why the encoding
    // migration could never finish. The migration opens the NEW database through this
    // adapter (start() provisions the approval table, and that first execSql is what
    // creates the pool), stops it, then renames it — and Postgres refuses to rename a
    // database while any connection remains. Every run ended in the rollback branch with
    // «is being accessed by other users», so a queue created with the wrong encoding could
    // never be moved off it.
    //
    // The handle is DROPPED, not merely closed, so a later execSql opens a fresh pool
    // rather than awaiting an ended one: stop() stays the reversible operation the rest of
    // this file assumes it is.
    if (poolPromise) {
      const closing = poolPromise
      poolPromise = null
      try {
        const pool = await closing
        await pool.end()
      } catch {
        // a pool that never finished opening, or one already ended: nothing left to close
      }
    }
    return true
  }

  async function enqueue(task) {
    const norm = validateTask(task) // DoR / forge / allowlist gate — same path as the memory backend
    // A PIECE OF A BATCH ARRIVES HELD, and is released when its turn comes (releaseBatchTurns).
    // The reason it cannot be filtered at the fetch instead is the same one that put the
    // request row in a queue of its own: the fetch IS the claim, so a piece recognised as «not
    // its turn» after the fetch has already been handed out and there is nothing left to
    // refuse. Held here means `start_after` in the future — pg-boss's own scheduling column,
    // whose `AND start_after < now()` is part of every fetch — so the row is fully VISIBLE to
    // every reader (a screen still draws the whole assembly) and reachable by no worker.
    const heldItem = !isBatchParent(norm) && typeof norm.batchId === 'string'
    let jobId
    try {
      jobId = await bossInstance.send(queueFor(norm), norm, {
        singletonKey: norm.id, // Pattern 5: one pending entry per item (coalescing)
        priority: norm.priority,
        // NOTHING OF A BATCH IS REPEATED BY ITSELF. The library's own retry is exactly the
        // silent repetition the owner forbade: a piece that broke must STOP its assembly and
        // ask him, and a queue quietly running it again two more times is the loop that cost a
        // day on 12.08.2026. Ordinary work keeps the retries it has always had.
        //
        // THE NUMBER IS NO LONGER THIS FILE'S OWN. It lived here as a literal, which meant the
        // reference backend — the executable spec every other backend is written against — could
        // not see the rule and kept no border at all: this queue refused past two re-issues, that
        // one handed the same row back for ever, and the suite asked neither. One name now, and
        // this call is where the durable half of it MAPS onto the library's own `retry_limit`.
        retryLimit: retryLimitOf(norm),
        retryBackoff: true,
        expireInSeconds, // liveness: silent worker → job expires → requeue
        ...(heldItem ? { startAfter: HELD_UNTIL } : {}),
      })
    } catch (err) {
      // A title in a language the database's encoding does not have is a PROPERTY OF THE
      // DATABASE, not a bad request, and the driver's byte-sequence message says nothing a
      // person can act on. Anything else is re-thrown untouched.
      const said = describeUntranslatable(err, encodingInfo ?? {})
      if (!said) throw err
      throw new QueueEncodingError(said, { cause: err })
    }
    if (jobId == null) {
      // Coalesced onto an existing pending/active entry — bump the soft display counter.
      const count = (coalesce.get(norm.id) ?? 1) + 1
      coalesce.set(norm.id, count)
      return { id: norm.id, coalesced: true, coalesceCount: count }
    }
    coalesce.set(norm.id, 1)
    return { id: norm.id, coalesced: false, coalesceCount: 1 }
  }

  /**
   * READ-ONLY resolution: find the active pg-boss job carrying this task id so the API
   * mutation (touch/complete/fail) can address it by (queue, jobId). Stateless — no
   * in-process taskId→job map (that would be lost on a kill). The `state = 'active'`
   * marker also lets the fake execSql distinguish this query from list().
   *
   * It also reads `data` and `retry_count` so complete/fail can stamp the
   * attempt row with the number and the lane THE QUEUE ITSELF holds, rather than with a
   * value the caller supplied about itself. Both are optional on the returned object: a
   * seam that does not surface them leaves `attempt` NaN and `lane` undefined, and the
   * stamp is then simply not written.
   */
  async function resolveActiveJob(taskId) {
    const res = await runSql(
      `SELECT id, name, data, retry_count FROM pgboss.job WHERE data->>'id' = $1 AND state = 'active' ORDER BY started_on DESC LIMIT 1`,
      [taskId],
    )
    const rows = res && Array.isArray(res.rows) ? res.rows : []
    const row = rows[0] || null
    if (!row) return null
    const data = row.data || null
    return {
      ...row,
      attempt: attemptNumberOf(data, row.retry_count),
      lane: data && typeof data.lane === 'string' ? data.lane : undefined,
    }
  }

  /**
   * The stamp fields derivable from the JOB ROW at the moment of a mutation: the attempt
   * number, the transition's key and version, and the digest of the lane envelope the work
   * ran under (`recordAttempt` hashes the envelope itself and keeps only the digest).
   *
   * FOUR OF THE SEVEN STAMP FIELDS ARE ABSENT HERE, AND THIS IS THE ONE PLACE THAT SAYS WHY
   * (fleet invariant six — the stamp is fixed at creation, so never invent a value):
   *   - `memorySnapshotHash` — this backend does not know which memory corpus the worker
   *     read. The tick does, because it is what handed the worker its work, and it stamps
   *     the digest on its own ledger row (loop.mjs). Re-deriving it here would mean
   *     guessing a corpus directory from a queue row.
   *   - `policyVersion` — the daemon's routing policy carries no version. The only
   *     versioned policy artifact in the product is the distilled voice's `policyVersion`
   *     in the exam score ledger, which is a different thing; stamping it here would
   *     fabricate provenance.
   *   - `harnessVersion` — the harness is the agent CLI the worker is spawned under, and
   *     nothing in this process observes its version.
   *   - `planHash` — a task carries a title, an acceptance sentence and a lane. There is
   *     no plan document, so there is nothing to hash.
   */
  function jobStamp(job, { from, to, actor, taskId }) {
    if (!job) return {}
    return {
      ...(Number.isFinite(job.attempt) ? { attempt: job.attempt } : {}),
      ...(transitionStamp({ from, to, actor, taskId, attempt: job.attempt, log }) || {}),
      ...(job.lane ? { capabilityEnvelope: defaultEnvelope(job.lane) } : {}),
    }
  }

  /**
   * stampClaimedAt(jobId) — record WHEN THIS ATTEMPT WAS TAKEN, beside the lease clock instead
   * of on top of it.
   *
   * `started_on` is this backend's lease: the renewal has to restamp it, because the library
   * offers no renewal call (see touch()). It was also the only answer to «when was this work
   * taken» — so a task that had been running for an hour reported a couple of minutes, then a
   * couple of minutes again, and the screen's duration was not a measurement of anything. The
   * moment of the claim therefore rides in the job's own payload, written the way assignWorker
   * already writes the executing worker: no new column, no schema migration over a queue the
   * library owns.
   *
   * WRITTEN ONCE PER ATTEMPT, never twice. The condition refuses to touch a value that already
   * belongs to the attempt in flight — a re-claim of a live attempt cannot move the clock a
   * screen is measuring from — while a task that lost its lease and was fetched again gets the
   * clock of the NEW attempt, which is what «идёт столько-то» means. `retry_count` is the
   * queue's own attempt marker, so the two agree by construction.
   *
   * FAIL-OPEN: a database that refuses this write costs the row its exact claim time, never the
   * claim — mapRow then falls back to the lease clock, which is what every row recorded before
   * this existed carries.
   *
   * ═══ THE FENCING TOKEN RIDES THE SAME STAMP, AND FOR THE SAME REASONS ═══
   *
   * IT LIVES IN THE PAYLOAD, not in a Map of this process. A register of live tokens in memory
   * would be the backend's own version of the daemon state this product has already outlawed:
   * a restart would forget every token, and every worker alive at that moment would be refused
   * the right to close work it really did. The payload survives a restart, and it survives the
   * queue's own re-issue (which DELETEs the row and INSERTs it back with the data copied).
   *
   * IT IS RESTAMPED BY THE SAME GUARD, so «a new token per hand-out» costs no second statement
   * and cannot drift from «a new claim time per hand-out»: the guard fires exactly when the
   * queue's own try counter says this is a different attempt from the one the mark describes.
   *
   * IT RETURNS THE TOKEN THE ROW NOW CARRIES, not the one this process minted — and that is the
   * fail-open half. If the write did not land, the row still carries what it carried (nothing,
   * or the previous attempt's token), and handing the claimer a token no row knows about would
   * refuse the very worker that holds the attempt: a database hiccup would then cost the WORK,
   * not just its mark. Null says «this row has no token of mine to give».
   */
  async function stampClaimedAt(jobId, attemptToken) {
    try {
      const res = await runSql(
        `UPDATE pgboss.job
            SET data = data || jsonb_build_object('claimedAt', $2::bigint, 'claimedAtRetry', retry_count, 'attemptToken', $3::text)
          WHERE id = $1 AND state = 'active'
            AND (NOT (data ? 'claimedAt') OR (data->>'claimedAtRetry') IS DISTINCT FROM retry_count::text)
        RETURNING data->>'attemptToken' AS attempt_token`,
        [jobId, now(), attemptToken],
      )
      const rows = res && Array.isArray(res.rows) ? res.rows : []
      const written = rows[0] ? rows[0].attempt_token : null
      return typeof written === 'string' && written !== '' ? written : null
    } catch (err) {
      log(`claim time not recorded for job ${jobId}: ${maskError(err)}`)
      return null
    }
  }

  /**
   * releaseBatchTurns() — before any fetch, put the pieces whose turn it now is back on the
   * clock, and leave every other piece of a batch held.
   *
   * DERIVED AT EVERY CLAIM, NEVER REMEMBERED. Whose turn it is is a function of the rows —
   * `batchHeldOf`, the one place that rule lives — so a daemon that was killed mid-batch, or a
   * piece finished by another machine, is simply read correctly on the next pass instead of
   * being reconciled. The statement itself is idempotent: a piece already on the clock is not
   * matched by it.
   *
   * FAIL-OPEN. A release that cannot run costs this pass its batch progress — the next claim
   * tries again — and never the claim of ordinary work, which is why it can never throw here.
   */
  async function releaseBatchTurns(rows) {
    const items = rows.filter((r) => r && r.batchId && !isBatchParent(r) && r.status === 'queued')
    if (items.length === 0) return
    const held = batchHeldOf(rows)
    for (const item of items) {
      if (held.includes(item.id)) continue
      try {
        await runSql(
          `UPDATE pgboss.job SET start_after = now()
             WHERE data->>'id' = $1 AND state = 'created' AND start_after > now()`,
          [item.id],
        )
      } catch (err) {
        log(`batch piece ${item.id} not released: ${maskError(err)}`)
      }
    }
  }

  /**
   * applyWaveHolds(rows, holds) — put the waiting rows of a STOPPED echelon out of every
   * worker's reach, and put the rows of a resumed one back.
   *
   * SAME MECHANISM AS THE BATCH TURN, for the same reason: the fetch IS the claim, so a row
   * recognised as stopped after it has already been handed out and there is nothing left to
   * refuse with. So a stopped row is deferred to the date no clock reaches, exactly like a piece
   * of a batch waiting its turn — visible to every reader, reachable by no worker.
   *
   * THE OTHER HALF IS THE RELEASE, and it is not optional: without it, lifting a stop would
   * leave the rows deferred forever and the founder would watch his own «продолжай» do nothing.
   * A row a BATCH is holding is left alone here — two rules must not undo each other, and that
   * one has its own release directly above.
   *
   * FAIL-OPEN, like its twin: a statement that cannot run costs this pass its stop and never the
   * claim of ordinary work.
   */
  async function applyWaveHolds(rows, holds) {
    const governed = rows.filter((r) => r && r.status === 'queued' && !isBatchParent(r) && waveAddressOf(r))
    if (governed.length === 0) return
    const stopped = new Set(waveHeldOf(rows, holds))
    const batchHeld = new Set(batchHeldOf(rows))
    for (const r of governed) {
      try {
        if (stopped.has(r.id)) {
          await runSql(
            `UPDATE pgboss.job SET start_after = $2
               WHERE data->>'id' = $1 AND state = 'created' AND start_after <= now()`,
            [r.id, HELD_UNTIL],
          )
        } else if (!batchHeld.has(r.id)) {
          await runSql(
            `UPDATE pgboss.job SET start_after = now()
               WHERE data->>'id' = $1 AND state = 'created' AND start_after > now()`,
            [r.id],
          )
        }
      } catch (err) {
        log(`wave hold not applied to ${r.id}: ${maskError(err)}`)
      }
    }
  }

  /**
   * settleTurns(holds) — ONE read of the rows, both withholding rules applied to it.
   *
   * The two rules ask the same question of the same rows («may this row be handed out now»), and
   * reading the queue twice per claim to answer it twice would be a second answer that can drift
   * from the first between the reads. Fail-open at the read: an unreadable queue costs this pass
   * its turn-keeping and never the claim itself.
   */
  async function settleTurns(holds) {
    let rows
    try {
      rows = await list({})
    } catch (err) {
      log(`turn not computed: ${maskError(err)}`)
      return
    }
    await releaseBatchTurns(rows)
    await applyWaveHolds(rows, holds)
  }

  async function claimNext(workerId, { lanes, holds } = {}) {
    // lanes:[] → nothing eligible; return null WITHOUT any fetch/mutation.
    if (Array.isArray(lanes) && lanes.length === 0) return null
    // WHOSE TURN IS IT, AND WHOSE ECHELON HAS BEEN STOPPED — asked BEFORE the fetch, because
    // after it there is nothing left to refuse. The pieces of a batch arrive held (see enqueue);
    // this is where the one whose turn has come stops being held, and where the rows of a wave
    // its owner stopped start being held.
    await settleTurns(holds)
    // LANE QUEUES AND NOTHING ELSE. That is also what keeps the request of a batch out of a
    // worker's hands: it was never sent to a lane, so no ordering of these fetches can reach
    // it (BATCH_PARENT_QUEUE). No filter here to forget to write.
    const eligible = Array.isArray(lanes)
      ? TASK_QUEUE_LANES.filter((l) => lanes.includes(l)) // restricted, but keep the stable order
      : TASK_QUEUE_LANES // omitted → all lanes eligible
    for (const lane of eligible) {
      // `includeMetadata` IS THE ATTEMPT NUMBER (found by the live crash drill, 2026-08-05).
      // pg-boss v11's fetch returns four columns by default — id, name, data,
      // expireInSeconds — and `retry_count` is NOT one of them. Without this flag the
      // arithmetic below always read a retry count of 0, so EVERY claim on the real queue
      // reported attempt 1: the tick stamped `attempt: 1` on every ledger row it wrote,
      // the CLAIMED transition minted the SAME idempotency key for a first attempt and a
      // third, and the ledger reconciliation pass found attempt 1 already claimed and
      // reconstructed nothing. None of it was visible in the suite, because the test's
      // fake pg-boss returns the retry count from fetch unconditionally — the fake was
      // more generous than the library it models.
      const jobs = await bossInstance.fetch(laneQueue(lane), { batchSize: 1, includeMetadata: true })
      const job = Array.isArray(jobs) ? jobs[0] : jobs
      if (job) {
        const data = job.data || {}
        const retries = job.retrycount ?? job.retryCount ?? job.retry_count ?? 0
        // THE ONE ARITHMETIC (attemptNumberOf), and this is the caller that reads the LIVE
        // count: the fetch above IS the claim, so the count in hand is the claim count — while
        // the mark still in the payload belongs to the attempt that just lost the row.
        const attempt = attemptNumberOf(data, retries, { unclaimed: true })
        // The fetch above set the lease clock; this records the moment the work was taken, which
        // the renewal must never be allowed to move (see stampClaimedAt) — AND the fencing token
        // of this hand-out, under the same guard, so a re-issued row gets a new one by
        // construction rather than by a second promise.
        const attemptToken = await stampClaimedAt(job.id, mintAttemptToken())
        // READY -> CLAIMED. The fetch above IS the claim (atomic in the queue), so this
        // cannot gate it — it is minted AFTER the fact, and a refusal is logged rather
        // than acted on: nothing here can un-fetch a job, and dropping a task the queue
        // has already handed out would strand it until its lease expires.
        transitionStamp({ from: 'READY', to: 'CLAIMED', actor: 'dispatcher', taskId: data.id, attempt, log })
        // NOTE ON `workerId`: the caller claims as the daemon itself — WHICH worker will run
        // this task is decided by routing, one step later. So nothing is stamped here; the
        // executing worker is written by assignWorker() below, once it is actually known.
        //
        // THE TOKEN IS WRITTEN OVER THE PAYLOAD'S OWN, DELIBERATELY. `data` is what the fetch
        // returned — the payload as it was BEFORE this claim was stamped — so it still carries
        // the token of the attempt that just lost the row (the queue copies the payload through
        // its own re-issue; measured on the live queue, and the claim time beside it behaves the
        // same way). Handing that one out would hand the new worker the dead worker's key.
        // Nothing is carried when the stamp did not land: an absent token is an absence, and
        // every method treats it as today's behaviour rather than as a refusal.
        const claimed = { ...data, attempt }
        delete claimed.attemptToken
        if (attemptToken) claimed.attemptToken = attemptToken
        return claimed
      }
    }
    return null
  }

  /**
   * assignWorker(taskId, workerId) — record WHICH worker is executing a claimed task.
   *
   * Nothing in pg-boss knows about our workers, and the claim itself is made by the daemon
   * before routing has chosen one — so without this write the answer to «who is running
   * this» exists nowhere durable. That is not a cosmetic gap: the board derives «who is
   * busy» by matching a claimed row's workerId against the configured workers, so an
   * unwritten id renders as an EMPTY QUEUE AND AN IDLE WORKER while the work is running.
   * Measured 12.08.2026 — the founder watched his own task disappear off the board and
   * reasonably concluded the system had lost it.
   *
   * Written into the job's own payload so a daemon restart still knows, and scoped to
   * active rows so a late assignment cannot touch finished work.
   */
  async function assignWorker(taskId, workerId) {
    const job = await resolveActiveJob(taskId)
    if (!job) return false
    await runSql(`UPDATE pgboss.job SET data = data || jsonb_build_object('workerId', $2::text) WHERE id = $1`, [
      job.id,
      workerId ?? null,
    ])
    return true
  }

  /**
   * resolveBatch(batchId, {skip, cancel}) — the owner's word about a stopped assembly, written
   * onto the REQUEST row and made to take effect. Returns false when no such request exists.
   *
   * WHERE THE WORD IS KEPT: in the request job's own payload, which is the only row of a batch
   * that outlives every piece of it. The two statements are written as MERGES of the existing
   * payload rather than as replacements, so two decisions taken seconds apart cannot lose each
   * other. The request job is never fetched by anything (BATCH_PARENT_QUEUE), so an UPDATE of
   * it can never race a worker.
   *
   * WHAT «CANCEL» ACTUALLY DOES, beyond remembering: it takes the pieces NOBODY STARTED out of
   * the queue (`boss.cancel`), because an abandoned assembly whose pieces went on sitting in
   * «в очереди» would be a counter no amount of working could bring down. Work that already
   * produced is never touched — what is closed stays closed.
   */
  async function resolveBatch(batchId, { skip, cancel } = {}) {
    if (typeof batchId !== 'string' || batchId === '') return false
    const rows = await list({})
    const request = rows.find((r) => isBatchParent(r) && (r.batchId || r.id) === batchId)
    if (!request) return false

    if (typeof skip === 'string' && skip !== '') {
      const already = batchDecisionsOf(request).skipped.includes(skip)
      if (!already) {
        await runSql(
          `UPDATE pgboss.job
              SET data = jsonb_set(
                    data,
                    '{data,skipped}',
                    coalesce(data->'data'->'skipped', '[]'::jsonb) || to_jsonb($2::text))
            WHERE data->>'id' = $1 AND name = $3`,
          [batchId, skip, BATCH_PARENT_QUEUE],
        )
      }
    }

    if (cancel === true) {
      await runSql(
        `UPDATE pgboss.job
            SET data = jsonb_set(data, '{data,cancelled}', 'true'::jsonb)
          WHERE data->>'id' = $1 AND name = $2`,
        [batchId, BATCH_PARENT_QUEUE],
      )
      for (const item of rows) {
        if (!item || item.batchId !== batchId || isBatchParent(item)) continue
        // EVERY PIECE STILL IN FLIGHT, waiting or under way. The piece already taken used to be
        // skipped here, and it then stayed «в работе» for good: an abandoned assembly is never
        // served again, so nothing ever finished it, no column of the board offered a person a
        // way to close it, and the lease could only ever hand it back to a queue nobody is
        // served from. pg-boss cancels anything short of completed (`state < 'completed'` in
        // its own plan), which is exactly the two states meant here.
        if (item.status !== 'queued' && item.status !== 'claimed') continue
        // A WAITING PIECE MAY BE WAITING IN EITHER STATE, and this is the second — and last —
        // deliberate adoption of the two-state resolution (the words door was the first). A
        // piece whose worker went silent comes back to the queue like any other row, reads as
        // «в очереди» on every screen, and used to be looked for in the FIRST waiting state
        // alone: not found, silently skipped, left live. Its backoff then ran out and the queue
        // handed the work of an abandoned assembly to a worker — the very outcome cancelling
        // exists to prevent.
        const job = item.status === 'claimed' ? await resolveActiveJob(item.id) : await resolveWaitingJob(item.id)
        if (!job) {
          // AND A PIECE THAT COULD NOT BE FOUND IS SAID OUT LOUD. The read above and the
          // resolution here are two moments, and a row can leave between them — another daemon
          // fetched it, its lease lapsed, a person closed it. That is a real outcome and it is
          // survivable; being told «сборка отменена» while a piece of it was never touched, and
          // finding nothing about it anywhere, is not.
          log(`batch piece ${item.id} was not found to take out of the queue: it left the waiting states between the read and the cancel`)
          continue
        }
        try {
          await bossInstance.cancel(job.name, job.id)
          // AND THE REASON WITH IT. `cancelled` is a state, not a word: every reader of a
          // finished row takes its cause from the job's output, so a cancellation that wrote
          // nothing there produced a red row with «причина не записана» on the card. A human
          // stopped this, and that is what the row now says — in both backends alike.
          await runSql(
            `UPDATE pgboss.job SET output = coalesce(output, '{}'::jsonb) || jsonb_build_object('reason', $2::text)
              WHERE id = $1`,
            [job.id, 'manual'],
          )
        } catch (err) {
          log(`batch piece ${item.id} not taken out of the queue: ${maskError(err)}`)
        }
      }
    }
    return true
  }

  /**
   * setWords(taskId, {description, acceptance}) — the words of a task, replaced on the job's
   * own payload. Returns false when no LIVE job carries this id.
   *
   * THE REFUSAL IS THE RESOLUTION, not a check beside it: the only two jobs this can find are
   * the waiting one and the one under way, so a task that already produced, failed or is
   * waiting for a person is simply not there to be edited. That is the same «what is closed
   * stays closed» the batch decisions keep, expressed as a query rather than as an if.
   *
   * The patch is MERGED into the payload (`||`), so a door sending one field does not erase
   * the other, and two edits seconds apart cannot lose each other.
   */
  async function setWords(taskId, patch = {}) {
    if (typeof taskId !== 'string' || taskId === '') return false
    const words = validateWords(patch)
    if (Object.keys(words).length === 0) return false
    const job = (await resolveActiveJob(taskId)) || (await resolveWaitingJob(taskId))
    if (!job) return false
    await runSql(`UPDATE pgboss.job SET data = data || $2::jsonb WHERE id = $1`, [job.id, JSON.stringify(words)])
    return true
  }

  /**
   * THE RESOLUTION THAT SAW ONLY THE FIRST WAITING STATE IS GONE, and its absence is the point:
   * both doors that used it — the words of a task and the owner's word about an abandoned
   * assembly — have now each taken their own decision to reach a row waiting after a lost
   * attempt, each with a case of its own. Nothing is left that asks this queue about ONE of
   * its two waiting states, so keeping a resolution that answers about one would leave a
   * loaded gun on the table for the next door somebody writes.
   */

  /**
   * READ-ONLY resolution of a job that is WAITING — in EITHER of the two states this queue
   * waits in — for the promises that are NOT the stop.
   *
   * WHY IT IS A RESOLUTION OF ITS OWN, and not the stop's one borrowed or the created-only one
   * widened. When the stop learned to see both waiting states it was said in the same breath
   * that whether the OTHER doors should reach a row waiting after a lost attempt is a separate
   * promise, owed its own decision and its own case — because widening the shared resolution
   * would have changed two promises at once, in silence, and nothing would have said which.
   * Those decisions have now been taken, one at a time, each with a case: the words door and
   * the owner's word about an abandoned assembly. This is where they are taken, so the reason
   * is readable here rather than inferred from a call site.
   *
   * WHAT IT CHANGES, in words rather than in states: a task whose worker went silent is parked
   * by the queue until its backoff runs out. Every reader of ours already calls that «в
   * очереди», so a person sees ordinary waiting work — and it is precisely the moment editing
   * the words matters most, because the next try should go out with a corrected brief rather
   * than the one that just failed. A door answering «no such task» about a row the board shows
   * in the queue is a refusal wearing the clothes of an absence.
   */
  async function resolveWaitingJob(taskId) {
    try {
      const res = await runSql(
        `SELECT id, name FROM pgboss.job WHERE data->>'id' = $1 AND state IN ('created','retry') ORDER BY created_on DESC LIMIT 1`,
        [taskId],
      )
      const rows = res && Array.isArray(res.rows) ? res.rows : []
      return rows[0] || null
    } catch (err) {
      log(`waiting job for ${taskId} not resolved: ${maskError(err)}`)
      return null
    }
  }

  /**
   * touch(taskId) — push out the lease clock on a job this daemon is actively working.
   *
   * PG-BOSS v11 HAS NO RENEWAL METHOD. There is no touch, no renew, no heartbeat, no
   * extend — verified against the installed instance, not the docs. A job's lease is
   * `started_on + expire_seconds`, so the ONLY way to keep a long attempt alive is to
   * restamp `started_on`. The line that used to stand here called `bossInstance.touch(...)`,
   * which is `undefined` on the instance: every renewal threw TypeError, the caller
   * discarded it, and so EVERY attempt outliving expireInSeconds was declared
   * `runtime_offline` while its process kept running and burning the window. Measured
   * 12.08.2026 on the first live pilot task: three parallel workers on one task, each
   * started two minutes after the last, while the board showed an empty queue and an idle
   * worker. The lease is the daemon's whole liveness story — it may never again rest on a
   * method nobody proved exists.
   *
   * The UPDATE rides `runSql`, the same seam list() and resolveActiveJob already use, so the
   * suite's injected execSql observes it and no second connection is ever opened. Scoped by
   * `state = 'active'` so a completed or failed job can never be resurrected by a late touch.
   *
   * IT WRITES THE LEASE AND NOTHING ELSE. `started_on` is the renewal clock alone now; the
   * moment the work was taken lives in the payload (stampClaimedAt) precisely so this statement
   * cannot move it. A renewal that also reset «how long has this been running» is what made
   * every live task report about zero.
   */
  async function touch(taskId, { attemptToken } = {}) {
    const job = await resolveActiveJob(taskId)
    if (!job) return false
    // WHOSE LEASE IS BEING HELD OPEN. The resolution above finds the row that is running under
    // THIS task id, which is not the same question as «is the caller the one running it». A
    // stale worker that went on renewing would keep the lease of somebody else's attempt alive
    // for ever, and the liveness sweep — whose whole job is to take a row away from a worker
    // that has gone quiet — would never fire. `false` is this method's own way of saying no.
    if (attemptTokenIsStale(tokenOfJob(job), attemptToken)) return false
    await runSql(`UPDATE pgboss.job SET started_on = now() WHERE id = $1 AND state = 'active'`, [job.id])
    return true
  }

  async function complete(taskId, result) {
    // No self-certified done — refuse BEFORE any mutation.
    if (!result || !result.receiptRef) {
      throw new NoReceiptError(
        `complete("${taskId}") refused: result must carry a receiptRef — work is never ` +
          `certified done on the runner's own word`,
      )
    }
    const job = await resolveActiveJob(taskId)
    // ═══ СТРОКА, КОТОРУЮ УЖЕ ЗАБРАЛ СТОРОЖ ЖИВОСТИ ══════════════════════════════════════
    //
    // Активной строки нет, а завершение пришло — и звонящий НАЗЫВАЕТ этот случай вслух
    // (`afterSweep`): между захватом и этой секундой сторож объявил замолчавшего мёртвым и
    // вернул задачу в очередь, где она ждёт своей отсрочки. Работа при этом добежала и
    // предъявила квитанцию, а квитанция сильнее исхода, реконструированного по молчанию.
    // Флаг обязателен: без него дверь отвечает ровно как отвечала, и ни одна другая дорога
    // сюда случайно не заезжает.
    const parked = !job && result.afterSweep === true ? await resolveWaitingJob(taskId) : null
    if (!job && !parked) throw new UnknownTaskError(`complete: no active task "${taskId}"`)
    // WHOSE ATTEMPT IS BEING CLOSED — asked BEFORE any mutation, like the missing receipt above.
    // The resolution finds the ACTIVE row of this task, whichever attempt that is; this is the
    // one question it cannot answer, and the one the live queue proved has to be asked.
    //
    // И ЖИВУЮ ПОПЫТКУ СОСЕДА ЭТА ДВЕРЬ ПО-ПРЕЖНЕМУ НЕ ПЕРЕБИВАЕТ: если задачу успел захватить
    // второй работник, разрешение выше находит ЕГО активную строку с ЕГО жетоном — и отказ
    // случается здесь, до всякой записи. Ожидающая строка ничьей попыткой не является, жетона
    // в ней запрос не читает, и отсутствие остаётся отсутствием.
    refuseStaleAttempt('complete', taskId, tokenOfJob(job), result.attemptToken)
    if (job) {
      await bossInstance.complete(job.name, job.id, { receiptRef: result.receiptRef })
    } else {
      // pg-boss закрывает ТОЛЬКО активную строку (его собственный план: `WHERE state =
      // 'active'`), а эта уже вернулась в ожидание — вызов библиотеки не сделал бы ничего и
      // сделал бы это молча. Поэтому правда пишется тем же оператором, каким эта дверь уже
      // правит строку задания, и в тех же двух состояниях ожидания, в которых её нашли.
      await runSql(
        `UPDATE pgboss.job SET state = 'completed', completed_on = now(), output = $2::jsonb
          WHERE id = $1 AND state IN ('created','retry')`,
        [parked.id, JSON.stringify({ receiptRef: result.receiptRef })],
      )
    }
    coalesce.delete(taskId)
    // Finished work is not finished business: the task now owes a human a word, and the
    // front's approve/return CAS from exactly this state (events.mjs already ANNOUNCES
    // `task.awaiting_approval` here — this is the durable half of that announcement).
    await markAwaitingApproval(runSql, taskId, { log })
    if (ledgerDir) {
      recordAttempt(ledgerDir, {
        taskId,
        workerId: result.workerId,
        provider: result.provider,
        outcome: 'completed',
        receiptRef: result.receiptRef,
        endedAt: new Date(now()).toISOString(),
        // НА ПОЗДНЕМ ПУТИ ШТАМПА НЕТ, и это не пропуск: активной строки не было, а переход
        // «вернулась в очередь → произведено» в контракте состояний не объявлен. Пустой штамп
        // пишет строку без полей перехода — ровно как это уже делает дверь завершения в цикле,
        // — вместо выдуманной пары, которой никто не совершал. Сам факт при этом не теряется:
        // рядом в реестре лежит строка приговора сторожа, а поздняя правда названа в журнале.
        ...jobStamp(job, { from: 'RUNNING', to: 'PRODUCED', actor: 'worker', taskId }),
      })
    }
    return true
  }

  async function fail(taskId, reason, { attemptToken } = {}) {
    if (!FAIL_REASONS.includes(reason)) {
      throw new InvalidFailReasonError(`fail: "${reason}" is not one of ${FAIL_REASONS.join('|')}`)
    }
    const job = await resolveActiveJob(taskId)
    if (!job) throw new UnknownTaskError(`fail: no active task "${taskId}"`)
    // A STALE WORKER MAY NOT BREAK SOMEBODY ELSE'S ATTEMPT EITHER, and here it matters twice
    // over: a failure in this queue is the RETRYABLE outcome — the row is deleted and inserted
    // back for another try — so a stranger's failure would take the work away from the worker
    // doing it right now and hand it to a third.
    refuseStaleAttempt('fail', taskId, tokenOfJob(job), attemptToken)
    await bossInstance.fail(job.name, job.id, { reason })
    coalesce.delete(taskId)
    if (ledgerDir) {
      recordAttempt(ledgerDir, {
        taskId,
        outcome: 'failed',
        failureReason: reason,
        endedAt: new Date(now()).toISOString(),
        ...jobStamp(job, { from: 'RUNNING', to: 'RETRYABLE', actor: 'supervisor', taskId }),
      })
    }
    return true
  }

  /**
   * parkForPerson(taskId, reason) — THE FAILURE THAT MAY NOT BE REPEATED, written into the
   * queue as a closed row that waits for a PERSON.
   *
   * AND NEVER `boss.fail`, which is the whole reason this door exists beside the other one.
   * A failure in this queue is the RETRYABLE outcome and the branch is taken INSIDE the
   * library, by `retryLimit`, where nothing of ours can see it: the row is deleted, inserted
   * back in the retry state, and handed out again — twice, on the same subscription, with the
   * SAME turn ceiling on the command line. For a cause a repetition cannot touch those two
   * attempts are paid for a known outcome. So the row is taken out of the queue instead.
   *
   * THE LIBRARY'S OWN CANCEL, for the same reason `cancelTask` uses it: the statement that
   * hands work out belongs to pg-boss, and its `cancel` is the one call that moves a row out
   * of everything short of completed by the very plan the fetch is written against. A state
   * written by a statement of ours would have to agree with that plan for ever.
   *
   * THE REASON RIDES WITH IT, and it is the TRUE one — `turns_exhausted`, not the `manual` a
   * stop writes. Every reader of a finished row takes its cause from the job's output; a row
   * saying `manual` here would blame a person for a ceiling the daemon set, and the card would
   * ask him to confirm a decision he never made instead of asking him to take one.
   *
   * ONLY AN ATTEMPT THAT IS UNDER WAY IS PARKED. This ending is the end of a RUN, and the run
   * is the active row; a task waiting in the queue has no attempt to park, and `false` says so
   * rather than closing work nobody has tried yet.
   */
  async function parkForPerson(taskId, reason, { attemptToken } = {}) {
    if (!FAIL_REASONS.includes(reason)) {
      throw new InvalidFailReasonError(`parkForPerson: "${reason}" is not one of ${FAIL_REASONS.join('|')}`)
    }
    const job = await resolveActiveJob(taskId)
    if (!job) return false
    // A STRANGER MAY NOT PARK SOMEBODY ELSE'S ATTEMPT, and here the fence matters more than it
    // does on the retryable door: this ending is terminal, so a stale worker's word would close
    // work that is running right now under a newer token, with no re-issue behind it to undo.
    refuseStaleAttempt('parkForPerson', taskId, tokenOfJob(job), attemptToken)
    await bossInstance.cancel(job.name, job.id)
    await runSql(
      `UPDATE pgboss.job SET output = coalesce(output, '{}'::jsonb) || jsonb_build_object('reason', $2::text)
        WHERE id = $1`,
      [job.id, reason],
    )
    coalesce.delete(taskId)
    if (ledgerDir) {
      recordAttempt(ledgerDir, {
        taskId,
        outcome: 'failed',
        failureReason: reason,
        endedAt: new Date(now()).toISOString(),
        // NO TRANSITION STAMP, and the absence is the honest answer rather than a gap. The
        // failure edge this backend can name is RUNNING -> RETRYABLE, and this attempt is
        // precisely the one that will NOT be retried; RUNNING -> CANCELLED is the human abort
        // edge, and no human aborted anything — he has not been asked yet. The contract table
        // declares no edge for «stopped at our own ceiling, waiting for a person», so none is
        // claimed: the same choice the late-completion path above makes, for the same reason.
        // The fact itself is not lost — the reason is on this row and on the card.
      })
    }
    return true
  }

  /**
   * READ-ONLY resolution of a job that is WAITING TO BE HANDED OUT — in EITHER of the two
   * states this queue waits in.
   *
   * WHY IT EXISTS AT ALL — it was the FIRST door taught to see both. A task whose worker
   * went silent is not failed: the liveness sweep hands the row back, and the queue parks it in
   * its RETRY state until the backoff runs out. Every reader of ours already calls that state
   * «в очереди» — the state map says so — so a person looking at the board sees an ordinary
   * waiting task. But the resolution that only knew the FIRST waiting state could not find it,
   * answered «no such task», and left the row live: measured on the live queue, the stop
   * returned false and the very next hand-out gave that task to a worker. A stop that a person
   * is told did not happen, on work that then runs anyway, is the same mine as a stop written
   * as a failure — approached from the other side.
   *
   * IT WAS DELIBERATELY NOT A WIDENING OF THE SHARED WAITING RESOLUTION, which at the time also
   * answered the words door and the owner's word about an abandoned assembly: whether THOSE
   * should reach a task waiting after a lost attempt was a separate promise, owed a decision
   * and a case of its own rather than a side effect of this one. Both decisions have since been
   * taken that way — one door at a time, one case each — and they read the same two states
   * through resolveWaitingJob. This resolution stays the stop's own, spelled out in full rather
   * than borrowed, so a future change to what «stoppable» means cannot silently move the
   * other two doors with it.
   */
  async function resolveStoppableJob(taskId) {
    try {
      const res = await runSql(
        `SELECT id, name FROM pgboss.job WHERE data->>'id' = $1 AND state IN ('created','retry') ORDER BY created_on DESC LIMIT 1`,
        [taskId],
      )
      const rows = res && Array.isArray(res.rows) ? res.rows : []
      return rows[0] || null
    } catch (err) {
      log(`waiting job for ${taskId} not resolved: ${maskError(err)}`)
      return null
    }
  }

  /**
   * cancelTask(taskId) — A PERSON STOPPED THIS WORK, written into the queue as a state and
   * not as a word on a screen. Returns false when no LIVE job carries this id.
   *
   * THE LIBRARY'S OWN CANCEL, NEVER AN UPDATE OF OUR OWN. The statement that hands work out
   * belongs to pg-boss, and it selects on a state ordering only pg-boss maintains; a state
   * written by a statement of ours would have to agree with that selection for ever, across
   * every version of the library, on a promise nobody checks. Its `cancel` is the one call
   * that moves a row out of everything short of completed — waiting, retrying and under way
   * alike — by the same plan the fetch is written against. So the two cannot disagree.
   *
   * AND NEVER `fail`. A failure is the RETRYABLE outcome of this queue: its own plan DELETES
   * the job row and INSERTS it back in the retry state with a later start. A stop written as
   * a failure would therefore be a stop that hands the work out again after the backoff —
   * a closed card, a counter that fell, and a worker holding the stopped task minutes later.
   * That is the single reason this method exists beside `fail` instead of inside it.
   *
   * THE REASON RIDES WITH IT. `cancelled` is a state, not an explanation: every reader of a
   * finished row takes its cause from the job's output, so a stop that wrote nothing there
   * would draw a red card saying «причина не записана». A human stopped this, and the row now
   * says exactly that — in the very shape the owner's word about an abandoned assembly
   * already writes, so both paths leave one kind of evidence rather than two.
   *
   * NOTHING IS TOUCHED IN THE READ PATH, and nothing needs to be: the state map already reads
   * a cancelled row as closed, and the reason already carries its own Russian label.
   *
   * THE LEDGER ROW IS WRITTEN ONLY FOR WORK THAT WAS UNDER WAY. The ledger is a record of
   * ATTEMPTS, and a task stopped while it was still waiting never had one — stamping a row
   * for it would invent a try nobody ran, which is the one thing an audit trail may never do.
   * Where there IS an attempt, the stop crosses the state machine's human-abort edge for real
   * instead of leaving it declared and never travelled.
   */
  async function cancelTask(taskId) {
    if (typeof taskId !== 'string' || taskId === '') return false
    // THE RESOLUTION IS THE «what is closed stays closed» RULE, expressed as a query rather
    // than as an if: the only jobs findable here are LIVE ones, so finished work is simply
    // not there to be stopped.
    const running = await resolveActiveJob(taskId)
    const job = running || (await resolveStoppableJob(taskId))
    if (!job) return false
    await bossInstance.cancel(job.name, job.id)
    await runSql(
      `UPDATE pgboss.job SET output = coalesce(output, '{}'::jsonb) || jsonb_build_object('reason', $2::text)
        WHERE id = $1`,
      [job.id, 'manual'],
    )
    coalesce.delete(taskId)
    if (ledgerDir && running) {
      recordAttempt(ledgerDir, {
        taskId,
        // The ledger's terminal vocabulary is two words wide and stays that way; WHICH kind of
        // ending this was is carried by the reason and by the transition stamp beside it, both
        // of which name the human. A third outcome word here would be a second place saying
        // the same thing, free to disagree with the first.
        outcome: 'failed',
        failureReason: 'manual',
        endedAt: new Date(now()).toISOString(),
        ...jobStamp(running, { from: 'RUNNING', to: 'CANCELLED', actor: 'human', taskId }),
      })
    }
    return true
  }

  /**
   * statusOf(r) → the contract status of a job row, approval row included.
   *
   * THE SIDE TABLE IS ONLY CONSULTED FOR FINISHED WORK. A task that was approved once and
   * later re-dispatched keeps its old approval row, and letting that row speak would report
   * a running task as decided — so pg-boss's own state wins for everything it still owns,
   * and the approval row is asked exactly one question: does this FINISHED work still owe a
   * person a word?
   */
  function statusOf(r) {
    const base = STATE_TO_STATUS[r.state] ?? r.state
    if (base !== 'completed') return base
    return AWAITING_APPROVAL_STATUSES.includes(r.approval_status) ? AWAITING_APPROVAL : base
  }

  /**
   * exhaustedReasonOf(r, output) → our word for a row THE LIBRARY closed, or null.
   *
   * The queue expires a lease on its own schedule, and when the row has no re-issues left it
   * closes it — with an output written in the library's language, not ours: a `value.message`
   * saying the job timed out, and no `reason` at all. Every reader of a finished row takes its
   * cause from `reason`, so such a row arrived on a card as «причина не записана» — a red row
   * that explains nothing, the very thing the batch cancellation already had to fix once.
   *
   * ONE MESSAGE IS TRANSLATED, matched literally against the library's own plan, and only on a
   * row that is actually CLOSED: a lease that timed out with re-issues still owed puts the row
   * back into a waiting state, where «the attempts ran out» would be a lie. Anything else the
   * library might write stays untranslated rather than being guessed at — an invented cause is
   * worse than an absent one.
   */
  function exhaustedReasonOf(r, output) {
    if (STATE_TO_STATUS[r.state] !== 'failed') return null
    const said = output && output.value && output.value.message
    return said === LIBRARY_TIMEOUT_MESSAGE ? ATTEMPTS_EXHAUSTED : null
  }

  function mapRow(r) {
    const data = r.data || {}
    const retries = r.retry_count ?? 0
    const output = r.output || {}
    return {
      id: data.id,
      source: data.source,
      lane: data.lane,
      // WHOSE WORK THIS IS, carried out exactly as it was written in — and ONLY when the task
      // itself named a project. This pick used to drop the field entirely, so a project stamped
      // at the door died on the very next read and the window had nothing to show; the reading
      // side then filled the gap in with whatever project was on the screen, which made the
      // same rows belong to each project in turn. A row that never said stays saying nothing:
      // ownership nobody measured is not something a reader may invent.
      ...(typeof data.project === 'string' && data.project ? { project: data.project } : {}),
      title: data.title,
      priority: data.priority ?? r.priority ?? 0,
      status: statusOf(r),
      // the stage envelope, carried exactly as the reference backend carries it — see the
      // note there: a phase stage is recognised by this object and never by its title
      ...(data.data ? { data: data.data } : {}),
      // WHICH BATCH THIS ROW BELONGS TO, mirrored from the reference backend exactly: carried
      // only when there is one, so ordinary work states nothing about a batch. It is the ONLY
      // thing that lets a reader group the items of one request back together.
      ...(data.batchId ? { batchId: data.batchId } : {}),
      // The two facts a decision leaves behind, carried only when they exist: a row that
      // was never returned states nothing about a note rather than carrying a null one.
      ...(r.returned_note ? { returnedNote: r.returned_note } : {}),
      ...(r.merge_receipt ? { mergeReceipt: r.merge_receipt } : {}),
      // THE ONE ARITHMETIC (attemptNumberOf) — this is the number a board and a task card
      // show, so an expression of its own here is a screen that argues with the audit trail.
      // A row still waiting for a hand reports the try it is ABOUT to get (live count + 1);
      // one already in a hand, or finished in one, reports the try the claim mark names.
      attempt: attemptNumberOf(data, retries, { unclaimed: WAITING_STATES.includes(r.state) }),
      coalesceCount: coalesce.get(data.id) ?? 1,
      // Who holds this task, as written into the payload by claimNext — pg-boss itself
      // records nothing about the fetching worker. `null` here now means «nobody has
      // claimed it», which is what every reader already assumed it meant.
      workerId: data.workerId ?? null,
      storyPoints: data.storyPoints,
      // The words of the task, mirrored from the reference backend: `acceptance` travels in
      // the shape it was written in (a string or a list of criteria) and is normalized by its
      // readers, never on the way out — see acceptanceItems in the adapter.
      description: data.description,
      acceptance: data.acceptance,
      enqueuedAt: r.created_on ?? null,
      // THE TWO CLOCKS, KEPT APART (see stampClaimedAt). `claimedAt` is the moment the attempt
      // in flight was taken — read from the payload, and from the lease clock for every row
      // claimed before that was recorded, so a pre-existing task states a real time rather than
      // nothing. `leaseRenewedAt` is the renewal clock, which is what a liveness sweep reads.
      // NOTHING HOLDS A ROW WITH NO LEASE CLOCK: a queued row keeps the payload's claim time
      // from the attempt it lost, and reporting that would tell a screen that work nobody is
      // doing has been running for forty minutes.
      claimedAt: r.started_on == null ? null : (data.claimedAt ?? r.started_on),
      leaseRenewedAt: r.started_on ?? null,
      completedAt: r.completed_on ?? null,
      failure_reason: output.reason ?? exhaustedReasonOf(r, output),
    }
  }

  /**
   * The two forms of the same read. The join brings the daemon's own approval row alongside
   * the job it belongs to, on the key the live database confirmed: the approval row's `id`
   * IS the task id, which is what the job payload carries at `data->>'id'`.
   *
   * Spelled out, because the table name below arrives as the constant approval-store.mjs
   * owns and a reader grepping for the relationship would otherwise not find it here:
   *
   *     LEFT JOIN sma_task_attempts a ON a.id = (j.data->>'id')
   *
   * Table and column names are TRUSTED DAEMON CONSTANTS (the cas.mjs law) and the only
   * value in the statement is the lane-name array, passed as $1. Nothing a person typed
   * reaches this SQL.
   */
  const JOB_COLUMNS = `j.id, j.name, j.priority, j.data, j.state, j.retry_count,
         j.created_on, j.started_on, j.completed_on, j.output`
  const LIST_WITH_APPROVAL = `SELECT ${JOB_COLUMNS},
              a.status AS approval_status, a.returned_note, a.merge_receipt
         FROM pgboss.job j
         LEFT JOIN ${APPROVAL_TABLE} a ON a.id = (j.data->>'id')
        WHERE j.name = ANY($1)`
  const LIST_JOBS_ONLY = `SELECT ${JOB_COLUMNS}
         FROM pgboss.job j
        WHERE j.name = ANY($1)`

  /** The last approval-read failure already spoken about — so a poll every few seconds
   *  cannot turn one broken permission into a log of its own. */
  let lastApprovalFailure = null

  /** Say a repeated approval-read failure ONCE, and again only if the reason changes. */
  function noteApprovalFailure(err) {
    const said = maskError(err)
    if (said === lastApprovalFailure) return
    lastApprovalFailure = said
    log(`approval join unavailable, falling back to job states only: ${said}`)
  }

  async function list(filter = {}) {
    // The batch requests are read WITH the work: a screen that cannot see the request has no
    // batch to draw, only loose items. They are excluded from stats() for the opposite
    // reason — see there.
    const names = readQueues()
    // FAIL-OPEN, the approval-store law: a database that will not answer about approvals
    // must still answer about WORK. A restricted or absent side table costs the rows their
    // «waiting for a person» reading — never the rows themselves.
    let res
    try {
      res = await runSql(LIST_WITH_APPROVAL, [names])
      lastApprovalFailure = null
    } catch (err) {
      noteApprovalFailure(err)
      res = await runSql(LIST_JOBS_ONLY, [names])
    }
    const rows = (res && Array.isArray(res.rows) ? res.rows : []).map(mapRow)
    let out = rows
    if (filter.status) out = out.filter((r) => r.status === filter.status)
    if (filter.lane) out = out.filter((r) => r.lane === filter.lane)
    return out
  }

  /**
   * countAwaitingApproval() → how many FINISHED tasks still owe a person a word.
   *
   * A SEPARATE STATEMENT, and deliberately not part of the per-lane API path above:
   * `getQueueStats` counts pg-boss's own states and has never heard of this one, so the
   * number can only come from the daemon's own table. The EXISTS clause is the whole point
   * of asking it this way — pg-boss archives a finished job after its retention window
   * while the approval row stays, and counting the table alone would report tasks waiting
   * that no screen can show, growing forever.
   *
   * Fail-open like every other approval read — but fail-open means «does not throw and does
   * not cost the rows their WORK counts», never «invents a number». A side table that will not
   * answer returns `null`, and stats() passes that through as «нет данных»: zero here would be
   * the same lie the library keys were, said by a different mouth, and a screen reading «ждут
   * решения: 0» over a growing pile is precisely the failure this whole read path exists for.
   */
  async function countAwaitingApproval(names) {
    try {
      const res = await runSql(
        `SELECT count(*)::int AS n
           FROM ${APPROVAL_TABLE} a
          WHERE a.status = $1
            AND EXISTS (SELECT 1 FROM pgboss.job j
                         WHERE j.data->>'id' = a.id AND j.name = ANY($2))`,
        [AWAITING_APPROVAL, names],
      )
      const row = res && Array.isArray(res.rows) ? res.rows[0] : null
      const n = Number(row && row.n)
      return Number.isFinite(n) ? n : null
    } catch (err) {
      noteApprovalFailure(err)
      return null
    }
  }

  /**
   * EVERY NUMBER HERE NAMES ITS SOURCE, AND A MISSING SOURCE SAYS SO.
   *
   * Three of the five counts are the library's, read under the library's OWN key names
   * (QUEUE_STATS_KEYS — see the note there for what asking under ours cost). Two of them —
   * finished and broken — pg-boss does not count at all, and they come from the attempt
   * journal, which does. Nothing is derived from a name that is not in an answer: a key that
   * is absent, or a source that will not answer, yields `null`, and a screen shows «нет
   * данных». A zero would be a measurement, and «сделано: 0» is the one wrong number that
   * looks exactly like a right one.
   */
  async function stats() {
    // Sum a per-lane count while it is still trustworthy: one lane answering with something
    // that is not a number makes the WHOLE column unknown, because a partial sum presented as
    // a total is a smaller version of the same lie.
    const add = (sum, v) => (sum === null || !Number.isFinite(v) ? null : sum + v)
    let queued = 0
    let claimed = 0
    let total = 0
    // THE LANES ONLY, and that is the whole reason the batch requests live elsewhere: they are
    // records of what was asked, not work waiting for a worker, and one counted here would add
    // a permanent unit to «в очереди» that no amount of working could remove.
    for (const lane of TASK_QUEUE_LANES) {
      const s = (await bossInstance.getQueueStats(laneQueue(lane))) || {}
      queued = add(queued, s[QUEUE_STATS_KEYS.queued])
      claimed = add(claimed, s[QUEUE_STATS_KEYS.claimed])
      total = add(total, s[QUEUE_STATS_KEYS.total])
    }
    // `awaiting_approval` is a state of the DAEMON's own table — pg-boss has never heard of it
    // (countAwaitingApproval says why), and an unanswerable table is `null` rather than zero.
    const awaiting = await countAwaitingApproval(TASK_QUEUE_LANES.map(laneQueue))
    // The journal of attempts, folded per task: how the last try of each task ended.
    const ended = countTerminalOutcomes(ledgerDir)
    // The finished ones and the waiting ones are ONE population read twice: the journal says
    // the work is done and the approval row says a person has not spoken yet. Counting them in
    // both places would make stats() disagree with list(), where a row holds exactly one
    // status — so the waiting ones move over rather than being added. With either side
    // unknown the subtraction has no meaning and is not attempted.
    const completed = ended && awaiting !== null ? Math.max(0, ended.completed - awaiting) : null
    return {
      queued,
      claimed,
      awaiting_approval: awaiting,
      completed,
      failed: ended ? ended.failed : null,
      total,
    }
  }

  // `execSql` is exposed so the composition root can hand the FRONT the same read/write
  // SQL seam this backend already owns (one pool, one connection string, one place that
  // knows how to reach the queue database) — that is what fills deps.casExec in production
  // instead of leaving approve/return answering «not implemented».
  // `expireMs` rides out as a FACT about the adapter, not as configuration: it is the lease
  // this queue is actually running on, and the composition root's own test is what reads it.
  // A liveness value that only exists inside a closure cannot be shown to agree with the
  // sweep's — and «they agree» is the whole property (see DEFAULT_EXPIRE_MS in adapter.mjs).
  // `encoding()` is a FUNCTION, not a field: it is answered at start(), and every decorator
  // in this product copies an adapter by spreading it — a field would be captured as its
  // pre-boot value and then quietly report «unknown» forever.
  return {
    start,
    stop,
    enqueue,
    claimNext,
    touch,
    assignWorker,
    resolveBatch,
    setWords,
    complete,
    fail,
    parkForPerson,
    cancelTask,
    list,
    stats,
    execSql: runSql,
    expireMs,
    encoding: () => encodingInfo,
  }
}
