/**
 * Tests for daemon/src/loop.mjs — the stateless tick.
 *
 * The tick is COMPOSITION over durable state: liveness sweep → intake → claim (eligible
 * lanes only) → preflight → worktree → spawn → reverify GATE → complete/fail → report.
 * Every dependency is injected; the whole suite drives fakes and never spawns a real CLI,
 * never touches Postgres, never spends a token.
 *
 * Covered here:
 *   - full happy-path trace over fakes, asserting the verb ORDER preflight→worktree→
 *     spawn→reverify (verify-before-execute mechanized; reverify is THE exit gate)
 *   - preflight 'built' short-circuit (skip spawn, complete on the preflight receipt)
 *   - exit-0 with no reverify receipt → fail('no_receipt') (exit code proves nothing)
 *   - classifyFailure parametrized over the whole taxonomy
 *   - the aging signal (queued older than agingHours fires task.aging; younger fires none)
 *   - kill-mid-tick drill: a fresh tick recovers a stale-claimed task from durable state
 *   - idle tick short-circuit (no claim → {idle:true}, no side effects)
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick, runDaemon, classifyFailure } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { workerReadiness, poolReadiness } from '../src/runner/readiness.mjs'
import { defaultEnvelope, envelopeAllows, envelopeHash } from '../src/queue/capability-envelope.mjs'
import { STATE_MACHINE_VERSION, idempotencyKey } from '../src/queue/state-machine.mjs'
import {
  recordAttempt,
  readAttempts,
  memorySnapshotHash,
  MEMORY_SNAPSHOT_ABSENT,
} from '../src/queue/attempt-ledger.mjs'

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const backlogTask = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

// A recording verbRunner: (bin, argsArray, {cwd}) → {code, stdout}. Verb = argsArray[1].
function makeVerbRunner(responses: Record<string, any>, order?: string[]) {
  return async (_bin: string, argsArray: string[]) => {
    const verb = argsArray[1]
    order?.push(verb)
    const r = responses[verb] ?? { code: 0, stdout: '{}' }
    return typeof r === 'function' ? r() : r
  }
}

// A recording spawnWorker: emits stream lines then exits. Optionally throws synchronously
// (an infra spawn error) or is left un-exited (to model a mid-tick kill).
// A COMPLETE attempt carries BOTH a green receipt and an approach note — the
// default fake worker leaves the note; the note law itself is exercised in journal.test.ts.
function makeSpawnWorker(order?: string[], opts: { lines?: string[]; code?: number; throwSync?: boolean } = {}) {
  const { lines = ['stream line', 'APPROACH_NOTE: прямой путь'], code = 0, throwSync = false } = opts
  return (spec: any) => {
    order?.push('spawn')
    if (throwSync) throw new Error('spawn infra failure')
    for (const l of lines) spec.onLine?.(l)
    spec.onExit?.({ code, signal: null }) // synchronous, deterministic exit
    return { pid: 4242, kill: () => {} }
  }
}

function makeDeps(over: any = {}) {
  const order: string[] = []
  const reports: any[] = []
  const attempts: any[] = []
  const journalled: any[] = []
  const c = over.clockObj ?? mkClock()
  const deps = {
    adapter: over.adapter,
    ledger: {
      recordAttempt: (a: any) => {
        attempts.push(a)
        return a
      },
      readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
    },
    config: {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: '/repo',
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: (_task: any, _route: any) => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: over.verbRunner ?? makeVerbRunner(over.responses ?? {}, order),
    spawnWorker: over.spawnWorker ?? makeSpawnWorker(order),
    report: async (e: any) => {
      reports.push(e)
    },
    clock: c.clock,
    journal: (e: any) => journalled.push(e),
    ...over.deps,
  }
  return { deps, order, reports, attempts, journalled, clock: c }
}

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) }

describe('tick — the stateless composed tick', () => {
  it('runs the full trace in order: preflight → worktree → spawn → reverify → complete', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, order, reports } = makeDeps({
      adapter,
      clockObj: c,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ worktreePath: '/wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
    })

    const res = await tick(deps)

    expect(order).toEqual(['preflight', 'worktree', 'spawn', 'reverify'])
    expect(res.completed).toBe('BL-1')
    const [row] = await adapter.list({})
    // completed work is reported as awaiting approval — the tick certified it, a person accepts it
    expect(row.status).toBe('awaiting_approval')
    // the report fired for the completion
    expect(reports.some((r) => r.event === 'task.completed' && r.taskId === 'BL-1')).toBe(true)
  })

  it('preflight verdict "built" short-circuits: no spawn, completes on the preflight receipt', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-2' }))
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'built', receiptRef: 'preflight:BL-2' }) } },
    })

    const res = await tick(deps)

    expect(order).toEqual(['preflight']) // never spawned, never reverified
    expect(res.completed).toBe('BL-2')
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
  })

  it('a worker exiting 0 WITHOUT a reverify receipt → fail("no_receipt")', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-3' }))
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: '{}' },
        reverify: { code: 0, stdout: '{}' }, // green exit, but NO receiptRef → no receipt
      },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-3', reason: 'no_receipt' })
    const [row] = await adapter.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('no_receipt')
  })

  it('idle tick: nothing queued → {idle:true}, spawn never called, no verbs run', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps, order } = makeDeps({ adapter, clockObj: c })
    const res = await tick(deps)
    expect(res.idle).toBe(true)
    expect(res.completed).toBeUndefined()
    expect(order).toEqual([]) // no preflight/worktree/spawn/reverify when there is no claim
  })

  it('kill-mid-tick drill: a fresh tick recovers a stale-claimed task from DURABLE state', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(backlogTask({ id: 'BL-K' }))
    // A PRIOR tick claimed the task and then the daemon was KILLED — no complete/fail ever
    // fired, the touch clock stopped. Nothing about that dead tick survives in memory.
    await adapter.claimNext('dead-worker', {})
    c.advance(10000) // past expireMs — the claim is now stale

    // A FRESH tick over the SAME durable adapter must recover + process the task.
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: '{}' },
        reverify: GREEN_REVERIFY,
      },
    })
    const res = await tick(deps)

    expect(order).toContain('spawn') // the fresh tick picked the recovered task up
    expect(res.completed).toBe('BL-K')
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
  })
})

// ── an attempt that cannot start says so — the QA «первая задача умирает молча» class ──
//
// A fresh install ships PLACEHOLDER accounts and (until the executor wave) no buildArgs.
// Before these gates the tick died on the way to the spawn, the fail-open catch swallowed
// it, the ledger write threw on an unconfigured ledgerDir and the card showed «failed,
// attempt 3» with attempts:[] and not one line in the log. Every test below pins one half
// of «каждая карточка отвечает ПОЧЕМУ».

describe('an attempt that cannot start is REFUSED, loudly and on the record', () => {
  it('a routed worker whose account was never set up fails with missing_access on the card', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, attempts, journalled, order } = makeDeps({
      adapter,
      clockObj: c,
      deps: { workerReady: (w: any) => workerReadiness(w, {}) }, // the REAL check, on '/x'
    })
    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'missing_access' })
    expect(String(res.failed.detail)).toContain('не настроен')
    // the card's «почему»: an attempt row carrying the reason code the roster renders
    expect(attempts.at(-1)).toMatchObject({ taskId: 'BL-1', outcome: 'failed', failureReason: 'missing_access' })
    expect(journalled.some((e: any) => e.type === 'task.refused' && e.reason === 'missing_access')).toBe(true)
    expect(order).not.toContain('spawn') // refused BEFORE any verb ran
    expect(order).not.toContain('preflight')
  })

  it('a daemon wired with no executor refuses before provisioning a worktree', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, attempts, order, journalled } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) } },
      deps: { buildArgs: undefined },
    })
    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'runtime_offline' })
    expect(attempts.at(-1)).toMatchObject({ outcome: 'failed', failureReason: 'runtime_offline' })
    expect(journalled.some((e: any) => e.type === 'task.refused')).toBe(true)
    expect(order).toEqual(['preflight']) // no worktree, no spawn
  })

  it('the preflight-«built» door still completes without any executor (the pilot smoke path)', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'built', receiptRef: 'preflight:BL-1' }) } },
      deps: { buildArgs: undefined },
    })
    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    expect(order).toEqual(['preflight'])
  })

  it('a ledger that cannot be written reports itself instead of swallowing the failure', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      deps: {
        workerReady: () => ({ ready: false, reason: 'missing_access', detail: 'нет каталога' }),
        ledger: {
          recordAttempt: () => {
            throw new Error('recordAttempt requires a ledgerDir') // the unconfigured-dir throw
          },
          readAttempts: () => [],
        },
      },
    })
    const res = await tick(deps)

    expect(res.failed).toMatchObject({ reason: 'missing_access' })
    expect(journalled.some((e: any) => e.type === 'ledger-error')).toBe(true)
    const [row] = await adapter.list({})
    expect(row.status).toBe('failed') // the durable transition still happened
  })
})

// ═══ the capability envelope is CONSULTED before a worker starts ═══
//
// Until 2026-08-05 nothing in the daemon constructed or consulted an envelope: the module
// declared eight fail-closed dimensions and had no caller. The tick now resolves the lane's
// envelope at the claim and refuses to start a process the envelope does not permit.

/**
 * A minimal adapter that hands out ONE task and records what was done to it. The memory
 * queue cannot be used here: `validateTask` refuses an unknown lane at enqueue, which is
 * exactly right and exactly why the case has to be constructed one layer down.
 */
