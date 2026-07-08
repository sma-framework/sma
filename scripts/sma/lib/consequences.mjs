/**
 * consequences.mjs — Consequences-as-LAW: the single step from RECORDING to
 * CONTROL (49.2-08, D-49.2-12, ICE 648). Verified claims must control behavior:
 * a class-A prediction miss OR a claimed-pass/reproduced-fail divergence stops
 * `sma ship` until the founder dispositions it, and a divergence leaves a ready
 * rollback candidate branch.
 *
 * This module is the law's BRAIN — deterministic, downgrade-proof, fail-open,
 * founder-gated at the record level. It is a pure library over injected state:
 * every ledger dir and git runner is dependency-injected (calibrationDir,
 * execGit), so tests never touch the real .sma/ or the real repo. Node built-ins
 * only; zero npm deps; NO LLM / network import anywhere (plan prohibition).
 *
 * The four moving parts:
 *   1. `parseConsequences` / `validateConsequence` — the immutable frontmatter
 *      block schema {id, trigger, blocks, until, rationale?, class?} (the CONS
 *      lint family in lint.mjs enforces schema + post-edit immutability).
 *   2. `classifyEvent` — the deterministic, total, downgrade-proof class
 *      taxonomy (A blocks ship, B warns) over CLASS_A_DOMAINS.
 *   3. `openBlocks` / `recordDisposition` — the auto-block consumer over the V2
 *      calibration ledger and the ONLY unblock path (a NEW appended disposition
 *      record, never an edit).
 *   4. `openRollbackCandidate` — create-only `update-ref` in a dedicated
 *      namespace (airbag D-49.2-08 posture: milliseconds, working tree untouched).
 *
 * Prohibitions honored HERE (see the plan's threat register):
 *   - NEVER a PreToolUse/hook hard deny — enforcement is exit codes the ship
 *     ritual consumes (cli.mjs cmdPreship), hard deny stays the guard's alone.
 *   - NEVER downgrade a trust-domain miss via an entry-declared class (Goodhart).
 *   - NEVER mutate/delete a ledger line — a disposition is a NEW record.
 *   - NEVER checkout/reset/force-move/delete a ref — create-only, own namespace.
 */

import { readLedger, appendVerdict } from './calibration.mjs'
import { parseFrontmatterEntries } from './predict.mjs'

/**
 * The three trust-claim domains from CONS-49.2-A: a `miss` verdict in ANY of
 * them is class A by construction — these ARE the trust claim (S1 false-done,
 * S4 subagent honesty, S8 blind-verifier quality). Frozen + exported so plan
 * 10's guards and the report reuse ONE boundary, never a second copy.
 */
export const CLASS_A_DOMAINS = Object.freeze([
  'sma.receipts',
  'sma.subagents',
  'sma.verification',
])

/** Required fields of a consequences entry. */
const REQUIRED_FIELDS = ['id', 'trigger', 'blocks', 'until']

/**
 * parseConsequences(planPath, opts) -> {consequences, error?}.
 *
 * Thin wrapper over predict.mjs's shared parseFrontmatterEntries keyed to
 * 'consequences'. A plan without the block returns an honest empty array, never
 * a throw (fail-open C9 — the law is an observer at parse time).
 *
 * @param {string} planPath
 * @param {{readFn?:Function}} [opts]
 * @returns {{consequences: object[], error?: string}}
 */
export function parseConsequences(planPath, opts = {}) {
  const { entries, error } = parseFrontmatterEntries(planPath, 'consequences', opts)
  return error ? { consequences: entries, error } : { consequences: entries }
}

/**
 * validateConsequence(entry) -> {valid, missing, errors}.
 *
 * Required: id/trigger/blocks/until (non-empty strings). Optional: rationale;
 * class in {A, B} (case-insensitive) — anything else is an error. Mirrors
 * predict.mjs's validatePrediction return shape exactly (one boundary, the CONS
 * lint delegates to this, never re-implements it).
 *
 * @param {object} entry
 * @returns {{valid: boolean, missing: string[], errors: string[]}}
 */
export function validateConsequence(entry) {
  const e = entry ?? {}
  const missing = REQUIRED_FIELDS.filter((k) => e[k] == null || String(e[k]).trim() === '')
  const errors = []
  if (e.class != null && String(e.class).trim() !== '') {
    const c = String(e.class).trim().toUpperCase()
    if (c !== 'A' && c !== 'B') {
      errors.push(`class "${e.class}" not in {A, B}`)
    }
  }
  return { valid: missing.length === 0 && errors.length === 0, missing, errors }
}

/**
 * eventKey(record) -> stable identity for a scored event. `${id}@${when}` where
 * when = scoredAt (a prediction verdict) or at (a divergence/other record),
 * falling back to '0'. A repeat-scored prediction keyed at a new scoredAt is a
 * NEW event; the same score is the same key (idempotent disposition matching).
 *
 * @param {object} record
 * @returns {string}
 */
export function eventKey(record) {
  const r = record ?? {}
  return `${r.id ?? 'unknown'}@${r.scoredAt ?? r.at ?? '0'}`
}

