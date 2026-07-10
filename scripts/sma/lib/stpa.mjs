/**
 * stpa.mjs — the STPA disarm-path guard (49.2-10, D-49.2-14).
 *
 * STPA (System-Theoretic Process Analysis) asks not «did a component fail» but
 * «what control action, or its ABSENCE, leads to a hazard». Our hazard: a
 * protection silently disabled. Every SMA gate/reflex carries a kill-switch env
 * var; a «self-tuning» enforcement layer optimizes itself into silence unless the
 * DISARM PATH itself is guarded. This module is that guard:
 *
 *   1. HAZARDS registry — one row per kill-switch (every GATES[].killEnv, the two
 *      global kills SMA_GATES_DISABLE / SMA_REFLEX_DISABLE, and the guard's OWN
 *      SMA_STPA_OFF). Each row cites a COMPENSATING CONTROL and the birth-incident
 *      FIXTURE that the protection exists to catch. uncompensatedKillSwitches
 *      returns any switch lacking a control — the env-independent git-side check
 *      HAZARD-NOCONTROL enforces (it is itself the control cited by SMA_STPA_OFF,
 *      so the guard cannot silently kill the guard).
 *
 *   2. shadowRunFixtures — at session-start, replays each DISARMED gate's birth
 *      fixture through checkEvent with a SCRUBBED env ({}) and a singleton gates
 *      list, proving the protection STILL trips against the incident that birthed
 *      it, even while it is switched off. Rides checkEvent's existing injectable
 *      env/gates surface — gates.mjs is NEVER edited.
 *
 *   3. reArmDecisions / renewDisarm — a set kill-switch gets a 7-day provenance
 *      LEASE on first sighting; when the lease lapses OR the switch cites no
 *      compensating control, the guard auto-RE-ARMS the rule (WARN tier only,
 *      fail-open — hard deny stays the security guard's alone). A founder can keep
 *      a rule off deliberately via renewDisarm (recorded provenance) but NEVER
 *      silently.
 *
 * CONS-49.2-B: everything here is fail-open. shadowRunFixtures/reArmDecisions wrap
 * every path — an IO error yields empty results so session-start can never wedge.
 * They wire into session-start + the lint ONLY, never the per-tool-call hot path
 * (plan 02 SLO): gates-check consults a re-arm decision solely on the rare path
 * where a gate's own kill env is actually set (zero extra IO otherwise).
 *
 * Node built-ins only; DI dirs; zero packages.
 */

import { join } from 'node:path'

import { DISARM_DIR } from './constants.mjs'
import { GATES, checkEvent } from './gates.mjs'
import { deriveTags } from './reflex.mjs'
import { appendEvent } from './journal.mjs'
import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'

// SMA-3 escaped-verb isolation: the two push fixtures replay the exact command the
// PUSH gates forbid, so the literal is ASSEMBLED (never adjacent in this source) —
// the same posture gates.mjs uses so this guard file does not trip SMA-3 on itself.
const PUSH_VERB = ['push'].join('')
const PUSH_FIXTURE = `git ${PUSH_VERB} origin main`
const FORCE_PUSH_FIXTURE = `git ${PUSH_VERB} --force origin main`

/** Default provenance-lease TTL: 7 days. */
export const DISARM_LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The two global kill-switches + the guard's own — no single gate owns these. */
export const GLOBAL_KILL_SWITCHES = ['SMA_GATES_DISABLE', 'SMA_REFLEX_DISABLE', 'SMA_STPA_OFF']

/** truthy env flag: set and not ''/0/false (mirrors gates.truthy — one semantics). */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/**
 * HAZARDS — one row per kill-switch. Each row:
 *   killEnv             — the env var that disables the protection
 *   gateId?             — the owning gate (gate rows only)
 *   kind                — 'gate' | 'reflex' | 'global' | 'self'
 *   hazard              — the unsafe control action a silent disarm enables
 *   compensatingControl — the mitigation that survives the switch being off
 *   fixture             — the birth-incident synthetic tool event (gate/reflex)
 *
 * Co-located HERE, not in gates.mjs — gates.mjs behavior is untouched.
 */
