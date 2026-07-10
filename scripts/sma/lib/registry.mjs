/**
 * registry.mjs — heartbeat session registry (R7, B15 lease schema).
 *
 * Per-terminal lease files (.sma/sessions/<terminalId>.json) replace the prose
 * "Active Sessions" STATE.md section with machine-checkable presence. Every write
 * routes through atomicWriteJson + renameWithRetry (overwrite-rename is THE Windows
 * EPERM case — RESEARCH Pitfall 2). Every function is fail-open (C9, P4): bad input /
 * missing dirs / corrupt JSON -> safe default + optional warn count, NEVER a throw
 * that escapes to a hook.
 *
 * Two axes, never conflated (B16): `status` is what the session SAYS (working|blocked|
 * idle|done); liveness is `renewTime`/mtime. Staleness is graduated (D-49-11): fresh ->
 * attention after ATTENTION_AFTER_MISSES missed beats -> reap-eligible after TTL+grace,
 * and reap-eligible splits clean (auto-reapable) vs dirty (fresh mtimes inside claimed
 * globs -> needs-human, NEVER auto-deleted, P3).
 *
 * The throttle is mtime-check-then-skip (RESEARCH Open Question 2): hooks are
 * subprocess-per-event with no daemon, so the only honest throttle is "read own file's
 * renewTime, skip the write if younger than HEARTBEAT_INTERVAL_MS."
 *
 * Node built-ins only; every fs path is dependency-injectable for tests.
 */

