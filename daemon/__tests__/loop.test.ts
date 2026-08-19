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

import {
  tick,
  runDaemon,
  classifyFailure,
  unregisteredMcpTools,
  DENIAL_LINES_CAP,
  DENIAL_COMMAND_MAX,
  DENIAL_TRUNCATION_MARK,
} from '../src/loop.mjs'
import { tokenHash } from '../../scripts/sma/lib/registry.mjs'
import { createMemoryQueue, REASON_LABELS } from '../src/queue/adapter.mjs'
// Imported for the cases at the foot of this file: the wire from a worker's stdout to the
// screen's payload. Every joint of that path had a green test of its own while the path
// itself was cut, so the case has to cross the module boundary the defect hid behind.
import { deriveState } from '../src/front/state.mjs'
import { windowState, isOpen } from '../src/policy/windows.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { workerReadiness, poolReadiness } from '../src/runner/readiness.mjs'
import { defaultEnvelope, envelopeAllows, envelopeHash, humanOnlyDenials } from '../src/queue/capability-envelope.mjs'
import { STATE_MACHINE_VERSION, idempotencyKey } from '../src/queue/state-machine.mjs'
import {
  recordAttempt,
  readAttempts,
  memorySnapshotHash,
  MEMORY_SNAPSHOT_ABSENT,
  createAttemptLogWriter,
  readAttemptLog,
} from '../src/queue/attempt-ledger.mjs'
import { appendRedirect, readPendingRedirects } from '../src/runner/redirects.mjs'
import { writeWaveHold } from '../src/queue/wave-holds.mjs'
// The mirror and the argument builder are used AS THEMSELVES in the wiring cases at the
// foot of this file: a fake of either could not be poorer than the library, and a fake of
// the parity guard would be exactly the hole those cases exist to close.
import { mirrorPersonalLayer, PersonalLayerError } from '../src/runner/personal-layer.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'

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
// A COMPLETE attempt carries a green receipt, an approach note AND a word about the lesson —
// the default fake worker leaves all three, so every case below is about ITS own subject. The
// lesson law itself is exercised by the gate cases further down; «тестовый работник» is the
// stated reason a fake has for teaching nothing, and a stated reason is what the gate asks for.
function makeSpawnWorker(
  order?: string[],
  opts: { lines?: string[]; code?: number; throwSync?: boolean; noLesson?: boolean } = {},
) {
  const { lines = ['stream line', 'APPROACH_NOTE: прямой путь'], code = 0, throwSync = false, noLesson = false } = opts
  // A case that dictates its own lines is almost never a case ABOUT the lesson, so the fake
  // closes the third condition for it — exactly as a real worker does — unless the case said
  // its own word about the lesson, or asked for silence to test the gate itself.
  const spoken =
    noLesson || lines.some((l) => typeof l === 'string' && l.includes('LESSON_'))
      ? lines
      : [...lines, 'LESSON_NONE: тестовый работник']
  return (spec: any) => {
    order?.push('spawn')
    if (throwSync) throw new Error('spawn infra failure')
    for (const l of spoken) spec.onLine?.(l)
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
    // No already-built question for work that carries no phase: such a task has no plan, so
    // there is nothing deterministic to ask about (the reason is on the daemon's log instead).
    expect(order).toEqual(['worktree', 'reverify', 'spawn', 'reverify'])
  })
})

describe('tick — the stateless composed tick', () => {
  it('runs the full trace in order: worktree → reverify(до) → spawn → reverify → complete', async () => {
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

    // TWO re-verifications, and the first one is not a duplicate: it is the BEFORE picture
    // the exit gate subtracts, taken in the fresh worktree before a worker exists. The
    // already-built door is absent from the trace on purpose: this task carries no phase, so
    // it has no plan to be asked about — the traced route WITH the door is the case below.
    expect(order).toEqual(['worktree', 'reverify', 'spawn', 'reverify'])
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
    // The door is asked about the PLAN of a phase, so the task has to carry one and the plan
    // has to be in the tree — a task without either is never asked at all.
    await adapter.enqueue(backlogTask({ id: 'BL-2', data: { kind: 'code', stage: 'execute', phase: 12 } }))
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'built' }) } },
      deps: { fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }) },
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
    expect(order).toEqual([]) // no worktree, no spawn — and no door for phaseless work
  })

  it('the preflight-«built» door still completes without any executor (the pilot smoke path)', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ data: { kind: 'code', stage: 'execute', phase: 12 } }))
    const { deps, order } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'built' }) } },
      deps: { buildArgs: undefined, fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }) },
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
    expect(order).toEqual([]) // no worktree was provisioned, no worker started
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
    // the checkpoint is asked BEFORE the code gate — the CERTIFYING re-verification never
    // ran (the one in the list is the before-picture, taken ahead of the spawn). The
    // already-built door is not in the list because this phase has no plan file in the tree
    // the door reads: it says so on the log and lets the work through.
    expect(order).toEqual(['worktree', 'reverify', 'spawn'])
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
      // the phase's plan IS in the tree, so the already-built door is genuinely asked and
      // answers «not built» — the whole route of a phase-carrying stage, door included
      deps: { fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }), execGit: makeGit({}) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    expect(order).toEqual(['preflight', 'worktree', 'reverify', 'spawn', 'reverify'])
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
    // no data envelope → no phase → no plan → the door is not asked at all
    expect(order).toEqual(['worktree', 'reverify', 'spawn', 'reverify'])
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
    await adapter.enqueue(backlogTask({ data: { kind: 'code', stage: 'execute', phase: 12 } }))
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      responses: { preflight: { code: 0, stdout: JSON.stringify({ verdict: 'built' }) } },
      deps: {
        ledger: { recordAttempt: (row: any) => recordAttempt(ledgerDir, row), readAttempts: () => [] },
        fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }),
      },
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

  /**
   * ОБРЫВ У ПРОВАЙДЕРА — ЭТО НЕ ВИНА РАБОТНИКА, и таксономия обязана их различать.
   *
   * Живой прогон: попытку убил 529 Overloaded на стороне провайдера, а окно сказало «нет
   * записки о подходе — попытка не объяснена». Записка и не могла появиться: работника
   * оборвали на полуслове. Названо было следствие, а виноватым выглядел работник.
   *
   * Обрыв стоит сразу за несостоявшимся запуском и ВЫШЕ всего остального: когда прогон
   * закончил не работник, ни отсутствие записки, ни красный прогон, ни маркер не годятся в
   * причину — судить не о чем.
   */
  it('провайдер оборвал прогон → provider_error, а не «нет записки»', () => {
    expect(classifyFailure({ exitCode: 1, providerAbort: { status: 529 }, receipt: { verdict: 'green', ref: 'r' }, journalComplete: false })).toBe('provider_error')
  })

  it('обрыв провайдера сильнее красного прогона и маркера — судить нечего', () => {
    expect(
      classifyFailure({ exitCode: 1, providerAbort: { status: 529 }, receipt: { verdict: 'red', ref: 'r' }, workerMarker: 'MISSING_ACCESS' }),
    ).toBe('provider_error')
  })

  it('но несостоявшийся запуск остаётся сильнее: обрывать было нечего', () => {
    expect(classifyFailure({ spawnError: new Error('offline'), providerAbort: { status: 529 } })).toBe('runtime_offline')
  })
})

/**
 * ═══════ ПРОВОД: СЛОВО ПРОВАЙДЕРА ДОЕЗЖАЕТ ДО СТРОКИ ЗАДАЧИ И ДО КАРТОЧКИ ═══════
 *
 * Классификатор, знающий про обрыв, и строка, показывающая обрыв, — разные вещи, и вторая
 * не следует из первой. Поэтому случай идёт от начала маршрута: поток работника несёт
 * ЗАВЕРШАЮЩИЙ кадр CLI ровно такой, какой пришёл в живом прогоне, — и проверяется то, что
 * записано в очереди и что прочтёт с неё окно.
 */
describe('обрыв на стороне провайдера назван обрывом — от кадра до карточки', () => {
  // Кадр из живой попытки: провайдер ответил 529, CLI закончил прогон своей ошибкой.
  const PROVIDER_529 = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 529,
    result: 'API Error: 529 Overloaded',
    session_id: 's-529',
  })

  async function runWithLines(lines: string[]) {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-529' }))
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: makeSpawnWorker(undefined, { lines, code: 1 }),
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-529', branch: 'wt/BL-529' }) },
        reverify: GREEN_REVERIFY,
      },
    })
    const res = await tick(deps)
    const [row] = await adapter.list({})
    return { res, row }
  }

  it('попытка, убитая провайдером, несёт причиной ПРОВАЙДЕРА, а не отсутствие записки', async () => {
    // ровно живая картина: записки нет — работника оборвали раньше, чем он её написал
    const { res, row } = await runWithLines(['начал разбираться', PROVIDER_529])

    expect(res.failed).toEqual({ taskId: 'BL-529', reason: 'provider_error' })
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('provider_error')
    // и у окна есть что показать: подпись строки берётся отсюда и ниоткуда больше
    expect(REASON_LABELS[row.failure_reason]).toMatch(/провайдер/i)
  })

  it('без обрыва тот же поток без записки остаётся «нет записки» — случай не съел соседний', async () => {
    const { res } = await runWithLines(['начал разбираться', JSON.stringify({ type: 'result', is_error: false, session_id: 's-ok' })])
    expect(res.failed).toEqual({ taskId: 'BL-529', reason: 'no_journal' })
  })

  /**
   * СЛОВО «529» В РЕЧИ РАБОТНИКА — НЕ ОБРЫВ. Работник, разбирающий чужую ошибку, произносит
   * её текст вслух, и попытка, объявленная оборванной за упоминание, была бы диагнозом по
   * подслушанному слову. Обрыв признаётся ТОЛЬКО по завершающему кадру самого CLI.
   */
  it('работник, ПЕРЕСКАЗАВШИЙ ошибку провайдера, не объявляется оборванным', async () => {
    const talk = JSON.stringify({
      type: 'assistant',
      message: { model: 'x', content: [{ type: 'text', text: 'в логе видно API Error: 529 Overloaded, чиню' }] },
    })
    const { res } = await runWithLines([talk, JSON.stringify({ type: 'result', is_error: false, session_id: 's-ok' })])
    expect(res.failed).toEqual({ taskId: 'BL-529', reason: 'no_journal' })
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
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'гоняет сьют' } },
          { type: 'tool_use', name: 'Task', input: { subagent_type: 'sma-executor', prompt: 'почини гейт' } },
        ],
      },
    }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_01SUB', message: { model: 'claude-opus-4-8' } }),
    'APPROACH_NOTE: прямой путь',
    'LESSON_NONE: тестовый работник',
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

  it('a queued correction resumes the SAME session after the run — once, consumed, with the correction in the prompt (руль)', async () => {
    const ledgerDir = mkDir('sma-loop-rd-')
    const dataDir = mkDir('sma-loop-rd-data-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })

    // Every spawn is recorded; each emits a session id and exits green.
    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
      spec.onLine?.(JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' }))
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }

    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: { ledger: realLedger(ledgerDir) },
    })
    deps.config.dataDir = dataDir // the redirect store's root — the continuation loop's switch

    // The founder's correction is pinned BEFORE the tick — «после хода».
    appendRedirect({ dataDir, taskId: 'BL-1', text: 'нет, правь шапку, не подвал', mode: 'queue', clock: c.clock })

    const res = await tick(deps)
    expect(res.completed).toBe('BL-1') // the corrected attempt still ends through the gates

    // Two spawns: the run, then ONE continuation of the SAME session with the correction.
    expect(spawns).toHaveLength(2)
    const resumeAt = spawns[1].args.indexOf('--resume')
    expect(resumeAt).toBeGreaterThan(-1)
    expect(spawns[1].args[resumeAt + 1]).toBe('11111111-2222-4333-8444-555555555555')
    expect(spawns[1].prompt).toContain('нет, правь шапку')
    expect(spawns[0].args).not.toContain('--resume') // the first run was the ordinary spawn

    // Consumed exactly once — a second tick would find nothing to continue.
    expect(readPendingRedirects({ dataDir, taskId: 'BL-1' })).toEqual([])
  })

  it('a RETURNED task’s next attempt resumes the prior session — the paid-for context survives', async () => {
    const ledgerDir = mkDir('sma-loop-res-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ args: spec.args.slice() })
      spec.onLine?.('APPROACH_NOTE: продолжил')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: { ledger: realLedger(ledgerDir) },
    })

    // The prior run's row carries the session — exactly what the return left behind.
    deps.ledger.recordAttempt({ taskId: 'BL-1', attempt: 1, outcome: 'returned', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    await adapter.enqueue(backlogTask({ attempt: 2 }))

    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')
    const at = spawns[0].args.indexOf('--resume')
    expect(at).toBeGreaterThan(-1)
    expect(spawns[0].args[at + 1]).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('every line reaches the attempt’s own file, and the delegated one is marked as delegated', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const run = greenRun(ledgerDir)
    await run.adapter.enqueue(backlogTask())
    const { deps } = run.mk()

    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')

    const log = readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#1' })
    // every line in, every line out — plus ONE the tick itself speaks: the lesson verdict
    // lands in the same file, so «why was this row red» never needs the gate's source
    expect(log.total).toBe(DELEGATING_STREAM.length + 1)
    expect(log.truncated).toBe(false)
    const subagentRows = log.entries.filter((e: any) => e.subagent === true)
    expect(subagentRows).toHaveLength(1)
    expect(subagentRows[0].parentId).toBe('toolu_01SUB')
    // a line that is not a frame is still a line
    expect(log.entries.some((e: any) => e.line === 'APPROACH_NOTE: прямой путь')).toBe(true)
    // and it was written to the ATTEMPT's file, not the task's
    expect(readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#2' }).total).toBe(0)
  })

  it('a stored row says WHICH TOOL ran and WHAT was handed to a subagent — not a machine frame', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    const run = greenRun(ledgerDir)
    await run.adapter.enqueue(backlogTask())
    const { deps } = run.mk()

    await tick(deps)

    const log = readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#1' })
    const withSummary = log.entries.filter((e: any) => Array.isArray(e.summary) && e.summary.length)
    // THIS is the lock the whole class of defect needed: the summariser can be perfect and
    // fully tested, and the log still shows raw JSON if nobody joins the two. Assert the
    // JOIN, on a row that came out of a real tick.
    expect(withSummary.length).toBeGreaterThan(0)

    const parts = withSummary[0].summary
    const tool = parts.find((p: any) => p.kind === 'tool')
    expect(tool.tool).toBe('Bash')
    expect(tool.detail).toBe('npm test') // the command that will really run, not the label somebody wrote

    const handoff = parts.find((p: any) => p.kind === 'handoff')
    expect(handoff.subagent).toBe('sma-executor')
    expect(handoff.detail).toBe('почини гейт') // the brief — the single most asked-for line in this log

    // the raw line is still stored beside it: a summary is a glance, never a replacement
    expect(withSummary[0].line).toContain('tool_use')
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
    expect(seen[0].forwardSubagentText).toBe(true)
    // AND THE TOOL GRANT RIDES THE SAME CALL. The envelope's allowedTools used to stop at the
    // attempt row's hash: the spawn was assembled without any grant at all, so the CLI refused
    // Edit/Write/Bash inside the child and no worker in this fleet could change a single file
    // (measured 12.08.2026). The assertion is on the WIRE — the policy itself was never the
    // broken half, and a test of the policy would have stayed green through all of it.
    expect(seen[0].allowedTools, 'spawn options carry no tool grant — the worker would be read-only').toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']),
    )
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
    expect(seen[0].forwardSubagentText).toBe(true)
    // AND THE TOOL GRANT RIDES THE FORGE SPAWN TOO. The code path was given the envelope on
    // 12.08 and this lane was left behind: the «Создатель» spawned read-only, could not write
    // the draft file it was ordered to write, and the exit gate then failed it for not
    // committing one — «ошибка работника», with nothing on the card to explain it.
    expect(seen[0].allowedTools, 'the forge spawn carries no tool grant — the «Создатель» would be read-only').toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']),
    )
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

/**
 * ═════════════ AN ANSWER IS ALSO WORK — AND THE CODE LAW IS UNTOUCHED ══════════════
 *
 * «Разберись и скажи» used to end in fail('no_receipt'): the only door to done demanded a
 * receipt over code that was never supposed to exist. The founder ruled that such a task
 * ends with the worker's answer, taken to approval to be acknowledged.
 *
 * ONE case below opens that door. The other FOUR exist to prove it is a door and not a
 * hole — each is an attempt that also lacks a receipt, and each must still go red:
 * a commit on the branch, an edit left uncommitted, an attempt that never explained
 * itself, and a git that cannot answer. The gate opens ONLY for a repository that cannot
 * tell the attempt ever happened.
 */
describe('a task that needed no code completes on its answer — and nothing else does', () => {
  const CODE_RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
    reverify: { code: 0, stdout: '{}' }, // exits green, names NO receipt — the old red path
  }

  /** A git that answers the gate's two questions, and can be told to fail at either. */
  const makeAnswerGit = ({ commits = '0', dirty = '', throwOn = '' } = {}) =>
    (args: string[]) => {
      const verb = args[0]
      if (verb === throwOn) throw new Error(`git ${verb} unavailable`)
      if (verb === 'rev-list') return commits
      if (verb === 'status') return dirty
      return ''
    }

  it('changed nothing and explained itself → completes on an answer receipt, and reverify is never asked', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, order, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit() },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const [call] = adapter.calls
    expect(call.op).toBe('complete')
    expect(call.result.receiptRef).toBe('answer:BL-1#1')
    // there was nothing to certify, so the CERTIFYING run of the verb was not spent on it —
    // the one before the spawn is the gate's before-picture, taken when no outcome is known yet
    // (phaseless work is never asked the already-built question — it has no plan)
    expect(order).toEqual(['worktree', 'reverify', 'spawn'])
    // and the outcome is on the operator's record, never silent
    expect(journalled.some((e: any) => e.type === 'task.answered' && e.taskId === 'BL-1')).toBe(true)
  })

  it('a commit on the branch → the code law stands: fail("no_receipt")', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, order } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit({ commits: '1' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    expect(order).toContain('reverify') // it WAS asked — this is code work
  })

  it('an edit left uncommitted is unfinished work, not an answer → fail("no_receipt")', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit({ dirty: ' M daemon/src/loop.mjs' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
  })

  it('an answer nobody wrote down is not an answer → fail("no_receipt")', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      spawnWorker: makeSpawnWorker(undefined, { lines: ['stream line'] }), // no APPROACH_NOTE
      deps: { execGit: makeAnswerGit() },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
  })

  for (const verb of ['rev-list', 'status']) {
    it(`git cannot answer "${verb}" → the gate fails SAFE, the old outcome stands`, async () => {
      const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
      const { deps } = makeDeps({
        adapter,
        responses: CODE_RESPONSES,
        deps: { execGit: makeAnswerGit({ throwOn: verb }) },
      })

      const res = await tick(deps)

      expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    })
  }

  it('no git surface at all → the gate cannot open', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({ adapter, responses: CODE_RESPONSES })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
  })

  /**
   * WHICH TREE THE COUNT IS TAKEN IN. The question the gate asks — «are there commits on
   * wt/<taskId> that HEAD does not have» — can only be answered in the repository that HOLDS
   * that branch: the CONNECTED project, the same tree the worktree was cut from. It used to be
   * asked in the daemon's launch directory, where the branch does not exist at all: git exits
   * non-zero, the fail-safe catch answers null, and a task that correctly wrote no code fell
   * through to the code gate and went red — the exact outcome this gate exists to remove.
   */
  it('the «no code» count is taken in the CONNECTED project, where the task branch actually lives', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const seen: any[] = []
    const { deps } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: {
        projectDir: () => '/connected',
        execGit: (args: string[], opts?: any) => {
          seen.push({ verb: args[0], cwd: opts && opts.cwd })
          // the real failure mode: `wt/BL-1` is not a revision in the launch tree
          if (args[0] === 'rev-list' && (!opts || opts.cwd !== '/connected')) throw new Error('unknown revision wt/BL-1')
          if (args[0] === 'rev-list') return '0'
          return ''
        },
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    expect(seen.find((s) => s.verb === 'rev-list').cwd).toBe('/connected')
  })

  it('with no project connected the count falls back to the served tree (regression)', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const seen: any[] = []
    const { deps } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: {
        execGit: (args: string[], opts?: any) => {
          seen.push({ verb: args[0], cwd: opts && opts.cwd })
          return args[0] === 'rev-list' ? '0' : ''
        },
      },
    })

    await tick(deps)

    expect(seen.find((s) => s.verb === 'rev-list').cwd).toBe('/repo')
  })
})