export const HAZARDS = [
  {
    killEnv: 'SMA_GATE_PUSH_OFF',
    gateId: 'GATE-PUSH',
    kind: 'gate',
    hazard: 'a push ships without the full gate / origin-diff review / V1.N tag',
    compensatingControl: 'the founder-only push ritual (/sma-ship) still runs the full gate; the pre-push grill (plan 07) inspects origin..main independently of this WARN',
    fixture: { tool_name: 'Bash', tool_input: { command: PUSH_FIXTURE } },
  },
  {
    killEnv: 'SMA_GATE_ADDALL_OFF',
    gateId: 'GATE-ADDALL',
    kind: 'gate',
    hazard: 'a bulk `git add -A` captures another terminal\'s uncommitted files on the shared tree',
    compensatingControl: 'git status shows staged files before every commit; the atomic-commit house rule requires explicit per-file staging regardless of this WARN',
    fixture: { tool_name: 'Bash', tool_input: { command: 'git add -A' } },
  },
  {
    killEnv: 'SMA_GATE_STASH_OFF',
    gateId: 'GATE-STASH',
    kind: 'gate',
    hazard: 'a `git stash` applies a sibling worktree\'s WIP from the shared stash stack',
    compensatingControl: 'the destructive-git-prohibition house rule bans git stash outright; the airbag gate (plan 05) snapshots before destructive git regardless',
    fixture: { tool_name: 'Bash', tool_input: { command: 'git stash' } },
  },
  {
    killEnv: 'SMA_GATE_MEMEDIT_OFF',
    gateId: 'GATE-MEMEDIT',
    kind: 'gate',
    hazard: 'a hand-edit of generated MEMORY.md / INDEX-*.md is lost on the next rebuild',
    compensatingControl: 'MEM-REGEN lint fails when the committed index diverges from regeneration — the drift is caught at git-side even with this WARN off',
    fixture: { tool_name: 'Write', tool_input: { file_path: '.claude/memory/MEMORY.md', content: 'x' } },
  },
  {
    killEnv: 'SMA_GATE_DODHONESTY_OFF',
    gateId: 'GATE-DODHONESTY',
    kind: 'gate',
    hazard: 'a human DoD gate is self-certified pass by a file write instead of the founder',
    compensatingControl: 'the DoD honesty house rule + /crm/projects human-gate toggles are the source of truth; a file-written pass is visible in the board audit',
    fixture: { tool_name: 'Write', tool_input: { file_path: 'phases/49.2-DOD.json', content: '{"kind":"human","status":"pass"}' } },
  },
  {
    killEnv: 'SMA_GATE_NEXTBUILD_OFF',
    gateId: 'GATE-NEXTBUILD',
    kind: 'gate',
    hazard: 'a local `next build` holds the .next lock and burns time the CI build owns',
    compensatingControl: 'the no-local-next-build house rule + Railway CI are authoritative; a stray build fails loudly on the lock, it does not corrupt state',
    fixture: { tool_name: 'Bash', tool_input: { command: 'next build' } },
  },
  {
    killEnv: 'SMA_GATE_CHECKOUT_OFF',
    gateId: 'GATE-CHECKOUT',
    kind: 'gate',
    hazard: 'a `git checkout -- .` / `git restore .` destroys another terminal\'s uncommitted work',
    compensatingControl: 'the destructive-git-prohibition house rule bans blanket checkout/restore; the airbag gate (plan 05) snapshots the tree before destructive git',
    fixture: { tool_name: 'Bash', tool_input: { command: 'git checkout -- .' } },
  },
  {
    killEnv: 'SMA_GATE_MIGNUM_OFF',
    gateId: 'GATE-MIGNUM',
    kind: 'gate',
    hazard: 'a hand-picked migration number collides with a parallel terminal on the shared tree',
    compensatingControl: 'migration numbers come from `pnpm sma next-slot migration` (sorted-insert slot claim); a collision surfaces at the slot claim regardless of this WARN',
    fixture: { tool_name: 'Write', tool_input: { file_path: 'src/migrations/index.ts', content: 'x' } },
  },
  {
    killEnv: 'SMA_GATE_STATEEDIT_OFF',
    gateId: 'GATE-STATEEDIT',
    kind: 'gate',
    hazard: 'a hand-edit of the machine-managed STATE.md fence is lost on the next state-verb write',
    compensatingControl: 'the state verbs (pnpm sma state ...) own the fenced region; a hand-edit outside the fence is preserved, one inside is overwritten predictably, not silently corrupted',
    fixture: { tool_name: 'Write', tool_input: { file_path: '.planning/STATE.md', content: '## Current Position\nx' } },
  },
  {
    killEnv: 'SMA_GATE_FORCEPUSH_OFF',
    gateId: 'GATE-FORCEPUSH',
    kind: 'gate',
    hazard: 'a force-push overwrites a branch with no burden-of-proof evidence record',
    compensatingControl: 'the soft-deny tier (SMA_GATE_FORCEPUSH_DENY) + evidence.mjs burden-of-proof record still gate an armed install; the destructive-git house rule bans force-push to foreign branches',
    fixture: { tool_name: 'Bash', tool_input: { command: FORCE_PUSH_FIXTURE } },
  },
  {
    killEnv: 'SMA_GATE_ALLOWLIST_OFF',
    gateId: 'GATE-ALLOWLIST',
    kind: 'gate',
    hazard: 'an edit to the SAFE_COMMAND allowlist widens the execution boundary unnoticed',
    compensatingControl: 'the soft-deny tier (SMA_GATE_ALLOWLIST_DENY) + evidence record gate an armed install; SMA-RECEIPTS-1 / SMA-GRILL guard invariants assert the boundary stays the single imported isSafeCommand',
    fixture: { tool_name: 'Write', tool_input: { file_path: 'lib/predict.mjs', content: 'SAFE_COMMAND_PATTERNS = []' } },
  },
  // ── global kill-switches ────────────────────────────────────────────────────
  {
    killEnv: 'SMA_GATES_DISABLE',
    kind: 'global',
    hazard: 'ALL gates are disabled at once — every hard-rule advisory goes dark',
    compensatingControl: 'setting a global disable is a deliberate, visible env action; the auto-re-arm lease + this HAZARDS registry make its use accountable, and the security guard\'s hard-deny is unaffected (WARN-only layer)',
    // Representative fixture: a bulk-stage still trips when the FULL gate set runs scrubbed.
    fixture: { tool_name: 'Bash', tool_input: { command: 'git add -A' } },
  },
  {
    killEnv: 'SMA_REFLEX_DISABLE',
    kind: 'reflex',
    hazard: 'the memory reflex stops surfacing task-scoped bug-lessons before an act',
    compensatingControl: 'CORE memory still auto-loads via MEMORY.md; deriveTags/matchReflexes remain callable and the pre-act injection at session-start is independent of the per-tool reflex WARN',
    fixture: { tool_name: 'Edit', tool_input: { file_path: 'src/crm/orchestrator/inbound.ts', content: 'x' } },
  },
  {
    killEnv: 'SMA_STPA_OFF',
    kind: 'self',
    hazard: 'the disarm-path guard itself is switched off, so silent disarms stop being re-armed',
    compensatingControl: 'HAZARD-NOCONTROL is an ENV-INDEPENDENT git-side lint — it runs regardless of SMA_STPA_OFF, so the guard cannot silently kill the guard',
    fixture: null, // the compensating control is a lint, not a tool-event fixture
  },
  {
    // 49.3-06 (D-49.3-12) — the self-tuning ladder's OWN kill env. Disabling the
    // overlay freezes every tier: demotions/re-arms stop, so a warned-then-ignored
    // rule can neither quieten nor re-arm. The disarm-path guard covers the tuner
    // itself. Its compensating control is env-independent: the tier registry is a
    // TRACKED file (git history is the record), LADDER-EVIDENCE lint fails any
    // evidence-free tier, and applyProposals cross-journals every legitimate change.
    killEnv: 'SMA_LADDER_OFF',
    kind: 'self',
    hazard: 'the ladder overlay is silently disabled -> tiers frozen; demotions and incident re-arms stop',
    compensatingControl: 'the TRACKED sma-ladder.json (git diff/history is the tamper record) + the LADDER-EVIDENCE critical lint (evidence-free tiers + unchecked retirements fail regardless of the env) + applyProposals cross-journaling every change',
    fixture: null, // the compensating control is the tracked file + lint, not a tool-event fixture
  },
]

