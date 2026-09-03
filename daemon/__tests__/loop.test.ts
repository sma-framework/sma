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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// the discussion checkpoint's SHIPPED template, imported as DATA — the exec checkpoint is
// asserted to be this exact shape plus a position block, never a second schema
import discussTemplate from '../../sma-core/workflows/discuss-phase/templates/checkpoint.json'

import {
  tick,
  runDaemon,
  classifyFailure,
  turnCapHitOf,
  contextExhaustedOf,
  lastToolErrorOf,
  TRANSCRIPT_ERROR_MAX,
  changedFilesOnBranch,
  unregisteredMcpTools,
  DENIAL_LINES_CAP,
  DENIAL_COMMAND_MAX,
  DENIAL_TRUNCATION_MARK,
} from '../src/loop.mjs'
import { tokenHash } from '../../scripts/sma/lib/registry.mjs'
import { createAgingMemory } from '../src/policy/aging-memory.mjs'
import { createMemoryQueue, FAIL_REASONS, REASON_LABELS, failureAwaitsAPerson, AUTO_RETRY_LIMIT, AUTO_RETRY_BASE_MS } from '../src/queue/adapter.mjs'
// Единый журнал срывов — читается и пишется здесь через те же две функции, что демон
// подаёт тику швом `ledger`: тест о том, что срыв доезжает до журнала САМ, не имеет права
// подсовывать проходу свой журнал в памяти.
import { appendBug, readBugs } from '../src/queue/bug-journal.mjs'
// Imported for the cases at the foot of this file: the wire from a worker's stdout to the
// screen's payload. Every joint of that path had a green test of its own while the path
// itself was cut, so the case has to cross the module boundary the defect hid behind.
import { deriveState } from '../src/front/state.mjs'
// The LIVE role resolver, imported for the wire cases at the foot of this file: an agent that
// lives in this machine's store has no repo-relative roleFile to be gated on, so «доехала ли
// роль» can only be answered by letting the real resolver meet the real tick.
import { resolveWorkerContext } from '../src/front/harness.mjs'
import { tickJournalLine } from '../src/main.mjs'
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
  ATTEMPT_FILES_CAP,
} from '../src/queue/attempt-ledger.mjs'
// `correctionsPreamble` is used AS ITSELF below: the cases about a correction's wording ask
// the module that owns what a correction IS, never a sentence retyped into a test. A hand
// written expectation would go on passing after the two forms drifted apart.
import { appendRedirect, readPendingRedirects, redirectFileOf, correctionsPreamble } from '../src/runner/redirects.mjs'
// Реестр живых ручек берётся НАСТОЯЩИЙ — тот же, что держит демон и дёргает дверь поправки:
// подделка здесь закрыла бы ровно тот провод, ради которого случай ниже и написан.
import { createTurnRegistry } from '../src/front/chat.mjs'
import { attemptRunDir, runsDirOf } from '../src/queue/run-dir.mjs'
import { formatDecision, parseDecision, ticketIdFor, readWaitingTicket } from '../../scripts/sma/lib/tool-gate.mjs'
import { writeWaveHold } from '../src/queue/wave-holds.mjs'
// Уборка копий — КАК ОНА ЕСТЬ, а не подделкой: дело внизу утверждает провод «уборка снимает
// ровно тот каталог, который положила провизия», и подделка уборки была бы в нём той самой
// сообразительностью, которая шесть раз за две фазы удостоверяла собственное отличие.
import { cleanupTaskWorktree, insideCopiesDir } from '../src/queue/worktree-cleanup.mjs'
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

/**
 * Провизия копии, отвечающая КОРНЕМ ФИКСТУРЫ, — потому что кейсы ниже про ГЕЙТ.
 *
 * Ступень любого рода теперь идёт в своей копии (31.08.2026: документарная ступень писала
 * коммитами прямо в main дерева планирования). Кейсам этого раздела адрес копии безразличен —
 * им важно, ЧТО гейт признаёт документом, — поэтому подделка отвечает тем же корнем, в котором
 * лежат фикстуры, и ни один из полутора десятка их не переписывается ради одного адреса. Сам
 * АДРЕС — «работник стоит в копии, а не в дереве человека» — утверждается там, где он и есть
 * предмет спора: `stage-copy-wire.test.ts`, настоящей дверью над настоящей очередью.
 */
const STAGE_WORKTREE = {
  code: 0,
  stdout: JSON.stringify({ ok: true, path: '/repo', branch: 'wt/ST-1', expectedBase: 'base1234' }),
}

