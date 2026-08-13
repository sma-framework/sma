/**
 * Tests for daemon/src/queue/pgboss-backend.mjs +
 * daemon/src/queue/attempt-ledger.mjs (Task 2, direct invariants).
 *
 * The pg-boss backend is a certified QueueAdapter: it re-runs the SAME
 * `queueAdapterContractSuite` the in-memory reference passes, here
 * against a STATEFUL FAKE pg-boss (send/fetch/touch/complete/fail/getQueueStats over
 * Maps, honouring singletonKey + priority + expireInSeconds) plus a fake execSql over
 * the same store — jobs AND the daemon's own approval table, so «a live queue with its
 * side table» is a fixture rather than a database. NO live Postgres, NO real pg-boss is
 * ever loaded (boss is injected).
 *
 * Direct grep-visible invariants pinned below:
 *   - every enqueue send carries singletonKey=task.id + expireInSeconds (recorded)
 *   - singletonKey coalescing is observable via the send-call recorder
 *   - complete() without a receiptRef throws NoReceiptError
 *   - start() creates the four lane queues idempotently with a shared deadLetter
 *   - recordAttempt/readAttempts append-and-read the per-task ledger (Task 2)
 *   - completed work is reported as awaiting approval — the approval row joins back onto
 *     the job it belongs to, and stats() counts it out of `completed` rather than twice
 *   - the side table may overrule pg-boss ONLY about finished work, and a decided task
 *     never leaves the contract's closed five-status vocabulary
 *   - fail-open: a database refusing the approval join still answers about the WORK, and
 *     says so once rather than once per poll
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPgBossQueue,
  TASK_QUEUE_LANES,
  DEAD_LETTER_QUEUE,
  BATCH_PARENT_QUEUE,
} from '../src/queue/pgboss-backend.mjs'
import { queueAdapterContractSuite, NoReceiptError } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts } from '../src/queue/attempt-ledger.mjs'
import { STATE_MACHINE_VERSION, idempotencyKey } from '../src/queue/state-machine.mjs'
import { defaultEnvelope, envelopeHash } from '../src/queue/capability-envelope.mjs'

// ── temp ledger dirs (cleaned once at the end) ──
const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-ledger-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

// ── a stateful fake pg-boss + a fake execSql over ONE shared job store ──
// Models exactly the pg-boss semantics the backend relies on: singletonKey coalescing,
// priority+FIFO fetch, expireInSeconds expiry (against the INJECTED clock), touch
// keepalive, complete/fail, getQueueStats. The fake execSql reads the same store.
function makeFakeBackend({
  clock,
  expireMs,
  ledgerDir,
}: {
  clock: () => number
  expireMs: number
  ledgerDir?: string
}) {
  const now = () => (typeof clock === 'function' ? clock() : (clock as unknown as number))
  const jobs = new Map<string, any>()
  /**
   * The daemon's OWN approval table, modelled beside the job store: taskId -> {status,
   * returned_note, merge_receipt}. The backend writes it through the same injected execSql
   * it reads it back through, so the fixture is a live queue AND its side table without a
   * Postgres anywhere — which is what lets the contract case «completed work is reported as
   * awaiting approval» run against this backend at all.
   */
  const attempts = new Map<string, any>()
  let seq = 0
  const sendCalls: any[] = []
  const createQueueCalls: any[] = []

  // pg-boss maintenance, simulated: an active job past its expiry returns to 'created'
  // (retry) with retry_count+1, or moves to the dead-letter (failed) once exhausted.
  function maintain() {
    const t = now()
    for (const j of jobs.values()) {
      if (j.state === 'active' && j.started_on != null) {
        if (t - j.started_on > j.expireInSeconds * 1000) {
          if ((j.retry_count ?? 0) < (j.retryLimit ?? 2)) {
            j.state = 'created'
            j.retry_count = (j.retry_count ?? 0) + 1
            j.started_on = null
          } else {
            j.state = 'failed'
            j.output = { reason: 'runtime_offline' }
          }
        }
      }
    }
  }

  function pendingWithKey(name: string, key: string) {
    for (const j of jobs.values()) {
      if (j.name === name && j.singleton_key === key && (j.state === 'created' || j.state === 'active')) {
        return j
      }
    }
    return null
  }

  const boss = {
    async start() {
      return true
    },
    async stop() {
      return true
    },
    on() {
      /* no-op */
    },
    async createQueue(name: string, opts: any) {
      createQueueCalls.push({ name, opts })
      return true
    },
    async send(name: string, data: any, opts: any = {}) {
      maintain()
      sendCalls.push({ name, data, opts })
      if (opts.singletonKey && pendingWithKey(name, opts.singletonKey)) return null // coalesced
      seq += 1
      const id = `job-${seq}`
      jobs.set(id, {
        id,
        name,
        singleton_key: opts.singletonKey ?? null,
        data,
        priority: opts.priority ?? 0,
        state: 'created',
        retry_count: 0,
        retryLimit: opts.retryLimit ?? 2,
        // WHEN THIS JOB BECOMES FETCHABLE. Modelled because the LIBRARY models it: every fetch
        // plan pg-boss issues carries `AND start_after < now()`, and that column is the whole
        // mechanism «one piece of a batch at a time» rests on. A fake that ignored the option
        // would hand out a held piece and certify a rule the real queue keeps — the fake being
        // richer than its library, once more. (The comparison in `fetch` is `<=` where the
        // library writes `<`: a real database advances its own now() between the INSERT and
        // the later fetch, and this fixture's clock is frozen unless a case moves it. The held
        // value is a date in year 2999, which no comparison of either kind lets through.)
        start_after: opts.startAfter == null ? now() : Date.parse(String(opts.startAfter)),
        expireInSeconds: opts.expireInSeconds ?? 120,
        created_on: now(),
        started_on: null,
        completed_on: null,
        output: null,
      })
      return id
    },
    async fetch(name: string, options: any = {}) {
      maintain()
      const batchSize = options.batchSize ?? 1
      const avail = [...jobs.values()].filter(
        (j) => j.name === name && j.state === 'created' && (j.start_after ?? 0) <= now(),
      )
      avail.sort((a, b) => b.priority - a.priority || a.created_on - b.created_on)
      const picked = avail.slice(0, batchSize)
      for (const j of picked) {
        j.state = 'active'
        j.started_on = now()
      }
      return picked.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
        priority: j.priority,
        retrycount: j.retry_count,
      }))
    },
    // NO `touch` HERE — ON PURPOSE. pg-boss v11 has no touch/renew/heartbeat of any kind,
    // and the fake that used to carry one is exactly why the suite stayed green while the
    // lease renewal threw TypeError on every real tick. A fake may be smaller than the
    // library it stands for; it may never be BIGGER. If a future change calls boss.touch()
    // again, it fails here first instead of in front of the founder.
    async complete(_name: string, id: string, out: any) {
      const j = jobs.get(id)
      if (j) {
        j.state = 'completed'
        j.completed_on = now()
        j.output = out
      }
      return true
    },
    async fail(_name: string, id: string, out: any) {
      const j = jobs.get(id)
      if (j) {
        j.state = 'failed'
        j.output = out
      }
      return true
    },
    // The library really does offer this one (pg-boss v11: cancel(name, id)), and the backend
    // uses it for exactly one thing — taking the unstarted pieces of an abandoned batch out of
    // the queue. `cancelled` is a state of pg-boss's own vocabulary, which the backend already
    // maps onto `failed`.
    async cancel(_name: string, id: string) {
      const j = jobs.get(id)
      if (j && j.state === 'created') j.state = 'cancelled'
      return true
    },
    async getQueueStats(name: string) {
      maintain()
      const s: any = { queued: 0, active: 0, completed: 0, failed: 0 }
      for (const j of jobs.values()) {
        if (j.name !== name) continue
        if (j.state === 'created') s.queued += 1
        else if (j.state === 'active') s.active += 1
        else if (j.state === 'completed') s.completed += 1
        else if (j.state === 'failed') s.failed += 1
      }
      return s
    },
  }

  const execSql = async (sql: string, params: any[]) => {
    maintain()
    if (sql.includes('CREATE TABLE')) return { rows: [] }
    if (sql.includes('INSERT INTO sma_task_attempts')) {
      // markAwaitingApproval's upsert: ($1 id, $2 status), the note cleared on re-entry
      const [id, status] = params
      attempts.set(String(id), { ...(attempts.get(String(id)) || {}), status, returned_note: null })
      return { rows: [] }
    }
    if (sql.includes('count(*)') && sql.includes('sma_task_attempts')) {
      // stats()'s separate counter: waiting rows that still have a job to belong to
      const [status] = params
      const live = new Set([...jobs.values()].map((j) => j.data && j.data.id))
      const n = [...attempts.entries()].filter(([id, a]) => a.status === status && live.has(id)).length
      return { rows: [{ n }] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('workerId')) {
      // assignWorker(): the executing worker written into the job payload, keyed by JOB id.
      const [jobId, workerId] = params
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') j.data = { ...(j.data || {}), workerId }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('$2::jsonb')) {
      // setWords(): the words of a task MERGED into the job payload, keyed by JOB id — the
      // same shape assignWorker uses. Modelled as a MERGE and not as a replacement, because
      // that is what `data || $2::jsonb` does: a patch naming one field leaves the other
      // exactly as it was, and a fake that replaced would certify an erasure nobody wrote.
      const [jobId, patch] = params
      const j = jobs.get(String(jobId))
      if (j) j.data = { ...(j.data || {}), ...JSON.parse(String(patch)) }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('claimedAt')) {
      // The claim-time stamp: written into the job payload, ONCE PER ATTEMPT. Modelled exactly
      // as the statement is written — keyed by JOB id, scoped to active rows, and refusing to
      // move a value that already belongs to the attempt in flight (the queue's own retry_count
      // is what tells the two apart). A fake looser than its statement would let a renewal move
      // the clock here and stay green.
      const [jobId, claimedAt] = params
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') {
        const d = j.data || {}
        const retry = j.retry_count ?? 0
        const sameAttempt = d.claimedAt != null && String(d.claimedAtRetry) === String(retry)
        if (!sameAttempt) j.data = { ...d, claimedAt, claimedAtRetry: retry }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('start_after = $2')) {
      // applyWaveHolds(): a waiting row of a STOPPED echelon is deferred out of every worker's
      // reach. Modelled with the statement's own guards — keyed by TASK id, only a waiting row,
      // and only one that is currently REACHABLE (so a second pass changes nothing, and a row a
      // batch is already holding is not restamped).
      const [taskId, until] = params
      for (const j of jobs.values()) {
        if (j.data && j.data.id === taskId && j.state === 'created' && (j.start_after ?? 0) <= now()) {
          j.start_after = Date.parse(String(until))
        }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('start_after = now()')) {
      // releaseBatchTurns(): the piece whose turn has come stops being deferred. Modelled with
      // the statement's own guards — keyed by TASK id, only a waiting row, and only one that is
      // actually held (so a second pass over an already-released piece changes nothing).
      const [taskId] = params
      for (const j of jobs.values()) {
        if (j.data && j.data.id === taskId && j.state === 'created' && (j.start_after ?? 0) > now()) {
          j.start_after = now()
        }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes("'{data,skipped}'")) {
      // resolveBatch({skip}): the owner's word appended to the request row's own payload.
      const [batchId, itemId] = params
      for (const j of jobs.values()) {
        if (!j.data || j.data.id !== batchId || j.name !== 'sma.batch') continue
        const env = { ...(j.data.data || {}) }
        env.skipped = [...(Array.isArray(env.skipped) ? env.skipped : []), itemId]
        j.data = { ...j.data, data: env }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes("'{data,cancelled}'")) {
      const [batchId] = params
      for (const j of jobs.values()) {
        if (!j.data || j.data.id !== batchId || j.name !== 'sma.batch') continue
        j.data = { ...j.data, data: { ...(j.data.data || {}), cancelled: true } }
      }
      return { rows: [] }
    }
    if (sql.includes("state = 'created'") && sql.startsWith('SELECT id, name')) {
      // resolveQueuedJob(): the waiting job carrying this task id (the mirror of the active
      // resolution below).
      const taskId = params[0]
      const match = [...jobs.values()]
        .filter((j) => j.state === 'created' && j.data && j.data.id === taskId)
        .sort((a, b) => (b.created_on ?? 0) - (a.created_on ?? 0))[0]
      return { rows: match ? [{ id: match.id, name: match.name }] : [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('started_on')) {
      // touch(): the lease restamp. Keyed by JOB id (params[0]), not task id, and scoped to
      // active rows — the same shape the backend sends. Must be matched BEFORE the
      // active-job SELECT below, whose `state = 'active'` substring this statement shares.
      const jobId = params[0]
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') j.started_on = now()
      return { rows: [] }
    }
    if (sql.includes("state = 'active'")) {
      // taskId → active job resolution (touch/complete/fail). `data` and `retry_count` come
      // back as well (2026-08-05): the backend's SELECT asks for them so complete/fail can
      // stamp the attempt row with the number and the lane THE QUEUE holds, and a fake that
      // withheld the two columns would test the absent-value path forever.
      const taskId = params[0]
      const match = [...jobs.values()]
        .filter((j) => j.state === 'active' && j.data && j.data.id === taskId)
        .sort((a, b) => (b.started_on ?? 0) - (a.started_on ?? 0))[0]
      return {
        rows: match ? [{ id: match.id, name: match.name, data: match.data, retry_count: match.retry_count }] : [],
      }
    }
    // list(): the jobs OF THE NAMED QUEUES, LEFT JOINed onto the approval table on the key the
    // live database confirmed — the approval row's id IS the task id the job payload carries.
    //
    // THE `WHERE j.name = ANY($1)` IS MODELLED, not ignored. A fake that answered with every
    // job whatever was asked for would be more generous than the statement it stands for — the
    // exact fault that let a missing method sit green for a release — and it would in
    // particular certify a list() that never asks for the batch queue.
    const withApproval = sql.includes('sma_task_attempts')
    const wanted: string[] | null = Array.isArray(params?.[0]) ? (params[0] as string[]) : null
    return {
      rows: [...jobs.values()]
        .filter((j) => !wanted || wanted.includes(j.name))
        .map((j) => {
          const a = (j.data && attempts.get(j.data.id)) || null
          return {
            id: j.id,
            name: j.name,
            priority: j.priority,
            data: j.data,
            state: j.state,
            retry_count: j.retry_count,
            created_on: j.created_on,
            started_on: j.started_on,
            completed_on: j.completed_on,
            output: j.output,
            ...(withApproval
              ? {
                  approval_status: a ? a.status : null,
                  returned_note: a ? a.returned_note : null,
                  merge_receipt: a ? a.merge_receipt : null,
                }
              : {}),
          }
        }),
    }
  }

  const adapter = createPgBossQueue({ boss, execSql, clock, expireMs, ledgerDir })
  return { adapter, boss, execSql, sendCalls, createQueueCalls, jobs, attempts }
}

// ── the reusable contract suite, run against the pg-boss backend (DI fake boss) ──
queueAdapterContractSuite('pgboss', ({ clock, expireMs }: any) =>
  makeFakeBackend({ clock, expireMs, ledgerDir: mkLedgerDir() }).adapter,
)

// ── pg-boss-specific direct invariants ──

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const backlog = (over: any = {}) => ({
  id: 'BL-196',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  attempt: 1,
  storyPoints: 3,
  acceptance: 'green targeted tests + reverify receipt',
  ...over,
})

describe('pg-boss backend — job-option contract', () => {
  it('every enqueue sends with singletonKey=task.id, expireInSeconds (from expireMs), retryLimit, to the lane queue', async () => {
    const c = mkClock()
    const { adapter, sendCalls } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(backlog())
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].name).toBe('sma.task.prod')
    expect(sendCalls[0].opts.singletonKey).toBe('BL-196')
    expect(sendCalls[0].opts.expireInSeconds).toBe(5) // ceil(5000/1000)
    expect(sendCalls[0].opts.retryLimit).toBe(2)
    expect(sendCalls[0].opts.retryBackoff).toBe(true)
  })

  it('default expireMs maps to expireInSeconds 120 (the plan default)', async () => {
    const c = mkClock()
    const { adapter, sendCalls } = makeFakeBackend({ clock: c.clock, expireMs: 120000 })
    await adapter.enqueue(backlog())
    expect(sendCalls[0].opts.expireInSeconds).toBe(120)
  })

  it('singletonKey coalescing is observable: the second send returns null (coalesced) — one job, counter bumps', async () => {
    const c = mkClock()
    const { adapter, sendCalls, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    const first = await adapter.enqueue(backlog())
    const second = await adapter.enqueue(backlog())
    expect(first.coalesced).toBe(false)
    expect(second.coalesced).toBe(true)
    expect(second.coalesceCount).toBe(2)
    expect(sendCalls).toHaveLength(2) // both sends attempted
    expect(jobs.size).toBe(1) // but only ONE job row exists
  })

  it('complete without a receiptRef throws NoReceiptError and does not mutate the job', async () => {
    const c = mkClock()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await expect(adapter.complete('BL-196', {} as any)).rejects.toBeInstanceOf(NoReceiptError)
    const [r] = await adapter.list({})
    expect(r.status).toBe('claimed') // untouched — still active
  })

  it('fail records a runtime attempt row in the ledger with the failure reason (key link → attempt-ledger)', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.fail('BL-196', 'missing_access')
    const rows = readAttempts(ledgerDir, 'BL-196')
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].failureReason).toBe('missing_access')
  })
})

// ═══ the two clocks of a running task: when it was taken, and when it last said it lives ═════
//
// This backend has no renewal call in its library, so it renews a lease by restamping the job's
// own start clock — and that clock used to be the ONLY answer to «when was this work taken».
// Every live task therefore reported a duration of about zero, refreshed every couple of
// minutes, while the work ran for an hour. The contract suite asserts the split on both
// backends; these cases pin the mechanism THIS one uses, which is the payload write.

describe('the claim time and the lease clock are two different writes', () => {
  it('a renewal writes the LEASE only — the claim time in the payload is never touched', async () => {
    const c = mkClock(1000)
    const statements: string[] = []
    const { boss, execSql, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000 })
    const adapter = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        statements.push(sql)
        return execSql(sql, params)
      },
      clock: c.clock,
      expireMs: 60000,
    })
    await adapter.enqueue(backlog())
    await adapter.claimNext('daemon', {})

    const job = [...jobs.values()][0]
    expect(job.data.claimedAt).toBe(1000) // the claim recorded in the payload, at the claim

    c.advance(30000)
    statements.length = 0
    await adapter.touch('BL-196')

    // The renewal's statements, named: the lease is restamped and the payload is not written.
    expect(statements.some((s) => s.includes('started_on = now()'))).toBe(true)
    expect(statements.some((s) => s.includes('claimedAt'))).toBe(false)
    expect(job.data.claimedAt).toBe(1000) // unmoved by the renewal
    expect(job.started_on).toBe(31000) // the lease clock did move

    const [row] = await adapter.list({})
    expect(row.claimedAt).toBe(1000) // «how long has this been running» is measured from here
    expect(row.leaseRenewedAt).toBe(31000)
  })

  it('a row claimed BEFORE the claim time was recorded falls back to the lease clock, never to nothing', async () => {
    const c = mkClock(1000)
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000 })
    await adapter.enqueue(backlog())
    await adapter.claimNext('daemon', {})
    // The pre-existing row: an active job whose payload never carried a claim time, because it
    // was fetched by the version that had only one clock. It states a real time — the one that
    // version recorded — rather than an absence a screen would have to explain.
    const job = [...jobs.values()][0]
    delete job.data.claimedAt
    delete job.data.claimedAtRetry

    const [row] = await adapter.list({})
    expect(row.claimedAt).toBe(job.started_on)
    expect(row.claimedAt).not.toBeNull()
    expect(row.leaseRenewedAt).toBe(job.started_on)
  })
})

