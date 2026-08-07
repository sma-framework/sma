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
 *
 * THE SECOND EXIT GATE (work made of prose), pinned as grep-visible invariants:
 *   - a document stage completes on a COMMITTED artifact, with a receipt naming the file and
 *     the commit — and on nothing else: a stage that wrote no document fails no_artifact, and
 *     one whose document was never committed fails no_artifact too
 *   - a discussion round parks for a human instead of going red: an open question in the
 *     workflow's own checkpoint is a SUCCESSFUL round, and the row lands awaiting_approval
 *   - an execute stage's blocking checkpoint parks the SAME way, checked BEFORE the code gate
 *   - the gate is a FILE check: the suite never feeds the daemon a line of worker stdout to
 *     decide an outcome with, and the code gate is byte-for-byte what it was (regression)
 *
 * THE LIVE ATTEMPT LOG (the tick's half of «наблюдение за исполнителями»), also pinned:
 *   - every stream line reaches the ATTEMPT's own file while the process is still alive, and
 *     a line spoken by a SUBAGENT is marked as such (parent_tool_use_id → subagent+parentId)
 *   - the sessionId off the result frame lands on the attempt row; an attempt that never
 *     named one carries no such key at all
 *   - the log is fail-open THREE ways: an unwritable directory, a seam that throws, and no
 *     seam at all — in each case the task is decided by its own gate, exactly as before
 *   - every spawn (both lanes, one constant) is assembled with forwardSubagentText
 *
 * WHY THIS FILE IS NOT PINNED SERIAL (vitest.config.mjs SERIAL_SUITES): the gate cases above
 * drive an in-memory filesystem and a git that is one function returning a string. Not one of
 * them starts a process, opens a real repository or writes outside a temp dir, so they carry
 * none of the contention that made the six pinned suites flaky beside eleven other workers.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// the discussion checkpoint's SHIPPED template, imported as DATA — the exec checkpoint is
// asserted to be this exact shape plus a position block, never a second schema
import discussTemplate from '../../sma-core/workflows/discuss-phase/templates/checkpoint.json'

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
  createAttemptLogWriter,
  readAttemptLog,
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
      // The conveyor is OFF unless a person switched it on, so every case that expects the
      // tick to DO something has to say so. Stated once here rather than per case, and left
      // overridable below — the «off does nothing» cases pass `pipeline: {enabled:false}`.
      pipeline: { enabled: true },
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

/**
 * ═══════════ THE CONVEYOR'S OWN SWITCH, AND THE PROOF THAT IT GATES ══════════════
 *
 * A toggle that does not gate anything is worse than no toggle: it tells a person the
 * machine is stopped while the machine keeps spending his subscription. So the cases below
 * do not check a flag — they check that with the switch off the tick touches NOTHING it can
 * be observed touching: no verb is invoked, no process is spawned, no row is claimed, no
 * report is sent, and the queue's own state is byte-identical afterwards.
 *
 * «Off» here is the absence of a `pipeline` block as well as an explicit false, because that
 * is the shape every install that upgrades into this version actually has.
 */
describe('the conveyor is off until a person switches it on', () => {
  const OFF_SHAPES: any[] = [undefined, { enabled: false }, { enabled: 'true' }, { enabled: 1 }]

  for (const pipeline of OFF_SHAPES) {
    it(`does NOTHING with pipeline = ${JSON.stringify(pipeline) ?? 'absent'}`, async () => {
      const c = mkClock()
      const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
      await adapter.enqueue(backlogTask())
      const { deps, order, reports } = makeDeps({
        adapter,
        clockObj: c,
        config: { pipeline },
        responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }, worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) }, reverify: GREEN_REVERIFY },
      })

      const res = await tick(deps)

      expect(res).toEqual({ idle: true, paused: true })
      expect(order).toEqual([]) // no verb invoked, no worker spawned
      expect(reports).toEqual([]) // nothing reported to anybody
      const [row] = await adapter.list({})
      expect(row.status).toBe('queued') // the work was NOT claimed
      expect(row.attempt).toBe(1)
    })
  }

  it('the SAME deps with the switch on run the work — so the case above proves the gate, not a broken fixture', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      config: { pipeline: { enabled: true } },
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    expect(order).toEqual(['preflight', 'worktree', 'spawn', 'reverify'])
  })
})

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
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
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
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
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
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
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