/** Every stage case routes the same way; the cases are about the GATE, nothing else. */
const stageDeps = (over: any = {}) =>
  makeDeps({
    ...over,
    responses: { worktree: STAGE_WORKTREE, ...over.responses },
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
    // a documentary stage gets a copy exactly like code work (31.08.2026 — without one it
    // committed straight into the founder's own main), and no preflight: «is this backlog item
    // already built» is not a question a phase stage can be asked
    expect(order).toEqual(['worktree', 'spawn'])
    expect(call.result.branch).toBe('wt/ST-1')
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

/**
 * ═══════ ОТКАЗ СТУПЕНИ ГОВОРИТ СЛОВАМИ, А НЕ ОДНИМ ИМЕНЕМ ГЕЙТА ═══════════════════════
 *
 * Живой случай, ради которого это написано. Пакетный вызов настроек упал на одном ключе;
 * работник вежливо вышел, не оставив файла; гейт честно отказал `no_artifact`. Карточка
 * сказала «стадия не оставила файла» — правду о последствии и ничего о причине, — и так ТРИ
 * попытки подряд, каждая под одной и той же подписью. Причина всё это время лежала в
 * стенограмме первой из них.
 *
 * Проверяется вся дорога, а не её куски: строка стенограммы → тик → строка реестра → payload,
 * который читает экран. Каждый стык этой дороги имел свой зелёный тест, пока сама дорога была
 * разорвана, — поэтому последний случай пересекает границу модулей.
 */
describe('a refused stage carries the last error of its own transcript', () => {
  /** Кадр результата инструмента в той же форме, в какой его шлёт CLI. */
  const toolResult = (text: string, isError = true) =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: isError, content: text }] },
    })

  const KEY_ERROR = 'Error: Key not found: workflow.mvp_mode'

  it('lastToolErrorOf берёт ПОСЛЕДНЮЮ ошибку: работа идёт вперёд, кончилась она на ней', () => {
    const lines = [toolResult('Error: первая, её обошли'), 'что-то сказал работник', toolResult(KEY_ERROR)]

    expect(lastToolErrorOf(lines)).toBe(KEY_ERROR)
  })

  it('удачный результат ошибкой не считается, и без ошибок ответ — null', () => {
    expect(lastToolErrorOf([toolResult('всё хорошо', false), 'stream line'])).toBeNull()
    expect(lastToolErrorOf(['stream line', 'APPROACH_NOTE: прямой путь'])).toBeNull()
    expect(lastToolErrorOf(['{не json'])).toBeNull()
    expect(lastToolErrorOf(null as any)).toBeNull()
  })

  it('ошибка без слов пропускается — сказать человеку нечего, ищем глубже', () => {
    expect(lastToolErrorOf([toolResult(KEY_ERROR), toolResult('   ')])).toBe(KEY_ERROR)
  })

  it('длинная ошибка обрезается и говорит об этом', () => {
    const long = `${'ы'.repeat(TRANSCRIPT_ERROR_MAX + 50)}`
    const got = String(lastToolErrorOf([toolResult(long)]))

    expect(got.length).toBe(TRANSCRIPT_ERROR_MAX + 1)
    expect(got.endsWith('…')).toBe(true)
  })

  it('слова ошибки едут в отказ тика и на строку реестра, рядом с именем гейта', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const { deps, attempts } = stageDeps({
      adapter,
      spawnWorker: makeSpawnWorker(undefined, {
        lines: [toolResult(KEY_ERROR), 'APPROACH_NOTE: спросил настройку пакетом'],
      }),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-CONTEXT.md`]: 'ctx' }),
        execGit: makeGit({ '.planning/phases/12-front/12-CONTEXT.md': 'deadbee' }),
      },
    })

    const res = await tick(deps)

    expect(res.failed.reason).toBe('no_artifact')
    // ИМЯ ГЕЙТА ОСТАЁТСЯ — оно про последствие, и оно по-прежнему нужно…
    expect(String(res.failed.detail)).toContain('не оставила файла')
    // …а рядом с ним теперь стоит то, на чём работа споткнулась в последний раз.
    expect(String(res.failed.detail)).toContain(KEY_ERROR)
    const failedRow = attempts.find((a: any) => a.outcome === 'failed')
    expect(String(failedRow.failureDetail)).toContain(KEY_ERROR)
    expect(String(failedRow.failureDetail)).toContain('не оставила файла')
  })

  it('отказ без единой ошибки в стенограмме не выдумывает слов', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const { deps, attempts } = stageDeps({
      adapter,
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-CONTEXT.md`]: 'ctx' }),
        execGit: makeGit({ '.planning/phases/12-front/12-CONTEXT.md': 'deadbee' }),
      },
    })

    const res = await tick(deps)

    expect(String(res.failed.detail)).toContain('не оставила файла')
    expect(String(res.failed.detail)).not.toContain('последняя ошибка')
    const failedRow = attempts.find((a: any) => a.outcome === 'failed')
    expect(String(failedRow.failureDetail)).not.toContain('последняя ошибка')
  })

  it('и доезжают до КАРТОЧКИ — той самой, что говорила только имя гейта', async () => {
    const adapter = oneTaskAdapter(stageTask({ kind: 'document', stage: 'plan', phase: 12 }))
    const { deps, attempts } = stageDeps({
      adapter,
      spawnWorker: makeSpawnWorker(undefined, {
        lines: [toolResult(KEY_ERROR), 'APPROACH_NOTE: спросил настройку пакетом'],
      }),
      deps: {
        fsImpl: makeFs({ [`${PHASE_DIR}/12-CONTEXT.md`]: 'ctx' }),
        execGit: makeGit({ '.planning/phases/12-front/12-CONTEXT.md': 'deadbee' }),
      },
    })

    await tick(deps)

    // Строка задачи, как её видит экран после того, как очередь исчерпала перевыдачи.
    const payload: any = await deriveState({
      adapter: { async list() { return [{ id: 'ST-1', title: 'стадия фазы', status: 'failed', failure_reason: 'no_artifact', attempt: 3, completedAt: new Date(0).toISOString() }] } },
      ledger: (id: string) => attempts.filter((a: any) => a.taskId === id),
      config: { workers: [], machineId: 'self' },
      clock: () => 0,
    })

    const card = payload.done.find((d: any) => d.id === 'ST-1')
    expect(card.failed.reasonLabel).toBe(REASON_LABELS['no_artifact'])
    expect(String(card.failed.detail)).toContain(KEY_ERROR)
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
    expect(order).toEqual(['worktree', 'spawn'])
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

// ═══ И СРЫВ ДОПИСЫВАЕТСЯ В ЕДИНЫЙ ЖУРНАЛ САМ ══════════════════════
//
// Смысл этих трёх случаев — не в том, что функция вызвана, а в том, что НИКТО НЕ ДОЛЖЕН
// ВСПОМИНАТЬ о журнале: задача сорвалась — строка появилась. Ровно этого не было у трёх
// прежних мест записи, каждое из которых знало про срыв свою половину.

describe('the tick writes the bug journal', () => {
  const bugDirs: string[] = []
  afterAll(() => {
    for (const d of bugDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it('reports the pass in its summary, and stays silent without the journal seams', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps } = makeDeps({ adapter, clockObj: c })

    const res = await tick(deps)
    expect(res.bugJournal).toEqual({ examined: 0, appended: 0, skipped: 0 })
  })

  it('a failed task the queue knows lands in the journal, with BOTH words about its cause', async () => {
    const c = mkClock()
    const dir = mkdtempSync(join(tmpdir(), 'sma-tick-bugs-'))
    bugDirs.push(dir)
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const attempts = [{ taskId: 'BL-7', attempt: 2, outcome: 'failed', failureReason: 'turns_exhausted' }]
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      deps: {
        // The queue says a person stopped it; the ledger says it had already walked into the
        // turn ceiling. The card shows the first word only — the journal keeps both.
        adapter: { ...adapter, list: async () => [{ id: 'BL-7', status: 'failed', project: 'sma', attempt: 2, failure_reason: 'manual' }] },
        ledger: {
          readAttempts: () => attempts,
          readBugs: () => readBugs(dir),
          appendBug: (entry: any) => appendBug(dir, entry),
        },
      },
    })

    const res = await tick(deps)

    expect(res.bugJournal).toMatchObject({ appended: 1 })
    expect(readBugs(dir)).toMatchObject([{ taskId: 'BL-7', reason: 'manual', cause: 'turns_exhausted', project: 'sma' }])
  })

  it('a bug-journal pass that throws is journaled and never wedges the tick (fail-open)', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      deps: {
        ledger: {
          readAttempts: () => [],
          readBugs: () => {
            throw new Error('журнал не читается')
          },
          appendBug: () => {
            throw new Error('журнал не пишется')
          },
        },
        adapter: {
          ...adapter,
          list: async () => {
            throw new Error('очередь молчит')
          },
        },
      },
    })

    const res = await tick(deps)
    // Обе двери прохода fail-open изнутри, поэтому тик получает честный ноль, а не исключение;
    // проверяется здесь именно то, что тик от этого не падает и не теряет своего шага.
    expect(res.bugJournal).toEqual({ examined: 0, appended: 0, skipped: 0 })
    expect(journalled.some((e: any) => e.type === 'tick-error')).toBe(false)
    expect(res.error).toBeUndefined()
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

/**
 * СТАРЕНИЕ ГОВОРИТСЯ ОДИН РАЗ НА ПЕРЕХОД, А СТРОКА ЖУРНАЛА НЕСЁТ МЕТКУ ВРЕМЕНИ.
 *
 * Замер живого журнала: за 12,34 часа демон написал 43 076 строк, из них 43 020 (99,87 %) —
 * одна и та же `task.aging`, повторённая каждые пять секунд на каждую залежавшуюся задачу.
 * Это не журнал, а шум, в котором тонет всё остальное; и ни одна из этих строк не несла
 * метки времени, хотя строки запускающей оболочки в том же файле её несут — два формата в
 * одном файле.
 *
 * Память дедупа — КОЛЛАБОРАТОР в deps, а не поле результата тика. Продевание состояния через
 * результат в production никем не замыкается (так уже вышло с intake: провод есть в тесте и
 * мёртв в жизни), а deps в main.mjs собираются ОДИН раз и живут столько же, сколько демон, —
 * поэтому память переживает тик, не делая тик состоянием.
 */
describe('старение: сказано один раз на переход, и строка несёт метку времени', () => {
  const stuckAdapter = (rows: any[]) => ({
    async list(filter: any = {}) {
      return filter.status ? rows.filter((r) => r.status === filter.status) : rows
    },
    async claimNext() {
      return null
    },
    async fail() {
      return true
    },
  })

  const aged = (id: string, hours: number, now: number) => ({
    id,
    title: id,
    lane: 'prod',
    status: 'queued',
    enqueuedAt: now - hours * 3600000,
  })

  it('два тика подряд с ОДНИМ объектом deps → ровно одна строка task.aging и один отчёт', async () => {
    const c = mkClock()
    const now = c.clock()
    const { deps, reports, journalled } = makeDeps({
      adapter: stuckAdapter([aged('BL-OLD', 30, now)]),
      clockObj: c,
      deps: { agingMemory: createAgingMemory() },
    })

    await tick(deps)
    c.advance(5000)
    await tick(deps)
    c.advance(5000)
    await tick(deps)

    expect(journalled.filter((e: any) => e.type === 'task.aging')).toHaveLength(1)
    expect(reports.filter((r: any) => r.event === 'task.aging')).toHaveLength(1)
  })

  it('прошли сутки — сказано снова: молчать вечно о застрявшей задаче тоже нельзя', async () => {
    const c = mkClock()
    const now = c.clock()
    const { deps, journalled } = makeDeps({
      adapter: stuckAdapter([aged('BL-OLD', 30, now)]),
      clockObj: c,
      deps: { agingMemory: createAgingMemory() },
    })

    await tick(deps)
    c.advance(23 * 3600000)
    await tick(deps)
    expect(journalled.filter((e: any) => e.type === 'task.aging')).toHaveLength(1) // сутки ещё не прошли
    c.advance(2 * 3600000)
    await tick(deps)
    expect(journalled.filter((e: any) => e.type === 'task.aging')).toHaveLength(2)
  })

  it('вторая залежавшаяся задача говорит о себе сама — дедуп по задаче, а не глобальный', async () => {
    const c = mkClock()
    const now = c.clock()
    const rows = [aged('BL-A', 30, now)]
    const { deps, journalled } = makeDeps({
      adapter: stuckAdapter(rows),
      clockObj: c,
      deps: { agingMemory: createAgingMemory() },
    })

    await tick(deps)
    rows.push(aged('BL-B', 40, now))
    c.advance(5000)
    await tick(deps)

    expect(journalled.filter((e: any) => e.type === 'task.aging').map((e: any) => e.taskId)).toEqual(['BL-A', 'BL-B'])
  })

  it('задача ушла из очереди и вернулась старой — это НОВЫЙ переход порога, и он сказан', async () => {
    const c = mkClock()
    const now = c.clock()
    const rows = [aged('BL-A', 30, now)]
    const { deps, journalled } = makeDeps({
      adapter: stuckAdapter(rows),
      clockObj: c,
      deps: { agingMemory: createAgingMemory() },
    })

    await tick(deps)
    rows.length = 0 // взята в работу: из «создано» ушла
    c.advance(5000)
    await tick(deps)
    rows.push(aged('BL-A', 31, now)) // вернулась — и всё ещё старая
    c.advance(5000)
    await tick(deps)

    expect(journalled.filter((e: any) => e.type === 'task.aging')).toHaveLength(2)
  })

  it('память дедупа не растёт вечно: ушедшее из очереди забывается', async () => {
    const c = mkClock()
    const now = c.clock()
    const rows = [aged('BL-A', 30, now), aged('BL-B', 30, now)]
    const memory: any = createAgingMemory()
    const { deps } = makeDeps({ adapter: stuckAdapter(rows), clockObj: c, deps: { agingMemory: memory } })

    await tick(deps)
    expect(memory.size).toBe(2)
    rows.length = 0
    c.advance(5000)
    await tick(deps)
    expect(memory.size).toBe(0)
  })

  it('без памяти в deps — прежнее поведение: строка на каждый тик (fail-open, старый контракт цел)', async () => {
    const c = mkClock()
    const now = c.clock()
    const { deps, journalled } = makeDeps({ adapter: stuckAdapter([aged('BL-OLD', 30, now)]), clockObj: c })

    await tick(deps)
    c.advance(5000)
    await tick(deps)

    expect(journalled.filter((e: any) => e.type === 'task.aging')).toHaveLength(2)
  })

  it('экран «застряла» от троттлинга не зависит: agedForHours считается из enqueuedAt', async () => {
    const c = mkClock()
    const now = c.clock()
    const rows = [aged('BL-OLD', 30, now)]
    const { deps, reports } = makeDeps({
      adapter: stuckAdapter(rows),
      clockObj: c,
      deps: { agingMemory: createAgingMemory() },
    })

    await tick(deps)
    c.advance(5000)
    await tick(deps) // об этом тике сигнал промолчал

    expect(reports.filter((r: any) => r.event === 'task.aging')).toHaveLength(1)
    const payload: any = await deriveState({
      adapter: { list: async () => rows },
      windows: () => ({}),
      config: { agingHours: 24, workers: [] },
      clock: c.clock,
    })
    const row = payload.queue.find((r: any) => r.id === 'BL-OLD')
    expect(row.agedForHours).toBeGreaterThanOrEqual(30) // показание живо и без сигнала
  })

  it('строка стока несёт ISO-метку, а за ней — прежние части описания события', () => {
    const line = tickJournalLine({ type: 'task.aging', taskId: 'BL-OLD', queuedForHours: 30 }, () => 1_700_000_000_000)
    expect(line).toMatch(/^\[SmaDaemon\] 20\d{2}-\d{2}-\d{2}T/)
    expect(line).toContain('task.aging')
    expect(line).toContain('task=BL-OLD')
    expect(line).toBe('[SmaDaemon] 2023-11-14T22:13:20.000Z task.aging · task=BL-OLD')
  })
})

/**
 * ═══════ УПОР В ПОТОЛОК ХОДОВ — ЭТО НЕ «ОШИБКА РАБОТНИКА» ═══════
 *
 * Работник, которому мы сами задали потолок ходов, останавливается на нём МОЛЧА: он не пишет
 * записки, не оставляет квитанции и выходит — ровно как оборванный провайдером, и ровно по той
 * же причине. До этого распознавателя такая попытка приходила на экран как «нет квитанции» или
 * «ошибка работника», то есть человека посылали чинить то, что мы ему сами и устроили.
 *
 * ПРИЗНАК БЕРЁТСЯ ИЗ ПОЛЯ КАДРА, НЕ ИЗ РЕЧИ. Работник, отлаживающий чужой потолок, произнесёт
 * фразу про исчерпание ходов вслух в собственном выводе — диагноз подслушиванием здесь запрещён
 * тем же законом, которым он запрещён у распознавателя обрыва провайдера.
 *
 * И ЗАПАСНОЙ ПРИЗНАК ОБЯЗАТЕЛЕН. Слово исхода — слово вендора, оно может смениться в следующей
 * версии его двоичного файла. Число сделанных ходов и заданный потолок — наша собственная
 * арифметика: потолок мы знаем потому, что сами его и передали запускаемому процессу.
 */
describe('turnCapHitOf — упор в потолок ходов, названный полем кадра', () => {
  const result = (o: object) => JSON.stringify({ type: 'result', ...o })

  it('слово исхода из закрытого перечисления CLI → упор, с числом сделанных ходов', () => {
    expect(turnCapHitOf([result({ subtype: 'error_max_turns', is_error: true, num_turns: 80 })])).toEqual({ turns: 80 })
  })

  it('берётся ПОСЛЕДНИЙ завершающий кадр потока: прогон, доигранный до успеха, упором не считается', () => {
    const lines = [
      result({ subtype: 'error_max_turns', is_error: true, num_turns: 80 }),
      result({ subtype: 'success', is_error: false, num_turns: 12 }),
    ]
    expect(turnCapHitOf(lines)).toBe(null)
    expect(turnCapHitOf([...lines].reverse())).toEqual({ turns: 80 })
  })

  it('поток без завершающего кадра и мусор на входе — пусто, без единого броска', () => {
    expect(turnCapHitOf(['не json вовсе', JSON.stringify({ type: 'assistant' })])).toBe(null)
    expect(turnCapHitOf([])).toBe(null)
    expect(turnCapHitOf(undefined as any)).toBe(null)
  })

  it('запасной признак: слово вендора незнакомо, но ходов не меньше ЗАДАННОГО НАМИ потолка', () => {
    const lines = [result({ subtype: 'error_ran_out_of_moves', is_error: true, num_turns: 80 })]
    expect(turnCapHitOf(lines, 80)).toEqual({ turns: 80 })
    // и он не срабатывает там, где ходов меньше потолка — это обычная ошибка, а не упор
    expect(turnCapHitOf([result({ subtype: 'error_during_execution', is_error: true, num_turns: 3 })], 80)).toBe(null)
  })

  it('без заданного потолка запасной признак молчит: сравнивать не с чем', () => {
    expect(turnCapHitOf([result({ subtype: 'error_ran_out_of_moves', is_error: true, num_turns: 999 })])).toBe(null)
  })

  it('кадр обрыва провайдера упором в потолок НЕ считается, сколько бы ходов на нём ни стояло', () => {
    const cut = result({ is_error: true, terminal_reason: 'api_error', api_error_status: 529, num_turns: 80 })
    expect(turnCapHitOf([cut], 80)).toBe(null)
  })
})

/**
 * ═══════ КОНЧИВШИЙСЯ КОНТЕКСТ — ТРЕТИЙ РАСХОД ПОПЫТКИ, КОТОРОГО ДЕМОН НЕ ВИДЕЛ ═══════
 *
 * Деньги и ходы демон читал с потока и называл своими словами; МЕСТО — не читал вовсе. Попытка,
 * у которой переполнилось окно, доигрывала на пересказе собственного контекста и заканчивалась
 * без квитанции и без записки, то есть выглядела ровно как плохая работа.
 *
 * ПРИЗНАК — ПОЛЕ КАДРА, А НЕ РЕЧЬ, ровно как у двух соседних распознавателей: работник, вслух
 * обсуждающий компактификацию, не должен становиться от этого переполненным.
 */
describe('contextExhaustedOf — переполнение окна, названное кадром CLI', () => {
  const compact = (meta: object | null, extra: object = {}) =>
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', ...extra, ...(meta ? { compact_metadata: meta } : {}) })

  it('автоматическое сжатие → переполнение, со счётом сжатий и самым большим окном', () => {
    const lines = [
      compact({ trigger: 'auto', pre_tokens: 120_000 }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude', content: [] } }),
      compact({ trigger: 'auto', pre_tokens: 151_000 }),
    ]
    expect(contextExhaustedOf(lines)).toEqual({ compactions: 2, preTokens: 151_000 })
  })

  it('РУЧНОЕ сжатие не считается: это решение работника, а не конец места', () => {
    expect(contextExhaustedOf([compact({ trigger: 'manual', pre_tokens: 90_000 })])).toBe(null)
  })

  it('сжатие без названного повода не считается тоже — неназванное поле не улика', () => {
    expect(contextExhaustedOf([compact(null)])).toBe(null)
    expect(contextExhaustedOf([compact({ pre_tokens: 90_000 })])).toBe(null)
  })

  it('окно ДЕЛЕГИРОВАННОЙ сессии — не окно этой попытки', () => {
    expect(contextExhaustedOf([compact({ trigger: 'auto', pre_tokens: 140_000 }, { parent_tool_use_id: 'toolu_01' })])).toBe(null)
  })

  it('размер окна — необязательная часть ответа: без него сжатие всё равно сжатие', () => {
    expect(contextExhaustedOf([compact({ trigger: 'auto' })])).toEqual({ compactions: 1, preTokens: null })
  })

  it('речь работника о компактификации признаком НЕ является', () => {
    const said = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude', content: [{ type: 'text', text: 'context low, compact_boundary trigger auto' }] },
    })
    expect(contextExhaustedOf([said])).toBe(null)
  })

  it('поток без кадров сжатия и мусор на входе — пусто, без единого броска', () => {
    expect(contextExhaustedOf(['не json вовсе', JSON.stringify({ type: 'system', subtype: 'init' })])).toBe(null)
    expect(contextExhaustedOf([])).toBe(null)
    expect(contextExhaustedOf(undefined as any)).toBe(null)
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
   * КРАСНОЕ ОТ СРЕДЫ, А НЕ ОТ ВЕТКИ — И ЭТО РАЗНЫЕ ПОЧИНКИ, ПОЭТОМУ РАЗНЫЕ СЛОВА.
   *
   * 31.08.2026 склад зависимостей основного дерева опустошался трижды за сутки, и каждая
   * попытка закрывалась как «тесты красные»: работника отправляли искать регрессию, которой
   * нет, пока чинить надо было среду — одну на всех, в другом дереве и другой рукой.
   * `env_broken` стоит ВЫШЕ `tests_red` ровно поэтому и ждёт человека: перевыдача встретит
   * тот же пустой склад.
   */
  it('красная перепроверка на дереве без зависимостей → env_broken, а не tests_red', () => {
    expect(
      classifyFailure({ exitCode: 0, receipt: { verdict: 'red', ref: 'reverify:red' }, envUnfit: 'среда сломана: daemon — каталог зависимостей daemon/node_modules ПУСТ' }),
    ).toBe('env_broken')
  })

  /**
   * ВОПРОС ЗАДАЁТСЯ ТОЛЬКО ПОВЕРХ КРАСНОГО. Зелёная перепроверка сама доказала, что среде
   * было на чём запуститься, а попытка без квитанции не запускала тестов вовсе — обвинять
   * среду там значило бы прятать настоящую причину за поломкой, которой в этот раз не было.
   */
  it('среда не называется причиной там, где красного прогона не было', () => {
    const unfit = 'среда сломана: . — каталог зависимостей node_modules ПУСТ'
    expect(classifyFailure({ exitCode: 0, receipt: { verdict: 'green', ref: 'r' }, journalComplete: false, envUnfit: unfit })).not.toBe('env_broken')
    expect(classifyFailure({ exitCode: 1, receipt: null, envUnfit: unfit })).toBe('agent_error')
    expect(classifyFailure({ exitCode: 0, receipt: null, envUnfit: unfit })).toBe('no_receipt')
  })

  it('маркер работника сильнее сломанной среды — он назвал причину точнее', () => {
    expect(
      classifyFailure({ exitCode: 1, receipt: { verdict: 'red', ref: 'r' }, envUnfit: 'среда сломана: …', workerMarker: 'NEEDS_DECISION' }),
    ).toBe('needs_decision')
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

  /**
   * ПОТОЛОК СТОИТ ТАМ ЖЕ, ГДЕ ОБРЫВ, И ПО ТОЙ ЖЕ ПРИЧИНЕ: попытка, срезанная на потолке, не
   * написала записки и не оставила квитанции ровно потому, что её остановили, — обвинять её в
   * этом нельзя. Выше — только то, чего мы не устраивали: несостоявшийся запуск и отказ вендора.
   */
  it('упор в потолок → turns_exhausted, а не «нет квитанции»', () => {
    expect(classifyFailure({ turnCapHit: { turns: 80 }, exitCode: 0, receipt: null })).toBe('turns_exhausted')
  })

  it('упор в потолок сильнее суждений о том, что попытка оставила: ни записки, ни квитанции с неё не спрашивают', () => {
    expect(
      classifyFailure({
        turnCapHit: { turns: 80 },
        exitCode: 1,
        receipt: { verdict: 'green', ref: 'r' },
        journalComplete: false,
      }),
    ).toBe('turns_exhausted')
  })

  /**
   * КОД ВЫХОДА В ПРИЗНАК НЕ ВХОДИТ. Чем именно завершается двоичный файл вендора при упоре в
   * потолок, мы не проверяли ни разу; ветка обязана давать один и тот же ответ при нулевом и
   * ненулевом коде, иначе непроверенное число тихо станет частью диагноза.
   */
  it('ответ один и тот же при нулевом и ненулевом коде выхода', () => {
    const zero = classifyFailure({ turnCapHit: { turns: 80 }, exitCode: 0, receipt: null })
    const nonzero = classifyFailure({ turnCapHit: { turns: 80 }, exitCode: 7, receipt: null })
    expect(zero).toBe(nonzero)
    expect(zero).toBe('turns_exhausted')
  })

  it('но обрыв провайдера остаётся сильнее потолка — порядок ветвей соблюдён', () => {
    expect(classifyFailure({ providerAbort: { status: 529 }, turnCapHit: { turns: 80 }, exitCode: 1 })).toBe('provider_error')
    expect(classifyFailure({ spawnError: new Error('offline'), turnCapHit: { turns: 80 } })).toBe('runtime_offline')
  })

  /**
   * ПЕРЕПОЛНЕННОЕ ОКНО СТОИТ НАМНОГО НИЖЕ ПОТОЛКА, И РАССТОЯНИЕ МЕЖДУ НИМИ — ЭТО И ЕСТЬ
   * СУЖДЕНИЕ. Сжатие не терминальное событие: прогон идёт дальше, — поэтому «окно наполнилось»
   * никогда не доказывает, что попытку остановили, и не смеет отменять то, что она ОСТАВИЛА.
   * Где не оставлено ничего, это самое точное, что о таком конце можно честно сказать.
   */
  it('нечего судить + переполненное окно → context_exhausted, а не «ошибка работника»', () => {
    expect(classifyFailure({ contextExhausted: { compactions: 2 }, exitCode: 1, receipt: null })).toBe('context_exhausted')
    expect(classifyFailure({ contextExhausted: { compactions: 2 }, exitCode: 0, receipt: null })).toBe('context_exhausted')
  })

  it('но всё, что попытка оставила, сильнее переполненного окна', () => {
    const ctx = { compactions: 3 }
    expect(classifyFailure({ contextExhausted: ctx, exitCode: 1, receipt: { verdict: 'red', ref: 'r' } })).toBe('tests_red')
    expect(classifyFailure({ contextExhausted: ctx, exitCode: 1, workerMarker: 'NEEDS_DECISION' })).toBe('needs_decision')
    expect(
      classifyFailure({ contextExhausted: ctx, exitCode: 0, receipt: { verdict: 'green', ref: 'r' }, journalComplete: false }),
    ).toBe('no_journal')
  })

  it('и всё, что остановило прогон снаружи, сильнее тоже — порядок ветвей соблюдён', () => {
    const ctx = { compactions: 3 }
    expect(classifyFailure({ contextExhausted: ctx, turnCapHit: { turns: 80 }, receipt: null })).toBe('turns_exhausted')
    expect(classifyFailure({ contextExhausted: ctx, providerAbort: { status: 529 }, receipt: null })).toBe('provider_error')
    expect(classifyFailure({ contextExhausted: ctx, spawnError: new Error('offline') })).toBe('runtime_offline')
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

/**
 * ═══════ ОБРЫВ ПОСТАВЩИКА НЕ БЫВАЕТ «СДЕЛАНО» — И НЕ ПРОПАДАЕТ ИЗ ВИДУ ═══════
 *
 * ЗАМЕР 30.08.2026, живой самотёк, две задачи подряд: в 19:02 и 19:03 UTC поставщик оборвал
 * два прогона одной причиной (`api_error 429: You've hit your session limit`). Демон честно
 * назвал обрыв в своём журнале — и обе строки ушли в `done`. Работы не было сделано никакой:
 * квитанция у обеих оказалась ВЫВЕДЕННОЙ (`unverified`), то есть посчитанной из числа
 * коммитов на ветке, а не заработанной перепроверкой. С доски они исчезли совсем — «сделано»
 * не ждёт приёмки так, как ждёт её красная строка, — и человек о потере не узнал.
 *
 * ДВЕ ПОЛОВИНЫ ЗАКОНА, И ОБЕ ЗДЕСЬ:
 *   · выведенная квитанция у оборванного прогона не считается ничем: ничего не заверено, а
 *     число коммитов у прогона, который не начинался, — это чужие коммиты вершины;
 *   · перепроверка, ДЕЙСТВИТЕЛЬНО прогнавшая ветку зелёной, остаётся зачтённой, кто бы ни
 *     закрыл сессию: отказать ей значило бы выбросить подтверждённую работу и оплатить её
 *     заново. Этот случай стоит ниже рядом с первыми — иначе починка «на всякий случай»
 *     съела бы соседний закон, и никто бы этого не заметил.
 *
 * И ТРЕТЬЕ: журнал срывов узнаёт об обрыве В МОМЕНТ события. Метла (шаг 1c) видит только то,
 * что очередь САМА называет сорвавшимся, а срыв поставщика — конец ПЕРЕВЫДАВАЕМЫЙ: строка
 * возвращается в очередь как ожидающая, и метле она не видна вовсе, пока не кончатся
 * перевыдачи. Замерено 30.08: строки о двух обрывах не было в журнале и через 40 минут.
 */
describe('обрыв поставщика: не «сделано», и журнал срывов узнаёт сразу', () => {
  // Кадр из живого прогона 30.08: лимит сессии, CLI закончил прогон своей ошибкой.
  const PROVIDER_429 = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 429,
    result: "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"You've hit your session limit\"}}",
    session_id: 's-429',
  })
  const NOTE = 'APPROACH_NOTE: прямой путь'

  /**
   * Попытка, у которой ЕСТЬ и записка, и слово об уроке, — то есть все условия двери «сделано»,
   * кроме заработанной квитанции, — оборванная поставщиком на завершающем кадре.
   */
  const runAborted = async (reverify: any) => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const bugs: any[] = []
    const attempts: any[] = []
    const { deps } = makeDeps({
      adapter,
      responses: DIFF_RESPONSES(reverify),
      spawnWorker: makeSpawnWorker(undefined, { lines: ['stream line', NOTE, PROVIDER_429], code: 1 }),
      deps: {
        execGit: makeGateGit(),
        ledger: {
          recordAttempt: (a: any) => {
            attempts.push(a)
            return a
          },
          readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
          appendBug: (b: any) => {
            bugs.push(b)
            return b
          },
          readBugs: () => bugs,
        },
      },
    })
    const res = await tick(deps)
    return { res, adapter, bugs, attempts }
  }

  /** Снимок с историческим расхождением: до попытки и после неё он один и тот же. */
  const stale = answer([rec('R-A', 'divergent')])

  it('дерево без рецептов: квитанция ВЫВЕДЕНА из коммитов → не done, а provider_error', async () => {
    const { res, adapter } = await runAborted(inTurn([answer([]), answer([])]))

    expect(res.completed).toBeUndefined()
    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'provider_error' })
    expect(adapter.calls.map((c: any) => c.op)).toEqual(['fail'])
  })

  it('снимки совпали: та же выведенная квитанция у оборванного прогона → provider_error', async () => {
    const { res, adapter } = await runAborted(inTurn([stale, stale]))

    expect(res.completed).toBeUndefined()
    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'provider_error' })
    expect(adapter.calls[0]).toMatchObject({ op: 'fail', reason: 'provider_error' })
  })

  it('строка не пропадает тихо: конец перевыдаваемый, и подпись называет поставщика словами', async () => {
    const { res } = await runAborted(inTurn([stale, stale]))

    expect(res.failed?.reason).toBe('provider_error')
    // Перевыдаваемый конец = строка возвращается в очередь, а не закрывается «ждёт человека».
    expect(failureAwaitsAPerson('provider_error')).toBe(false)
    expect(REASON_LABELS.provider_error).toMatch(/провайдер/i)
  })

  it('журнал срывов получает строку В МОМЕНТ обрыва — метла тут ни при чём', async () => {
    const { bugs } = await runAborted(inTurn([stale, stale]))

    expect(bugs).toHaveLength(1)
    expect(bugs[0]).toMatchObject({
      taskId: 'BL-1',
      attempt: 1,
      reason: 'provider_error',
      cause: 'provider_error',
      // Кто дописал строку — сказано полем, а не выведено из формы: у метлы своё слово.
      source: 'live',
    })
    // Очередь этой попытки метле не показывала вовсе (`list` пуст) — строка пришла от двери.
    expect(bugs[0].endedAt).toEqual(expect.any(String))
  })

  it('журнал, которого нет, не стоит задаче ничего: реестр без двери срывов — не отказ', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({
      adapter,
      responses: DIFF_RESPONSES(inTurn([stale, stale])),
      spawnWorker: makeSpawnWorker(undefined, { lines: ['stream line', NOTE, PROVIDER_429], code: 1 }),
      deps: { execGit: makeGateGit() }, // реестр по умолчанию — без appendBug
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'provider_error' })
  })

  /**
   * СОСЕДНИЙ ЗАКОН НЕ СЪЕДЕН. Ветка, которую перепроверка прогнала зелёной и выдала на неё
   * СВОЮ квитанцию, — законченная работа, кто бы ни закрыл сессию следом. Починка выше режет
   * ровно выведенную квитанцию, и этот случай — граница между ними.
   */
  it('перепроверка выдала СВОЮ квитанцию → работа остаётся сделанной, кто бы ни закрыл сессию', async () => {
    const { res, adapter, bugs } = await runAborted(GREEN_REVERIFY)

    expect(res.completed).toBe('BL-1')
    expect(adapter.calls[0]).toMatchObject({ op: 'complete' })
    expect(bugs).toEqual([]) // сорвавшейся эта попытка не была — и в журнале срывов ей не место
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

  /**
   * ═══════ ЧТО ИМЕННО ТИК РЕШАЕТ ПРО ПРОБУЖДЕНИЕ ═══════
   *
   * Возврат человека и пробуждение по времени приходят на тик НЕОТЛИЧИМЫМИ на первый взгляд:
   * вторая попытка той же задачи, и в леджере записана сессия первой. До этой пары дел обе шли
   * одним и тем же путём продолжения — условие смотрело только на номер попытки. Между тем
   * разница смысловая: человек вернул работу с замечанием, и работник обязан помнить, что
   * делал, — контекст уже оплачен, а поправка должна лечь в голову, которая ещё помнит, о чём
   * речь; таймер же будит задачу спустя время, и старая сессия несёт картину мира, которая к
   * этому моменту уже неверна.
   *
   * ЗДЕСЬ ПРОВЕРЯЕТСЯ РЕШЕНИЕ ТИКА, А НЕ КОМАНДНАЯ СТРОКА, и это сказано прямо, чтобы никто не
   * принял эти два дела за сквозной прогон. Провод состоит из двух звеньев, и у каждого своё
   * место: тик → опции спавна (здесь, настоящим тиком) и опции → массив аргументов (сьют
   * композитора, настоящим композитором и настоящим строителем). Подделки нет ни в одном из
   * двух звеньев; настоящий запуск с настоящим массивом аргументов читается уже с диска, живым
   * прогоном, а не сьютом.
   *
   * Свежесть таймера обеспечена НЕ вторым условием, а тем, что вид пробуждения доезжает до
   * строителя, где замок на этот случай написан, брошен явной ошибкой и проверен давно.
   */
  const wakeDecisionOf = async (over: any, ledgerRow: any) => {
    const ledgerDir = mkDir('sma-loop-wake-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const seen: any[] = []
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: (spec: any) => {
        spec.onLine?.('APPROACH_NOTE: продолжил')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
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
    deps.ledger.recordAttempt(ledgerRow)
    await adapter.enqueue(backlogTask({ attempt: 2, ...over }))
    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')
    return seen[0]
  }

  it('a RETURNED task’s next attempt resumes the prior session — the paid-for context survives', async () => {
    const opts = await wakeDecisionOf(
      { source: 'return' },
      { taskId: 'BL-1', attempt: 1, outcome: 'returned', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    )
    expect(opts.wakeKind).toBe('return')
    expect(opts.resumeId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('а задача, разбуженная по времени, продолжения не получает — даже когда сессия в леджере есть', async () => {
    // Та же запись прошлой сессии, та же вторая попытка. Отличается ровно одно слово: строку
    // вернул в очередь не человек, а истёкшая аренда.
    const opts = await wakeDecisionOf(
      {},
      { taskId: 'BL-1', attempt: 1, outcome: 'failed', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    )
    expect(opts.wakeKind).toBe('timer')
    expect(opts.resumeId).toBeUndefined()
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

  it('кадр init доезжает до файла ЦЕЛЫМ, а длинная обычная строка обрезана И помечена — провод, не расчёт', async () => {
    const ledgerDir = mkDir('sma-loop-log-')
    // Кадр init настоящей сессии — это список инструментов и подключений; он спокойно
    // перерастает 4096 и до этой правки резался молча ровно там, где его и читают.
    const bigInit = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '9f8e7d6c-1234-4abc-8def-0123456789ab',
      model: 'claude-opus-4-8',
      tools: Array.from({ length: 400 }, (_, i) => `Tool_${i}_${'x'.repeat(20)}`),
    })
    expect(bigInit.length).toBeGreaterThan(4096)
    const longPlain = 'p'.repeat(9000) // обычный вывод работника: потолок прежний, но молчать он перестал

    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: makeSpawnWorker(undefined, {
        lines: [
          bigInit,
          longPlain,
          'APPROACH_NOTE: прямой путь',
          JSON.stringify({ type: 'result', is_error: false, session_id: '9f8e7d6c-1234-4abc-8def-0123456789ab' }),
        ],
      }),
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: GREEN_REVERIFY,
      },
      deps: { ledger: realLedger(ledgerDir) },
    })

    await tick(deps)

    const log = readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#1' })
    const init = log.entries.find((e: any) => e.line.includes('"subtype":"init"'))
    expect(init.line).toHaveLength(bigInit.length) // цел, а не 4096
    expect(init.truncated).toBeUndefined()

    const plain = log.entries.find((e: any) => e.line.startsWith('ppp'))
    expect(plain.line).toHaveLength(4096) // потолок обычной строки НЕ поднят
    expect(plain.truncated).toBe(true) // но обрезка больше не молчит
    expect(plain.originalLength).toBe(9000)

    const result = log.entries.find((e: any) => e.line.includes('"type":"result"'))
    expect(result.truncated).toBeUndefined()
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

/**
 * ═══════ ПОТРЕБЛЕНИЕ ПОПРАВКИ — В МОМЕНТ ДОСТАВКИ, И НИКОГДА РАНЬШЕ ═══════
 *
 * Обещание хранилища поправок сформулировано словами: «поправка пишется на диск ПЕРВОЙ,
 * чтобы перезапуск её не потерял». Цикл продолжения это обещание нарушал ровно наоборот —
 * помечал строки употреблёнными, а ПОТОМ выяснял, есть ли чем их доставить. Для попытки
 * исполнителя без канала возобновления и на пределе прыжков слово основателя съедалось
 * молча: записали на диск, а потом сами же и уничтожили.
 *
 * Случаи ниже утверждают ПОРЯДОК, а не сумму. Каждый из них КРАСНЕЕТ, если порядок вернуть
 * обратно, — тест, зелёный при обоих порядках, не утверждает ничего. И каждый смотрит на
 * то, что доехало до АРГУМЕНТОВ ЗАПУСКА, а не на промежуточную строку: доставка, доказанная
 * вычислением, — ровно класс «вычислено, но не подключено».
 */
describe('поправка потребляется только тогда, когда её есть чем доставить', () => {
  const tmpDirs: string[] = []
  const mkDir = (prefix = 'sma-loop-order-') => {
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

  const RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
    reverify: GREEN_REVERIFY,
  }

  const TASK_PROMPT = 'сделай дело'
  const SESSION = '11111111-2222-4333-8444-555555555555'
  const INIT_FRAME = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })

  /**
   * ДВА ЛЕЙНА, ОДНО РАЗЛИЧИЕ — БИНАРЬ. Живой сборщик аргументов различает ровно это: сторонний
   * вендор идёт своим CLI, всё остальное — нашим (`runner/build-args.mjs`, выбор по провайдеру).
   * Подделке сборщика больше знать неоткуда и незачем: цикл смотрит на `spec.bin` и ни на что
   * ещё, поэтому богаче живой библиотеки она здесь быть не может.
   */
  const lane = (bin: string) => () => ({ bin, args: bin === 'codex' ? ['exec', '--json'] : ['--print', '-'], env: {}, prompt: TASK_PROMPT })

  /** Запись `done` в файле поправок — единственный след потребления; её отсутствие проверяемо. */
  const doneMarks = (dataDir: string, taskId: string) =>
    readFileSync(redirectFileOf({ dataDir, taskId }) as string, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r: any) => r && r.kind === 'done')

  it('(а) слово исполнителю без канала НЕ СЪЕДЕНО: доставить нечем — значит и потреблять нечего', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    // Слово прилетает в ОКНО МЕЖДУ запуском и выходом — процесс ещё жив, задание уже прочитано.
    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
      appendRedirect({ dataDir, taskId: 'BL-1', text: 'стой, не трогай подвал', mode: 'steer', clock: c.clock })
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }

    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      config: { dataDir },
      responses: RESPONSES,
      deps: { buildArgs: lane('codex') },
    })

    await tick(deps)

    // СТРОКА ЖДЁТ. Её никто не доставил — значит никто не имел права её съесть.
    const pending = readPendingRedirects({ dataDir, taskId: 'BL-1' })
    expect(pending).toHaveLength(1)
    expect(pending[0].text).toContain('не трогай подвал')
    expect(doneMarks(dataDir, 'BL-1')).toEqual([])
    // И потеря не молчалива: пропуск записан с причиной ПО ИМЕНИ.
    const skipped = journalled.filter((e: any) => e.type === 'task.redirect_skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toBe('provider')
    expect(spawns).toHaveLength(1) // возобновлять нечем — второго запуска не было
  })

  it('(б) предел прыжков НЕ ЕСТ: последняя поправка остаётся ждать, а не гибнет на пороге', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    // Основатель правит без остановки: каждый запуск застаёт новое слово, и цикл упирается в предел.
    let n = 0
    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      n += 1
      spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
      appendRedirect({ dataDir, taskId: 'BL-1', text: `поправка ${n}`, mode: 'queue', clock: c.clock })
      c.advance(1)
      spec.onLine?.(INIT_FRAME)
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }

    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      config: { dataDir },
      responses: RESPONSES,
      deps: { buildArgs: lane('claude') },
    })

    await tick(deps)

    const skipped = journalled.filter((e: any) => e.type === 'task.redirect_skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].reason).toBe('hop_cap')
    // Слово, до которого прыжков не хватило, ЖДЁТ следующего захода задачи.
    const pending = readPendingRedirects({ dataDir, taskId: 'BL-1' })
    expect(pending).toHaveLength(1)
    expect(pending[0].text).toBe(`поправка ${n}`)
  })

  it('(в) слово для исполнителя без канала ДОЕЗЖАЕТ В САМОМ ЗАДАНИИ следующего захода', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    // ОБЕ судьбы, посланные задаче ДО первой попытки: «после хода» и слово живому ходу. Вторая —
    // единственный замок на судьбу steer-строки, адресованной работнику на чужом лейне: калитки
    // у него нет, поэтому подобрать её может только задание следующего захода.
    appendRedirect({ dataDir, taskId: 'BL-1', text: 'правь шапку, не подвал', mode: 'queue', clock: c.clock })
    c.advance(1)
    appendRedirect({ dataDir, taskId: 'BL-1', text: 'и сборку не трогай', mode: 'steer', clock: c.clock })

    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }

    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      config: { dataDir },
      responses: RESPONSES,
      deps: { buildArgs: lane('codex') },
    })

    await tick(deps)

    expect(spawns).toHaveLength(1)
    // ГРАНТ ДОЕХАЛ ДО АРГУМЕНТОВ ЗАПУСКА — до того самого текста, который получил запускатель.
    expect(spawns[0].prompt).toContain(TASK_PROMPT) // задание не подменено, слово ДОПИСАНО
    expect(spawns[0].prompt).toContain(
      correctionsPreamble([{ text: 'правь шапку, не подвал' }, { text: 'и сборку не трогай' }]),
    )
    // И только теперь строки употреблены — ровно один раз, обе.
    expect(readPendingRedirects({ dataDir, taskId: 'BL-1' })).toEqual([])
    expect(doneMarks(dataDir, 'BL-1')).toHaveLength(2)
    // Журнал называет КАНАЛ, которым слово доехало.
    const delivered = journalled.filter((e: any) => e.type === 'task.redirected')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].delivery).toBe('prompt')
    // Пропуска нет: слово доставлено, жаловаться не на что.
    expect(journalled.filter((e: any) => e.type === 'task.redirect_skipped')).toEqual([])
  })

  it('(в2) СТАРТ-ПРОВАЛ не ест: задание собрано, но процесс не поднялся — слово осталось ждать', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    appendRedirect({ dataDir, taskId: 'BL-1', text: 'правь шапку, не подвал', mode: 'queue', clock: c.clock })
    c.advance(1)
    appendRedirect({ dataDir, taskId: 'BL-1', text: 'и сборку не трогай', mode: 'steer', clock: c.clock })

    // «Программу не удалось запустить» — вторая дорога провала: не бросок, а onError.
    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ prompt: String(spec.prompt ?? '') })
      spec.onError?.(new Error('spawn ENOENT'))
      return { pid: null, kill: () => {} }
    }

    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      config: { dataDir },
      responses: RESPONSES,
      deps: { buildArgs: lane('codex') },
    })

    const res = await tick(deps)
    expect(res.failed?.reason).toBe('runtime_offline') // процесса не было — это его судьба

    // Строку СОБРАЛИ, но никто её не прочитал: потребление привязано к прочитанному заданию.
    expect(spawns[0].prompt).toContain('правь шапку, не подвал')
    expect(readPendingRedirects({ dataDir, taskId: 'BL-1' })).toHaveLength(2)
    expect(doneMarks(dataDir, 'BL-1')).toEqual([])
  })

  /**
   * ═══ «ПЕРЕБИТЬ СЕЙЧАС» ПО РАБОТНИКУ БЕЗ КАНАЛА: УБИЛИ ХОД — ЗНАЧИТ ВЕРНИТЕ ЗАДАЧУ ═══
   *
   * Замерено 01.09: дверь по задаче стороннего вендора ответила {accepted:true, live:true},
   * ход был убит, а в журнале осталось `redirect_skipped · provider` — перевыдачи не было, и
   * задача умерла пустой. Снаружи это неотличимо от доставки: человек сказал слово, получил
   * «принято» и не получил ничего. Дело красное ровно на этом: исход «принято + пропуск»
   * запрещён, у слова обязана быть дорога, и дорога у него одна — ЗАДАНИЕ СЛЕДУЮЩЕГО ЗАХОДА.
   *
   * ДВЕРЬ ЗДЕСЬ НЕ ПОДДЕЛАНА ПО СУЩЕСТВУ: она делает ровно две вещи (пишет слово в то самое
   * хранилище и дёргает ту самую ручку из реестра попыток), и обе делаются настоящими —
   * `appendRedirect` и `createTurnRegistry`, тот же реестр, который цикл потом и спрашивает.
   */
  it('(г) «перебить сейчас» по работнику без канала: ход оборван — задача возвращается, записка едет в задании', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const attemptTurns = createTurnRegistry()

    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
      if (spawns.length === 1) {
        // ДВЕРЬ СРАБАТЫВАЕТ ПО ЖИВОМУ РЕБЁНКУ — после того, как ручка попала в реестр (это
        // делает `steeredSpawn` уже ПОСЛЕ возврата отсюда), поэтому выстрел откладывается.
        setTimeout(() => {
          appendRedirect({ dataDir, taskId: 'BL-1', text: 'стой, не трогай подвал', mode: 'interrupt', clock: c.clock })
          attemptTurns.stop('BL-1')
        }, 0)
        return { pid: 1, kill: () => spec.onExit?.({ code: 143, signal: 'SIGTERM' }) }
      }
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }

    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      config: { dataDir },
      responses: RESPONSES,
      deps: { buildArgs: lane('codex'), attemptTurns },
    })

    const first = await tick(deps)

    // (1) ИСХОД НАЗВАН СЛОВАМИ, И ЭТО НЕ ПРОПУСК. Пропуск здесь запрещён: он означал бы
    // «слово потеряно молча», а слово поедет.
    expect(journalled.filter((e: any) => e.type === 'task.redirect_skipped')).toEqual([])
    const deferred = journalled.filter((e: any) => e.type === 'task.redirect_deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0].delivery).toBe('next_run')
    expect(deferred[0].detail).toContain('следующего захода')

    // (2) ПОПЫТКА КОНЧИЛАСЬ ПЕРЕВЫДАВАЕМЫМ КОНЦОМ СО СВОИМ СЛОВОМ — не «нет квитанции» и не
    // «ошибка работника»: работу не сломали, её прервали.
    expect(first.failed?.reason).toBe('redirect_restart')
    expect(FAIL_REASONS).toContain('redirect_restart')
    expect(failureAwaitsAPerson('redirect_restart')).toBe(false) // за этим концом стоит попытка, а не человек
    expect(REASON_LABELS.redirect_restart).toContain('перевыдана')

    // (3) СЛОВО ЦЕЛО: доставить его было нечем, значит и потреблять было нечего.
    expect(readPendingRedirects({ dataDir, taskId: 'BL-1' })).toHaveLength(1)
    expect(doneMarks(dataDir, 'BL-1')).toEqual([])

    // ═══ И ДОСТАВКА, ИЗМЕРЕННАЯ НА АРГУМЕНТАХ СЛЕДУЮЩЕГО ЗАПУСКА ═══
    c.advance(AUTO_RETRY_BASE_MS + 1000) // пауза автоповтора — она же граница «не долбить»
    await tick(deps)

    expect(spawns).toHaveLength(2) // перевыдача СОСТОЯЛАСЬ
    expect(spawns[1].prompt).toContain(TASK_PROMPT) // задание не подменено, слово ДОПИСАНО
    expect(spawns[1].prompt).toContain(correctionsPreamble([{ text: 'стой, не трогай подвал' }]))
    expect(readPendingRedirects({ dataDir, taskId: 'BL-1' })).toEqual([]) // употреблено ровно теперь
    expect(doneMarks(dataDir, 'BL-1')).toHaveLength(1)
    const delivered = journalled.filter((e: any) => e.type === 'task.redirected')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].delivery).toBe('prompt')
  })

  it('(д) слово ЖИВОМУ ходу, которого ход не подобрал, подбирает продолжение — та же сессия', async () => {
    const c = mkClock()
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    // Ход не сделал ни одного вызова инструмента — калитка внутри работника слова не увидела.
    appendRedirect({ dataDir, taskId: 'BL-1', text: 'вернись к шапке', mode: 'steer', clock: c.clock })

    const spawns: any[] = []
    const spawnWorker = (spec: any) => {
      spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
      spec.onLine?.(INIT_FRAME)
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }

    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker,
      config: { dataDir },
      responses: RESPONSES,
      deps: { buildArgs: lane('claude') },
    })

    await tick(deps)

    expect(spawns).toHaveLength(2)
    const resumeAt = spawns[1].args.indexOf('--resume')
    expect(resumeAt).toBeGreaterThan(-1)
    expect(spawns[1].args[resumeAt + 1]).toBe(SESSION) // ТА ЖЕ сессия, ничего не начато с нуля
    // ОДНА ФОРМА СЛОВ: записка собрана производителем из модуля поправок, а не второй склейкой.
    expect(spawns[1].prompt).toBe(correctionsPreamble([{ text: 'вернись к шапке' }]))
    expect(readPendingRedirects({ dataDir, taskId: 'BL-1' })).toEqual([])
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

  /**
   * A git that ANSWERS THE QUESTION IT WAS ASKED — and refuses to answer one it does not model.
   *
   * Its predecessor looked at the VERB alone and handed the same number back for every
   * `rev-list`, whichever two points the caller named. That is precisely why a gate counting
   * from the wrong anchor stayed invisible to a green suite: the fake could not tell «commits
   * this branch has that the tip of the connected project does not» from «commits this attempt
   * put on top of the base the copy was cut from», so two opposite questions shared one answer
   * and the defect had nowhere to show itself. A fake that knows more than the live library is
   * the same class of lie that once hid a call to a method no real object had.
   *
   * Hence: the revision questions are matched by their ARGUMENTS and answer separately, and a
   * question this fake never modelled is RECORDED and thrown on. The recording is what reaches
   * the assertion — production catches throws on purpose (fail-safe), so a thrown error on its
   * own would be swallowed and read as «nothing happened». Cases assert `unanswered` is empty,
   * so an unmodelled question fails the case with the question printed instead of quietly
   * answering zero.
   */
  const makeAnswerGit = ({
    base = 'base0',
    fromBase = '0',
    fromProjectHead = '0',
    dirty = '',
    throwOn = '',
    answersIn = '',
  }: {
    base?: string
    fromBase?: string
    fromProjectHead?: string
    dirty?: string
    throwOn?: string
    answersIn?: string
  } = {}) => {
    const asked: { verb: string; args: string[]; cwd?: string }[] = []
    const unanswered: string[] = []
    return Object.assign(
      (args: string[], opts?: any) => {
        const verb = args[0]
        asked.push({ verb, args, cwd: opts && opts.cwd })
        if (verb === throwOn) throw new Error(`git ${verb} unavailable`)
        // A REVISION IS ONLY A REVISION IN THE TREE THAT HAS IT — the live failure mode behind
        // the placement cases: ask any other directory and git simply exits non-zero.
        if (answersIn && (verb === 'rev-list' || verb === 'rev-parse') && (!opts || opts.cwd !== answersIn)) {
          throw new Error(`unknown revision — asked in ${(opts && opts.cwd) || 'nowhere'}, resolvable only in ${answersIn}`)
        }
        // where the tree being asked stands right now — how a copy learns its own base when
        // the provisioning verb declined to name one
        if (verb === 'rev-parse') return base
        // WHERE THE BRANCH WAS CUT. The receiptless gate asks this FIRST when the provisioning
        // verb named no base, and only falls back to the tip if it goes unanswered — real git
        // answers the merge point, and for a fixture whose copy has not diverged that is the
        // same commit `rev-parse` reports. Modelled here rather than left to the refusal below
        // because it is a question production legitimately asks: an unmodelled question turns
        // every case using this fake into a verdict about the fixture instead of about the
        // code. The question arrived with the work that made a RETRY count from the point its
        // branch was cut from, rather than from wherever the project has since moved to.
        //
        // AND A TREE THAT CANNOT SAY WHERE IT STANDS CANNOT SAY WHERE IT WAS CUT FROM. Both
        // are questions to the SAME copy, so one switch covers both: back when `rev-parse` was
        // the only fallback, `throwOn: 'rev-parse'` was how a case said «nobody can name this
        // base», and the cases that say it still spell it that way. Answering merge-base while
        // rev-parse is silenced would hand those cases a base out of a tree the fixture just
        // declared mute — and the door that must stay shut would open.
        if (verb === 'merge-base') {
          if (throwOn === 'rev-parse') throw new Error('git merge-base unavailable')
          return base
        }
        if (verb === 'status') return dirty
        // what the FAILED path asks to list the files an attempt touched — both shapes of it
        if (verb === 'show') return ''
        if (verb === '-c' && args.includes('diff')) return ''
        if (verb === 'rev-list') {
          const range = args.slice(2)
          // «…beyond the tip of whatever tree is being asked» — the anchor that was wrong
          if (range.length === 2 && range[1] === '^HEAD') return fromProjectHead
          // «…on top of the base the copy was cut from» — the anchor the copy actually has
          if (range.length === 1 && range[0] === `${base}..HEAD`) return fromBase
          unanswered.push(`rev-list ${range.join(' ')}`)
          throw new Error(`fake git: unmodelled revision question «rev-list ${range.join(' ')}»`)
        }
        unanswered.push(args.join(' '))
        throw new Error(`fake git: unmodelled question «${args.join(' ')}»`)
      },
      { asked, unanswered },
    )
  }

  it('changed nothing and explained itself → completes on an answer receipt, and reverify is never asked', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const git = makeAnswerGit()
    const { deps, order, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: git },
    })

    const res = await tick(deps)

    // the fake was never asked something it had to guess at — otherwise the verdict below
    // would be a verdict about the fixture
    expect(git.unanswered, 'git was asked a question the fake does not model').toEqual([])
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
    const { deps, order, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      // one commit on the branch — and a branch that carries one says so from either anchor
      deps: { execGit: makeAnswerGit({ fromBase: '1', fromProjectHead: '1' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    expect(order).toContain('reverify') // it WAS asked — this is code work
    // and the door says NOTHING: commits are not a refusal but ordinary code work, and a log
    // line per ordinary attempt would bury the refusals a person must see
    expect(journalled.some((e: any) => e.type === 'task.answer_gate_closed')).toBe(false)
  })

  it('an edit left uncommitted is unfinished work, not an answer → fail("no_receipt")', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit({ dirty: ' M daemon/src/loop.mjs' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    // the refusal is said out loud AND names what git names: a person deciding whether this is
    // unfinished code work or the daemon's own artefact standing in the copy needs the file
    // list, not the bare fact. The silent shape of this refusal cost a live circle 24.08.2026.
    const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
    expect(said, 'the door closed without a word').toBeTruthy()
    expect(said.reason).toBe('dirty_tree')
    expect(String(said.detail)).toContain('daemon/src/loop.mjs')
  })

  /**
   * ── THE DAEMON'S OWN FURNITURE IS NOT THE WORKER'S DIRT ──
   *
   * Measured live 24.08.2026 by the steer drill: the daemon materializes the personal layer
   * into the copy, `git status` answered «?? .claude/», and this door read the daemon's own
   * hand as unfinished work. The question round went out «нет квитанции» and the queue burned
   * two more sessions re-asking the same question. Worse, the collision was structural: the
   * lesson lessonCheck REQUIRES of an answer lives as an uncommitted draft under
   * .claude/memory/ — so «ответ обязан оставить урок» and «ответ обязан оставить чистое
   * дерево» could never both hold. These cases pin each side of the repaired rule.
   */
  it('the daemon\'s untracked furniture («?? .claude/») does not close the answer door', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit({ dirty: '?? .claude/' }) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const [call] = adapter.calls
    expect(call.result.receiptRef).toBe('answer:BL-1#1')
    expect(journalled.some((e: any) => e.type === 'task.answer_gate_closed')).toBe(false)
  })

  it('the lesson draft an answer is REQUIRED to leave does not close the door on that answer', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit({ dirty: '?? .claude/memory/2026-08-24-drill-lesson.md' }) },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
  })

  it('a MODIFIED tracked file under the furnished paths is still the worker\'s work → refused', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      deps: { execGit: makeAnswerGit({ dirty: ' M .claude/settings.json' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
    expect(said?.reason).toBe('dirty_tree')
  })

  it('an untracked file OUTSIDE the furniture is unfinished work → refused, named', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      // the furniture stands beside it, and only the foreign file closes the door
      deps: { execGit: makeAnswerGit({ dirty: '?? .claude/\n?? src/new.mjs' }) },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
    expect(said?.reason).toBe('dirty_tree')
    expect(String(said?.detail)).toContain('src/new.mjs')
    expect(String(said?.detail)).not.toContain('.claude')
  })

  it('an answer nobody wrote down is not an answer → fail("no_receipt")', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({
      adapter,
      responses: CODE_RESPONSES,
      spawnWorker: makeSpawnWorker(undefined, { lines: ['stream line'] }), // no APPROACH_NOTE
      deps: { execGit: makeAnswerGit() },
    })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    // said out loud with the one reason left: the tree is provably untouched, so the missing
    // note is the WHOLE refusal — an answer nobody wrote down
    const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
    expect(said, 'the door closed without a word').toBeTruthy()
    expect(said.reason).toBe('no_note')
  })

  for (const [verb, reason] of [
    ['rev-list', 'count_unknown'],
    ['status', 'status_failed'],
  ]) {
    it(`git cannot answer "${verb}" → the gate fails SAFE and says "${reason}"`, async () => {
      const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
      const { deps, journalled } = makeDeps({
        adapter,
        responses: CODE_RESPONSES,
        deps: { execGit: makeAnswerGit({ throwOn: verb }) },
      })

      const res = await tick(deps)

      expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
      // fail-SAFE is kept, fail-SILENT is not: «git could not answer» is a fact about the
      // machine, and a person hunting a red row must find it in the log, not in the code
      const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
      expect(said, 'the door closed without a word').toBeTruthy()
      expect(said.reason).toBe(reason)
    })
  }

  it('no git surface at all → the gate cannot open, and says so', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps, journalled } = makeDeps({ adapter, responses: CODE_RESPONSES })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
    expect(said, 'the door closed without a word').toBeTruthy()
    expect(said.reason).toBe('no_git')
  })

  /**
   * ── THE ANCHOR, AND THE LIVE MISS IT COST ──
   *
   * 19.08.2026, measured on a real run: the copy had been cut from one branch while the
   * connected project stood on another, TEN commits apart. The attempt touched nothing — it
   * read, understood and answered — but the gate asked «how many commits does this branch have
   * that the project's tip does not», got ten, and closed. The finished answer was called «нет
   * квитанции» and the task was re-run for nothing: ~57 seconds and ~0.17 dollar of the
   * founder's subscription. On the next run the two points happened to coincide and the defect
   * «did not reproduce» — which is a hint about the cause, not a repair.
   *
   * The question that was always meant is «did this attempt put anything on the branch», and
   * only the base the COPY was cut from can answer it. So this case makes the two anchors
   * disagree on purpose and pins the gate to the right one.
   */
  it('the count starts at the base of the copy, not at the tip of the connected project', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    // the copy names the point it was cut from, and the project has since moved on
    const git = makeAnswerGit({ base: 'base-of-copy', fromBase: '0', fromProjectHead: '10' })
    const { deps, journalled } = makeDeps({
      adapter,
      responses: {
        ...CODE_RESPONSES,
        worktree: {
          code: 0,
          stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1', expectedBase: 'base-of-copy' }),
        },
      },
      deps: { projectDir: () => '/connected', execGit: git },
    })

    const res = await tick(deps)

    expect(git.unanswered, 'git was asked a question the fake does not model').toEqual([])
    // an attempt that changed nothing finishes on its answer, whatever the project's tip did
    expect(res.completed).toBe('BL-1')
    const [call] = adapter.calls
    expect(call.result.receiptRef).toBe('answer:BL-1#1')
    expect(journalled.some((e: any) => e.type === 'task.answered' && e.taskId === 'BL-1')).toBe(true)
    // and it is pinned to WHICH question was put, not merely to the outcome: the count runs in
    // the copy's own tree and names the copy's base — the project's tip is never the anchor
    const counts = git.asked.filter((a) => a.verb === 'rev-list')
    expect(counts).toHaveLength(1)
    expect(counts[0].args).toEqual(['rev-list', '--count', 'base-of-copy..HEAD'])
    expect(counts[0].cwd).toBe('/wt/BL-1')
  })

  /**
   * WHICH TREE THE COUNT IS TAKEN IN — and the two placement cases below outlived two laws,
   * which is why they are rewritten rather than deleted.
   *
   * The count first ran in the daemon's LAUNCH directory, where `wt/<taskId>` is not a revision
   * at all on an install serving one repository while the founder works in another: git exited
   * non-zero, the fail-safe answered null, and a task that correctly wrote no code went red.
   * It was moved to the connected project, which held the branch — and that is where the anchor
   * defect above then bit. Now the question carries its own base and is put to the COPY, the one
   * tree that is guaranteed to hold both points: the branch is checked out there and the work
   * happened there. So the pair still asserts exactly what it always did — WHERE the question
   * goes — against the law that replaced the one they were written for.
   */
  const RESPONSES_WITH_BASE = {
    ...CODE_RESPONSES,
    worktree: {
      code: 0,
      stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1', expectedBase: 'base-of-copy' }),
    },
  }

  it('the «no code» count is taken in the COPY — a connected project is not asked at all', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    // a git that can only resolve revisions inside the copy: ask anywhere else and it exits
    // non-zero, exactly as the live one does
    const git = makeAnswerGit({ base: 'base-of-copy', answersIn: '/wt/BL-1' })
    const { deps } = makeDeps({
      adapter,
      responses: RESPONSES_WITH_BASE,
      deps: { projectDir: () => '/connected', execGit: git },
    })

    const res = await tick(deps)

    expect(git.unanswered, 'git was asked a question the fake does not model').toEqual([])
    expect(res.completed).toBe('BL-1')
    const counts = git.asked.filter((a) => a.verb === 'rev-list')
    expect(counts.map((c) => c.cwd)).toEqual(['/wt/BL-1'])
    expect(counts[0].args).toEqual(['rev-list', '--count', 'base-of-copy..HEAD'])
  })

  it('with no project connected the count still goes to the copy, never to the served tree', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const git = makeAnswerGit({ base: 'base-of-copy', answersIn: '/wt/BL-1' })
    const { deps } = makeDeps({ adapter, responses: RESPONSES_WITH_BASE, deps: { execGit: git } })

    const res = await tick(deps)

    expect(git.unanswered, 'git was asked a question the fake does not model').toEqual([])
    expect(res.completed).toBe('BL-1')
    const counts = git.asked.filter((a) => a.verb === 'rev-list')
    expect(counts.map((c) => c.cwd)).toEqual(['/wt/BL-1']) // and never '/repo', the launch tree
  })

  /**
   * AND WHEN NOBODY CAN NAME THE POINT TO COUNT FROM. The copy's provisioning verb declines to
   * name a base on a reused worktree, and the tree it was cut from may be unreachable too. The
   * door stays SHUT — this is the door to completed, and an unknown must never read as «the
   * attempt is provably empty». But it no longer shuts in silence: that silence is precisely
   * what made the anchor miss look like a worker who left no receipt, and sent a person hunting
   * for a file nobody was ever going to write.
   */
  it('a copy whose base nobody can name → the door stays shut, and SAYS so in the operator\'s log', async () => {
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    // the verb names no base (CODE_RESPONSES), and the fallback question cannot be answered either
    const git = makeAnswerGit({ throwOn: 'rev-parse' })
    const { deps, journalled } = makeDeps({ adapter, responses: CODE_RESPONSES, deps: { execGit: git } })

    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: 'BL-1', reason: 'no_receipt' })
    const said = journalled.find((e: any) => e.type === 'task.answer_gate_closed' && e.taskId === 'BL-1')
    expect(said, 'the door closed without a word').toBeTruthy()
    expect(said.reason).toBe('unknown_base')
    expect(String(said.detail)).toContain('база копии неизвестна')
    // and no count was even attempted — there was nothing to count from
    expect(git.asked.filter((a) => a.verb === 'rev-list')).toEqual([])
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
    const { deps, journalled } = makeDeps({
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
    return { clock: c.clock, journalled }
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

  /**
   * ═══════ THE REFUSAL THAT SHUT A SUBSCRIPTION FOR FIVE DAYS, ON THE REAL PATH ═══════
   *
   * 31.08.2026: the provider refused `seven_day_overage_included` — the weekly window with the
   * paid overage folded in, on an account whose paid channel is off and whose ceiling is zero.
   * The tick closed the WHOLE account until 05.09 on the strength of a name it has never been
   * able to draw on any screen, and the conveyor stopped with thirty tasks queued. This runs
   * that exact frame through the real tick and ends where the router looks.
   */
  it('a refusal on a window name we cannot draw is filed and LOGGED, and the account keeps working', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-unknown-'))
    dirs.push(dataDir)
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000
    const refused = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT_SEC, rateLimitType: 'seven_day_overage_included', isUsingOverage: false },
    })

    const { journalled } = await tickWith(refused, dataDir, now)

    const state = windowState({ account: { name: 'max-2' }, clock: () => now, dataDir })
    expect(state.closedUntil).toBeUndefined()
    expect(state.fiveHour.status).toBe('unknown')
    expect(state.week.status).toBe('unknown')
    expect(isOpen(state, () => now)).toBe(true) // thirty queued tasks keep moving

    // Ignoring it silently would be the same bug wearing a quieter coat: the operator has to be
    // able to see that a window nobody can name was refused, and to name it.
    const noted = journalled.find((e: any) => e && e.type === 'window-refusal-unnamed')
    expect(noted).toBeDefined()
    expect(noted.limitType).toBe('seven_day_overage_included')
    expect(noted.account).toBe('max-2')
  })

  /**
   * «Ждёт окно» has to say WHICH window and until when. It used to say neither: the close sat at
   * the top of the record with no window on it, the card pinned the words to the five-hour line
   * whatever had really been refused, and a worker could read «ждёт окно» with both rows saying
   * the subscription was taking work.
   */
  it('a refusal names the window it shut — «ждёт окно» never stands beside two open rows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-named-'))
    dirs.push(dataDir)
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000
    const refused = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT_SEC, rateLimitType: 'seven_day', isUsingOverage: false },
    })

    await tickWith(refused, dataDir, now)

    const payload = await deriveState({
      adapter: { async list() { return [] } },
      windows: (account: any) => windowState({ account, clock: () => now, dataDir }),
      config: { workers: [{ id: 'max-2', lane: 'prod', account: { name: 'max-2' } }], machineId: 'self' },
      clock: () => now,
    })

    const worker = payload.workers[0]
    expect(worker.presence).toBe('ждёт окно')
    expect(worker.window.week.status).toBe('exhausted') // the shut window is named on its own row…
    expect(worker.window.week.resetsAt).toBe(new Date(RESETS_AT_SEC * 1000).toISOString()) // …with the hour
    expect(worker.window.fiveHour.status).toBe('unknown') // and the innocent window is not accused
    expect(worker.window.closedUntil).toBeDefined()
  })

  /**
   * ═════ ОДИН КАДР — ОДНО ЧТЕНИЕ ВСЕЙ ПОДПИСКИ, А НЕ ТОЛЬКО НАЗВАННОГО ОКНА ═════════════
   *
   * 02.09.2026 основатель спросил, почему доска говорит про неделю 67 %, когда его собственный
   * терминал говорит 7 %. Ответ: недельное окно обновлялось ТОЛЬКО тогда, когда поставщик его
   * НАЗЫВАЛ (`rateLimitType: "seven_day"`) — это предупреждение, оно приходит раз в сутки и
   * реже. А в каждом кадре, рядом, ехал `unifiedWindows` с долей обоих окон сразу, и его никто
   * не открывал. Строка ниже взята из ленты дословно: она называет ПЯТИЧАСОВОЕ окно, и неделя
   * в ней есть только в этом блоке.
   *
   * Кадр идёт через настоящий тик и заканчивается там, куда смотрит человек, — в выдаче экрана.
   */
  it('a frame that names only the five-hour window still refreshes the WEEK — the unified block is read', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-unified-'))
    dirs.push(dataDir)
    const WEEK_RESETS_AT_SEC = RESETS_AT_SEC + 3 * 24 * 60 * 60
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000
    const unified = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: RESETS_AT_SEC,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'out_of_credits',
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 0.18, resetsAt: RESETS_AT_SEC },
          seven_day: { utilization: 0.07, resetsAt: WEEK_RESETS_AT_SEC },
        },
      },
      uuid: 'f0b6a5a9-4f75-497c-8cd8-dea9901217e2',
      session_id: '718f1fa9-9947-4be0-86fe-369f876f266a',
    })

    await tickWith(unified, dataDir, now)

    const payload = await deriveState({
      adapter: { async list() { return [] } },
      windows: (account: any) => windowState({ account, clock: () => now, dataDir }),
      config: { workers: [{ id: 'max-2', lane: 'prod', account: { name: 'max-2' } }], machineId: 'self' },
      clock: () => now,
    })

    const [account] = payload.spend.accounts
    // The window the frame NAMED, with the fraction the unified block carried for it
    expect(account.fiveHour.status).toBe('open')
    expect(account.fiveHour.pct).toBe(18)
    // AND THE ONE IT DID NOT NAME — this is the whole case
    expect(account.week.status).toBe('open')
    expect(account.week.pct).toBe(7)
    expect(account.week.resetsAt).toBe(new Date(WEEK_RESETS_AT_SEC * 1000).toISOString())
    // …dated, because a number with no hour on it is read as «now»
    expect(account.week.observedAt).toBe(new Date(now).toISOString())
  })

  /**
   * ═════ ЕСЛИ ПОСТАВЩИК ПРИШЛЁТ ПРОЦЕНТЫ — СЧЁТ НЕ ЗАКРЫВАЕТСЯ НА СЕМЬ ДНЕЙ ══════════════
   *
   * Доля израсходованного читается как ЧАСТЬ ЕДИНИЦЫ, и единица означает «поставщик больше не
   * пропускает работу». Пришли бы те же числа процентами — 18, 47, 67, — и каждое из них
   * больше единицы: с первого же кадра оба окна читались бы «исчерпано», `isOpen` отвечал бы
   * ложью, маршрутизатор перестал бы выдавать этому счёту работу, и поправить это было бы
   * нечем до сброса окна — для недельного это семь суток. Отказ, которого поставщик не
   * объявлял, и конвейер, вставший молча.
   *
   * Кадр ниже — тот же настоящий кадр с долями, но в процентной шкале. Он идёт через живой тик
   * и заканчивается там же, где смотрит человек, плюс в журнале: перетолкованное число обязано
   * быть видно, иначе смена формы провода пройдёт незамеченной.
   */
  it('a spent share sent in PERCENTS is read as percents — the account keeps working, and the journal says so', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-scale-pct-'))
    dirs.push(dataDir)
    const WEEK_RESETS_AT_SEC = RESETS_AT_SEC + 3 * 24 * 60 * 60
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000
    const inPercents = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: RESETS_AT_SEC,
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 18, resetsAt: RESETS_AT_SEC },
          seven_day: { utilization: 67, resetsAt: WEEK_RESETS_AT_SEC },
        },
      },
    })

    const { journalled } = await tickWith(inPercents, dataDir, now)

    const state = windowState({ account: { name: 'max-2' }, clock: () => now, dataDir })
    // NOT «исчерпано» — which is what a raw read of 18 and 67 would have made of them
    expect(state.fiveHour.status).toBe('open')
    expect(state.week.status).toBe('open')
    expect(isOpen(state, () => now)).toBe(true) // and the router goes on using the account
    expect(state.fiveHour.pct).toBe(18) // …with the number meaning what it says
    expect(state.week.pct).toBe(67)

    // A NUMBER WE RE-INTERPRETED IS SAID OUT LOUD. Quietly right is how nobody learns the wire
    // changed shape — and the frame that proves it is the one worth capturing.
    const noted = journalled.filter((e: any) => e && e.type === 'window-utilization-scale')
    expect(noted.length).toBeGreaterThan(0)
    expect(noted.every((e: any) => e.scale === 'percent')).toBe(true)
    expect(noted.map((e: any) => e.limitType).sort()).toEqual(['five_hour', 'seven_day'])
    expect(noted[0].account).toBe('max-2')
  })

  /**
   * И ЧИСЛО, КОТОРОЕ НЕ ЛОЖИТСЯ НИ В ОДНУ ШКАЛУ, ОТБРАСЫВАЕТСЯ СЛОВАМИ. 150 — это не доля и не
   * процент; поставить его на экран значило бы выдать за измерение то, что никто прочитать не
   * смог, а промолчать — потерять единственный признак, что провод поехал. Окно говорит «нет
   * данных» (это честно), состояние окна не трогается, счёт продолжает работать, а в журнале
   * остаётся строка с исходным числом.
   */
  it('a spent share that is neither a fraction nor a percent is dropped — «нет данных», not a claim', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wire-scale-bad-'))
    dirs.push(dataDir)
    const now = RESETS_AT_SEC * 1000 - 60 * 60 * 1000
    const nonsense = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: RESETS_AT_SEC,
        rateLimitType: 'five_hour',
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: 150, resetsAt: RESETS_AT_SEC } },
      },
    })

    const { journalled } = await tickWith(nonsense, dataDir, now)

    const state = windowState({ account: { name: 'max-2' }, clock: () => now, dataDir })
    expect(state.fiveHour.status).toBe('open') // the vendor said «allowed» and nothing overrode it
    expect(state.fiveHour.pct).toBeNull() // the unreadable number never reaches the glass
    expect(isOpen(state, () => now)).toBe(true)

    const noted = journalled.find((e: any) => e && e.type === 'window-utilization-scale')
    expect(noted).toBeDefined()
    expect(noted.scale).toBe('out-of-range')
    expect(noted.raw).toBe(150)
    expect(noted.limitType).toBe('five_hour')
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
    expect(account.fiveHour).toEqual({ status: 'unknown', resetsAt: null, pct: null, observedAt: null })
    expect(account.week).toEqual({ status: 'unknown', resetsAt: null, pct: null, observedAt: null })
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
 * ═══════════ СЛОМАЛОСЬ — ПОВТОРИ СЧИТАННОЕ ЧИСЛО РАЗ, ПОТОМ СТОП ═══════════════════
 *
 * This is the loop of 12.08.2026 written down as a test, at the level it actually happened:
 * the TICK. A piece broke, and the machine ran it again — and again — because nothing anywhere
 * said «stop». Three live sessions on one task, a subscription burnt overnight, and a board
 * showing an empty queue and an idle worker.
 *
 * WHAT THE CURE TURNED OUT TO BE, and it is not «never repeat». Never repeating cost its own
 * measured day: on 31.08 three assemblies stood broken since the day before, holding ten pieces
 * of work behind them, all three on a cause whose own card said «the provider cut it, try
 * again» — and all three went green on the first try when a person pressed repeat by hand. The
 * loop was never the repetition; it was the repetition WITHOUT A CEILING and without a word.
 *
 * So the promise this block pins is the pair of them:
 *   — a broken piece IS repeated by the tick itself, after a pause, and each repeat is counted;
 *   — the counting ENDS: past the ceiling, tick after tick after tick does nothing with that
 *     assembly — no repeat, no next piece — until its owner says a word, and when he does, the
 *     very next tick carries on exactly as he asked.
 */