// ═══ the attempt stamp on the ADAPTER's own rows (2026-08-05) ═══════
//
// Until this landed the backend's two `recordAttempt` call sites passed none of the seven
// stamp fields and no status change was ever routed through `applyTransition`. These cases
// pin what the adapter can now truthfully say — and, just as deliberately, what it cannot.

describe('the queue adapter stamps the attempt row it writes', () => {
  it('complete() routes RUNNING -> PRODUCED through the machine and stamps key, version, attempt and envelope digest', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green', workerId: 'w1' })

    const [row] = readAttempts(ledgerDir, 'BL-196')
    expect(row.attempt).toBe(1) // the number the QUEUE holds, not one the caller supplied
    expect(row.stateMachineVersion).toBe(STATE_MACHINE_VERSION)
    expect(row.idempotencyKey).toBe(idempotencyKey('BL-196', 'BL-196#1', 'RUNNING->PRODUCED'))
    // The envelope reaches the durable row as a DIGEST and never as paths.
    expect(row.capabilityEnvelopeHash).toBe(envelopeHash(defaultEnvelope('prod')))
    expect(row.capabilityEnvelope).toBeUndefined()
  })

  it('fail() routes RUNNING -> RETRYABLE, and the key is the one of the attempt the QUEUE names', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    // A task already on its second attempt: the number rides in the job payload, and the
    // adapter reads it from there rather than defaulting to 1 about itself.
    await adapter.enqueue(backlog({ id: 'BL-A2', attempt: 2 }))
    await adapter.claimNext('w1', {})
    await adapter.fail('BL-A2', 'tests_red')

    const [row] = readAttempts(ledgerDir, 'BL-A2')
    expect(row.attempt).toBe(2)
    expect(row.idempotencyKey).toBe(idempotencyKey('BL-A2', 'BL-A2#2', 'RUNNING->RETRYABLE'))
    // A different attempt of the SAME task is a different key by construction — that is the
    // half of fleet invariant 5 the queue layer has to keep from its side.
    expect(row.idempotencyKey).not.toBe(idempotencyKey('BL-A2', 'BL-A2#1', 'RUNNING->RETRYABLE'))
  })

  it('leaves the four fields it cannot observe ABSENT rather than inventing them', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green' })

    const [row] = readAttempts(ledgerDir, 'BL-196')
    // policyVersion: the daemon's routing policy carries no version.
    // memorySnapshotHash: the backend does not know which corpus the worker read (the tick does).
    // harnessVersion: nothing in this process observes the agent CLI's version.
    // planHash: a task has a title and an acceptance sentence, not a plan document.
    for (const absent of ['policyVersion', 'memorySnapshotHash', 'harnessVersion', 'planHash']) {
      expect(Object.hasOwn(row, absent)).toBe(false)
    }
  })

  it('a seam that does not surface the job payload writes NO stamp instead of a guessed one', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    // The pre-2026-08-05 fake: the active-job resolution answers with id and name only.
    const { adapter: full, boss } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    const narrow = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        const res: any = await (full as any).execSql(sql, params)
        if (!sql.includes("state = 'active'")) return res
        return { rows: res.rows.map((r: any) => ({ id: r.id, name: r.name })) }
      },
      clock: c.clock,
      expireMs: 5000,
      ledgerDir,
    })
    await narrow.enqueue(backlog({ id: 'BL-NARROW' }))
    await narrow.claimNext('w1', {})
    await narrow.fail('BL-NARROW', 'agent_error')

    const [row] = readAttempts(ledgerDir, 'BL-NARROW')
    expect(row.failureReason).toBe('agent_error') // the row is still written, in full
    for (const absent of ['attempt', 'idempotencyKey', 'stateMachineVersion', 'capabilityEnvelopeHash']) {
      expect(Object.hasOwn(row, absent)).toBe(false)
    }
  })
})