// ═══ THE SECOND EXIT GATE: work whose product is prose ═════════════════════════
//
// A stage of the phase cycle has no targeted tests to be green, so under the single reverify
// gate every stage started from the screen would have failed «нет квитанции» while sitting
// next to the document it had just written. The second gate asks for the document instead —
// and asks the DISK and GIT, never the worker's own account of itself.

/** A tiny in-memory filesystem: the only surface findArtifact and the questions engine use. */
function makeFs(files: Record<string, string>) {
  const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const table: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) table[norm(k)] = v
  const names = () => Object.keys(table)
  return {
    existsSync: (p: string) => {
      const n = norm(p)
      return names().some((f) => f === n || f.startsWith(`${n}/`))
    },
    readdirSync: (p: string) => {
      const n = norm(p)
      const out: string[] = []
      for (const f of names()) {
        if (!f.startsWith(`${n}/`)) continue
        const child = f.slice(n.length + 1).split('/')[0]
        if (!out.includes(child)) out.push(child)
      }
      return out
    },
    readFileSync: (p: string) => {
      const n = norm(p)
      if (!(n in table)) throw new Error(`ENOENT: ${n}`)
      return table[n]
    },
  }
}

/** A git that knows which paths are committed and to which short sha. */
function makeGit(committed: Record<string, string>) {
  return (args: string[]) => {
    const path = args[args.indexOf('--') + 1]
    return committed[String(path)] ?? ''
  }
}

const PHASE_DIR = '/repo/.planning/phases/12-front'

/** A checkpoint in the workflow's OWN shape, with one question still unanswered. */
const parkedCheckpointJson = JSON.stringify({
  phase: '12',
  phase_name: 'front',
  areas_completed: ['Область 1'],
  areas_remaining: ['Область 2'],
  decisions: {
    'Область 2': [{ question: 'Хранить ответы в чекпойнте?', options_presented: ['да', 'нет'] }],
  },
})

const stageTask = (data: any, over: any = {}) => ({
  id: 'ST-1',
  source: 'roster',
  title: 'стадия фазы',
  lane: 'paperwork',
  priority: 0,
  attempt: 1,
  data,
  ...over,
})

/** Every stage case routes the same way; the cases are about the GATE, nothing else. */
const stageDeps = (over: any = {}) =>
  makeDeps({
    ...over,
    deps: { routing: { resolveRoute: () => ({ workerId: 'max-2', provider: 'claude' }) }, ...over.deps },
  })

describe('a document stage completes on a committed artifact — and on nothing else', () => {
  it('artifact present AND committed → complete with an artifact receipt naming file and commit', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const { deps, order } = stageDeps({
      adapter,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan', [`${PHASE_DIR}/12-02-PLAN.md`]: '# plan' }),
        execGit: makeGit({ '.planning/phases/12-front/12-02-PLAN.md': 'abc1234' }),
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    const [call] = adapter.calls
    expect(call.op).toBe('complete')
    expect(call.result.receiptRef).toBe('artifact:.planning/phases/12-front/12-02-PLAN.md@abc1234')
    expect(call.result.receiptRef.startsWith('artifact:')).toBe(true)
    expect(call.result.receiptRef).toContain('@')
    // a documentary stage stands in the project checkout: no worktree, and no preflight —
    // «is this backlog item already built» is not a question a phase stage can be asked
    expect(order).toEqual(['spawn'])
    expect(call.result.branch).toBe(null)
  })

  it('no artifact → fail("no_artifact"), whatever the worker printed about itself', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const { deps } = stageDeps({
      adapter,
      // the worker ANNOUNCES the document — the first threat this gate exists for
      spawnWorker: makeSpawnWorker(undefined, {
        lines: ['документ готов, план записан', 'APPROACH_NOTE: соврал'],
      }),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-CONTEXT.md`]: 'ctx' }), // a different stage's file
        execGit: makeGit({ '.planning/phases/12-front/12-CONTEXT.md': 'deadbee' }),
      },
    })

    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId: 'ST-1', reason: 'no_artifact' })
    expect(String(res.failed.detail)).toContain('-PLAN.md')
    expect(adapter.calls).toEqual([{ op: 'fail', id: 'ST-1', reason: 'no_artifact' }])
  })

  it('artifact on disk but NEVER COMMITTED → fail("no_artifact") — the history is half the gate', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'verify', phase: 12 }))
    const { deps } = stageDeps({
      adapter,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-VERIFICATION.md`]: '# verdict' }),
        execGit: makeGit({}), // git names no commit for it
      },
    })

    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId: 'ST-1', reason: 'no_artifact' })
    expect(String(res.failed.detail)).toContain('не закоммичен')
  })

  it('an undeclared stage is refused by name — no gate is picked by default', async () => {
    // `data.stage` is a closed vocabulary at enqueue; this is the layer below, where a row
    // written by an older or a foreign writer could still arrive with a stage nobody declared.
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'ponder', phase: 12 }))
    const { deps } = stageDeps({ adapter, deps: { fsImpl: makeFs({}), execGit: makeGit({}) } })

    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId: 'ST-1', reason: 'no_artifact' })
    expect(String(res.failed.detail)).toContain('ponder')
  })
})

