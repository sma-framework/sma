/**
 * Tests for daemon/src/queue/adapter.mjs.
 *
 * The QueueAdapter seam — an EXECUTABLE contract any backend (the
 * in-memory reference now, pg-boss next, a file backend later) must pass:
 *   - queueAdapterContractSuite('memory', …) runs the full describe/it block against
 *     createMemoryQueue with an injected fake clock (this is what makes the seam
 *     honest — the pg-boss suite re-runs THIS block against a real backend).
 *   - Direct unit tests below pin the grep-visible invariants in the test file itself:
 *     the NoReceiptError refusal, enqueue coalescing, the DoR gate
 *     (NotReadyError / InvalidStoryPointsError), the forge rule, the
 *     enqueuedAt/claimedAt/completedAt timestamps, and — since completed work is
 *     reported as awaiting approval — that a receipted complete() leaves the row in
 *     `awaiting_approval` with a stats() counter to match.
 *   - Constants: FAIL_REASONS is the 11-reason human taxonomy and
 *     REASON_LABELS carries a RU подпись for every one.
 *   - The `data` envelope: which EXIT GATE a task must pass rides in `data.kind` /
 *     `data.stage`, and the enqueue gate is fail-closed about both — a typo can never
 *     fall through to the other kind's gate.
 */

import { describe, it, expect } from 'vitest'