/**
 * classifyEvent(record) -> 'A' | 'B' | null. Deterministic, total, and
 * DOWNGRADE-PROOF:
 *   - {verdict:'divergence'}                              -> 'A' (always)
 *   - {verdict:'miss', domain ∈ CLASS_A_DOMAINS}          -> 'A' (trust miss)
 *   - {verdict:'miss', other domain}                      -> 'B'
 *   - {verdict:'miss', other domain, class:'A'}           -> 'A' (escalation OK)
 *   - {verdict:'miss', trust domain, class:'B'}           -> 'A' (downgrade IGNORED)
 *   - {verdict:'hit'} / {kind:'disposition'} / anything else -> null
 *
 * An entry-declared class may only ESCALATE B->A; it can NEVER downgrade a
 * trust-domain miss (the Goodhart hole the taxonomy would otherwise leave open
 * from plan frontmatter). Locked by behavior test.
 *
 * @param {object} record  a calibration-ledger record
 * @returns {'A'|'B'|null}
 */
export function classifyEvent(record) {
  const r = record ?? {}
  if (r.kind === 'disposition') return null // a disposition is not itself an event
  if (r.verdict === 'divergence') return 'A' // claimed-pass / reproduced-fail — always A
  if (r.verdict !== 'miss') return null // hit / skipped-unsafe / error carry no class

  const trustDomain = CLASS_A_DOMAINS.includes(r.domain)
  if (trustDomain) return 'A' // trust-domain miss is A; a declared class cannot downgrade it

  // Non-trust miss: class B by default; a declared 'A' may escalate it.
  const declared = typeof r.class === 'string' ? r.class.trim().toUpperCase() : null
  return declared === 'A' ? 'A' : 'B'
}

/**
 * openBlocks(opts) -> {blocks, warns, dispositions, corrupt}.
 *
 * Reads the WHOLE calibration ledger (all domains), classifies every record,
 * and returns the OPEN class-A blocks (a class-A event whose eventKey has NO
 * matching {kind:'disposition', ref} record), the class-B warns, the raw
 * disposition records, and the tolerant-reader corrupt-line count. A missing
 * ledger dir yields an honest empty result — an absent ledger CANNOT block ship
 * (fail-open C9: the block requires POSITIVE evidence of a class-A event).
 *
 * @param {{calibrationDir?:string}} [opts]
 * @returns {{blocks: object[], warns: object[], dispositions: object[], corrupt: number}}
 */
export function openBlocks(opts = {}) {
  const { records, corrupt } = readLedger({ calibrationDir: opts.calibrationDir })

  const dispositions = records.filter((r) => r && r.kind === 'disposition')
  const dispositionedKeys = new Set(dispositions.map((d) => d.ref))

  const blocks = []
  const warns = []
  for (const r of records) {
    const cls = classifyEvent(r)
    if (cls === 'A') {
      const key = eventKey(r)
      if (!dispositionedKeys.has(key)) blocks.push({ ...r, class: 'A', eventKey: key })
    } else if (cls === 'B') {
      warns.push({ ...r, class: 'B', eventKey: eventKey(r) })
    }
  }

  return { blocks, warns, dispositions, corrupt }
}

/**
 * recordDisposition({eventKey, disposition, reason, by, domain}, opts) -> the
 * written record. The ONLY unblock path. Appends ONE append-only
 * {kind:'disposition', ref, disposition, reason, by, domain, at} line to the
 * event's domain file (fallback 'sma.consequences') via calibration.appendVerdict
 * — a disposition carries NO `verdict` field, so hitRate/escalations ignore it
 * by construction and the law never distorts B20 calibration math.
 *
 * @param {{eventKey:string, disposition:string, reason:string, by?:string, domain?:string}} args
 * @param {{calibrationDir?:string, now?:string}} [opts]
 * @returns {object} the written disposition record
 */
export function recordDisposition({ eventKey: ref, disposition, reason, by, domain }, opts = {}) {
  const record = {
    kind: 'disposition',
    ref,
    disposition,
    reason,
    by: by ?? 'unknown',
    domain: domain ?? 'sma.consequences',
    at: opts.now ?? new Date().toISOString(),
  }
  return appendVerdict(record, { calibrationDir: opts.calibrationDir })
}

/**
 * openRollbackCandidate({slug, sha, execGit}) -> {created, ...}.
 *
 * Create-only rollback candidate: validate sha is 40-hex FIRST (a non-hex sha
 * short-circuits with the spy NEVER called), sanitize the slug, then issue
 * `update-ref <ref> <sha> <40-zeros>` — the 40-zeros oldvalue makes it CREATE
 * ONLY (git refuses if the ref already exists). No checkout, no reset, no delete,
 * ever (airbag D-49.2-08: milliseconds, working tree untouched). Never throws —
 * an execGit failure (ref exists / git unavailable) returns {created:false}.
 *
 * @param {{slug:string, sha:string, execGit:Function}} args
 * @returns {{created:boolean, ref?:string, sha?:string, existed?:boolean, reason?:string}}
 */
export function openRollbackCandidate({ slug, sha, execGit }) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    return { created: false, reason: 'sha is not a 40-hex commit id' }
  }
  const safeSlug = String(slug ?? '').replace(/[^\w.-]/g, '_') || 'candidate'
  const ref = `refs/heads/sma/rollback-candidate/${safeSlug}`
  try {
    execGit(['update-ref', ref, sha, '0'.repeat(40)])
    return { created: true, ref, sha }
  } catch (err) {
    return { created: false, existed: true, ref, reason: String((err && err.message) ?? err) }
  }
}