/**
 * ═════════ THE PROVIDER'S WORD ABOUT A WINDOW REACHES THE SCREEN, OR IT IS NOTHING ═════════
 *
 * This is a WIRE test, not a calculation test, and the difference is the whole reason it
 * exists. Every piece of this path already had passing tests of its own on 12.08.2026 — the
 * parser had one, the store had one, the read model had one — and what travelled between them
 * was wrong. The provider sends no `utilization`; the parser honestly said null; the store did
 * `Number(null)`, which is 0, and filed «0% of this window is spent» as a measurement. Every
 * unit test passed because every unit test handed the store a fraction. «Расходы» therefore
 * drew a confident 0% forever, and 0% reads as «the quota is free».
 *
 * So this case starts where the truth starts — one VERBATIM line of a worker's stdout, copied
 * from the founder's own ledger — runs it through the real tick, and ends where a person looks:
 * the payload `deriveState` puts on the screen. Nothing in between is faked or asserted about.
 * If any joint on that path comes apart again, this goes red.
 */
describe('a rate-limit frame travels from the worker stream to the screen', () => {
  const dirs: string[] = []
  afterAll(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  /** The line as the CLI really emitted it — seconds-epoch reset, status, no utilization. */
  const RESETS_AT_SEC = 1786539600
  const RATE_LIMIT_LINE = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: RESETS_AT_SEC,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
      isUsingOverage: false,
    },
    uuid: 'cd23b1f0-65d4-4c29-90da-c9dfcb6b46bd',
    session_id: '94c56115-079d-4a99-b414-457167bc90dc',
  })

  /** A tick that spawns a worker which says exactly that, and nothing else of interest. */
  async function tickWith(line: string, dataDir: string, now: number) {
    const c = mkClock(now)
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: {
        dataDir,
        pipeline: { enabled: true },
        workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { name: 'max-2' }, enabled: true }],
      },
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      spawnWorker: makeSpawnWorker(undefined, { lines: [line, 'APPROACH_NOTE: прямой путь'] }),
      deps: {
        // The account this attempt runs on rides out of buildArgs in the real daemon; the fake
        // one has to carry it too, because the account name is what the reading is filed under.
        buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it', workerId: 'max-2', accountName: 'max-2' }),
      },
    })
    await tick(deps)
    return { clock: c.clock }
  }

  it('the window a worker was told about is the window «Расходы» shows, reset time and all', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-win-'))
    dirs.push(dataDir)
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000 // an hour before the window turns over

    await tickWith(RATE_LIMIT_LINE, dataDir, now)

    const payload = await deriveState({
      adapter: { async list() { return [] } },
      windows: (account: any) => windowState({ account, clock: () => now, dataDir }),
      config: { workers: [{ id: 'max-2', lane: 'prod', account: { name: 'max-2' } }], machineId: 'self' },
      clock: () => now,
    })

    // THE SCREEN'S OWN DATA. «Расходы» reads spend.accounts and nothing else for this section.
    const [account] = payload.spend.accounts
    expect(account.name).toBe('max-2')
    expect(account.fiveHour.status).toBe('open') // the provider said «allowed»
    expect(account.fiveHour.resetsAt).toBe(new Date(RESETS_AT_SEC * 1000).toISOString())
    expect(account.fiveHour.pct).toBeNull() // it sent no fraction, so the screen shows none
    expect(account.week.status).toBe('unknown') // the other window was never mentioned
  })

  it('a refused window arrives as «exhausted» and stops the account being routed to', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-shut-'))
    dirs.push(dataDir)
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000
    const refused = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT_SEC, rateLimitType: 'five_hour', isUsingOverage: false },
    })

    await tickWith(refused, dataDir, now)

    const state = windowState({ account: { name: 'max-2' }, clock: () => now, dataDir })
    expect(state.fiveHour.status).toBe('exhausted')
    expect(state.closedUntil).toBeDefined() // the refusal was PERSISTED, not merely noticed
    expect(isOpen(state, () => now)).toBe(false)
  })

  it('a machine that has heard nothing says so — no reading is ever invented as a zero', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-quiet-'))
    dirs.push(dataDir)
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000

    const payload = await deriveState({
      adapter: { async list() { return [] } },
      windows: (account: any) => windowState({ account, clock: () => now, dataDir }),
      config: { workers: [{ id: 'max-2', lane: 'prod', account: { name: 'max-2' } }], machineId: 'self' },
      clock: () => now,
    })

    const [account] = payload.spend.accounts
    expect(account.fiveHour).toEqual({ status: 'unknown', resetsAt: null, pct: null })
    expect(account.week).toEqual({ status: 'unknown', resetsAt: null, pct: null })
  })
})

/**
 * ═══════════ ОДИН РАБОТНИК, ПО ОДНОМУ ЗА РАЗ — ЧЕРЕЗ ЖИВОЙ ТИК ═══════════════════════
 *
 * The queue's own contract already says the pieces of an assembly are handed out one at a
 * time (adapter.mjs). What is asserted HERE is the half the queue cannot assert about
 * itself: that a real tick, with routing and a worker pool in it, gives the next piece to
 * the worker that ran the previous one, wedges an urgent inline task BETWEEN pieces without
 * ever interrupting a live one, and — when a piece breaks — stops and repeats NOTHING no
 * matter how many times it runs.
 *
 * The last of those is the loop of 12.08.2026 written down as a test: three live sessions on
 * one task, a burnt subscription, an empty board. Nothing here is allowed to happen by itself.
 */
describe('a batch is dispatched one piece at a time, by one worker', () => {
  const TWO_WORKERS = [
    { id: 'w-first', lane: 'prod', provider: 'claude', account: { configDir: '/a' }, enabled: true },
    { id: 'w-second', lane: 'prod', provider: 'claude', account: { configDir: '/b' }, enabled: true },
  ]

  const CODE_RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
    reverify: GREEN_REVERIFY,
  }

  const request = (batchId: string) => ({
    id: batchId,
    source: 'roster',
    title: 'разгреби мелочь перед демо',
    lane: 'prod',
    batchId,
    data: { batch: 'parent' },
  })
  const piece = (batchId: string, n: number, over: any = {}) => ({
    id: `${batchId}-${n}`,
    source: 'roster',
    title: `кусок ${n}`,
    lane: 'prod',
    batchId,
    ...over,
  })

  /** A queue holding one request and two pieces of it, oldest first. */
  async function batchQueue(batchId: string, c: any) {
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(request(batchId))
    await adapter.enqueue(piece(batchId, 1))
    c.advance(10)
    await adapter.enqueue(piece(batchId, 2))
    return adapter
  }

  it('the piece that follows goes to the worker that ran the piece before it', async () => {
    const c = mkClock()
    const adapter = await batchQueue('B-A', c)
    // The first piece was run by the SECOND worker of the pool and produced. The pin is the
    // only thing that can send the next piece there — pool order alone would pick w-first.
    await adapter.claimNext('daemon', {})
    await adapter.assignWorker('B-A-1', 'w-second')
    await adapter.complete('B-A-1', { receiptRef: 'reverify:one' })

    const { deps } = makeDeps({ adapter, clockObj: c, config: { workers: TWO_WORKERS }, responses: CODE_RESPONSES })
    const res = await tick(deps)

    expect(res.completed).toBe('B-A-2')
    const rows = await adapter.list({})
    expect(rows.find((r: any) => r.id === 'B-A-2').workerId).toBe('w-second')
  })

  it('...and ordinary work still goes to the head of the pool — so the case above is a pin, not a fixture', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-alone' }))
    const { deps } = makeDeps({ adapter, clockObj: c, config: { workers: TWO_WORKERS }, responses: CODE_RESPONSES })

    await tick(deps)

    const [row] = await adapter.list({})
    expect(row.workerId).toBe('w-first')
  })

  it('two pieces of one assembly are never live at once: tick after tick, one at a time', async () => {
    const c = mkClock()
    const adapter = await batchQueue('B-B', c)
    const { deps } = makeDeps({ adapter, clockObj: c, config: { workers: TWO_WORKERS }, responses: CODE_RESPONSES })

    const first = await tick(deps)
    expect(first.completed).toBe('B-B-1')
    // while the first piece was under way nothing else of the batch was claimed — the row is
    // still waiting, and it is the NEXT tick that takes it
    const second = await tick(deps)
    expect(second.completed).toBe('B-B-2')
    const third = await tick(deps)
    expect(third.idle).toBe(true) // the assembly is out of pieces; nothing invents another
  })
})

/**
 * ═══════════ СРОЧНОЕ ВКЛИНИВАЕТСЯ МЕЖДУ КУСКАМИ, А НЕ ПОСРЕДИ КУСКА ═════════════════
 *
 * The owner's rule, in his words: an urgent inline task waits for the CURRENT piece to close,
 * runs, and the worker goes back to the assembly. Two halves, and the second one is the one
 * that is easy to lose: sessions are not torn open. A live attempt is never killed to make
 * room for something louder — the only thing that ends a running session in this product is
 * the founder's own «Перебить сейчас», and an arriving task is not that.
 *
 * The wedging itself is not new machinery: the queue already hands out the loudest waiting
 * task, and a piece of a batch is ordinary work in every respect but its kinship. What these
 * cases pin is that the two rules COMPOSE the way he asked for — which is precisely the kind
 * of claim that is believed until someone runs it.
 */