function oneTaskAdapter(task: any) {
  const calls: any[] = []
  let handedOut = false
  return {
    calls,
    async list() {
      return []
    },
    async claimNext() {
      if (handedOut) return null
      handedOut = true
      return task
    },
    async touch() {
      return true
    },
    async complete(id: string, result: any) {
      calls.push({ op: 'complete', id, result })
      return true
    },
    async fail(id: string, reason: string) {
      calls.push({ op: 'fail', id, reason })
      return true
    },
  }
}

describe('the capability envelope gates the spawn', () => {
  it('a lane whose envelope grants no shell never reaches a worktree or a spawn, and says why', async () => {
    const c = mkClock()
    const adapter = oneTaskAdapter(backlogTask({ lane: 'ghost', attempt: 1 }))
    const { deps, order, attempts, journalled } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) } },
      // The router is stubbed so this case is about the ENVELOPE and nothing else: an
      // unroutable lane would otherwise fail 'window_exhausted' one door earlier.
      deps: { routing: { resolveRoute: () => ({ workerId: 'max-2', provider: 'claude' }) } },
    })

    const res = await tick(deps)

    // Fail-closed: an unrecognised lane resolves to the LOCKED envelope, whose allowedTools
    // is empty, and an unrecognised permission is not a permit.
    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'missing_access' })
    expect(res.failed.detail).toMatch(/capability envelope grants no "Bash"/)
    expect(order).toEqual(['preflight']) // no worktree was provisioned, no worker started
    expect(adapter.calls).toEqual([{ op: 'fail', id: 'BL-1', reason: 'missing_access' }])

    // The refusal is VISIBLE on both surfaces — the daemon's own log and the attempt row.
    // A fail-closed gate that refused silently would be the worse of the two faults.
    expect(
      journalled.some((e: any) => e.type === 'task.refused' && /capability envelope/.test(String(e.detail))),
    ).toBe(true)
    expect(attempts[0]).toMatchObject({ taskId: 'BL-1', outcome: 'failed', failureReason: 'missing_access' })
    expect(attempts[0].capabilityEnvelope).toEqual(defaultEnvelope('ghost'))
  })

  it('each of the four shipped lanes DOES grant it — the gate is closed, not stuck shut', async () => {
    for (const lane of ['prod', 'research', 'paperwork', 'forge']) {
      expect(envelopeAllows(defaultEnvelope(lane), { action: 'tool', tool: 'Bash' })).toBe(true)
    }
    expect(envelopeAllows(defaultEnvelope('ghost'), { action: 'tool', tool: 'Bash' })).toBe(false)
  })
})

