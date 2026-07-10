/**
 * collision.mjs — advisory scope-glob collision detector + Terraform-style WARN
 * builder (R8, B20/B25, D-49-16).
 *
 * READ-ONLY over a readSessions() snapshot (SPEC edge: concurrency R8) — the detector
 * NEVER writes or deletes anything except a journal append. It only returns data; the
 * caller is NEVER blocked (advisory, C9). Everything is fail-open: any internal error
 * yields [] so a hook can never wedge a session.
 *
 * Windows path semantics (SPEC edge: encoding R8): normalizePath (case-fold + forward
 * slashes + collapsed slashes) runs BEFORE any glob intersection — NTFS compares
 * case-insensitively (B18).
 *
 * D-49-16 hot-file watch list (real incident 2026-07-02): .planning/STATE.md /
 * .planning/ROADMAP.md / .claude/memory/MEMORY.md are first-class collision targets.
 * When >=2 sessions are fresh and an input path touches one of these — EVEN WITHOUT an
 * explicit claim — an informational (tier:'info') warn rides the same channel; it is
 * NEVER counted as a collision (status/statusline counters count tier:'warn' only).
 *
 * Node built-ins only; the journal append is dependency-injectable via appendEvent opts.
 */

import { appendEvent } from './journal.mjs'
import { classifyStaleness } from './registry.mjs'
import { HEARTBEAT_INTERVAL_MS, ATTENTION_AFTER_MISSES } from './constants.mjs'

/**
 * normalizePath(p) — lowercase + backslash→forward-slash + collapse duplicate slashes.
 * NTFS is case-insensitive (B18), so normalization MUST precede any matching.
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (p == null) return ''
  return String(p)
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
}

/** D-49-16: built-in hot-file watch list (normalized). Planning files are first-class. */
export const HOT_FILES = [
  normalizePath('.planning/STATE.md'),
  normalizePath('.planning/ROADMAP.md'),
  normalizePath('.claude/memory/MEMORY.md'),
]

/**
 * compileGlob(glob) -> RegExp over normalized paths. Supported subset (documented,
 * no npm dep): `**` (matches across path segments, incl. zero), `*` (matches within a
 * single segment), and literal segments. Everything else is escaped literally.
 * @param {string} glob
 * @returns {RegExp}
 */
