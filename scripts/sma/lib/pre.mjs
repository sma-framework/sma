/**
 * pre.mjs — the `sma pre` PreToolUse multiplexer dispatch core (49.2-02, D-49.2-04).
 *
 * ONE node run per Edit/Write/Bash tool call. Reads the hook event once, builds a
 * SHARED context (identity + heartbeat + seen-store loaded once), dispatches an
 * ordered internal stream pipeline (collision → reflex → gates, later + airbag +
 * spend), merges output under the carried-forward fail-open WARN / soft-deny
 * posture, and emits the single hookSpecificOutput object the harness consumes.
 *
 * ═══════════════════════════════ THE DISPATCH CONTRACT ═══════════════════════════
 *
 * This module is the CANONICAL SPEC downstream stream authors read before
 * registering. Plans 49.2-05 (git airbag) and 49.2-09 (spend ledger) each append
 * ONE stream object literal to the exported `PRE_CHECKS` array below — there is NO
 * dynamic registration API; consolidation is structural, one reviewable array in
 * one file, and the one-spawn guarantee never renegotiates.
 *
 * A stream is a plain object:
 *   {
 *     id:            string,                 // unique, stable — journal + sample key
 *     tools:         string[],               // subset of ['Edit','Write','Bash']
 *     killSwitchEnv: string | null,          // env var that skips ONLY this stream
 *     mayDeny:       boolean,                 // ONLY a mayDeny:true stream can deny
 *     run(ctx):      { warns: string[], deny?: { text } }   // never throws (wrapped)
 *   }
 *
 * POSTURE LOCKS (carried forward from V1/V2, D-49.1-12 / D-49-02):
 *   - Enforcement is fail-open WARN / soft-deny; hard-deny stays the security
 *     guard's alone. Only the gates stream carries mayDeny:true (soft-deny tier
 *     D-49.1-13). A `deny` returned by ANY other stream is DOWNGRADED to a warn
 *     line — a merge bug can never escalate WARN posture to a real deny.
 *   - Four independent fail-open layers protect every tool call: the HOOK_FACING
 *     exit-0 wrapper in cli.mjs, per-stream try/catch here, the SMA_PRE_DISABLE
 *     global kill-switch, and the soft time-budget that skips late streams rather
 *     than overrunning the harness timeout. A pre failure can NEVER wedge a session.
 *
 * Node built-ins only; every dependency is injectable so tests never touch the
 * real .sma or shell out. Zero npm deps, zero network, zero LLM (substrate law).
 */

import { join, dirname } from 'node:path'
import { appendFileSync, statSync, readFileSync, mkdirSync } from 'node:fs'

import { atomicWriteRaw } from './fs-atomics.mjs'

/** Default soft time-budget: once cumulative stream time crosses this, remaining
 * streams are skipped (well inside the 5 s harness timeout). Env-overridable. */
export const DEFAULT_PRE_BUDGET_MS = 1500

/** Perf store rewrite trigger + retained tail — bounded telemetry (never unbounded). */
const PERF_MAX_BYTES = 256 * 1024
const PERF_KEEP_LINES = 500

// ─────────────────────────── the stream bodies ──────────────────────────────
// Each EXTRACTS the exact glue the legacy cmdCollisionCheck / cmdReflexCheck /
// cmdGatesCheck carried — same lib calls, same journal event kinds, same warn
// text — but reads/mutates the SHARED ctx.seen instead of loading its own copy.

/**
 * collision stream — scope-collision (Edit/Write touched path) + push-claim
 * (Bash git deploy) channels. WARN-only (D-49-02): mayDeny:false, no kill-switch.
 * Identity + the throttled heartbeat are resolved ONCE in buildCtx (moved out of
 * this stream so the heartbeat cadence survives even when collision is silent).
 */