// ═══ the attempt row carries the world it ran in ═══════════════════

describe('the tick stamps its attempt rows', () => {
  const tmpDirs: string[] = []
  const mkDir = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    tmpDirs.push(d)
    return d
  }
  afterAll(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  /** A repo whose corpus holds one real note, so the digest is a digest of something. */
  function mkRepoWithCorpus(): string {
    const repoDir = mkDir('sma-loop-repo-')
    const corpus = join(repoDir, '.claude', 'memory')
    mkdirSync(corpus, { recursive: true })
    writeFileSync(join(corpus, 'one-lesson.md'), '---\nid: one-lesson\n---\nthe lesson\n', 'utf8')
    return repoDir
  }

  it('a completed attempt row carries the envelope digest, the corpus digest, the key and the machine version', async () => {
    const c = mkClock()
    const repoDir = mkRepoWithCorpus()
    const ledgerDir = mkDir('sma-loop-ledger-')
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { repoDir },
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ worktreePath: '/wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      // The REAL ledger, so the digest that lands on disk is the one asserted — not the
      // object the tick handed over.
      deps: { ledger: { recordAttempt: (row: any) => recordAttempt(ledgerDir, row), readAttempts: () => [] } },
    })

    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')

    const [row] = readAttempts(ledgerDir, 'BL-1')
    expect(row.outcome).toBe('completed')
    // RUNNING -> PRODUCED: a worker process really did start, so that is the edge named.
    expect(row.stateMachineVersion).toBe(STATE_MACHINE_VERSION)
    expect(row.idempotencyKey).toBe(idempotencyKey('BL-1', 'BL-1#1', 'RUNNING->PRODUCED'))
    expect(row.capabilityEnvelopeHash).toBe(envelopeHash(defaultEnvelope('prod')))
    expect(row.capabilityEnvelope).toBeUndefined() // digests only, never the thing itself
    // The corpus the worker stood in — a real digest of a real note, not the declared absence.
    expect(row.memorySnapshotHash).toBe(memorySnapshotHash({ corpusDir: join(repoDir, '.claude', 'memory') }))
    expect(row.memorySnapshotHash).not.toBe(MEMORY_SNAPSHOT_ABSENT)
    // The three this file cannot compute stay ABSENT rather than invented.
    for (const absent of ['policyVersion', 'harnessVersion', 'planHash']) {
      expect(Object.hasOwn(row, absent)).toBe(false)
    }
  })

  it('an attempt refused BEFORE any worker started names CLAIMED -> RETRYABLE, not RUNNING', async () => {
    const c = mkClock()
    const ledgerDir = mkDir('sma-loop-ledger-')
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      deps: {
        workerReady: () => ({ ready: false, reason: 'missing_access', detail: 'нет каталога' }),
        ledger: { recordAttempt: (row: any) => recordAttempt(ledgerDir, row), readAttempts: () => [] },
      },
    })

    await tick(deps)

    const [row] = readAttempts(ledgerDir, 'BL-1')
    expect(row.failureReason).toBe('missing_access')
    expect(row.idempotencyKey).toBe(idempotencyKey('BL-1', 'BL-1#1', 'CLAIMED->RETRYABLE'))
    expect(row.idempotencyKey).not.toBe(idempotencyKey('BL-1', 'BL-1#1', 'RUNNING->RETRYABLE'))
  })

  it('the preflight-«built» completion carries NO transition fields — no worker ran, so there is no edge to name', async () => {
    const c = mkClock()
    const ledgerDir = mkDir('sma-loop-ledger-')
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'built', receiptRef: 'preflight:BL-1' }) } },
      deps: { ledger: { recordAttempt: (row: any) => recordAttempt(ledgerDir, row), readAttempts: () => [] } },
    })

    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')

    const [row] = readAttempts(ledgerDir, 'BL-1')
    expect(row.outcome).toBe('completed')
    // The envelope is still stamped — it is a property of the lane, and the lane is known.
    expect(row.capabilityEnvelopeHash).toBe(envelopeHash(defaultEnvelope('prod')))
    // But CLAIMED -> PRODUCED is not a contract, and minting CLAIMED -> RUNNING would assert
    // `worker_process_started` — an external effect that did not happen.
    expect(Object.hasOwn(row, 'idempotencyKey')).toBe(false)
    expect(Object.hasOwn(row, 'stateMachineVersion')).toBe(false)
  })
})

