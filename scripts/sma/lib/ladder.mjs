/**
 * ladder.mjs — the rule-maturation ladder (9.3-06, D-9.3-12).
 *
 * A rule's tier (note -> warn -> soft-deny -> deterministic auto-fix, plus the
 * off-ladder terminal state 'retired') rises AND falls ONLY on measured journal
 * benefit, and every tier change lands as a diff to the TRACKED registry file
 * `sma-ladder.json` (repo root, NOT under gitignored .sma/) so a human reviews it
 * in `git diff`. The tuner NEVER commits, NEVER pushes, NEVER spawns a process:
 * applyProposals writes the working-tree diff and STOPS; the only command
 * execution is the INJECTED runner in applyFix.
 *
 * BENEFIT-ACCOUNTING, not fire-counting (the grill's pillar-04 verdict): every
 * fire is classified heeded / ignored-ok / ignored-broke / unobserved from the
 * EXISTING V2 journal fire events (type 'reflex' {detail.noteId} and type 'gate'
 * {detail.gateId}) plus calibration 'miss' verdicts. Promotion keys on measured
 * ignored-broke; demotion keys on measured zero-benefit. A rule that fires 20
 * times and is heeded is HEALTHY — high fire count alone never moves a tier.
 *
 * SILENCE-IMMUNITY (T-9.3-63, D-9.2-14): retirement DEFERS to the 9.2-10 STPA
 * birth-fixture check via an injected checkFixture(ruleId) -> {fixtureTrips,
 * compensated}; a rule can only retire when its fixture no longer trips OR a
 * compensating control is cited. Absent/unknown checker -> retire REFUSED
 * (conservative default, capped at note). An ignored-broke on a note/retired rule
 * re-arms it one rung immediately (fail-open overlay bump) AND emits the matching
 * re-arm proposal so the diff still lands for review.
 *
 * AUTO-FIX BOUNDARY (T-9.3-60): a registered fix command must pass predict.mjs's
 * isSafeCommand at registration AND again at run — the ONE allowlist, imported,
 * never re-implemented. Promotion to auto-fix requires >= 3 recorded green applies.
 *
 * Node built-ins only; every path DI-injectable; fail-open throughout (C9). The
 * module reaches NO shell and NO git — command execution is exclusively the
 * injected runner (acceptance: zero direct process-spawn calls live in this file).
 */

import { appendEvent } from './journal.mjs'
import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { isSafeCommand } from './predict.mjs'

/** The maturation ladder, low -> high. 'retired' is an off-ladder terminal state. */
export const LADDER_TIERS = ['note', 'warn', 'soft-deny', 'auto-fix']

