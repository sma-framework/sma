/**
 * pgboss-backend.mjs — the durable QueueAdapter over pg-boss (Phase 49.5 Plan 03,
 * Task 1; D-49.5-02, D-49.5-02c).
 *
 * WHAT: a certified QueueAdapter (the adapter.mjs contract) whose task truth lives
 * ENTIRELY in Postgres via pg-boss. The daemon holds NO task state — kill it at any
 * line and no task is lost (D-49.5-02). This backend re-runs the SAME
 * `queueAdapterContractSuite` the in-memory reference passes (plan 49.5-01): a backend
 * that passes the suite IS a conforming adapter; nothing else certifies it.
 *
 * WHERE THE QUEUE DB LIVES (D-49.5-02 / D-49.5-02c): a **LOCAL Postgres owned by the
 * daemon host** (Homebrew postgresql@16 on the Mac mini for the pilot). The connection
 * string comes from config `queueUrl`. The Railway / Institut-platform `DATABASE_URI`
 * MUST NEVER appear in this file or its config — SMA is a standalone product, and
 * worker churn (fetch polling, touch ticks) never belongs in a production medical CRM.
 *
 * PER-LANE QUEUES (grill CH-49.5-07-1): pg-boss `fetch` cannot filter by payload, and a
 * `fetch` IS a claim — one shared queue would force fetch-then-unfetch to honour lane
 * eligibility. So each lane is its OWN queue `sma.task.<lane>` (prod / research /
 * paperwork / forge), sharing one deadLetter `sma.task.dead`. claimNext fetches the
 * eligible lanes in a documented stable order (prod → research → paperwork → forge), so
 * a claimed task is BY CONSTRUCTION one an open worker can run.
 *
 * READ-ONLY-BY-CONTRACT list() (grill CH-49.5-03-1): the roster feed + D-49.5-10
 * timestamps need to enumerate jobs with their payloads across states — which no
 * pg-boss API exposes. So list() is ONE read-only SELECT over the pg-boss job tables
 * via an injected `execSql` (the SAME DI seam as cas.mjs), and taskId→job resolution
 * for touch/complete/fail is likewise a read-only SELECT. This backend NEVER UPDATEs
 * boss tables directly — every MUTATION goes through the boss API (send / fetch /
 * touch / complete / fail). stats() stays API-first via getQueueStats summed over the
 * four lane queues.
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
 * LOGGING (T-49.5-09): task ids + masked errors ONLY — never task payloads, never the
 * connection string (agent-run-queue maskSecrets discipline).
 *
 * DI: `boss` (a pg-boss instance or a fake), `execSql`, `clock`, and `ledgerDir` are
 * all injectable. When `boss` is injected NO connection is opened and pg-boss is never
 * imported — EVERY unit test runs against a fake. pg-boss is imported LAZILY inside
 * start() only when we own the connection.
 */

import {
  validateTask,
  FAIL_REASONS,
  NoReceiptError,
  InvalidFailReasonError,
  UnknownTaskError,
} from './adapter.mjs'
import { recordAttempt } from './attempt-ledger.mjs'

/** The four execution lanes, in the documented stable claim order (grill CH-49.5-07-1). */
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
    // lane queue whose deadLetter target does not exist yet (BL-194 pilot fresh-boot
    // finding) — then the per-lane queues (grill CH-49.5-07-1).
    await bossInstance.createQueue(DEAD_LETTER_QUEUE)
    for (const lane of TASK_QUEUE_LANES) {
      await bossInstance.createQueue(laneQueue(lane), { deadLetter: DEAD_LETTER_QUEUE })
    }
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
   */
  async function resolveActiveJob(taskId) {
    const res = await runSql(
      `SELECT id, name FROM pgboss.job WHERE data->>'id' = $1 AND state = 'active' ORDER BY started_on DESC LIMIT 1`,
      [taskId],
    )
    const rows = res && Array.isArray(res.rows) ? res.rows : []
    return rows[0] || null
  }

  async function claimNext(workerId, { lanes } = {}) {
    // lanes:[] → nothing eligible; return null WITHOUT any fetch/mutation (grill CH-49.5-07-1).
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
        return { ...data, attempt: (data.attempt ?? 1) + retries }
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
    if (ledgerDir) {
      recordAttempt(ledgerDir, {
        taskId,
        workerId: result.workerId,
        provider: result.provider,
        outcome: 'completed',
        receiptRef: result.receiptRef,
        endedAt: new Date(now()).toISOString(),
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

  return { start, stop, enqueue, claimNext, touch, complete, fail, list, stats }
}
