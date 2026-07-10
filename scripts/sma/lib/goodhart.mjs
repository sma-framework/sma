/**
 * goodhart.mjs — the Goodhart integrity guards (9.2-10, D-9.2-14).
 *
 * The moment trust numbers are published, the incentive to game them exists.
 * This module is the anti-gaming layer for the receipts/predictions spine:
 *
 *   1. SKEPTIC COUNTERSIGN — a plan's `predictions:` block is countersigned by a
 *      SKEPTIC identity distinct from the implementer. The countersign hashes the
 *      EXACT predictions block via lint.mjs's ONE extractor (extractPredictionsBlock),
 *      so any post-sign edit voids it (mirrors PRED-POSTEDIT immutability). A
 *      countersign whose terminalId equals the implementer's (from the plan's exec
 *      journal) is a self-sign — rejected.
 *
 *   2. SEEDED 5% DEEP RECEIPT AUDIT — a random ~5% sample of receipts is re-run
 *      through plan 03's OWN machinery (receipts.verifyReceipt), seeded by the
 *      release-tip commit sha. The seed is unknowable at receipt-authoring time,
 *      so the author structurally cannot steer which receipts get audited
 *      (Goodhart mitigation). Verdicts land in the V2 calibration ledger under a
 *      SEPARATE domain 'sma.receipts-audit' — never sma.receipts.
 *
 *   3. SCORING-IMMUNE NEAR-MISS CHANNEL (ASRS class) — recordNearMiss appends a
 *      free-text entry that carries NO metric field. No scoring path (calibration,
 *      bench, audit, digest) ever reads .sma/nearmiss/, so reporting a near-miss
 *      can never hurt a number — immunity is what makes reporting rational.
 *
 * Security boundary (T-9.2-30): the audit executes check_command strings sourced
 * from claims files. The audit reuses receipts.verifyReceipt, which enforces the
 * ONE isSafeCommand boundary (imported from predict.mjs) BEFORE any run — a
 * non-allowlisted command scores 'skipped-unsafe' with the runner never invoked.
 * There is NO second allowlist here.
 *
 * Node built-ins only; every path DI-injectable via `dirs`; fail-open throughout
 * (C9) — a signing/verify/audit error degrades to an honest verdict, never a throw.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'

import { SKEPTIC_DIR, NEARMISS_DIR, EXEC_DIR } from './constants.mjs'
import { extractPredictionsBlock } from './lint.mjs'
import { isSafeCommand } from './predict.mjs'
import { verifyReceipt } from './receipts.mjs'
import { appendVerdict } from './calibration.mjs'
import { read as readExecJournal } from './exec-journal.mjs'
import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'

/** sha256 hex of a UTF-8 string. */
function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** '9.2-10-PLAN.md' -> '9.2-10' (the plan identity a countersign is keyed by). */
export function planIdFromPath(planPath) {
  return basename(String(planPath)).replace(/-PLAN\.md$/i, '').replace(/\.md$/i, '')
}

/** '9.2-10' -> {phase:'9.2', plan:'10'} (the exec-journal file key). */
function splitPlanId(planId) {
  const s = String(planId)
  const i = s.lastIndexOf('-')
  if (i < 0) return { phase: s, plan: '' }
  return { phase: s.slice(0, i), plan: s.slice(i + 1) }
}

function resolveSkepticDir(dirs = {}) {
  return dirs.skepticDir ?? SKEPTIC_DIR
}
function resolveNearmissDir(dirs = {}) {
  return dirs.nearmissDir ?? NEARMISS_DIR
}
function resolveExecDir(dirs = {}) {
  return dirs.execDir ?? EXEC_DIR
}

/** Read plan text (injected readFn wins so tests never touch disk). */
function readPlanText(planPath, readFn) {
  const fn = readFn ?? readFileSync
  return fn(planPath, 'utf8')
}

/**
 * The implementer terminalId for a plan, read from its exec journal. Any event
 * carrying a truthy `terminalId` (or legacy `terminal`) names the implementer.
 * No journal / no such field -> null (self-sign check defers, fail-open).
 */