export function compileGlob(glob) {
  const norm = normalizePath(glob)
  let re = ''
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i]
    if (c === '*') {
      if (norm[i + 1] === '*') {
        // `**` -> any chars incl. slashes; swallow an optional trailing slash so
        // 'src/**' matches 'src/a/b' and 'src' itself is handled by callers.
        re += '.*'
        i++
        if (norm[i + 1] === '/') i++
      } else {
        re += '[^/]*' // single-segment wildcard
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c // escape regex metachars (literal)
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** terminalId derived from a session file name ('fabrika.json' -> 'fabrika'). */
function terminalIdOf(session) {
  if (session && typeof session._file === 'string') return session._file.replace(/\.json$/i, '')
  return null
}

/**
 * relativizePath(p, rootNorm) — strip a normalized repo-root prefix from a normalized
 * path so an ABSOLUTE hook path (`C:\Users\...\repo\src\x.ts` → `c:/users/.../repo/src/x.ts`)
 * becomes repo-relative (`src/x.ts`) before it is matched against repo-relative globs.
 * A path that is already relative (does not start with the root prefix) passes through
 * unchanged. CR-01: Claude Code PreToolUse hooks deliver absolute `file_path` values, but
 * scope globs + HOT_FILES are repo-relative — without this strip they can never match.
 * @param {string} p          normalized candidate path
 * @param {string} rootNorm   normalized repo root WITH a trailing slash, or '' to skip
 * @returns {string}
 */
export function relativizePath(p, rootNorm) {
  if (!rootNorm) return p
  return p.startsWith(rootNorm) ? p.slice(rootNorm.length) : p
}

/**
 * checkScopeCollision(paths[], {sessions, selfTerminalId, now, scopeMtimeProbe, root}) —
 * read-only over the sessions snapshot. For each FOREIGN session with scope.globs,
 * intersect its compiled globs against the normalized input paths; build a warn per hit.
 * Additionally (D-49-16) emit an info warn for any input path on HOT_FILES when >=2
 * sessions are fresh — even with no claim. Fail-open: any error -> [].
 *
 * CR-01: when `root` (the repo root) is supplied, each candidate is relativized against
 * it FIRST, so an absolute hook path is matched against repo-relative globs. Pure-relative
 * inputs are unaffected. NTFS case-insensitivity is handled by normalizePath running on
 * both the candidate and the root before the prefix strip.
 *
 * @param {string[]} paths
 * @param {{sessions:Array, selfTerminalId?:string, now?:number, scopeMtimeProbe?:Function, root?:string}} opts
 * @returns {Array<Object>}  warns; tier:'warn' are collisions, tier:'info' are advisories
 */
export function checkScopeCollision(paths, opts = {}) {
  try {
    const sessions = Array.isArray(opts.sessions) ? opts.sessions : []
    const self = opts.selfTerminalId ?? null
    const now = opts.now ?? Date.now()
    // CR-01: derive a normalized root prefix (with trailing slash) so absolute hook
    // paths are relativized to repo-relative before glob/HOT_FILES matching.
    const rootNorm = opts.root ? normalizePath(opts.root).replace(/\/+$/, '') + '/' : ''
    const normPaths = (Array.isArray(paths) ? paths : [])
      .map(normalizePath)
      .map((p) => relativizePath(p, rootNorm))
      .filter(Boolean)
    if (!normPaths.length) return []

    const warns = []

    for (const session of sessions) {
      if (!session) continue
      const sTerm = terminalIdOf(session)
      if (self && sTerm && sTerm === self) continue // skip own session
      const globs = session.scope && Array.isArray(session.scope.globs) ? session.scope.globs : []
      if (!globs.length) continue

      for (const glob of globs) {
        let matcher
        try {
          matcher = compileGlob(glob)
        } catch {
          continue // malformed glob -> skip, fail-open
        }
        const hit = normPaths.find((p) => matcher.test(p))
        if (!hit) continue

        const cls = classifyStaleness(session, { now, scopeMtimeProbe: opts.scopeMtimeProbe })
        const staleness = cls.state // 'fresh'|'attention'|'reap-clean'|'needs-human'
        const active = staleness === 'fresh' || staleness === 'attention'
        warns.push({
          tier: 'warn',
          who: session.holderIdentity ?? '—',
          pid: session.pid ?? null,
          operation: (session.scope && session.scope.description) || '—',
          scope: glob,
          since: session.acquireTime ?? session.renewTime ?? null,
          staleness,
          howToClear: active
            ? 'дождитесь завершения или: pnpm sma force-clear ' + slugClaim(session)
            : 'pnpm sma force-clear ' + slugClaim(session),
        })
        break // one warn per foreign session is enough
      }
    }

    // D-49-16 hot-file advisory: >=2 fresh sessions + a hot-file path, no claim needed.
    const freshCount = sessions.filter((s) => {
      const cls = classifyStaleness(s, { now })
      return cls.state === 'fresh'
    }).length
    if (freshCount >= 2) {
      for (const p of normPaths) {
        if (HOT_FILES.includes(p)) {
          warns.push({
            tier: 'info',
            reason: 'hot-file',
            who: '—',
            scope: p,
            text: `${freshCount} сессий активны; файл высококонтентный; перечитайте перед записью`,
          })
        }
      }
    }

    return warns
  } catch {
    return [] // fail-open (C9) — a detector error never blocks or throws
  }
}

/**
 * scopeClaimSlug(descriptionOrHolder) — the stable claims-dir entry name for a scope
 * claim, and the exact string the force-clear remediation suggests. WR-02: cmdClaim
 * creates a claims-dir entry under THIS name so `force-clear <slug>` from a collision
 * WARN actually resolves. Exported so the CLI and the WARN builder share one derivation.
 * @param {string} src   the scope description (preferred) or holder identity
 * @returns {string}
 */
export function scopeClaimSlug(src) {
  const s = src || 'claim'
  return normalizePath(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'claim'
}

/** A stable claim-name suggestion for the force-clear command (operation-or-holder). */
function slugClaim(session) {
  const src = (session.scope && session.scope.description) || session.holderIdentity || 'claim'
  return scopeClaimSlug(src)
}

/**
 * buildWarnText(warn) — the RU one-liner in the Terraform force-unlock style
 * (CONTEXT: «занято терминалом Фабрика (pid 31240), операция push, с 14:20 — очистить:
 * pnpm sma force-clear push»). An info hot-file warn passes through as its own text.
 * @param {Object} warn
 * @returns {string}
 */
export function buildWarnText(warn) {
  if (!warn) return ''
  if (warn.tier === 'info') return warn.text ?? ''
  const since = formatSince(warn.since)
  // BL-158 (D-49.3-22f): attention ≠ fully-active. A `fresh` owner reads «занято» (busy
  // NOW). An `attention` owner (missed heartbeats — possibly idle, possibly still there)
  // reads «внимание» so the reader knows it is NOT a hard busy and the raw tier is carried
  // inline. The active COUNT split lives in countSessionTiers; this is the WARN-text split.
  const attention = warn.staleness === 'attention'
  const lead = attention ? 'внимание' : 'занято'
  const staleNote = warn.staleness && warn.staleness !== 'fresh' ? ` [${warn.staleness}]` : ''
  // D-49.3-22: self-verifying evidence inline (live «правки N мин назад…» / stale «можно
  // работать») when the caller attached it via verifyClaimEvidence.
  const evidence = typeof warn.evidence === 'string' && warn.evidence ? ` — ${warn.evidence}` : ''
  return (
    `${lead} терминалом ${warn.who} (pid ${warn.pid ?? '?'}), ` +
    `операция ${warn.operation}, диапазон ${warn.scope}, с ${since}${staleNote}${evidence} — ` +
    `очистить: ${warn.howToClear}`
  )
}

/**
 * countSessionTiers(sessions, {now, classify}) — BL-158 (D-49.3-22f): count `fresh` and
 * `attention` SEPARATELY instead of collapsing both into one "active" boolean. Liveness is
 * renewTime-only (classifyStaleness — no pid). `active` (fresh+attention) is kept for the
 * legacy count, but the two tiers are also individually visible so a caller can distinguish
 * a hard-busy owner from one that may already be idle. Injectable classify for tests.
 * @param {Array} sessions
 * @param {{now?:number, classify?:Function}} [opts]
 * @returns {{fresh:number, attention:number, active:number}}
 */
export function countSessionTiers(sessions, opts = {}) {
  const now = opts.now ?? Date.now()
  const classify = typeof opts.classify === 'function' ? opts.classify : classifyStaleness
  let fresh = 0
  let attention = 0
  for (const s of Array.isArray(sessions) ? sessions : []) {
    let st
    try {
      st = classify(s, { now }).state
    } catch {
      continue
    }
    if (st === 'fresh') fresh += 1
    else if (st === 'attention') attention += 1
  }
  return { fresh, attention, active: fresh + attention }
}

/**
 * verifyClaimEvidence({claim, scopeDirtyVsHead, commitInScopeAfterRenew, mtimeAgeMin, intent})
 * — the self-verifying WARN banner (D-49.3-22). Every collision WARN carries its OWN
 * evidence so the reader can trust it WITHOUT a manual check. A claim is STALE (safe to
 * take) when the scope is CLEAN vs HEAD AND a commit landed in scope after the claim's
 * renewTime — the «verify before holding» lesson mechanized. Otherwise it is LIVE (real
 * busy). Deterministic over the INJECTED git facts; no git call here.
 * @returns {{live:boolean, text:string}}
 */
export function verifyClaimEvidence(opts = {}) {
  const dirty = !!opts.scopeDirtyVsHead
  const commit = opts.commitInScopeAfterRenew || null
  const stale = !dirty && !!commit // clean AND a post-renew in-scope commit landed
  if (stale) {
    const sha = String(commit).slice(0, 7)
    return { live: false, text: `claim устарел (скоуп чист, коммит ${sha} уже в HEAD) — можно работать` }
  }
  const claim = opts.claim || {}
  const who = claim.by || claim.holderIdentity || 'T-?'
  const mins = Number.isFinite(opts.mtimeAgeMin) ? Math.round(opts.mtimeAgeMin) : '?'
  const intent = claim.intent || opts.intent || ''
  const intentPart = intent ? `, намерение: ${intent}` : ''
  return { live: true, text: `занято ${who} (правки ${mins} мин назад${intentPart})` }
}

/** HH:MM local time from an ISO string, or the raw value if unparseable. */
function formatSince(iso) {
  if (!iso) return '?'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return String(iso)
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * recordCollisions(warns, {terminalId, journalDir, now}) — journal one 'collision'
 * event per collision warn (tier:'warn'); info advisories are NOT journaled as
 * collisions. actors = [own terminalId, owner holderIdentity]. Fail-open per event.
 * @param {Array<Object>} warns
 * @param {{terminalId:string, journalDir?:string, now?:string}} opts
 * @returns {{recorded:number}}
 */
export function recordCollisions(warns, opts = {}) {
  let recorded = 0
  for (const w of Array.isArray(warns) ? warns : []) {
    if (!w || w.tier !== 'warn') continue
    try {
      // FI-10 — when the caller supplies NAMED display identities (opts.selfDisplay +
      // per-warn w.whoDisplay, «P49 Tom» / «P52 Anna»), the who column carries those so
      // forensics reads real windows, not t-<hash>. Backward-compatible: without them the
      // actors stay the original [own terminalId, owner holderIdentity] shape.
      const actors = opts.selfDisplay
        ? [opts.selfDisplay, w.whoDisplay ?? w.who].filter(Boolean)
        : [opts.terminalId, w.who].filter(Boolean)
      appendEvent(
        {
          type: 'collision',
          actors,
          scope: w.scope,
          detail: { operation: w.operation, pid: w.pid, staleness: w.staleness },
        },
        { terminalId: opts.terminalId, journalDir: opts.journalDir, now: opts.now },
      )
      recorded += 1
    } catch {
      // fail-open — a journal failure never blocks the detector (C9)
    }
  }
  return { recorded }
}

// Re-export the cadence constants the CLI/hooks pair with this detector so a consumer
// imports the timing contract from one place (no behavioral use here).
export { HEARTBEAT_INTERVAL_MS, ATTENTION_AFTER_MISSES }