describe('an urgent inline task wedges BETWEEN the pieces of a batch', () => {
  const CODE_RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
    reverify: GREEN_REVERIFY,
  }

  const request = (batchId: string) => ({
    id: batchId,
    source: 'roster',
    title: 'разгреби мелочь перед демо',
    lane: 'prod',
    batchId,
    data: { batch: 'parent' },
  })
  const piece = (batchId: string, n: number) => ({
    id: `${batchId}-${n}`,
    source: 'roster',
    title: `кусок ${n}`,
    lane: 'prod',
    batchId,
  })

  /**
   * A worker that does its work and, WHILE IT IS STILL RUNNING, lets something arrive in the
   * queue behind it — the exit only happens once that has landed. That ordering is the whole
   * point: «пришло во время куска», not «лежало заранее».
   */
  function spawnWithArrival(order: string[], arrive?: () => Promise<any>) {
    const killed: string[] = []
    let arrived = false // the founder types it ONCE, while the first piece is under way
    const spawn = (spec: any) => {
      order.push('spawn')
      spec.onLine?.('stream line')
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      const finish = () => spec.onExit?.({ code: 0, signal: null })
      if (arrive && !arrived) {
        arrived = true
        void arrive().then(finish)
      } else finish()
      return { pid: 7, kill: () => killed.push('kill') }
    }
    return { spawn, killed }
  }

  async function batchQueue(batchId: string, c: any) {
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(request(batchId))
    await adapter.enqueue(piece(batchId, 1))
    c.advance(10)
    await adapter.enqueue(piece(batchId, 2))
    return adapter
  }

  it('urgent → the order of hand-out is «кусок 1 → срочное → кусок 2», and the live piece is never killed', async () => {
    const c = mkClock()
    const adapter = await batchQueue('B-C', c)
    const order: string[] = []
    const { spawn, killed } = spawnWithArrival(order, async () => {
      c.advance(5)
      // the founder types something urgent while the first piece is under way
      return adapter.enqueue(backlogTask({ id: 'BL-urgent', priority: 9 }))
    })
    const { deps } = makeDeps({ adapter, clockObj: c, responses: CODE_RESPONSES, spawnWorker: spawn })

    const one = await tick(deps)
    expect(one.completed).toBe('B-C-1') // the piece was NOT abandoned for the louder task
    expect(killed).toEqual([]) // and nothing interrupted it — no session was torn open

    const two = await tick(deps)
    expect(two.completed).toBe('BL-urgent') // the urgent task went first, between the pieces

    const three = await tick(deps)
    expect(three.completed).toBe('B-C-2') // and the worker came back to the assembly
  })

  it('an inline task that is NOT urgent does not push the pieces aside', async () => {
    const c = mkClock()
    const adapter = await batchQueue('B-D', c)
    const order: string[] = []
    const { spawn } = spawnWithArrival(order, async () => {
      c.advance(5)
      return adapter.enqueue(backlogTask({ id: 'BL-ordinary' })) // priority 0, arrived last
    })
    const { deps } = makeDeps({ adapter, clockObj: c, responses: CODE_RESPONSES, spawnWorker: spawn })

    expect((await tick(deps)).completed).toBe('B-D-1')
    expect((await tick(deps)).completed).toBe('B-D-2') // the assembly keeps its place in line
    expect((await tick(deps)).completed).toBe('BL-ordinary')
  })

  it('after the wedge the assembly is carried to its end — every piece produced, nothing left to hand out', async () => {
    const c = mkClock()
    const adapter = await batchQueue('B-E', c)
    const order: string[] = []
    const { spawn } = spawnWithArrival(order, async () => {
      c.advance(5)
      return adapter.enqueue(backlogTask({ id: 'BL-urgent-2', priority: 9 }))
    })
    const { deps } = makeDeps({ adapter, clockObj: c, responses: CODE_RESPONSES, spawnWorker: spawn })

    await tick(deps)
    await tick(deps)
    await tick(deps)
    expect((await tick(deps)).idle).toBe(true)

    const rows = await adapter.list({})
    const pieces = rows.filter((r: any) => r.batchId === 'B-E' && r.id !== 'B-E')
    expect(pieces).toHaveLength(2)
    // both produced and now owe a person a word — the assembly is what he accepts, not each
    // piece separately (which is also why a piece waiting for him never stalls the next one)
    expect(pieces.every((r: any) => r.status === 'awaiting_approval')).toBe(true)
  })
})

/**
 * ═══════════ СЛОМАЛОСЬ — СТОП. НИЧЕГО НЕ ПРОИСХОДИТ САМО ═══════════════════════════
 *
 * This is the loop of 12.08.2026 written down as a test, at the level it actually happened:
 * the TICK. A piece broke, and the machine ran it again — and again — because nothing anywhere
 * said «stop and ask». Three live sessions on one task, a subscription burnt overnight, and a
 * board showing an empty queue and an idle worker.
 *
 * So: after a piece of a batch fails, tick after tick after tick must do NOTHING with that
 * assembly — not repeat the broken piece, not move on to the next one — until its owner says
 * a word. And when he does, the very next tick carries on exactly as he asked.
 */
describe('a broken piece stops its batch until the owner says a word — the tick repeats NOTHING', () => {
  const RED_RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
    reverify: { code: 0, stdout: JSON.stringify({ verdict: 'red', receiptRef: 'reverify:red' }) },
  }
  const GREEN_RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
    reverify: GREEN_REVERIFY,
  }

  async function brokenBatch(c: any) {
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({
      id: 'B-F',
      source: 'roster',
      title: 'разгреби мелочь перед демо',
      lane: 'prod',
      batchId: 'B-F',
      data: { batch: 'parent' },
    })
    await adapter.enqueue({ id: 'B-F-1', source: 'roster', title: 'кусок 1', lane: 'prod', batchId: 'B-F' })
    c.advance(10)
    await adapter.enqueue({ id: 'B-F-2', source: 'roster', title: 'кусок 2', lane: 'prod', batchId: 'B-F' })

    // the first piece runs and its tests come back red
    const { deps } = makeDeps({ adapter, clockObj: c, responses: RED_RESPONSES })
    const res = await tick(deps)
    expect(res.failed).toEqual({ taskId: 'B-F-1', reason: 'tests_red' })
    return adapter
  }

  it('tick after tick, the stopped assembly does nothing at all — no repeat, no next piece', async () => {
    const c = mkClock()
    const adapter = await brokenBatch(c)

    const { deps, order } = makeDeps({ adapter, clockObj: c, responses: GREEN_RESPONSES })
    for (let i = 0; i < 5; i += 1) {
      c.advance(60000) // an hour of five-second ticks, compressed
      expect((await tick(deps)).idle).toBe(true)
    }
    expect(order).toEqual([]) // not one verb, not one session — nothing was spawned at all

    const rows = await adapter.list({})
    expect(rows.find((r: any) => r.id === 'B-F-1').status).toBe('failed')
    expect(rows.find((r: any) => r.id === 'B-F-1').attempt).toBe(1) // it was never run again
    expect(rows.find((r: any) => r.id === 'B-F-2').status).toBe('queued') // and never moved on
  })

  it('«пропустить» → the very next tick carries the assembly on with the piece after it', async () => {
    const c = mkClock()
    const adapter = await brokenBatch(c)
    await adapter.resolveBatch('B-F', { skip: 'B-F-1' })

    const { deps } = makeDeps({ adapter, clockObj: c, responses: GREEN_RESPONSES })
    expect((await tick(deps)).completed).toBe('B-F-2')
  })

  it('«повторить» → the very next tick runs THAT piece again, and only because he asked', async () => {
    const c = mkClock()
    const adapter = await brokenBatch(c)
    c.advance(10)
    await adapter.enqueue({
      id: 'B-F-1',
      source: 'return',
      title: 'кусок 1',
      lane: 'prod',
      batchId: 'B-F',
      attempt: 2,
    })

    const { deps } = makeDeps({ adapter, clockObj: c, responses: GREEN_RESPONSES })
    const res = await tick(deps)
    expect(res.completed).toBe('B-F-1')
  })

  it('«отменить» → the next tick has nothing of that assembly to run, now or ever', async () => {
    const c = mkClock()
    const adapter = await brokenBatch(c)
    await adapter.resolveBatch('B-F', { cancel: true })

    const { deps } = makeDeps({ adapter, clockObj: c, responses: GREEN_RESPONSES })
    expect((await tick(deps)).idle).toBe(true)
    const rows = await adapter.list({})
    expect(rows.find((r: any) => r.id === 'B-F-2').status).not.toBe('queued')
  })
})

/**
 * ═══════════ «ОСТАНОВИ ВОЛНУ 2» — АДРЕСНО, МЯГКО И С ПРОДОЛЖЕНИЕМ ═════════════════════
 *
 * The founder's order, in his own words: the tasks of that wave finish the step they are on and
 * stand, their unfinished steps stay in their sessions, and when the stop is lifted they carry
 * on from the same place. Three claims, and each is easy to lose in a different way:
 *
 *   ADDRESSED — a stop that widened to «everything of that phase» or «everything in that lane»
 *     would be the machine going quiet for a reason its owner cannot see. So every case below
 *     keeps a neighbour running: another wave of the SAME phase, another phase, and work that
 *     never said which echelon it belongs to.
 *   SOFT — nothing is killed. A live task is ASKED, through the steering channel the founder
 *     already has, to finish its step and stand. The case reads the ask back with the very
 *     reader the continuation loop uses, and pins that it is made ONCE however many ticks the
 *     stop stands for — a channel that repeats itself is a channel a worker learns to ignore.
 *   RESUMABLE — lifting the order hands the SAME row out again, on its same first attempt: a
 *     stop is not a failure and must not cost an attempt.
 */
describe('останов волны: адресный, мягкий, переживающий рестарт', () => {
  const tmpDirs: string[] = []
  const mkDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-wave-'))
    tmpDirs.push(d)
    return d
  }
  afterAll(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  const CODE_RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
    reverify: GREEN_REVERIFY,
  }

  const planTask = (id: string, phase: string, wave: number) => ({
    id,
    source: 'roster',
    title: `план ${id}`,
    lane: 'prod',
    data: { phase, wave },
  })

  it('останов адресован волне: её задача не выдаётся, соседняя волна и чужая фаза идут', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(planTask('P-14-2', '14', 2))
    c.advance(10)
    await adapter.enqueue(planTask('P-14-1', '14', 1))
    c.advance(10)
    await adapter.enqueue(planTask('P-15-2', '15', 2))
    c.advance(10)
    await adapter.enqueue(backlogTask({ id: 'BL-nowave' })) // об эшелонах не говорит ничего

    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold', clock: c.clock })

    const { deps } = makeDeps({ adapter, clockObj: c, config: { dataDir }, responses: CODE_RESPONSES })
    const ran: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await tick(deps)
      if (res.claimed) ran.push(res.claimed)
    }

    expect(ran).not.toContain('P-14-2')
    expect(ran).toEqual(expect.arrayContaining(['P-14-1', 'P-15-2', 'BL-nowave']))
    // остановленная не потеряна: она ждёт ровно там, где стояла, и на своей первой попытке
    const rows = await adapter.list({})
    expect(rows.find((r: any) => r.id === 'P-14-2').status).toBe('queued')
    expect(rows.find((r: any) => r.id === 'P-14-2').attempt).toBe(1)
  })

  it('живой задаче остановленной волны уходит поправка «после хода» — и процесс не убит', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(planTask('P-30-2', '30', 2))
    await adapter.claimNext('daemon', {}) // задача уже у работника — её нельзя «не выдать»
    await adapter.assignWorker('P-30-2', 'max-2')

    writeWaveHold({ dataDir, phase: '30', wave: 2, action: 'hold', clock: c.clock })

    const killed: string[] = []
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { dataDir },
      responses: CODE_RESPONSES,
      deps: { attemptTurns: { stop: (id: string) => (killed.push(id), true) } },
    })
    const res = await tick(deps)

    expect(res.parked).toEqual(['P-30-2'])
    // ПРОВОД: поправка находится тем же чтением, которым цикл ищет её перед продолжением сессии
    const pending = readPendingRedirects({ dataDir, taskId: 'P-30-2' })
    expect(pending).toHaveLength(1)
    expect(pending[0].mode).toBe('queue') // «после хода», а не «перебить сейчас»
    expect(pending[0].text).toContain('волну 2')
    expect(pending[0].text).toContain('сессию не закрывайте')
    // ручку убийства не дёргали ни разу: останов не рвёт живую сессию
    expect(killed).toEqual([])
  })

  it('одна остановка — одна поправка: тик за тиком работнику не повторяют одно и то же', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(planTask('P-31-2', '31', 2))
    await adapter.claimNext('daemon', {})
    await adapter.assignWorker('P-31-2', 'max-2')
    writeWaveHold({ dataDir, phase: '31', wave: 2, action: 'hold', clock: c.clock })

    const { deps } = makeDeps({ adapter, clockObj: c, config: { dataDir }, responses: CODE_RESPONSES })
    for (let i = 0; i < 12; i += 1) {
      c.advance(5000) // час пятисекундных тиков в миниатюре
      await tick(deps)
    }

    expect(readPendingRedirects({ dataDir, taskId: 'P-31-2' })).toHaveLength(1)
  })

  it('снятие останова возвращает выдачу — та же строка, та же первая попытка', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(planTask('P-32-2', '32', 2))
    writeWaveHold({ dataDir, phase: '32', wave: 2, action: 'hold', clock: c.clock })

    const { deps } = makeDeps({ adapter, clockObj: c, config: { dataDir }, responses: CODE_RESPONSES })
    expect((await tick(deps)).idle).toBe(true)

    writeWaveHold({ dataDir, phase: '32', wave: 2, action: 'release', clock: c.clock })
    const res = await tick(deps)
    expect(res.completed).toBe('P-32-2')
    const [row] = await adapter.list({})
    expect(row.attempt).toBe(1) // останов — не провал, попытки он не стоит
  })

  it('останов переживает рестарт: цикл читает реестр с диска, а не свою память', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(planTask('P-33-2', '33', 2))
    writeWaveHold({ dataDir, phase: '33', wave: 2, action: 'hold', clock: c.clock })

    // СОВЕРШЕННО НОВЫЙ набор зависимостей — ровно то, что даёт перезапущенный демон: между ним
    // и приказом нет ничего, кроме каталога на диске
    const { deps } = makeDeps({ adapter, clockObj: c, config: { dataDir }, responses: CODE_RESPONSES })
    const res = await tick(deps)
    expect(res.idle).toBe(true)
    expect(res.waveHolds).toEqual(['33/2'])
  })

  it('пустой реестр ничего не меняет: без приказа это обычная работа', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(planTask('P-34-2', '34', 2))

    const { deps } = makeDeps({ adapter, clockObj: c, config: { dataDir }, responses: CODE_RESPONSES })
    const res = await tick(deps)
    expect(res.completed).toBe('P-34-2')
    expect(res.waveHolds).toBeUndefined()
  })
})

/**
 * ═══════ КРАСНЫМ СЧИТАЕТСЯ ТОЛЬКО НОВОЕ: выходной гейт стал РАЗНОСТНЫМ ════════
 *
 * Гейт читал АБСОЛЮТНЫЙ ответ перепроверки: «в дереве есть расхождения» → работа красная.
 * В живом дереве со сколькими-то годами истории расхождения есть ВСЕГДА — рецепты старых
 * работ давно разошлись с деревом, и это ничья не вина сегодня. Поэтому любая работа С
 * КОММИТАМИ получала tests_red, а работа без коммитов (ответ словами) проходила: система
 * хоронила код и пропускала разговор. Замер 13.08.2026: три попытки подряд, каждая красная,
 * при образцовой работе исполнителя.
 *
 * Лечение — не ослабление, а вопрос по существу: гейт снимает состояние дерева ДО попытки и
 * ПОСЛЕ и вменяет работе только РАЗНИЦУ. Ниже кейс на каждую половину этого предложения:
 * одинаковые снимки пропускают работу, новое расхождение по-прежнему красное, снимков
 * ровно два за попытку, и без снимка ДО гейт возвращается к старому правилу ВСЛУХ.
 */
// Форма записи списана с ответа самого верба (его проверяющая функция возвращает ровно эти
// поля), а не выдумана: подделка, которая богаче библиотеки, доказывает несуществующее.
const rec = (id: string, verdict: string, summary = '.planning/phases/01-old/01-01-SUMMARY.md') => ({
  id,
  coverage_id: null,
  assertion: 'целевые тесты зелёные',
  check_command: 'pnpm vitest run daemon/__tests__/loop.test.ts',
  expected_sha256: 'a'.repeat(64),
  observed_sha256: verdict === 'divergent' ? 'b'.repeat(64) : 'a'.repeat(64),
  exitCode: 0,
  scoredAt: '2026-08-14T00:00:00.000Z',
  summary,
  domain: 'sma.receipts',
  verdict,
})

