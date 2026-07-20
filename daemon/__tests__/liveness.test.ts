/**
 * Tests for daemon/src/queue/liveness.mjs (Phase 9.5 Plan 03, Task 3) +
 * daemon/src/queue/cas.mjs (Task 2, CAS lost-race cases live here per the plan).
 *
 * Liveness contract (Paperclip §8 as ТЗ): «every non-terminal task must have a durable
 * live path». The sweep audits DURABLE state only (fake adapter + fake ledger, frozen
 * clocks — no in-memory task registry, no live Postgres):
 *   - queued task → OK (audited, not requeued)
 *   - active + fresh touch → OK
 *   - active + STALE touch → fail(runtime_offline) + attempt row + requeue (attempt+1)
 *   - kill-drill: daemon death mid-task → task back to queued, attempt+1, ledger row
 *   - computeCooldownMs exponential throttle at n=2,3,4,10
 *   - CAS: won on 1 row, LOST (no throw) on 0 rows; claim generation in the WHERE
 */

import { describe, it, expect } from 'vitest'

import { livenessSweep, computeCooldownMs } from '../src/queue/liveness.mjs'
import { casTransition } from '../src/queue/cas.mjs'

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ── a minimal fake QueueAdapter: fail() mirrors the pg-boss retry-on-fail semantics
// (requeue the SAME record with attempt+1 while retries remain) AND writes the durable
// attempt row via the injected ledger, exactly as pgboss-backend.fail() does. ──
function makeFakeAdapter({ clock, ledger }: { clock: () => number; ledger?: any }) {
  const now = () => clock()
  const recs = new Map<string, any>()
  return {
    _seed(rec: any) {
      recs.set(rec.id, { ...rec })
    },
    async list() {
      return [...recs.values()].map((r) => ({ ...r }))
    },
    async fail(id: string, reason: string) {
      const r = recs.get(id)
      if (!r) return false
      if (ledger && typeof ledger.recordAttempt === 'function') {
        ledger.recordAttempt({
          taskId: id,
          attempt: r.attempt,
          outcome: 'failed',
          failureReason: reason,
          endedAt: new Date(now()).toISOString(),
        })
      }
      if (r.attempt < (r.maxAttempts ?? 3)) {
        r.status = 'queued' // pg-boss auto-retry: same row back to the queue
        r.attempt += 1
        r.claimedAt = null
      } else {
        r.status = 'failed'
        r.failure_reason = reason
      }
      return true
    },
    async touch(id: string) {
      const r = recs.get(id)
      if (r && r.status === 'claimed') {
        r.claimedAt = now()
        return true
      }
      return false
    },
  }
}

function makeFakeLedger() {
  const rows: any[] = []
  return {
    recordAttempt: (a: any) => {
      rows.push(a)
      return a
    },
    readAttempts: (taskId: string) => rows.filter((r) => r.taskId === taskId),
    _rows: rows,
  }
}

const claimed = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'x',
  lane: 'prod',
  status: 'claimed',
  attempt: 1,
  claimedAt: 1000,
  ...over,
})

