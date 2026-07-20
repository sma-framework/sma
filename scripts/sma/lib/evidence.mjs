/**
 * evidence.mjs — burden-of-proof evidence records for risky ops (9.2-07, D-9.2-11).
 *
 * A risky op — git force-push, an edit to the SAFE_COMMAND allowlist (predict.mjs), a
 * foreign-claim force-clear — must carry a burden-of-proof record in .sma/evidence/
 * naming the reason AND the verifications performed BEFORE it proceeds. The record
 * follows the force-clear-with-provenance shape (D-9-09, claims.mjs lineage):
 * append-only, actor+pid+ts stamped, NEVER overwritten and NEVER deleted (T-9.2-07C —
 * there is no unlink path in this module). The risky-op gates (gates.mjs) consult
 * hasFreshEvidence for their DORMANT soft-deny tier; the advisory WARN + the journaled
 * risky-op event are the default posture (hard-deny stays the security guard's alone).
 *
 * Node built-ins only; every dir is dependency-injected; zero LLM.
 */

import { readdirSync } from 'node:fs'

import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { readJournal } from './journal.mjs'

/** The closed set of ops that require a burden-of-proof record. */
export const RISKY_OPS = Object.freeze(['force-push', 'allowlist-edit', 'foreign-claim-clear'])

/** Default freshness TTL — a record older than this no longer satisfies a gate. 15 min. */
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000

/** op → filename-safe token. */
function safeOp(op) {
  return String(op ?? 'unknown').replace(/[^\w.-]+/g, '_')
}

/**
 * writeEvidence({op, target, reason, checks, actor}, {evidenceDir, now}) ->
 * {ok, id?, path?, record?} | {ok:false, missing}.
 *
 * Validates: op ∈ RISKY_OPS; reason a non-empty string; checks a NON-EMPTY array of
 * performed-verification strings (the burden of proof). Anything less returns
 * {ok:false, missing:[...]} and writes NOTHING. On success writes
 * .sma/evidence/<tsMs>-<op>.json via atomicWriteJson (append-only — never overwrites an
 * existing file by construction of the unique ts key; never deletes).
 *
 * @param {{op:string, target:string, reason:string, checks:string[], actor?:string}} args
 * @param {{evidenceDir:string, now?:number}} opts
 * @returns {{ok:boolean, id?:string, path?:string, record?:object, missing?:string[]}}
 */
export function writeEvidence({ op, target, reason, checks, actor } = {}, opts = {}) {
  const missing = []
  if (!RISKY_OPS.includes(op)) missing.push('op (must be one of force-push, allowlist-edit, foreign-claim-clear)')
  if (!reason || !String(reason).trim()) missing.push('reason')
  if (!Array.isArray(checks) || checks.length === 0 || !checks.every((c) => String(c ?? '').trim())) {
    missing.push('checks (non-empty array of performed-verification strings)')
  }
  if (missing.length) return { ok: false, missing }

  const ts = opts.now ?? Date.now()
  const id = `${ts}-${safeOp(op)}`
  const record = {
    op,
    target: target ?? '',
    reason: String(reason),
    checks: checks.map((c) => String(c)),
    actor: actor ?? 'unknown',
    pid: process.pid,
    ts, // epoch ms — the freshness key
    at: new Date(ts).toISOString(),
    id,
  }
  const path = join(opts.evidenceDir, `${id}.json`)
  atomicWriteJson(path, record) // append-only; never unlinked (T-9.2-07C)
  return { ok: true, id, path, record }
}

/**
 * hasFreshEvidence({op, target, maxAgeMs}, {evidenceDir, now}) -> boolean. True ONLY
 * for a record matching op AND target within the TTL. A stale record, a wrong-target
 * record, or a missing dir → false (never a throw).
 *
 * @param {{op:string, target?:string, maxAgeMs?:number}} args
 * @param {{evidenceDir:string, now?:number}} opts
 * @returns {boolean}
 */
export function hasFreshEvidence({ op, target, maxAgeMs } = {}, opts = {}) {
  const ttl = Number.isFinite(maxAgeMs) ? maxAgeMs : DEFAULT_MAX_AGE_MS
  const now = opts.now ?? Date.now()
  let files
  try {
    files = readdirSync(opts.evidenceDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
  } catch {
    return false // missing dir → no evidence, never throws
  }
  for (const f of files) {
    const rec = readJsonSafe(join(opts.evidenceDir, f))
    if (!rec || rec.op !== op) continue
    if (target != null && String(rec.target) !== String(target)) continue
    const tsMs = Number(rec.ts)
    if (!Number.isFinite(tsMs)) continue
    if (now - tsMs <= ttl) return true
  }
  return false
}

/**
 * evidenceStats({evidenceDir, journalDir}) -> {coverage, riskyOps, covered}. Coverage =
 * pct of journal events type 'risky-op' that reference an evidenceId. No risky-op events
 * → 100 (coverage of an empty set is honestly full). coverage is an integer (the
 * P9.2-07-C numeric-last-line contract). Never throws.
 *
 * @param {{evidenceDir?:string, journalDir:string}} opts
 * @returns {{coverage:number, riskyOps:number, covered:number}}
 */
export function evidenceStats(opts = {}) {
  let events = []
  try {
    events = readJournal({ journalDir: opts.journalDir }).events
  } catch {
    events = []
  }
  const riskyEvents = events.filter((e) => e && e.type === 'risky-op')
  if (!riskyEvents.length) return { coverage: 100, riskyOps: 0, covered: 0 }
  const covered = riskyEvents.filter((e) => (e.detail && e.detail.evidenceId) != null).length
  return { coverage: Math.round((covered / riskyEvents.length) * 100), riskyOps: riskyEvents.length, covered }
}
