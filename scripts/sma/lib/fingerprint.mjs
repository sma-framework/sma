/**
 * fingerprint.mjs — the live work fingerprint (49.3-13, D-49.3-21/22/23).
 *
 * The founder ask, verbatim: «терминалы не понимают, что сейчас ведётся в работе,
 * кто что сделал; ROADMAP/STATE такого результата не дают; нужен отпечаток, читаемый
 * между строк, понятный на языке агента.» This module makes «what is each terminal
 * doing RIGHT NOW, and can I trust this collision warning» answerable from local files
 * only, in the agent's own language.
 *
 * ═══════════════════════════ THE FINGERPRINT LOCKS (D-49.3-21) ═══════════════════════
 *
 * ATTRIBUTION IS HOOK SELF-CAPTURE (D-49.3-21a). Each terminal's `sma pre` hook appends
 * its OWN Edit/Write file_path to its OWN session lease at the moment of touching —
 * riding the existing once-per-tool-call buildCtx heartbeat (ZERO new spawns). `git
 * status` is NEVER an attribution source: on a shared tree it shows the UNION of every
 * terminal's work, so reading it would mis-attribute another terminal's edits. recordTouch
 * here is PURE over an injected lease — it structurally cannot read git (T-49.3-13-A).
 *
 * THE FINGERPRINT EXTENDS THE LEASE (D-49.3-02). There is NO parallel `.sma/fingerprint/`
 * store: the lease (registry.mjs heartbeat payload) gains `intent` + `filesRecent[]` +
 * `fpStatus`, and buildFingerprint reads them back. The pre-injection, `pnpm sma status`,
 * and plan-07's statusline all READ this ONE fingerprint — plan 07 is its renderer, so
 * plan 13 waves BEFORE plan 07 (W2 before W3).
 *
 * INJECTION IS TWO CHANNELS, NEVER PER-TOOL-CALL SPAM (D-49.3-21c): (1) a compact AMBIENT
 * digest of all live terminals (one line each — status + intent + phase) throttled to
 * ~every AMBIENT_DIGEST_MS via a renewTime-age compare (NEVER a setInterval/daemon);
 * PLUS (2) the FULL fingerprint of terminal B injected IMMEDIATELY when A touches a
 * file/scope inside B's fingerprint.
 *
 * TWO AXES, NEVER CONFLATED (B16, D-49.3-22f): `fpStatus` (working|waiting-for-human|idle)
 * is the fingerprint's ATTENTION axis — what the agent SAYS it is doing. Liveness is the
 * lease's renewTime freshness ONLY — pid is NEVER consulted (pid is stale across Claude
 * restarts). The lease already carries a work-axis `status`; `fpStatus` sits alongside it
 * without conflation.
 *
 * FAIL-OPEN EVERYWHERE (substrate law C9): every function degrades to a safe default on
 * any error; nothing throws. A coordination bug can NEVER wedge a session.
 *
 * Node built-ins only; everything dependency-injectable so tests never touch the real
 * .sma/, never shell out for attribution, never spend a token. Zero npm deps.
 */

import { classifyStaleness } from './registry.mjs'
import { normalizePath, compileGlob } from './collision.mjs'
import { appendEvent, journalTail } from './journal.mjs'
import { FINGERPRINT_FILES_WINDOW_MS, FINGERPRINT_FILES_MAX, AMBIENT_DIGEST_MS } from './constants.mjs'

/** The fingerprint's attention-axis values (D-49.3-21). Distinct from the lease's
 * work-axis `status` (working|blocked|idle|done) — the two axes never conflate. */
export const FP_STATUS_VALUES = ['working', 'waiting-for-human', 'idle']

export { FINGERPRINT_FILES_WINDOW_MS, AMBIENT_DIGEST_MS }

/** terminalId derived from a session file name ('fabrika.json' -> 'fabrika'), else the
 * holderIdentity, else null. Mirrors collision.mjs's private terminalIdOf. */
function terminalIdOf(session) {
  if (session && typeof session._file === 'string') return session._file.replace(/\.json$/i, '')
  if (session && typeof session.holderIdentity === 'string') return session.holderIdentity
  return null
}