/** Ответ верба в его собственной форме: {records, appended} на stdout + код выхода. */
const answer = (records: any[]) => ({
  code: records.some((r) => r.verdict === 'divergent' || r.verdict === 'error') ? 1 : 0,
  stdout: JSON.stringify({ records, appended: records.length }),
})

/** Верб отвечает по очереди: первый вызов — снимок ДО, второй — снимок ПОСЛЕ. */
const inTurn = (answers: any[]) => {
  let i = 0
  return () => answers[Math.min(i++, answers.length - 1)]
}

const DIFF_RESPONSES = (reverify: any) => ({
  preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
  worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
  reverify,
})

/** Git, отвечающий на все четыре вопроса попытки; любой из них можно заставить упасть. */
const makeGateGit =
  ({ commits = '1', diff = 'M\tdaemon/src/loop.mjs', throwOn = '' } = {}) =>
  (args: string[]) => {
    const verb = args[0]
    if (verb === throwOn) throw new Error(`git ${verb} unavailable`)
    if (verb === 'rev-parse') return 'base0000'
    if (verb === 'rev-list') return commits
    if (verb === 'diff') return diff
    return ''
  }

describe('выходной гейт различает «работник сломал» и «было сломано до него»', () => {
  const RESPONSES = DIFF_RESPONSES
  const makeGit = makeGateGit

  it('снимки одинаковы → работа ПРИНЯТА, хотя верб и вышел не нулём', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const snapshot = answer([rec('R-A', 'divergent'), rec('R-B', 'divergent')])
    const { deps } = makeDeps({
      adapter,
      responses: RESPONSES(inTurn([snapshot, snapshot])),
      deps: { execGit: makeGit() },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const [call] = adapter.calls
    expect(call.op).toBe('complete')
    // Квитанция называет словами, что расхождения были и работе не вменены.
    expect(call.result.receiptRef).toMatchObject({ preexistingRed: 2, newRed: 0, branch: 'wt/BL-1' })
  })

  it('появилось НОВОЕ расхождение → tests_red: гейт не ослаблен', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({
      adapter,
      responses: RESPONSES(
        inTurn([answer([rec('R-A', 'divergent')]), answer([rec('R-A', 'divergent'), rec('R-C', 'divergent')])]),
      ),
      deps: { execGit: makeGit() },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'tests_red' })
  })

  it('ПРОВОД: перепроверка спрашивается ДВАЖДЫ за попытку — до работника и после него', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const snapshot = answer([rec('R-A', 'divergent')])
    const { deps, order } = makeDeps({
      adapter,
      responses: RESPONSES(inTurn([snapshot, snapshot])),
      deps: { execGit: makeGit() },
    })

    await tick(deps)

    // двери «уже построено» в списке нет: у задачи без номера фазы плана не существует
    expect(order).toEqual(['worktree', 'reverify', 'spawn', 'reverify'])
  })

  /**
   * ПРОВОД, А НЕ ФАКТ ВЫЗОВА. Двух вызовов мало: снимки могут описывать ЧУЖОЕ дерево, и
   * тогда разница пуста по построению, а гейт зелен всегда. Так и было: вербу отдавался
   * cwd внутри копии, а корень записей он выводит через общий .git — то есть из копии
   * уезжает в главный чекаут. Утверждается поэтому сам аргумент запуска: путь рабочей
   * копии обязан стоять в args ОБОИХ вызовов, рядом с флагом, который его читает.
   */
  it('ПРОВОД: оба снимка названы ПУТЁМ рабочей копии — аргумент, а не «оно наверное доехало»', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const snapshot = answer([rec('R-A', 'divergent')])
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const responses = RESPONSES(inTurn([snapshot, snapshot]))
    const { deps } = makeDeps({
      adapter,
      verbRunner: async (_bin: string, argsArray: string[], opts: any) => {
        const verb = argsArray[1]
        seen.push({ verb, args: argsArray, cwd: opts && opts.cwd })
        const r = (responses as any)[verb] ?? { code: 0, stdout: '{}' }
        return typeof r === 'function' ? r() : r
      },
      deps: { execGit: makeGit() },
    })

    await tick(deps)

    const calls = seen.filter((c) => c.verb === 'reverify')
    expect(calls).toHaveLength(2)
    for (const [i, call] of calls.entries()) {
      const at = call.args.indexOf('--tree')
      expect(at, `вызов ${i + 1}: дерево не названо — снимок описывает чужой чекаут`).toBeGreaterThan(-1)
      expect(call.args[at + 1]).toBe('/wt/BL-1') // ровно та копия, что уехала в cwd
      expect(call.cwd).toBe('/wt/BL-1')
    }
  })

  it('вердикт объясним из журнала: строка несёт числа «красных до» и «красных новых»', async () => {
    for (const [after, expectedNew] of [
      [answer([rec('R-A', 'divergent')]), 0],
      [answer([rec('R-A', 'divergent'), rec('R-C', 'divergent')]), 1],
    ] as [any, number][]) {
      const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
      const { deps, journalled } = makeDeps({
        adapter,
        responses: RESPONSES(inTurn([answer([rec('R-A', 'divergent')]), after])),
        deps: { execGit: makeGit() },
      })

      await tick(deps)

      const line = journalled.find((e: any) => e.type === 'task.gate_differential')
      expect(line, 'гейт решил молча — вердикт необъясним').toBeTruthy()
      // числа живут в detail: форматтер оператора печатает только его
      expect(line.detail).toContain('до=1')
      expect(line.detail).toContain(`новых=${expectedNew}`)
    }
  })

  it('снимка ДО нет (верб не назвал записей) → старое абсолютное правило, и об этом сказано вслух', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      // первый ответ — без списка записей: сравнивать не с чем
      responses: RESPONSES(inTurn([{ code: 0, stdout: '{}' }, answer([rec('R-A', 'divergent')])])),
      deps: { execGit: makeGit() },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'tests_red' })
    const line = journalled.find((e: any) => e.type === 'task.gate_differential')
    expect(line, 'ослабление/возврат к старому правилу произошли молча').toBeTruthy()
    expect(line.detail).toContain('снимка ДО нет')
  })
})

/**
 * ═════ «ОТКАТИТЬ МОЖНО» И «ВИДНО, ЧТО ОТКАТЫВАЕТСЯ» — РАЗНЫЕ ВЕЩИ ══════════════
 *
 * Изоляция работника была настоящей с самого начала: он пишет только в свою рабочую копию на
 * своей ветке. Базовый коммит — точку, к которой можно вернуться, — журнал уже называл. Чего
 * в нём не было: СПИСКА того, что вернётся. Он выводился руками и исчезал вместе с веткой.
 *
 * Ниже три кейса на одну строку журнала: она есть у принятой попытки, есть у ПРОВАЛЕННОЙ
 * (именно её и хотят откатить) и честно называет причину, когда git ответить не смог.
 */
describe('журнал попытки отвечает и «к чему откатывать», и «что откатывается»', () => {
  const filesLine = (journalled: any[]) => journalled.find((e: any) => e.type === 'task.attempt_files')

  it('попытка ПРИНЯТА → в журнале база и список изменённых файлов', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const snapshot = answer([rec('R-A', 'divergent')])
    const { deps, journalled } = makeDeps({
      adapter,
      responses: DIFF_RESPONSES(inTurn([snapshot, snapshot])),
      deps: { execGit: makeGateGit({ diff: 'M\tdaemon/src/loop.mjs\nA\tdaemon/__tests__/loop.test.ts' }) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const line = filesLine(journalled)
    expect(line, 'попытка закрылась, а что она тронула — неизвестно').toBeTruthy()
    expect(line.base).toBe('base0000')
    expect(line.branch).toBe('wt/BL-1')
    expect(line.files).toEqual(['M\tdaemon/src/loop.mjs', 'A\tdaemon/__tests__/loop.test.ts'])
    // числа и имена живут в detail: форматтер оператора печатает только его
    expect(line.detail).toContain('base0000')
    expect(line.detail).toContain('daemon/src/loop.mjs')
  })

  it('попытка ПРОВАЛЕНА гейтом → список файлов ВСЁ РАВНО записан', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      responses: DIFF_RESPONSES(
        inTurn([answer([rec('R-A', 'divergent')]), answer([rec('R-A', 'divergent'), rec('R-C', 'divergent')])]),
      ),
      deps: { execGit: makeGateGit({ diff: 'M\tdaemon/src/loop.mjs' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'tests_red' })
    const line = filesLine(journalled)
    expect(line, 'провалившаяся попытка — именно та, которую хотят откатить').toBeTruthy()
    expect(line.base).toBe('base0000')
    expect(line.files).toEqual(['M\tdaemon/src/loop.mjs'])
  })

  it('git не ответил → запись честно называет причину и ничего не роняет', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const snapshot = answer([rec('R-A', 'divergent')])
    const { deps, journalled } = makeDeps({
      adapter,
      responses: DIFF_RESPONSES(inTurn([snapshot, snapshot])),
      deps: { execGit: makeGateGit({ throwOn: 'diff' }) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1') // судьбу попытки решает её гейт, а не строка журнала
    const line = filesLine(journalled)
    expect(line).toBeTruthy()
    expect(line.files).toEqual([])
    expect(line.detail).toContain('git не ответил')
  })

  it('ветка пуста → запись говорит «изменённых файлов нет», а не молчит', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const snapshot = answer([rec('R-A', 'divergent')])
    const { deps, journalled } = makeDeps({
      adapter,
      // коммит на ветке есть (иначе попытку закроет дверь «ответа словами»), а diff пуст —
      // ровно тот случай, когда молчание журнала читалось бы как «данных нет вообще»
      responses: DIFF_RESPONSES(inTurn([snapshot, snapshot])),
      deps: { execGit: makeGateGit({ diff: '' }) },
    })

    await tick(deps)

    const line = filesLine(journalled)
    expect(line).toBeTruthy()
    expect(line.files).toEqual([])
    expect(line.detail).toContain('изменённых файлов нет')
  })
})

/**
 * ═════════════ УРОК — ТРЕТЬЕ УСЛОВИЕ СДАЧИ, И ОНО ПРОВЕРЯЕТСЯ ПО ДИСКУ ═══════════
 *
 * Продукт обещал маховик памяти в обе стороны, а корпус за десятки попыток не получил от
 * работников ни одной заметки: шага не было ни в промпте, ни в гейте. Ниже — гейт, и он
 * проверяет НЕ слово работника, а файл: черновик обязан лежать в корпусе копии и нести
 * штамп конвейера. Плоский файл, положенный мимо конвейера, уроком не считается — иначе
 * обещание «ни один факт не входит в память случайно» держалось бы на честном слове.
 *
 * `parseNote` берётся НАСТОЯЩИЙ, файлы — настоящие, во временном каталоге: подделка,
 * умеющая больше библиотеки, уже однажды показывала зелёный сьют поверх сломанного провода.
 */
describe('гейт урока: попытка оставляет заметку конвейера, причину — или не закрывается', () => {
  const tmpDirs: string[] = []
  const mkWork = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-lesson-'))
    tmpDirs.push(d)
    mkdirSync(join(d, '.claude', 'memory', 'drafts'), { recursive: true })
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

  /** Черновик ровно той формы, какую кладёт конвейер: схема 2, статус draft, штамп конвейера. */
  const writeDraft = (workDir: string, name: string, drop: string[] = []) => {
    const fm: Record<string, string> = {
      id: name.replace(/\.md$/, ''),
      schema_version: '2',
      status: 'draft',
      draft_kind: 'pipeline-write',
      memory_type: 'procedural',
      truth_mode: 'observed',
      claim: 'гейт читает файл, а не слово',
      language: 'ru',
    }
    for (const k of drop) delete fm[k]
    const text = `---\n${Object.entries(fm)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')}\n---\n\nтело урока\n`
    writeFileSync(join(workDir, '.claude', 'memory', 'drafts', name), text, 'utf8')
    return `.claude/memory/drafts/${name}`
  }

  /** Зелёная попытка: коммит на ветке, снимки совпали — судьбу решает только урок. */
  const runAttempt = async (lines: string[], workDir?: string) => {
    const snapshot = answer([rec('R-A', 'divergent')])
    const responses = {
      ...DIFF_RESPONSES(inTurn([snapshot, snapshot])),
      ...(workDir
        ? { worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: workDir, branch: 'wt/BL-1' }) } }
        : {}),
    }
    const { deps, journalled } = makeDeps({
      adapter: oneTaskAdapter(backlogTask({ attempt: 1 })),
      responses,
      // эти кейсы — РОВНО про урок, поэтому подделка не договаривает за работника
      spawnWorker: makeSpawnWorker(undefined, { lines, noLesson: true }),
      deps: { execGit: makeGateGit() },
    })
    const res = await tick(deps)
    return { res, journalled }
  }

  const NOTE = 'APPROACH_NOTE: прямой путь'

  it('зелёная попытка молчит об уроке → no_lesson, а не «принято»', async () => {
    const { res } = await runAttempt(['stream line', NOTE])
    expect(res.completed).toBeUndefined()
    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_lesson' })
  })

  it('«урока нет» с причиной → попытка ПОЛНА: честное «нет» не наказывается', async () => {
    const { res } = await runAttempt(['stream line', NOTE, 'LESSON_NONE: задача была чистым чтением'])
    expect(res.completed).toBe('BL-1')
  })

  it('настоящий черновик конвейера в копии → попытка принята', async () => {
    const workDir = mkWork()
    const path = writeDraft(workDir, 'lesson-r-77-gate.md')
    const { res } = await runAttempt(['stream line', NOTE, `LESSON_WRITTEN: ${path}`], workDir)
    expect(res.completed).toBe('BL-1')
  })

  it('маркер есть, а файла в копии нет → no_lesson: гейт верит диску, а не строке', async () => {
    const workDir = mkWork()
    const { res } = await runAttempt(
      ['stream line', NOTE, 'LESSON_WRITTEN: .claude/memory/drafts/lesson-r-77-ghost.md'],
      workDir,
    )
    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_lesson' })
  })

  it('файл без штампа конвейера → no_lesson: плоская заметка уроком не считается', async () => {
    const workDir = mkWork()
    const path = writeDraft(workDir, 'lesson-r-77-flat.md', ['draft_kind'])
    const { res } = await runAttempt(['stream line', NOTE, `LESSON_WRITTEN: ${path}`], workDir)
    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_lesson' })
  })

  it('путь мимо корпуса памяти → no_lesson, и файла никто не читает', async () => {
    const workDir = mkWork()
    writeFileSync(join(workDir, 'lesson.md'), '---\nschema_version: 2\ndraft_kind: pipeline-write\n---\n', 'utf8')
    for (const path of ['../lesson.md', 'lesson.md', '.claude/memory/../../lesson.md']) {
      const { res } = await runAttempt(['stream line', NOTE, `LESSON_WRITTEN: ${path}`], workDir)
      expect(res.failed, `путь «${path}» принят гейтом`).toEqual({ taskId: 'BL-1', reason: 'no_lesson' })
    }
  })

  // Вердикт обязан быть ВИДЕН: карточку и разбор читают по стенограмме попытки, и «почему
  // красная» не должно требовать чтения кода гейта.
  it('вердикт урока уезжает в стенограмму попытки', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-lesson-log-'))
    tmpDirs.push(dir)
    const snapshot = answer([rec('R-A', 'divergent')])
    const { deps } = makeDeps({
      adapter: oneTaskAdapter(backlogTask({ attempt: 1 })),
      responses: DIFF_RESPONSES(inTurn([snapshot, snapshot])),
      spawnWorker: makeSpawnWorker(undefined, {
        lines: ['stream line', NOTE, 'LESSON_NONE: задача была чистым чтением'],
      }),
      deps: {
        execGit: makeGateGit(),
        ledger: {
          recordAttempt: (a: any) => a,
          readAttempts: () => [],
          attemptLog: () => ({
            append: (e: any) => {
              writeFileSync(join(dir, 'log.txt'), `${e.line}\n`, { flag: 'a' })
              return true
            },
          }),
        },
      },
    })

    await tick(deps)

    const log = readFileSync(join(dir, 'log.txt'), 'utf8')
    expect(log).toContain('[sma] lesson:')
    expect(log).toContain('задача была чистым чтением')
  })
})