// ═══ the approval row is read back, and only where it may speak ═══════════════════════
//
// Writing the row was half a sentence: while list() read the job table alone, work that had
// finished and was waiting for a person looked exactly like work a person had accepted, so
// the screen showing what waits had nothing to draw and its counter read zero. These cases
// pin the join, the one place the side table is allowed to overrule pg-boss, and the
// fail-open that keeps a restricted database from costing the rows themselves.

describe('the approval row reaches the read path', () => {
  it('completed work is reported as awaiting approval, and stats() moves it out of completed', async () => {
    const c = mkClock()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green' })

    // the durable half: complete() wrote the row through the very seam list() reads
    expect(attempts.get('BL-196').status).toBe('awaiting_approval')

    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
    expect(await adapter.list({ status: 'awaiting_approval' })).toHaveLength(1)

    const s = await adapter.stats()
    expect(s.awaiting_approval).toBe(1)
    // ONE population, read twice — counting it in both places would make stats() disagree
    // with list(), where a row holds exactly one status.
    expect(s.completed).toBe(0)
    expect(s.total).toBe(1)
  })

  it('a decided task does NOT leave the closed vocabulary: approved reads as completed, not as "approved"', async () => {
    const c = mkClock()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green' })
    // the front's approve path CASed the row to its decided value
    attempts.set('BL-196', { status: 'approved', merge_receipt: 'merge:abc' })

    const [row] = await adapter.list({})
    expect(row.status).toBe('completed') // the night's finished work still has a place to appear
    expect(row.mergeReceipt).toBe('merge:abc')
    expect((await adapter.stats()).awaiting_approval).toBe(0)
  })

  it('the side table may speak ONLY about finished work: a live claim is never overruled', async () => {
    const c = mkClock()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    // a stale row from a PREVIOUS decision on the same task, while the job is active again
    attempts.set('BL-196', { status: 'approved' })
    expect((await adapter.list({}))[0].status).toBe('claimed')

    attempts.set('BL-196', { status: 'awaiting_approval' })
    expect((await adapter.list({}))[0].status).toBe('claimed') // still running — nobody is waiting yet
  })

  it('FAIL-OPEN: a database that refuses the approval join still answers about the WORK', async () => {
    const c = mkClock()
    const logged: string[] = []
    const { boss, execSql } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    // the restricted database: every statement naming the approval table is refused —
    // the join, the counter and the write alike (no CREATE right, the approval-store case)
    const restricted = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        if (sql.includes('sma_task_attempts')) throw new Error('permission denied for relation sma_task_attempts')
        return execSql(sql, params)
      },
      clock: c.clock,
      expireMs: 5000,
      log: (m: string) => logged.push(m),
    })
    await restricted.enqueue(backlog({ id: 'BL-OPEN' }))
    await restricted.claimNext('w1', {})
    await restricted.complete('BL-OPEN', { receiptRef: 'reverify:green' })

    const rows = await restricted.list({}) // does not throw
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed') // the job's own state, the pre-join reading
    expect((await restricted.stats()).awaiting_approval).toBe(0)
    expect(logged.some((m) => m.includes('approval join unavailable'))).toBe(true)
    // one broken permission polled every few seconds is still ONE log line
    expect(logged.filter((m) => m.includes('approval join unavailable'))).toHaveLength(1)
  })
})