/** The shipped default tier — a rule absent from the registry sits here (V2 posture). */
const DEFAULT_TIER = 'warn'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default proposal thresholds (Claude's-discretion values, locked by this plan). */
export const DEFAULT_THRESHOLDS = {
  window: '30d',
  minFires: 5, //           n-floor before ANY move
  promoteIgnoredBroke: 2, // warn -> soft-deny gate
  greenAppliesForAutofix: 3, // soft-deny -> auto-fix gate
  demoteFires: 8, //        warn -> note demote floor
  demoteSpanDays: 14, //    warn -> note span floor
}

// ── registry read + effective tier ──────────────────────────────────────────────

/**
 * readLadder({ladderPath}) -> {version, rules}. A missing/corrupt file yields the
 * empty registry {version:1, rules:[]} — an absent overlay changes NOTHING about
 * V2 behavior (Test 1). Never throws.
 * @param {{ladderPath?:string}} [opts]
 * @returns {{version:number, rules:object[]}}
 */
export function readLadder(opts = {}) {
  const raw = opts.ladderPath ? readJsonSafe(opts.ladderPath) : null
  if (!raw || typeof raw !== 'object') return { version: 1, rules: [] }
  return { version: Number.isFinite(raw.version) ? raw.version : 1, rules: Array.isArray(raw.rules) ? raw.rules : [] }
}

/** The registry row for a ruleId, or null. */
function ruleRow(ladder, ruleId) {
  return (ladder && Array.isArray(ladder.rules) ? ladder.rules : []).find((r) => r && r.ruleId === ruleId) ?? null
}

/** One rung up (note->warn, retired->note). Higher tiers are already armed. */
function bumpUp(tier) {
  if (tier === 'retired') return 'note'
  if (tier === 'note') return 'warn'
  return tier
}

/**
 * tierOf(ladder, ruleId, opts) -> the effective tier string. With no opts it is the
 * stored tier (or the shipped default 'warn' for an absent rule). With {reArm:true}
 * a note/retired rule resolves one rung UP immediately — the fail-open incident
 * re-arm the overlay applies the moment an ignored-broke lands (Test 1 + Test 6).
 * @param {{rules:object[]}} ladder
 * @param {string} ruleId
 * @param {{reArm?:boolean}} [opts]
 * @returns {string}
 */
export function tierOf(ladder, ruleId, opts = {}) {
  const row = ruleRow(ladder, ruleId)
  let tier = row && typeof row.tier === 'string' ? row.tier : DEFAULT_TIER
  if (!LADDER_TIERS.includes(tier) && tier !== 'retired') tier = DEFAULT_TIER
  if (opts && opts.reArm && (tier === 'note' || tier === 'retired')) return bumpUp(tier)
  return tier
}

// ── classification (benefit-accounting) ─────────────────────────────────────────

/** targetClass = the directory portion of a scope path (a file's dir; else itself). */
function targetClassOf(scope) {
  const s = String(scope ?? '')
  if (!s.includes('/')) return s
  const segs = s.split('/').filter(Boolean)
  if (!segs.length) return s
  const last = segs[segs.length - 1]
  return last.includes('.') ? segs.slice(0, -1).join('/') || s : segs.join('/')
}

/** Two scopes intersect on a shared targetClass, exact match, or a path-prefix. */
function scopeIntersects(a, b) {
  const sa = String(a ?? '')
  const sb = String(b ?? '')
  if (!sa || !sb) return false
  if (sa === sb) return true
  const ca = targetClassOf(sa)
  const cb = targetClassOf(sb)
  if (ca && cb && ca === cb) return true
  return sa.startsWith(cb) || sb.startsWith(ca)
}

/** The ruleId + kind a fire event carries: reflex -> noteId, gate -> gateId. */
function fireIdentity(evt) {
  const d = (evt && evt.detail) || {}
  if (evt.type === 'reflex') return { ruleId: d.noteId ?? null, kind: 'reflex' }
  if (evt.type === 'gate') return { ruleId: d.gateId ?? null, kind: 'gate' }
  return { ruleId: null, kind: null }
}

/** `<terminal>#<seq>` journal-ref for a fire (the evidence pointer). */
function refOf(evt) {
  return `${evt.terminal ?? '?'}#${evt.seq ?? ''}`
}

/**
 * classifyFires({events, ledgers, now, horizonMs, ruleDomains}) -> classified[].
 *
 * Pure over injected inputs. Each fire (type 'reflex' | 'gate') is labelled:
 *   ignored-broke — followed inside [ts, ts+horizon] by an 'incident'/'gate-override'
 *                   with intersecting scope, OR by a calibration 'miss' in the rule's
 *                   mapped domain (ruleDomains[ruleId]);
 *   unobserved    — the horizon has not elapsed at `now`;
 *   ignored-ok    — the fire (ruleId, targetClass) recurs later, no linked incident;
 *   heeded        — the fire never recurs (the warning changed behavior).
 *
 * Deterministic, tolerant of corrupt/partial events (journal fail-open posture).
 * @param {{events?:object[], ledgers?:object[], now?:(number|string), horizonMs?:number, ruleDomains?:object}} args
 * @returns {Array<{ruleId, kind, scope, targetClass, ts, seq, terminal, ref, classification}>}
 */
export function classifyFires({ events = [], ledgers = [], now, horizonMs = 7 * DAY_MS, ruleDomains = {} } = {}) {
  const nowMs = now == null ? Date.now() : typeof now === 'number' ? now : Date.parse(now)
  const evs = Array.isArray(events) ? events : []

  const fires = []
  for (const e of evs) {
    if (!e || (e.type !== 'reflex' && e.type !== 'gate')) continue
    const { ruleId, kind } = fireIdentity(e)
    if (!ruleId) continue
    const tsMs = Date.parse(e.ts)
    if (!Number.isFinite(tsMs)) continue
    fires.push({ ruleId, kind, scope: e.scope ?? '', targetClass: targetClassOf(e.scope), ts: e.ts, tsMs, seq: e.seq, terminal: e.terminal, ref: refOf(e) })
  }

  const incidents = evs
    .filter((e) => e && (e.type === 'incident' || e.type === 'gate-override'))
    .map((e) => ({ scope: e.scope ?? (e.detail && e.detail.scope) ?? '', tsMs: Date.parse(e.ts) }))
    .filter((i) => Number.isFinite(i.tsMs))

  const misses = (Array.isArray(ledgers) ? ledgers : [])
    .filter((r) => r && r.verdict === 'miss')
    .map((r) => ({ domain: r.domain ?? 'unknown', tsMs: Date.parse(r.scoredAt ?? r.ts) }))
    .filter((m) => Number.isFinite(m.tsMs))

  const out = []
  for (const f of fires) {
    const horizonEnd = f.tsMs + horizonMs
    const domain = ruleDomains[f.ruleId]

    const brokeByIncident = incidents.some((i) => i.tsMs > f.tsMs && i.tsMs <= horizonEnd && scopeIntersects(f.scope, i.scope))
    const brokeByMiss = domain != null && misses.some((m) => m.tsMs > f.tsMs && m.tsMs <= horizonEnd && m.domain === domain)

    let classification
    if (brokeByIncident || brokeByMiss) {
      classification = 'ignored-broke'
    } else if (horizonEnd > nowMs) {
      classification = 'unobserved'
    } else if (fires.some((g) => g !== f && g.ruleId === f.ruleId && g.targetClass === f.targetClass && g.tsMs > f.tsMs)) {
      classification = 'ignored-ok'
    } else {
      classification = 'heeded'
    }
    out.push({ ruleId: f.ruleId, kind: f.kind, scope: f.scope, targetClass: f.targetClass, ts: f.ts, seq: f.seq, terminal: f.terminal, ref: f.ref, classification })
  }
  return out
}

/**
 * benefitStats({classified, windowMs, now}) -> per-rule {ruleId, kind, fires, heeded,
 * ignoredOk, ignoredBroke, unobserved, spanDays, journalRefs}. The ONLY numbers
 * proposeTierChanges reads. windowMs+now, when both given, filters to fires inside
 * the trailing window; otherwise all classified fires count.
 * @param {{classified?:object[], windowMs?:number, now?:(number|string)}} args
 * @returns {Object<string, object>}
 */
export function benefitStats({ classified = [], windowMs, now } = {}) {
  const nowMs = now == null ? Date.now() : typeof now === 'number' ? now : Date.parse(now)
  const inWindow = (c) => {
    if (!windowMs || !Number.isFinite(nowMs)) return true
    const t = Date.parse(c.ts)
    return !Number.isFinite(t) || t >= nowMs - windowMs
  }
  const byRule = {}
  for (const c of Array.isArray(classified) ? classified : []) {
    if (!c || !c.ruleId || !inWindow(c)) continue
    const r = (byRule[c.ruleId] ||= { ruleId: c.ruleId, kind: c.kind, fires: 0, heeded: 0, ignoredOk: 0, ignoredBroke: 0, unobserved: 0, journalRefs: [], _min: Infinity, _max: -Infinity })
    r.fires += 1
    if (c.classification === 'heeded') r.heeded += 1
    else if (c.classification === 'ignored-ok') r.ignoredOk += 1
    else if (c.classification === 'ignored-broke') r.ignoredBroke += 1
    else if (c.classification === 'unobserved') r.unobserved += 1
    if (c.ref && r.journalRefs.length < 50) r.journalRefs.push(c.ref)
    const t = Date.parse(c.ts)
    if (Number.isFinite(t)) {
      r._min = Math.min(r._min, t)
      r._max = Math.max(r._max, t)
    }
  }
  for (const r of Object.values(byRule)) {
    r.spanDays = Number.isFinite(r._min) && Number.isFinite(r._max) ? (r._max - r._min) / DAY_MS : 0
    delete r._min
    delete r._max
  }
  return byRule
}

// ── proposal engine ─────────────────────────────────────────────────────────────

/** One evidence row from a rule's benefit stats. */
function evidenceRow(window, s) {
  return {
    window,
    fires: s.fires ?? 0,
    heeded: s.heeded ?? 0,
    ignoredOk: s.ignoredOk ?? 0,
    ignoredBroke: s.ignoredBroke ?? 0,
    journalRefs: Array.isArray(s.journalRefs) ? s.journalRefs.slice(0, 20) : [],
  }
}

/**
 * proposeTierChanges({ladder, stats, checkFixture, thresholds}) -> proposal[]. Pure.
 * Every proposal carries its evidence rows verbatim. Kinds:
 *   {ruleId, kind, from, to, reason, evidence, refused:false}          — a tier move
 *   {ruleId, kind, from:'note'|... , to:'retired', refused:true, ...}  — a refused retire
 *   {kind:'gate-candidate', ruleId, evidence, reason}                  — a reflex that
 *        earned soft-deny evidence (reflexes NEVER deny — D-9.1-12; a human authors
 *        the gate from the brief instead).
 *
 * @param {{ladder:{rules:object[]}, stats:Object<string,object>, checkFixture?:Function, thresholds?:object}} args
 * @returns {object[]}
 */
export function proposeTierChanges({ ladder = { rules: [] }, stats = {}, checkFixture, thresholds } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) }
  const proposals = []

  for (const s of Object.values(stats)) {
    if (!s || !s.ruleId) continue
    const ruleId = s.ruleId
    const row = ruleRow(ladder, ruleId)
    const kind = s.kind ?? (row && row.kind) ?? 'reflex'
    const tier = tierOf(ladder, ruleId)
    const ev = [evidenceRow(t.window, s)]
    const fires = s.fires ?? 0
    const zeroBenefit = fires >= t.demoteFires && (s.spanDays ?? 0) >= t.demoteSpanDays && (s.heeded ?? 0) === 0 && (s.ignoredBroke ?? 0) === 0

    // (1) incident RE-ARM — an ignored-broke on a silenced rule bumps one rung up,
    // immediately and as a reviewable diff (never silent, T-9.3-63 / Test 6).
    if ((tier === 'note' || tier === 'retired') && (s.ignoredBroke ?? 0) >= 1) {
      proposals.push({ ruleId, kind, from: tier, to: bumpUp(tier), reason: 'ignored-broke re-arm', refused: false, evidence: ev })
      continue
    }

    // (2) promote warn -> soft-deny on measured ignored-broke (gate-class only; a
    // reflex that earns it yields a gate-candidate advisory instead).
    if (tier === 'warn' && fires >= t.minFires && (s.ignoredBroke ?? 0) >= t.promoteIgnoredBroke) {
      if (kind === 'gate') {
        proposals.push({ ruleId, kind, from: 'warn', to: 'soft-deny', reason: 'measured ignored-broke', refused: false, evidence: ev })
      } else {
        proposals.push({ kind: 'gate-candidate', ruleId, reason: 'reflex earned soft-deny evidence — a human authors the gate', evidence: ev })
      }
      continue
    }

    // (3) promote soft-deny -> auto-fix on >= 3 recorded green fix applies.
    if (tier === 'soft-deny') {
      const green = row && row.fix && Number.isFinite(row.fix.greenApplies) ? row.fix.greenApplies : 0
      if (green >= t.greenAppliesForAutofix) {
        proposals.push({ ruleId, kind, from: 'soft-deny', to: 'auto-fix', reason: `${green} green fix applies`, refused: false, evidence: ev })
      }
      continue
    }

    // (4) demote warn -> note on measured zero benefit.
    if (tier === 'warn' && zeroBenefit) {
      proposals.push({ ruleId, kind, from: 'warn', to: 'note', reason: 'measured zero benefit', refused: false, evidence: ev })
      continue
    }

    // (5) demote note -> retired ONLY when the birth fixture signs off (D-9.2-14).
    if (tier === 'note' && zeroBenefit) {
      let fx = null
      try {
        fx = typeof checkFixture === 'function' ? checkFixture(ruleId) : null
      } catch {
        fx = null
      }
      const signsOff = fx && (fx.fixtureTrips === false || fx.compensated === true)
      if (signsOff) {
        proposals.push({ ruleId, kind, from: 'note', to: 'retired', reason: 'zero benefit + fixture signed off', refused: false, evidence: ev, fixtureCheck: { at: null, fixtureTrips: !!fx.fixtureTrips, compensated: !!fx.compensated } })
      } else {
        const why = !fx ? 'fixture check unavailable — conservative refuse (capped at note)' : 'birth fixture still trips and no compensating control cited'
        proposals.push({ ruleId, kind, from: 'note', to: 'retired', reason: 'zero benefit', refused: true, refusalReason: why, evidence: ev })
      }
      continue
    }
  }
  return proposals
}

