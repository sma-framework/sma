/**
 * Tests for daemon/src/queue/adapter.mjs (Phase 9.5 Plan 01, Task 3).
 *
 * The D-9.5-02c QueueAdapter seam — an EXECUTABLE contract any backend (the
 * in-memory reference now, pg-boss in plan 9.5-03, a file backend later) must pass:
 *   - queueAdapterContractSuite('memory', …) runs the full describe/it block against
 *     createMemoryQueue with an injected fake clock (this is what makes the seam
 *     honest — plan 03 re-runs THIS suite against pg-boss).
 *   - Direct unit tests below pin the grep-visible invariants in the test file itself:
 *     the NoReceiptError refusal (Pitfall 6), enqueue coalescing (Pattern 5), the
 *     D-9.5-10 DoR gate (NotReadyError / InvalidStoryPointsError), the forge rule
 *     (D-9.5-09), and the enqueuedAt/claimedAt/completedAt timestamps (D-9.5-10).
 *   - Constants: FAIL_REASONS is the 9-reason human taxonomy (D-9.5-11) and
 *     REASON_LABELS carries a RU подпись for every one.
 */

import { describe, it, expect } from 'vitest'

import {
  createMemoryQueue,
  queueAdapterContractSuite,
  validateTask,
  TASK_SOURCES,
  TASK_LANES,
  FAIL_REASONS,
  REASON_LABELS,
  NoReceiptError,
  NotReadyError,
  InvalidStoryPointsError,
  InvalidTaskError,
} from '../src/queue/adapter.mjs'

// ── the reusable contract suite, run against the in-memory reference backend ──
queueAdapterContractSuite('memory', ({ clock, expireMs }) => createMemoryQueue({ clock, expireMs }))

// ── grep-visible direct invariants (test-file local) ──

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const backlog = (over: any = {}) => ({
  id: 'BL-96',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  attempt: 1,
  storyPoints: 3,
  acceptance: 'green tests + reverify receipt',
  ...over,
})

describe('validateTask — DoR gate (D-9.5-10) + forge (D-9.5-09)', () => {
  it('rejects a backlog task missing storyPoints with NotReadyError', () => {
    expect(() => validateTask(backlog({ storyPoints: undefined }))).toThrow(NotReadyError)
  })

  it('rejects a backlog task missing acceptance with NotReadyError', () => {
    expect(() => validateTask(backlog({ acceptance: undefined }))).toThrow(NotReadyError)
  })

  it('rejects non-Fibonacci storyPoints with InvalidStoryPointsError', () => {
    expect(() => validateTask(backlog({ storyPoints: 4 }))).toThrow(InvalidStoryPointsError)
  })

  it('accepts a roster task WITHOUT storyPoints/acceptance (founder-explicit is exempt)', () => {
    const out = validateTask({ id: 'R-1', source: 'roster', title: 'expedite', lane: 'prod' })
    expect(out.id).toBe('R-1')
    expect(out.priority).toBe(0)
    expect(out.attempt).toBe(1)
  })

  it('requires a forge object iff lane is forge, and forbids it otherwise', () => {
    expect(() =>
      validateTask({ id: 'F-1', source: 'roster', title: 'make agent', lane: 'forge' }),
    ).toThrow(InvalidTaskError)
    const ok = validateTask({
      id: 'F-1',
      source: 'roster',
      title: 'make agent',
      lane: 'forge',
      forge: { kind: 'agent', description: 'parses twitter' },
    })
    expect(ok.forge.kind).toBe('agent')
    expect(() => validateTask(backlog({ forge: { kind: 'agent', description: 'x' } }))).toThrow(InvalidTaskError)
  })

  it('caps title at 200 chars', () => {
    expect(() => validateTask(backlog({ title: 'x'.repeat(201) }))).toThrow(InvalidTaskError)
  })
})

describe('memory backend — receipt refusal, coalescing, timestamps', () => {
  it('complete refuses without a receipt — throws NoReceiptError (no self-certified done)', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await expect(q.complete('BL-96', { note: 'looks done' })).rejects.toThrow(NoReceiptError)
    await expect(q.complete('BL-96', { receiptRef: 'reverify:abc' })).resolves.toBeTruthy()
  })

  it('enqueue of the same id while pending coalesces to ONE entry with a counter (Pattern 5)', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    const second = await q.enqueue(backlog())
    expect(second.coalesced).toBe(true)
    expect(second.coalesceCount).toBe(2)
    const rows = await q.list({ status: 'queued' })
    expect(rows).toHaveLength(1)
    expect(rows[0].coalesceCount).toBe(2)
  })

  it('stamps enqueuedAt / claimedAt / completedAt across the transitions (D-9.5-10)', async () => {
    const c = mkClock(5000)
    const q = createMemoryQueue({ clock: c.clock, expireMs: 10000 })
    await q.enqueue(backlog())
    c.advance(100)
    await q.claimNext('w1', {})
    c.advance(100)
    await q.complete('BL-96', { receiptRef: 'reverify:abc' })
    const [row] = await q.list({})
    expect(row.enqueuedAt).toBe(5000)
    expect(row.claimedAt).toBe(5100)
    expect(row.completedAt).toBe(5200)
  })

  it('fail(taskId, reason) rejects an unknown reason and records a valid one', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await expect(q.fail('BL-96', 'not_a_reason')).rejects.toThrow()
    await q.fail('BL-96', 'tests_red')
    const [row] = await q.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('tests_red')
  })
})

describe('constants — taxonomy (D-9.5-11)', () => {
  it('FAIL_REASONS is the 9-reason human taxonomy and is frozen', () => {
    expect(FAIL_REASONS).toEqual([
      'no_receipt',
      'agent_error',
      'tests_red',
      'needs_decision',
      'missing_access',
      'timeout',
      'runtime_offline',
      'window_exhausted',
      'manual',
    ])
    expect(Object.isFrozen(FAIL_REASONS)).toBe(true)
  })

  it('REASON_LABELS carries a RU подпись for every FAIL_REASON', () => {
    for (const reason of FAIL_REASONS) {
      expect(typeof REASON_LABELS[reason]).toBe('string')
      expect(REASON_LABELS[reason].length).toBeGreaterThan(0)
    }
  })

  it('TASK_LANES includes forge and TASK_SOURCES the three intake origins', () => {
    expect(TASK_LANES).toContain('forge')
    expect(TASK_SOURCES).toEqual(['backlog', 'roster', 'return'])
  })
})