// ═══ the ledger is reconciled once a tick ══════════════════════════

describe('the tick runs the reconciliation pass', () => {
  it('reports the pass in its summary, right after the sweep', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps } = makeDeps({ adapter, clockObj: c })

    const res = await tick(deps)
    expect(res.reconciled).toEqual({ examined: 0, reconstructed: 0 })
  })

  it('a reconciliation that throws is journaled and never wedges the tick (fail-open)', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      // No list() at all: the pass throws a TypeError on construction of its own contract.
      deps: { adapter: { ...adapter, list: undefined } },
    })

    const res = await tick(deps)
    expect(journalled.some((e: any) => e.type === 'reconcile-error')).toBe(true)
    expect(res.error).toBeUndefined() // the tick itself did not fall over
  })
})

describe('readiness — can this worker start at all? (runner/readiness.mjs)', () => {
  it('an account directory that does not exist is missing_access, with the path in the detail', () => {
    const r = workerReadiness({ id: 'max-1', account: { name: 'max-1', configDir: '/nope/max-1' } }, {})
    expect(r.ready).toBe(false)
    expect(r.reason).toBe('missing_access')
    expect(r.detail).toContain('max-1')
  })

  it('expands ~ against the injected home before asking the filesystem', () => {
    const seen: string[] = []
    const fsImpl = { existsSync: (p: string) => (seen.push(p), true) }
    const r = workerReadiness({ id: 'max-1', account: { configDir: '~/.sma-accounts/max-1' } }, {
      fsImpl,
      homedir: () => '/home/x',
    })
    expect(r.ready).toBe(true)
    expect(seen[0].replace(/\\/g, '/')).toBe('/home/x/.sma-accounts/max-1')
  })

  it('poolReadiness counts only enabled workers and names every blocked one', () => {
    const config = {
      workers: [
        { id: 'a', enabled: true, account: { configDir: '/nope/a' } },
        { id: 'b', enabled: false, account: { configDir: '/nope/b' } },
        { id: 'c', enabled: true, account: { configDir: '/here/c' } },
      ],
    }
    const fsImpl = { existsSync: (p: string) => String(p).includes('here') }
    const out = poolReadiness(config, { fsImpl })
    expect(out.total).toBe(2)
    expect(out.ready).toEqual(['c'])
    expect(out.blocked.map((b: any) => b.id)).toEqual(['a'])
  })
})