/** The HAZARDS row for a given killEnv, or null. */
function hazardFor(killEnv) {
  return HAZARDS.find((h) => h.killEnv === killEnv) ?? null
}

/** A non-empty string. */
function nonEmpty(s) {
  return typeof s === 'string' && s.trim() !== ''
}

/**
 * uncompensatedKillSwitches({gates}) -> string[]. The set of kill-switches that
 * lack a HAZARDS row with a non-empty compensatingControl. The required switch
 * set = every gate.killEnv (from the injected gates, default GATES) + the three
 * globals. On the shipped registry this is [] — a synthetic gate carrying a
 * killEnv with no HAZARDS row surfaces as the orphan. Env-independent + pure.
 *
 * @param {{gates?:Array}} [args]
 * @returns {string[]}
 */
export function uncompensatedKillSwitches({ gates = GATES } = {}) {
  const required = new Set()
  for (const g of Array.isArray(gates) ? gates : []) {
    if (g && nonEmpty(g.killEnv)) required.add(g.killEnv)
  }
  for (const k of GLOBAL_KILL_SWITCHES) required.add(k)

  const orphans = []
  for (const killEnv of required) {
    const row = hazardFor(killEnv)
    if (!row || !nonEmpty(row.compensatingControl)) orphans.push(killEnv)
  }
  return orphans
}

