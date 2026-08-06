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
  backfillProject,
  DEFAULT_PROJECT_ID,
  TASK_SOURCES,
  TASK_LANES,
  FAIL_REASONS,
  REASON_LABELS,
  NoReceiptError,
  NotReadyError,
  InvalidStoryPointsError,
  InvalidTaskError,
  DEFAULT_EXPIRE_MS,
  resolveExpireMs,
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

/**
 * ONE LIVENESS CLOCK. The sweep that requeues a silent worker and the queue's own lease
 * expiry are two mechanisms answering the same question, and they used to read two
 * different values: the config's expiry reached the sweep and never reached the queue,
 * whose lease then always ran on the built-in default. This resolver is the single place
 * that turns a config into that one number, so the two cannot drift apart by construction.
 */
describe('resolveExpireMs — the ONE liveness value both the sweep and the lease read', () => {
  it('a config that names no expiry yields the shipped default', () => {
    expect(resolveExpireMs({})).toBe(DEFAULT_EXPIRE_MS)
    expect(resolveExpireMs(undefined)).toBe(DEFAULT_EXPIRE_MS)
    expect(DEFAULT_EXPIRE_MS).toBe(120000)
  })

  it('an operator value is honoured exactly', () => {
    expect(resolveExpireMs({ expireMs: 300000 })).toBe(300000)
    expect(resolveExpireMs({ expireMs: 1 })).toBe(1)
  })

  /**
   * A hand-edited config is a trust boundary: this number now reaches pg-boss, where it is
   * divided by 1000 and sent as `expireInSeconds`. NaN or a negative would make a lease of
   * nonsense out of a typo, so anything that is not a positive finite number falls back to
   * the default instead of travelling on.
   */
  it('refuses a value that is not a positive finite number and falls back to the default', () => {
    for (const bad of ['5m', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}, []]) {
      expect(resolveExpireMs({ expireMs: bad as any }), `expireMs=${String(bad)}`).toBe(DEFAULT_EXPIRE_MS)
    }
  })
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

// ── V5.1: the project field on a task (D-9.7-01) + the read-time backfill (D-9.7-08) ──

describe('project — an additive task field with an injected default (D-9.7-01)', () => {
  it('validateTask accepts an optional project slug and rejects a malformed one', () => {
    expect(validateTask(backlog({ project: 'acme-clinic' })).project).toBe('acme-clinic')
    expect(validateTask(backlog()).project).toBeUndefined()
    expect(() => validateTask(backlog({ project: 'Acme Clinic' }))).toThrow(InvalidTaskError)
    expect(() => validateTask(backlog({ project: 'a'.repeat(65) }))).toThrow(InvalidTaskError)
  })

  it('does NOT check the project against a registry — that is the door\'s job, not the adapter\'s', () => {
    // Structural only: an unknown-but-well-formed slug passes the adapter untouched.
    expect(validateTask(backlog({ project: 'never-registered' })).project).toBe('never-registered')
  })

  it('a task enqueued with no project gets the adapter\'s active project', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue(backlog())
    const [row] = await q.list({})
    expect(row.project).toBe('acme-clinic')
    const claimed = await q.claimNext('w1', {})
    expect(claimed.project).toBe('acme-clinic')
  })

  it('an explicit project survives the enqueue unchanged', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue(backlog({ project: 'other-shop' }))
    const [row] = await q.list({})
    expect(row.project).toBe('other-shop')
  })

  it('BACKFILL ON READ — a row stored before the field existed reads with a default, never throws', async () => {
    // The pure helper is what every read path runs a row through.
    expect(backfillProject({ id: 'BL-old', lane: 'prod' }, 'acme-clinic')).toMatchObject({
      id: 'BL-old',
      project: 'acme-clinic',
    })
    expect(backfillProject({ id: 'BL-old' }, undefined).project).toBe(DEFAULT_PROJECT_ID)
    expect(backfillProject(null, 'acme')).toBeNull()

    // End-to-end: an adapter with NO active project configured (the pre-V5.1 composition
    // root) stores no project, and every read still hands one back.
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    const [row] = await q.list({})
    expect(row.project).toBe(DEFAULT_PROJECT_ID)
  })

  it('list accepts an optional project filter; no filter means every project', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue(backlog({ id: 'BL-a' }))
    await q.enqueue(backlog({ id: 'BL-b', project: 'other-shop' }))
    expect(await q.list({})).toHaveLength(2)
    expect((await q.list({ project: 'other-shop' })).map((r: any) => r.id)).toEqual(['BL-b'])
    expect((await q.list({ project: 'acme-clinic' })).map((r: any) => r.id)).toEqual(['BL-a'])
    expect(await q.list({ project: 'nobody' })).toHaveLength(0)
  })

  it('lane and project are INDEPENDENT dimensions — a forge task in another project is valid', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue({
      id: 'F-9',
      source: 'roster',
      title: 'make an agent',
      lane: 'forge',
      project: 'other-shop',
      forge: { kind: 'agent', description: 'parses invoices' },
    })
    const [row] = await q.list({ project: 'other-shop' })
    expect(row.lane).toBe('forge')
    expect(row.project).toBe('other-shop')
  })
})

describe('constants — taxonomy (D-9.5-11)', () => {
  it('FAIL_REASONS is the 10-reason human taxonomy and is frozen', () => {
    expect(FAIL_REASONS).toEqual([
      'no_receipt',
      'no_journal',
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