async function runCollision(ctx) {
  const warns = []
  const { collision, registry, slots } = ctx.deps
  const identity = ctx.identity

  // (1) scope-collision channel (Edit/Write touched path).
  try {
    const candidatePaths = []
    if ((ctx.toolName === 'Edit' || ctx.toolName === 'Write') && typeof ctx.toolInput.file_path === 'string') {
      candidatePaths.push(ctx.toolInput.file_path)
    }
    if (candidatePaths.length && collision && registry) {
      const sessions = ctx.sessions
      // CR-01: pass the repo root so ABSOLUTE hook paths are relativized to
      // repo-relative BEFORE matching the repo-relative globs + HOT_FILES.
      const warnObjs = collision.checkScopeCollision(candidatePaths, {
        sessions,
        selfTerminalId: identity ? identity.terminalId : null,
        root: ctx.repoRoot,
      })
      for (const w of warnObjs) warns.push(collision.buildWarnText(w))
      // journal the collisions (tier:'warn' only; fail-open). FI-10: enrich the
      // who column with NAMED identities from the live leases.
      if (identity) {
        const own = sessions.find((sess) => sess._file === `${identity.terminalId}.json`)
        const selfDisplay = registry.displayIdentity({ holderIdentity: identity.holderIdentity, label: own && own.label })
        const ownerLabel = new Map((sessions || []).map((sess) => [sess.holderIdentity, sess.label]))
        for (const w of warnObjs) {
          w.whoDisplay = registry.displayIdentity({ holderIdentity: w.who, label: ownerLabel.get(w.who) })
        }
        collision.recordCollisions(warnObjs, { terminalId: identity.terminalId, selfDisplay, journalDir: ctx.dirs.journalDir })
      }
    }
  } catch {
    /* fail-open */
  }

  // (2) push-claim channel (Bash git deploy invocation) — D-49-02 second channel.
  // The two-word deploy invocation is detected with an ESCAPED regex so this
  // source file never carries the adjacent literal (SMA-3 discipline).
  try {
    if (ctx.toolName === 'Bash' && typeof ctx.toolInput.command === 'string' && slots) {
      const pushWord = ['push'].join('') // the deploy verb, isolated
      const deployRe = new RegExp('git\\s+' + pushWord)
      if (deployRe.test(ctx.toolInput.command)) {
        const pc = slots.checkPushClaim(ctx.dirs)
        if (pc && pc.live && pc.warn) warns.push(pc.warn)
      }
    }
  } catch {
    /* fail-open */
  }

  return { warns }
}

/**
 * reflex stream — the P2 reflex consumer (49.1-10). Derives tags → matches promoted
 * bug-lessons → applies the launch-blocking fatigue battery → journals each fire.
 * Mutates the SHARED ctx.seen (loaded/saved once by runPre, not here). WARN-only.
 * Kill-switch SMA_REFLEX_DISABLE (also honored by runPre before this runs).
 */
async function runReflex(ctx) {
  const warns = []
  const { reflex, loader, registry, journal } = ctx.deps
  try {
    if (!reflex || !loader) return { warns }
    const { tags, target, targetClass } = reflex.deriveTags(ctx.toolInput, ctx.repoRoot)
    if (!tags.length) return { warns }

    const corpusDir = join(ctx.repoRoot, '.claude', 'memory')
    const candidates = reflex.matchReflexes({
      tags,
      target,
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      loader,
    })
    if (!candidates.length) return { warns }

    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    let whoDisplay = null
    try {
      if (ctx.identity && registry) whoDisplay = registry.displayIdentity({ holderIdentity: ctx.identity.holderIdentity })
    } catch {
      /* fail-open */
    }

    // Shared seen-store (loaded once in buildCtx) — applyFatigue mutates it in place.
    const res = reflex.applyFatigue({ candidates, targetClass, sessionSeen: ctx.seen, env: ctx.env })
    for (const w of res.warns) warns.push(w.text)

    // Journal each surviving fire (event kind 'reflex') — fail-open.
    if (journal) {
      try {
        for (const w of res.warns) {
          journal.appendEvent(
            { type: 'reflex', actors: [whoDisplay ?? terminalId], scope: target, detail: { noteId: w.noteId, target, tier: w.tier } },
            { terminalId, journalDir: ctx.dirs.journalDir },
          )
        }
      } catch {
        /* a journal failure never blocks the reflex */
      }
    }
  } catch {
    /* fail-open (C9) */
  }
  return { warns }
}

/**
 * gates stream — the P4 enforcement consumer (49.1-16, D-49.1-12/13). Evaluates the
 * checkable HARD-RULE inventory (gates.checkEvent — which journals internally and
 * mutates the SHARED ctx.seen under 'gate:' keys). The ONLY mayDeny:true stream: an
 * armed soft-deny gate returns {deny:{text}}; dormant gates never set deny, so the
 * default posture stays WARN. Kill-switch SMA_GATES_DISABLE.
 */
async function runGates(ctx) {
  const warns = []
  const { gates } = ctx.deps
  try {
    if (!gates) return { warns }
    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    const res = gates.checkEvent({
      evt: ctx.evt,
      root: ctx.repoRoot,
      env: ctx.env,
      seen: ctx.seen, // shared — checkEvent returns opts.seen, mutations land on ctx.seen
      journalDir: ctx.dirs.journalDir,
      terminalId,
      gatesDir: ctx.dirs.gatesDir,
      headSha: ctx.headSha,
      now: ctx.now(),
    })
    for (const w of res.warns) warns.push(w.text)
    if (res.deny) return { warns, deny: { text: res.deny.text } }
  } catch {
    /* fail-open (C9) — a gate failure can NEVER wedge a session */
  }
  return { warns }
}

