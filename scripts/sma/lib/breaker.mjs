/**
 * breaker.mjs — the loop-breaker: soft-disables an SMA rule that fires REPEATEDLY
 * in the journal, until a human review re-arms it.
 *
 * ═══════════════════════════ WHAT IT DOES ═════════════════════════════════════
 *
 * A rule (a reflex note or an SMA gate) that fires the same (ruleId, target) many
 * times inside a short window is almost certainly stuck in a loop — nagging the
 * operator on every tool call. detectLoops finds that pattern in the shared journal;
 * detectAndTrip writes a per-ruleId marker under .sma/breaker/ that soft-disables
 * THAT rule (and only that rule) until `sma breaker re-arm` clears it.
 *
 * ═══════════════════════════ THE NAMESPACE FENCE ═════════════════════════════
 *
 * isBreakableRule is a hard fence: ONLY reflex note ids and SMA gate ids (GATE-*)
 * are breakable. The security-regression-guard and its invariants (SMA-*, SEC-*)
 * are UNREACHABLE by construction — a runaway rule can never disarm a protection.
 * Every marker CITES a compensatingControl and carries reviewRequired:true — the
 * disarm-path contract the integrity guards shadow-run and auto-re-arm against.
 *
 * ═══════════════════════════ POSTURE ══════════════════════════════════════════
 *
 * Fail-open everywhere (C9 substrate law): any error → no trip, no throw. Re-arm is
 * the force-clear-with-provenance idiom: it journals who re-armed and why.
 * Node built-ins only; the journal + fs are dependency-injectable.
 */

import { existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { appendEvent, readJournal } from './journal.mjs'
import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { BREAKER_DIR } from './constants.mjs'

/** Claude's-discretion defaults, exported as named constants. */
export const DEFAULT_BREAKER_THRESHOLD = 10
export const DEFAULT_BREAKER_WINDOW_MS = 30 * 60 * 1000 // 30 min

/** Namespaces that are NEVER breakable — the security guard + its invariants. */
const NON_BREAKABLE_RE = [/^SMA-/i, /^SEC-/i, /guard/i, /security/i]

/**
 * isBreakableRule(ruleId) — the fence. TRUE only for reflex note ids + SMA gate ids
 * (GATE-*); FALSE for the security-regression-guard namespace (SMA-*, SEC-*, anything
 * naming guard/security) and for empty input. A guard/security ruleId NEVER produces
 * a marker (behavior test 5) — the protection layer is unreachable by construction.
 * @param {string} ruleId
 * @returns {boolean}
 */
export function isBreakableRule(ruleId) {
  if (typeof ruleId !== 'string' || !ruleId.trim()) return false
  const id = ruleId.trim()
  for (const re of NON_BREAKABLE_RE) if (re.test(id)) return false
  return true
}

/** The compensating-control text a marker MUST cite (reflex vs gate tier). */
function compensatingControlFor(ruleId) {
  if (/^GATE-/i.test(ruleId)) {
    return 'advisory tier only; soft-deny tier + security guard unaffected'
  }
  return 'note stays in corpus; gates + security guard unaffected'
}

/** A filename-safe marker name for a ruleId (note ids / GATE-* stay readable). */
function safeName(ruleId) {
  return String(ruleId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'rule'
}

/** Extract the breakable ruleId from a journal rule-fire event (reflex/gate), or null. */
function ruleIdOf(e) {
  if (!e || !e.detail || typeof e.detail !== 'object') return null
  if (e.type === 'reflex' && e.detail.noteId) return String(e.detail.noteId)
  if (e.type === 'gate' && e.detail.gateId) return String(e.detail.gateId)
  return null
}

/** The event's target (dedup granularity): scope, or detail.target, or ''. */
function targetOf(e) {
  if (e && typeof e.scope === 'string' && e.scope) return e.scope
  if (e && e.detail && typeof e.detail.target === 'string') return e.detail.target
  return ''
}

/**
 * detectLoops(events, {threshold, windowMs, now}) -> trips[]. Groups rule-fire events
 * (reflex/gate) by (ruleId, target) and finds any group with >= threshold fires inside
 * a sliding windowMs window (two-pointer over sorted timestamps). Returns one trip per
 * looping group: {ruleId, target, count, firstTs, lastTs}. Fail-open → []. Read-only.
 *
 * @param {Array} events  journal events
 * @param {{threshold?:number, windowMs?:number, now?:number}} [opts]
 * @returns {Array<{ruleId:string, target:string, count:number, firstTs:string, lastTs:string}>}
 */
export function detectLoops(events, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_BREAKER_THRESHOLD
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_BREAKER_WINDOW_MS
  const trips = []
  try {
    const groups = new Map()
    for (const e of Array.isArray(events) ? events : []) {
      const ruleId = ruleIdOf(e)
      if (!ruleId) continue
      const t = Date.parse(e.ts)
      if (!Number.isFinite(t)) continue
      const key = ruleId + '\u0000' + targetOf(e)
      if (!groups.has(key)) groups.set(key, { ruleId, target: targetOf(e), ts: [] })
      groups.get(key).ts.push(t)
    }
    for (const g of groups.values()) {
      g.ts.sort((a, b) => a - b)
      let left = 0
      for (let right = 0; right < g.ts.length; right++) {
        while (g.ts[right] - g.ts[left] > windowMs) left++
        const count = right - left + 1
        if (count >= threshold) {
          trips.push({
            ruleId: g.ruleId,
            target: g.target,
            count,
            firstTs: new Date(g.ts[left]).toISOString(),
            lastTs: new Date(g.ts[right]).toISOString(),
          })
          break // one trip per group is enough
        }
      }
    }
  } catch {
    return []
  }
  return trips
}

/** Journal an event, swallowing any failure (a journal error never blocks a trip). */
function journalSafe(event, opts) {
  const append = typeof opts.journalAppend === 'function' ? opts.journalAppend : appendEvent
  const terminalId = opts.terminalId || (typeof opts.by === 'string' ? opts.by : 'breaker')
  if (!opts.journalDir) return
  try {
    append(event, { terminalId, journalDir: opts.journalDir })
  } catch {
    /* fail-open */
  }
}

/**
 * detectAndTrip({breakerDir, journalDir, by, threshold, windowMs, now, ...}) ->
 * {tripped[]}. Reads the recent journal tail (bounded to the window — the hot path
 * never re-reads history), detects loops, and for each BREAKABLE looping rule that is
 * not already tripped writes a marker (.sma/breaker/<ruleId>.json) + journals a
 * 'breaker-trip'. A guard/security ruleId is fenced out (no marker). Fail-open → {tripped:[]}.
 *
 * @param {{breakerDir?:string, journalDir?:string, by?:string, threshold?:number,
 *          windowMs?:number, now?:number, terminalId?:string, readJournalFn?:Function,
 *          journalAppend?:Function}} [opts]
 * @returns {{tripped:object[]}}
 */
export function detectAndTrip(opts = {}) {
  const out = { tripped: [] }
  try {
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_BREAKER_THRESHOLD
    const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_BREAKER_WINDOW_MS
    const now = Number.isFinite(opts.now) ? opts.now : Date.now()

    const reader = typeof opts.readJournalFn === 'function' ? opts.readJournalFn : readJournal
    let events = []
    try {
      const r = reader({ journalDir: opts.journalDir })
      events = Array.isArray(r) ? r : (r && r.events) || []
    } catch {
      events = []
    }
    // Watermark: only the recent window matters (bounded — the hot path stays cheap).
    const recent = events.filter((e) => {
      const t = Date.parse(e && e.ts)
      return !Number.isFinite(t) || t >= now - windowMs
    })

    for (const trip of detectLoops(recent, { threshold, windowMs, now })) {
      if (!isBreakableRule(trip.ruleId)) continue // namespace fence — guard is unreachable
      if (isTripped(trip.ruleId, { breakerDir: opts.breakerDir })) continue // idempotent
      const marker = writeMarker(trip, { ...opts, windowMs, now })
      if (marker) out.tripped.push(marker)
    }
  } catch {
    /* fail-open */
  }
  return out
}

/** Write the per-ruleId marker + journal the trip. Returns the marker or null. */
function writeMarker(trip, opts) {
  try {
    const breakerDir = opts.breakerDir
    if (!breakerDir) return null
    mkdirSync(breakerDir, { recursive: true })
    const marker = {
      ruleId: trip.ruleId,
      target: trip.target,
      tripCount: trip.count,
      windowMs: opts.windowMs,
      firstTs: trip.firstTs,
      lastTs: trip.lastTs,
      disabledAt: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString(),
      by: typeof opts.by === 'string' ? opts.by : 'breaker',
      compensatingControl: compensatingControlFor(trip.ruleId),
      reviewRequired: true,
    }
    atomicWriteJson(join(breakerDir, `${safeName(trip.ruleId)}.json`), marker)
    journalSafe(
      {
        type: 'breaker-trip',
        actors: [opts.terminalId || marker.by],
        scope: trip.ruleId,
        detail: { ruleId: trip.ruleId, tripCount: trip.count, compensatingControl: marker.compensatingControl },
      },
      opts,
    )
    return marker
  } catch {
    return null
  }
}

/**
 * isTripped(ruleId, {breakerDir}) -> boolean. True when a marker exists for the rule.
 * Fail-open → false. Read-only.
 */
export function isTripped(ruleId, opts = {}) {
  try {
    if (!opts.breakerDir) return false
    return existsSync(join(opts.breakerDir, `${safeName(ruleId)}.json`))
  } catch {
    return false
  }
}

/**
 * listMarkers({breakerDir}) -> marker[]. All breaker markers, newest-first by disabledAt.
 * Fail-open → []. Read-only (the input contract the disarm-path guard consumes).
 */
export function listMarkers(opts = {}) {
  const out = []
  try {
    if (!opts.breakerDir) return out
    for (const f of readdirSync(opts.breakerDir)) {
      if (!f.endsWith('.json')) continue
      const m = readJsonSafe(join(opts.breakerDir, f))
      if (m && typeof m === 'object') out.push(m)
    }
  } catch {
    return out
  }
  return out.sort((a, b) => (String(b.disabledAt) < String(a.disabledAt) ? -1 : 1))
}

/**
 * recordSkipOnce(ruleId, {seen, journalDir, terminalId}) — the consumer-skip receipt.
 * When a tripped rule's own firing is skipped, journal ONE 'breaker-skip' event per
 * session (deduped via the shared seen-store 'breaker-skip:' key), not one per call.
 * Fail-open. Returns {journaled}.
 * @param {string} ruleId
 * @param {{seen?:object, journalDir?:string, terminalId?:string, journalAppend?:Function}} [opts]
 */
export function recordSkipOnce(ruleId, opts = {}) {
  try {
    const seen = opts.seen && typeof opts.seen === 'object' ? opts.seen : { keys: {} }
    if (!seen.keys || typeof seen.keys !== 'object') seen.keys = {}
    const key = `breaker-skip:${ruleId}`
    if (seen.keys[key]) {
      seen.keys[key] += 1
      return { journaled: false }
    }
    seen.keys[key] = 1
    const append = typeof opts.journalAppend === 'function' ? opts.journalAppend : appendEvent
    if (opts.journalDir && opts.terminalId) {
      append(
        { type: 'breaker-skip', actors: [opts.terminalId], scope: ruleId, detail: { ruleId } },
        { terminalId: opts.terminalId, journalDir: opts.journalDir },
      )
    }
    return { journaled: true }
  } catch {
    return { journaled: false }
  }
}

/**
 * reArm(ruleId, {breakerDir, journalDir, by, terminalId}) — the review re-arm. Deletes
 * the marker (re-enabling the rule) and journals a 'breaker-rearm' event WITH provenance
 * (who + why, the force-clear idiom). Absent marker → {rearmed:false}. Fail-open.
 * @param {string} ruleId
 * @param {{breakerDir?:string, journalDir?:string, by?:string, terminalId?:string, journalAppend?:Function}} [opts]
 * @returns {{rearmed:boolean}}
 */
export function reArm(ruleId, opts = {}) {
  try {
    if (!opts.breakerDir) return { rearmed: false }
    const path = join(opts.breakerDir, `${safeName(ruleId)}.json`)
    if (!existsSync(path)) return { rearmed: false }
    try {
      unlinkSync(path)
    } catch {
      return { rearmed: false }
    }
    const append = typeof opts.journalAppend === 'function' ? opts.journalAppend : appendEvent
    const terminalId = opts.terminalId || 'unknown'
    if (opts.journalDir) {
      try {
        append(
          { type: 'breaker-rearm', actors: [terminalId], scope: ruleId, detail: { ruleId, by: typeof opts.by === 'string' ? opts.by : 'unknown' } },
          { terminalId, journalDir: opts.journalDir },
        )
      } catch {
        /* a journal failure never blocks the re-arm */
      }
    }
    return { rearmed: true }
  } catch {
    return { rearmed: false }
  }
}

/** Re-export the runtime dir default so a consumer imports the contract from one place. */
export { BREAKER_DIR }
