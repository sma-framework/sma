/**
 * claims.mjs — atomic mkdir claim gate + provenance-lite stamps + expectedPrev
 * scanner (R11, C8, B18/B19/B24). D-49-09 groundwork; consumed by slots/CLI later.
 *
 * The gate is `fs.mkdirSync(dir)` with NO recursive flag: on a race, exactly one
 * caller creates the dir and every other gets EEXIST — that is the whole atomicity
 * primitive (RESEARCH Pattern 4). Provenance is written INSIDE the just-created dir
 * via atomicWriteJson (B19: metadata from creation, age over PID).
 *
 * Foreign-claim protection (P3, D-49-09): releaseSlot removes only the caller's OWN
 * claim; a foreign claim is refused unless {force:true} — the single foreign-removal
 * path, reachable only via the interactive force-clear command (49-10) with journaled
 * provenance.
 *
 * Node built-ins only; fs is dependency-injectable via the claimsDir option.
 */

import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { CLAIMS_DIR, SLOT_COOLDOWN_MS, SLOT_CLAIM_TTL_MS } from './constants.mjs'

function resolveClaimsDir(opts = {}) {
  return opts.claimsDir ?? CLAIMS_DIR
}

/**
 * claimSlot(name, provenance, opts) — try to win the named slot.
 * @param {string} name
 * @param {{by:string, session?:string, pid?:number, expectedPrev?:*, reason?:string}} provenance
 * @param {{claimsDir?:string}} [opts]
 * @returns {{won:true} | {won:false, holder:object|null}}
 */
export function claimSlot(name, provenance, opts = {}) {
  const base = resolveClaimsDir(opts)
  const dir = join(base, name)

  // Ensure the parent exists WITHOUT touching the claim dir itself.
  mkdirSync(base, { recursive: true })

  try {
    mkdirSync(dir) // NO recursive — EEXIST on race is the whole point (Pattern 4)
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const holder = readJsonSafe(join(dir, 'provenance.json'))
      return { won: false, holder }
    }
    throw err
  }

  const stamp = {
    by: provenance.by, // human holderIdentity (D-49-01)
    pid: provenance.pid ?? process.pid, // pid rides alongside (D-49-01)
    session: provenance.session ?? null,
    at: new Date().toISOString(),
    expectedPrev: provenance.expectedPrev ?? null,
    reason: provenance.reason ?? (provenance.expectedPrev == null ? 'initial' : 'update'),
  }
  atomicWriteJson(join(dir, 'provenance.json'), stamp)
  return { won: true }
}

/**
 * readClaims(opts) -> Array<{name, provenance, ageMs}>. Never throws; a malformed
 * claim dir is included with provenance:null.
 * @param {{claimsDir?:string}} [opts]
 */
export function readClaims(opts = {}) {
  const base = resolveClaimsDir(opts)
  let names
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return [] // missing claims dir -> no claims
  }

  const now = Date.now()
  return names.map((name) => {
    const dir = join(base, name)
    const provenance = readJsonSafe(join(dir, 'provenance.json'))
    let ageMs = 0
    try {
      ageMs = now - statSync(dir).ctimeMs
    } catch {
      ageMs = 0
    }
    return { name, provenance, ageMs }
  })
}

/**
 * releaseSlot(name, opts) — release the caller's OWN claim; refuse a foreign one
 * unless {force:true}. Also drops a cooldown marker so the slot stays unavailable
 * for SLOT_COOLDOWN_MS (B27).
 * @param {string} name
 * @param {{by:string, force?:boolean, claimsDir?:string}} opts
 * @returns {{released:boolean, reason?:string}}
 */
export function releaseSlot(name, opts = {}) {
  const base = resolveClaimsDir(opts)
  const dir = join(base, name)
  const prov = readJsonSafe(join(dir, 'provenance.json'))

  const isOwn = prov && prov.by === opts.by
  if (!isOwn && !opts.force) {
    return { released: false, reason: 'foreign' } // P3 — never silently remove a foreign claim
  }

  try {
    rmSync(dir, { recursive: true, force: true }) // rmSync recursive is the only allowed recursive here
  } catch {
    return { released: false, reason: 'rm-failed' }
  }

  // Cooldown marker (B27): a released slot stays unavailable for a window.
  try {
    writeFileSync(join(base, `.cooldown-${name}`), String(Date.now()))
  } catch {
    // fail-open — a missing cooldown marker just means no cooldown, never a throw
  }
  return { released: true }
}

/**
 * isCoolingDown(name, opts) -> boolean. True while a released/abandoned slot is
 * still within SLOT_COOLDOWN_MS of its cooldown marker (B27).
 * @param {string} name
 * @param {{claimsDir?:string, now?:number}} [opts]
 */