/**
 * airbag stream — the git airbag GATE (49.2-05, D-49.2-08). Bash-only: matches a
 * destructive git command and writes a ms-level recovery point (update-ref + stash
 * create + batched hash-object/mktree) BEFORE it runs, journaling an 'airbag' receipt.
 * mayDeny:true — an armed (SMA_AIRBAG_DENY) soft-deny on a dirty tree / foreign claim
 * surfaces permissionDecision 'deny' unless a GATE-AIRBAG override token is present.
 *
 * OPT-IN (CONS-49.2-B): the stream is a NO-OP unless SMA_AIRBAG_ENABLE is set —
 * plan 02's hook p95 MISSED the 300 ms SLO, so V3 streams stay opt-in until the
 * multiplexer re-measures under SLO. Protection stays UNCONDITIONAL once enabled
 * (the snapshot is not posture-gated; only the deny tier is). Kill: SMA_AIRBAG_DISABLE.
 */
async function runAirbag(ctx) {
  const warns = []
  try {
    // opt-in default-off until the multiplexer meets its SLO (CONS-49.2-B).
    if (!envOn(ctx.env.SMA_AIRBAG_ENABLE)) return { warns }
    if (ctx.toolName !== 'Bash') return { warns }
    const { airbag, slots } = ctx.deps
    if (!airbag) return { warns }
    const { execFileSync } = await import('node:child_process')
    // execFileSync-shaped runner over the repo root; buffer mode for blob bytes.
    // A FIXED argv array only — no fragment of the tool command ever enters it.
    const runGit = (args, opts = {}) =>
      execFileSync('git', args, { cwd: ctx.repoRoot, input: opts.input, encoding: opts.buffer ? 'buffer' : 'utf8' })
    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    const res = airbag.checkAirbag(ctx.evt, {
      dirs: ctx.dirs,
      runGit,
      env: ctx.env,
      seen: ctx.seen, // shared — the stand-down note dedups under 'airbag:' keys
      now: () => ctx.now(),
      sessions: ctx.sessions,
      selfTerminalId: terminalId,
      slots,
      terminalId,
      repoRoot: ctx.repoRoot,
    })
    for (const w of res.warns) warns.push(w)
    if (res.deny && res.deny.text) return { warns, deny: { text: res.deny.text } }
  } catch {
    /* fail-open (C9) — an airbag bug can NEVER wedge a session */
  }
  return { warns }
}

/**
 * PRE_CHECKS — the ordered internal dispatch pipeline (D-49.2-04). THE registration
 * point plans 05 (airbag) and 09 (spend) extend: each appends one stream object
 * literal here. Order is emit order for warns. collision is WARN-only; gates + airbag
 * are the deny-capable streams (airbag is opt-in until the SLO is met).
 */