describe('a discussion round parks for a human instead of going red', () => {
  it('an open question in the workflow’s own checkpoint is a SUCCESSFUL round — awaiting_approval', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask({ kind: 'document', stage: 'discuss', phase: 12 }))
    const { deps, order } = stageDeps({
      adapter,
      clockObj: c,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-DISCUSS-CHECKPOINT.json`]: parkedCheckpointJson }),
        execGit: makeGit({ '.planning/phases/12-front/12-DISCUSS-CHECKPOINT.json': 'c0ffee1' }),
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    const [row] = await adapter.list({})
    // the contract turns a receipted complete() into «ждёт человека» — the card the screen shows
    expect(row.status).toBe('awaiting_approval')
    expect(order).toEqual(['spawn'])
  })

  it('a parked question that was never committed is not a question yet', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'discuss', phase: 12 }))
    const { deps } = stageDeps({
      adapter,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-DISCUSS-CHECKPOINT.json`]: parkedCheckpointJson }),
        execGit: makeGit({}),
      },
    })

    const res = await tick(deps)
    expect(res.failed).toMatchObject({ reason: 'no_artifact' })
    expect(String(res.failed.detail)).toContain('только этой машине')
  })

  it('no checkpoint and a committed context file → the discussion simply ENDED, ordinary success', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'discuss', phase: 12 }))
    const { deps } = stageDeps({
      adapter,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-CONTEXT.md`]: '# context' }),
        execGit: makeGit({ '.planning/phases/12-front/12-CONTEXT.md': 'facade1' }),
      },
    })

    const res = await tick(deps)
    expect(res.completed).toBe('ST-1')
    expect(adapter.calls[0].result.receiptRef).toBe('artifact:.planning/phases/12-front/12-CONTEXT.md@facade1')
  })

  it('the gate is a FILE check: an answered checkpoint parks nothing, however loud the stream', async () => {
    const answered = JSON.stringify({
      phase: '12',
      areas_completed: ['Область 1'],
      decisions: { 'Область 1': [{ question: 'q', answer: 'да', options_presented: [] }] },
    })
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'discuss', phase: 12 }))
    const { deps } = stageDeps({
      adapter,
      spawnWorker: makeSpawnWorker(undefined, { lines: ['жду ответа человека', 'APPROACH_NOTE: спросил'] }),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-DISCUSS-CHECKPOINT.json`]: answered }),
        execGit: makeGit({ '.planning/phases/12-front/12-DISCUSS-CHECKPOINT.json': 'c0ffee1' }),
      },
    })

    const res = await tick(deps)
    // nothing is open, so the round did not park — and the stage owes its own document
    expect(res.failed).toMatchObject({ reason: 'no_artifact' })
  })
})