// ── apply (reviewable diff only — never a commit) ───────────────────────────────

/**
 * applyProposals({proposals, ladderPath, journalDir, terminalId, now}) — write the
 * updated registry via atomicWriteJson with per-rule history rows {from,to,at,evidence}
 * and journal one 'ladder-change' event per applied change. REFUSED proposals and
 * gate-candidate advisories are NOT applied. Performs ZERO git operations and spawns
 * ZERO processes — committing the diff is the human's act (prohibition). Never throws.
 * @returns {{applied:number, ladder:object}}
 */
export function applyProposals({ proposals = [], ladderPath, journalDir, terminalId = 'ladder', now } = {}) {
  const at = now ?? new Date().toISOString()
  const ladder = readLadder({ ladderPath })
  let applied = 0

  for (const p of Array.isArray(proposals) ? proposals : []) {
    if (!p || p.refused || p.kind === 'gate-candidate' || !p.ruleId || !p.to) continue
    let row = ruleRow(ladder, p.ruleId)
    if (!row) {
      row = { ruleId: p.ruleId, kind: p.kind ?? 'reflex', tier: DEFAULT_TIER, since: at, evidence: [], history: [] }
      ladder.rules.push(row)
    }
    const from = p.from ?? row.tier ?? DEFAULT_TIER
    row.tier = p.to
    row.since = at
    if (!Array.isArray(row.history)) row.history = []
    if (!Array.isArray(row.evidence)) row.evidence = []
    if (Array.isArray(p.evidence)) row.evidence.push(...p.evidence)
    row.history.push({ from, to: p.to, at, evidence: Array.isArray(p.evidence) ? p.evidence : [] })
    if (p.fixtureCheck) row.fixtureCheck = { ...p.fixtureCheck, at }
    applied += 1

    if (journalDir) {
      try {
        appendEvent(
          { type: 'ladder-change', actors: [terminalId], scope: p.ruleId, detail: { ruleId: p.ruleId, from, to: p.to, reason: p.reason ?? '' } },
          { terminalId, journalDir, now: at },
        )
      } catch {
        /* fail-open — a journal failure never blocks the write */
      }
    }
  }

  if (ladderPath && applied > 0) {
    try {
      atomicWriteJson(ladderPath, ladder)
    } catch {
      /* fail-open */
    }
  }
  return { applied, ladder }
}

