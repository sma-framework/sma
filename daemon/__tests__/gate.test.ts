/**
 * gate.test.ts — the D-9.5-04a UNIFIED EXIT GATE as its own regression-locked suite
 * (Phase 9.5 Plan 07, Task 3; D-9.5-04a, Pitfall 6).
 *
 * This suite is the phase's cognitive-layer differentiator made executable: RECEIPTS OR
 * NOTHING, for EVERY executor. It proves — over the real loop + real memory adapter +
 * real routing, with only the worker child + verbs faked — that:
 *   - a claude-lane task and a codex-lane task travel the SAME tick path and BOTH require
 *     a GREEN reverify receipt to reach `completed` (lane-agnostic);
 *   - a worker exiting 0 WITHOUT a receipt is failed 'no_receipt' — the exit code proves
 *     nothing (the Multica «completed = слово демона» anti-lesson);
 *   - a RED reverify receipt fails 'tests_red' with the receipt ref preserved on the
 *     attempt row (the roster's «не справился» card has evidence — D-9.5-11 taxonomy);
 *   - defense in depth: the adapter itself refuses complete() without a receiptRef.
 */

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import { createMemoryQueue, NoReceiptError } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// A claude worker (prod lane) AND a codex worker (research lane) — both open windows, so
// the tick can claim either lane and route it to its executor.
const WORKERS = [
  { id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/claude' }, enabled: true },
  { id: 'pro-1', lane: 'research', provider: 'codex', account: { configDir: '/codex' }, enabled: true },
]

function makeVerbRunner(responses: Record<string, any>) {
  return async (_bin: string, argsArray: string[]) => {
    const verb = argsArray[1]
    return responses[verb] ?? { code: 0, stdout: '{}' }
  }
}

function makeSpawnWorker(opts: { lines?: string[]; code?: number } = {}) {
  const { lines = ['working'], code = 0 } = opts
  return (spec: any) => {
    for (const l of lines) spec.onLine?.(l)
    spec.onExit?.({ code, signal: null })
    return { pid: 1, kill: () => {} }
  }
}

function makeDeps({ adapter, clock, responses, spawnWorker }: any) {
  const attempts: any[] = []
  const reports: any[] = []
  const deps = {
    adapter,
    ledger: { recordAttempt: (a: any) => (attempts.push(a), a), readAttempts: (id: string) => attempts.filter((x) => x.taskId === id) },
    config: { workers: WORKERS, agingHours: 24, backlogScanMinutes: 60, repoDir: '/repo' },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'exec', args: ['-'], env: {}, prompt: 'p' }),
    verbRunner: makeVerbRunner(responses),
    spawnWorker: spawnWorker ?? makeSpawnWorker(),
    report: async (e: any) => reports.push(e),
    clock,
    journal: () => {},
  }
  return { deps, attempts, reports }
}

const NOT_BUILT = { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
const GREEN = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:green' }) }

// claude lane = prod (backlog, DoR-complete); codex lane = research (roster, DoR-exempt).
const LANE_CASES = [
  { name: 'claude lane (prod)', task: { id: 'BL-P', source: 'backlog', title: 't', lane: 'prod', storyPoints: 3, acceptance: 'a' } },
  { name: 'codex lane (research)', task: { id: 'R-C', source: 'roster', title: 't', lane: 'research' } },
]

describe('D-9.5-04a — one gate for all executors: green reverify receipt or nothing', () => {
  for (const { name, task } of LANE_CASES) {
    it(`${name}: completes ONLY on a green reverify receipt`, async () => {
      const c = mkClock()
      const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
      await adapter.enqueue(task)
      const { deps } = makeDeps({ adapter, clock: c.clock, responses: { preflight: NOT_BUILT, worktree: { code: 0, stdout: '{}' }, reverify: GREEN } })
      const res = await tick(deps)
      expect(res.completed).toBe(task.id)
      const [row] = await adapter.list({})
      expect(row.status).toBe('completed')
    })

    it(`${name}: a worker exiting 0 WITHOUT a receipt → fail('no_receipt') (Pitfall 6)`, async () => {
      const c = mkClock()
      const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
      await adapter.enqueue(task)
      const { deps } = makeDeps({
        adapter,
        clock: c.clock,
        responses: { preflight: NOT_BUILT, worktree: { code: 0, stdout: '{}' }, reverify: { code: 0, stdout: '{}' } },
        spawnWorker: makeSpawnWorker({ code: 0 }), // exits 0 — but reverify produced no receipt
      })
      const res = await tick(deps)
      expect(res.failed).toEqual({ taskId: task.id, reason: 'no_receipt' })
      const [row] = await adapter.list({})
      expect(row.status).toBe('failed')
      expect(row.failure_reason).toBe('no_receipt')
    })
  }

  it("D-9.5-11: a RED reverify receipt → fail('tests_red') with the receipt ref preserved on the attempt row", async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-R', source: 'backlog', title: 't', lane: 'prod', storyPoints: 2, acceptance: 'a' })
    const { deps, attempts } = makeDeps({
      adapter,
      clock: c.clock,
      responses: { preflight: NOT_BUILT, worktree: { code: 0, stdout: '{}' }, reverify: { code: 1, stdout: JSON.stringify({ verdict: 'red', receiptRef: 'reverify:red-BL-R' }) } },
    })
    const res = await tick(deps)
    expect(res.failed).toEqual({ taskId: 'BL-R', reason: 'tests_red' })
    const row = attempts.find((a) => a.taskId === 'BL-R' && a.outcome === 'failed')
    expect(row).toBeTruthy()
    expect(row.failureReason).toBe('tests_red')
    expect(row.receiptRef).toBe('reverify:red-BL-R') // evidence preserved for the roster card
  })

  it('defense in depth (Pitfall 6): the adapter itself refuses complete() without a receiptRef', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-D', source: 'backlog', title: 't', lane: 'prod', storyPoints: 1, acceptance: 'a' })
    await adapter.claimNext('w', {})
    await expect(adapter.complete('BL-D', {})).rejects.toBeInstanceOf(NoReceiptError)
  })
})