describe('an execute stage parks its blocking checkpoint the same way — BEFORE the code gate', () => {
  it('an EXEC checkpoint with an open question → complete on the artifact receipt, no reverify', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const { deps, order } = stageDeps({
      adapter,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/repo', branch: 'wt/exec' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-EXEC-CHECKPOINT.json`]: parkedCheckpointJson }),
        execGit: makeGit({ '.planning/phases/12-front/12-EXEC-CHECKPOINT.json': 'ba5eba11' }),
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    expect(adapter.calls[0].result.receiptRef).toBe('artifact:.planning/phases/12-front/12-EXEC-CHECKPOINT.json@ba5eba11')
    // the checkpoint is asked BEFORE the code gate — reverify never ran
    expect(order).toEqual(['preflight', 'worktree', 'spawn'])
    // …and the position is not thrown away: the row parks instead of failing, so the answer
    // wakes a CONTINUATION of the stage rather than a fresh attempt from zero
    expect(adapter.calls.some((x: any) => x.op === 'fail')).toBe(false)
  })

  it('the shape it parks on is the SHIPPED workflow’s own — read out of execute-phase.md, not typed here', async () => {
    // The strongest form of «one parser, one card»: the artifact the workflow documents is
    // lifted off disk and fed to the daemon. A fixture typed out in this file would only
    // prove that the gate reads what its own author wrote.
    const workflow = readFileSync(join('sma-core', 'workflows', 'execute-phase.md'), 'utf8')
    const block = workflow.slice(workflow.indexOf('EXEC-CHECKPOINT.json`'))
    const json = block.slice(block.indexOf('```json') + 7, block.indexOf('```', block.indexOf('```json') + 7))
    // two placeholders stand where numbers go; everything else is literal JSON
    const documented = JSON.parse(json.replace('{task_number}', '3').replace('{wave_number}', '2'))

    // it IS the discussion checkpoint's shape, plus a position block and nothing else
    expect(Object.keys(documented).sort()).toEqual(
      [...Object.keys(discussTemplate), 'position'].sort(),
    )
    expect(documented.position).toEqual({ plan: '{plan_id}', task: 3, wave: 2 })
    // …and the question it carries is OPEN by the shared convention: an empty answer
    expect(Object.values(documented.decisions as any)[0][0].answer).toBe('')

    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const { deps } = stageDeps({
      adapter,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/repo', branch: 'wt/exec' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-EXEC-CHECKPOINT.json`]: JSON.stringify(documented) }),
        execGit: makeGit({ '.planning/phases/12-front/12-EXEC-CHECKPOINT.json': 'd0cf00d' }),
      },
    })

    const res = await tick(deps)
    expect(res.completed).toBe('ST-1')
    expect(adapter.calls[0].result.receiptRef).toContain('12-EXEC-CHECKPOINT.json@d0cf00d')
  })

  it('REGRESSION — an execute stage with NO checkpoint runs the code gate exactly as before', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const { deps, order } = stageDeps({
      adapter,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/repo', branch: 'wt/exec' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: { fsImpl: makeFs({}), execGit: makeGit({}) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    expect(order).toEqual(['preflight', 'worktree', 'spawn', 'reverify'])
    expect(adapter.calls[0].result.receiptRef).toBe('reverify:abc') // the ORIGINAL receipt, unchanged
  })

  it('REGRESSION — a task with no data envelope at all is ordinary code work', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-REG' }))
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-REG', branch: 'wt/x' }) },
        reverify: GREEN_REVERIFY,
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-REG')
    expect(order).toEqual(['preflight', 'worktree', 'spawn', 'reverify'])
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
  })
})

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
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
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

// ═══════════ THE LIVE ATTEMPT LOG — the tick writes it WHILE the worker speaks ═══════════