/**
 * recordTouch({lease, filePath, now, windowMs}) — PURE self-capture (D-49.3-21a).
 * Returns a NEW filesRecent[] with {path, ts} appended, dropping entries older than
 * FINGERPRINT_FILES_WINDOW_MS and capping to the most recent FINGERPRINT_FILES_MAX.
 * Attribution comes ONLY from the passed filePath (the hook's own toolInput). It takes
 * NO git dependency and calls nothing external — an injected git double is NEVER touched.
 * @param {{lease:Object, filePath:string, now?:number, windowMs?:number}} opts
 * @returns {Array<{path:string, ts:number}>}
 */
export function recordTouch(opts = {}) {
  const lease = opts.lease || {}
  const t = Number.isFinite(opts.now) ? opts.now : Date.now()
  const w = Number.isFinite(opts.windowMs) ? opts.windowMs : FINGERPRINT_FILES_WINDOW_MS
  const prior = Array.isArray(lease.filesRecent) ? lease.filesRecent : []
  const path = typeof opts.filePath === 'string' ? opts.filePath.trim() : ''
  const next = path ? [...prior, { path, ts: t }] : [...prior]
  // Drop entries older than the window; keep only well-formed {path, ts}.
  const kept = next.filter((e) => e && typeof e.path === 'string' && Number.isFinite(e.ts) && t - e.ts < w)
  // Cap to the most-recent N (defensive against a burst inside one window).
  return kept.slice(-FINGERPRINT_FILES_MAX)
}

/**
 * buildFingerprint({lease, journalTail, now, windowMs}) — the canonical per-terminal
 * fingerprint object. PURE over the injected lease + journal tail (never reads disk).
 *   { terminalId, phasePlan, filesRecent[], lastEvents:[<=3], claims[], intent, status }
 * status ∈ FP_STATUS_VALUES; intent is the lease's one-line string ('' when unset, never
 * invented); filesRecent is windowed to the touch window.
 * @param {{lease:Object, journalTail?:Array, now?:number, windowMs?:number}} opts
 * @returns {Object}
 */
export function buildFingerprint(opts = {}) {
  const lease = opts.lease || {}
  const t = Number.isFinite(opts.now) ? opts.now : Date.now()
  const w = Number.isFinite(opts.windowMs) ? opts.windowMs : FINGERPRINT_FILES_WINDOW_MS

  const filesRecent = (Array.isArray(lease.filesRecent) ? lease.filesRecent : [])
    .filter((e) => e && typeof e.path === 'string' && Number.isFinite(e.ts) && t - e.ts < w)
    .map((e) => e.path)

  const tail = Array.isArray(opts.journalTail) ? opts.journalTail : []
  const lastEvents = tail.slice(-3).map((e) => (e && typeof e.type === 'string' ? e.type : String(e && e.type)))

  const claims = lease.scope && Array.isArray(lease.scope.globs) ? lease.scope.globs : []
  const intent = typeof lease.intent === 'string' ? lease.intent : ''
  const status = FP_STATUS_VALUES.includes(lease.fpStatus) ? lease.fpStatus : 'working'
  const phasePlan = typeof lease.label === 'string' ? lease.label : ''

  return {
    terminalId: terminalIdOf(lease),
    holderIdentity: lease.holderIdentity ?? null,
    phasePlan,
    filesRecent,
    lastEvents,
    claims,
    intent,
    status,
  }
}

/** True when a session is LIVE (renewTime-only liveness: fresh OR attention). pid is
 * NEVER consulted (D-49.3-22f). Injectable classify for tests. */
function isLive(session, now, classify) {
  const cl = classify ?? classifyStaleness
  try {
    const st = cl(session, { now }).state
    return st === 'fresh' || st === 'attention'
  } catch {
    return false
  }
}

/** Compact one-line digest of a fingerprint/lease (status · intent-or-phase · id). Pure,
 * deterministic — no time formatting, so identical inputs yield identical text. */
function digestLine(lease) {
  const id = lease.holderIdentity || terminalIdOf(lease) || '—'
  const status = FP_STATUS_VALUES.includes(lease.fpStatus) ? lease.fpStatus : 'working'
  const intent = typeof lease.intent === 'string' && lease.intent.trim() ? lease.intent.trim() : ''
  const phase = typeof lease.label === 'string' && lease.label.trim() ? lease.label.trim() : ''
  const what = intent || phase || '—'
  return `${id} · ${status} · ${what}`
}