function implementerTerminalId(planId, dirs) {
  try {
    const { phase, plan } = splitPlanId(planId)
    const { events } = readExecJournal({ phase, plan, execDir: resolveExecDir(dirs) })
    for (const e of events ?? []) {
      const t = e && (e.terminalId ?? e.terminal)
      if (t) return String(t)
    }
  } catch {
    /* fail-open */
  }
  return null
}

/**
 * signPredictions({planPath, identity, dirs, readFn, now}) -> the countersign
 * record. Writes .sma/skeptic/<planId>.json {planId, predictionsHash, skeptic:
 * {terminalId, holderIdentity}, signedAt}. predictionsHash = sha256 of the plan's
 * EXACT predictions block (lint.mjs extractor — never re-derived).
 *
 * @param {{planPath:string, identity:{terminalId?:string, holderIdentity?:string}, dirs?:object, readFn?:Function, now?:string}} args
 * @returns {object} the written countersign record
 */
export function signPredictions({ planPath, identity = {}, dirs = {}, readFn, now } = {}) {
  const planId = planIdFromPath(planPath)
  const text = readPlanText(planPath, readFn)
  const record = {
    planId,
    predictionsHash: sha256(extractPredictionsBlock(text)),
    skeptic: {
      terminalId: identity.terminalId ?? null,
      holderIdentity: identity.holderIdentity ?? null,
    },
    signedAt: now ?? new Date().toISOString(),
  }
  atomicWriteJson(join(resolveSkepticDir(dirs), `${planId}.json`), record)
  return record
}

/**
 * verifySkeptic({planPath, dirs, readFn}) -> a verdict object.
 *   {ok:true}                          — a valid, distinct countersign of the
 *                                        current predictions block
 *   {ok:true, deferred:true}           — countersign valid, but no exec journal
 *                                        exists yet to prove distinctness (fail-open;
 *                                        re-checked at score time)
 *   {ok:false, reason:'unsigned'}      — no countersign file at all
 *   {ok:false, reason:'hash-mismatch'} — the predictions block changed after signing
 *   {ok:false, reason:'self-sign'}     — the countersign terminalId equals the
 *                                        implementer's (from the exec journal)
 * Never throws.
 *
 * @param {{planPath:string, dirs?:object, readFn?:Function}} args
 */
export function verifySkeptic({ planPath, dirs = {}, readFn } = {}) {
  try {
    const planId = planIdFromPath(planPath)
    const sig = readJsonSafe(join(resolveSkepticDir(dirs), `${planId}.json`))
    if (!sig) return { ok: false, reason: 'unsigned' }

    const text = readPlanText(planPath, readFn)
    if (sha256(extractPredictionsBlock(text)) !== sig.predictionsHash) {
      return { ok: false, reason: 'hash-mismatch' }
    }

    const impl = implementerTerminalId(planId, dirs)
    if (impl == null) return { ok: true, deferred: true } // no journal -> defer distinctness
    const skepticTid = sig.skeptic && sig.skeptic.terminalId
    if (skepticTid != null && String(skepticTid) === impl) {
      return { ok: false, reason: 'self-sign' }
    }
    return { ok: true }
  } catch {
    // fail-open: an unreadable countersign never blocks (advisory guard)
    return { ok: true, deferred: true }
  }
}

/**
 * sampleReceipts({receipts, seedSha, rate, floor}) -> the audited subset. PURE:
 * sort by sha256(seedSha + ':' + id) hex and take max(floor, ceil(rate*n)). The
 * seedSha (the release-tip sha, unknowable at authoring time) makes the sample
 * unsteerable; floor guarantees coverage on tiny sets. Same seed -> same sample.
 *
 * @param {{receipts:object[], seedSha:string, rate?:number, floor?:number}} args
 * @returns {object[]}
 */