describe('сорвавшийся кусок повторяется сам считанное число раз, а дальше ждёт владельца', () => {
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

  /**
   * Сборка, у которой первый кусок сорвался `redRuns` раз подряд. Каждый следующий прогон
   * случается НЕ потому, что его завёл тест: между прогонами проходит пауза автоповтора, и тик
   * сам возвращает кусок в очередь — тем же проходом, каким потом его и выдаёт.
   */
  async function brokenBatch(c: any, { redRuns = 1 } = {}) {
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
    for (let n = 0; n < redRuns; n += 1) {
      if (n > 0) c.advance(AUTO_RETRY_BASE_MS * 2 ** (n - 1) + 1000)
      const res = await tick(deps)
      expect(res.failed).toEqual({ taskId: 'B-F-1', reason: 'tests_red' })
    }
    return adapter
  }

  it('пауза прошла — тик возвращает кусок сам, и на повторе сборка едет дальше', async () => {
    const c = mkClock()
    const adapter = await brokenBatch(c)

    // До конца паузы — ничего: свежий срыв не трогают.
    const { deps } = makeDeps({ adapter, clockObj: c, responses: GREEN_RESPONSES })
    expect((await tick(deps)).idle).toBe(true)

    c.advance(AUTO_RETRY_BASE_MS + 1000)
    // Один и тот же проход возвращает кусок в очередь и выдаёт его — повтор не ждёт лишнего тика.
    expect((await tick(deps)).completed).toBe('B-F-1')
    expect((await tick(deps)).completed).toBe('B-F-2') // и сборка доехала до конца сама
  })

  it('потолок повторов исчерпан — дальше тик за тиком не происходит ничего', async () => {
    const c = mkClock()
    const adapter = await brokenBatch(c, { redRuns: AUTO_RETRY_LIMIT + 1 })

    const { deps, order } = makeDeps({ adapter, clockObj: c, responses: GREEN_RESPONSES })
    for (let i = 0; i < 5; i += 1) {
      c.advance(60000) // an hour of five-second ticks, compressed
      expect((await tick(deps)).idle).toBe(true)
    }
    expect(order).toEqual([]) // not one verb, not one session — nothing was spawned at all

    const rows = await adapter.list({})
    expect(rows.find((r: any) => r.id === 'B-F-1').status).toBe('failed')
    // Повторов было ровно столько, сколько отпущено, и ни одного сверх.
    expect(rows.find((r: any) => r.id === 'B-F-1').attempt).toBe(AUTO_RETRY_LIMIT + 1)
    expect(rows.find((r: any) => r.id === 'B-F-2').status).toBe('queued') // и дальше не пошло
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
/**
 * КАКОЙ ГЛАГОЛ У ЭТОГО ВЫЗОВА — вопрос к аргументам, а не к их ПОРЯДКУ.
 *
 * `git -c ключ=значение <глагол> …` — обычная форма вызова, и подделка, читавшая нулевой
 * аргумент как глагол, отвечала пустотой на любой такой вызов. Это ровно тот класс, который в
 * этом дереве уже стоил дня: подделка, которая умеет МЕНЬШЕ библиотеки, зелена ровно до того
 * дня, когда настоящий вызов перестаёт совпадать с её представлением о нём.
 */
const gitVerbOf = (args: string[]) => {
  const rest = [...args]
  while (rest[0] === '-c') rest.splice(0, 2) // пара «настройка=значение» — не глагол
  return rest[0]
}

const makeGateGit =
  ({ commits = '1', diff = 'M\tdaemon/src/loop.mjs', throwOn = '' } = {}) =>
  (args: string[]) => {
    const verb = gitVerbOf(args)
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
    // Запись — статус и имя ОТДЕЛЬНО, а не одна склеенная строка: карточке нужно знать, что
    // именно случилось с файлом, и склейка заставила бы её разбирать строку заново.
    expect(line.files).toEqual([
      { status: 'M', path: 'daemon/src/loop.mjs' },
      { status: 'A', path: 'daemon/__tests__/loop.test.ts' },
    ])
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
    expect(line.files).toEqual([{ status: 'M', path: 'daemon/src/loop.mjs' }])
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

  it('документарная стадия идёт В КОПИИ — путь, база и ветка стоят в строке попытки', async () => {
    // ДО 31.08.2026 ЗДЕСЬ УТВЕРЖДАЛОСЬ ОБРАТНОЕ: «шла без копии — ни пути, ни списка». Ровно это
    // и означало, что ступень пишет в дерево планирования, а строка попытки не может назвать НИ
    // ОДНОЙ точки отката: откатывать приходилось руками по хэшам, найденным задним числом.
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
    expect(row.worktreePath).toBe('/repo')
    expect(row.branch).toBe('wt/ST-1')
    expect(row.base).toBe('base1234')
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

  /**
   * ═══════ СКВОЗНОЙ ПРОВОД ПРОБУЖДЕНИЯ: НАСТОЯЩИЙ ТИК, НАСТОЯЩИЙ КОМПОЗИТОР, НАСТОЯЩИЙ ARGV ═══════
   *
   * Дела выше проверяют половины: тик решает вид пробуждения, композитор кладёт решение во флаги.
   * Здесь обе половины соединены и НИ ОДНА не подделана — тот же настоящий сборщик аргументов,
   * что и в деле про mcp-конфиг выше, и утверждение снимается с массива, которым запускается
   * процесс. Это ровно та форма, которой требует закон о связности: каждый кусок по отдельности
   * был написан, покрыт делом и зелён — и однажды ни один не оказался присоединён к соседнему.
   *
   * И ЗДЕСЬ ЖЕ ВИДНО, ЧТО ПОТОЛОК ХОДОВ ДОЕЗЖАЕТ ТЕМ ЖЕ ПУТЁМ — один прогон предъявляет оба
   * провода этой работы, потому что оба кончаются в одном и том же массиве.
   */
  const argvOfWake = async (over: any, ledgerRow: any) => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const dataDir = mkDir('sma-data-')
    const ledgerDir = mkDir('sma-ledger-')
    const spawns: any[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const config = { workers: [worker(accountDir)], repoDir: '/repo', pipeline: { enabled: true, maxTurns: 33 }, dataDir }
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
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
        loadMcpRegistry: () => ({ servers: [], path: join(dataDir, 'mcp.json') }),
      },
    })
    recordAttempt(ledgerDir, ledgerRow)
    await adapter.enqueue(backlogTask({ attempt: 2, ...over }))
    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')
    expect(spawns).toHaveLength(1)
    return spawns[0]
  }

  it('возврат человека доезжает до argv продолжением сессии, а таймер — без него, и потолок едет в обоих', async () => {
    const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

    const returned = await argvOfWake({ source: 'return' }, { taskId: 'BL-1', attempt: 1, outcome: 'returned', sessionId: SID })
    const at = returned.indexOf('--resume')
    expect(at, 'продолжение сессии не доехало до argv возврата').toBeGreaterThan(-1)
    expect(returned[at + 1]).toBe(SID)

    const woken = await argvOfWake({}, { taskId: 'BL-1', attempt: 1, outcome: 'failed', sessionId: SID })
    expect(woken).not.toContain('--resume')
    expect(woken.join(' '), 'старая сессия не смеет ехать в свежее пробуждение').not.toContain(SID)

    // и потолок ходов — в обоих массивах, подряд со своим флагом.
    //
    // 66, а не 33: настройка человека — БАЗА, а не одно число на всякую работу. Эта задача
    // объявлена оценкой 3 по Фибоначчи, то есть обычной, и обычная работа идёт под удвоенной
    // базой. Пробуждение на потолок не влияет — это и проверяется двумя массивами.
    for (const argv of [returned, woken]) {
      const cap = argv.indexOf('--max-turns')
      expect(cap, 'потолок ходов не доехал до argv').toBeGreaterThan(-1)
      expect(argv[cap + 1]).toBe('66')
    }
  })

  /**
   * ═════ ПРОВОД: КОНСПЕКТ ПРОШЛОГО ПОДХОДА ДОЕЗЖАЕТ ДО ПРОМПТА СЛЕДУЮЩЕГО ═════
   *
   * ЭТО ДЕЛО О ПРОВОДЕ, А НЕ О СБОРКЕ. Оно кладёт файл конспекта на диск РУКАМИ — то есть
   * ровно так, как его кладёт прошлая попытка, — и снимает утверждение с промпта, которым
   * запущен процесс. Дело, утверждающее, что конспект где-то собран, было бы бесполезно:
   * именно такое дело и было зелёным в тот день, когда ничего никуда не доезжало.
   *
   * НИ ОДНОГО ПОДДЕЛЬНОГО ЗВЕНА НА МАРШРУТЕ: настоящий тик, настоящий композитор
   * (`createBuildArgs`), настоящий строитель промпта. Подделка любого из трёх вернула бы
   * дело к утверждению о сборке.
   *
   * ФАЙЛ ЛЕЖИТ ТАМ, ГДЕ ЕГО ИЩЕТ ВЫРАЖЕНИЕ ПУТИ, и путь в деле собран ТЕМ ЖЕ выражением
   * (`attemptRunDir`), а не написан строкой: дело, знающее второе написание пути, доказывало
   * бы согласие с самим собой.
   */
  const promptOfWake = async (over: any, ledgerRow: any, continuation: string | null) => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const dataDir = mkDir('sma-data-')
    const ledgerDir = mkDir('sma-ledger-')
    const repoDir = mkDir('sma-repo-')
    const spawns: any[] = []
    const seenOpts: any[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const config = { workers: [worker(accountDir)], repoDir, pipeline: { enabled: true, maxTurns: 33 }, dataDir }
    const realBuildArgs = createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } })

    // КАТАЛОГ ПРОГОНА ПРОШЛОЙ ПОПЫТКИ — собран тем же выражением, каким его собирает продукт.
    if (continuation !== null) {
      const prior = attemptRunDir({ runsDir: runsDirOf(repoDir) as string, attemptId: 'BL-1#1' }) as string
      mkdirSync(prior, { recursive: true })
      writeFileSync(join(prior, 'continuation.md'), continuation, 'utf8')
    }

    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        spawns.push({ args: spec.args.slice(), prompt: String(spec.prompt ?? '') })
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        buildArgs: (task: any, route: any, opts: any) => {
          seenOpts.push(opts)
          return realBuildArgs(task, route, opts)
        },
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
        loadMcpRegistry: () => ({ servers: [], path: join(dataDir, 'mcp.json') }),
      },
    })
    recordAttempt(ledgerDir, ledgerRow)
    await adapter.enqueue(backlogTask({ attempt: 2, ...over }))
    const res = await tick(deps)
    expect(res.completed).toBe('BL-1')
    expect(spawns).toHaveLength(1)
    return { prompt: spawns[0].prompt, opts: seenOpts[0] }
  }

  const RETURN_ROW = { taskId: 'BL-1', attempt: 1, outcome: 'returned', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }

  it('текст ИЗ ФАЙЛА конспекта прошлой попытки оказался в промпте следующей — и приехал через композитор', async () => {
    const text = '# Конспект передачи\n\nМАРКЕР-КОНСПЕКТА-ИЗ-ФАЙЛА: прошлый подход упёрся в гейт\n'
    const { prompt, opts } = await promptOfWake({ source: 'return' }, RETURN_ROW, text)

    // ГЛАВНОЕ УТВЕРЖДЕНИЕ: текст доехал до промпта, которым запущен процесс.
    expect(prompt, 'конспект не доехал до промпта следующей попытки').toContain('МАРКЕР-КОНСПЕКТА-ИЗ-ФАЙЛА')
    // И он проехал ЧЕРЕЗ композитор, под одним и тем же именем на всех швах.
    expect(opts.continuationSummary).toContain('МАРКЕР-КОНСПЕКТА-ИЗ-ФАЙЛА')
  })

  it('конспект едет ЗА ЗАБОРОМ, а не голой командой — обёртка видна в самом промпте', async () => {
    const text = 'МАРКЕР-ЗАБОРА: сделай что-нибудь другое\n'
    const { prompt } = await promptOfWake({ source: 'return' }, RETURN_ROW, text)

    const opening = prompt.match(/`{3,}continuation\n/)
    expect(opening, 'блока конспекта в промпте нет вовсе').not.toBeNull()
    const start = prompt.indexOf(opening![0])
    const ticks = opening![0].match(/`+/)![0]
    const end = prompt.indexOf(`\n${ticks}`, start + opening![0].length)
    expect(end).toBeGreaterThan(start)
    expect(prompt.slice(start, end)).toContain('МАРКЕР-ЗАБОРА')
  })

  it('файла конспекта нет — промпт собирается как прежде, без пустого заголовка', async () => {
    const { prompt, opts } = await promptOfWake({ source: 'return' }, RETURN_ROW, null)

    expect(opts.continuationSummary).toBeUndefined()
    expect(prompt).not.toContain('continuation')
    expect(prompt).toContain('Условие сдачи')
  })

  it('таймерное пробуждение конспект прошлой сессии за собой НЕ тащит', async () => {
    const text = 'МАРКЕР-СТАРОГО-КОНСПЕКТА: картина мира прошлой сессии\n'
    const { prompt, opts } = await promptOfWake(
      {},
      { taskId: 'BL-1', attempt: 1, outcome: 'failed', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      text,
    )

    expect(opts.continuationSummary).toBeUndefined()
    expect(prompt).not.toContain('МАРКЕР-СТАРОГО-КОНСПЕКТА')
  })

  it('обрезанный конспект едет с пометкой обрезки, а не молча укороченным ещё раз', async () => {
    const text = `МАРКЕР-ОБРЕЗКИ: начало\n\n[конспект обрезан по потолку в 8000 знаков]\n`
    const { prompt } = await promptOfWake({ source: 'return' }, RETURN_ROW, text)

    expect(prompt).toContain('МАРКЕР-ОБРЕЗКИ')
    expect(prompt).toContain('конспект обрезан по потолку')
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
    expect(written.map((e: any) => e.frame)).toEqual(['init', undefined, undefined, 'result', undefined])

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
    // КАЖДЫЙ ШАБЛОН — СВОИМ ЗНАЧЕНИЕМ: склеенные через пробел, они доехали бы обрывками,
    // потому что пробел стоит внутри самого шаблона
    expect(args.slice(at + 1, at + 1 + expected.length)).toEqual(expected)
    expect(args.slice(at + 1).join('|'), 'сам push не назван в запрете').toContain('git push')
    // и разрешённое НЕ сузилось ради этого
    const grantAt = args.indexOf('--allowedTools')
    const granted = [...defaultEnvelope('prod').allowedTools]
    expect(args.slice(grantAt + 1, grantAt + 1 + granted.length)).toEqual(granted)

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

  it('провод: каталог попытки и файл переписки доезжают до ОКРУЖЕНИЯ процесса и до записи попытки', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const projectDir = mkDir('sma-proj-')
    const ledgerDir = mkDir('sma-ledger-')
    const dataDir = mkDir('sma-data-')
    // Что процесс УВИДЕЛ в момент запуска — а не то, что оказалось на диске потом.
    const seen: Array<{ env: Record<string, string>; runDirExisted: boolean }> = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const config = { workers: [worker(accountDir)], repoDir: projectDir, dataDir, pipeline: { enabled: true } }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        seen.push({
          env: { ...(spec.env || {}) },
          runDirExisted: existsSync(String((spec.env || {}).SMA_RUN_DIR || '')),
        })
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
        dataDir,
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
      },
    })

    await tick(deps)

    expect(seen).toHaveLength(1)
    const expectedRunDir = attemptRunDir({ runsDir: runsDirOf(projectDir), attemptId: 'BL-1_1' })
    // (1) ЗНАЧЕНИЕ доехало до окружения запущенного процесса — не «вычислено», а вручено.
    expect(seen[0].env.SMA_RUN_DIR).toBe(expectedRunDir)
    expect(seen[0].env.SMA_REDIRECTS_FILE).toBe(redirectFileOf({ dataDir, taskId: 'BL-1' }))
    // (2) и каталог СУЩЕСТВОВАЛ уже в момент запуска: билету некуда лечь в каталог, которого нет
    expect(seen[0].runDirExisted, 'каталог попытки создан ПОСЛЕ запуска — билету было некуда лечь').toBe(true)
    // (3) имена видны в записи попытки, значения — нет (правило «только имена»)
    const run = JSON.parse(readFileSync(join(expectedRunDir!, 'run.json'), 'utf8'))
    expect(run.envNames).toContain('SMA_RUN_DIR')
    expect(run.envNames).toContain('SMA_REDIRECTS_FILE')
  })

  it('провод: задача со штампом проекта отрезается от дерева ШТАМПА, а не от проекта на экране', async () => {
    // Штамп кладётся дверью постановки в единственный момент, когда проект известен;
    // экранный селектор — живой, между постановкой и взятием человек переключает проекты.
    // До починки провижен читал ЭКРАН в момент взятия, и задача мастерской бежала в дереве
    // продукта — доказано живой задачей: работник сам установил git rev-parse'ом, что его
    // копия отрезана не от того репозитория, и вернулся с вопросом вместо работы.
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const screenDir = mkDir('sma-screen-')
    const stampedDir = mkDir('sma-stamped-')
    const ledgerDir = mkDir('sma-ledger-')
    const seen: Array<{ env: Record<string, string> }> = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ ...backlogTask(), project: 'stamped' })
    const config = {
      workers: [worker(accountDir)],
      repoDir: screenDir,
      pipeline: { enabled: true },
      projects: [{ id: 'stamped', path: stampedDir }],
    }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        seen.push({ env: { ...(spec.env || {}) } })
        spec.onLine?.(JSON.stringify(FOREIGN_INIT_FRAME))
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        projectDir: () => screenDir, // экран в момент взятия показывает ДРУГОЙ проект
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
      },
    })

    await tick(deps)

    // (1) каталог попытки ВРУЧЁН процессу в дереве штампа — не «вычислен», а доехал.
    expect(seen).toHaveLength(1)
    const expectedRunDir = attemptRunDir({ runsDir: runsDirOf(stampedDir), attemptId: 'BL-1_1' })
    expect(seen[0].env.SMA_RUN_DIR).toBe(expectedRunDir)
    // (2) запись попытки лежит там же.
    expect(existsSync(join(expectedRunDir!, 'run.json'))).toBe(true)
    // (3) в дереве экрана попытка каталога НЕ оставила — работа не бежала в чужом дереве.
    expect(existsSync(join(screenDir, '.sma', 'runs', 'BL-1_1'))).toBe(false)
  })

  /**
   * ПРОВОД ПРАВА СПРОСИТЬ — ДО РТА РАБОТНИКА, А НЕ ДО СБОРЩИКА.
   *
   * Раздел «Вопрос по ходу» проверен в сьюте промпта — но там утверждается ВОЗВРАТ СБОРЩИКА,
   * то есть промежуточная строка. Работник читает не её: задание идёт через композицию
   * аргументов в поле `prompt` и оттуда — в stdin ребёнка. Сегодня преобразований между этими
   * точками нет, и ровно такие «сегодня нет» рвались в живых прогонах: вычисленное значение
   * жило в журнале и не доезжало до запуска. Поэтому здесь — НАСТОЯЩИЙ сборщик аргументов
   * (подделка закрыла бы тот самый стык) и утверждение о том, ЧТО ПОЛУЧИЛ ЗАПУСКАТЕЛЬ.
   *
   * Подделка запускателя здесь не умеет больше живого: она читает `spec.prompt`, `spec.onLine`
   * и `spec.onExit` — ровно те поля, которые читает `spawnWorker` (сверено с его телом; сьют
   * промпта отдельно доказывает, что живой запускатель пишет `prompt` в stdin ребёнка).
   */
  it('провод: раздел «Вопрос по ходу» доезжает до ЗАДАНИЯ, переданного запускателю', async () => {
    const sourceDir = founderHome()
    const accountDir = mkDir('sma-account-')
    const projectDir = mkDir('sma-proj-')
    const ledgerDir = mkDir('sma-ledger-')
    const prompts: string[] = []
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const config = { workers: [worker(accountDir)], repoDir: projectDir, pipeline: { enabled: true } }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config,
      spawnWorker: (spec: any) => {
        prompts.push(String(spec.prompt ?? ''))
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      responses: codeResponses(),
      deps: {
        ledger: ledgerSeam(ledgerDir),
        projectDir: () => projectDir,
        // НАСТОЯЩИЙ сборщик: подделка здесь закрыла бы ровно тот стык, ради которого кейс написан
        buildArgs: createBuildArgs({ config, env: { SMA_MAX_2_TOKEN: 'oauth-value' }, fsImpl: { readFileSync } }),
        mirrorPersonalLayer: (opts: any) => mirrorPersonalLayer({ ...opts, sourceDir }),
      },
    })

    await tick(deps)

    expect(prompts).toHaveLength(1)
    const handedOver = prompts[0]
    // (1) право спросить доехало до задания, которое получил запускатель
    expect(handedOver, 'раздел о вопросе по ходу остался у сборщика и до работника не доехал').toContain(
      '## Вопрос по ходу',
    )
    // (2) и доехало ЦЕЛИКОМ: все три вещи, а не один заголовок
    const section = handedOver.slice(handedOver.indexOf('## Вопрос по ходу')).replace(/\s+/g, ' ')
    expect(section).toContain('вызов поставлен на паузу')
    expect(section).toContain('В ЭТУ ЖЕ сессию')
    expect(section).toContain('ГЛАВНЕЕ ранее данных указаний')
    // (3) и это ОБЫЧНАЯ задача — та самая, у которой права спросить не было вовсе
    expect(handedOver).toContain('BL-1')
  })

  it('провод: путь каталога попытки у спавна и у записи — ОДНО выражение', () => {
    // Расход этих двух путей означал бы билеты в одном каталоге и запись в другом.
    const runsDir = runsDirOf('/p')
    expect(attemptRunDir({ runsDir, attemptId: 'BL-1_1' })).toBe(join('/p', '.sma', 'runs', 'BL-1_1'))
    expect(attemptRunDir({ runsDir: null as never, attemptId: 'BL-1_1' })).toBe(null)
    expect(attemptRunDir({ runsDir, attemptId: '' })).toBe(null)
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
    // ТРИ ЧИТАТЕЛЯ, И НИ ОДНОГО ЛИШНЕГО: две точки спавна плюс блокировщик песочницы полосы
    // codex. Третий появился не «в обход замка», а внутри него: он ОТКАЗЫВАЕТ по тому же
    // гранту, по какому спавн бы ЗАПУСТИЛСЯ, и второе прочтение конверта здесь означало бы
    // отказывать по одному конверту, а запускать по другому — ровно тот дефект, ради которого
    // замок и стоит. Число пинится, чтобы четвёртый читатель пришёл сюда за словами.
    expect(source.match(/envelopeSpawnOptions\(envelope\)/g) ?? []).toHaveLength(3)
    // и третий назван поимённо: замок ловит появление НОВОГО читателя, а не переименование
    expect(source).toMatch(/codexSandboxFor\(envelopeSpawnOptions\(envelope\)\.allowedTools\)/)
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
            // ЭТО ИСПОЛНИТЕЛЬ, И СКАЗАНО ЭТО РУКОЙ. Обычная задача просит исполнителя, а роль
            // выводится из имени файла описания — «builder» исполнителем не читается. Поле
            // `role` главнее выведенного (policy/worker-role.mjs), и здесь оно ровно за тем,
            // за чем существует: описание называется по делу, а работу человек ведёт им же.
            role: 'executor',
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
      // копия провизится и документарной ступени — верб обязан ответить путём, иначе тик честно
      // откажется запускать работника в каталог, которого никто не делал
      verbRunner: recordingRunner(seen, { worktree: STAGE_WORKTREE }),
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

// ── Кнопка «Одобрить вызов»: провод от окна к стоящему вызову ──────────────────
describe('кнопка одобрения — один провод, один режим', () => {
  it('провод: строка, собранная ПРОИЗВОДИТЕЛЕМ окна, разбирается ПОТРЕБИТЕЛЕМ хука', () => {
    // Ровно тот вызов, который делает кнопка, и ровно тот разбор, который делает хук.
    // Собрать строку руками в тесте значило бы доказать, что обе стороны согласны С ТЕСТОМ.
    const ticketId = ticketIdFor({ attemptId: 'BL-1_1', tool: 'Bash', input: { command: 'npm publish' } })
    const line = formatDecision({ ticketId, decision: 'approve', reason: 'посмотрел' })
    const parsed = parseDecision(line)
    expect(parsed?.ticketId).toBe(ticketId)
    expect(parsed?.decision).toBe('approve')
    // И чужая поправка того же человека решением НЕ становится — она едет работнику.
    expect(parseDecision('нет, не так — правь шапку')).toBe(null)
  })

  it('провод: режим кнопки — queue, и interrupt на этом пути не существует', () => {
    // ПЕРЕВОДЫ СТРОК НОРМАЛИЗУЮТСЯ, и это не косметика: этот замок режет тело функции по
    // маркеру конца, а git отдаёт один и тот же файл с LF в одной рабочей копии и с CRLF в
    // другой. Без нормализации замок находил пустоту и падал на дереве, где всё правильно, —
    // то есть переставал быть замком ровно там, где его сработать и должно.
    const lf = (s: string) => s.split('\r\n').join('\n')
    const client = lf(readFileSync(new URL('../../spa/src/api/client.ts', import.meta.url), 'utf8'))
    const decide = client.slice(client.indexOf('export function decideToolTicket'))
    const body = decide.slice(0, decide.indexOf('\n}\n') + 2)
    // Режим ЗАШИТ в теле, а не принят параметром: второго значения у этого пути быть не должно.
    expect(body).toContain("mode: 'queue'")
    expect(body).not.toContain('interrupt')
    // Прерывание убивает живого ребёнка — то есть уничтожило бы удерживаемую билетом сессию.
    const card = lf(readFileSync(new URL('../../spa/src/screens/task-card/index.tsx', import.meta.url), 'utf8'))
    const parked = card.slice(card.indexOf('function ParkedCall'), card.indexOf('«Карточка задачи»'))
    expect(parked).toContain('useDecideToolTicket')
    expect(parked).not.toContain('interrupt')
    // И строка кнопки НЕ склеивается в окне: она приходит из производителя продукта.
    expect(client).toContain("from '../../../scripts/sma/lib/tool-decision.mjs'")
  })

  it('провод: дверь решения — та, что УЖЕ есть; новых маршрутов не заведено', () => {
    const server = readFileSync(new URL('../src/front/server.mjs', import.meta.url), 'utf8')
    const routes = server.slice(server.indexOf('const ROUTES'), server.indexOf('const ROUTES') + 12000)
    // Решение едет дверью переписки, и никакой двери билета в таблице маршрутов нет.
    expect(routes).toContain("'POST /api/redirect'")
    expect(routes).not.toMatch(/ticket|approve-call|tool\/approve/i)
    const client = readFileSync(new URL('../../spa/src/api/client.ts', import.meta.url), 'utf8')
    const decide = client.slice(client.indexOf('export function decideToolTicket'))
    expect(decide.slice(0, 900)).toContain('redirectTask(')
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────
// ЧТО ПОПЫТКА ИЗМЕНИЛА — прочитанное из git так, как git на самом деле отвечает
//
// ПОЧЕМУ ЭТИ СЛУЧАИ ГОНЯЮТСЯ НА НАСТОЯЩЕМ git, А НЕ НА ПОДДЕЛКЕ. Подделка, которая отдаёт
// ровно то, чего от неё ждут, зелена всегда — включая тот день, когда форму ответа «знают
// неправильно». Форма здесь измерена побайтово ДО написания разбора, и каждый случай ниже
// создаёт настоящий временный репозиторий, делает в нём настоящие правки настоящими
// командами и спрашивает настоящий git. Цена подделки в этом месте уже известна по дереву:
// имя файла с кириллицей приходит от git по умолчанию восьмеричными последовательностями в
// кавычках, и никакая подделка об этом не расскажет.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe('изменённые файлы попытки: список читается из git', () => {
  const gitDirs: string[] = []
  afterAll(() => {
    for (const d of gitDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* уборка временного каталога никогда не роняет сьют */
      }
    }
  })

  /** Нулевой байт — разделитель записей в ответе git. В исходнике он собирается кодом, а не
   *  пишется байтом: файл теста обязан остаться текстовым, иначе его не прочитает ни человек,
   *  ни половина инструментов вокруг. */
  const NUL = String.fromCharCode(0)

  /** НАСТОЯЩИЙ шов git — тот же вызов, что собирает production в main.mjs. */
  const realGit = (args: string[], opts: { cwd?: string } = {}) =>
    execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const newRepo = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    gitDirs.push(dir)
    realGit(['init', '-q', '.'], { cwd: dir })
    realGit(['config', 'user.email', 'wire@test'], { cwd: dir })
    realGit(['config', 'user.name', 'wire'], { cwd: dir })
    realGit(['config', 'core.autocrlf', 'false'], { cwd: dir })
    return dir
  }

  /** Репозиторий со ВСЕМИ формами сразу: изменение, добавление, удаление оболочкой,
   *  удаление через git, переименование, русское имя, имя с пробелом. */
  const worldRepo = () => {
    const dir = newRepo('sma-changed-')
    writeFileSync(join(dir, 'modify.txt'), 'a\n')
    writeFileSync(join(dir, 'shell-delete.txt'), 'b\n')
    writeFileSync(join(dir, 'git-delete.txt'), 'b2\n')
    writeFileSync(join(dir, 'oldname.txt'), 'c\n')
    writeFileSync(join(dir, 'русское имя.txt'), 'd\n')
    writeFileSync(join(dir, 'with space.txt'), 'e\n')
    // ПО ИМЕНАМ, никогда `-A` — тот же закон, что и в рабочем дереве.
    realGit(
      ['add', 'modify.txt', 'shell-delete.txt', 'git-delete.txt', 'oldname.txt', 'русское имя.txt', 'with space.txt'],
      { cwd: dir },
    )
    realGit(['commit', '-qm', 'base'], { cwd: dir })
    const base = realGit(['rev-parse', 'HEAD'], { cwd: dir }).trim()

    writeFileSync(join(dir, 'modify.txt'), 'a2\n')
    writeFileSync(join(dir, 'added.txt'), 'new\n')
    writeFileSync(join(dir, 'русское имя.txt'), 'd2\n')
    writeFileSync(join(dir, 'with space.txt'), 'e2\n')
    rmSync(join(dir, 'shell-delete.txt')) // ОБОЛОЧКОЙ: ни один инструмент правки этого не видит
    realGit(['rm', '-q', 'git-delete.txt'], { cwd: dir })
    realGit(['mv', 'oldname.txt', 'newname.txt'], { cwd: dir })
    realGit(['add', 'modify.txt', 'added.txt', 'русское имя.txt', 'with space.txt', 'shell-delete.txt'], { cwd: dir })
    realGit(['commit', '-qm', 'work'], { cwd: dir })
    return { dir, base }
  }

  const pathsOf = (r: { files: Array<{ path: string }> }) => r.files.map((f) => f.path).sort()
  const statusOf = (r: { files: Array<{ status: string; path: string }> }, path: string) =>
    (r.files.find((f) => f.path === path) || { status: null }).status

  it('изменённые файлы: изменение, добавление и удаление, сделанное ОБОЛОЧКОЙ, приходят все', () => {
    const { dir, base } = worldRepo()
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    expect(pathsOf(r)).toContain('modify.txt')
    expect(pathsOf(r)).toContain('added.txt')
    expect(pathsOf(r)).toContain('shell-delete.txt')
    expect(statusOf(r, 'modify.txt')).toBe('M')
    expect(statusOf(r, 'added.txt')).toBe('A')
    expect(statusOf(r, 'shell-delete.txt')).toBe('D')
    expect(r.answered).toBe(true)
  })

  it('изменённые файлы: исчезнувшие пути лежат ОТДЕЛЬНЫМ списком — «удалён» и «изменён» разные новости', () => {
    const { dir, base } = worldRepo()
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    expect(r.deletions).toContain('shell-delete.txt')
    expect(r.deletions).toContain('git-delete.txt')
    expect(r.deletions).not.toContain('modify.txt')
    expect(r.deletions).not.toContain('added.txt')
  })

  it('изменённые файлы: переименование приходит ТРЕМЯ записями, и старая сторона считается исчезнувшей', () => {
    const { dir, base } = worldRepo()
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    const renamed = r.files.find((f) => f.path === 'newname.txt')
    expect(renamed).toBeTruthy()
    expect(String(renamed.status).startsWith('R')).toBe(true)
    expect(renamed.from).toBe('oldname.txt')
    // Человек, читающий откат, обязан увидеть, что oldname.txt исчез.
    expect(r.deletions).toContain('oldname.txt')
    // …и НЕ увидеть его среди путей, которые всё ещё существуют.
    expect(pathsOf(r)).not.toContain('oldname.txt')
  })

  it('изменённые файлы: русское имя читаемо КАК ЕСТЬ, без восьмеричных последовательностей', () => {
    const { dir, base } = worldRepo()
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    expect(pathsOf(r)).toContain('русское имя.txt')
    const raw = JSON.stringify(r.files)
    expect(/\\3[0-9]{2}/.test(raw)).toBe(false)
  })

  it('изменённые файлы: имя с пробелом внутри не разваливается на два', () => {
    const { dir, base } = worldRepo()
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    expect(pathsOf(r)).toContain('with space.txt')
    expect(pathsOf(r)).not.toContain('with')
  })

  it('изменённые файлы: копирование — та же трёхзаписная форма, что и переименование', () => {
    const dir = newRepo('sma-changed-copy-')
    writeFileSync(join(dir, 'source.txt'), 'x'.repeat(400) + '\n')
    realGit(['add', 'source.txt'], { cwd: dir })
    realGit(['commit', '-qm', 'base'], { cwd: dir })
    const base = realGit(['rev-parse', 'HEAD'], { cwd: dir }).trim()
    // Обнаружение копий включается настройкой ПОДКЛЮЧЁННОГО проекта — не нашей. Разбор
    // обязан пережить её: иначе одна лишняя запись сдвинет разбор и имя файла станет статусом.
    realGit(['config', 'diff.renames', 'copies'], { cwd: dir })
    writeFileSync(join(dir, 'copy.txt'), 'x'.repeat(400) + '\n')
    realGit(['add', 'copy.txt'], { cwd: dir })
    realGit(['commit', '-qm', 'copied'], { cwd: dir })
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    const copied = r.files.find((f) => f.path === 'copy.txt')
    expect(copied).toBeTruthy()
    expect(/^[CA]/.test(String(copied.status))).toBe(true)
    // Копирование НИЧЕГО не уносит: источник на месте, значит в исчезнувших его нет.
    expect(r.deletions).not.toContain('source.txt')
  })

  it('изменённые файлы: список длиннее потолка обрезан ОДНОЙ константой, а перебор посчитан честно', () => {
    const dir = newRepo('sma-changed-cap-')
    writeFileSync(join(dir, 'seed.txt'), 's\n')
    realGit(['add', 'seed.txt'], { cwd: dir })
    realGit(['commit', '-qm', 'base'], { cwd: dir })
    const base = realGit(['rev-parse', 'HEAD'], { cwd: dir }).trim()
    const many = ATTEMPT_FILES_CAP + 7
    const names: string[] = []
    for (let i = 0; i < many; i += 1) {
      const n = `f${String(i).padStart(4, '0')}.txt`
      names.push(n)
      writeFileSync(join(dir, n), `${i}\n`)
    }
    realGit(['add', ...names], { cwd: dir })
    realGit(['commit', '-qm', 'many'], { cwd: dir })
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    expect(r.files.length).toBe(ATTEMPT_FILES_CAP)
    expect(r.filesOverflow).toBe(7)
  })

  it('изменённые файлы: удаления считают свой перебор ОТДЕЛЬНО — молча урезанное удаление тут запрещено', () => {
    const dir = newRepo('sma-changed-delcap-')
    const many = ATTEMPT_FILES_CAP + 3
    const names: string[] = []
    for (let i = 0; i < many; i += 1) {
      const n = `d${String(i).padStart(4, '0')}.txt`
      names.push(n)
      writeFileSync(join(dir, n), `${i}\n`)
    }
    realGit(['add', ...names], { cwd: dir })
    realGit(['commit', '-qm', 'base'], { cwd: dir })
    const base = realGit(['rev-parse', 'HEAD'], { cwd: dir }).trim()
    for (const n of names) rmSync(join(dir, n))
    realGit(['add', ...names], { cwd: dir })
    realGit(['commit', '-qm', 'swept'], { cwd: dir })
    const r = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', dir)
    expect(r.deletions.length).toBe(ATTEMPT_FILES_CAP)
    expect(r.deletionsOverflow).toBe(3)
  })

  it('изменённые файлы: fail-open — нет шва, нет базы, git отказал → причина словами, никогда исключение', () => {
    const { dir, base } = worldRepo()
    const noSeam = changedFilesOnBranch({}, base, 'HEAD', dir)
    expect(noSeam.files).toEqual([])
    expect(noSeam.answered).toBe(false)
    expect(String(noSeam.reason)).toContain('git')

    const noBase = changedFilesOnBranch({ execGit: realGit }, null, 'HEAD', dir)
    expect(noBase.answered).toBe(false)
    expect(noBase.deletions).toEqual([])

    const noCopy = changedFilesOnBranch({ execGit: realGit }, base, 'HEAD', null)
    expect(noCopy.answered).toBe(false)

    const angry = changedFilesOnBranch(
      {
        execGit: () => {
          throw new Error('fatal: ambiguous argument')
        },
      },
      base,
      'HEAD',
      dir,
    )
    expect(angry.answered).toBe(false)
    expect(String(angry.reason)).toContain('fatal')
  })

  it('изменённые файлы: усечённый ответ обрывает разбор и НЕ бросает; незнакомый статус кладётся как есть', () => {
    // Запись без имени — ровно то, что приходит от оборванного чтения потока.
    const truncated = changedFilesOnBranch(
      { execGit: () => ['M', 'modify.txt', 'R100', 'oldname.txt'].join(NUL) + NUL },
      'b',
      'HEAD',
      '/tmp/x',
    )
    expect(truncated.files.map((f) => f.path)).toEqual(['modify.txt'])
    const weird = changedFilesOnBranch(
      { execGit: () => ['T', 'typechange.txt', 'U', 'conflicted.txt', ''].join(NUL) },
      'b',
      'HEAD',
      '/tmp/x',
    )
    expect(weird.files.map((f) => f.status)).toEqual(['T', 'U'])
    expect(weird.deletions).toEqual([])
  })

  it('изменённые файлы: запасной путь — ответ БЕЗ нулевых байтов разбирается по строкам и табу', () => {
    // На случай сборки git, где `-z` не применилось: имена всё равно читаемы, потому что
    // в вызове стоит выключенное квотирование путей.
    const legacy = changedFilesOnBranch(
      { execGit: () => 'M\tmodify.txt\nD\tgone.txt\nR100\told.txt\tnew.txt\n' },
      'b',
      'HEAD',
      '/tmp/x',
    )
    expect(legacy.files.map((f) => f.path)).toEqual(['modify.txt', 'gone.txt', 'new.txt'])
    expect(legacy.deletions).toEqual(['gone.txt', 'old.txt'])
  })

  it('изменённые файлы: вызов идёт с нулевыми разделителями и выключенным квотированием путей', () => {
    // Провод, а не намерение: аргументы, которыми на самом деле зовут git.
    let seen: string[] = []
    changedFilesOnBranch(
      {
        execGit: (args: string[]) => {
          seen = args
          return ''
        },
      },
      'basecommit',
      'wt/branch',
      '/tmp/x',
    )
    expect(seen).toContain('-z')
    expect(seen).toContain('core.quotepath=false')
    expect(seen).toContain('--name-status')
    expect(seen).toContain('basecommit..wt/branch')
    // Содержимое дифа в строку попытки не попадает НИКОГДА: строка durable, содержимое может нести секрет.
    expect(seen).not.toContain('-p')
    expect(seen).not.toContain('--patch')
  })
})

/**
 * ═══ ОСТАВШИЕСЯ БИЛЕТЫ ЗАКРЫВАЮТСЯ ВМЕСТЕ С ПОПЫТКОЙ ══════════════════════════════════════
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Не то, что функция пометки умеет помечать (это утверждает сьют
 * самого гейта), а ПРОВОД: тик, закрывая попытку, доходит до каталога её билетов. Дыра была
 * ровно такой формы — билет закрывают три пути, и все три пишет процесс хука; умер процесс, и
 * файл навсегда остаётся ожидающим, а карточка честно показывает «ждут вас» там, где уже
 * никто не ждёт.
 *
 * ГОНЯЕТСЯ НАСТОЯЩИЙ ТИК ПО НАСТОЯЩЕМУ ВРЕМЕННОМУ КАТАЛОГУ: билет кладёт на диск сам
 * порождённый процесс (как это делает хук), а утверждается файл НА ДИСКЕ после тика.
 */
describe('оставшиеся билеты попытки закрываются вместе с ней', () => {
  const ticketTmp: string[] = []
  const mkTicketDir = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    ticketTmp.push(d)
    return d
  }
  afterAll(() => {
    for (const d of ticketTmp) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* каталог, который не уходит, — не провал теста */
      }
    }
  })

  const runTickLeavingTicket = async (over: any = {}) => {
    const projectDir = mkTicketDir('sma-ticket-proj-')
    const ledgerDir = mkTicketDir('sma-ticket-ledger-')
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const runDir = attemptRunDir({ runsDir: runsDirOf(projectDir), attemptId: 'BL-1_1' })!
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      config: { repoDir: projectDir, pipeline: { enabled: true } },
      responses: {
        preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
        worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
        reverify: over.reverify ?? GREEN_REVERIFY,
      },
      // ХУК КЛАДЁТ БИЛЕТ И НЕ УСПЕВАЕТ ЕГО ЗАКРЫТЬ — процесс кончился раньше человека.
      spawnWorker: (spec: any) => {
        const dir = join(String((spec.env || {}).SMA_RUN_DIR || runDir), 'tickets')
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'tk-orphan.json'),
          JSON.stringify({
            schema: 'sma-ticket/1',
            id: 'tk-orphan',
            attemptId: 'BL-1_1',
            status: 'waiting',
            tool: 'Bash',
            command: 'npm publish',
            seenAt: new Date(c.clock()).toISOString(),
            deadlineAt: new Date(c.clock() + 3600000).toISOString(),
          }),
          'utf8',
        )
        spec.onLine?.('APPROACH_NOTE: прямой путь')
        spec.onLine?.('LESSON_NONE: тестовый работник')
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 7, kill: () => {} }
      },
      deps: { projectDir: () => projectDir, ledger: { recordAttempt: (r: any) => recordAttempt(ledgerDir, r), readAttempts: (id: string) => readAttempts(ledgerDir, id) } },
    })

    const res = await tick(deps)
    return { res, runDir, clock: c }
  }

  it('оставшиеся билеты: на успешном исходе билет умершего хука перестаёт быть ожидающим', async () => {
    const { runDir, clock } = await runTickLeavingTicket()

    const onDisk = JSON.parse(readFileSync(join(runDir, 'tickets', 'tk-orphan.json'), 'utf8'))
    expect(onDisk.status, 'билет остался «ждут вас» после конца попытки').not.toBe('waiting')
    expect(readWaitingTicket({ runDir, clock: clock.clock })).toBe(null)
  })

  it('оставшиеся билеты: на провальном исходе — то же самое, и по той же одной двери', async () => {
    const { runDir, clock } = await runTickLeavingTicket({ reverify: { code: 1, stdout: JSON.stringify({ verdict: 'red' }) } })

    const onDisk = JSON.parse(readFileSync(join(runDir, 'tickets', 'tk-orphan.json'), 'utf8'))
    expect(onDisk.status).not.toBe('waiting')
    expect(readWaitingTicket({ runDir, clock: clock.clock })).toBe(null)
  })
})

