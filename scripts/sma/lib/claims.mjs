/**
 * claims.mjs — atomic mkdir claim gate + provenance-lite stamps + expectedPrev
 * scanner (R11, C8, B18/B19/B24). D-9-09 groundwork; consumed by slots/CLI later.
 *
 * The gate is `fs.mkdirSync(dir)` with NO recursive flag: on a race, exactly one
 * caller creates the dir and every other gets EEXIST — that is the whole atomicity
 * primitive (RESEARCH Pattern 4). Provenance is written INSIDE the just-created dir
 * via atomicWriteJson (B19: metadata from creation, age over PID).
 *
 * Foreign-claim protection (P3, D-9-09): releaseSlot removes only the caller's OWN
 * claim; a foreign claim is refused unless {force:true} — the single foreign-removal
 * path, reachable only via the interactive force-clear command (49-10) with journaled
 * provenance.
 *
 * Node built-ins only; fs is dependency-injectable via the claimsDir option.
 */

import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { appendEvent } from './journal.mjs'
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
    by: provenance.by, // human holderIdentity (D-9-01)
    pid: provenance.pid ?? process.pid, // pid rides alongside (D-9-01)
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
 * cooldownText(name, opts) — 9.3-13 (D-9.3-22c): the rendered collision text for a slot
 * in cooldown. A recently force-cleared / released scope reads «недавно освобождён», NEVER
 * «занято» — the reader must know it is FREE-ish (in a short cooldown), not busy. Empty
 * string when the slot is not cooling down. The cooldown marker / provenance / force-clear
 * confirmation machinery (D-9-09) is UNCHANGED — only this copy is the fix.
 * @param {string} name
 * @param {{claimsDir?:string, now?:number}} [opts]
 * @returns {string}
 */
export function cooldownText(name, opts = {}) {
  if (!isCoolingDown(name, opts)) return ''
  const base = resolveClaimsDir(opts)
  const marker = join(base, `.cooldown-${name}`)
  let ageMin = '?'
  try {
    const ts = Number(readFileSync(marker, 'utf8'))
    const now = opts.now ?? Date.now()
    if (Number.isFinite(ts)) ageMin = Math.max(0, Math.round((now - ts) / 60000))
  } catch {
    /* fail-open — no marker age */
  }
  return `недавно освобождён (${ageMin} мин назад) — можно занимать`
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

// ── 9.1-23 (B17) — idempotent slot reconciliation ─────────────────────────────────
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

// ── 9.3-13 (D-9.3-22) — claim trust repair: the TWO auto-release triggers ──────────
//
// Claims become trustworthy by auto-releasing on EXACTLY two triggers — never an idle
// timer (D-9.3-22a: an idle timer would reap a terminal that thinks/researches long
// before editing). Trigger 1: a SessionEnd hook releases all of the session's claims.
// Trigger 2: commit-evidence — the claimed scope is clean vs HEAD AND a commit landed in
// scope after renewTime, so the work is provably DONE — release immediately, no TTL wait.

/**
 * sessionEnd({identity, claimsDir, journalDir, now}) — TRIGGER 1. Release ALL of THIS
 * session's own claims (marked «сессия завершена» in the journal). Releases only the OWN
 * session's claims (a foreign claim is left untouched); calling it twice is idempotent
 * (the second call finds no own claims). Wired to a NEW SessionEnd hook — NEVER the Stop
 * hook (Stop fires per turn; releasing every claim after every turn destroys the system).
 * @param {{identity?:Object, by?:string, claimsDir?:string, journalDir?:string, now?:string}} opts
 * @returns {{released:string[]}}
 */
export function sessionEnd(opts = {}) {
  const identity = opts.identity || {}
  const by = identity.holderIdentity || opts.by
  const released = []
  if (!by) return { released }
  const terminalId = identity.terminalId || by
  for (const { name, provenance } of readClaims(opts)) {
    if (!provenance || provenance.by !== by) continue // OWN claims only (P3)
    const r = releaseSlot(name, { by, claimsDir: opts.claimsDir })
    if (!r.released) continue
    released.push(name)
    try {
      appendEvent(
        { type: 'release', actors: [by], scope: name, detail: { reason: 'session-ended' } },
        { terminalId, journalDir: opts.journalDir, now: opts.now },
      )
    } catch {
      /* fail-open — the journal note is best-effort */
    }
  }
  return { released }
}

/**
 * commitEvidenceRelease({claim, scopeDirtyVsHead, commitShaAfterRenew, ...}) — TRIGGER 2.
 * Release the claim IMMEDIATELY (no TTL wait) IFF the scope is CLEAN vs HEAD AND a commit
 * landed in scope after the claim's renewTime — the two conditions ANDed (the work is
 * provably done). A DIRTY scope, or NO post-renew commit, means work is still in progress
 * -> NOT released. Journals the git evidence. Deterministic over the injected facts.
 * @param {{claim:Object, scopeDirtyVsHead:boolean, commitShaAfterRenew?:string,
 *          claimsDir?:string, journalDir?:string, terminalId?:string, now?:string}} opts
 * @returns {{released:boolean, reason?:string, commit?:string}}
 */
export function commitEvidenceRelease(opts = {}) {
  const claim = opts.claim || {}
  const dirty = !!opts.scopeDirtyVsHead
  const commit = opts.commitShaAfterRenew || null
  if (dirty) return { released: false, reason: 'dirty' } // work still in progress
  if (!commit) return { released: false, reason: 'no-commit' } // no evidence the work landed

  const name = claim.name
  if (!name) return { released: false, reason: 'no-name' }
  const by = claim.by || (claim.provenance && claim.provenance.by) || opts.by || '—'
  // Evidence-based auto-release: the git facts justify removal, so force:true is used with
  // a fully-journaled provenance (D-9-09 governs the interactive force-clear COMMAND, not
  // this evidence trigger).
  const r = releaseSlot(name, { by, force: true, claimsDir: opts.claimsDir })
  if (!r.released) return { released: false, reason: r.reason }
  const sha = String(commit).slice(0, 7)
  try {
    appendEvent(
      { type: 'release', actors: [by], scope: name, detail: { reason: 'commit-evidence', commit: sha } },
      { terminalId: opts.terminalId || by, journalDir: opts.journalDir, now: opts.now },
    )
  } catch {
    /* fail-open */
  }
  return { released: true, commit: sha }
}