/**
 * ══════ ЧТО ЗА КОПИЮ ПОЛУЧИЛ РАБОТНИК — В СТРОКЕ ПОПЫТКИ, А НЕ В ЛОГЕ ═══════════
 *
 * База копии до сих пор жила ТОЛЬКО в операторском логе: откатить попытку было можно, а
 * увидеть, к чему откатывать, — нет, потому что лог не переживает ни ротацию, ни месяц.
 * Здесь проверяется ПРОВОД, а не вычисление: ответ верба провизии обязан доехать до
 * `recordAttempt` — и у завершённой попытки, и у ПРОВАЛЕННОЙ (откатывают обычно вторую).
 *
 * Подделка верба отвечает РОВНО тем, чем отвечает настоящий: её ответ лежит одним файлом
 * (`fixtures/worktree-provision-answer.json`), а его ключи — подмножество ключей живого
 * прогона `worktree provision --json` на временном репозитории. Подделка, умеющая больше
 * библиотеки, уже однажды показывала зелёный сьют поверх вызова несуществующего метода.
 */
const PROVISION_ANSWER = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'worktree-provision-answer.json'), 'utf8'),
)

const copyTask = (over: any = {}) => backlogTask({ id: 'R-77', attempt: 1, ...over })

const copyResponses = (answer: any = PROVISION_ANSWER) => ({
  preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
  worktree: { code: 0, stdout: JSON.stringify(answer) },
  reverify: GREEN_REVERIFY,
})

describe('строка попытки несёт копию: базу, ветку, путь, материализованное и время провизии', () => {
  it('завершённая попытка: пять полей в строке — ровно то, что ответил верб', async () => {
    const adapter = oneTaskAdapter(copyTask())
    const { deps, attempts } = makeDeps({ adapter, responses: copyResponses() })

    const res = await tick(deps)

    expect(res.completed).toBe('R-77')
    const row = attempts.find((a) => a.outcome === 'completed')
    expect(row).toBeTruthy()
    expect(row.base).toBe('a'.repeat(40))
    expect(row.branch).toBe('wt/R-77')
    expect(row.worktreePath).toBe('/wt/R-77')
    // ровно тот список, что ответил верб — не пересобранный тиком и не урезанный
    expect(row.materialized).toEqual(PROVISION_ANSWER.materialized)
    expect(Number.isFinite(row.provisionMs)).toBe(true)
    expect(row.provisionMs).toBeGreaterThanOrEqual(0)
  })

  it('ПРОВАЛЕННАЯ попытка несёт те же пять полей — её и откатывают', async () => {
    const adapter = oneTaskAdapter(copyTask())
    const { deps, attempts } = makeDeps({
      adapter,
      responses: copyResponses(),
      // работник отработал и НЕ оставил записки — попытка закрывается провалом
      spawnWorker: makeSpawnWorker(undefined, { lines: ['stream line'] }),
    })

    const res = await tick(deps)

    expect(res.failed && res.failed.taskId).toBe('R-77')
    const row = attempts.find((a) => a.outcome === 'failed')
    expect(row).toBeTruthy()
    expect(row.base).toBe('a'.repeat(40))
    expect(row.branch).toBe('wt/R-77')
    expect(row.worktreePath).toBe('/wt/R-77')
    expect(row.materialized).toEqual(PROVISION_ANSWER.materialized)
    expect(Number.isFinite(row.provisionMs)).toBe(true)
  })

  it('верб старой версии не сообщил список — строка без ключа, тик жив, в логе сказано вслух', async () => {
    const adapter = oneTaskAdapter(copyTask({ id: 'R-78' }))
    const { deps, attempts, journalled } = makeDeps({
      adapter,
      // ответ установки, которая ещё не знает про материализацию: прежние ключи и только они
      responses: copyResponses({ ok: true, path: '/wt/R-78', branch: 'wt/R-78', expectedBase: 'b'.repeat(40) }),
    })

    const res = await tick(deps)

    expect(res.completed).toBe('R-78')
    const row = attempts.find((a) => a.outcome === 'completed')
    expect(row.base).toBe('b'.repeat(40))
    expect(row.worktreePath).toBe('/wt/R-78')
    // отсутствие — это undefined: ни null, ни пустой массив, иначе читатель через месяц
    // прочтёт «копия была пуста» там, где верб просто промолчал
    expect(row.materialized).toBeUndefined()
    // ВРЕМЯ ПРОВИЗИИ МЕРЯЕТ ТИК, А НЕ ВЕРБ: старый верб числа не назвал, а строка его несёт
    expect(Number.isFinite(row.provisionMs)).toBe(true)
    expect(journalled.some((e: any) => e.type === 'task.worktree_materialized_missing')).toBe(true)
  })

  it('документарная стадия шла без копии — ни пути, ни списка в строке', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const { deps, attempts } = stageDeps({
      adapter,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }),
        execGit: makeGit({ '.planning/phases/12-front/12-01-PLAN.md': 'abc1234' }),
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    const row = attempts.find((a) => a.outcome === 'completed')
    expect(row.worktreePath).toBeUndefined()
    expect(row.materialized).toBeUndefined()
    expect(row.base).toBeUndefined()
  })
})

/**
 * ══════ ОБХОД КОПИЙ ЖИВЁТ В ТИКЕ, РЯДОМ С ОБХОДОМ ЖИВОСТИ ═══════════════════════
 *
 * Копии закрытых задач не убирал никто: у приёмки уборки не было, а у демона — обхода.
 * Обход стоит там же, где обход живости очереди, и по тому же образцу: он не имеет права
 * уронить тик. Копия — это каталог; неубранный каталог стоит места, а тик, упавший на его
 * уборке, стоит всей работы, которую он должен был раздать.
 */
describe('тик гоняет обход копий и переживает его падение', () => {
  it('обход вызван РАЗ за тик и получает время тика', async () => {
    const sweeps: any[] = []
    const adapter = oneTaskAdapter(backlogTask({ id: 'R-77', attempt: 1 }))
    const { deps, clock } = makeDeps({
      adapter,
      responses: copyResponses(),
      deps: { sweepWorktrees: async (a: any) => { sweeps.push(a); return { scanned: 1, removed: 1, skipped: 0, errors: 0 } } },
    })

    const res = await tick(deps)

    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].now).toBe(clock.clock())
    expect(res.worktreeSweep).toMatchObject({ removed: 1 })
  })

  it('обход упал — тик доводит задачу до конца, а причина названа в журнале', async () => {
    const adapter = oneTaskAdapter(copyTask())
    const { deps, journalled } = makeDeps({
      adapter,
      responses: copyResponses(),
      deps: { sweepWorktrees: async () => { throw new Error('список деревьев не читается') } },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('R-77')
    const line = journalled.find((e: any) => e.type === 'worktree-sweep-error')
    expect(line, 'падение обхода прошло молча').toBeTruthy()
    expect(String(line.error)).toContain('список деревьев не читается')
  })

  it('демон без обхода работает как прежде — поля в итоге тика нет вовсе', async () => {
    const adapter = oneTaskAdapter(copyTask({ id: 'R-81' }))
    const { deps } = makeDeps({ adapter, responses: copyResponses({ ...PROVISION_ANSWER, path: '/wt/R-81', branch: 'wt/R-81' }) })

    const res = await tick(deps)

    expect(res.completed).toBe('R-81')
    expect(Object.hasOwn(res, 'worktreeSweep')).toBe(false)
  })
})

/**
 * ═════ ЛИЧНЫЙ СЛОЙ, НАШИ СЕРВЕРЫ И INIT-КАДР — ДО СПАВНА, В ARGV, В СТРОКЕ ПОПЫТКИ ═════
 *
 * Три вещи были посчитаны и никуда не доехали, и каждая по отдельности была зелёной.
 * Зеркало личного слоя писало settings аккаунта — но его никто не звал, поэтому страж
 * паритета отказывал КАЖДОМУ живому спавну словом «connectors». Файл mcp-конфига умел
 * собираться — и не собирался ни разу, так что работник получал подключения, которых
 * никто не выбирал, и не получал наших. Init-кадр сессии — единственное свидетельство
 * того, что слой доехал (путь авто-памяти, число хуков основателя, отсутствие чужих
 * подключений) — резался капом строки и не попадал в строку попытки вовсе.
 *
 * Поэтому кейсы ниже проверяют ПРОВОД, а не вычисление:
 *   - зеркало вызвано ДО спавна (порядок утверждён явно) и с каталогом аккаунта работника;
 *   - настоящий сборщик аргументов проходит стража и кладёт `--mcp-config` в argv — это же
 *     и есть доказательство порядка с зубами: спавн до зеркала упал бы на паритете;
 *   - ошибка зеркала — именованный отказ попытки, а не спавн «как получится»;
 *   - `personalLayer` и `mcpConfig` доезжают до НАСТОЯЩЕГО леджера (allowlist пропускает);
 *   - init-кадр читается и хранится целиком.
 *
 * Подделок «богаче библиотеки» здесь нет: зеркало в кейсах — настоящая функция продукта
 * над временными каталогами, реестр отвечает ровно формой loadMcpRegistry.
 */