/**
 * ambientDigest({sessions, lastDigestAt, now, digestMs, selfTerminalId, classify}) —
 * one compact line per LIVE terminal (D-49.3-21c channel 1) when the ~AMBIENT_DIGEST_MS
 * cadence has elapsed since lastDigestAt; otherwise {skipped:true}. The cadence is a
 * renewTime-age compare, NEVER a timer. Deterministic: identical inputs -> identical text.
 * @returns {{skipped:true} | {skipped:false, lines:string[], text:string}}
 */
export function ambientDigest(opts = {}) {
  const t = Number.isFinite(opts.now) ? opts.now : Date.now()
  const cadence = Number.isFinite(opts.digestMs) ? opts.digestMs : AMBIENT_DIGEST_MS
  const last = Number.isFinite(opts.lastDigestAt) ? opts.lastDigestAt : 0
  if (t - last < cadence) return { skipped: true }

  const self = opts.selfTerminalId ?? null
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : []
  const lines = []
  for (const s of sessions) {
    if (!s) continue
    if (self && terminalIdOf(s) === self) continue // one's own line is redundant
    if (!isLive(s, t, opts.classify)) continue
    lines.push(digestLine(s))
  }
  return { skipped: false, lines, text: lines.join('\n') }
}

/** Does a normalized (repo-relative) path lie inside a session's fingerprint (its claimed
 * globs OR its recently-touched files)? Fail-open false on any error. */
function pathOverlapsSession(pathNorm, session) {
  if (!pathNorm || !session) return false
  // (a) claimed globs
  const globs = session.scope && Array.isArray(session.scope.globs) ? session.scope.globs : []
  for (const g of globs) {
    try {
      if (compileGlob(g).test(pathNorm)) return true
    } catch {
      /* malformed glob -> skip */
    }
  }
  // (b) recently-touched files
  const files = Array.isArray(session.filesRecent) ? session.filesRecent : []
  for (const e of files) {
    if (e && typeof e.path === 'string' && normalizePath(e.path) === pathNorm) return true
  }
  return false
}

/**
 * overlapInjection({ownTouch, sessions, selfTerminalId, now, root, classify}) — channel 2
 * (D-49.3-21c): the FULL fingerprint of every OTHER terminal whose fingerprint (claim set
 * OR recently-touched files) contains the path A just touched. Immediate (not throttled).
 * Returns [] when there is no overlap; a terminal's own fingerprint never self-injects.
 * @returns {Object[]} fingerprint objects (buildFingerprint shape)
 */
export function overlapInjection(opts = {}) {
  const t = Number.isFinite(opts.now) ? opts.now : Date.now()
  const self = opts.selfTerminalId ?? null
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : []
  const rawTouch = typeof opts.ownTouch === 'string' ? opts.ownTouch : opts.ownTouch && opts.ownTouch.path
  let pathNorm = normalizePath(rawTouch || '')
  // Relativize an absolute hook path against the repo root (mirrors collision.mjs CR-01).
  if (opts.root) {
    const rootNorm = normalizePath(opts.root).replace(/\/+$/, '') + '/'
    if (pathNorm.startsWith(rootNorm)) pathNorm = pathNorm.slice(rootNorm.length)
  }
  if (!pathNorm) return []

  const out = []
  for (const s of sessions) {
    if (!s) continue
    if (self && terminalIdOf(s) === self) continue // never self-inject
    if (!isLive(s, t, opts.classify)) continue // a dead terminal's overlap is not a live conflict
    if (pathOverlapsSession(pathNorm, s)) {
      out.push(buildFingerprint({ lease: s, journalTail: [], now: t }))
    }
  }
  return out
}

/** renderFingerprint(fp) — a compact RU multi-fact line for the overlap injection. Pure. */
export function renderFingerprint(fp) {
  if (!fp) return ''
  const id = fp.holderIdentity || fp.terminalId || '—'
  const status = FP_STATUS_VALUES.includes(fp.status) ? fp.status : 'working'
  const intent = fp.intent && fp.intent.trim() ? fp.intent.trim() : (fp.phasePlan || '—')
  const files = Array.isArray(fp.filesRecent) && fp.filesRecent.length ? fp.filesRecent.slice(-3).join(', ') : '—'
  return `отпечаток ${id} · ${status} · намерение: ${intent} · недавно: ${files}`
}

// ─────────────────────── coordination-trust instruments ─────────────────────

/**
 * staleWarnShare({journal, windowDays, now}) — the deterministic stale-warn share
 * (P49.3-13-A). Over the journal's collision (shown-warn) events in the window, a warn is
 * NOISE when the warned scope's claim LATER auto-released (a `release` event with reason
 * session-ended | commit-evidence) AND no further touch/collision landed on that scope
 * after the release. Returns the integer percentage noise/total. Identical journal ->
 * identical number. Empty -> 0.
 * @returns {number}
 */
