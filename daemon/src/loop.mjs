/**
 * loop.mjs — THE STATELESS TICK: the phase's core, where the founder stops being the
 * runtime (Phase 9.5 Plan 07, Task 2; D-9.5-02, D-9.5-04a, D-9.5-11).
 *
 * ═══════════════════════ D-9.5-02 — STATELESS CONSUMER ═══════════════════════════
 * The daemon is a POLL over durable state. `tick(deps)` executes ONE pass and holds NO
 * task memory: every tick re-derives from the QueueAdapter (Postgres truth) + the
 * attempt ledger. The process is KILLABLE AT ANY LINE — restart = resume; a lost tick
 * self-heals on the next one (Pitfall 1). There is NO in-process registry of live tasks
 * here: this file constructs NO Map and NO Set anywhere (a literal grep gate). Any keyed
 * lookup belongs in the adapter/ledger or a helper module — never in the tick.
 *
 * ═══════════════════════ CONSUME-NEVER-REIMPLEMENT ════════════════════════════════
 * The tick COMPOSES existing verbs, it never reimplements them:
 *   - preflight  — verify-before-execute mechanized: 'built' → complete on the preflight
 *                  receipt, skip the spawn entirely (the work already exists).
 *   - worktree   — per-task branch `wt/<taskId>`; the worktree.mjs EXPECTED_BASE guard
 *                  (Pitfall 7, platform-neutral) stays ON inside the provision verb.
 *   - reverify   — THE exit gate (D-9.5-04a): done = a GREEN reverify receipt, whoever
 *                  the executor was. No receipt → fail('no_receipt'); never completed on
 *                  the daemon's word (the Multica «completed = слово демона» anti-lesson).
 *   - merge      — stays a serialized verb invoked ONLY from the front's approve path.
 *                  The loop itself NEVER merges.
 * All four run through ONE injected `verbRunner(bin, argsArray, {cwd}) → {code, stdout}`
 * that spawns `node scripts/sma/cli.mjs <verb> …` with the shell disabled. Tests inject a
 * recorder; production injects the real child runner.
 *
 * ═══════════════════════ THE FOUNDER-PUSH LAW ════════════════════════════════════
 * This process holds NO origin-push path. Approved work travels back by the FOUNDER
 * pulling the worker host as a git remote (assumption Q1, pending grill) — the daemon
 * never talks to origin. SMA-3 COMMENT DISCIPLINE: the two-word push invocation literal
 * is never written in this file or any daemon source; where the concept is unavoidable it
 * is «the push verb». Workers never push; the loop's only git surface is worktree/merge
 * verbs, both local by construction.
 *
 * ═══════════════════════ FAIL-OPEN HONESTY (merge-gate posture) ═══════════════════
 * The whole tick is wrapped fail-open: any thrown error is journaled and the affected
 * task is FAILED HONESTLY ('runtime_offline' on spawn infra errors) — a tick bug can
 * never wedge the daemon and never lie a status. An empty tick short-circuits with
 * {idle:true} and no spawn (skipTimerWhenNoActionableWork — Pitfall 10).
 *
 * Node built-ins only; every collaborator injected. Zero deps; zero network in this file.
 */

import { join } from 'node:path'

import { livenessSweep } from './queue/liveness.mjs'
import { buildForgePrompt, lintDraft, writeForgeReceipt, draftDirFor } from './forge/forge.mjs'

/** The execution lanes, in the documented stable order (mirrors the adapter's lanes). */
const LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

const TOUCH_THROTTLE_MS = 30000 // touch at most once per 30s while streaming (Pitfall 2)
const HOUR_MS = 3600000

/** Worker final-output markers — a SOFT protocol the worker MAY emit (D-9.5-11 item 4). */
const MARKER_RE = /^\s*(NEEDS_DECISION|MISSING_ACCESS)\s*:/