describe('личный слой и наши серверы доезжают до спавна и до строки попытки', () => {
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
        /* a temp dir that will not go is not a test failure */
      }
    }
  })

  const ledgerSeam = (ledgerDir: string, over: any = {}) => ({
    recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
    readAttempts: (id: string) => readAttempts(ledgerDir, id),
    attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    ...over,
  })

  /** Дом основателя: то, что зеркало обязано перенести (правила и хук), и то, что обязано отсечь. */
  const founderHome = () => {
    const dir = mkDir('sma-founder-')
    writeFileSync(join(dir, 'CLAUDE.md'), '# правила основателя\nотвечай по делу\n')
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node journal.mjs log' }] }] },
        permissions: { deny: ['Read(.env)', 'Read(.secrets)'], ask: [], allow: ['Bash(ls:*)'], defaultMode: 'auto' },
        env: { MCP_TIMEOUT: '30000' },
        model: 'opus',
      }),
    )
    return dir
  }

  const codeResponses = (path = '/wt/BL-1', branch = 'wt/BL-1') => ({
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path, branch }) },
    reverify: GREEN_REVERIFY,
  })

  const worker = (accountDir: string, over: any = {}) => ({
    id: 'max-2',
    lane: 'prod',
    provider: 'claude',
    enabled: true,
    account: {
      name: 'max-2',
      configDir: accountDir,
      oauthTokenEnv: 'SMA_MAX_2_TOKEN',
      spendLogsDir: join(accountDir, 'spend'),
    },
    ...over,
  })

  it('зеркало вызвано ДО спавна — с каталогом аккаунта работника, его плагинами и правками профиля', async () => {
    const order: string[] = []
    const calls: any[] = []
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: {
        workers: [
          worker(accountDir, { plugins: ['skill-creator@official'], settingsOverrides: { autoMemoryEnabled: true } }),
        ],
      },
      spawnWorker: makeSpawnWorker(order),
      responses: codeResponses(),
      deps: {
        mirrorPersonalLayer: (opts: any) => {
          order.push('mirror')
          calls.push(opts)
          return mirrorPersonalLayer({ ...opts, sourceDir })
        },
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    expect(order.indexOf('mirror')).toBeGreaterThan(-1)
    expect(order.indexOf('mirror'), 'зеркало обязано лечь ДО спавна — иначе работник стартует без слоя').toBeLessThan(
      order.indexOf('spawn'),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      accountDir,
      plugins: ['skill-creator@official'],
      overrides: { autoMemoryEnabled: true },
    })
    // и слой ДЕЙСТВИТЕЛЬНО лежит в каталоге аккаунта к моменту спавна
    expect(JSON.parse(readFileSync(join(accountDir, 'settings.json'), 'utf8')).disableClaudeAiConnectors).toBe(true)
  })

  it('та же полоса у «Создателя»: зеркало ложится до спавна и в форге', async () => {
    const order: string[] = []
    const calls: any[] = []
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({
      id: 'F-9',
      source: 'roster',
      title: 'выкуй агента',
      lane: 'forge',
      priority: 0,
      forge: { kind: 'agent', description: 'читает и суммирует' },
    } as any)
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir, { lane: 'forge' })] },
      spawnWorker: makeSpawnWorker(order),
      responses: { worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/F-9', branch: 'wt/F-9' }) } },
      deps: {
        execGit: () => '',
        mirrorPersonalLayer: (opts: any) => {
          order.push('mirror')
          calls.push(opts)
          return mirrorPersonalLayer({ ...opts, sourceDir })
        },
      },
    })

    await tick(deps)

    expect(calls).toHaveLength(1)
    expect(calls[0].accountDir).toBe(accountDir)
    expect(order.indexOf('mirror')).toBeGreaterThan(-1)
    expect(order.indexOf('mirror')).toBeLessThan(order.indexOf('spawn'))
  })

  it('НАСТОЯЩИЙ сборщик аргументов проходит стража и кладёт --mcp-config в argv (порядок с зубами)', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const dataDir = mkDir('sma-data-')
    const ledgerDir = mkDir('sma-ledger-')
    const spawns: any[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const config = { workers: [worker(accountDir)], repoDir: '/repo', pipeline: { enabled: true }, dataDir }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        spawns.push(spec.args.slice())
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        // НАСТОЯЩИЙ сборщик: он читает settings аккаунта с диска и отказывает без зеркала.
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
        loadMcpRegistry: () => ({ servers: [], path: join(dataDir, 'mcp.json') }),
      },
    })

    const res = await tick(deps)

    expect(res.completed, 'спавн до зеркала упал бы на страже паритета словом connectors').toBe('BL-1')
    expect(spawns).toHaveLength(1)
    const at = spawns[0].indexOf('--mcp-config')
    expect(at, 'путь mcp-конфига не доехал до argv').toBeGreaterThan(-1)
    const mcpPath = spawns[0][at + 1]
    expect(mcpPath).toBe(join(dataDir, 'mcp', 'BL-1-1', 'mcp-config.json'))
    expect(JSON.parse(readFileSync(mcpPath, 'utf8'))).toEqual({ mcpServers: {} })

    const row = readAttempts(ledgerDir, 'BL-1')[0]
    expect(row.mcpConfig).toEqual({ path: mcpPath, servers: [] })
  })

  it('включённый сервер реестра лежит в файле и назван в строке попытки', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const dataDir = mkDir('sma-data-')
    const ledgerDir = mkDir('sma-ledger-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir)], dataDir },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
        loadMcpRegistry: () => ({
          servers: [
            { id: 's1', title: 'наш сервер', command: 'node', args: ['x.mjs'], enabled: true },
            { id: 's2', title: 'выключенный', command: 'node', args: ['y.mjs'], enabled: false },
          ],
          path: '/r/mcp.json',
        }),
      },
    })

    await tick(deps)

    const row = readAttempts(ledgerDir, 'BL-1')[0]
    expect(row.mcpConfig.servers).toEqual(['s1'])
    const written = JSON.parse(readFileSync(row.mcpConfig.path, 'utf8'))
    expect(written).toEqual({ mcpServers: { s1: { type: 'stdio', command: 'node', args: ['x.mjs'] } } })
  })

  it('ошибка зеркала — именованный отказ попытки: спавна нет, причина названа, слоя в строке нет', async () => {
    const accountDir = mkDir('sma-account-')
    const ledgerDir = mkDir('sma-ledger-')
    const order: string[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir)] },
      spawnWorker: makeSpawnWorker(order),
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        mirrorPersonalLayer: () => {
          throw new PersonalLayerError('источник личного слоя не читается: /f/settings.json')
        },
      },
    })

    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'personal_layer_error' })
    expect(order).not.toContain('spawn')
    const row = readAttempts(ledgerDir, 'BL-1')[0]
    expect(row.outcome).toBe('failed')
    expect(row.failureReason).toBe('personal_layer_error')
    expect(Object.hasOwn(row, 'personalLayer'), 'отказ не может нести слой, которого не было').toBe(false)
    const line = journalled.find((e: any) => e.reason === 'personal_layer_error')
    expect(String(line.detail)).toContain('не читается')
  })

  it('строка попытки несёт РОВНО то, что вернуло зеркало — и у завершённой, и у отказанной попытки', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const ledgerDir = mkDir('sma-ledger-')
    const answers: any[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir)] },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        mirrorPersonalLayer: (opts: any) => {
          const answer = mirrorPersonalLayer({ ...opts, sourceDir })
          answers.push(answer)
          return answer
        },
      },
    })

    await tick(deps)
    const done = readAttempts(ledgerDir, 'BL-1')[0]
    expect(done.outcome).toBe('completed')
    expect(answers).toHaveLength(1)
    expect(done.personalLayer, 'строка попытки без слоя — это и есть «вычислено и не подключено»').toBeTruthy()
    expect(done.personalLayer).toMatchObject(answers[0])

    // …и та же строка у красной попытки: слой доехал, а работа — нет
    await adapter.enqueue(backlogTask({ id: 'BL-2' }))
    const failing = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir)] },
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-2', branch: 'wt/BL-2' }) },
        reverify: { code: 0, stdout: '{}' },
      },
      deps: {
        ledger: ledgerSeam(ledgerDir),
        execGit: () => '',
        mirrorPersonalLayer: (opts: any) => {
          const answer = mirrorPersonalLayer({ ...opts, sourceDir })
          answers.push(answer)
          return answer
        },
      },
    })
    await tick(failing.deps)
    const red = readAttempts(ledgerDir, 'BL-2')[0]
    expect(red.outcome).toBe('failed')
    expect(answers).toHaveLength(2)
    expect(red.personalLayer).toBeTruthy()
    expect(red.personalLayer).toMatchObject(answers[1])
  })

  it('демон без зеркала работает как прежде — ни слоя в строке, ни пути mcp в argv', async () => {
    const ledgerDir = mkDir('sma-ledger-')
    const spawns: any[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      responses: codeResponses(),
      spawnWorker: (spec: any) => {
        spawns.push(spec.args.slice())
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      deps: { ledger: ledgerSeam(ledgerDir) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const row = readAttempts(ledgerDir, 'BL-1')[0]
    expect(Object.hasOwn(row, 'personalLayer')).toBe(false)
    expect(Object.hasOwn(row, 'mcpConfig')).toBe(false)
    expect(spawns[0]).not.toContain('--mcp-config')
  })

  // ── INIT-КАДР: единственное свидетельство того, что слой доехал ──
  const AUTO_MEMORY = 'C:\\Users\\x\\.sma-accounts\\local-1\\projects\\C--projects-sma\\memory\\'
  const INIT_FRAME = JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cwd: '/wt/BL-1',
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    mcp_servers: [],
    memory_paths: { auto: AUTO_MEMORY },
    permissionMode: 'default',
    plugins: [],
    // настоящий init-кадр велик: встроенные навыки с описаниями — так он и переваливает
    // за кап строки, ради которого кадру дан отдельный размер
    skills: Array.from({ length: 200 }, (_, i) => `встроенный-навык-номер-${i}-с-описанием`),
  })
  const HOOK_FRAME = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' })
  const RESULT_FRAME = JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    total_cost_usd: 0.1,
  })

  it('init-кадр доезжает до строки попытки: путь авто-памяти, хуки, чужие подключения', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const ledgerDir = mkDir('sma-ledger-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir)] },
      responses: codeResponses(),
      spawnWorker: makeSpawnWorker(undefined, {
        lines: [INIT_FRAME, HOOK_FRAME, HOOK_FRAME, 'APPROACH_NOTE: прямой путь', RESULT_FRAME],
      }),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
      },
    })

    await tick(deps)

    const row = readAttempts(ledgerDir, 'BL-1')[0]
    expect(row.personalLayer.autoMemoryDir).toBe(AUTO_MEMORY)
    expect(row.personalLayer.initHooks, 'хуки основателя сработали — это и есть доказательство слоя').toBe(2)
    expect(row.personalLayer.initMcpServers).toEqual([])
    expect(row.personalLayer.initClaudeAiTools, 'ни одного чужого подключения в сессии').toBe(0)
    expect(row.personalLayer.initPlugins).toEqual([])
    expect(row.personalLayer.permissionMode).toBe('default')
    // и то, что вернуло зеркало, никуда не делось — init ДОПОЛНЯЕТ слой, а не заменяет
    expect(row.personalLayer.connectors).toBe('disabled')
    expect(row.personalLayer.claudeMd).not.toBe('absent')
  })

  it('чужие подключения в init-кадре сосчитаны честно', async () => {
    const accountDir = mkDir('sma-account-')
    const ledgerDir = mkDir('sma-ledger-')
    const sourceDir = founderHome()
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const dirty = JSON.stringify({
      type: 'system',
      subtype: 'init',
      tools: ['Read', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Drive'],
      mcp_servers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }],
      memory_paths: { auto: AUTO_MEMORY },
      permissionMode: 'default',
      plugins: ['skill-creator@official'],
    })
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { workers: [worker(accountDir)] },
      responses: codeResponses(),
      spawnWorker: makeSpawnWorker(undefined, { lines: [dirty, 'APPROACH_NOTE: прямой путь', RESULT_FRAME] }),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
      },
    })

    await tick(deps)

    const row = readAttempts(ledgerDir, 'BL-1')[0]
    expect(row.personalLayer.autoMemoryDir).toBe(AUTO_MEMORY)
    expect(row.personalLayer.initClaudeAiTools).toBe(2)
    expect(row.personalLayer.initMcpServers).toEqual(['claude.ai Gmail'])
    expect(row.personalLayer.initPlugins).toEqual(['skill-creator@official'])
  })

  it('init и result помечены видом кадра и хранятся ЦЕЛИКОМ — обрезанный init ничего не доказывает', async () => {
    const ledgerDir = mkDir('sma-ledger-')
    const written: any[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      responses: codeResponses(),
      spawnWorker: makeSpawnWorker(undefined, {
        lines: [INIT_FRAME, 'APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник', RESULT_FRAME],
      }),
      deps: {
        ledger: {
          recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
          readAttempts: (id: string) => readAttempts(ledgerDir, id),
          attemptLog: () => ({ append: (e: any) => written.push(e) }),
        },
      },
    })

    await tick(deps)

    expect(INIT_FRAME.length).toBeGreaterThan(5000)
    // две безымянные строки между кадрами — записка и урок работника; последняя — вердикт самого тика
    expect(written.map((e: any) => e.frameKind)).toEqual(['init', undefined, undefined, 'result', undefined])

    // …и через НАСТОЯЩИЙ писатель стенограммы кадр доезжает нерезаным
    const ledgerDir2 = mkDir('sma-ledger-')
    const adapter2 = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter2.enqueue(backlogTask({ id: 'BL-7' }))
    const { deps: deps2 } = makeDeps({
      adapter: adapter2,
      clockObj: c,
      responses: codeResponses('/wt/BL-7', 'wt/BL-7'),
      spawnWorker: makeSpawnWorker(undefined, {
        lines: [INIT_FRAME, 'APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник', RESULT_FRAME],
      }),
      deps: { ledger: ledgerSeam(ledgerDir2) },
    })
    await tick(deps2)
    const log = readAttemptLog({ dir: ledgerDir2, attemptId: 'BL-7#1' })
    expect(log.entries[0].line.length).toBe(INIT_FRAME.length)
  })

  // === THE ENVELOPE'S REFUSAL TRAVELS, AND BOTH SPAWN POINTS CARRY THE SAME ONE ===
  //
  // The four human-only actions were computed for every attempt this fleet ever ran, hashed
  // into its row and written to the journal - and read by nobody downstream. "The worker
  // cannot push" was a sentence in a prompt. These cases are about the WIRE and only the
  // wire: what reached the argument array of a started process, and what the attempt's own
  // record says it stood under. A test of the translation itself would have stayed green
  // through every day the wire was cut, and one did.
  //
  // WHAT IS DELIBERATELY NOT ASSERTED HERE: the refusal in the session's opening frame. That
  // frame lists the TOOLS a session holds, and we do not shorten that list - narrowing the
  // grant under a clean config turns every command nobody remembered into a silent refusal
  // inside the child. So the boundary is a denial rather than a shorter grant, and a denial
  // is simply not one of the things the opening frame enumerates. It is proved where it
  // actually passes: in the arguments, in the attempt record, and in a live refusal.

  // Открывающий кадр сессии, в которой ЗАШЁЛ сервер, объявленный в корне подключённого
  // проекта. Форма кадра — вендорская, поля взяты из живого прогона.
  const FOREIGN_INIT_FRAME = {
    type: 'system',
    subtype: 'init',
    session_id: '001afe17-d221-4736-adc8-35c3ec74e5c4',
    claude_code_version: '2.1.235',
    model: 'haiku',
    permissionMode: 'default',
    tools: ['Read', 'Bash', 'mcp__foreignproject__beacon'],
    mcp_servers: [{ name: 'foreignproject', status: 'connected' }],
    skills: [],
    agents: [],
    plugins: [],
  }

  it('запрет конверта доезжает до аргументов запущенного процесса И до записи попытки', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const projectDir = mkDir('sma-proj-')
    const ledgerDir = mkDir('sma-ledger-')
    const spawns: string[][] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const config = { workers: [worker(accountDir)], repoDir: projectDir, pipeline: { enabled: true } }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        spawns.push(spec.args.slice())
        spec.onLine?.(JSON.stringify(FOREIGN_INIT_FRAME))
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        projectDir: () => projectDir,
        // НАСТОЯЩИЙ сборщик аргументов - подделка здесь закрыла бы ровно тот стык,
        // ради которого случай написан
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
      },
    })

    await tick(deps)

    // (1) значение доехало до АРГУМЕНТОВ ЗАПУСКА
    expect(spawns).toHaveLength(1)
    const args = spawns[0]
    const at = args.indexOf('--disallowedTools')
    expect(at, 'запрет конверта не доехал до аргументов - граница осталась в журнале').toBeGreaterThan(-1)
    const expected = humanOnlyDenials(defaultEnvelope('prod')).patterns
    expect(expected.length).toBeGreaterThan(0)
    expect(args[at + 1]).toBe(expected.join(' '))
    expect(args[at + 1], 'сам push не назван в запрете').toContain('git push')
    // и разрешённое НЕ сузилось ради этого
    expect(args[args.indexOf('--allowedTools') + 1]).toBe([...defaultEnvelope('prod').allowedTools].join(' '))

    // (2) ровно тот же массив лежит в записи попытки
    const run = JSON.parse(readFileSync(join(projectDir, '.sma', 'runs', 'BL-1_1', 'run.json'), 'utf8'))
    expect(run.args).toEqual(args)
    expect(run.envelope.humanOnlyActions).toEqual([...defaultEnvelope('prod').humanOnlyActions])

    // (3) И ЧЕСТНАЯ СТРОКА О ТОМ, ЧЕГО МЫ НЕ ПОСЫЛАЛИ. Сервер, объявленный в корне
    // подключённого проекта, заходит в сессию, что бы ни стояло в настройках аккаунта
    // (измерено прогоном). Раз дверь не закрывается, продукт записывает, что через неё
    // прошло: инструменты сессии минус наши серверы.
    expect(run.init.unregisteredMcpTools).toEqual(['mcp__foreignproject__beacon'])
  })

  it('строка о чужих MCP считается по кадру сессии, а не по нашему намерению', () => {
    // наш сервер из реестра — не «чужой»
    expect(
      unregisteredMcpTools({ tools: ['Read', 'mcp__ours__do', 'mcp__foreign__beacon'] }, { servers: ['ours'] }),
    ).toEqual(['mcp__foreign__beacon'])
    // ни одного MCP-инструмента — пустой список, а не отсутствие поля
    expect(unregisteredMcpTools({ tools: ['Read', 'Bash'] }, { servers: [] })).toEqual([])
    // кадра нет вовсе — тоже пустой список, а не бросок
    expect(unregisteredMcpTools(null, null)).toEqual([])
    // повторов нет, порядок устойчив
    expect(
      unregisteredMcpTools({ tools: ['mcp__b__x', 'mcp__a__y', 'mcp__b__x'] }, null),
    ).toEqual(['mcp__a__y', 'mcp__b__x'])
  })

  it('обе точки спавна берут конверт из ОДНОЙ функции - аргументы двух путей совпадают', async () => {
    const sourceDir = founderHome()
    const seen: any[] = []
    const runOne = async (over: any) => {
      const accountDir = mkDir('sma-account-')
      const ledgerDir = mkDir('sma-ledger-')
      const c = mkClock()
      const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
      await adapter.enqueue(over.task)
      const { deps } = makeDeps({
        adapter,
        clockObj: c,
        config: { workers: [worker(accountDir, over.workerOver ?? {})], pipeline: { enabled: true } },
        spawnWorker: makeSpawnWorker(undefined, { lines: ['APPROACH_NOTE: прямой путь'] }),
        responses: over.responses,
        deps: {
          ledger: ledgerSeam(ledgerDir),
          execGit: () => '',
          mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
          buildArgs: (_t: any, _r: any, opts: any) => {
            seen.push(opts)
            return { bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }
          },
        },
      })
      await tick(deps)
    }

    // путь кода/документа
    await runOne({ task: backlogTask(), responses: codeResponses() })
    // путь "Создателя"
    await runOne({
      task: {
        id: 'F-1',
        source: 'roster',
        title: 'выкуй агента',
        lane: 'forge',
        priority: 0,
        forge: { kind: 'agent', description: 'читает и суммирует' },
      },
      workerOver: { lane: 'forge' },
      responses: { worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/F-1', branch: 'wt/x' }) } },
    })

    expect(seen, 'одна из двух точек спавна не позвала сборщик аргументов').toHaveLength(2)
    const [codePath, forgePath] = seen

    // обе точки несут ОБА измерения конверта...
    for (const [name, opts] of [['путь кода', codePath], ['путь Создателя', forgePath]] as const) {
      expect(opts.allowedTools, name).toEqual([...defaultEnvelope('prod').allowedTools])
      expect(opts.disallowedTools, name).toEqual([...humanOnlyDenials(defaultEnvelope('prod')).patterns])
    }
    // ...и, что здесь и есть предмет случая, СОБРАННЫЕ АРГУМЕНТЫ двух путей совпадают.
    // Два списка полей, которые сегодня говорят одно и то же, расходятся в тот день, когда
    // правят один из них: у этих двух точек такая история уже была.
    expect(buildClaudeArgs({ allowedTools: codePath.allowedTools, disallowedTools: codePath.disallowedTools })).toEqual(
      buildClaudeArgs({ allowedTools: forgePath.allowedTools, disallowedTools: forgePath.disallowedTools }),
    )
  })


  // === ОТКАЗ НАЗЫВАЕТСЯ КОМАНДОЙ, А НЕ СЧИТАЕТСЯ ===
  //
  // Вендор присылает на кадре результата ПОЛНЫЙ список отказанных вызовов — имя инструмента,
  // идентификатор вызова и сами аргументы. Демон сохранял из него ровно одно число. Человек у
  // окна видел «отказов: 1» и не знал, что именно работнику не дали сделать, — то есть ровно
  // то, чем доказывается вся граница, выбрасывалось на входе. Ниже — про запись, и только
  // про запись: что попало в `guards.jsonl` попытки.

  /** Кадр результата вендора: форма взята с живого прогона. */
  const denialFrame = (denials: any[]) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'd82a347f-a54a-4a33-9c87-0b2efb517172',
    permission_denials: denials,
  })

  const denial = (id: string, command: string, tool = 'Bash') => ({
    tool_name: tool,
    tool_use_id: id,
    tool_input: { command, description: 'что-то делает' },
  })

  /** Один тик с подставленными кадрами; отдаёт каталог проекта и разобранные файлы попытки. */
  const runWithFrames = async (lines: string[], over: any = {}) => {
    const accountDir = mkDir('sma-account-')
    const projectDir = mkDir('sma-proj-')
    const ledgerDir = mkDir('sma-ledger-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const config = { workers: [worker(accountDir)], repoDir: projectDir, pipeline: { enabled: true } }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        for (const line of lines) spec.onLine?.(line)
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      responses: over.responses ?? codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        projectDir: () => projectDir,
        execGit: () => '',
        // НАСТОЯЩИЙ сборщик аргументов, потому что от него зависит `spec.env` — а именно из
        // него берётся список значений, которые чистильщик обязан вырезать из журнала.
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir: founderHome() }),
      },
    })
    await tick(deps)
    const runDir = join(projectDir, '.sma', 'runs', 'BL-1_1')
    const guards = readFileSync(join(runDir, 'guards.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    return { guards, run, projectDir }
  }

  it('кадр с двумя отказами → две строки журнала, каждая с инструментом, командой и id вызова', async () => {
    const { guards, run } = await runWithFrames([
      JSON.stringify(
        denialFrame([
          denial('toolu_01AAA', 'git push origin HEAD'),
          denial('toolu_01BBB', 'npm publish --access public'),
        ]),
      ),
    ])
    const vendor = guards.filter((g) => g.kind === 'denied' && g.source === 'vendor')
    expect(vendor, 'вендорский список снова сведён к числу').toHaveLength(2)
    expect(vendor.map((g) => g.command)).toEqual(['git push origin HEAD', 'npm publish --access public'])
    expect(vendor.map((g) => g.tool)).toEqual(['Bash', 'Bash'])
    expect(vendor.map((g) => g.toolUseId)).toEqual(['toolu_01AAA', 'toolu_01BBB'])
    // КОЛИЧЕСТВО СОХРАНЕНО РЯДОМ, а не вместо: два факта, которые имеют право разойтись
    expect(run.exit.permissionDenials).toBe(2)
  })

  it('тот же кадр дважды — отказ остаётся одним: строки не удваиваются', async () => {
    const frame = JSON.stringify(denialFrame([denial('toolu_01AAA', 'git push origin HEAD')]))
    const { guards } = await runWithFrames([frame, frame])
    expect(guards.filter((g) => g.kind === 'denied' && g.source === 'vendor')).toHaveLength(1)
  })

  it('лавина отказов упирается в объявленный предел и закрывается строкой-остатком', async () => {
    const many = Array.from({ length: DENIAL_LINES_CAP + 7 }, (_, i) => denial(`toolu_${i}`, `git push origin b${i}`))
    const { guards, run } = await runWithFrames([JSON.stringify(denialFrame(many))])
    const vendor = guards.filter((g) => g.kind === 'denied' && g.source === 'vendor')
    expect(vendor).toHaveLength(DENIAL_LINES_CAP)
    const tail = guards.find((g) => g.kind === 'denied_overflow')
    expect(tail, 'потеря молча — запрещена').toBeTruthy()
    expect(tail.notRecorded).toBe(7)
    expect(String(tail.reason)).toContain('7')
    // и число вендора по-прежнему полное
    expect(run.exit.permissionDenials).toBe(DENIAL_LINES_CAP + 7)
  })

  it('длинная команда обрезана по константе и обрезка помечена явно', async () => {
    const long = `git push ${'x'.repeat(DENIAL_COMMAND_MAX + 200)}`
    const { guards } = await runWithFrames([JSON.stringify(denialFrame([denial('toolu_01L', long)]))])
    const one = guards.find((g) => g.kind === 'denied' && g.source === 'vendor')
    expect(one.command.length).toBeLessThan(long.length)
    expect(one.command).toContain(DENIAL_TRUNCATION_MARK)
    expect(one.command.startsWith('git push xxx')).toBe(true)
  })

  it('значение переменной окружения внутри отказанной команды не доезжает до файла', async () => {
    const { guards } = await runWithFrames([
      JSON.stringify(denialFrame([denial('toolu_01S', 'curl -H "Authorization: oauth-value" https://example.com')])),
    ])
    const one = guards.find((g) => g.kind === 'denied' && g.source === 'vendor')
    expect(String(one.command)).not.toContain('oauth-value')
  })

  it('обе точки сборки копии несут pushLock в запись попытки — объекты копии равны', async () => {
    const lock = {
      applied: true,
      isolated: true,
      worktreeConfigPreset: true,
      mainPushUrl: '',
      reason: 'the copy has no address to push to; the main tree keeps its own',
    }
    /** Один и тот же ответ верба выдачи копии — обеим точкам. */
    const answer = (path: string, branch: string) => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, path, branch, expectedBase: 'BASE', materialized: [], pushLock: lock }),
    })

    const copyOf = async (over: any) => {
      const accountDir = mkDir('sma-account-')
      const projectDir = mkDir('sma-proj-')
      const ledgerDir = mkDir('sma-ledger-')
      const c = mkClock()
      const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
      await adapter.enqueue(over.task)
      const { deps } = makeDeps({
        adapter,
        clockObj: c,
        config: {
          workers: [worker(accountDir, over.workerOver ?? {})],
          repoDir: projectDir,
          pipeline: { enabled: true },
        },
        spawnWorker: makeSpawnWorker(undefined, { lines: ['APPROACH_NOTE: прямой путь'] }),
        responses: over.responses,
        deps: {
          ledger: ledgerSeam(ledgerDir),
          projectDir: () => projectDir,
          execGit: () => '',
          mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir: founderHome() }),
        },
      })
      await tick(deps)
      const dir = join(projectDir, '.sma', 'runs', over.runId)
      return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).copy
    }

    // путь кода
    const codeCopy = await copyOf({
      task: backlogTask(),
      runId: 'BL-1_1',
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: answer('/wt/BL-1', 'wt/BL-1'),
        reverify: GREEN_REVERIFY,
      },
    })
    // путь «Создателя»
    const forgeCopy = await copyOf({
      task: {
        id: 'F-1',
        source: 'roster',
        title: 'выкуй агента',
        lane: 'forge',
        priority: 0,
        forge: { kind: 'agent', description: 'читает и суммирует' },
      },
      workerOver: { lane: 'forge' },
      runId: 'F-1_1',
      responses: { worktree: answer('/wt/F-1', 'wt/F-1') },
    })

    // ОБЕ ТОЧКИ, и это здесь предмет случая: «доехало до одной из двух» — это не доехало.
    expect(codeCopy.pushLock, 'путь кода потерял замок').toEqual(lock)
    expect(forgeCopy.pushLock, 'путь Создателя потерял замок').toEqual(lock)
    // Два списка полей, которые сегодня говорят одно и то же, расходятся в тот день, когда
    // правят один из них: у этих двух точек такая история уже была.
    expect(Object.keys(codeCopy).sort()).toEqual(Object.keys(forgeCopy).sort())
    // и объекты копии РАВНЫ, если убрать то, что законно различается у двух задач
    const same = (row: any) => ({ ...row, branch: 'X', worktreePath: 'X', provisionMs: 0 })
    expect(same(codeCopy)).toEqual(same(forgeCopy))
  })

  it('старая установка не отвечает про замок — в записи `null`, а не выдуманное «замок стоит»', async () => {
    const { run } = await runWithFrames([], { responses: codeResponses() })
    expect(run.copy.pushLock).toBe(null)
  })

  it('замок на расход двух точек сборки копии: строка копии собирается одной функцией', () => {
    const source = readFileSync(new URL('../src/loop.mjs', import.meta.url), 'utf8')
    // ровно два вызова — по одному на точку сборки объекта копии
    expect(source.match(/=\s*copyRow\(\{/g) ?? []).toHaveLength(2)
    // и ни одной точки, которая собирает строку копии своим списком полей
    expect(source).not.toMatch(/worktreeRow\s*=\s*\{\s*base:/)
  })

  it('замок на расход двух точек: опции конверта собирает одна функция и никто больше', () => {
    const source = readFileSync(new URL('../src/loop.mjs', import.meta.url), 'utf8')
    // ровно два вызова - по одному на точку спавна
    expect(source.match(/envelopeSpawnOptions\(envelope\)/g) ?? []).toHaveLength(2)
    // и ни одной точки, которая собирает поле конверта своим литералом
    expect(source).not.toMatch(/allowedTools:\s*envelope\.allowedTools/)
  })
})

/**
 * ═══ СЛОЙ ПАМЯТИ ЖУРНАЛА — НА КАЖДУЮ ПОПЫТКУ И ИЗ РЕАЛЬНОГО СЛЕДА ═══════════════
 *
 * Слой `memory` писался ТОЛЬКО работнику с файлом роли и нёс ИМЯ ЭТОЙ РОЛИ — заявление,
 * сделанное до того, как сессия открыла рот. На машине это дало ноль строк слоя за десятки
 * попыток при обещании «маховик памяти крутится в обе стороны». Ниже проверяется ПРОВОД, а
 * не вычисление: кадры стенограммы и файлы `.sma` доезжают до строки журнала, и строка есть
 * у КАЖДОЙ попытки — и у принятой, и у проваленной.
 *
 * Подделка стрима — настоящие кадры: фикстура `claude-stream-read-frame.ndjson` снята с
 * живой стенограммы (`Read` с `file_path` в копии, `Read` авто-памяти аккаунта, `Bash` с
 * вызовом конвейера памяти), у неё обезличен только каталог. Подделка, умеющая больше
 * библиотеки, уже однажды показывала зелёный сьют поверх сломанного провода.
 */
const READ_FRAMES = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-stream-read-frame.ndjson'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())

/** Каталог и сессия, записанные в фикстуре: копия подставляется своя, сессия — та же. */
const FIXTURE_WORKDIR = 'C:\\work\\.sma-worktrees\\t-25212'
const FIXTURE_SESSION = 'd82a347f-a54a-4a33-9c87-0b2efb517172'

/** Те же кадры, но про КОПИЮ этого кейса: путь переписывается внутри разобранного кадра. */
const framesFor = (workDir: string) =>
  READ_FRAMES.map((line) => {
    const frame = JSON.parse(line)
    for (const block of frame.message?.content ?? []) {
      if (block && typeof block.input?.file_path === 'string') {
        block.input.file_path = block.input.file_path.split(FIXTURE_WORKDIR).join(workDir)
      }
    }
    return JSON.stringify(frame)
  })

/**
 * Кадры двух ЖИВЫХ прогонов: в зелёном чтение оглавления вернулось, в красном — копия была
 * отведена без `.claude/`, и тот же `Read` получил «File does not exist». Год такой прогон
 * записывался как «работник прочитал память проекта»: трейсер считал НАМЕРЕНИЕ.
 */
const PARITY_WORKDIR = 'C:\\work\\.sma-worktrees\\t-1000'
const parityFrames = (file: string, workDir: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const frame = JSON.parse(line)
      for (const block of frame.message?.content ?? []) {
        if (block && typeof block.input?.file_path === 'string') {
          block.input.file_path = block.input.file_path.split(PARITY_WORKDIR).join(workDir)
        }
      }
      return JSON.stringify(frame)
    })