/** Evaluate one HAZARDS row's birth fixture with a SCRUBBED env. Never throws. */
function fixtureTrips(row, { gates = GATES } = {}) {
  try {
    if (row.kind === 'self') {
      // The control is the env-independent lint — «trips» = it is computable.
      return Array.isArray(uncompensatedKillSwitches({ gates }))
    }
    if (row.kind === 'reflex') {
      const { tags } = deriveTags(row.fixture && row.fixture.tool_input, '')
      return Array.isArray(tags) && tags.length > 0
    }
    // gate | global: run checkEvent with a SCRUBBED env and the relevant gate(s).
    const list =
      row.kind === 'global'
        ? gates // a global disable would kill the WHOLE set — run them all scrubbed
        : (gates || []).filter((g) => g && g.id === row.gateId)
    const out = checkEvent({ evt: row.fixture, env: {}, gates: list })
    return (out.warns && out.warns.length > 0) || (out.fires && out.fires.length > 0)
  } catch {
    return false // fail-open — a fixture that cannot be evaluated is reported as not-tripping
  }
}

/**
 * shadowRunFixtures({env, dirs, gates, now}) -> report[]. For each HAZARDS row,
 * replays its birth fixture through checkEvent with a SCRUBBED env and reports
 * {killEnv, gateId, kind, disarmed, fixtureTrips}. A disarmed-but-still-tripping
 * fixture is the proof the protection is needed while it is off. Journals each
 * finding (best-effort). Fail-open: any error -> []. Never wedges session-start.
 *
 * @param {{env?:object, dirs?:object, gates?:Array, now?:string}} [args]
 */
export function shadowRunFixtures({ env = {}, dirs = {}, gates = GATES, now } = {}) {
  try {
    const report = []
    for (const row of HAZARDS) {
      const disarmed = truthy(env[row.killEnv])
      const trips = fixtureTrips(row, { gates })
      const entry = { killEnv: row.killEnv, gateId: row.gateId ?? null, kind: row.kind, disarmed, fixtureTrips: trips }
      report.push(entry)
      if (disarmed) {
        try {
          appendEvent(
            {
              type: 'stpa-shadow',
              actors: [],
              scope: row.killEnv,
              detail: { gateId: row.gateId ?? null, disarmed: true, fixtureTrips: trips, at: now ?? new Date().toISOString() },
            },
            { terminalId: 'stpa-guard', journalDir: dirs.journalDir },
          )
        } catch {
          /* journal fail-soft */
        }
      }
    }
    return report
  } catch {
    return []
  }
}

// ── provenance leases + auto-re-arm ─────────────────────────────────────────────

function resolveDisarmDir(dirs = {}) {
  return dirs.disarmDir ?? DISARM_DIR
}

/** The lease key for a HAZARDS row: gateId for gates, killEnv for globals. */
function leaseKey(row) {
  return row.gateId ?? row.killEnv
}

function leasePath(row, dirs) {
  return join(resolveDisarmDir(dirs), `${leaseKey(row)}.json`)
}

/** Parse a `now` that may be an ISO string or ms number -> ms (Date.now() default). */
function nowMs(now) {
  if (now == null) return Date.now()
  if (typeof now === 'number') return now
  const t = Date.parse(now)
  return Number.isFinite(t) ? t : Date.now()
}

/**
 * reArmDecisions({env, now, dirs, gates}) -> decision[]. For every kill-switch set
 * truthy in `env`: on FIRST sighting writes a 7-day provenance lease
 * {gateId, killEnv, firstSeen, ttlMs, provenance:null}; then decides:
 *   'honor'   — a LIVE lease whose HAZARDS row cites a compensating control
 *   're-arm'  — the lease is EXPIRED, OR the switch is uncompensated
 * A 're-arm' carries a WARN-tier message naming the fixture that still trips. The
 * decision NEVER escalates past WARN (hard deny stays the security guard's). Any
 * IO error -> [] (fail-open). Reads leases only for switches actually set — zero
 * IO when nothing is disarmed.
 *
 * @param {{env?:object, now?:(string|number), dirs?:object, gates?:Array}} [args]
 * @returns {Array<{killEnv, gateId, decision, compensated, expired, hasProvenance, message, fixtureTrips}>}
 */