/**
 * classifyFailure({spawnError, exitCode, receipt, workerMarker}) → a FAIL_REASONS code.
 * Pure. Maps a non-completing outcome onto the D-9.5-11 taxonomy, sharpest signal first:
 *   spawnError                     → 'runtime_offline'  (the process never ran)
 *   worker marker NEEDS_DECISION   → 'needs_decision'   (a call only a human can make)
 *   worker marker MISSING_ACCESS   → 'missing_access'   (credentials/permissions absent)
 *   red reverify receipt           → 'tests_red'        (targeted tests failed)
 *   no receipt + nonzero exit      → 'agent_error'      (the worker crashed)
 *   no receipt + exit 0            → 'no_receipt'        (claimed done, never certified)
 *   anything else                  → 'agent_error'
 * A marker (when present) BEATS the receipt — the worker gave the sharper reason.
 *
 * @param {{spawnError?:any, exitCode?:number|null, receipt?:{verdict?:string,ref?:any}|null, workerMarker?:string|null}} [o]
 * @returns {string}
 */
export function classifyFailure({ spawnError, exitCode, receipt, workerMarker } = {}) {
  if (spawnError) return 'runtime_offline'
  if (workerMarker === 'NEEDS_DECISION') return 'needs_decision'
  if (workerMarker === 'MISSING_ACCESS') return 'missing_access'
  if (receipt && receipt.verdict === 'red') return 'tests_red'
  if (!receipt) {
    return Number.isFinite(exitCode) && exitCode !== 0 ? 'agent_error' : 'no_receipt'
  }
  return 'agent_error'
}

/** Parse the last JSON object on a verb's stdout; fail-open to {} (never throws). */
function parseVerbResult(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim()
    if (!t || t[0] !== '{') continue
    try {
      return JSON.parse(t)
    } catch {
      /* keep scanning upward for a parseable line */
    }
  }
  return {}
}

/** Invoke one CLI verb through the injected runner; returns {code, ...parsedStdout}. */
async function invokeVerb(verbRunner, verb, args, cwd) {
  try {
    const res = await verbRunner('node', ['scripts/sma/cli.mjs', verb, ...args], { cwd })
    const parsed = parseVerbResult(res && res.stdout)
    return { code: (res && Number.isFinite(res.code)) ? res.code : 0, ...parsed }
  } catch (err) {
    return { code: 1, error: String((err && err.message) || err) }
  }
}

/** Detect a worker final-output marker among the collected stream lines (soft protocol). */
function detectMarker(lines) {
  for (const line of lines) {
    const m = typeof line === 'string' ? line.match(MARKER_RE) : null
    if (m) return m[1]
  }
  return null
}

/**
 * eligibleLanes(deps) — the lanes with at least one runnable worker RIGHT NOW, derived by
 * asking the routing policy (CONSUME-NEVER-REIMPLEMENT: the day-priority + window rules
 * live in routing.mjs, never re-encoded here). A lane is eligible when a lane-probe yields
 * a workerId or an explicit API fallback. Deriving eligibility BEFORE the claim is grill
 * CH-9.5-07-1: the per-lane queues make a claimed task runnable by construction.
 */
function eligibleLanes(deps) {
  const { routing, config, windows, clock } = deps
  const out = []
  for (const lane of LANES) {
    const decision = routing.resolveRoute({ lane }, { workers: config.workers, windows, clock, config })
    if (decision && (decision.workerId || decision.useApiFallback)) out.push(lane)
  }
  return out
}

/**
 * runSpawn(spawnWorker, spec, onLine) — await a worker child to exit, collecting a
 * synchronous spawn failure as spawnError. Resolves {code, signal, spawnError}. The child
 * is driven entirely through the injected spawnWorker (spawn.mjs in production).
 */
function runSpawn(spawnWorker, spec, onLine) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      spawnWorker({
        ...spec,
        onLine,
        onExit: ({ code, signal } = {}) => done({ code: code ?? null, signal: signal ?? null, spawnError: null }),
      })
    } catch (err) {
      done({ code: null, signal: null, spawnError: err })
    }
  })
}