describe('слой памяти пишется на каждую попытку — из того, что работник правда прочитал', () => {
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

  const NOTE = 'APPROACH_NOTE: прямой путь'
  const memoryRows = (rows: any[]) => rows.filter((e) => e && e.layer === 'memory')

  const runAttempt = async (over: any = {}) => {
    const snapshot = answer([rec('R-A', 'divergent')])
    const rows: any[] = []
    const { deps } = makeDeps({
      adapter: oneTaskAdapter(backlogTask({ attempt: 1 })),
      responses: {
        ...DIFF_RESPONSES(inTurn([snapshot, snapshot])),
        ...(over.workDir
          ? { worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: over.workDir, branch: 'wt/BL-1' }) } }
          : {}),
      },
      spawnWorker: makeSpawnWorker(undefined, { lines: over.lines, noLesson: over.noLesson === true }),
      config: over.config ?? {},
      deps: { execGit: makeGateGit(), decisionJournal: (e: any) => rows.push(e), ...over.deps },
    })
    const res = await tick(deps)
    return { res, rows }
  }

  it('попытка БЕЗ роли всё равно имеет слой: оглавление, заметка, вызов конвейера, авто-память', async () => {
    const workDir = mkDir('sma-mem-')
    const { res, rows } = await runAttempt({
      workDir,
      lines: [...framesFor(workDir), NOTE, 'LESSON_NONE: задача была чистым чтением'],
    })

    expect(res.completed).toBe('BL-1')
    const memory = memoryRows(rows)
    expect(memory).toHaveLength(1)
    const p = memory[0].payload
    // прочитанное в копии: оглавление отдельно от заметки, вызов конвейера — счётчиком
    expect(p.loaded).toEqual({ index: true, reads: ['alpha'], loadCalls: 1 })
    // авто-память аккаунта — ОТДЕЛЬНЫМ списком: это не память проекта
    expect(p.autoMemoryReads).toEqual(['memory-check-grey-morning'])
    expect(p.notes).toEqual([])
    expect(p.reflexes).toEqual([])
    expect(p.reflexSource).toBe('none')
    expect(p.lesson).toEqual({ none: 'задача была чистым чтением' })
    expect(p.approach).toBe('journaled')
  })

  it('оглавление засчитано, потому что файл ВЕРНУЛСЯ: у чтения есть парный tool_result', async () => {
    const workDir = mkDir('sma-mem-ok-')
    const { res, rows } = await runAttempt({
      workDir,
      lines: [...parityFrames('claude-stream-parity-green.ndjson', workDir), NOTE, 'LESSON_NONE: задача была чистым чтением'],
    })

    expect(res.completed).toBe('BL-1')
    const [row] = memoryRows(rows)
    expect(row.payload.loaded.index).toBe(true)
    expect(row.payload.loaded.loadCalls).toBe(1)
  })

  it('провалившийся Read оглавления БОЛЬШЕ не считается прочтением — копия была без `.claude/`', async () => {
    const workDir = mkDir('sma-mem-noclaude-')
    const { rows } = await runAttempt({
      workDir,
      lines: [...parityFrames('claude-stream-parity-red-memory.ndjson', workDir), NOTE, 'LESSON_NONE: задача была чистым чтением'],
    })

    const [row] = memoryRows(rows)
    // это ровно тот кадр, который год давал зелёную квитанцию «память»
    expect(row.payload.loaded).toEqual({ index: false, reads: [], loadCalls: 0 })
  })

  it('Read БЕЗ результата вовсе не засчитывается: намерение — не факт', async () => {
    const workDir = mkDir('sma-mem-noresult-')
    const asked = parityFrames('claude-stream-parity-green.ndjson', workDir).filter((line) => {
      const frame = JSON.parse(line)
      return frame.type !== 'user' // выбрасываем ответы, оставляем только просьбы
    })
    const { rows } = await runAttempt({
      workDir,
      lines: [...asked, NOTE, 'LESSON_NONE: задача была чистым чтением'],
    })

    const [row] = memoryRows(rows)
    expect(row.payload.loaded).toEqual({ index: false, reads: [], loadCalls: 0 })
  })

  it('рефлексы и цитаты берутся из `.sma` проекта по хешу сессии работника', async () => {
    const workDir = mkDir('sma-mem-wt-')
    const projectDir = mkDir('sma-mem-proj-')
    const terminal = `t-${tokenHash(FIXTURE_SESSION)}`
    mkdirSync(join(projectDir, '.sma', 'usage'), { recursive: true })
    mkdirSync(join(projectDir, '.sma', 'journal'), { recursive: true })
    writeFileSync(
      join(projectDir, '.sma', 'usage', `${terminal}.jsonl`),
      `${JSON.stringify({ ts: 1, terminal, seq: 1, noteId: 'u1', kind: 'load' })}\n`,
      'utf8',
    )
    writeFileSync(
      join(projectDir, '.sma', 'journal', `${terminal}.jsonl`),
      `${JSON.stringify({ ts: 1, terminal, type: 'reflex', detail: { noteId: 'r1', tier: 'core' } })}\n`,
      'utf8',
    )

    const { rows } = await runAttempt({
      workDir,
      config: { repoDir: projectDir },
      lines: [...framesFor(workDir), NOTE, 'LESSON_NONE: задача была чистым чтением'],
    })

    const [row] = memoryRows(rows)
    expect(row.payload.reflexes).toEqual(['r1'])
    expect(row.payload.reflexSource).toBe('sma-journal')
    // цитаты конвейера и кадры стенограммы — ОДИН список прочитанного по проекту
    expect([...row.payload.loaded.reads].sort()).toEqual(['alpha', 'u1'])
  })

  it('ПРОВАЛЕННАЯ попытка тоже имеет слой, и он говорит, что урока нет', async () => {
    const workDir = mkDir('sma-mem-red-')
    const { res, rows } = await runAttempt({
      workDir,
      noLesson: true,
      lines: [...framesFor(workDir), NOTE],
    })

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_lesson' })
    const memory = memoryRows(rows)
    expect(memory).toHaveLength(1)
    expect(memory[0].payload.lesson).toEqual({ missing: true })
    expect(memory[0].payload.loaded.index).toBe(true)
    expect(memory[0].payload.approach).toBe('journaled')
  })

  it('роль и навыки остаются в `notes`, но строка слоя по-прежнему ОДНА', async () => {
    const workDir = mkDir('sma-mem-role-')
    const { rows } = await runAttempt({
      workDir,
      lines: [...framesFor(workDir), NOTE, 'LESSON_NONE: задача была чистым чтением'],
      config: {
        workers: [
          {
            id: 'max-2',
            lane: 'prod',
            provider: 'claude',
            account: { configDir: '/x' },
            enabled: true,
            roleFile: '.claude/agents/builder.md',
            skills: ['sma-debug'],
          },
        ],
      },
      deps: {
        resolveWorkerContext: () => ({
          rolePreamble: 'СЕКРЕТНОЕ тело роли, целый абзац',
          skillsList: ['sma-debug', 'sma-quick'],
        }),
      },
    })

    const memory = memoryRows(rows)
    expect(memory).toHaveLength(1)
    expect(memory[0].payload.notes).toEqual(['.claude/agents/builder.md', 'sma-debug', 'sma-quick'])
    // тело роли в журнал не уезжает — ни ids, ни текстом
    expect(JSON.stringify(memory[0])).not.toContain('СЕКРЕТНОЕ')
  })

  it('попытка, не тронувшая память, всё равно оставляет слой — пустой и говорящий об этом', async () => {
    const workDir = mkDir('sma-mem-empty-')
    const { rows } = await runAttempt({
      workDir,
      lines: ['stream line', NOTE, 'LESSON_NONE: задача была чистым чтением'],
    })

    const [row] = memoryRows(rows)
    expect(row.payload.loaded).toEqual({ index: false, reads: [], loadCalls: 0 })
    expect(row.payload.autoMemoryReads).toEqual([])
    expect(row.payload.reflexSource).toBe('none')
  })
})