export function staleWarnShare(opts = {}) {
  const events = Array.isArray(opts.journal) ? opts.journal : []
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const windowMs = (Number.isFinite(opts.windowDays) ? opts.windowDays : 7) * 86400000
  const tsOf = (e) => {
    const t = Date.parse(e && e.ts)
    return Number.isFinite(t) ? t : 0
  }
  const inWindow = (e) => now - tsOf(e) <= windowMs
  const collisions = events.filter((e) => e && e.type === 'collision' && inWindow(e))
  if (!collisions.length) return 0

  const autoRelTs = new Map()
  for (const e of events) {
    if (e && e.type === 'release' && e.detail && ['session-ended', 'commit-evidence'].includes(e.detail.reason)) {
      const cur = autoRelTs.has(e.scope) ? autoRelTs.get(e.scope) : 0
      autoRelTs.set(e.scope, Math.max(cur, tsOf(e)))
    }
  }

  let noise = 0
  for (const c of collisions) {
    const rel = autoRelTs.get(c.scope)
    if (!rel) continue // the warned scope never auto-released -> not provably noise
    const laterTouch = collisions.some((x) => x.scope === c.scope && tsOf(x) > rel)
    if (!laterTouch) noise += 1
  }
  return Math.round((noise / collisions.length) * 100)
}

// ─────────────────────────── the `sma ask` demand STUB ───────────────────────
//
// D-49.3-23: the ask-bus is DEFERRED to V3.1 (vendor-absorbable — D-49.2-05 BRIDGE,
// OpenAI acquired Multi 2024; a demolition clause, never a moat). `ask` is a STUB: it
// PRINTS the target's fingerprint (buildFingerprint) and JOURNALS the unmet question so
// demand is MEASURED, not assumed. >=10 journaled cases the fingerprint could not answer
// is the V3.1 build trigger (CONS-49.3-13-B). It opens no socket, routes no message.

/**
 * ask({target, question, sessions, journalTail, journalDir, now, nowIso}) — the demand
 * stub. Resolves the target's live fingerprint; answered = a live fingerprint with real
 * content (files, intent, or claims). Journals one `ask` event carrying answeredByFingerprint.
 * @returns {{fingerprint:Object|null, answered:boolean, text:string}}
 */
export function ask(opts = {}) {
  const target = typeof opts.target === 'string' ? opts.target : ''
  const question = typeof opts.question === 'string' ? opts.question : ''
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const nowIso = opts.nowIso || new Date(now).toISOString()
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : []
  const tailFn = typeof opts.journalTail === 'function' ? opts.journalTail : () => []

  const lease = sessions.find((s) => terminalIdOf(s) === target || (s && s.holderIdentity === target)) || null
  const fp = lease ? buildFingerprint({ lease, journalTail: tailFn(terminalIdOf(lease) || target), now }) : null
  const answered = !!(
    fp &&
    ((Array.isArray(fp.filesRecent) && fp.filesRecent.length) ||
      (fp.intent && fp.intent.trim()) ||
      (Array.isArray(fp.claims) && fp.claims.length))
  )

  try {
    appendEvent(
      {
        type: 'ask',
        actors: ['ask'],
        scope: target,
        detail: { target, question, answeredByFingerprint: answered },
      },
      { terminalId: 'ask', journalDir: opts.journalDir, now: nowIso },
    )
  } catch {
    /* fail-open — journaling demand is best-effort */
  }

  return { fingerprint: fp, answered, text: fp ? renderFingerprint(fp) : `нет живого отпечатка у «${target}»` }
}

/**
 * askUnmetCount({journalDir}) — count journaled `ask` events the fingerprint could NOT
 * answer (answeredByFingerprint === false). >=10 is the V3.1 ask-bus build trigger
 * (D-49.3-23 / CONS-49.3-13-B). Deterministic; fail-open 0.
 * @returns {number}
 */
export function askUnmetCount(opts = {}) {
  try {
    const events = journalTail('ask', -1, opts)
    return (Array.isArray(events) ? events : []).filter(
      (e) => e && e.type === 'ask' && e.detail && e.detail.answeredByFingerprint === false,
    ).length
  } catch {
    return 0
  }
}