describe('the tick keeps a live log of the attempt, and never dies of it', () => {
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

  /** A REAL ledger over a temp dir: attempt rows and the live log, exactly as main.mjs wires them. */
  const realLedger = (ledgerDir: string, over: any = {}) => ({
    recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
    readAttempts: (id: string) => readAttempts(ledgerDir, id),
    attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    ...over,
  })

  /** What a delegating session prints: its own line, a SUBAGENT's, a plain note, a result frame. */
  const DELEGATING_STREAM = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_01SUB', message: { model: 'claude-opus-4-8' } }),
    'APPROACH_NOTE: прямой путь',
    JSON.stringify({ type: 'result', session_id: '9f8e7d6c-1234-4abc-8def-0123456789ab', total_cost_usd: 0.03 }),
  ]

  const greenRun = (ledgerDir: string, over: any = {}) => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    return {
      c,
      adapter,
      mk: () =>
        makeDeps({
          adapter,
          clockObj: c,
          spawnWorker: makeSpawnWorker(undefined, { lines: DELEGATING_STREAM }),
          responses: {
            preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
            worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
            reverify: GREEN_REVERIFY,
          },
          deps: { ledger: realLedger(ledgerDir, over) },
        }),
    }
  }

  it('every line reaches the attempt’s own file, and the delegated one is marked as delegated', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const run = greenRun(ledgerDir)
    await run.adapter.enqueue(backlogTask())
    const { deps } = run.mk()

    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')

    const log = readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#1' })
    expect(log.total).toBe(DELEGATING_STREAM.length) // four lines in, four rows out — nothing dropped
    expect(log.truncated).toBe(false)
    const subagentRows = log.entries.filter((e: any) => e.subagent === true)
    expect(subagentRows).toHaveLength(1)
    expect(subagentRows[0].parentId).toBe('toolu_01SUB')
    // a line that is not a frame is still a line
    expect(log.entries.some((e: any) => e.line === 'APPROACH_NOTE: прямой путь')).toBe(true)
    // and it was written to the ATTEMPT's file, not the task's
    expect(readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#2' }).total).toBe(0)
  })

  it('the sessionId off the result frame lands on the attempt row — the one fact nothing else can recover', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const run = greenRun(ledgerDir)
    await run.adapter.enqueue(backlogTask())
    const { deps } = run.mk()

    await tick(deps)

    const [row] = readAttempts(ledgerDir, 'BL-1')
    expect(row.outcome).toBe('completed')
    expect(row.sessionId).toBe('9f8e7d6c-1234-4abc-8def-0123456789ab')
  })

  it('an attempt whose stream never names a session carries NO sessionId key — absence, not an empty string', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: makeSpawnWorker(undefined, { lines: ['plain text', 'APPROACH_NOTE: прямой путь'] }),
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: { ledger: realLedger(ledgerDir) },
    })

    await tick(deps)

    const [row] = readAttempts(ledgerDir, 'BL-1')
    expect(Object.hasOwn(row, 'sessionId')).toBe(false)
  })

  it('A LOG THAT CANNOT BE WRITTEN COSTS THE PICTURE AND NOTHING ELSE — the task completes by its own gate', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    // a directory that is really a FILE: every append underneath it fails, for real
    const unreachable = join(ledgerDir, 'not-a-dir')
    writeFileSync(unreachable, 'i am a file', 'utf8')

    const run = greenRun(ledgerDir, {
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: join(unreachable, 'nested'), attemptId }),
    })
    await run.adapter.enqueue(backlogTask())
    const { deps } = run.mk()

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1') // the gate decided, exactly as it does with a working log
    const [row] = readAttempts(ledgerDir, 'BL-1')
    expect(row.outcome).toBe('completed')
    expect(row.sessionId).toBe('9f8e7d6c-1234-4abc-8def-0123456789ab') // still read off the stream
  })

  it('a ledger seam that THROWS when asked for a writer is survived, named in the log, and treated as absent', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const run = greenRun(ledgerDir, {
      attemptLog: () => {
        throw new Error('no log for you')
      },
    })
    await run.adapter.enqueue(backlogTask())
    const { deps, journalled } = run.mk()

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    expect(journalled.some((e: any) => e.type === 'attempt-log-error')).toBe(true)
  })

  it('a daemon assembled with NO log seam at all behaves exactly as it did before (regression)', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const run = greenRun(ledgerDir, { attemptLog: undefined })
    await run.adapter.enqueue(backlogTask())
    const { deps } = run.mk()

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    expect(readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#1' }).total).toBe(0)
  })

  it('EVERY spawn is assembled with forwardSubagentText — otherwise the delegated half of the log is silent', async () => {
    const seen: any[] = []
    const ledgerDir = mkDir('sma-loop-log-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: makeSpawnWorker(undefined, { lines: DELEGATING_STREAM }),
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: {
        ledger: realLedger(ledgerDir),
        buildArgs: (_task: any, _route: any, opts: any) => {
          seen.push(opts)
          return { bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }
        },
      },
    })

    await tick(deps)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ forwardSubagentText: true })
  })

  it('the same option reaches the FORGE lane’s spawn, and that lane keeps a transcript too', async () => {
    const seen: any[] = []
    const ledgerDir = mkDir('sma-loop-log-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({
      id: 'F-1',
      source: 'roster',
      title: 'выкуй агента',
      lane: 'forge',
      priority: 0,
      forge: { kind: 'agent', description: 'читает и суммирует' },
    } as any)
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [{ id: 'max-2', lane: 'forge', provider: 'claude', account: { configDir: '/x' }, enabled: true }] },
      spawnWorker: makeSpawnWorker(undefined, { lines: DELEGATING_STREAM }),
      responses: { worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/F-1', branch: 'wt/x' }) } },
      deps: {
        ledger: realLedger(ledgerDir),
        execGit: () => '',
        buildArgs: (_task: any, _route: any, opts: any) => {
          seen.push(opts)
          return { bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'forge it' }
        },
      },
    })

    await tick(deps)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ forwardSubagentText: true })
    // the forge attempt fails its own draft gate here (nothing committed) — and it STILL left
    // a transcript, because a lane nobody can watch is the lane that goes quiet at 3am
    const log = readAttemptLog({ dir: ledgerDir, attemptId: 'F-1#1' })
    expect(log.total).toBe(DELEGATING_STREAM.length)
    expect(log.entries.filter((e: any) => e.subagent === true)).toHaveLength(1)
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