/**
 * ═══════ ЧЕМ СПРАШИВАЮТ ДВЕРЬ «РАБОТА УЖЕ СДЕЛАНА» — ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ ═══════
 *
 * Вычислитель вердикта живёт в вербе, покрыт своими фикстурами и здесь не проверяется вовсе.
 * Эти кейсы — про ПРОВОД между тиком и вербом, потому что сломан был именно он, и сломан был
 * тихо: дверь звали идентификатором задачи там, где верб ждёт ПУТЬ К ФАЙЛУ ПЛАНА, не просили
 * машинного вывода, поэтому верб печатал строку для человека, читатель ответов не находил в
 * ней объекта и возвращал пустоту — а пустота читалась как «не построено». Каждый кусок
 * маршрута был написан и зелен по отдельности; ни один не был присоединён к соседнему.
 *
 * Поэтому подставной исполнитель здесь не отвечает по имени верба, а ЗАПИСЫВАЕТ, чем его
 * позвали: имя, полный список аргументов и рабочий каталог. Утверждается ровно это.
 */

/** Раннер-регистратор: пишет {verb, args, cwd} каждого вызова, отвечает по вербу или по пути. */
function recordingRunner(seen: { verb: string; args: string[]; cwd: string }[], responses: Record<string, any>) {
  return async (_bin: string, argsArray: string[], opts: any) => {
    const verb = argsArray[1]
    seen.push({ verb, args: argsArray, cwd: opts && opts.cwd })
    const r = responses[verb] ?? { code: 0, stdout: '{}' }
    return typeof r === 'function' ? r(argsArray) : r
  }
}

const BUILT_ANSWER = { code: 0, stdout: JSON.stringify({ verdict: 'built', code: 0, confidence: 'high' }) }
const ABSENT_ANSWER = { code: 2, stdout: JSON.stringify({ verdict: 'absent', code: 2, confidence: 'high' }) }
const AFTER_THE_DOOR = {
  worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/ST-1', branch: 'wt/ST-1' }) },
  reverify: GREEN_REVERIFY,
}

describe('дверь «работа уже сделана» спрашивается путём плана, машинным выводом и деревом проекта', () => {
  it('ПРОВОД: первым позиционалом — существующий файл плана, среди флагов машинный вывод, cwd — дерево проекта', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    // план лежит в дереве ПОДКЛЮЧЁННОГО проекта, а не в каталоге, из которого запущен процесс
    const fs = makeFs({ '/connected/.planning/phases/12-front/12-01-PLAN.md': '# plan' })
    const { deps } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, { preflight: ABSENT_ANSWER, ...AFTER_THE_DOOR }),
      deps: { projectDir: () => '/connected', fsImpl: fs, execGit: makeGit({}) },
    })

    await tick(deps)

    const calls = seen.filter((s) => s.verb === 'preflight')
    expect(calls).toHaveLength(1)
    const [call] = calls
    // (а) первый позиционал после имени верба — ПУТЬ, а не идентификатор задачи…
    const positional = call.args[2]
    expect(positional).not.toBe('ST-1')
    expect(positional.endsWith('-PLAN.md')).toBe(true)
    // …и путь этот РЕАЛЬНО существует — там, где верб его будет резолвить: от своего cwd
    expect(fs.existsSync(`${call.cwd}/${positional}`)).toBe(true)
    // (б) машинный вывод запрошен: без него верб печатает строку для человека, и читатель
    // ответов возвращает пустоту, которую код принимает за «не построено»
    expect(call.args).toContain('--json')
    // (в) вопрос задан в дереве ПРОЕКТА: и путь плана, и пути артефактов внутри плана
    // резолвятся от рабочего каталога ребёнка
    expect(call.cwd).toBe('/connected')
  })

  it('без подключённого проекта вопрос задают в дереве, которое обслуживает процесс — законный запасной путь', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, { preflight: ABSENT_ANSWER, ...AFTER_THE_DOOR }),
      deps: { fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }), execGit: makeGit({}) },
    })

    await tick(deps)

    expect(seen.find((s) => s.verb === 'preflight')!.cwd).toBe('/repo')
  })

  it('фаза из двух планов: построен один — дверь НЕ открывается, спрошены ОБА, оба вердикта в журнале', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps, order, journalled } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, {
        // отвечаем ПО ПУТИ из аргументов: первый план построен, второй ещё нет
        preflight: (args: string[]) => (args[2].includes('12-01-PLAN.md') ? BUILT_ANSWER : ABSENT_ANSWER),
        ...AFTER_THE_DOOR,
      }),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan', [`${PHASE_DIR}/12-02-PLAN.md`]: '# plan' }),
        execGit: makeGit({}),
      },
    })

    const res = await tick(deps)

    // спрошены ОБА плана — «новейший» здесь ничего не решает
    const asked = seen.filter((s) => s.verb === 'preflight').map((s) => s.args[2])
    expect(asked).toEqual([
      '.planning/phases/12-front/12-01-PLAN.md',
      '.planning/phases/12-front/12-02-PLAN.md',
    ])
    // задача дошла до работника и закрылась ЕГО квитанцией, а не квитанцией двери:
    // ложное «построено» закрыло бы недоделанную фазу навсегда и молча
    expect(order).toContain('spawn')
    expect(res.completed).toBe('ST-1')
    expect(adapter.calls[0].result.receiptRef).toBe('reverify:abc')
    // оба ответа — на записи, с путями, по которым их можно перепроверить руками
    const verdicts = journalled.filter((e: any) => e.type === 'preflight.verdict')
    expect(verdicts.map((e: any) => [e.planPath, e.verdict])).toEqual([
      ['.planning/phases/12-front/12-01-PLAN.md', 'built'],
      ['.planning/phases/12-front/12-02-PLAN.md', 'absent'],
    ])
  })

  it('фаза из двух планов: построены ОБА — задача закрыта квитанцией двери, работника не поднимали', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps, order, attempts } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, { preflight: BUILT_ANSWER, ...AFTER_THE_DOOR }),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan', [`${PHASE_DIR}/12-02-PLAN.md`]: '# plan' }),
        execGit: makeGit({}),
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    expect(order).toEqual([]) // ни рабочей копии, ни запуска работника
    expect(seen.map((s) => s.verb)).toEqual(['preflight', 'preflight'])
    // квитанция постоянной формы — верб своей не отдаёт, а экран читает именно эту
    expect(adapter.calls[0].result.receiptRef).toBe('preflight:ST-1')
    expect(adapter.calls[0].result.branch).toBe(null)
    // переход состояний НЕ минтится: работник не стартовал, называть нечего
    expect(Object.hasOwn(attempts[0], 'idempotencyKey')).toBe(false)
    expect(Object.hasOwn(attempts[0], 'stateMachineVersion')).toBe(false)
  })

  it('у задачи нет номера фазы — верб НЕ вызывают вовсе, и причина записана', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-NOPHASE' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      verbRunner: recordingRunner(seen, {
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
        reverify: GREEN_REVERIFY,
      }),
    })

    await tick(deps)

    // именно ОТСУТСТВИЕ вызова, а не пустой ответ: у такой задачи плана нет по построению,
    // а признаки её успеха — проза, которую вердикту судить нельзя
    expect(seen.filter((s) => s.verb === 'preflight')).toHaveLength(0)
    const skipped = journalled.filter((e: any) => e.type === 'preflight.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].taskId).toBe('BL-NOPHASE')
    expect(String(skipped[0].reason)).toContain('фазы')
  })

  it('фаза есть, а планов в дереве нет — верб НЕ вызывают, причина другая и тоже записана', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps, journalled } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, AFTER_THE_DOOR),
      deps: { fsImpl: makeFs({ [`${PHASE_DIR}/12-CONTEXT.md`]: '# ctx' }), execGit: makeGit({}) },
    })

    await tick(deps)

    expect(seen.filter((s) => s.verb === 'preflight')).toHaveLength(0)
    const [skipped] = journalled.filter((e: any) => e.type === 'preflight.skipped')
    expect(skipped).toBeTruthy()
    expect(String(skipped.reason)).toContain('планов')
  })

  it('вердикт пишется ВСЕГДА: «не построено» тоже строка в журнале, а не молчание', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps, order, journalled } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, { preflight: ABSENT_ANSWER, ...AFTER_THE_DOOR }),
      deps: { fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }), execGit: makeGit({}) },
    })

    await tick(deps)

    const [verdict] = journalled.filter((e: any) => e.type === 'preflight.verdict')
    expect(verdict).toMatchObject({
      taskId: 'ST-1',
      planPath: '.planning/phases/12-front/12-01-PLAN.md',
      verdict: 'absent',
      code: 2,
    })
    // ненулевой код верба — это ДАННЫЕ, а не отказ: задача спокойно идёт к работнику
    expect(order).toContain('spawn')
  })

  it('верб не запустился вовсе — вердикт всё равно на записи, вместе с текстом ошибки', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'code', stage: 'execute', phase: 12 }, { lane: 'prod' }))
    const { deps, order, journalled } = stageDeps({
      adapter,
      verbRunner: async (_bin: string, argsArray: string[]) => {
        if (argsArray[1] === 'preflight') throw new Error('cli.mjs не найден в этом дереве')
        const r = (AFTER_THE_DOOR as any)[argsArray[1]] ?? { code: 0, stdout: '{}' }
        return r
      },
      deps: { fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }), execGit: makeGit({}) },
    })

    await tick(deps)

    const [verdict] = journalled.filter((e: any) => e.type === 'preflight.verdict')
    expect(verdict.verdict).toBe(null)
    expect(String(verdict.error)).toContain('cli.mjs')
    // сломанная дверь никогда не блокирует стройку — она только переисполняет
    expect(order).toContain('spawn')
  })

  it('документарная стадия дверь по-прежнему не спрашивает и в журнал о ней ничего не пишет', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const seen: { verb: string; args: string[]; cwd: string }[] = []
    const { deps, journalled } = stageDeps({
      adapter,
      verbRunner: recordingRunner(seen, {}),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-01-PLAN.md`]: '# plan' }),
        execGit: makeGit({ '.planning/phases/12-front/12-01-PLAN.md': 'abc1234' }),
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('ST-1')
    expect(seen.filter((s) => s.verb === 'preflight')).toHaveLength(0)
    expect(journalled.some((e: any) => String(e.type).startsWith('preflight.'))).toBe(false)
  })
})