/**
 * ═══ ПРОВОД: ТИК ОТДАЁТ РЕЕСТР РУЧЕК СТОРОЖУ ЖИВОСТИ ════════════════════════════════════════
 *
 * ЗДЕСЬ И РВАЛАСЬ СВЯЗЬ. Сторож живости зовёт ровно один вызов во всём продукте — вот этот,
 * шагом (1) тика. Сколько бы кода ни было написано в самом стороже, без реестра ручек В ЭТОМ
 * ВЫЗОВЕ он остаётся вычисленным и никуда не подключённым: объявляет смерть, перевыдаёт задачу
 * и не может тронуть живого ребёнка, потому что ручки ему не дали.
 *
 * ПОЭТОМУ ДЕЛО УТВЕРЖДАЕТ ПЕРЕДАЧУ, А НЕ НАЛИЧИЕ. Не «реестр где-то есть», а «в аргументы
 * подметания приехал ТОТ САМЫЙ объект из зависимостей цикла» — и наблюдается это тем, что
 * остановку дёрнули на нём самом.
 */
describe('тик отдаёт реестр ручек сторожу живости', () => {
  it('hands the kill-handle registry to the liveness sweep — и это тот самый объект из зависимостей цикла', async () => {
    const c = mkClock()
    // Срок у самой очереди намеренно ДЛИННЫЙ, а у подметания короткий: у памятной очереди есть
    // собственное истечение аренды, и с равными сроками она вернула бы строку в очередь сама —
    // сторожу было бы нечего находить, и дело доказывало бы не провод, а её внутреннюю уборку.
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 10_000_000 })
    await adapter.enqueue(backlogTask())
    await adapter.claimNext('daemon', {}) // задача у работника, аренда взята

    const seen: any[] = []
    const attemptTurns = {
      stop(taskId: string) {
        seen.push({ taskId, self: this })
        return true
      },
    }
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      // ОДИН И ТОТ ЖЕ срок у аренды и у подметания: две величины на один вопрос не спорят
      config: { expireMs: 300000 },
      deps: { attemptTurns },
    })
    c.advance(500000) // работник замолчал — аренда протухла

    await tick(deps)

    expect(seen, 'реестр ручек не доехал до аргументов подметания живости').toHaveLength(1)
    expect(seen[0].taskId).toBe('BL-1')
    expect(seen[0].self, 'подметанию достался ДРУГОЙ реестр, а не тот, что лежит в зависимостях цикла').toBe(attemptTurns)
  })

  it('тик без реестра подметает как прежде — коллаборатор необязателен, как и журнал', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 10_000_000 }) // см. оговорку выше
    await adapter.enqueue(backlogTask())
    await adapter.claimNext('daemon', {})

    const { deps, journalled } = makeDeps({ adapter, clockObj: c, config: { expireMs: 300000 } })
    c.advance(500000)

    const res = await tick(deps)

    expect(res.sweep.requeued).toBe(1) // задача перевыдана и без всякой ручки
    expect(journalled.some((e: any) => e.type === 'sweep-error')).toBe(false)
  })
})