/** Coerce an enqueuedAt (number ms or ISO string) to epoch ms, or NaN. */
function toEpochMs(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : NaN
}

/** Fresh-derive the aging signal every tick — nothing stored (D-9.5-11 item 3). */
async function deriveAging(deps, now) {
  const { adapter, config, report, journal } = deps
  const agingMs = (config.agingHours ?? 24) * HOUR_MS
  let queued = []
  try {
    queued = await adapter.list({ status: 'queued' })
  } catch {
    return // a list failure never wedges the tick (fail-open)
  }
  for (const row of queued) {
    const enq = toEpochMs(row.enqueuedAt)
    if (!Number.isFinite(enq)) continue
    const ageMs = now - enq
    if (ageMs < agingMs) continue
    const queuedForHours = Math.floor(ageMs / HOUR_MS)
    if (typeof journal === 'function') journal({ type: 'task.aging', taskId: row.id, queuedForHours })
    if (typeof report === 'function') {
      // fire-and-forget; consumers dedup by taskId (the same signal reaches plan 08/09)
      await report({ event: 'task.aging', taskId: row.id, title: row.title, lane: row.lane, queuedForHours })
    }
  }
}

/** Intake per cadence — enqueue NEW ready backlog items; last-scan is threaded THROUGH the
 *  tick (deps.intake.lastScanAt in, result.intake.scannedAt out) so the tick stays stateless. */
async function runIntake(deps, now, result) {
  const { adapter, config, journal } = deps
  const intake = deps.intake
  if (!intake || typeof intake.scan !== 'function') return
  const dueMs = (config.backlogScanMinutes ?? 60) * 60000
  const last = Number.isFinite(intake.lastScanAt) ? intake.lastScanAt : 0
  if (now - last < dueMs) return
  try {
    const scan = await intake.scan()
    let enqueued = 0
    for (const task of (scan && scan.items) || []) {
      try {
        await adapter.enqueue(task)
        enqueued += 1
      } catch (err) {
        // a NotReady / invalid item is journaled, never fatal (fail-open intake)
        if (typeof journal === 'function') journal({ type: 'intake-skip', taskId: task && task.id, error: String((err && err.message) || err) })
      }
    }
    result.intake = { scannedAt: now, enqueued, notReady: (scan && scan.notReady) || [] }
  } catch (err) {
    if (typeof journal === 'function') journal({ type: 'intake-error', error: String((err && err.message) || err) })
  }
}

/**
 * tick(deps) — ONE stateless pass. deps: {adapter, ledger, config, routing, windows,
 * buildArgs, spawnWorker, verbRunner, report, clock, journal, intake?}.
 * Returns a summary {idle, sweep?, claimed?, completed?, failed?, intake?}.
 */