describe('pg-boss backend — start() lane provisioning', () => {
  it('start() creates the dead-letter queue FIRST, then the four lane queues and the batch queue with the shared deadLetter', async () => {
    const c = mkClock()
    const { adapter, createQueueCalls } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.start()
    // pg-boss v11 rejects a lane queue whose deadLetter target does not exist yet
    // (the pilot fresh-boot finding) — the shared dead queue must be provisioned first.
    // The batch queue is provisioned like the lanes and fetched like none of them: that is
    // what keeps the request of a batch structurally out of a worker's hands.
    expect(createQueueCalls.map((x) => x.name)).toEqual([
      'sma.task.dead',
      'sma.task.prod',
      'sma.task.research',
      'sma.task.paperwork',
      'sma.task.forge',
      'sma.batch',
    ])
    expect(createQueueCalls[0].opts?.deadLetter).toBeUndefined()
    for (const call of createQueueCalls.slice(1)) expect(call.opts.deadLetter).toBe(DEAD_LETTER_QUEUE)
    // exported vocabulary matches
    expect([...TASK_QUEUE_LANES]).toEqual(['prod', 'research', 'paperwork', 'forge'])
    expect(BATCH_PARENT_QUEUE).toBe('sma.batch')
    expect(TASK_QUEUE_LANES.map((l) => `sma.task.${l}`)).not.toContain(BATCH_PARENT_QUEUE)
  })
})