// ══════════ ЖЕТОН ЗАХВАТА ДОЕЗЖАЕТ ДО ТРЁХ ШВОВ ЗАВЕРШЕНИЯ ═══════════════════
//
// Очередь научилась отвергать чужой жетон раньше — и это не меняло НИЧЕГО, пока цикл
// жетона не носил. Между захватом и завершением аренда может истечь, очередь перевыдаёт
// строку, а работник первой попытки в конце зовёт завершение по одному лишь имени задачи
// и закрывает ЧУЖУЮ, вторую попытку. Дыра закрывается не умением очереди отказывать, а
// ПРОВОДОМ: значение, которое вернул захват, обязано оказаться в аргументах вызова.
//
// Поэтому дела ниже НЕ спрашивают «есть ли где-то жетон». Они сверяют РОВНО то значение,
// которое очередь выдала ЭТОМУ захвату, с тем, что доехало до шва. Дело вида «жетон
// какой-то есть» было бы зелёным и в тот день, когда никуда ничего не доезжало, — а
// именно такой день и стоил суток разбора.
//
// Очередь здесь НАСТОЯЩАЯ (памятная, эталонная), а не подделка: жетон чеканит она сама, и
// сверяемое значение приходит из живого объекта. Подделка, чеканящая жетон по-своему,
// удостоверяла бы собственное отличие вместо поведения продукта.