export async function tick(deps = {}) {
  const { adapter, ledger, config, verbRunner, spawnWorker, buildArgs, report, journal } = deps
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const now = () => clock()
  const result = { idle: false }

  try {
    // (1) liveness sweep — audit durable state; requeue any task that lost its live path.
    try {
      result.sweep = await livenessSweep({ adapter, ledger, clock, expireMs: config?.expireMs ?? 120000 })
    } catch (err) {
      if (typeof journal === 'function') journal({ type: 'sweep-error', error: String((err && err.message) || err) })
    }

    // (2) intake per cadence (secondary path; roster button is primary — Q2).
    await runIntake(deps, now(), result)

    // (2b) aging signal — derived fresh, nothing stored (runs whether or not we claim).
    await deriveAging(deps, now())

    // (3) claim — eligible lanes FIRST, then a lane-restricted claim (grill CH-9.5-07-1).
    const lanes = eligibleLanes(deps)
    if (lanes.length === 0) {
      result.idle = true
      return result
    }
    const workerId = 'daemon' // the claim is against durable state; identity is the ledger's job
    const task = await adapter.claimNext(workerId, { lanes })
    if (!task) {
      result.idle = true // skipTimerWhenNoActionableWork (Pitfall 10)
      return result
    }
    result.claimed = task.id

    // From here a per-task failure is honest, never a wedge (fail-open).
    try {
      const route = deps.routing.resolveRoute(task, { workers: config.workers, windows: deps.windows, clock, config })
      if (!route || (!route.workerId && !route.useApiFallback)) {
        // Claimed but no runnable target after the real route (rare race) — degrade honestly.
        await failTask(deps, task, { reason: 'window_exhausted', now: now() })
        result.failed = { taskId: task.id, reason: 'window_exhausted' }
        return result
      }

      // (3b) FORGE LANE (D-9.5-09) — a described-in-words draft. Same claim/route/worktree/
      // spawn as code work, but preflight is SKIPPED (nothing to already-build) and the exit
      // gate is a DETERMINISTIC draft lint, not reverify (a draft is a definition file). The
      // «Создатель» never activates anything — it commits a draft on the branch, full stop.
      if (task.lane === 'forge') {
        return await runForgeTask(deps, task, route, result, now)
      }

      // (4) preflight — verify-before-execute. 'built' → complete on the preflight receipt.
      const pf = await invokeVerb(verbRunner, 'preflight', [task.id], config.repoDir)
      if (pf.verdict === 'built') {
        const receiptRef = pf.receiptRef || `preflight:${task.id}`
        await completeTask(deps, task, { receiptRef, branch: null, diffStat: pf.diffStat, route, now: now() })
        result.completed = task.id
        return result
      }

      // (5) worktree provision — per-task branch `wt/<taskId>` (EXPECTED_BASE guard on).
      const branch = `wt/${task.id}`
      const wt = await invokeVerb(verbRunner, 'worktree', ['provision', '--branch', branch], config.repoDir)
      const worktreePath = wt.worktreePath || `${config.repoDir ?? '.'}/../${branch}`

      // (6) spawn the routed worker; touch (throttled) on every stream line.
      const spec = buildArgs(task, route)
      // D-9.5-09: prepend the enabled agent's role/skills preamble (resolveWorkerContext) so
      // «включён» is real in the session. Optional + DI-guarded — skipped when not injected.
      if (typeof deps.resolveWorkerContext === 'function' && route && route.workerId) {
        const worker = (config.workers || []).find((w) => w && w.id === route.workerId)
        if (worker && (worker.roleFile || (Array.isArray(worker.skills) && worker.skills.length))) {
          const ctx = deps.resolveWorkerContext({ worker, repoDir: config.repoDir, fsImpl: deps.fsImpl })
          if (ctx && ctx.rolePreamble) spec.prompt = `${ctx.rolePreamble}\n\n${spec.prompt ?? ''}`
        }
      }
      const streamLines = []
      let lastTouchAt = 0
      const onLine = (line) => {
        streamLines.push(line)
        const t = now()
        if (t - lastTouchAt >= TOUCH_THROTTLE_MS) {
          lastTouchAt = t
          Promise.resolve(adapter.touch(task.id)).catch(() => {})
        }
      }
      const exit = await runSpawn(spawnWorker, { bin: spec.bin, args: spec.args, cwd: worktreePath, env: spec.env, prompt: spec.prompt }, onLine)

      // (7) reverify GATE in the worktree — the ONLY door to completed (D-9.5-04a).
      const rv = exit.spawnError ? { code: 1 } : await invokeVerb(verbRunner, 'reverify', ['--branch', branch], worktreePath)
      let receipt = null
      if (rv.receiptRef) {
        receipt = { verdict: rv.verdict || (rv.code === 0 ? 'green' : 'red'), ref: rv.receiptRef }
      } else if (rv.verdict === 'red' || (Number.isFinite(rv.code) && rv.code !== 0)) {
        receipt = { verdict: 'red', ref: null }
      }
      const marker = detectMarker(streamLines)

      if (!exit.spawnError && receipt && receipt.verdict === 'green' && receipt.ref) {
        await completeTask(deps, task, { receiptRef: receipt.ref, branch, diffStat: rv.diffStat, route, now: now() })
        result.completed = task.id
      } else {
        const reason = classifyFailure({ spawnError: exit.spawnError, exitCode: exit.code, receipt, workerMarker: marker })
        await failTask(deps, task, { reason, receiptRef: receipt && receipt.ref, branch, route, now: now() })
        result.failed = { taskId: task.id, reason }
      }
      return result
    } catch (err) {
      // Per-task fail-open: a thrown error becomes an honest runtime_offline, never a wedge.
      if (typeof journal === 'function') journal({ type: 'task-error', taskId: task.id, error: String((err && err.message) || err) })
      try {
        await failTask(deps, task, { reason: 'runtime_offline', now: now() })
      } catch {
        /* even the fail is fail-open — the next tick's liveness sweep will recover it */
      }
      result.failed = { taskId: task.id, reason: 'runtime_offline' }
      return result
    }
  } catch (err) {
    // Tick-level fail-open (merge-gate posture): journal + return an honest error marker.
    if (typeof journal === 'function') journal({ type: 'tick-error', error: String((err && err.message) || err) })
    result.error = true
    return result
  }
}

