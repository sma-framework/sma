/**
 * Tests for daemon/src/queue/pgboss-backend.mjs (Phase 49.5 Plan 03, Task 1) +
 * daemon/src/queue/attempt-ledger.mjs (Task 2, direct invariants).
 *
 * The pg-boss backend is a certified QueueAdapter: it re-runs the SAME
 * `queueAdapterContractSuite` the in-memory reference passes (plan 49.5-01), here
 * against a STATEFUL FAKE pg-boss (send/fetch/touch/complete/fail/getQueueStats over
 * Maps, honouring singletonKey + priority + expireInSeconds) plus a fake execSql over
 * the same store. NO live Postgres, NO real pg-boss is ever loaded (boss is injected).
 *
 * Direct grep-visible invariants pinned below:
 *   - every enqueue send carries singletonKey=task.id + expireInSeconds (recorded)
 *   - singletonKey coalescing is observable via the send-call recorder
 *   - complete() without a receiptRef throws NoReceiptError (Pitfall 6)
 *   - start() creates the four lane queues idempotently with a shared deadLetter
 *   - recordAttempt/readAttempts append-and-read the per-task ledger (Task 2)
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPgBossQueue,
  TASK_QUEUE_LANES,
  DEAD_LETTER_QUEUE,
} from '../src/queue/pgboss-backend.mjs'
import { queueAdapterContractSuite, NoReceiptError } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts } from '../src/queue/attempt-ledger.mjs'

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
      const avail = [...jobs.values()].filter((j) => j.name === name && j.state === 'created')
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
    async touch(_name: string, id: string) {
      const j = jobs.get(id)
      if (j && j.state === 'active') j.started_on = now()
      return true
    },
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
    if (sql.includes("state = 'active'")) {
      // taskId → active job resolution (touch/complete/fail)
      const taskId = params[0]
      const match = [...jobs.values()]
        .filter((j) => j.state === 'active' && j.data && j.data.id === taskId)
        .sort((a, b) => (b.started_on ?? 0) - (a.started_on ?? 0))[0]
      return { rows: match ? [{ id: match.id, name: match.name }] : [] }
    }
    // list(): all jobs; the adapter maps + filters
    return {
      rows: [...jobs.values()].map((j) => ({
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
      })),
    }
  }

  const adapter = createPgBossQueue({ boss, execSql, clock, expireMs, ledgerDir })
  return { adapter, boss, sendCalls, createQueueCalls, jobs }
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
    expect(jobs.size).toBe(1) // but only ONE job row exists (Pattern 5)
  })

  it('complete without a receiptRef throws NoReceiptError (Pitfall 6) and does not mutate the job', async () => {
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

describe('pg-boss backend — start() lane provisioning', () => {
  it('start() creates the dead-letter queue FIRST, then the four lane queues with the shared deadLetter', async () => {
    const c = mkClock()
    const { adapter, createQueueCalls } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.start()
    // pg-boss v11 rejects a lane queue whose deadLetter target does not exist yet
    // (BL-194 pilot fresh-boot finding) — the shared dead queue must be provisioned first.
    expect(createQueueCalls.map((x) => x.name)).toEqual([
      'sma.task.dead',
      'sma.task.prod',
      'sma.task.research',
      'sma.task.paperwork',
      'sma.task.forge',
    ])
    expect(createQueueCalls[0].opts?.deadLetter).toBeUndefined()
    for (const call of createQueueCalls.slice(1)) expect(call.opts.deadLetter).toBe(DEAD_LETTER_QUEUE)
    // exported vocabulary matches
    expect([...TASK_QUEUE_LANES]).toEqual(['prod', 'research', 'paperwork', 'forge'])
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