import {
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
  rmSync as fsRmSync,
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn as childSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { compileGlob, normalizePath } from './collision.mjs'
import { appendEvent } from './journal.mjs'
import {
  SESSIONS_DIR,
  SMA_ROOT,
  HEARTBEAT_INTERVAL_MS,
  ATTENTION_AFTER_MISSES,
  SESSION_TTL_MS,
  GRACE_MS,
} from './constants.mjs'

/** Valid self-reported status values (C12). Liveness is a SEPARATE axis (B16). */
export const STATUS_VALUES = ['working', 'blocked', 'idle', 'done']

/** 49.3-13 (D-49.3-21) — the fingerprint's ATTENTION-axis values. Stored on the lease as
 * `fpStatus`, ALONGSIDE the work-axis `status` above, never conflated with it. */
export const FP_STATUS_VALUES = ['working', 'waiting-for-human', 'idle']

/**
 * tokenHash(token) — a short, stable, deterministic 8-hex suffix derived from a
 * window token. Same token in -> same suffix out on every hook invocation of one
 * window, so it is the renewal-safe disambiguator (unlike the volatile pid).
 */
function tokenHash(token) {
  return createHash('sha1').update(String(token)).digest('hex').slice(0, 8)
}

/** First non-blank string among the candidates, trimmed; null when none qualify. */
function firstToken(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

/**
 * resolveTerminalIdentity({env, pid, sessionToken}) — D-49-01 window-stable identity.
 *
 * holderIdentity = env.SMA_TERMINAL_NAME (the human window name, «Мозг» / «Фабрика») if
 * set; else a fallback derived from the WINDOW TOKEN when one is available (`T-<hash>`),
 * else the volatile `T-<pid>`. terminalId = slugified holderIdentity SUFFIXED WITH a
 * disambiguator so two windows sharing a name never collapse into one id.
 *
 * THE FIX (R7/D-49-01): every SMA hook is a one-shot `node cli.mjs` process, so a
 * pid-based disambiguator changed on EVERY tool call — terminalId fragmented into
 * hundreds of write-once lease files and renewal/throttle/transitions never saw the same
 * identity twice. The disambiguator is now the WINDOW TOKEN when present:
 *   - the token (Claude Code's per-session `session_id`, threaded from the hook stdin, or
 *     SMA_WINDOW_TOKEN / CLAUDE_SESSION_ID from the env) is STABLE across SessionStart +
 *     every PreToolUse of ONE window -> sequential hooks renew the SAME lease file; and
 *   - it is DISTINCT between two concurrent windows (two Claude sessions have two
 *     session_ids) -> same-name windows stay distinct (the WR-05 goal), WITHOUT the pid
 *     fragmenting identity across a window's own sequential invocations.
 * The pid remains ONLY as a last-resort tiebreaker when no window token is available at
 * all (e.g. a bare manual `pnpm sma …` run outside a hook) — the exact WR-05 fallback,
 * now scoped to the genuinely-tokenless case instead of every invocation.
 *
 * @param {{env?:Object, pid?:number, sessionToken?:string}} [opts]
 * @returns {{holderIdentity:string, terminalId:string, pid:number, sessionToken:string|null}}
 */
export function resolveTerminalIdentity(opts = {}) {
  const env = opts.env ?? process.env
  const pid = opts.pid ?? process.pid
  // Window token: explicit arg (threaded from the hook stdin session_id) first, else the
  // env overrides SMA_WINDOW_TOKEN / CLAUDE_SESSION_ID. firstToken picks the first
  // non-blank string so an absent candidate falls through cleanly (a `&&`/`??` chain
  // would yield `false` and short-circuit the fallthrough — the subtle bug this avoids).
  const sessionToken = firstToken(
    opts.sessionToken,
    env ? env.SMA_WINDOW_TOKEN : undefined,
    env ? env.CLAUDE_SESSION_ID : undefined,
  )

  const named = env && typeof env.SMA_TERMINAL_NAME === 'string' && env.SMA_TERMINAL_NAME.trim()
  // Disambiguator: the STABLE window-token hash when present (renewal-safe), else the pid
  // (WR-05 tiebreaker, now only for the tokenless manual case).
  const disambig = sessionToken ? tokenHash(sessionToken) : String(pid)
  const holderIdentity = named
    ? env.SMA_TERMINAL_NAME.trim()
    : sessionToken
      ? `T-${disambig}` // stable per-window fallback name (no more per-invocation churn)
      : `T-${pid}`
  return { holderIdentity, terminalId: slugify(holderIdentity, disambig), pid, sessionToken }
}

/**
 * Lowercase, keep [a-z0-9-]; collapse runs of other chars to a single dash; ALWAYS
 * suffix the disambiguator so same-named windows are distinct (WR-05). An empty slug
 * (non-latin name) degrades to the disambiguator-only `t-<disambig>` form. When the slug
 * already carries the disambiguator (the auto `T-<disambig>` fallback identity), it is
 * NOT appended twice.
 */
function slugify(name, disambig) {
  const suffix = String(disambig)
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return `t-${suffix}` // non-latin/empty name -> disambiguator-only
  if (slug === `t-${suffix}` || slug.endsWith(`-${suffix}`)) return slug // already carries it
  return `${slug}-${suffix}` // disambiguator always present (WR-05)
}

/**
 * smaRoot({cwd, gitCommonDirFn}) — resolve the MAIN checkout root so a worktree
 * session registers in the shared checkout's .sma/, not its own (SPEC R7). Uses
 * `git rev-parse --git-common-dir`; fail-open to cwd if git is absent.
 * @param {{cwd?:string, gitCommonDirFn?:Function}} [opts]
 * @returns {string}
 */
export function smaRoot(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  try {
    const run =
      opts.gitCommonDirFn ??
      (() => execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim())
    const commonDir = run()
    if (!commonDir) return cwd
    // --git-common-dir points at the shared `.git`; its parent is the main repo root.
    // For a normal checkout it is '.git' (relative) -> parent resolves to cwd.
    const abs = commonDir.replace(/[\\/]+/g, '/')
    const parent = abs.replace(/\/?\.git\/?$/i, '') || cwd
    return parent || cwd
  } catch {
    return cwd // git absent / not a repo -> fail-open to cwd
  }
}

function resolveSessionsDir(opts = {}) {
  if (opts.sessionsDir) return opts.sessionsDir
  const root = opts.smaRoot ?? SMA_ROOT
  return opts.smaRoot ? join(root, 'sessions') : SESSIONS_DIR
}

/** True when two scope objects declare the same globs (order-sensitive) + description. */
function scopeUnchanged(a, b) {
  if (!a || !b) return a === b
  const ga = Array.isArray(a.globs) ? a.globs : []
  const gb = Array.isArray(b.globs) ? b.globs : []
  return ga.length === gb.length && ga.every((g, i) => g === gb[i]) && (a.description ?? '') === (b.description ?? '')
}

/**
 * heartbeat({scope, status, blockers}, opts) — create/renew this terminal's lease.
 * Reads own file: if it exists, renewTime younger than HEARTBEAT_INTERVAL_MS, AND
 * scope+status unchanged -> {skipped:true} (mtime-check-then-skip throttle, OQ2).
 * Otherwise writes the full B15 lease via atomicWriteJson, preserving acquireTime,
 * bumping renewTime, incrementing transitions ONLY on a scope change (B28).
 * Fail-open: any error -> {skipped:false, error:true}, never a throw (C9, P4).
 * @param {{scope:Object, status:string, blockers?:Array}} beat
 * @param {{sessionsDir?:string, smaRoot?:string, identity?:Object, now?:number}} [opts]
 * @returns {{skipped:boolean, error?:boolean}}
 */
export function heartbeat(beat, opts = {}) {
  try {
    const dir = resolveSessionsDir(opts)
    const identity = opts.identity ?? resolveTerminalIdentity(opts)
    const file = join(dir, `${identity.terminalId}.json`)
    const nowMs = opts.now ?? Date.now()
    const nowIso = new Date(nowMs).toISOString()

    const scope = beat.scope ?? { globs: [], description: '' }
    const status = STATUS_VALUES.includes(beat.status) ? beat.status : 'working'
    const blockers = Array.isArray(beat.blockers) ? beat.blockers : []

    const existing = readJsonSafe(file)
    // FI-10 work label — the founder-readable «what this window works on». Provided by
    // the caller (resolveWorkLabel, recomputed from live context on every beat); when a
    // beat omits it we PRESERVE the existing label rather than blanking it.
    const label =
      typeof beat.label === 'string' && beat.label.trim()
        ? beat.label.trim()
        : existing && typeof existing.label === 'string'
          ? existing.label
          : ''

    // 49.3-13 (D-49.3-21) — fingerprint fields on the SAME lease (D-49.3-02: no parallel
    // store). intent is the agent-maintained one-line string (preserved when a beat omits
    // it, never invented); fpStatus is the attention axis; filesRecent is preserved here
    // (the `sma pre` self-capture is its primary mutator — a separate no-spawn write).
    const intent =
      typeof beat.intent === 'string' && beat.intent.trim()
        ? beat.intent.trim()
        : existing && typeof existing.intent === 'string'
          ? existing.intent
          : ''
    const fpStatus = FP_STATUS_VALUES.includes(beat.fpStatus)
      ? beat.fpStatus
      : existing && FP_STATUS_VALUES.includes(existing.fpStatus)
        ? existing.fpStatus
        : 'working'
    const filesRecent = existing && Array.isArray(existing.filesRecent) ? existing.filesRecent : []

    if (existing) {
      const renewMs = Date.parse(existing.renewTime)
      const young = Number.isFinite(renewMs) && nowMs - renewMs < HEARTBEAT_INTERVAL_MS
      const sameScope = scopeUnchanged(existing.scope, scope)
      const sameStatus = existing.status === status
      // The label is a meaningful-change axis too: a refreshed label (the work moved to a
      // new phase/scope) forces a write so the founder-visible identity follows the work.
      const sameLabel = (existing.label ?? '') === label
      // Fingerprint intent/fpStatus are meaningful too (they follow the work). filesRecent
      // is NOT a throttle axis — the self-capture writes it directly, bypassing this beat,
      // so a touch never forces (and never spawns) an extra snapshot from here.
      const sameIntent = (existing.intent ?? '') === intent
      const sameFp = (existing.fpStatus ?? 'working') === fpStatus
      if (young && sameScope && sameStatus && sameLabel && sameIntent && sameFp) {
        return { skipped: true } // throttle: nothing meaningful changed within the interval
      }
    }

    const acquireTime = existing && existing.acquireTime ? existing.acquireTime : nowIso
    const priorTransitions = existing && Number.isFinite(existing.transitions) ? existing.transitions : 0
    const scopeChanged = !existing || !scopeUnchanged(existing.scope, scope)
    const transitions = existing && scopeChanged ? priorTransitions + 1 : priorTransitions

    const lease = {
      holderIdentity: identity.holderIdentity,
      pid: identity.pid,
      scope: { globs: Array.isArray(scope.globs) ? scope.globs : [], description: scope.description ?? '' },
      status, // self-reported (B16)
      blockers,
      label, // FI-10 — founder-readable work label, refreshed from live context
      intent, // 49.3-13 (D-49.3-21) — fingerprint intent line («чиню тест dispatcher…»)
      fpStatus, // 49.3-13 — fingerprint attention axis (working|waiting-for-human|idle)
      filesRecent, // 49.3-13 — self-captured touch trail (mutated by the `sma pre` stream)
      acquireTime,
      renewTime: nowIso, // liveness axis (B16)
      leaseDurationSeconds: SESSION_TTL_MS / 1000,
      transitions,
    }
    atomicWriteJson(file, lease)

    // D-49-11 cadence: a NON-skipped heartbeat spawns a detached one-shot snapshot
    // reporter (fire-and-forget) so the CRM mirror refreshes on the same cadence
    // WITHOUT a daemon and WITHOUT the hook ever waiting on the network. The child
    // is unref'd so the parent (the PreToolUse hook) exits immediately; any spawn
    // failure is swallowed (fail-open, C9/P4 — the reporter never wedges a beat).
    // Suppressible via opts.spawnSnapshot === false (tests / nested invocations).
    // Thread this window's token to the child so its own resolveTerminalIdentity yields
    // the SAME terminalId — otherwise the detached snapshot process (a fresh Node with no
    // hook stdin) would report under a different id and defeat the CRM mirror's
    // per-terminal LWW keying once SMA_SNAPSHOT_TOKEN (A-047) is provisioned.
    if (opts.spawnSnapshot !== false) spawnDetachedSnapshot({ ...opts, sessionToken: identity.sessionToken })

    return { skipped: false }
  } catch {
    return { skipped: false, error: true } // fail-open — never wedge a session (P4, C9)
  }
}

/**
 * spawnDetachedSnapshot(opts) — fire-and-forget `node scripts/sma/cli.mjs snapshot`.
 * detached + stdio:'ignore' + unref so it outlives the short-lived hook process and
 * the parent never blocks on it (a short-lived child is NOT a daemon, D-49-11).
 * Fully fail-open: a spawn error is swallowed. Injectable via opts.spawnFn for tests.
 * @param {{spawnFn?:Function, cliPath?:string, sessionToken?:string|null}} [opts]
 */
function spawnDetachedSnapshot(opts = {}) {
  try {
    // WR-10: never launch a real detached snapshot child under a test runner or when the
    // kill-switch is set. Otherwise every non-throttled beat in the suite spawns a stray
    // unref'd Node child that reads the real repo .sma/ and (if a token is present) POSTs
    // to the production receiver from a test run. An injected spawnFn (tests) still runs,
    // so behavior can be asserted deterministically without a real process.
    if (
      !opts.spawnFn &&
      (process.env.SMA_DISABLE_SNAPSHOT_SPAWN || process.env.VITEST || process.env.NODE_ENV === 'test')
    ) {
      return
    }
    const spawnFn = opts.spawnFn ?? childSpawn
    // WR-06: resolve cli.mjs ABSOLUTELY (relative to THIS module) so the detached child
    // finds it regardless of the child's inherited cwd — a relative 'scripts/sma/cli.mjs'
    // silently no-ops when the beat fires from outside the repo root (e.g. a worktree).
    const cliPath = opts.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
    // Carry the window token to the child (SMA_WINDOW_TOKEN) so it resolves the SAME
    // stable terminalId as this window — a fresh detached process has no hook stdin to
    // read session_id from.
    const childEnv = { ...process.env }
    if (opts.sessionToken) childEnv.SMA_WINDOW_TOKEN = opts.sessionToken
    const child = spawnFn(process.execPath, [cliPath, 'snapshot'], {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
    })
    if (child && typeof child.unref === 'function') child.unref()
  } catch {
    /* fail-open — the reporter is best-effort; a failed spawn never affects the beat */
  }
}

/**
 * readSessions(opts) -> {sessions, corrupt, warnings}. Parses all session files
 * (skips corrupt with a count), detects duplicate holderIdentity via pid mismatch ->
 * a duplicate-identity warning naming every pid (SPEC edge: concurrency R7).
 * Never throws — a missing/corrupt dir yields an empty read (C9, P4).
 * @param {{sessionsDir?:string, smaRoot?:string}} [opts]
 */
export function readSessions(opts = {}) {
  const dir = resolveSessionsDir(opts)
  let files
  try {
    files = fsReaddirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return { sessions: [], corrupt: 0, warnings: [] } // missing dir / not-a-dir -> empty
  }

  const sessions = []
  let corrupt = 0
  for (const f of files) {
    const parsed = readJsonSafe(join(dir, f))
    if (parsed && typeof parsed === 'object') sessions.push({ ...parsed, _file: f })
    else corrupt += 1 // fail-open — skip-and-count
  }

  const warnings = []
  const byIdentity = new Map()
  for (const s of sessions) {
    if (!s.holderIdentity) continue
    if (!byIdentity.has(s.holderIdentity)) byIdentity.set(s.holderIdentity, [])
    byIdentity.get(s.holderIdentity).push(s.pid)
  }
  for (const [holderIdentity, pids] of byIdentity) {
    const uniquePids = [...new Set(pids.filter((p) => p != null))]
    if (uniquePids.length > 1) {
      warnings.push({ type: 'duplicate-identity', holderIdentity, pids: uniquePids })
    }
  }

  return { sessions, corrupt, warnings }
}

/**
 * classifyStaleness(session, {now, scopeMtimeProbe}) — graduated grading (D-49-11):
 *   fresh          renewTime younger than ATTENTION window
 *   attention      >= ATTENTION_AFTER_MISSES × HEARTBEAT_INTERVAL_MS since renewTime
 *   reap-clean     > SESSION_TTL_MS + GRACE_MS AND claimed globs have NO fresh mtimes
 *   needs-human    reap-eligible but DIRTY (a claimed file changed after renewTime) — P3
 * scopeMtimeProbe(session) -> the max mtime (ms) across the session's claimed globs; a
 * value newer than renewTime means real work happened after the lease went quiet -> dirty.
 * @param {Object} session
 * @param {{now?:number, scopeMtimeProbe?:Function}} [opts]
 * @returns {{state:string, ageMs:number, dirty:boolean}}
 */
export function classifyStaleness(session, opts = {}) {
  const now = opts.now ?? Date.now()
  const renewMs = Date.parse(session && session.renewTime)
  const ageMs = Number.isFinite(renewMs) ? now - renewMs : Number.POSITIVE_INFINITY

  const attentionThreshold = ATTENTION_AFTER_MISSES * HEARTBEAT_INTERVAL_MS
  const reapThreshold = SESSION_TTL_MS + GRACE_MS

  if (ageMs < attentionThreshold) return { state: 'fresh', ageMs, dirty: false }
  if (ageMs < reapThreshold) return { state: 'attention', ageMs, dirty: false }

  // Reap-eligible by age. Split clean vs dirty (P3): a fresh mtime inside a claimed
  // glob means work is still happening — flag for a human, never auto-reap.
  let dirty = false
  const globs = session && session.scope && Array.isArray(session.scope.globs) ? session.scope.globs : []
  if (opts.scopeMtimeProbe && globs.length) {
    try {
      const maxMtime = opts.scopeMtimeProbe(session)
      if (Number.isFinite(maxMtime) && Number.isFinite(renewMs) && maxMtime > renewMs) dirty = true
    } catch {
      dirty = false // probe failure -> treat as clean (fail-open), still not auto-destructive
    }
  }
  return dirty ? { state: 'needs-human', ageMs, dirty: true } : { state: 'reap-clean', ageMs, dirty: false }
}

/**
 * reapStale({sessionsDir, now, dryRun, scopeMtimeProbe}) — the ONLY code path that
 * removes a session file, and only for entries classifyStaleness rates 'reap-clean'.
 * Dirty / fresh / attention entries are left untouched (P3). Returns the reaped
 * holderIdentity list; dryRun computes the list without deleting. Fail-open (C9).
 * @param {{sessionsDir?:string, smaRoot?:string, now?:number, dryRun?:boolean, scopeMtimeProbe?:Function}} [opts]
 * @returns {{reaped:string[], candidates:string[]}}
 */
export function reapStale(opts = {}) {
  const { sessions } = readSessions(opts)
  const dir = resolveSessionsDir(opts)
  const now = opts.now ?? Date.now()
  const reaped = []
  const candidates = []

  for (const s of sessions) {
    const cls = classifyStaleness(s, { now, scopeMtimeProbe: opts.scopeMtimeProbe })
    if (cls.state !== 'reap-clean') continue
    candidates.push(s.holderIdentity)
    if (opts.dryRun) continue
    const file = join(dir, s._file ?? `${s.holderIdentity}.json`)
    try {
      if (fsExistsSync(file)) fsRmSync(file)
      reaped.push(s.holderIdentity)
    } catch {
      // fail-open — a failed unlink is not fatal; the entry simply stays for next pass
    }
  }
  return { reaped, candidates }
}

/**
 * reapStaleObservable(opts) — BL-158 (D-49.3-22f): the reap call path made OBSERVABLE.
 * The prior sole call site (cmdStatus/gatherSummary) wrapped reapStale in a SILENT
 * try/catch, so a reap failure was invisible and uncountable — the reaper could stop
 * running and nobody would know. This wrapper stays fail-open (a reap bug NEVER wedges a
 * session) BUT journals a countable signal: a `reap` event carrying the reaped count on
 * success, a `reap-fail` event carrying the error on a throw. Liveness stays renewTime-only
 * (reapStale -> classifyStaleness, no pid). Injectable reapFn for tests.
 * @param {{reapFn?:Function, journalDir?:string, terminalId?:string, now?:string, ...}} opts
 * @returns {{reaped:string[], candidates:string[], ok:boolean, error?:boolean}}
 */
export function reapStaleObservable(opts = {}) {
  const reapFn = typeof opts.reapFn === 'function' ? opts.reapFn : reapStale
  const journalDir = opts.journalDir
  const terminalId = opts.terminalId || 'reaper'
  try {
    const res = reapFn(opts) || { reaped: [], candidates: [] }
    const count = Array.isArray(res.reaped) ? res.reaped.length : 0
    if (count > 0 && journalDir) {
      try {
        appendEvent(
          { type: 'reap', actors: [terminalId], detail: { reaped: count } },
          { terminalId, journalDir, now: opts.now },
        )
      } catch {
        /* fail-open — the diagnostic is best-effort */
      }
    }
    return { reaped: res.reaped ?? [], candidates: res.candidates ?? [], ok: true }
  } catch (err) {
    if (journalDir) {
      try {
        appendEvent(
          { type: 'reap-fail', actors: [terminalId], detail: { error: String((err && err.message) || err) } },
          { terminalId, journalDir, now: opts.now },
        )
      } catch {
        /* fail-open */
      }
    }
    return { reaped: [], candidates: [], ok: false, error: true }
  }
}

/** Directory names never worth walking for a scope-mtime probe (WR-01). */
const PROBE_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.sma'])

/**
 * probeScopeMtime(session, {root, statFn, readdirFn}) — a convenience default probe:
 * the max mtime (ms) across ONLY the files whose repo-relative path matches one of the
 * session's claimed globs under `root`. The plan's public contract accepts an injected
 * probe; this helper is exported for the CLI (49-10) / hooks (49-12) so the mtime source
 * lives in one place. Fail-open: any error -> 0 (treated as clean).
 *
 * WR-01: previously this walked the ENTIRE tree (incl. .git/node_modules) and returned
 * the newest mtime anywhere, so any scoped reap-eligible session was classified
 * needs-human forever on an active repo, and the unbounded walk blew the 5s hook budget.
 * It now compiles the claimed globs, skips heavy dirs, and only considers matching files.
 * @param {Object} session
 * @param {{root?:string, statFn?:Function, readdirFn?:Function}} [opts]
 * @returns {number}
 */
export function probeScopeMtime(session, opts = {}) {
  const root = opts.root ?? process.cwd()
  const statFn = opts.statFn ?? fsStatSync
  const readdirFn = opts.readdirFn ?? fsReaddirSync
  const globs = session && session.scope && Array.isArray(session.scope.globs) ? session.scope.globs : []
  if (!globs.length) return 0

  // Compile each claimed glob once; a malformed glob is skipped (fail-open).
  const matchers = []
  for (const g of globs) {
    try {
      matchers.push(compileGlob(g))
    } catch {
      /* skip malformed glob */
    }
  }
  if (!matchers.length) return 0

  const rootNorm = normalizePath(root).replace(/\/+$/, '') + '/'
  const relNorm = (full) => {
    const n = normalizePath(full)
    return n.startsWith(rootNorm) ? n.slice(rootNorm.length) : n
  }

  let max = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirFn(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (PROBE_SKIP_DIRS.has(e.name)) continue // WR-01: never recurse .git/node_modules/…
        walk(join(dir, e.name))
      } else {
        const full = join(dir, e.name)
        // WR-01: only files matching a claimed glob count toward the scope mtime.
        if (!matchers.some((m) => m.test(relNorm(full)))) continue
        try {
          const m = statFn(full).mtimeMs
          if (m > max) max = m
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  try {
    walk(root)
  } catch {
    return 0
  }
  return max
}

// ── FI-10 — named sessions: work label + founder-readable display identity ──────────
//
// Identity = SMA_TERMINAL_NAME (the human window name) + a WORK LABEL that follows the
// work. The label is recomputed on EVERY heartbeat from live context so a window is
// «P49 Tom — правит slots.mjs», never an anonymous t-3bbdef7f with an empty who column.

/** Read the STATE.md Current-Position phase (e.g. '49.1'), or null. Fail-open. */
function readStatePhase(statePath, readFileFn) {
  if (!statePath) return null
  try {
    const read = readFileFn ?? ((p) => fsReadFileSync(p, 'utf8'))
    const text = read(statePath)
    const m = /Phase:\s*([\d.]+)/.exec(String(text))
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * resolveWorkLabel(o) — the FI-10 work label, by precedence:
 *   (1) an ACTIVE claimed scope (o.claimScope — the scope this window claimed) wins;
 *   (2) else the phase named in STATE.md Current Position (o.statePath) -> `phase:<N>`;
 *   (3) else the invoking /sma-* command (first non-flag token of o.argv);
 *   (4) else 'idle'.
 * Called on every heartbeat so the label follows the work. Pure + fail-open.
 *
 * @param {{claimScope?:string, statePath?:string, argv?:string[], readFileFn?:Function}} [o]
 * @returns {string}
 */
export function resolveWorkLabel(o = {}) {
  if (typeof o.claimScope === 'string' && o.claimScope.trim()) return o.claimScope.trim()

  const phase = readStatePhase(o.statePath, o.readFileFn)
  if (phase) return `phase:${phase}`

  const argv = Array.isArray(o.argv) ? o.argv : []
  for (const a of argv) {
    if (typeof a === 'string' && a.trim() && !a.startsWith('-')) return a.trim()
  }
  return 'idle'
}

/**
 * displayIdentity(o) -> founder-readable «P<phase> <Name>» (FI-10). The phase is parsed
 * from the work label (`phase:49` / a `P49` token) or o.phase; the name is the human
 * SMA_TERMINAL_NAME. An auto `T-<hash>` fallback counts as «no human name» and is dropped
 * (the anti-anonymous goal): with a phase it degrades to «P<phase>», else to the raw
 * token / «—».
 *
 * @param {{holderIdentity?:string, label?:string, phase?:string|number}} [o]
 * @returns {string}
 */
export function displayIdentity(o = {}) {
  const raw = o.holderIdentity != null ? String(o.holderIdentity).trim() : ''
  const isAnon = !raw || /^T-/i.test(raw) // an auto fallback token is not a human name
  const name = isAnon ? null : raw

  const label = o.label != null ? String(o.label) : ''
  const pm = /phase:([\d.]+)/i.exec(label) || /\bP([\d.]+)\b/.exec(label)
  const phase = pm ? pm[1] : o.phase != null && String(o.phase).trim() ? String(o.phase).trim() : null

  if (phase && name) return `P${phase} ${name}`
  if (name) return name
  if (phase) return `P${phase}`
  return raw || '—'
}

/**
 * buildJournalActors({self, other}) -> [selfDisplay, otherDisplay] named identities for a
 * collision/gate journal event (FI-10 — every event records WHO, both terminals, so the
 * journal's who column is never empty and forensics is not manual).
 *
 * @param {{self?:object, other?:object}} [o] each {holderIdentity,label,phase}
 * @returns {string[]}
 */
export function buildJournalActors(o = {}) {
  const out = []
  if (o.self) out.push(displayIdentity(o.self))
  if (o.other) out.push(displayIdentity(o.other))
  return out
}
