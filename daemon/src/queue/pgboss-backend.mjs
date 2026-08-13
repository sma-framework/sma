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
 * four lane queues. The ONE table this backend does write is not pg-boss's: the daemon's
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
 * `expireInSeconds` (derived from `expireMs`, default 120s) + `retryLimit`/
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
  isBatchParent,
  DEFAULT_EXPIRE_MS,
  FAIL_REASONS,
  NoReceiptError,
  InvalidFailReasonError,
  UnknownTaskError,
} from './adapter.mjs'
import {
  QueueEncodingError,
  describeEncoding,
  describeUntranslatable,
  readQueueEncoding,
  UTF8,
} from './encoding.mjs'
import { recordAttempt } from './attempt-ledger.mjs'
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
 * attemptNumberOf(data, retryCount) → the attempt now in flight, or NaN.
 *
 * The SAME arithmetic `mapRow` and `claimNext` use, in one place so the three cannot
 * drift. NaN when the caller could not read the job's payload — an attempt number that
 * was not observed is left absent rather than defaulted to 1, because a wrong number on a
 * durable audit row is worse than a missing one.
 */
function attemptNumberOf(data, retryCount) {
  if (!data || typeof data !== 'object') return NaN
  return (Number(data.attempt) || 1) + (Number(retryCount) || 0)
}

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
      poolPromise = import('pg').then(({ default: pg }) => new pg.Pool({ connectionString: queueUrl, ...CLIENT_ENCODING }))
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
    let jobId
    try {
      jobId = await bossInstance.send(queueFor(norm), norm, {
        singletonKey: norm.id, // Pattern 5: one pending entry per item (coalescing)
        priority: norm.priority,
        retryLimit: 2,
        retryBackoff: true,
        expireInSeconds, // liveness: silent worker → job expires → requeue
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
   */
  async function stampClaimedAt(jobId) {
    try {
      await runSql(
        `UPDATE pgboss.job
            SET data = data || jsonb_build_object('claimedAt', $2::bigint, 'claimedAtRetry', retry_count)
          WHERE id = $1 AND state = 'active'
            AND (NOT (data ? 'claimedAt') OR (data->>'claimedAtRetry') IS DISTINCT FROM retry_count::text)`,
        [jobId, now()],
      )
    } catch (err) {
      log(`claim time not recorded for job ${jobId}: ${maskError(err)}`)
    }
  }

  async function claimNext(workerId, { lanes } = {}) {
    // lanes:[] → nothing eligible; return null WITHOUT any fetch/mutation.
    if (Array.isArray(lanes) && lanes.length === 0) return null
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
        const attempt = (data.attempt ?? 1) + retries
        // The fetch above set the lease clock; this records the moment the work was taken, which
        // the renewal must never be allowed to move (see stampClaimedAt).
        await stampClaimedAt(job.id)
        // READY -> CLAIMED. The fetch above IS the claim (atomic in the queue), so this
        // cannot gate it — it is minted AFTER the fact, and a refusal is logged rather
        // than acted on: nothing here can un-fetch a job, and dropping a task the queue
        // has already handed out would strand it until its lease expires.
        transitionStamp({ from: 'READY', to: 'CLAIMED', actor: 'dispatcher', taskId: data.id, attempt, log })
        // NOTE ON `workerId`: the caller claims as the daemon itself — WHICH worker will run
        // this task is decided by routing, one step later. So nothing is stamped here; the
        // executing worker is written by assignWorker() below, once it is actually known.
        return { ...data, attempt }
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
  async function touch(taskId) {
    const job = await resolveActiveJob(taskId)
    if (!job) return false
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
    if (!job) throw new UnknownTaskError(`complete: no active task "${taskId}"`)
    await bossInstance.complete(job.name, job.id, { receiptRef: result.receiptRef })
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
        ...jobStamp(job, { from: 'RUNNING', to: 'PRODUCED', actor: 'worker', taskId }),
      })
    }
    return true
  }

  async function fail(taskId, reason) {
    if (!FAIL_REASONS.includes(reason)) {
      throw new InvalidFailReasonError(`fail: "${reason}" is not one of ${FAIL_REASONS.join('|')}`)
    }
    const job = await resolveActiveJob(taskId)
    if (!job) throw new UnknownTaskError(`fail: no active task "${taskId}"`)
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

  function mapRow(r) {
    const data = r.data || {}
    const retries = r.retry_count ?? 0
    const output = r.output || {}
    return {
      id: data.id,
      source: data.source,
      lane: data.lane,
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
      attempt: (data.attempt ?? 1) + retries,
      coalesceCount: coalesce.get(data.id) ?? 1,
      // Who holds this task, as written into the payload by claimNext — pg-boss itself
      // records nothing about the fetching worker. `null` here now means «nobody has
      // claimed it», which is what every reader already assumed it meant.
      workerId: data.workerId ?? null,
      storyPoints: data.storyPoints,
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
      failure_reason: output.reason ?? null,
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
   * Fail-open like every other approval read: an unanswerable side table means zero, and
   * the counts about WORK are unaffected.
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
      return Number(row && row.n) || 0
    } catch (err) {
      noteApprovalFailure(err)
      return 0
    }
  }

  async function stats() {
    const agg = { queued: 0, claimed: 0, awaiting_approval: 0, completed: 0, failed: 0, total: 0 }
    // THE LANES ONLY, and that is the whole reason the batch requests live elsewhere: they are
    // records of what was asked, not work waiting for a worker, and one counted here would add
    // a permanent unit to «в очереди» that no amount of working could remove.
    for (const lane of TASK_QUEUE_LANES) {
      const s = (await bossInstance.getQueueStats(laneQueue(lane))) || {}
      const queued = s.queued ?? s.created ?? 0
      const active = s.active ?? s.claimed ?? 0
      const completed = s.completed ?? 0
      const failed = s.failed ?? 0
      agg.queued += queued
      agg.claimed += active
      agg.completed += completed
      agg.failed += failed
      agg.total += queued + active + completed + failed
    }
    // The two counts are ONE population read twice: pg-boss calls these jobs completed and
    // the approval row says they are still waiting. Counting them in both places would make
    // stats() disagree with list(), where each row holds exactly one status — so the
    // waiting ones move over rather than being added. `total` does not change: nothing
    // appeared, a name did.
    agg.awaiting_approval = await countAwaitingApproval(TASK_QUEUE_LANES.map(laneQueue))
    agg.completed = Math.max(0, agg.completed - agg.awaiting_approval)
    return agg
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
    complete,
    fail,
    list,
    stats,
    execSql: runSql,
    expireMs,
    encoding: () => encodingInfo,
  }
}