export function reArmDecisions({ env = {}, now, dirs = {}, gates = GATES } = {}) {
  try {
    const t = nowMs(now)
    const nowIso = new Date(t).toISOString()
    const decisions = []
    for (const row of HAZARDS) {
      if (!truthy(env[row.killEnv])) continue // only SET switches are decided (rare path)

      const path = leasePath(row, dirs)
      let lease = readJsonSafe(path)
      if (!lease) {
        lease = { gateId: leaseKey(row), killEnv: row.killEnv, firstSeen: nowIso, ttlMs: DISARM_LEASE_TTL_MS, provenance: null }
        try {
          atomicWriteJson(path, lease)
        } catch {
          /* fail-open — a lease write failure never blocks the decision */
        }
      }

      const compensated = nonEmpty(row.compensatingControl)
      const leaseStart = Date.parse(lease.renewedAt ?? lease.firstSeen)
      const ttl = Number.isFinite(lease.ttlMs) ? lease.ttlMs : DISARM_LEASE_TTL_MS
      const expired = Number.isFinite(leaseStart) ? t - leaseStart > ttl : false
      const hasProvenance = lease.provenance != null

      let decision
      if (!compensated) decision = 're-arm'
      else if (expired) decision = 're-arm'
      else decision = 'honor'

      const reason = !compensated ? 'no compensating control cited' : expired ? 'disarm lease expired' : 'live compensated lease'
      const message =
        decision === 're-arm'
          ? `SMA STPA: kill-switch ${row.killEnv} re-armed to WARN (${reason}); its birth fixture still trips — set provenance via \`sma integrity disarm-renew ${leaseKey(row)}\` to keep it off deliberately.`
          : `SMA STPA: kill-switch ${row.killEnv} honored (${reason}).`

      decisions.push({
        killEnv: row.killEnv,
        gateId: row.gateId ?? null,
        decision,
        compensated,
        expired,
        hasProvenance,
        fixtureTrips: fixtureTrips(row, { gates }),
        message,
      })
    }
    return decisions
  } catch {
    return []
  }
}

/**
 * countSilentDisarms({env, now, dirs}) -> integer. A SILENT disarm = a set
 * kill-switch that is being HONORED (not re-armed) yet carries no provenance —
 * disabled with neither a live provenance lease NOR an auto-re-arm. The data
 * source for `integrity disarms --count-silent` (P49.2-10-02). Zero on an env
 * with no kill-switch set.
 *
 * @param {{env?:object, now?:(string|number), dirs?:object}} [args]
 */
export function countSilentDisarms({ env = {}, now, dirs = {} } = {}) {
  const decisions = reArmDecisions({ env, now, dirs })
  return decisions.filter((d) => d.decision !== 're-arm' && !d.hasProvenance).length
}

/**
 * renewDisarm({gateId, reason, identity, dirs, now, ttlMs}) -> the renewed lease.
 * Re-leases a kill-switch WITH provenance {renewedAt, by, reason} (D-49-09 shape)
 * so a founder can keep a rule off deliberately — but never silently. Journals the
 * renewal. `gateId` is the lease key (a gate id, or a global killEnv). Never throws.
 *
 * @param {{gateId:string, reason?:string, identity?:{terminalId?:string, holderIdentity?:string}, dirs?:object, now?:string, ttlMs?:number}} args
 */
export function renewDisarm({ gateId, reason, identity = {}, dirs = {}, now, ttlMs } = {}) {
  const at = now ?? new Date().toISOString()
  const path = join(resolveDisarmDir(dirs), `${gateId}.json`)
  const prior = readJsonSafe(path) ?? {}
  const row = HAZARDS.find((h) => (h.gateId ?? h.killEnv) === gateId)
  const lease = {
    gateId,
    killEnv: prior.killEnv ?? (row ? row.killEnv : null),
    firstSeen: prior.firstSeen ?? at,
    renewedAt: at,
    ttlMs: Number.isFinite(ttlMs) ? ttlMs : (Number.isFinite(prior.ttlMs) ? prior.ttlMs : DISARM_LEASE_TTL_MS),
    provenance: {
      by: identity.holderIdentity ?? identity.terminalId ?? null,
      reason: typeof reason === 'string' ? reason : null,
      renewedAt: at,
    },
  }
  try {
    atomicWriteJson(path, lease)
  } catch {
    /* fail-open */
  }
  try {
    appendEvent(
      {
        type: 'stpa-disarm-renew',
        actors: [identity.terminalId ?? identity.holderIdentity].filter(Boolean),
        scope: gateId,
        detail: { gateId, killEnv: lease.killEnv, reason: lease.provenance.reason, renewedAt: at },
      },
      { terminalId: identity.terminalId ?? 'stpa-guard', journalDir: dirs.journalDir },
    )
  } catch {
    /* journal fail-soft */
  }
  return lease
}
