/**
 * pgboss-backend.mjs — the durable QueueAdapter over pg-boss (Phase 9.5 Plan 03,
 * Task 1; D-9.5-02, D-9.5-02c).
 *
 * WHAT: a certified QueueAdapter (the adapter.mjs contract) whose task truth lives
 * ENTIRELY in Postgres via pg-boss. The daemon holds NO task state — kill it at any
 * line and no task is lost (D-9.5-02). This backend re-runs the SAME
 * `queueAdapterContractSuite` the in-memory reference passes (plan 9.5-01): a backend
 * that passes the suite IS a conforming adapter; nothing else certifies it.
 *
 * WHERE THE QUEUE DB LIVES (D-9.5-02 / D-9.5-02c): a **LOCAL Postgres owned by the
 * daemon host** (Homebrew postgresql@16 on the Mac mini for the pilot). The connection
 * string comes from config `queueUrl`. A production application's `DATABASE_URI`
 * MUST NEVER appear in this file or its config — SMA is a standalone product, and
 * worker churn (fetch polling, touch ticks) never belongs in a production medical CRM.
 *
 * PER-LANE QUEUES (grill CH-9.5-07-1): pg-boss `fetch` cannot filter by payload, and a
 * `fetch` IS a claim — one shared queue would force fetch-then-unfetch to honour lane
 * eligibility. So each lane is its OWN queue `sma.task.<lane>` (prod / research /
 * paperwork / forge), sharing one deadLetter `sma.task.dead`. claimNext fetches the
 * eligible lanes in a documented stable order (prod → research → paperwork → forge), so
 * a claimed task is BY CONSTRUCTION one an open worker can run.
 *
 * READ-ONLY-BY-CONTRACT list() (grill CH-9.5-03-1): the roster feed + D-9.5-10
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
 * LOGGING (T-9.5-09): task ids + masked errors ONLY — never task payloads, never the
 * connection string (agent-run-queue maskSecrets discipline).
 *
 * DI: `boss` (a pg-boss instance or a fake), `execSql`, `clock`, and `ledgerDir` are
 * all injectable. When `boss` is injected NO connection is opened and pg-boss is never
 * imported — EVERY unit test runs against a fake. pg-boss is imported LAZILY inside
 * start() only when we own the connection.
 *
 * ═══════ THE STATUS CHANGES ARE ROUTED THROUGH THE STATE MACHINE (D-11-DEFER-23) ═══════
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
 *     disposition appears. Routing a completion through ACCEPTED would need canon
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
  FAIL_REASONS,
  NoReceiptError,
  InvalidFailReasonError,
  UnknownTaskError,
} from './adapter.mjs'
import { recordAttempt } from './attempt-ledger.mjs'
import { ensureApprovalTable, markAwaitingApproval } from './approval-store.mjs'
import { applyTransition } from './state-machine.mjs'
import { defaultEnvelope } from './capability-envelope.mjs'
import { attemptIdFor } from '../front/journal.mjs'

/** The four execution lanes, in the documented stable claim order (grill CH-9.5-07-1). */
export const TASK_QUEUE_LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/** Shared dead-letter queue for exhausted retries → the roster's red «не справился» card. */
export const DEAD_LETTER_QUEUE = 'sma.task.dead'

const DEFAULT_EXPIRE_MS = 120000

/** `sma.task.<lane>` — one durable queue per lane. */
const laneQueue = (lane) => `sma.task.${lane}`

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
 * `null` when it could not be minted (D-11-DEFER-23).
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
 *          expireMs?:number, ledgerDir?:string}} [opts]
 * @returns {object} a QueueAdapter (+ start/stop lifecycle)
 */