export function isCoolingDown(name, opts = {}) {
  const base = resolveClaimsDir(opts)
  const marker = join(base, `.cooldown-${name}`)
  try {
    const ts = Number(readFileSync(marker, 'utf8'))
    if (!Number.isFinite(ts)) return false
    const now = opts.now ?? Date.now()
    return now - ts < SLOT_COOLDOWN_MS
  } catch {
    return false // no marker -> not cooling down
  }
}

// ── 49.1-23 (B17) — idempotent slot reconciliation ─────────────────────────────────
//
// The claimed-but-not-consumed gap: a terminal claims a number slot (migration-100),
// then dies / aborts before actually writing the number into the source file. The old
// scan saw the live claim dir and skipped 100 forever — the number leaked into limbo.
// Reconciliation closes it: a claim that OUTLIVES its TTL and was never marked consumed
// is nobody's property — it is removed so the SAME number is re-issued.
//
// This is DISTINCT from the P3 founder-reserved push signal (never auto-cleared): a
// number slot is a mechanical allocation, not a human decision. reconcileExpiredClaim is
// only ever called from the next-slot allocators, never against push-in-progress.

/**
 * markConsumed(name, opts) — write the `consumed` marker inside a claim dir, recording
 * that the slot's number was ACTUALLY used. A consumed claim is never reconciled away.
 * @param {string} name
 * @param {{claimsDir?:string, now?:string}} [opts]
 * @returns {{consumed:boolean, reason?:string}}
 */
export function markConsumed(name, opts = {}) {
  const base = resolveClaimsDir(opts)
  const dir = join(base, name)
  try {
    writeFileSync(join(dir, 'consumed'), opts.now ?? new Date().toISOString())
    return { consumed: true }
  } catch {
    return { consumed: false, reason: 'no-claim' } // the dir must exist first (claim before consume)
  }
}

/** isConsumed(name, opts) -> boolean — true when the claim carries the consumed marker. */
export function isConsumed(name, opts = {}) {
  const base = resolveClaimsDir(opts)
  try {
    readFileSync(join(base, name, 'consumed'), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * reconcileExpiredClaim(name, opts) — remove a claim on `name` IFF it is older than
 * ttlMs (default SLOT_CLAIM_TTL_MS) AND was never marked consumed. Age is measured from
 * provenance.at (fallback: dir ctime). A consumed or still-fresh claim is left untouched.
 * No cooldown marker is dropped — the point is to re-issue the SAME number immediately.
 * @param {string} name
 * @param {{claimsDir?:string, ttlMs?:number, now?:number}} [opts]
 * @returns {{reconciled:boolean, holder?:object, ageMs?:number, reason?:string}}
 */
export function reconcileExpiredClaim(name, opts = {}) {
  const base = resolveClaimsDir(opts)
  const dir = join(base, name)
  const prov = readJsonSafe(join(dir, 'provenance.json'))
  if (!prov) return { reconciled: false, reason: 'no-claim' } // nothing / malformed -> nothing to do
  if (isConsumed(name, opts)) return { reconciled: false, reason: 'consumed' }

  const ttlMs = opts.ttlMs ?? SLOT_CLAIM_TTL_MS
  const now = opts.now ?? Date.now()
  const startedMs = prov.at ? Date.parse(prov.at) : NaN
  let ageMs
  if (Number.isFinite(startedMs)) {
    ageMs = now - startedMs
  } else {
    try {
      ageMs = now - statSync(dir).ctimeMs
    } catch {
      ageMs = 0
    }
  }
  if (ageMs <= ttlMs) return { reconciled: false, reason: 'fresh' }

  try {
    rmSync(dir, { recursive: true, force: true }) // no cooldown marker — reissue immediately
  } catch {
    return { reconciled: false, reason: 'rm-failed' }
  }
  return { reconciled: true, holder: prov, ageMs }
}

/**
 * scanProvenance(opts) -> Array<{claim, expected, actual}>. For each claim,
 * compares provenance.expectedPrev against the resolver's actual prior value; a
 * mismatch is a WARN. expectedPrev null with reason 'initial' is exempt (R11 edge).
 * @param {{claimsDir?:string, expectedResolver:(name:string, prov:object)=>*}} opts
 */
export function scanProvenance(opts = {}) {
  const resolver = opts.expectedResolver
  const warnings = []
  for (const { name, provenance } of readClaims(opts)) {
    if (!provenance) continue // malformed -> skip (fail-open, C9)
    if (provenance.expectedPrev == null && provenance.reason === 'initial') continue // exempt
    const actual = resolver ? resolver(name, provenance) : undefined
    if (provenance.expectedPrev !== actual) {
      warnings.push({ claim: name, expected: provenance.expectedPrev, actual })
    }
  }
  return warnings
}