/**
 * listCommittedDrafts(execGit, branch, cwd, kind) → the draft files of `kind` committed on
 * the branch tip. The injected execGit runs with the shell disabled (spawn.mjs posture); a
 * missing execGit or a git error yields [] (the caller then fails 'agent_error' honestly).
 * The worker commits EXACTLY ONE draft — this is how the loop asserts it landed on the branch.
 */
function listCommittedDrafts(execGit, branch, cwd, kind) {
  if (typeof execGit !== 'function') return []
  const dir = draftDirFor(kind)
  if (!dir) return []
  let out = ''
  try {
    out = String(execGit(['show', '--name-only', '--pretty=format:', branch], { cwd }) || '')
  } catch {
    return []
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((p) => p.startsWith(dir))
}

/**
 * runForgeTask(deps, task, route, result, now) — the forge-lane branch. Reuses claim (already
 * done) / worktree / spawn / touch VERBATIM; SKIPS preflight; swaps the reverify exit gate for
 * `lintDraft`. Green + committed → complete on the FORGE receipt (D-9.5-04a for the forge
 * lane); red lint or an uncommitted draft → fail('agent_error') with the lint detail on the
 * attempt row. A return-with-note re-forges: the note flows into buildForgePrompt.
 */
async function runForgeTask(deps, task, route, result, now) {
  const { verbRunner, spawnWorker, buildArgs, config, adapter } = deps

  // (5) worktree provision — per-task branch `wt/<taskId>` (EXPECTED_BASE guard on).
  const branch = `wt/${task.id}`
  const wt = await invokeVerb(verbRunner, 'worktree', ['provision', '--branch', branch], config.repoDir)
  const worktreePath = wt.worktreePath || `${config.repoDir ?? '.'}/../${branch}`

  // (6) spawn the «Создатель» with the FORGE prompt (not the code task prompt); touch on stream.
  const kind = task.forge && task.forge.kind
  const spec = buildArgs(task, route)
  spec.prompt = buildForgePrompt({
    kind,
    description: task.forge && task.forge.description,
    note: task.note,
    repoDir: config.repoDir,
  })
  let lastTouchAt = 0
  const onLine = () => {
    const t = now()
    if (t - lastTouchAt >= TOUCH_THROTTLE_MS) {
      lastTouchAt = t
      Promise.resolve(adapter.touch(task.id)).catch(() => {})
    }
  }
  const exit = await runSpawn(spawnWorker, { bin: spec.bin, args: spec.args, cwd: worktreePath, env: spec.env, prompt: spec.prompt }, onLine)

  if (exit.spawnError) {
    await failTask(deps, task, { reason: 'runtime_offline', branch, route, now: now() })
    result.failed = { taskId: task.id, reason: 'runtime_offline' }
    return result
  }

  // (7) EXIT GATE = deterministic draft lint + committed-on-branch assertion (NOT reverify).
  const drafts = listCommittedDrafts(deps.execGit, branch, worktreePath, kind)
  if (drafts.length !== 1) {
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now() })
    result.failed = { taskId: task.id, reason: 'agent_error', detail: 'draft not committed (expected exactly one)' }
    return result
  }
  const draftPath = drafts[0]
  const lint = lintDraft({ kind, filePath: join(worktreePath, draftPath), fsImpl: deps.fsImpl })
  if (!lint.passed) {
    const failed = lint.checks.filter((c) => !c.ok).map((c) => c.name).join(',')
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now() })
    result.failed = { taskId: task.id, reason: 'agent_error', detail: `lint failed: ${failed}` }
    return result
  }

  const receiptRef = writeForgeReceipt({
    dataDir: config.dataDir,
    taskId: task.id,
    kind,
    filePath: draftPath,
    lint,
    sha256: lint.sha256,
    fsImpl: deps.fsImpl,
  })
  await completeTask(deps, task, { receiptRef, branch, diffStat: null, route, now: now() })
  result.completed = task.id
  return result
}