/**
 * Записывающая обёртка НАД настоящей очередью: каждый вызов уходит внутрь без изменений,
 * а его аргументы запоминаются. Ничего не подменяется — иначе доказывался бы не провод
 * цикла, а сообразительность обёртки.
 */
function recordingQueue(inner: any) {
  const seen = { claimed: [] as any[], calls: [] as any[] }
  return {
    ...inner,
    seen,
    async claimNext(workerId: string, opts: any) {
      const t = await inner.claimNext(workerId, opts)
      if (t) seen.claimed.push(t)
      return t
    },
    async touch(id: string, opts?: any) {
      seen.calls.push({ op: 'touch', id, opts })
      return inner.touch(id, opts)
    },
    async complete(id: string, result: any) {
      seen.calls.push({ op: 'complete', id, result })
      return inner.complete(id, result)
    },
    async fail(id: string, reason: string, opts?: any) {
      seen.calls.push({ op: 'fail', id, reason, opts })
      return inner.fail(id, reason, opts)
    },
  }
}

const TOKEN_RESPONSES = () => ({
  preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
  worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
  reverify: GREEN_REVERIFY,
})

describe('жетон, выданный захватом, доезжает до всех трёх швов завершения', () => {
  it('ЗАВЕРШЕНИЕ предъявляет ровно тот жетон, который вернул захват', async () => {
    const c = mkClock()
    const inner = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await inner.enqueue(backlogTask())
    const adapter = recordingQueue(inner)
    const { deps } = makeDeps({ adapter, clockObj: c, responses: TOKEN_RESPONSES() })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const claimed = adapter.seen.claimed[0]
    expect(typeof claimed.attemptToken, 'захват не выдал жетона вовсе').toBe('string')
    expect(claimed.attemptToken.length).toBeGreaterThan(15)
    const done = adapter.seen.calls.find((x: any) => x.op === 'complete')
    expect(done, 'цикл не звал завершения').toBeTruthy()
    expect(done.result.attemptToken, 'жетон захвата не доехал до завершения').toBe(claimed.attemptToken)
  })

  it('ПРОВАЛ предъявляет тот же жетон — иначе чужой работник рвёт живую попытку', async () => {
    const c = mkClock()
    const inner = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await inner.enqueue(backlogTask())
    const adapter = recordingQueue(inner)
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      responses: TOKEN_RESPONSES(),
      // работник отработал и не оставил записки — попытка закрывается провалом
      spawnWorker: makeSpawnWorker(undefined, { lines: ['stream line'] }),
    })

    const res = await tick(deps)

    expect(res.failed && res.failed.taskId).toBe('BL-1')
    const claimed = adapter.seen.claimed[0]
    const failed = adapter.seen.calls.find((x: any) => x.op === 'fail')
    expect(failed, 'цикл не звал провала').toBeTruthy()
    expect(failed.opts && failed.opts.attemptToken, 'жетон захвата не доехал до провала').toBe(claimed.attemptToken)
  })

  it('ПРОДЛЕНИЕ предъявляет тот же жетон — продлевать чужую аренду не за что', async () => {
    const c = mkClock()
    const inner = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await inner.enqueue(backlogTask())
    const adapter = recordingQueue(inner)
    const { deps } = makeDeps({ adapter, clockObj: c, responses: TOKEN_RESPONSES() })

    await tick(deps)

    const claimed = adapter.seen.claimed[0]
    const touched = adapter.seen.calls.find((x: any) => x.op === 'touch')
    expect(touched, 'цикл не продлевал аренду вовсе').toBeTruthy()
    expect(touched.opts && touched.opts.attemptToken, 'жетон захвата не доехал до продления').toBe(claimed.attemptToken)
  })

  it('строка БЕЗ жетона (посеяна до этого обновления) — цикл зовёт швы как раньше и не падает', async () => {
    // `oneTaskAdapter` выдаёт задачу, собранную руками: жетона у неё нет, как у строки,
    // захваченной прошлой версией продукта. Отсутствие есть отсутствие — не повод падать
    // на живой очереди и не лицензия жетон выдумать.
    const adapter = oneTaskAdapter(backlogTask({ attempt: 1 }))
    const { deps } = makeDeps({ adapter, responses: TOKEN_RESPONSES() })

    const res = await tick(deps)

    expect(res.completed).toBe('BL-1')
    const [call] = adapter.calls
    expect(call.op).toBe('complete')
    expect(call.result.attemptToken).toBeUndefined()
  })
})

