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
 * idle|done); liveness is `renewTime`/mtime. Staleness is graduated: fresh ->
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
import { translitToLatin } from './translit.mjs'
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

/** the fingerprint's ATTENTION-axis values. Stored on the lease as
 * `fpStatus`, ALONGSIDE the work-axis `status` above, never conflated with it. */
export const FP_STATUS_VALUES = ['working', 'waiting-for-human', 'idle']

/**
 * tokenHash(token) — a short, stable, deterministic 8-hex suffix derived from a
 * window token. Same token in -> same suffix out on every hook invocation of one
 * window, so it is the renewal-safe disambiguator (unlike the volatile pid).
 *
 * EXPORTED because a second reader of this identity now exists: the daemon has to find the
 * files a worker's own session wrote — its citations and its fired reflexes — and those sit
 * under the terminal id minted here. Re-typing the formula over there would be two spellings
 * of one identity, and the day either one changed the daemon would read an empty trace and
 * report «this attempt used no memory» about a session that used plenty.
 */
export function tokenHash(token) {
  return createHash('sha1').update(String(token)).digest('hex').slice(0, 8)
}

/** First non-blank string among the candidates, trimmed; null when none qualify. */
function firstToken(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

// ── the persisted window name: «token hash → human name» ─────────────────────────────
//
// A window name has to SURVIVE the process that chose it. Every SMA hook is a one-shot
// `node cli.mjs`, so a name computed at session start and held in memory is gone by the
// next tool call; only a file on disk lets the second, third and hundredth invocation of
// the SAME window keep the name the first one picked. Without it the only way to have a
// readable window was to export an environment variable by hand, in every window, every
// time — and a name nobody sets is a journal nobody reads.

/** File name of the persisted map, under the state root. */
export const TERMINAL_NAMES_FILE = 'terminal-names.json'

/** The readable default a nameless window is given: «Окно-1», «Окно-2», … */
export const DEFAULT_WINDOW_NAME_PREFIX = 'Окно-'

/** Matches exactly the auto-minted form, so a hand-written name is never counted as one. */
const DEFAULT_WINDOW_NAME_RE = /^Окно-(\d+)$/

/**
 * terminalNamesPath({env, namesFile}) — where the map lives.
 *
 * ANCHORED to the project root, never relative to the working directory: a hook process
 * inherits its cwd from the session and may be standing somewhere else entirely. A relative
 * path here would repeat the hook-loading defect, only quieter — the file would be looked
 * for beside whatever directory happened to be current, silently found missing, and the
 * window would fall back to a machine token while its name sat on disk one directory over.
 * The same anchor the tool gate already reads.
 *
 * @param {{env?:Object, namesFile?:string}} [o]
 * @returns {string}
 */
export function terminalNamesPath(o = {}) {
  if (o.namesFile) return o.namesFile
  const env = o.env ?? process.env
  const anchor = (env && typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim()) || '.'
  return join(anchor, SMA_ROOT, TERMINAL_NAMES_FILE)
}

/**
 * readTerminalNames({env, namesFile}) -> the flat map
 * `{ "<token hash>": { name, auto, at } }`, or `{}` when the file is absent, unreadable or
 * not an object. Fail-open by law (C9, P4): a hook must NEVER die over a name.
 *
 * @param {{env?:Object, namesFile?:string}} [o]
 * @returns {Object}
 */
export function readTerminalNames(o = {}) {
  const data = readJsonSafe(terminalNamesPath(o))
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/**
 * allocateDefaultWindowName({tokenHash, env, namesFile, now}) -> the readable name this
 * window is recorded under: «Окно-N» minted the FIRST time this token is seen, and the very
 * same name returned on every later call for that token (so a second session start is a
 * lookup, not a new number).
 *
 * N is «one more than the highest Окно-N already on file» — deliberately not a count of
 * entries, so removing a line from the map by hand never hands a live window a name that is
 * already taken.
 *
 * Two windows starting in the same instant both read the same file and both write it back
 * whole, and the second write can drop the first one's entry; so we re-read after writing
 * and merge ourselves back in when we are missing. Even a genuine tie is survivable rather
 * than fatal: the terminal id ALWAYS carries the token disambiguator, so two windows sharing
 * a display name still keep separate lease files and separate journals.
 *
 * @param {{tokenHash?:string, env?:Object, namesFile?:string, now?:string}} [o]
 * @returns {string|null} the name, or null when there is no token to record it against
 */
export function allocateDefaultWindowName(o = {}) {
  const hash = o.tokenHash != null ? String(o.tokenHash).trim() : ''
  if (!hash) return null // no window token -> nothing stable to key a name on
  const namesFile = terminalNamesPath(o)

  const names = readTerminalNames({ namesFile })
  const existing = names[hash]
  if (existing && typeof existing.name === 'string' && existing.name.trim()) return existing.name.trim()

  let max = 0
  for (const rec of Object.values(names)) {
    const m = DEFAULT_WINDOW_NAME_RE.exec(rec && typeof rec.name === 'string' ? rec.name.trim() : '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  const name = `${DEFAULT_WINDOW_NAME_PREFIX}${max + 1}`
  const record = { name, auto: true, at: o.now ?? new Date().toISOString() }
  names[hash] = record
  atomicWriteJson(namesFile, names)

  const after = readTerminalNames({ namesFile })
  if (!after[hash] || after[hash].name !== name) {
    after[hash] = record
    try {
      atomicWriteJson(namesFile, after)
    } catch {
      /* fail-open — we still return the name we chose; the next start re-mints it */
    }
  }
  return name
}

/**
 * resolveTerminalIdentity({env, pid, sessionToken}) — window-stable identity.
 *
 * NAME PRECEDENCE, in words, highest first:
 *   (1) env.SMA_TERMINAL_NAME — the name a PERSON set by hand («Мозг» / «Фабрика»). A
 *       human choice outranks anything the system chose for itself, always.
 *   (2) the name PERSISTED for this window token in `.sma/terminal-names.json` — the
 *       readable «Окно-N» handed out once at session start and read back by every later
 *       one-shot hook process of the same window.
 *   (3) the machine fallback that has always been here: `T-<token hash>`, or the volatile
 *       `T-<pid>` when there is no window token at all.
 * terminalId = slugified holderIdentity SUFFIXED WITH a disambiguator so two windows
 * sharing a name never collapse into one id.
 *
 * Reading the persist costs one small JSON read per hook process and is fail-open: an
 * absent or corrupt file simply means «no name», which lands on (3) — exactly the
 * behaviour of every installation that has no names file at all.
 *
 * THE FIX (R7): every SMA hook is a one-shot `node cli.mjs` process, so a
 * pid-based disambiguator changed on EVERY tool call — terminalId fragmented into
 * hundreds of write-once lease files and renewal/throttle/transitions never saw the same
 * identity twice. The disambiguator is now the WINDOW TOKEN when present:
 *   - the token (Claude Code's per-session `session_id`, threaded from the hook stdin, or
 *     SMA_WINDOW_TOKEN / the agent's own session-id variable from the env) is STABLE across SessionStart +
 *     every PreToolUse of ONE window -> sequential hooks renew the SAME lease file; and
 *   - it is DISTINCT between two concurrent windows (two Claude sessions have two
 *     session_ids) -> same-name windows stay distinct (the whole point of having a
 *     disambiguator at all), WITHOUT the pid fragmenting identity across a window's
 *     own sequential invocations.
 * The pid remains ONLY as a last-resort tiebreaker when no window token is available at
 * all (e.g. a bare manual `pnpm sma …` run outside a hook) — the same fallback as before,
 * now scoped to the genuinely-tokenless case instead of every invocation.
 *
 * @param {{env?:Object, pid?:number, sessionToken?:string}} [opts]
 * @returns {{holderIdentity:string, terminalId:string, pid:number, sessionToken:string|null}}
 */
export function resolveTerminalIdentity(opts = {}) {
  const env = opts.env ?? process.env
  const pid = opts.pid ?? process.pid
  // Window token: explicit arg (threaded from the hook stdin session_id) first, else the
  // env overrides SMA_WINDOW_TOKEN and the agent's own session-id variable. firstToken picks the first
  // non-blank string so an absent candidate falls through cleanly (a `&&`/`??` chain
  // would yield `false` and short-circuit the fallthrough — the subtle bug this avoids).
  const sessionToken = firstToken(
    opts.sessionToken,
    env ? env.SMA_WINDOW_TOKEN : undefined,
    // BOTH spellings of the agent's own variable, because the one it actually exports is
    // the longer one and we were reading only the shorter. A name that is wrong by one word
    // fails silently and completely: the token is simply absent, the disambiguator falls back
    // to the process id, and every one-shot call from the same window mints a NEW identity —
    // which is the exact fragmentation the token was introduced to end. Measured on a live
    // window: claims landed in a lease named after the child process instead of the window,
    // so the window's own status line could not find the claim it had just taken, and the
    // session registry filled with leases no window will ever renew. Keep both names: the
    // shorter one may be what other tools set, and an extra candidate costs one comparison.
    env ? env.CLAUDE_CODE_SESSION_ID : undefined,
    env ? env.CLAUDE_SESSION_ID : undefined,
  )

  const named = env && typeof env.SMA_TERMINAL_NAME === 'string' && env.SMA_TERMINAL_NAME.trim()
  // Disambiguator: the STABLE window-token hash when present (renewal-safe), else the pid
  // (last-resort tiebreaker, now only for the tokenless manual case).
  const disambig = sessionToken ? tokenHash(sessionToken) : String(pid)

  // Step (2) of the precedence above — consulted ONLY when nobody set a name by hand and
  // there is a token to key the lookup on.
  let persisted = null
  if (!named && sessionToken) {
    const rec = readTerminalNames({ env, namesFile: opts.namesFile })[disambig]
    if (rec && typeof rec.name === 'string' && rec.name.trim()) persisted = rec
  }

  const holderIdentity = named
    ? env.SMA_TERMINAL_NAME.trim()
    : persisted
      ? persisted.name.trim()
      : sessionToken
        ? `T-${disambig}` // stable per-window fallback name (no more per-invocation churn)
        : `T-${pid}`
  const nameSource = named ? 'env' : persisted ? 'persist' : 'fallback'
  // nameAuto — «is this still a name the SYSTEM chose?». The session-start prompt reads it
  // to decide whether to keep offering a real one: «Окно-3» is readable but not CHOSEN, and
  // the offer should stop the moment a person names the window themselves.
  const nameAuto = nameSource === 'env' ? false : nameSource === 'persist' ? persisted.auto === true : true
  return {
    holderIdentity,
    terminalId: slugify(holderIdentity, disambig),
    pid,
    sessionToken,
    nameSource,
    nameAuto,
  }
}

/**
 * TRANSLITERATE FIRST, then keep [a-z0-9-] and collapse runs of other chars to a single
 * dash; ALWAYS suffix the disambiguator so same-named windows are distinct.
 *
 * Transliteration is what makes the journal readable at all. Cleaning a name character by
 * character throws away every letter the file name cannot carry, so «Окно-3» used to leave
 * nothing behind and the trail was filed under a machine token — the very thing naming a
 * window was meant to end. It uses the SAME shared spelling of «a human name becomes a
 * machine name» the claim directories use: one table of letters for the whole tree, because
 * a naming convention written down twice drifts, and the day the two disagree one half of
 * the system stops finding what the other half created.
 *
 * An empty slug (a name that leaves nothing even after transliteration) still degrades to
 * the disambiguator-only `t-<disambig>` form. When the slug already carries the
 * disambiguator (the auto `T-<disambig>` fallback identity), it is NOT appended twice.
 */
function slugify(name, disambig) {
  const suffix = String(disambig)
  const slug = translitToLatin(String(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return `t-${suffix}` // non-latin/empty name -> disambiguator-only
  if (slug === `t-${suffix}` || slug.endsWith(`-${suffix}`)) return slug // already carries it
  return `${slug}-${suffix}` // disambiguator always present
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

/**
 * dropSession({identity, sessionsDir, smaRoot}) — remove THIS terminal's OWN lease file, so a
 * session that has ended stops being counted as one that is running.
 *
 * WHY A SESSION MUST BE ABLE TO END AT ALL. A lease is created by the first beat and renewed by
 * every later one; until this function existed, the ONLY way one ever disappeared was the reaper,
 * which waits out the whole TTL plus its grace and refuses outright when the claimed scope has
 * fresh mtimes. That is the right posture for a window nobody has heard from — «missing» is not
 * «finished» — and it is the wrong one for a window that SAID it was finished. A fleet that
 * starts a session per attempt filled the registry with windows no process stands behind
 * («Окно-26»…«Окно-31» in one evening), and every one of them was counted as a live neighbour by
 * the collision check.
 *
 * OWN ONLY, and that is the whole safety of it: the file is addressed by the identity handed in,
 * which the caller resolves from ITS OWN window token. There is no scan, no name matching and no
 * heuristic that could reach a stranger's lease — the deliberate contrast with `reapStale`, which
 * judges other sessions and therefore has to wait, probe and refuse.
 *
 * IDEMPOTENT AND FAIL-OPEN (C9, P4): an absent file is `{dropped:false}`, never an error, so
 * ending a session twice is ordinary rather than exceptional.
 *
 * @param {{identity?:Object, sessionsDir?:string, smaRoot?:string, env?:Object, pid?:number, sessionToken?:string}} [opts]
 * @returns {{dropped:boolean, error?:boolean}}
 */
export function dropSession(opts = {}) {
  try {
    const identity = opts.identity ?? resolveTerminalIdentity(opts)
    const terminalId = identity && identity.terminalId
    if (!terminalId) return { dropped: false }
    const file = join(resolveSessionsDir(opts), `${terminalId}.json`)
    if (!fsExistsSync(file)) return { dropped: false }
    fsRmSync(file)
    return { dropped: true }
  } catch {
    return { dropped: false, error: true } // a lease that will not unlink stays for the reaper
  }
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
    // The work label — the founder-readable «what this window works on». Provided by
    // the caller (resolveWorkLabel, recomputed from live context on every beat); when a
    // beat omits it we PRESERVE the existing label rather than blanking it.
    const label =
      typeof beat.label === 'string' && beat.label.trim()
        ? beat.label.trim()
        : existing && typeof existing.label === 'string'
          ? existing.label
          : ''

    // fingerprint fields on the SAME lease (no parallel
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
      label, // founder-readable work label, refreshed from live context
      intent, // fingerprint intent line («чиню тест dispatcher…»)
      fpStatus, // fingerprint attention axis (working|waiting-for-human|idle)
      filesRecent, // self-captured touch trail (mutated by the `sma pre` stream)
      acquireTime,
      renewTime: nowIso, // liveness axis (B16)
      leaseDurationSeconds: SESSION_TTL_MS / 1000,
      transitions,
    }
    atomicWriteJson(file, lease)

    // On the heartbeat cadence: a NON-skipped heartbeat spawns a detached one-shot snapshot
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
 * hasSnapshotReceiver(env) — true only when BOTH halves of the reporter's destination
 * are provisioned: the auth token AND the receiver URL. The engine ships with neither
 * (there is no built-in endpoint), so on an unprovisioned checkout the detached child
 * could only ever build a payload and drop it — pure overhead per beat. This is the
 * predicate that keeps that child from being born at all.
 * @param {Object} [env]
 * @returns {boolean}
 */
export function hasSnapshotReceiver(env) {
  const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''
  return Boolean(env) && nonBlank(env.SMA_SNAPSHOT_TOKEN) && nonBlank(env.SMA_SNAPSHOT_URL)
}

/**
 * spawnDetachedSnapshot(opts) — fire-and-forget `node scripts/sma/cli.mjs snapshot`.
 * detached + stdio:'ignore' + unref so it outlives the short-lived hook process and
 * the parent never blocks on it (a short-lived child is NOT a daemon).
 * Fully fail-open: a spawn error is swallowed. Injectable via opts.spawnFn for tests.
 * @param {{spawnFn?:Function, cliPath?:string, sessionToken?:string|null, env?:Object}} [opts]
 */
function spawnDetachedSnapshot(opts = {}) {
  try {
    // NO RECEIVER -> NO CHILD. Checked FIRST (and for injected spawnFn too, so the
    // behavior is assertable): without a provisioned receiver the child's own entry point
    // returns 'no-token' immediately, so spawning it buys nothing and costs a process per
    // beat — on Windows, historically a process AND a console window.
    if (!hasSnapshotReceiver(opts.env ?? process.env)) return
    // Never launch a real detached snapshot child under a test runner or when the
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
    // Resolve cli.mjs ABSOLUTELY (relative to THIS module) so the detached child
    // finds it regardless of the child's inherited cwd — a relative 'scripts/sma/cli.mjs'
    // silently no-ops when the beat fires from outside the repo root (e.g. a worktree).
    const cliPath = opts.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
    // Carry the window token to the child (SMA_WINDOW_TOKEN) so it resolves the SAME
    // stable terminalId as this window — a fresh detached process has no hook stdin to
    // read session_id from.
    const childEnv = { ...(opts.env ?? process.env) }
    if (opts.sessionToken) childEnv.SMA_WINDOW_TOKEN = opts.sessionToken
    const child = spawnFn(process.execPath, [cliPath, 'snapshot'], {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
      // WINDOWS: a `detached` console child ALWAYS gets its OWN console window unless this
      // is set. Without it every non-throttled beat flashed a new window on the founder's
      // desktop; a session with hundreds of tool calls buried the machine under them.
      windowsHide: true,
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

/** A pid-identity lease: the auto fallback name is literally `T-<pid>`. */
const RE_PID_IDENTITY = /^T-(\d+)$/

/**
 * isPidAlive(pid, {killFn}) — signal-0 liveness probe, FAIL-OPEN toward "alive".
 *   - the process answers            -> alive
 *   - ESRCH (no such process)        -> dead (the ONLY dead verdict)
 *   - EPERM (exists, another user)   -> alive
 *   - anything unexpected / bad pid  -> alive
 * A false "dead" would delete a live terminal's lease, so every ambiguity resolves the
 * safe way. Injectable killFn for tests.
 * @param {number} pid
 * @param {{killFn?:Function}} [opts]
 * @returns {boolean}
 */
export function isPidAlive(pid, opts = {}) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return true // unknowable -> assume alive
  const kill = opts.killFn ?? ((p, sig) => process.kill(p, sig))
  try {
    kill(n, 0)
    return true
  } catch (err) {
    if (err && err.code === 'ESRCH') return false
    return true // EPERM and every unexpected error -> assume alive
  }
}

/**
 * isDeadPidLease(session, {killFn}) — true when the lease's IDENTITY is the volatile
 * pid fallback (`T-<pid>`) AND that pid no longer exists.
 *
 * This narrow shape is the one case where a pid IS authoritative: such a lease can only
 * ever be renewed by the very process whose pid names it (any other process resolves a
 * different terminalId), so a dead pid means the lease is unrenewable — the terminal is
 * physically gone. NAMED / token-hash identities are deliberately excluded: their `pid`
 * field is a one-shot stamp that goes stale across restarts while the window lives on.
 * @param {Object} session
 * @param {{killFn?:Function}} [opts]
 * @returns {boolean}
 */
export function isDeadPidLease(session, opts = {}) {
  try {
    const holder = session && typeof session.holderIdentity === 'string' ? session.holderIdentity.trim() : ''
    const m = RE_PID_IDENTITY.exec(holder)
    if (!m) return false
    return !isPidAlive(Number(m[1]), opts)
  } catch {
    return false // fail-open — an unreadable lease is never declared dead
  }
}

/**
 * classifyStaleness(session, {now, scopeMtimeProbe}) — graduated grading:
 *   fresh          renewTime younger than ATTENTION window
 *   attention      >= ATTENTION_AFTER_MISSES × HEARTBEAT_INTERVAL_MS since renewTime
 *   reap-clean     > SESSION_TTL_MS + GRACE_MS AND claimed globs have NO fresh mtimes
 *   needs-human    reap-eligible but DIRTY (a claimed file changed after renewTime) — P3
 * scopeMtimeProbe(session) -> the max mtime (ms) across the session's claimed globs; a
 * value newer than renewTime means real work happened after the lease went quiet -> dirty.
 *
 * ONE exception to the dirty split: a reap-eligible PID-IDENTITY lease (`T-<pid>`) whose
 * pid is gone is reap-clean regardless of scope mtimes (isDeadPidLease) — a dead pid means
 * that terminal is physically gone, and nothing can ever renew that lease again.
 * @param {Object} session
 * @param {{now?:number, scopeMtimeProbe?:Function, killFn?:Function}} [opts]
 * @returns {{state:string, ageMs:number, dirty:boolean, deadPid?:boolean}}
 */
export function classifyStaleness(session, opts = {}) {
  const now = opts.now ?? Date.now()
  const renewMs = Date.parse(session && session.renewTime)
  const ageMs = Number.isFinite(renewMs) ? now - renewMs : Number.POSITIVE_INFINITY

  const attentionThreshold = ATTENTION_AFTER_MISSES * HEARTBEAT_INTERVAL_MS
  const reapThreshold = SESSION_TTL_MS + GRACE_MS

  if (ageMs < attentionThreshold) return { state: 'fresh', ageMs, dirty: false }
  if (ageMs < reapThreshold) return { state: 'attention', ageMs, dirty: false }

  // Reap-eligible by age. A pid-identity lease whose pid is GONE is reap-clean outright:
  // the terminal it named cannot exist any more, so a dirty claimed scope is not evidence
  // that IT is still working (on a live shared repo the scope is almost always dirtier
  // than the lease's renewTime, which is exactly why these leases used to accumulate as
  // permanent needs-human graveyard entries).
  if (isDeadPidLease(session, opts)) return { state: 'reap-clean', ageMs, dirty: false, deadPid: true }

  // Split clean vs dirty (P3): a fresh mtime inside a claimed glob means work is still
  // happening — flag for a human, never auto-reap.
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
 * sessionActivityTier(session, {now, classify, killFn}) → 'fresh' | 'attention' | 'stale'
 * — THE ONE activity classification. Every path that answers «is this terminal working
 * right now» (the `status` count, the PreToolUse hook's fingerprint digest, the collision
 * detector's hot-file advisory) goes through HERE. It is deliberately a tier, not a
 * boolean, so the one caller that needs the hard-busy tier alone can have it without
 * forking a second rule.
 *
 * TWO gates, ANDed. renewTime freshness is the first (classifyStaleness); the
 * dead-pid-lease rule is the second. The second one is what the divergence was about: a
 * `T-<pid>` lease is written by EVERY one-shot CLI process (`sma claim`, `sma status`…)
 * and keeps a YOUNG renewTime for the full 45-minute window after that process exited, so
 * a renewTime-only reading counts each dead command as a separate live terminal. `status`
 * learned this first and the hook did not — for one afternoon the hook printed 20–80
 * «working» terminals while `status` honestly printed 1. A signal that inflated teaches
 * agents to ignore it, so the rule lives in ONE function with no parallel copy.
 *
 * Fail-closed on error (a lease we cannot classify is NOT reported as working) — which is
 * still fail-open for the caller: nothing throws, nothing wedges.
 * @param {Object} session
 * @param {{now?:number, classify?:Function, killFn?:Function, scopeMtimeProbe?:Function}} [opts]
 * @returns {'fresh'|'attention'|'stale'}
 */
export function sessionActivityTier(session, opts = {}) {
  try {
    const classify = typeof opts.classify === 'function' ? opts.classify : classifyStaleness
    const now = opts.now ?? Date.now()
    const state = classify(session, { now, scopeMtimeProbe: opts.scopeMtimeProbe, killFn: opts.killFn }).state
    if (state !== 'fresh' && state !== 'attention') return 'stale'
    return isDeadPidLease(session, opts) ? 'stale' : state
  } catch {
    return 'stale'
  }
}

/**
 * isSessionLive(session, {now, classify, killFn}) — the boolean face of
 * sessionActivityTier: true when the lease can still be doing work. The predicate the
 * hook, the collision detector and `status` share. Never throws.
 * @param {Object} session
 * @param {{now?:number, classify?:Function, killFn?:Function, scopeMtimeProbe?:Function}} [opts]
 * @returns {boolean}
 */
export function isSessionLive(session, opts = {}) {
  return sessionActivityTier(session, opts) !== 'stale'
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
    const cls = classifyStaleness(s, { now, scopeMtimeProbe: opts.scopeMtimeProbe, killFn: opts.killFn })
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
 * reapStaleObservable(opts) — the reap call path made OBSERVABLE.
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

/** Directory names never worth walking for a scope-mtime probe. */
const PROBE_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.sma'])

/**
 * probeScopeMtime(session, {root, statFn, readdirFn}) — a convenience default probe:
 * the max mtime (ms) across ONLY the files whose repo-relative path matches one of the
 * session's claimed globs under `root`. The plan's public contract accepts an injected
 * probe; this helper is exported for the CLI and the hooks so the mtime source
 * lives in one place. Fail-open: any error -> 0 (treated as clean).
 *
 * Previously this walked the ENTIRE tree (incl. .git/node_modules) and returned
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
        if (PROBE_SKIP_DIRS.has(e.name)) continue // never recurse .git/node_modules/…
        walk(join(dir, e.name))
      } else {
        const full = join(dir, e.name)
        // Only files matching a claimed glob count toward the scope mtime.
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

// ── named sessions: work label + founder-readable display identity ──────────────────
//
// Identity = SMA_TERMINAL_NAME (the human window name) + a WORK LABEL that follows the
// work. The label is recomputed on EVERY heartbeat from live context so a window is
// «P9 Tom — правит slots.mjs», never an anonymous t-3bbdef7f with an empty who column.

/** Read the STATE.md Current-Position phase (e.g. '9.1'), or null. Fail-open. */
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
 * resolveWorkLabel(o) — the work label, by precedence:
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
 * displayIdentity(o) -> founder-readable «P<phase> <Name>». The phase is parsed
 * from the work label (`phase:9` / a `P9` token) or o.phase; the name is the human
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
 * collision/gate journal event (every event records WHO, both terminals, so the
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