export function sampleReceipts({ receipts = [], seedSha = '', rate = 0.05, floor = 1 } = {}) {
  const list = Array.isArray(receipts) ? receipts.slice() : []
  const n = list.length
  if (n === 0) return []
  const want = Math.min(n, Math.max(floor, Math.ceil(rate * n)))
  const keyed = list.map((r) => ({ r, k: sha256(`${seedSha}:${r && r.id}`) }))
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
  return keyed.slice(0, want).map((x) => x.r)
}

/**
 * auditReceipts({receipts, seedSha, runCommand, dirs, rate, floor, now}) ->
 * {sampled, records}. Re-runs the SAMPLED receipts through plan 03's OWN
 * verifyReceipt (the same isSafeCommand boundary, verbatim), maps the receipt
 * verdict into a calibration verdict (verified->hit, divergent->miss, others
 * pass through), and appends each under domain 'sma.receipts-audit'. Never throws;
 * NEVER reads .sma/nearmiss/.
 *
 * @param {{receipts:object[], seedSha:string, runCommand:Function, dirs?:object, rate?:number, floor?:number, now?:string}} args
 */
export function auditReceipts({ receipts = [], seedSha = '', runCommand, dirs = {}, rate = 0.05, floor = 1, now } = {}) {
  const sampled = sampleReceipts({ receipts, seedSha, rate, floor })
  const records = []
  for (const entry of sampled) {
    let r
    // Defense-in-depth on the SAME boundary (the imported isSafeCommand — there is
    // NO second allowlist): score skipped-unsafe here BEFORE delegating, so the
    // runner is provably never invoked for a non-allowlisted command even if the
    // downstream verifier's posture ever changed. Safe commands audit THROUGH plan
    // 03's own verifyReceipt (same isSafeCommand gate, verbatim).
    if (!isSafeCommand(entry && entry.check_command)) {
      r = {
        id: entry && entry.id,
        coverage_id: (entry && entry.coverage_id) ?? null,
        assertion: entry && entry.assertion,
        check_command: entry && entry.check_command,
        expected_sha256: (entry && entry.expected_sha256) ?? null,
        observed_sha256: null,
        exitCode: null,
        scoredAt: now ?? new Date().toISOString(),
        verdict: 'skipped-unsafe',
      }
    } else {
      try {
        r = verifyReceipt(entry, { runCommand, now })
      } catch (err) {
        r = { id: entry && entry.id, verdict: 'error', error: String((err && err.message) ?? err) }
      }
    }
    const verdict = r.verdict === 'verified' ? 'hit' : r.verdict === 'divergent' ? 'miss' : r.verdict
    const record = {
      ...r,
      domain: 'sma.receipts-audit', // SEPARATE ledger domain — never sma.receipts
      verdict,
      receipt_verdict: r.verdict, // preserve the source verdict verbatim
      seedSha,
      auditedAt: r.scoredAt ?? now ?? new Date().toISOString(),
    }
    try {
      appendVerdict(record, { calibrationDir: dirs.calibrationDir })
    } catch {
      /* fail-open — a ledger write failure never aborts the audit */
    }
    records.push(record)
  }
  return { sampled, records }
}

/**
 * recordNearMiss({text, identity, dirs, now}) -> the appended record. One JSONL
 * line {at, terminalId, text} per near-miss in .sma/nearmiss/<yyyy-mm>.jsonl.
 * There is deliberately NO metric field on the record — there is nothing for a
 * scorer to read even by accident (ASRS immunity). Never throws.
 *
 * @param {{text:string, identity?:{terminalId?:string}, dirs?:object, now?:string}} args
 */
export function recordNearMiss({ text, identity = {}, dirs = {}, now } = {}) {
  const at = now ?? new Date().toISOString()
  const record = { at, terminalId: identity.terminalId ?? null, text: String(text ?? '') }
  try {
    const dir = resolveNearmissDir(dirs)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${at.slice(0, 7)}.jsonl`), JSON.stringify(record) + '\n')
  } catch {
    /* fail-open — a near-miss log failure never blocks work */
  }
  return record
}