describe('livenessSweep — durable live-path audit', () => {
  it('a queued task is a durable live path — audited, never requeued', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ status: 'queued', claimedAt: null }))
    c.advance(500000)
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(1)
    expect(res.requeued).toBe(0)
    const [row] = await adapter.list()
    expect(row.status).toBe('queued')
  })

  it('an active task with a fresh touch is OK — audited, not requeued', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ claimedAt: 1000 }))
    c.advance(60000) // < expireMs, still fresh
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(1)
    expect(res.requeued).toBe(0)
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed')
  })

  it('terminal tasks (completed/failed) carry no live-path obligation — not audited', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-done', status: 'completed' }))
    adapter._seed(claimed({ id: 'BL-dead', status: 'failed' }))
    c.advance(500000)
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(0)
    expect(res.requeued).toBe(0)
  })

  it('kill-drill: daemon death mid-task requeues the task with attempt+1 and a runtime_offline attempt row (zero lost state)', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    // A task is claimed and running; then the daemon is KILLED — no complete/fail ever
    // fires, and the touch clock stops. Time advances well past expiry.
    adapter._seed(claimed({ id: 'BL-1', status: 'claimed', attempt: 1, claimedAt: 1000 }))
    c.advance(200000) // past expireMs (120000), no touch — the worker/daemon died

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })

    const [row] = await adapter.list()
    expect(row.status).toBe('queued') // back in the queue
    expect(row.attempt).toBe(2) // attempt+1
    expect(res.requeued).toBe(1)
    const attempts = ledger.readAttempts('BL-1')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].failureReason).toBe('runtime_offline')
  })

  it('a task with >= 2 prior no-progress attempts is throttled on requeue (Pattern 4)', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    // two prior failed attempts already on record
    ledger.recordAttempt({ taskId: 'BL-1', attempt: 1, outcome: 'failed', failureReason: 'runtime_offline' })
    ledger.recordAttempt({ taskId: 'BL-1', attempt: 2, outcome: 'failed', failureReason: 'runtime_offline' })
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', attempt: 3, claimedAt: 1000, maxAttempts: 9 }))
    c.advance(200000)
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.requeued).toBe(1)
    expect(res.throttled).toBe(1) // noProgress = 2 prior + 1 = 3 → cooldown > 0
  })
})

describe('computeCooldownMs — exponential rewake throttle', () => {
  it('is 0 for the first run and grows exponentially, capped at 30 min', () => {
    expect(computeCooldownMs(0)).toBe(0)
    expect(computeCooldownMs(1)).toBe(0)
    expect(computeCooldownMs(2)).toBe(120000)
    expect(computeCooldownMs(3)).toBe(240000)
    expect(computeCooldownMs(4)).toBe(480000)
    expect(computeCooldownMs(10)).toBe(1800000) // capped
  })
})

// ── CAS transition (cas.mjs) — lost-race + claim generation ──
describe('casTransition — lock-free compare-and-set', () => {
  // a recorder execSql: returns a configurable row set, records (sql, params)
  const recorder = (rows: any[]) => {
    const calls: any[] = []
    const fn = async (sql: string, params: any[]) => {
      calls.push({ sql, params })
      return { rows }
    }
    return { fn, calls }
  }

  it('wins on a 1-row UPDATE', async () => {
    const { fn } = recorder([{ id: 'BL-1' }])
    const res = await casTransition(fn, {
      table: 'sma_task_attempts',
      id: 'BL-1',
      from: 'awaiting_approval',
      to: 'returned',
    })
    expect(res.won).toBe(true)
  })

  it('LOSES the race on a 0-row UPDATE — returns {won:false}, never throws', async () => {
    const { fn } = recorder([]) // zero rows = a newer claimer already moved the row
    const res = await casTransition(fn, {
      table: 'sma_task_attempts',
      id: 'BL-1',
      from: 'awaiting_approval',
      to: 'returned',
    })
    expect(res.won).toBe(false)
  })

  it('a stale claimer loses: the claim generation (dispatched_at) is in the WHERE + bound as a param', async () => {
    const { fn, calls } = recorder([])
    await casTransition(fn, {
      table: 'sma_task_attempts',
      id: 'BL-1',
      from: 'awaiting_approval',
      to: 'returned',
      dispatchedAt: '2026-07-17T10:00:00Z',
      extra: { returned_note: 'stale' },
    })
    const { sql, params } = calls[0]
    expect(sql).toMatch(/dispatched_at = \$\d/)
    expect(sql).toMatch(/status = \$\d/)
    expect(sql).toMatch(/RETURNING id/)
    expect(params).toContain('2026-07-17T10:00:00Z') // claim generation bound as a param
    expect(params).toContain('stale') // extra SET value bound too
  })

  it('throws on programmer errors (missing execSql / table / id), not on a lost race', async () => {
    await expect(
      casTransition(undefined as any, { table: 't', id: 1, from: 'a', to: 'b' }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})