// ── auto-fix rung (allowlisted, deterministic, never inside a hook) ─────────────

/**
 * registerFix({ruleId, command, ladderPath}) -> {ok, reason?}. REFUSES a command that
 * fails the imported isSafeCommand (the ONE allowlist). On accept, records
 * fix:{command, registeredAt, greenApplies:0} on the rule (when ladderPath given).
 */
export function registerFix({ ruleId, command, ladderPath, now } = {}) {
  if (!ruleId) return { ok: false, reason: 'no ruleId' }
  if (!isSafeCommand(command)) return { ok: false, reason: 'command fails isSafeCommand allowlist' }
  if (ladderPath) {
    const ladder = readLadder({ ladderPath })
    let row = ruleRow(ladder, ruleId)
    if (!row) {
      row = { ruleId, kind: 'gate', tier: DEFAULT_TIER, since: now ?? new Date().toISOString(), evidence: [], history: [] }
      ladder.rules.push(row)
    }
    row.fix = { command: String(command), registeredAt: now ?? new Date().toISOString(), greenApplies: 0 }
    try {
      atomicWriteJson(ladderPath, ladder)
    } catch {
      /* fail-open */
    }
  }
  return { ok: true }
}

/**
 * applyFix({ruleId, runCommand, ladderPath, journalDir, terminalId, now}) -> {ok, ...}.
 * Runs ONLY an allowlisted registered command, via the INJECTED runCommand (this module
 * never spawns). Journals 'fix-applied' {ruleId, ok} and increments fix.greenApplies
 * only on a green run. A missing/non-allowlisted command -> {ok:false}. Never throws.
 */