// ══════ КОПИЯ ПОПЫТКИ СТОИТ В КАТАЛОГЕ ОТ ЗАДАЧИ — В ОБЕИХ ДВЕРЯХ ПРОВИЗИИ ═════
//
// Ветка копии всегда была своя у каждой задачи, а КАТАЛОГ — один: верб, если ему не сказать
// пути, строит его из identity того, кто зовёт, а у демона она одна на всё время жизни
// процесса и на все задачи сразу. N веток претендовали на один каталог. Пока копия жива и
// зарегистрирована, соседняя задача переиспользовала её молча; стоило копии осиротеть
// (демон убит, регистрация потеряна) — каждая следующая провизия отвечала «уже существует»,
// попытка умирала ДО запуска, и в журнал это ложилось как «среда исполнения недоступна».
// Замерено прошлой фазой: одна брошенная копия держала конвейер мёртвым почти два часа, и
// сам он из этого не вышел — каждая задача сжигала отпущенные повторы об один и тот же
// каталог и закрывалась навсегда.
//
// Дверей провизии ДВЕ — путь кода-работы и путь Творца, — и правка одной оставляет мину во
// второй: этот класс уже дважды стоил тому же файлу отдельного разбора. Поэтому дело есть
// на КАЖДУЮ дверь, а не одно «на провизию».
//
// ПОДДЕЛКА ВЕРБА ВЕДЁТ СЕБЯ КАК ВЕРБ: сказали путь — отвечает им, не сказали — строит свой
// от identity, одинаковой на все задачи. Подделка, всегда отвечающая путём от задачи,
// удостоверяла бы собственную сообразительность вместо поведения продукта.

/** Identity зовущего — одна на все задачи, как у живого демона. */
const FAKE_CALLER_IDENTITY = 'c-один-на-всех'

function fakeWorktreeAnswer(argsArray: string[]) {
  const p = argsArray.indexOf('--path')
  const b = argsArray.indexOf('--branch')
  return {
    ok: true,
    path: p >= 0 ? argsArray[p + 1] : join('/', '.sma-worktrees', FAKE_CALLER_IDENTITY),
    branch: b >= 0 ? argsArray[b + 1] : null,
    expectedBase: 'a'.repeat(40),
  }
}

/** Раннер, записывающий ПОЛНЫЕ аргументы каждого верба: провод проверяется по ним. */
function copyPathRunner() {
  const provisions: string[][] = []
  const removals: string[][] = []
  const runner = async (_bin: string, argsArray: string[]) => {
    const verb = argsArray[1]
    const sub = argsArray[2]
    if (verb === 'worktree' && sub === 'provision') {
      provisions.push(argsArray)
      return { code: 0, stdout: JSON.stringify(fakeWorktreeAnswer(argsArray)) }
    }
    if (verb === 'worktree' && sub === 'remove') {
      removals.push(argsArray)
      return { code: 0, stdout: JSON.stringify({ ok: true, path: argsArray[3], branch: 'wt/x', branchTip: 'c'.repeat(40) }) }
    }
    if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ worktrees: [] }) }
    if (verb === 'reverify') return GREEN_REVERIFY
    if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
    return { code: 0, stdout: '{}' }
  }
  return { runner, provisions, removals }
}

/** Значение флага пути в записанном вызове верба, либо null — флага не было вовсе. */
function pathFlagOf(argsArray: string[]) {
  const i = argsArray.indexOf('--path')
  return i >= 0 ? argsArray[i + 1] : null
}

/** Последний сегмент пути в обоих начертаниях разделителя — на Windows приходят оба. */
function lastSegmentOf(p: string) {
  const parts = String(p).split(/[\\/]+/)
  return parts[parts.length - 1]
}

// Настоящий git отвечать не обязан: важно, что вопрос об основании задаётся ЧЕРЕЗ него, и
// ответ детерминирован. Ровно так же отвечает верб, когда git молчит.
const fakeExecGit = (args: string[]) => (args[0] === 'rev-parse' && args[1] === '--git-common-dir' ? '/repo/.git' : '')

describe('копия попытки провизионируется в каталог ОТ ЗАДАЧИ — в обеих дверях', () => {
  it('ОСНОВНАЯ дверь (код-работа) зовёт верб с явным путём, выведенным из имени задачи', async () => {
    const rec = copyPathRunner()
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1 }))
    const { deps } = makeDeps({ adapter, verbRunner: rec.runner, deps: { execGit: fakeExecGit } })

    await tick(deps)

    expect(rec.provisions, 'основная дверь не провизионировала копию вовсе').toHaveLength(1)
    const p = pathFlagOf(rec.provisions[0])
    expect(p, 'основная дверь не передала вербу пути — каталог остаётся один на все задачи').toBeTruthy()
    expect(lastSegmentOf(String(p))).toBe('wt-BL-1')
    // Уборка трогает ТОЛЬКО каталог копий: путь, который она не признает своим, она удалять
    // откажется — значит провизия обязана класть копию именно туда.
    expect(insideCopiesDir(String(p)), 'провизия положила копию туда, где уборке трогать нечего').toBe(true)
  })

  it('дверь ТВОРЦА зовёт верб с явным путём той же формы — забытая вторая дверь и есть мина', async () => {
    const rec = copyPathRunner()
    const adapter = oneTaskAdapter({
      id: 'F-1',
      source: 'roster',
      title: 'сделай агента, который парсит ленту',
      lane: 'forge',
      forge: { kind: 'agent', description: 'парсит ленту по метке и пишет сводку' },
    })
    const { deps } = makeDeps({
      adapter,
      verbRunner: rec.runner,
      config: { workers: [{ id: 'creator', lane: 'forge', provider: 'claude', account: { configDir: '/creator' }, enabled: true }] },
      deps: { execGit: fakeExecGit },
    })

    await tick(deps)

    expect(rec.provisions, 'дверь Творца не провизионировала копию вовсе').toHaveLength(1)
    const p = pathFlagOf(rec.provisions[0])
    expect(p, 'дверь Творца не передала вербу пути — мина осталась во второй двери').toBeTruthy()
    expect(lastSegmentOf(String(p))).toBe('wt-F-1')
    expect(insideCopiesDir(String(p))).toBe(true)
  })

  it('две разные задачи — два разных каталога; та же задача — тот же каталог', async () => {
    const one = copyPathRunner()
    await tick(makeDeps({ adapter: oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1 })), verbRunner: one.runner, deps: { execGit: fakeExecGit } }).deps)
    const two = copyPathRunner()
    await tick(makeDeps({ adapter: oneTaskAdapter(backlogTask({ id: 'BL-2', attempt: 1 })), verbRunner: two.runner, deps: { execGit: fakeExecGit } }).deps)
    // Повтор ТОЙ ЖЕ задачи — отдельный тик с тем же именем: готовая среда повтору не
    // отнимается, путь и ветка совпадают, и верб переиспользует копию честно.
    const again = copyPathRunner()
    await tick(makeDeps({ adapter: oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 2 })), verbRunner: again.runner, deps: { execGit: fakeExecGit } }).deps)

    const a = pathFlagOf(one.provisions[0])
    const b = pathFlagOf(two.provisions[0])
    const a2 = pathFlagOf(again.provisions[0])
    expect(a, 'путь не передан — сравнивать нечего').toBeTruthy()
    expect(a).not.toBe(b)
    expect(a2).toBe(a)
  })

  it('УБОРКА снимает РОВНО тот каталог, который положила провизия — по путям, не по намерениям', async () => {
    const rec = copyPathRunner()
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1 }))
    const { deps, attempts } = makeDeps({ adapter, verbRunner: rec.runner, deps: { execGit: fakeExecGit } })

    await tick(deps)
    const provisioned = pathFlagOf(rec.provisions[0])

    const res = await cleanupTaskWorktree({
      taskId: 'BL-1',
      by: 'approve',
      projectDir: '/repo',
      ledger: deps.ledger,
      verbRunner: rec.runner,
    })

    // Строка попытки несёт путь, который ОТВЕТИЛ верб, а уборка удаляет то, что в строке.
    expect(attempts.find((a: any) => a.worktreePath)?.worktreePath).toBe(provisioned)
    expect(res.removed, `уборка отказалась: ${res.reason ?? ''}`).toBe(true)
    expect(rec.removals, 'уборка не звала верба удаления').toHaveLength(1)
    expect(rec.removals[0][3], 'уборка целилась не в тот каталог, который положила провизия').toBe(provisioned)
  })
})

/**
 * БАЗА СРАВНЕНИЯ У ПЕРЕИСПОЛЬЗОВАННОЙ КОПИИ.
 *
 * Когда верб не называет основания (замерено 12.08.2026: переиспользованная копия отвечает
 * `base=нет reused=true expected=нет actual=нет`), цикл спрашивал у git вершину ПРОЕКТА.
 * На первой попытке это верно — копию только что отвели оттуда. На ПОВТОРЕ проект успевает
 * уехать вперёд, и тогда «база» указывает не туда, где ветку отвели: счёт коммитов ловит
 * чужую историю, и в квитанцию приёмки едут работы, которых попытка не делала. Замерено
 * тем же днём: попытка, не тронувшая ни одного файла, получила квитанцию на три коммита
 * и одно исчезновение файла.
 *
 * Спрашивать надо ТОЧКУ ОТВОДА — там, где ветка задачи разошлась с проектом. На первой
 * попытке это ровно вершина проекта, на повторе — по-прежнему место отвода.
 */
describe('база сравнения у переиспользованной копии — точка отвода, а не уехавшая вершина', () => {
  const CUT = 'a'.repeat(40) // где стоял проект, когда копию отводили
  const MOVED = 'f'.repeat(40) // куда проект уехал с тех пор

  /** Верб отвечает БЕЗ основания — так отвечает переиспользованная копия. */
  const noBaseRunner = async (_bin: string, argsArray: string[]) => {
    const verb = argsArray[1]
    const sub = argsArray[2]
    if (verb === 'worktree' && sub === 'provision') {
      const b = argsArray.indexOf('--branch')
      const p = argsArray.indexOf('--path')
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          reused: true,
          path: p >= 0 ? argsArray[p + 1] : '/wt/BL-1',
          branch: b >= 0 ? argsArray[b + 1] : 'wt/BL-1',
        }),
      }
    }
    if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ worktrees: [] }) }
    if (verb === 'reverify') return GREEN_REVERIFY
    if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
    return { code: 0, stdout: '{}' }
  }

  /** Проект уехал: его вершина и точка отвода — РАЗНЫЕ ответы, и их видно по вопросу. */
  const movedProjectGit = (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/repo/.git'
    if (args[0] === 'merge-base') return CUT
    if (args[0] === 'rev-parse') return MOVED
    return ''
  }

  it('база берётся из точки отвода — вершина уехавшего проекта даёт чужие коммиты в квитанции', async () => {
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 2 }))
    const { deps, journalled } = makeDeps({ adapter, verbRunner: noBaseRunner, deps: { execGit: movedProjectGit } })
    await tick(deps)
    const line = journalled.find((e: any) => e.type === 'task.worktree_base')
    expect(line, 'строка об основании копии обязана быть записана').toBeTruthy()
    expect(line.base, 'база обязана быть ТОЧКОЙ ОТВОДА, а не вершиной уехавшего проекта').toBe(CUT)
  })
})

/**
 * ПОТОЛОК ОДНОВРЕМЕННЫХ ПОПЫТОК.
 *
 * Тик заводится таймером и вызывается БЕЗ ожидания предыдущего прохода, а каждый проход берёт
 * задачу и ведёт её до конца — значит попытки идут внахлёст по устройству. Регулятора не было
 * ни одного: поиск по исходникам не давал ни счётчика идущих, ни признака занятости. Пол под
 * происшествием 12.08.2026, когда три параллельных процесса жгли подписку при пустой доске.
 *
 * Третье дело здесь — главное, и оно родилось из ошибки в первой редакции этой самой правки:
 * место бралось ПОСЛЕ захвата, а захват — это await. Два тика внахлёст оба видели пустой дом
 * и оба брали по задаче. Дело гоняет ровно этот случай на НАСТОЯЩЕМ доме.
 */
import { createInFlight } from '../src/queue/in-flight.mjs'

describe('потолок одновременных попыток — тик не берёт задачу сверх него', () => {
  const fullHouse = { reserve: () => null, size: () => 1, workers: () => new Set<string>(), name() {}, release() {} }
  const freeHouse = { reserve: () => 'seat-1', size: () => 0, workers: () => new Set<string>(), name() {}, release() {} }

  it('при достигнутом потолке очередь вообще не спрашивается', async () => {
    const base = oneTaskAdapter(backlogTask({ id: 'BL-1' }))
    let claims = 0
    const counting: any = {
      ...base,
      async claimNext(...args: any[]) {
        claims += 1
        return (base as any).claimNext(...args)
      },
    }
    const { deps } = makeDeps({ adapter: counting, deps: { inFlight: fullHouse } })
    const r = await tick(deps)
    expect(claims, 'при достигнутом потолке очередь спрашивать нельзя — иначе попытка уже выдана').toBe(0)
    expect(r.idle, 'проход при достигнутом потолке — это простой, а не работа').toBe(true)
  })

  /**
   * ОТКАЗ В МЕСТЕ ВИДЕН ЧЕЛОВЕКУ, А НЕ ТОЛЬКО ЖУРНАЛУ ДЕМОНА.
   *
   * Отказ в месте — единственное решение, из-за которого задача не едет при полной тишине во
   * всех остальных списках: очередь не двинулась, работник не сменил занятость, ни одна строка
   * не поменяла состояния. Пока он жил только в журнале, снаружи «потолок держит» было
   * неотличимо от «конвейер сломался» — и ошибку в настройке потолка нечем было уличить.
   *
   * Дело проверяет ПРОВОД: кадр уходит в переданный шов, несёт оба числа, и потолок в нём —
   * прочитанная настройка, а не выдуманное число. Соседние дела шва не передают вовсе и
   * проходят тот же путь — звонок в никуда не имеет права уронить проход.
   */
  it('при полном доме отказ в месте уходит в живой поток, а не только в журнал', async () => {
    const frames: any[] = []
    const { deps, journalled } = makeDeps({
      adapter: oneTaskAdapter(backlogTask({ id: 'BL-3' })),
      config: { maxConcurrentAttempts: 2 },
      deps: { inFlight: fullHouse, emitEvent: (f: any) => frames.push(f) },
    })
    const r = await tick(deps)

    expect(r.idle, 'проход при полном доме — простой').toBe(true)
    expect(
      journalled.some((e: any) => e.type === 'tick.concurrency_cap'),
      'журнал демона обязан продолжать записывать отказ — живой поток его не заменяет',
    ).toBe(true)
    const bell = frames.find((f: any) => f.event === 'seats.full')
    expect(bell, 'отказ в месте обязан звонить в живой поток — иначе снаружи это немая остановка').toBeTruthy()
    expect(bell, 'кадр обязан нести оба числа: сколько занято и сколько мест всего').toMatchObject({
      event: 'seats.full',
      inFlight: 1,
      cap: 2,
    })
  })

  it('при свободном месте потолок не мешает — задача берётся как обычно', async () => {
    const base = oneTaskAdapter(backlogTask({ id: 'BL-2' }))
    let claims = 0
    const counting: any = {
      ...base,
      async claimNext(...args: any[]) {
        claims += 1
        return (base as any).claimNext(...args)
      },
    }
    const { deps } = makeDeps({ adapter: counting, deps: { inFlight: freeHouse } })
    await tick(deps)
    expect(claims, 'свободное место обязано пропускать работу').toBe(1)
  })

  it('ДВА ПРОХОДА ВНАХЛЁСТ на настоящем доме берут ОДНУ задачу, а не две', async () => {
    // Очередь отдаёт разные задачи и считает выдачи: если потолок держится, вторая выдача
    // не случится вовсе. Захват намеренно асинхронный — ровно как настоящий.
    let handed = 0
    const adapter: any = {
      async list() {
        return []
      },
      async claimNext() {
        await new Promise((r) => setTimeout(r, 5))
        handed += 1
        return handed <= 2 ? backlogTask({ id: `BL-${handed}` }) : null
      },
      async complete() {},
      async fail() {},
      async touch() {},
      async stats() {
        return {}
      },
    }
    const house = createInFlight()
    const { deps } = makeDeps({ adapter, deps: { inFlight: house } })
    const [a, b] = await Promise.all([tick(deps), tick(deps)])
    expect(handed, 'очередь спрошена дважды — потолок не удержал два прохода внахлёст').toBe(1)
    const idle = [a, b].filter((r: any) => r && r.idle === true)
    expect(idle.length, 'один из двух проходов обязан стать простоем по потолку').toBe(1)
    expect(house.size(), 'после обоих проходов дом обязан опустеть — иначе конвейер встанет молча').toBe(0)
  })
})

/**
 * ═══ СНИМОК КОНТЕКСТА И ВСТРОЕННЫЕ НАВЫКИ ЛОЖАТСЯ В РАБОЧУЮ КОПИЮ ═══════════════
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ — ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ. Снимок уже живёт на строке очереди и
 * доезжает до захваченной задачи; тексты трёх навыков уже лежат замороженным списком; право
 * их вызвать уже стоит в аргументах спавна. Ни одно из трёх не превращается в файл, который
 * работник может открыть, — и пока не превратится, все три зелены и не подключены ни к чему.
 *
 * ДВЕРЕЙ ПРОВИЗИИ ДВЕ, и забытая вторая — мина, уже стоившая этому файлу отдельного разбора:
 * основной путь кода-работы и путь Творца. Правка одной оставляет вторую немой, и грепу
 * имени модуля это незаметно. Поэтому дело есть на КАЖДУЮ дверь.
 *
 * КОПИЯ ЗДЕСЬ — НАСТОЯЩИЙ КАТАЛОГ ВО ВРЕМЕННОМ МЕСТЕ, и верб отвечает именно им. Подделка,
 * отвечающая выдуманным путём, удостоверяла бы, что мы умеем позвать функцию, а не что файл
 * оказался там, куда работник придёт его читать.
 */

import { WORKER_SKILLS } from '../src/queue/worker-skills.mjs'