/** complete a task through the adapter gate + write a rich (receipt-bearing) attempt row. */
async function completeTask(deps, task, { receiptRef, branch, diffStat, route, now }) {
  const { adapter, ledger, report } = deps
  await adapter.complete(task.id, {
    receiptRef,
    branch,
    diffStat,
    workerId: route && route.workerId,
    provider: route && route.provider,
  })
  if (ledger && typeof ledger.recordAttempt === 'function') {
    ledger.recordAttempt({
      taskId: task.id,
      attempt: task.attempt,
      provider: route && route.provider,
      outcome: 'completed',
      receiptRef,
      endedAt: new Date(now).toISOString(),
    })
  }
  if (typeof report === 'function') {
    await report({ event: 'task.completed', taskId: task.id, title: task.title, lane: task.lane, receiptVerdict: 'green', branch, attempt: task.attempt })
  }
}

/** fail a task through the adapter gate + write a rich (receipt-bearing) attempt row. */
async function failTask(deps, task, { reason, receiptRef, branch, route, now }) {
  const { adapter, ledger, report } = deps
  await adapter.fail(task.id, reason)
  if (ledger && typeof ledger.recordAttempt === 'function') {
    ledger.recordAttempt({
      taskId: task.id,
      attempt: task.attempt,
      provider: route && route.provider,
      outcome: 'failed',
      failureReason: reason,
      receiptRef: receiptRef ?? undefined, // the red receipt ref is preserved on the row (D-9.5-11)
      endedAt: new Date(now).toISOString(),
    })
  }
  if (typeof report === 'function') {
    await report({ event: 'task.failed', taskId: task.id, title: task.title, lane: task.lane, receiptVerdict: receiptRef ? 'red' : undefined, branch, attempt: task.attempt })
  }
}

/**
 * runDaemon({tickMs, onTick}) — a thin setInterval wrapper. The ONLY state is the interval
 * handle (D-9.5-02: no task state lives in the process). start/stop are idempotent; a
 * thrown tick is swallowed so one bad tick never stops the schedule.
 *
 * @param {{tickMs?:number, onTick?:()=>any}} [opts]
 * @returns {{start:()=>boolean, stop:()=>boolean}}
 */
export function runDaemon({ tickMs = 5000, onTick } = {}) {
  let handle = null
  return {
    start() {
      if (handle) return true // idempotent — one interval only
      handle = setInterval(() => {
        try {
          Promise.resolve(typeof onTick === 'function' ? onTick() : undefined).catch(() => {})
        } catch {
          /* a synchronous tick throw never stops the schedule (fail-open) */
        }
      }, tickMs)
      if (handle && typeof handle.unref === 'function') handle.unref()
      return true
    },
    stop() {
      if (handle) {
        clearInterval(handle)
        handle = null
      }
      return true
    },
  }
}