export const PRE_CHECKS = [
  { id: 'collision', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: null, mayDeny: false, run: runCollision },
  { id: 'reflex', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_REFLEX_DISABLE', mayDeny: false, run: runReflex },
  { id: 'gates', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_GATES_DISABLE', mayDeny: true, run: runGates },
  { id: 'airbag', tools: ['Bash'], killSwitchEnv: 'SMA_AIRBAG_DISABLE', mayDeny: true, run: runAirbag },
]

// ─────────────────────────── shared context ─────────────────────────────────

/** windowToken from the hook event's session_id (constant across one window). */
function windowTokenFrom(evt) {
  const t = evt && typeof evt.session_id === 'string' ? evt.session_id.trim() : ''
  return t || null
}

/** Truthy env-flag test (matches the reflex/gates kill-switch convention). */
function envOn(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/** Real git HEAD sha probe (read-only, fail-open → null). Injectable for tests. */
async function realGitHeadSha(repoRoot) {
  try {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Lazy-load the real lib modules the streams depend on (overridable in tests). */
async function loadDefaultDeps() {
  const [collision, reflex, gates, loader, slots, journal, registry, airbag] = await Promise.all([
    import('./collision.mjs'),
    import('./reflex.mjs'),
    import('./gates.mjs'),
    import('./loader.mjs'),
    import('./slots.mjs'),
    import('./journal.mjs'),
    import('./registry.mjs'),
    import('./airbag.mjs'),
  ])
  return { collision, reflex, gates, loader, slots, journal, registry, airbag }
}

/**
 * buildCtx({ evt, dirs, env, now, deps, headShaProbe }) — the shared context, built
 * ONCE per tool call. Parses the event; resolves terminal identity ONCE and fires
 * the throttled heartbeat ONCE (moved here so cadence survives a silent collision);
 * reads the sessions snapshot ONCE; loads the per-session seen-store ONCE into
 * ctx.seen (fixes the V2 last-write-wins race: reflex + gates each load+save it
 * today across two processes). Every fallible step is individually try/caught —
 * identity may be null and streams tolerate it, exactly as today.
 */
export async function buildCtx(opts = {}) {
  const evt = opts.evt || {}
  const dirs = opts.dirs || {}
  const env = opts.env || {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const deps = opts.deps || (await loadDefaultDeps())
  const headShaProbe = typeof opts.headShaProbe === 'function' ? opts.headShaProbe : realGitHeadSha

  const toolName = evt && typeof evt.tool_name === 'string' ? evt.tool_name : ''
  const toolInput = (evt && evt.tool_input) || {}
  const sessionToken = windowTokenFrom(evt)
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

  const ctx = {
    evt,
    dirs,
    env,
    now,
    deps,
    toolName,
    toolInput,
    sessionToken,
    repoRoot,
    identity: null,
    sessions: [],
    seen: sessionToken ? { session: sessionToken, keys: {}, notes: {} } : { keys: {}, notes: {} },
    headSha: null,
  }

  // Terminal identity ONCE + throttled heartbeat ONCE (OQ2 cadence).
  try {
    if (deps.registry) {
      ctx.identity = deps.registry.resolveTerminalIdentity({ sessionToken })
      deps.registry.heartbeat(
        { scope: { globs: [], description: '' }, status: 'working' },
        { ...dirs, identity: ctx.identity },
      )
    }
  } catch {
    /* fail-open — identity stays null, streams tolerate it */
  }

  // Sessions snapshot ONCE (collision stream reads it).
  try {
    if (deps.registry) {
      const read = deps.registry.readSessions(dirs)
      ctx.sessions = (read && Array.isArray(read.sessions)) ? read.sessions : []
    }
  } catch {
    /* fail-open — no session read */
  }

  // Seen-store ONCE — the shared store reflex + gates both mutate (race fix).
  try {
    if (deps.reflex) {
      const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
      ctx.seen = deps.reflex.loadSeen({ reflexDir: dirs.reflexDir, terminalId, sessionToken })
    }
  } catch {
    /* fail-open — fresh seen already set */
  }

  // HEAD sha ONCE (gates soft-deny evidence) — skip the git probe when gates is
  // killed (parity: the legacy gates-check early-exited before probing).
  try {
    if (!envOn(env.SMA_GATES_DISABLE)) ctx.headSha = await headShaProbe(repoRoot)
  } catch {
    ctx.headSha = null
  }

  return ctx
}

// ─────────────────────────── the dispatch loop ──────────────────────────────

/**
 * runPre(ctx) → { warns, deny, sample }. Iterates PRE_CHECKS in order:
 *   - SMA_PRE_DISABLE global early-exit (instant no-op, no stream invoked);
 *   - filters by ctx.toolName ∈ stream.tools and the stream's kill-switch;
 *   - per-stream try/catch + elapsed timing via ctx.now;
 *   - soft budget (SMA_PRE_BUDGET_MS, default 1500): once cumulative time is
 *     exceeded, remaining applicable streams are SKIPPED and recorded — late is
 *     skipped, never blocking;
 *   - collects warns IN ORDER; accepts a deny ONLY from a mayDeny stream (first
 *     wins); downgrades any other stream's deny to a warn line (posture protection);
 *   - saves ctx.seen ONCE at the end.
 * Never throws.
 */
export async function runPre(ctx) {
  const warns = []
  let deny = null
  const checks = []
  const t0 = ctx.now()

  if (envOn(ctx.env.SMA_PRE_DISABLE)) {
    return { warns, deny, sample: { ts: new Date().toISOString(), toolName: ctx.toolName, totalMs: 0, checks, disabled: true } }
  }

  const budget = Number(ctx.env.SMA_PRE_BUDGET_MS) > 0 ? Number(ctx.env.SMA_PRE_BUDGET_MS) : DEFAULT_PRE_BUDGET_MS
  let budgetBlown = false

  for (const stream of PRE_CHECKS) {
    // tool-applicability filter.
    if (!Array.isArray(stream.tools) || !stream.tools.includes(ctx.toolName)) continue
    // per-stream kill-switch.
    if (stream.killSwitchEnv && envOn(ctx.env[stream.killSwitchEnv])) continue

    // soft time-budget: once blown, remaining applicable streams are skipped.
    if (budgetBlown) {
      checks.push({ id: stream.id, ms: 0, warns: 0, skipped: true })
      continue
    }

    const s0 = ctx.now()
    let result = { warns: [] }
    let errored = false
    try {
      result = (await stream.run(ctx)) || { warns: [] }
    } catch {
      errored = true // per-stream fail-open (test 3) — remaining streams still run
      result = { warns: [] }
    }
    const ms = Math.max(0, ctx.now() - s0)

    const streamWarns = Array.isArray(result.warns) ? result.warns.filter((w) => typeof w === 'string' && w) : []
    for (const w of streamWarns) warns.push(w)

    // deny handling — posture protection: only a mayDeny stream can surface a deny.
    if (result.deny && result.deny.text) {
      if (stream.mayDeny) {
        if (!deny) deny = { text: String(result.deny.text) }
      } else {
        // DOWNGRADE a non-gates deny to a warn line — never a real deny (test 2).
        warns.push(String(result.deny.text))
      }
    }

    const sample = { id: stream.id, ms, warns: streamWarns.length }
    if (errored) sample.error = true
    checks.push(sample)

    if (ctx.now() - t0 > budget) budgetBlown = true
  }

  // Save the shared seen-store ONCE (both reflex + gates mutations persisted).
  try {
    if (ctx.deps && ctx.deps.reflex) {
      const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
      ctx.deps.reflex.saveSeen(ctx.seen, { reflexDir: ctx.dirs.reflexDir, terminalId })
    }
  } catch {
    /* fail-open — a save failure only costs dedup on the NEXT invocation */
  }

  const totalMs = Math.max(0, ctx.now() - t0)
  return { warns, deny, sample: { ts: new Date().toISOString(), toolName: ctx.toolName, totalMs, checks } }
}

// ─────────────────────────── output merge ───────────────────────────────────

/**
 * mergeOutput({ warns, deny }) → the SINGLE hookSpecificOutput object (or null).
 * deny → permissionDecision 'deny' with the deny text + any collected warns as the
 * reason; warns-only → 'allow' + additionalContext; empty → null (silent success,
 * today's behavior — the harness gets nothing).
 */
export function mergeOutput({ warns = [], deny = null } = {}) {
  const lines = Array.isArray(warns) ? warns.filter((w) => typeof w === 'string' && w) : []
  if (deny && deny.text) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [deny.text, ...lines].join('\n'),
      },
    }
  }
  if (lines.length) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: lines.join('\n'),
      },
    }
  }
  return null
}