describe('the aging signal — derived fresh every tick, nothing stored', () => {
  it('fires task.aging (with queuedForHours) for a task older than agingHours; not for a younger one', async () => {
    const c = mkClock()
    // A fake adapter whose list() returns two queued rows with fixed enqueuedAt.
    const now = c.clock()
    const adapter = {
      async list(filter: any = {}) {
        const rows = [
          { id: 'BL-OLD', title: 'stuck', lane: 'prod', status: 'queued', enqueuedAt: now - 30 * 3600000 },
          { id: 'BL-NEW', title: 'fresh', lane: 'prod', status: 'queued', enqueuedAt: now - 1 * 3600000 },
        ]
        return filter.status ? rows.filter((r) => r.status === filter.status) : rows
      },
      async claimNext() {
        return null // no claim — we only exercise the aging derive here
      },
      async fail() {
        return true
      },
    }
    const { deps, reports } = makeDeps({ adapter, clockObj: c })
    await tick(deps)

    const aging = reports.filter((r) => r.event === 'task.aging')
    expect(aging.map((r) => r.taskId)).toEqual(['BL-OLD'])
    expect(aging[0].queuedForHours).toBe(30)
  })
})

describe('classifyFailure — the taxonomy (pure)', () => {
  const cases: Array<[string, any, string]> = [
    ['spawn infra error → runtime_offline', { spawnError: new Error('offline'), exitCode: null }, 'runtime_offline'],
    ['red reverify receipt → tests_red', { exitCode: 0, receipt: { verdict: 'red', ref: 'reverify:red' } }, 'tests_red'],
    ['worker NEEDS_DECISION marker → needs_decision', { exitCode: 0, workerMarker: 'NEEDS_DECISION' }, 'needs_decision'],
    ['worker MISSING_ACCESS marker → missing_access', { exitCode: 0, workerMarker: 'MISSING_ACCESS' }, 'missing_access'],
    ['nonzero crash, no receipt → agent_error', { exitCode: 1, receipt: null }, 'agent_error'],
    ['exit 0, no receipt → no_receipt', { exitCode: 0, receipt: null }, 'no_receipt'],
  ]
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(classifyFailure(input)).toBe(expected)
    })
  }

  it('a marker beats a red receipt (the worker gave the sharper reason)', () => {
    expect(classifyFailure({ exitCode: 1, receipt: { verdict: 'red', ref: 'r' }, workerMarker: 'MISSING_ACCESS' })).toBe(
      'missing_access',
    )
  })
})

describe('runDaemon — a thin setInterval wrapper, no state beyond the handle', () => {
  it('start schedules ticks; stop clears them; double start/stop is safe', async () => {
    let ticks = 0
    const d = runDaemon({ tickMs: 5, onTick: async () => { ticks += 1 } })
    d.start()
    d.start() // idempotent — one interval only
    await new Promise((r) => setTimeout(r, 30))
    d.stop()
    const after = ticks
    await new Promise((r) => setTimeout(r, 20))
    expect(ticks).toBeGreaterThan(0)
    expect(ticks).toBe(after) // no ticks after stop
    d.stop() // idempotent
  })
})