export function applyFix({ ruleId, runCommand, ladderPath, journalDir, terminalId = 'ladder', now } = {}) {
  const ladder = readLadder({ ladderPath })
  const row = ruleRow(ladder, ruleId)
  const command = row && row.fix && row.fix.command
  if (!command || !isSafeCommand(command)) return { ok: false, reason: 'no allowlisted fix registered' }
  if (typeof runCommand !== 'function') return { ok: false, reason: 'no runner injected' }

  let ok = false
  let error = null
  try {
    runCommand(command)
    ok = true
  } catch (err) {
    ok = false
    error = String((err && err.message) ?? err)
  }

  if (ok) {
    row.fix.greenApplies = (Number.isFinite(row.fix.greenApplies) ? row.fix.greenApplies : 0) + 1
    if (ladderPath) {
      try {
        atomicWriteJson(ladderPath, ladder)
      } catch {
        /* fail-open */
      }
    }
  }
  if (journalDir) {
    try {
      appendEvent(
        { type: 'fix-applied', actors: [terminalId], scope: ruleId, detail: { ruleId, ok } },
        { terminalId, journalDir, now: now ?? new Date().toISOString() },
      )
    } catch {
      /* fail-open */
    }
  }
  return { ok, error, greenApplies: row.fix.greenApplies }
}