// ─────────────────────────── perf telemetry ─────────────────────────────────

/**
 * appendPerfSample(sample, { perfDir, appendFn, statFn, readFn, writeRawFn }) —
 * append one JSONL line to perfDir/pre.jsonl (bounded: when the file exceeds
 * ~256 KB it is atomically rewritten keeping the last 500 lines). Every fs call is
 * injectable so tests never write to disk. Fail-open — a perf-store failure never
 * blocks the hook.
 */
export function appendPerfSample(sample, opts = {}) {
  const perfDir = opts.perfDir
  if (!perfDir) return
  const appendFn = opts.appendFn ?? appendFileSync
  const statFn = opts.statFn ?? statSync
  const readFn = opts.readFn ?? readFileSync
  const writeRawFn = opts.writeRawFn ?? atomicWriteRaw
  const mkdirFn = opts.mkdirFn ?? mkdirSync
  const file = join(perfDir, 'pre.jsonl')
  try {
    mkdirFn(perfDir, { recursive: true })
    appendFn(file, JSON.stringify(sample) + '\n')
    // bound the file: rewrite to the last PERF_KEEP_LINES once it grows past cap.
    let size = 0
    try {
      size = statFn(file).size
    } catch {
      size = 0
    }
    if (size > PERF_MAX_BYTES) {
      const lines = String(readFn(file, 'utf8')).split('\n').filter((l) => l.trim())
      const tail = lines.slice(-PERF_KEEP_LINES).join('\n') + '\n'
      writeRawFn(file, tail)
    }
  } catch {
    /* fail-open — perf telemetry is best-effort */
  }
}

/**
 * computePercentile(values, p) → the nearest-rank percentile (pins pre-bench's
 * arithmetic; identical method to bench.mjs's percentile). Empty → 0.
 */
export function computePercentile(values, p) {
  const nums = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v))
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}