/**
 * THE DURABLE HALF OF «THE REQUEST IS NEVER HANDED OUT».
 *
 * The contract suite asserts the PROMISE against every backend; these two cases assert the
 * MECHANISM this backend keeps it with, because the mechanism is a layout decision a later
 * edit could undo without any promise visibly breaking first: the parent is SENT somewhere
 * `fetch` never looks, and claimNext fetches lane queues only.
 */
describe('pg-boss backend — a batch request is not sent where a fetch can reach it', () => {
  const parent = (batchId: string) => ({
    id: batchId,
    source: 'roster',
    title: 'разгреби мелочь перед демо',
    lane: 'prod',
    batchId,
    data: { batch: 'parent' },
  })

  it('the request goes to the batch queue and the items to their lanes — and no fetch ever names the batch queue', async () => {
    const c = mkClock()
    const { adapter, sendCalls, boss } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    const fetched: string[] = []
    const realFetch = boss.fetch.bind(boss)
    boss.fetch = async (name: string, options: any) => {
      fetched.push(name)
      return realFetch(name, options)
    }

    await adapter.enqueue(parent('B-77'))
    await adapter.enqueue({ id: 'B-77-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-77' })

    expect(sendCalls.map((x) => x.name)).toEqual(['sma.batch', 'sma.task.prod'])

    const claimed = await adapter.claimNext('w1', {})
    expect(claimed.id).toBe('B-77-1')
    expect(await adapter.claimNext('w2', {})).toBeNull()
    expect(fetched).not.toContain('sma.batch')
  })

  it('the request is READ back with the work — a list that hides it leaves a screen with loose items', async () => {
    const c = mkClock()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(parent('B-78'))
    await adapter.enqueue({ id: 'B-78-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-78' })

    const rows = await adapter.list({})
    const row = rows.find((r: any) => r.id === 'B-78')
    expect(row).toBeTruthy()
    expect(row.batchId).toBe('B-78')
    expect(row.data.batch).toBe('parent')
    expect(rows.find((r: any) => r.id === 'B-78-1').batchId).toBe('B-78')
  })
})

// ── attempt-ledger direct invariants (Task 2) ──
describe('attempt-ledger — append-only per-task history', () => {
  it('recordAttempt appends and readAttempts returns rows ordered by attempt number', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-9', attempt: 2, outcome: 'failed', failureReason: 'agent_error' })
    recordAttempt(dir, { taskId: 'BL-9', attempt: 1, outcome: 'failed', failureReason: 'timeout' })
    recordAttempt(dir, { taskId: 'BL-9', attempt: 3, outcome: 'completed', receiptRef: 'reverify:ok' })
    const rows = readAttempts(dir, 'BL-9')
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(rows[2].receiptRef).toBe('reverify:ok')
    expect(rows[0].failureReason).toBe('timeout')
  })

  it('readAttempts on a missing ledger is fail-open ([])', () => {
    const dir = mkLedgerDir()
    expect(readAttempts(dir, 'BL-none')).toEqual([])
  })

  it('recordAttempt drops keys outside the allowlist (explicit-pick)', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-x', outcome: 'completed', secret: 'nope' } as any)
    const [row] = readAttempts(dir, 'BL-x')
    expect(row.outcome).toBe('completed')
    expect((row as any).secret).toBeUndefined()
  })
})