export function createPgBossQueue({
  queueUrl,
  boss,
  execSql,
  clock = Date.now,
  expireMs = DEFAULT_EXPIRE_MS,
  ledgerDir,
} = {}) {
  const ownBoss = !boss
  let bossInstance = boss || null
  const now = () => (typeof clock === 'function' ? clock() : clock)
  const expireInSeconds = Math.max(1, Math.ceil(expireMs / 1000))
  /** SOFT display counter (taskId -> coalesce count) — NOT task truth (see header). */
  const coalesce = new Map()

  // Lazy default execSql over a pg Pool for real use; tests inject a fake execSql and
  // never touch this path (pg is never imported).
  let poolPromise = null
  async function defaultExecSql(sql, params) {
    if (!queueUrl) throw new Error('list()/resolve require queueUrl or an injected execSql')
    if (!poolPromise) {
      poolPromise = import('pg').then(({ default: pg }) => new pg.Pool({ connectionString: queueUrl }))
    }
    const pool = await poolPromise
    return pool.query(sql, params)
  }
  const runSql = execSql || defaultExecSql

  const log = (msg) => console.log(`[SmaQueue] ${msg}`) // ids only, never payloads

  async function start() {
    if (ownBoss) {
      if (startedUrls.has(queueUrl)) return true // duplicate in-process init guard
      const { default: PgBoss } = await import('pg-boss') // LAZY — only when we own the connection
      bossInstance = new PgBoss({ connectionString: queueUrl })
      bossInstance.on('error', (err) => log(`boss error: ${maskError(err)}`))
      await bossInstance.start()
    } else if (typeof bossInstance.on === 'function') {
      bossInstance.on('error', (err) => log(`boss error: ${maskError(err)}`))
    }
    // Idempotent queue provisioning: the shared dead-letter FIRST — pg-boss v11 rejects a
    // lane queue whose deadLetter target does not exist yet (the pilot fresh-boot
    // finding) — then the per-lane queues (grill CH-9.5-07-1).
    await bossInstance.createQueue(DEAD_LETTER_QUEUE)
    for (const lane of TASK_QUEUE_LANES) {
      await bossInstance.createQueue(laneQueue(lane), { deadLetter: DEAD_LETTER_QUEUE })
    }
    // The daemon's OWN approval row (approval-store.mjs) — provisioned in the same breath
    // as the queues, because the front's approve/return CAS against it from the first
    // request. Fail-open by construction: a database that refuses the CREATE logs and
    // boots anyway (the queue itself is what a boot cannot do without).
    await ensureApprovalTable(runSql, { log })
    if (ownBoss) startedUrls.add(queueUrl)
    return true
  }

  async function stop() {
    if (ownBoss && bossInstance && typeof bossInstance.stop === 'function') {
      await bossInstance.stop()
      startedUrls.delete(queueUrl)
    }
    return true
  }

  async function enqueue(task) {
    const norm = validateTask(task) // DoR / forge / allowlist gate — same path as the memory backend
    const jobId = await bossInstance.send(laneQueue(norm.lane), norm, {
      singletonKey: norm.id, // Pattern 5: one pending entry per item (coalescing)
      priority: norm.priority,
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds, // liveness: silent worker → job expires → requeue
    })
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
   * It also reads `data` and `retry_count` (D-11-DEFER-23) so complete/fail can stamp the
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
   * (canon invariant 6; D-11-DEFER-23 — never invent a value):
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

  async function claimNext(workerId, { lanes } = {}) {
    // lanes:[] → nothing eligible; return null WITHOUT any fetch/mutation (grill CH-9.5-07-1).
    if (Array.isArray(lanes) && lanes.length === 0) return null
    const eligible = Array.isArray(lanes)
      ? TASK_QUEUE_LANES.filter((l) => lanes.includes(l)) // restricted, but keep the stable order
      : TASK_QUEUE_LANES // omitted → all lanes eligible
    for (const lane of eligible) {
      const jobs = await bossInstance.fetch(laneQueue(lane), { batchSize: 1 })
      const job = Array.isArray(jobs) ? jobs[0] : jobs
      if (job) {
        const data = job.data || {}
        const retries = job.retrycount ?? job.retryCount ?? job.retry_count ?? 0
        const attempt = (data.attempt ?? 1) + retries
        // READY -> CLAIMED. The fetch above IS the claim (atomic in the queue), so this
        // cannot gate it — it is minted AFTER the fact, and a refusal is logged rather
        // than acted on: nothing here can un-fetch a job, and dropping a task the queue
        // has already handed out would strand it until its lease expires.
        transitionStamp({ from: 'READY', to: 'CLAIMED', actor: 'dispatcher', taskId: data.id, attempt, log })
        return { ...data, attempt }
      }
    }
    return null
  }

  async function touch(taskId) {
    const job = await resolveActiveJob(taskId)
    if (!job) return false
    await bossInstance.touch(job.name, job.id)
    return true
  }

  async function complete(taskId, result) {
    // Pitfall 6: no self-certified done — refuse BEFORE any mutation.
    if (!result || !result.receiptRef) {
      throw new NoReceiptError(`complete("${taskId}") refused: result must carry a receiptRef (Pitfall 6)`)
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
      status: STATE_TO_STATUS[r.state] ?? r.state,
      attempt: (data.attempt ?? 1) + retries,
      coalesceCount: coalesce.get(data.id) ?? 1,
      workerId: null, // pg-boss does not record the fetching worker; presence is derived elsewhere
      storyPoints: data.storyPoints,
      acceptance: data.acceptance,
      enqueuedAt: r.created_on ?? null,
      claimedAt: r.started_on ?? null,
      completedAt: r.completed_on ?? null,
      failure_reason: output.reason ?? null,
    }
  }

  async function list(filter = {}) {
    const names = TASK_QUEUE_LANES.map(laneQueue)
    const res = await runSql(
      `SELECT id, name, priority, data, state, retry_count, created_on, started_on, completed_on, output
         FROM pgboss.job
        WHERE name = ANY($1)`,
      [names],
    )
    const rows = (res && Array.isArray(res.rows) ? res.rows : []).map(mapRow)
    let out = rows
    if (filter.status) out = out.filter((r) => r.status === filter.status)
    if (filter.lane) out = out.filter((r) => r.lane === filter.lane)
    return out
  }

  async function stats() {
    const agg = { queued: 0, claimed: 0, completed: 0, failed: 0, total: 0 }
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
    return agg
  }

  // `execSql` is exposed so the composition root can hand the FRONT the same read/write
  // SQL seam this backend already owns (one pool, one connection string, one place that
  // knows how to reach the queue database) — that is what fills deps.casExec in production
  // instead of leaving approve/return answering «not implemented».
  return { start, stop, enqueue, claimNext, touch, complete, fail, list, stats, execSql: runSql }
}