describe('снимок контекста и навыки материализуются в копию — обе двери провизии', () => {
  const matDirs: string[] = []
  const mkCopy = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-mat-'))
    matDirs.push(d)
    return d
  }
  afterAll(() => {
    for (const d of matDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  const SNAPSHOT = 'Что происходит вокруг задачи.\nВторая строка снимка — с переносом.'
  const CONTEXT_FILE = 'task_context.md'

  /** Верб, отвечающий НАСТОЯЩИМ каталогом на диске — ровно так отвечает живой. */
  const runnerAnswering = (copyDir: string) => async (_bin: string, argsArray: string[]) => {
    const verb = argsArray[1]
    const sub = argsArray[2]
    if (verb === 'worktree' && sub === 'provision') {
      const b = argsArray.indexOf('--branch')
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: copyDir,
          branch: b >= 0 ? argsArray[b + 1] : 'wt/BL-1',
          expectedBase: 'a'.repeat(40),
        }),
      }
    }
    if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ worktrees: [] }) }
    if (verb === 'reverify') return GREEN_REVERIFY
    if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
    return { code: 0, stdout: '{}' }
  }

  const forgeTask = (over: any = {}) => ({
    id: 'F-1',
    source: 'roster',
    title: 'сделай агента, который парсит ленту',
    lane: 'forge',
    forge: { kind: 'agent', description: 'парсит ленту по метке и пишет сводку' },
    ...over,
  })

  const forgeConfig = {
    workers: [{ id: 'creator', lane: 'forge', provider: 'claude', account: { configDir: '/creator' }, enabled: true }],
  }

  it('ОСНОВНАЯ дверь: снимок со строки лежит файлом в корне копии', async () => {
    const copy = mkCopy()
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1, taskContext: SNAPSHOT }))
    const { deps } = makeDeps({ adapter, verbRunner: runnerAnswering(copy) })

    await tick(deps)

    expect(existsSync(join(copy, CONTEXT_FILE)), 'работник открыл копию, а снимка там нет').toBe(true)
    expect(readFileSync(join(copy, CONTEXT_FILE), 'utf8')).toContain(SNAPSHOT)
  })

  it('дверь ТВОРЦА: та же материализация — забытая вторая дверь и есть мина', async () => {
    const copy = mkCopy()
    const adapter = oneTaskAdapter(forgeTask({ taskContext: SNAPSHOT }))
    const { deps } = makeDeps({ adapter, verbRunner: runnerAnswering(copy), config: forgeConfig })

    await tick(deps)

    expect(existsSync(join(copy, CONTEXT_FILE)), 'вторая дверь осталась немой').toBe(true)
    expect(readFileSync(join(copy, CONTEXT_FILE), 'utf8')).toContain(SNAPSHOT)
  })

  it('ОСВЕЖЕНИЕ: ретрай переиспользовал копию — файл несёт ТЕКУЩИЙ снимок, не прошлый', async () => {
    const copy = mkCopy()
    writeFileSync(join(copy, CONTEXT_FILE), 'СТАРЫЙ СНИМОК ПРОШЛОЙ ПОПЫТКИ', 'utf8')
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 2, taskContext: SNAPSHOT }))
    const { deps } = makeDeps({ adapter, verbRunner: runnerAnswering(copy) })

    await tick(deps)

    const text = readFileSync(join(copy, CONTEXT_FILE), 'utf8')
    expect(text, 'протухший снимок остался и врёт попытке о том, чего человек уже не просит').not.toContain('СТАРЫЙ СНИМОК')
    expect(text).toContain(SNAPSHOT)
  })

  it('снимок СНЯТ со строки — протухший файл удалён, и удаление названо в журнале', async () => {
    const copy = mkCopy()
    writeFileSync(join(copy, CONTEXT_FILE), 'СТАРЫЙ СНИМОК ПРОШЛОЙ ПОПЫТКИ', 'utf8')
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 2 }))
    const { deps, journalled } = makeDeps({ adapter, verbRunner: runnerAnswering(copy) })

    await tick(deps)

    expect(existsSync(join(copy, CONTEXT_FILE)), 'снятый снимок остался файлом в копии').toBe(false)
    expect(
      journalled.find((e: any) => e.type === 'task.task_context_removed'),
      'удаление существующего файла обязано оставить след',
    ).toBeTruthy()
  })

  it('снимка нет и файла не было — файл НЕ появляется (пустышка соврала бы)', async () => {
    const copy = mkCopy()
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1 }))
    const { deps } = makeDeps({ adapter, verbRunner: runnerAnswering(copy) })

    await tick(deps)

    expect(existsSync(join(copy, CONTEXT_FILE))).toBe(false)
  })

  it('встроенные навыки лежат в копии по пути навыков — каждый своим каталогом', async () => {
    const copy = mkCopy()
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1 }))
    const { deps } = makeDeps({ adapter, verbRunner: runnerAnswering(copy) })

    await tick(deps)

    expect(WORKER_SKILLS.length, 'список навыков пуст — дело ниже ничего не утверждает').toBeGreaterThan(0)
    for (const skill of WORKER_SKILLS as any[]) {
      const path = join(copy, '.claude', 'skills', skill.slug, 'SKILL.md')
      expect(existsSync(path), 'навык до копии не доехал: ' + skill.slug).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(skill.body)
    }
  })

  it('ПРАВИЛА ПОЛЬЗОВАТЕЛЯ ВЫШЕ НАШИХ: одноимённый навык проекта не перезаписан, и это в журнале', async () => {
    const copy = mkCopy()
    const mine = (WORKER_SKILLS as any[])[0].slug
    const theirs = '# навык самого проекта, писал пользователь'
    mkdirSync(join(copy, '.claude', 'skills', mine), { recursive: true })
    writeFileSync(join(copy, '.claude', 'skills', mine, 'SKILL.md'), theirs, 'utf8')
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1 }))
    const { deps, journalled } = makeDeps({ adapter, verbRunner: runnerAnswering(copy) })

    await tick(deps)

    expect(readFileSync(join(copy, '.claude', 'skills', mine, 'SKILL.md'), 'utf8'), 'мы затёрли файл пользователя').toBe(theirs)
    expect(
      journalled.find((e: any) => e.type === 'task.worker_skill_kept'),
      'мы уступили файлу пользователя молча — узнать об этом неоткуда',
    ).toBeTruthy()
  })

  it('ЧЕСТНЫЙ ПРОВАЛ: запись снимка упала — попытка не запускается, а падает по имени', async () => {
    const copy = mkCopy()
    const adapter = oneTaskAdapter(backlogTask({ id: 'BL-1', attempt: 1, taskContext: SNAPSHOT }))
    const { deps, order } = makeDeps({
      adapter,
      verbRunner: runnerAnswering(copy),
      deps: {
        fsImpl: {
          existsSync: () => true,
          mkdirSync: () => {},
          writeFileSync: () => {
            throw new Error('disk on fire')
          },
        },
      },
    })

    const res = await tick(deps)

    expect(res.failed?.taskId, 'попытка ушла в спавн с копией, о которой критерий фазы соврал бы').toBe('BL-1')
    expect(order, 'работник запущен, хотя снимок до копии не доехал').not.toContain('spawn')
  })

  it('СЕКРЕТ ИЗ СРЕДЫ ДЕМОНА вырезан из файла в копии — тем же поясом, что у каталога прогона', async () => {
    const copy = mkCopy()
    const token = 'sk-ant-oat01-THIS-IS-THE-TOKEN-VALUE-0123456789'
    const adapter = oneTaskAdapter(
      backlogTask({
        id: 'BL-1',
        attempt: 1,
        taskContext: 'первая строка\nвставил токен ' + token + ' по ошибке\nтретья строка',
      }),
    )
    const { deps } = makeDeps({
      adapter,
      verbRunner: runnerAnswering(copy),
      deps: { env: { SMA_LOCAL_1_TOKEN: token, PATH: '/usr/bin' } },
    })

    await tick(deps)

    const text = readFileSync(join(copy, CONTEXT_FILE), 'utf8')
    expect(text, 'секрет уехал файлом в дерево, где работает чужой процесс').not.toContain(token)
    expect(text, 'вырезали больше, чем нужно: остальные строки человека обязаны выжить').toContain('третья строка')
  })
})

/**
 * ═════ РОЙ ЖИВЁТ НА МАШИНЕ: ПРОВОД, А НЕ НАЛИЧИЕ ФАЙЛА ═════
 *
 * Решение владельца 27.08: рой агентов принадлежит машине, а не проекту. Читающая сторона
 * (harness.mjs) закрыта своими случаями; здесь закрывается СТЫК, на котором всё и обрывалось.
 *
 * Ворота выдачи роли стояли на поле `worker.roleFile`. Это поле есть только у работника, чьё
 * определение нашлось в ДЕРЕВЕ ПРОЕКТА: путь роли раскрывается относительно репозитория, и у
 * определения из хранилища машины такого пути нет и быть не может. Значит агент машины мог
 * числиться на карточке включённым, а сессия не получала ни строки роли — «есть в списке» и
 * «работает» расходились молча. Случай ниже спрашивает единственное, что доказывает обратное:
 * доехал ли текст роли до `spec.prompt`, то есть до аргументов, с которыми поднимают работника.
 */
describe('рой на машине: роль агента машины доезжает до запуска работника', () => {
  const SCOUT = `---
name: sma-scout
description: Ищет по дереву и не правит.
lane: prod
provider: claude
---
МАРКЕР-РОЛИ-ИЗ-ХРАНИЛИЩА-МАШИНЫ
`

  /** Фальшивая ФС ровно того вида, что читает harness: только машинное хранилище, дерева нет. */
  const machineOnlyFs = (name: string, body: string) => ({
    existsSync: (p: string) => String(p).replace(/\\/g, '/').endsWith(`/machine/agents/${name}.md`),
    readFileSync: (p: string) => {
      if (String(p).replace(/\\/g, '/').endsWith(`/machine/agents/${name}.md`)) return body
      throw new Error(`ENOENT ${p}`)
    },
    readdirSync: (p: string) => {
      if (String(p).replace(/\\/g, '/').endsWith('/machine/agents')) return [`${name}.md`]
      throw new Error(`ENOENT ${p}`)
    },
  })

  const spawnRecording = (spawns: any[]) => (spec: any) => {
    spawns.push({ prompt: String(spec.prompt ?? '') })
    spec.onLine?.('APPROACH_NOTE: прямой путь')
    spec.onLine?.('LESSON_NONE: тестовый работник')
    spec.onExit?.({ code: 0, signal: null })
    return { pid: 1, kill: () => {} }
  }

  const RESPONSES = {
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) },
    reverify: GREEN_REVERIFY,
  }

  it('работник БЕЗ roleFile получает роль из хранилища машины — она в задании запуска', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    const spawns: any[] = []
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: spawnRecording(spawns),
      responses: RESPONSES,
      config: {
        repoDir: '/repo',
        // ровно то, что записывает дверь включения для определения из хранилища машины:
        // профиль есть, пина роли нет — взять его неоткуда
        workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      },
      deps: {
        resolveWorkerContext,
        fsImpl: machineOnlyFs('max-2', SCOUT),
        env: { SMA_DAEMON_AGENTS: '/machine/agents' },
      },
    })

    await tick(deps)

    expect(spawns).toHaveLength(1)
    expect(spawns[0].prompt, 'роль из хранилища машины не доехала до аргументов запуска').toContain(
      'МАРКЕР-РОЛИ-ИЗ-ХРАНИЛИЩА-МАШИНЫ',
    )
    // задание не подменено — роль ДОПИСАНА перед ним, как и роль из дерева
    expect(spawns[0].prompt).toContain('do it')
    expect(spawns[0].prompt.indexOf('МАРКЕР-РОЛИ-ИЗ-ХРАНИЛИЩА-МАШИНЫ')).toBeLessThan(
      spawns[0].prompt.indexOf('do it'),
    )
  })

  it('нечего найти — ничего и не дописано: пустое хранилище не выдумывает роли', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(backlogTask())

    const spawns: any[] = []
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: spawnRecording(spawns),
      responses: RESPONSES,
      config: {
        repoDir: '/repo',
        workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      },
      deps: {
        resolveWorkerContext,
        fsImpl: machineOnlyFs('somebody-else', SCOUT),
        env: { SMA_DAEMON_AGENTS: '/machine/agents' },
      },
    })

    await tick(deps)

    expect(spawns).toHaveLength(1)
    expect(spawns[0].prompt).not.toContain('МАРКЕР-РОЛИ-ИЗ-ХРАНИЛИЩА-МАШИНЫ')
  })
})

/**
 * ═══ ПРИНЯТАЯ РАБОТА НЕ ВОСКРЕСАЕТ: ОБХОД БЕКЛОГА СПРАШИВАЕТ, ПРЕЖДЕ ЧЕМ СТАВИТЬ ═══
 *
 * ЧТО БЫЛО ИЗМЕРЕНО. Работа, законченная в 11:03 и ПРИНЯТАЯ человеком в 11:12, вернулась в
 * очередь ближайшим обходом беклога и была выдана работнику заново. Причин ровно две, и обе
 * проверяются здесь:
 *   · строку файла беклога ведёт ЧЕЛОВЕК — дверь приёмки его не правит и вычеркнутой строку не
 *     увидит, поэтому «строка открыта» ничего не говорит о том, брали ли её в работу;
 *   · слипание очереди держит только ждущее и идущее (`singletonKey` на `created`/`active`), а
 *     ЗАКОНЧЕННАЯ работа — ждущая решения и принятая — заводилась заново, подходом номер два.
 *
 * ПОЧЕМУ СЛУЧАЯ ДВА. Они закрывают дыру в РАЗНОЕ время: пока строка в очереди есть — отвечает
 * очередь; когда очередь унесла законченную работу в архив по сроку хранения, отвечать может
 * только реестр, и только если дверь приёмки записала в него закрытие карточки.
 *
 * Оба случая гоняют НАСТОЯЩИЙ тик над настоящей эталонной очередью: подставлен только сканер
 * файла, потому что файла на диске здесь нет.
 */
describe('обход беклога не ставит заново работу, о которой уже есть слово', () => {
  const line = (over: any = {}) => backlogTask({ id: 'R-176', title: 'починить дверь приёмки', ...over })
  const intakeOf = (items: any[]) => ({ lastScanAt: 0, scan: async () => ({ items, notReady: [] }) })

  it('карточку, принятую человеком, не ставит — даже когда очередь о ней уже забыла', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      deps: { intake: intakeOf([line()]) },
    })
    // ЧТО ОСТАЛОСЬ ПОСЛЕ ПРИЁМКИ: строки очереди нет вовсе (её унёс архив), а реестр несёт
    // строку закрытия — ровно ту, которую пишет дверь «Одобрить».
    deps.ledger.recordAttempt({
      taskId: 'R-176',
      attempt: 1,
      closed: { at: '2026-08-31T11:12:00.000Z', by: 'approve', merged: true },
    })

    const res = await tick(deps)

    expect(res.intake.enqueued, 'принятая и слитая работа поставлена в очередь заново').toBe(0)
    expect(res.intake.known).toEqual(['R-176'])
    expect(await adapter.list({})).toEqual([]) // очередь осталась пустой
    expect(journalled.some((e: any) => e.type === 'intake-known')).toBe(true)
  })

  it('карточку, которая ждёт решения человека, не выдаёт вторым подходом', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(line())
    const claimed: any = await adapter.claimNext('w-1', { lanes: ['prod'] })
    await adapter.complete('R-176', { receiptRef: 'reverify:abc', attemptToken: claimed.attemptToken })
    const [before] = await adapter.list({})
    expect(before.status).toBe('awaiting_approval') // исходное состояние случая, а не допущение

    const { deps } = makeDeps({ adapter, clockObj: c, deps: { intake: intakeOf([line()]) } })
    const res = await tick(deps)

    expect(res.intake.enqueued).toBe(0)
    const rows = await adapter.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0].status, 'готовая работа снова уехала в очередь').toBe('awaiting_approval')
    expect(rows[0].attempt).toBe(1)
  })

  it('строку, о которой не сказал никто, обход по-прежнему ставит — иначе это не сторож, а замок', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const { deps } = makeDeps({
      adapter,
      clockObj: c,
      deps: { intake: intakeOf([line({ id: 'R-901' })]) },
    })

    const res = await tick(deps)

    expect(res.intake.enqueued).toBe(1)
    expect(res.intake.known).toEqual([])
    expect((await adapter.list({})).map((r: any) => r.id)).toEqual(['R-901'])
  })

  it('очередь, которая не ответила о своих строках, останавливает постановку целиком', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    const enqueued: any[] = []
    const blind = {
      ...adapter,
      list: async () => {
        throw new Error('queue unreachable')
      },
      enqueue: async (t: any) => {
        enqueued.push(t)
        return { id: t.id, coalesced: false, coalesceCount: 1 }
      },
    }
    const { deps, journalled } = makeDeps({
      adapter: blind,
      clockObj: c,
      deps: { intake: intakeOf([line({ id: 'R-902' })]) },
    })

    const res = await tick(deps)

    expect(enqueued, 'слепой обход поставил работу, не спросив очередь').toEqual([])
    expect(res.intake).toEqual({ scannedAt: expect.any(Number), enqueued: 0, known: [], notReady: [] })
    expect(journalled.some((e: any) => e.type === 'intake-blind')).toBe(true)
  })
})

/**
 * ═══ ЗАХВАТ СПРАШИВАЕТ ПОСЛЕДНЕЕ СЛОВО О ЗАДАЧЕ — ДО ТОГО, КАК ЗА НЕЁ НАЧНУТ ПЛАТИТЬ ═══════
 *
 * ЧТО БЫЛО ИЗМЕРЕНО. Обход беклога перестал минтить принятую работу (дела выше), но выданной она
 * от этого быть не перестала: строка, уже стоявшая в очереди, доезжала до работника как ни в чём
 * не бывало. Правило свёртки («последнее слово о задаче») спрашивал ОДИН автоповтор; у захвата
 * того же вопроса не было ни одного. Цена названа днём 31.08.2026: три оплаченных прогона, каждый
 * из которых закончился словами «уже сделано».
 *
 * И ВТОРАЯ, ОСТРЕЙШАЯ ГРАНЬ ТОГО ЖЕ КЛАССА. Задача в состоянии `awaiting_approval` получала
 * ВТОРОГО живого писателя в ТУ ЖЕ рабочую копию (19:48:35Z и 20:07:18Z, дважды за вечер): работник
 * дописывал исходники под ногами у посадки — честный штамп на движущемся дереве невозможен, — а
 * уборка копии при приёмке убила бы его незакоммиченное.
 *
 * ДЕЛА ГОНЯЮТ НАСТОЯЩИЙ ТИК над настоящей эталонной очередью и настоящим швом реестра.
 */
describe('захват не выдаёт работу, о которой уже сказано последнее слово', () => {
  const line = (over: any = {}) => backlogTask({ id: 'R-176', title: 'починить дверь приёмки', ...over })
  const runResponses = (id: string) => ({
    preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
    worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: `/wt/${id}`, branch: `wt/${id}` }) },
    reverify: GREEN_REVERIFY,
  })

  it('принятую и слитую карточку работнику не отдают — даже когда её строка стоит в очереди', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(line()) // призрак, отчеканенный обходом ДО приёмки
    const { deps, order, attempts, journalled } = makeDeps({ adapter, clockObj: c, responses: runResponses('R-176') })
    // то, что осталось после приёмки: строка закрытия, как её пишет дверь «Одобрить»
    deps.ledger.recordAttempt({
      taskId: 'R-176',
      attempt: 1,
      closed: { at: '2026-08-31T11:12:00.000Z', by: 'approve', merged: true, mergeSha: '504b61a9' },
    })

    const res = await tick(deps)

    expect(res.refusedClaim).toEqual({ taskId: 'R-176', code: 'card_closed' })
    // НИ КОПИИ, НИ ПРОЦЕССА: дороже всего стоит не выданная строка, а запущенный по ней работник
    expect(order).toEqual([])
    const [row] = await adapter.list({})
    expect(row.status, 'призрак остался живым в очереди').toBe('failed')
    expect(row.failure_reason).toBe('already_decided')
    // и почему — словами, на долговечной строке, а не только в журнале демона
    const ghost: any = attempts.find((a: any) => a.failureReason === 'already_decided')
    expect(ghost.failureDetail).toContain('принятая работа не выдаётся заново')
    expect(journalled.some((e: any) => e.type === 'claim.refused')).toBe(true)
  })

  it('вторую строку не выдают, пока первая ждёт решения человека — второй писатель в ту же копию', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(line({ id: 'R-195' }))
    // Долговечная очередь держит ЗАКОНЧЕННУЮ строку рядом с новой; памятная так не умеет — одна
    // задача, одна запись. Поэтому список о двух строках подставлен поверх настоящей очереди, и
    // это единственная подделка в деле: захват, отказ и закрытие строки — настоящие.
    const waiting = {
      id: 'R-195',
      status: 'awaiting_approval',
      attempt: 1,
      title: 'починить дверь приёмки',
      lane: 'prod',
      source: 'backlog',
      priority: 0,
      enqueuedAt: c.clock() - 3600_000,
      completedAt: c.clock() - 600_000,
    }
    const twoRows = { ...adapter, list: async (f: any) => [...(await adapter.list(f)), waiting] }
    const { deps, order } = makeDeps({ adapter: twoRows, clockObj: c, responses: runResponses('R-195') })

    const res = await tick(deps)

    expect(res.refusedClaim).toEqual({ taskId: 'R-195', code: 'awaiting_person' })
    expect(order).toEqual([]) // работник в живую копию посадки не поехал
    const ghost: any = (await adapter.list({})).find((r: any) => r.id === 'R-195')
    expect(ghost.status).toBe('failed')
    expect(ghost.failure_reason).toBe('already_decided')
  })

  it('чужое закрытие ничего не запрещает: работа со своим именем идёт как обычно — это сторож, а не замок', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(line({ id: 'R-901' }))
    const { deps } = makeDeps({ adapter, clockObj: c, responses: runResponses('R-901') })
    deps.ledger.recordAttempt({
      taskId: 'R-176', // закрыта ДРУГАЯ карточка
      attempt: 1,
      closed: { at: '2026-08-31T11:12:00.000Z', by: 'approve', merged: true },
    })

    const res = await tick(deps)

    expect(res.refusedClaim).toBeUndefined()
    expect(res.completed).toBe('R-901')
  })

  /**
   * ═══ И СЧЁТ ПОДХОДОВ МОНОТОНЕН: ВТОРОЙ ЕДИНИЦЫ НЕ БЫВАЕТ ═══════════════════════════════
   *
   * Счёт ведёт очередь, и она его забывает вместе со строкой (архив по сроку хранения), а реестр
   * не забывает. Замерено 31.08.2026: вторая физическая попытка задачи записана ТЕМ ЖЕ номером 1.
   * Каталог прогона зовётся `<taskId>#<attempt>` — повторённое число молча накрывает запись
   * предыдущего подхода.
   */
  it('вторая физическая попытка не пишется номером 1 — реестр поднимает счёт очереди', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(line({ id: 'R-180' })) // очередь начала счёт заново: подход 1
    const { deps, attempts, journalled } = makeDeps({ adapter, clockObj: c, responses: runResponses('R-180') })
    deps.ledger.recordAttempt({ taskId: 'R-180', attempt: 1, outcome: 'failed', failureReason: 'provider_error' })

    const res = await tick(deps)

    expect(res.completed).toBe('R-180')
    const ended: any = attempts.filter((a: any) => a.taskId === 'R-180' && a.outcome === 'completed').at(-1)
    expect(ended.attempt, 'вторая попытка легла в реестр под номером первой').toBe(2)
    expect(journalled.some((e: any) => e.type === 'attempt.number_lifted')).toBe(true)
  })
})