import {
  createMemoryQueue,
  queueAdapterContractSuite,
  validateTask,
  acceptanceItems,
  backfillProject,
  DEFAULT_PROJECT_ID,
  TASK_SOURCES,
  TASK_LANES,
  TASK_STATUSES,
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

describe('validateTask — DoR gate + forge', () => {
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

  it('enqueue of the same id while pending coalesces to ONE entry with a counter', async () => {
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

  it('stamps enqueuedAt / claimedAt / completedAt across the transitions', async () => {
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

  /**
   * Completed work is reported as awaiting approval. The receipt is the worker's half of
   * «done»; the other half is a person, and until that word arrives the row says so out
   * loud instead of parking in a status that means the business is finished.
   */
  it('a receipted complete() leaves the row awaiting_approval — never completed', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await q.complete('BL-96', { receiptRef: 'reverify:abc' })
    const [row] = await q.list({})
    expect(row.status).toBe('awaiting_approval')
    const s = await q.stats()
    expect(s.awaiting_approval).toBe(1)
    expect(s.completed).toBe(0)
  })

  it('stats() carries a key for EVERY status of the closed vocabulary, at zero when empty', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    const s = await q.stats()
    for (const status of TASK_STATUSES) expect(s[status]).toBe(0)
    expect(s.total).toBe(0)
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

// ── V5.1: the project field on a task + the read-time backfill ──

describe('project — an additive task field with an injected default', () => {
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

describe('constants — taxonomy', () => {
  it('FAIL_REASONS is the 11-reason human taxonomy and is frozen', () => {
    expect(FAIL_REASONS).toEqual([
      'no_receipt',
      'no_journal',
      // the documentary counterpart of no_receipt: a stage whose product is prose said done
      // and left no document — the file is absent from the phase directory, or uncommitted
      'no_artifact',
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

  // ── the data envelope: WHICH GATE, carried by the task, refused by name when malformed ──
  //
  // Nothing in the queue interprets these two words; the tick does. What the queue owes them
  // is that they arrive intact and that a typo is refused rather than defaulted: a document
  // stage gated on reverify fails red forever, and a code task gated on an artifact completes
  // without one. Both are silent, and both are prevented here.

  it('the data envelope survives the field allowlist — the gate rides ON the task', () => {
    const out = validateTask({
      id: 'ST-1',
      source: 'roster',
      title: 'спланировать фазу',
      lane: 'paperwork',
      data: { kind: 'document', stage: 'plan', phase: 12 },
    })
    expect(out.data).toEqual({ kind: 'document', stage: 'plan', phase: 12 })
  })

  it('a task with no data envelope is unchanged — absent means «code», today’s behaviour', () => {
    const out = validateTask({ id: 'BL-9', source: 'roster', title: 'обычная задача', lane: 'prod' })
    expect(Object.hasOwn(out, 'data')).toBe(false)
  })

  it('a typo in kind / stage is REFUSED BY NAME, never defaulted to the other gate', () => {
    const base = { id: 'ST-2', source: 'roster', title: 'стадия', lane: 'paperwork' }
    expect(() => validateTask({ ...base, data: { kind: 'documents' } })).toThrow(InvalidTaskError)
    expect(() => validateTask({ ...base, data: { kind: 'document', stage: 'planning' } })).toThrow(/data\.stage/)
    expect(() => validateTask({ ...base, data: { kind: 'document', phase: { n: 12 } } })).toThrow(/data\.phase/)
    expect(() => validateTask({ ...base, data: { kind: 'document', smuggled: 'x' } })).toThrow(/unknown key "smuggled"/)
    expect(() => validateTask({ ...base, data: ['document'] })).toThrow(/must be an object/)
  })

  /**
   * THE WORDS OF A TASK — one field of promise, and the proof that there is only one.
   *
   * The temptation these cases exist against is a second field of «criteria» beside
   * `acceptance`: two places to write the same promise, disagreeing the first time either is
   * edited, with nothing able to say which one the work was judged by. The vocabulary grew by
   * `description` ONLY, and the promise learned a second SHAPE rather than a second home.
   */
  it('the vocabulary grew by description alone — there is no second field of criteria', () => {
    const out = validateTask({
      id: 'R-words',
      source: 'roster',
      title: 'работа со словами',
      lane: 'prod',
      description: 'что это за работа',
      acceptance: ['первый признак', 'второй признак'],
    })
    expect(out.description).toBe('что это за работа')
    expect(out.acceptance).toEqual(['первый признак', 'второй признак'])
    // no neighbouring field of criteria travelled — the promise has exactly one home
    expect(Object.keys(out)).not.toContain('criteria')
    const smuggled: any = validateTask({
      id: 'R-smuggle',
      source: 'roster',
      title: 'работа',
      lane: 'prod',
      criteria: ['так писать нельзя'],
    })
    expect(Object.hasOwn(smuggled, 'criteria')).toBe(false)
  })

  it('acceptanceItems is the ONE reading path: a string is a list of one, blanks are nothing', () => {
    expect(acceptanceItems('тесты зелёные')).toEqual(['тесты зелёные'])
    expect(acceptanceItems(['  первый  ', '', '   ', 'второй'])).toEqual(['первый', 'второй'])
    expect(acceptanceItems(undefined)).toEqual([])
    expect(acceptanceItems('   ')).toEqual([])
    expect(acceptanceItems(42 as any)).toEqual([])
  })

  /** The DoR gate reads THROUGH the normalizer — a promise of nothing is unready in either shape. */
  it('a backlog task promising an EMPTY list is as unready as one promising nothing at all', () => {
    expect(() => validateTask(backlog({ acceptance: [] }))).toThrow(NotReadyError)
    expect(() => validateTask(backlog({ acceptance: ['   '] }))).toThrow(NotReadyError)
    expect(validateTask(backlog({ acceptance: ['зелёные тесты'] })).acceptance).toEqual(['зелёные тесты'])
  })

  it('a criterion that is not a string is refused by name, never coerced', () => {
    expect(() => validateTask(backlog({ acceptance: ['ок', 42] }))).toThrow(/string or a list of strings/)
  })

  it('TASK_LANES includes forge and TASK_SOURCES the three intake origins', () => {
    expect(TASK_LANES).toContain('forge')
    expect(TASK_SOURCES).toEqual(['backlog', 'roster', 'return'])
  })

  it('TASK_STATUSES is the closed five-status vocabulary, waiting-for-a-person included, and is frozen', () => {
    expect(TASK_STATUSES).toEqual(['queued', 'claimed', 'awaiting_approval', 'completed', 'failed'])
    expect(Object.isFrozen(TASK_STATUSES)).toBe(true)
  })
})
