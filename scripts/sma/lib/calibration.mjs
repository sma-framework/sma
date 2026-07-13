/**
 * calibration.mjs — per-domain prediction-calibration ledger (49.1-08, B20).
 *
 * Answers "in which areas are our plans historically wrong" with DATA:
 * every predict-score verdict is appended to .sma/calibration/<domain>.jsonl,
 * and hitRate/escalations() compute per-domain hit-rates + the
 * low-calibration domain list for auto-escalation (stricter gates / founder
 * review surface via 49.1-18's digest and 49.1-24's report — this module
 * only COMPUTES, it never gates).
 *
 * Structure mirrors journal.mjs EXACTLY (PATTERNS analog): one append-only
 * JSONL file per key (here: domain, there: terminal), appendFileSync single-
 * line appends, tolerant skip-and-count line reader (fail-open C9), missing
 * dir -> honest empty report. Ledger integrity is accepted-risk T-49.1-15:
 * the dir lives in gitignored .sma/; the committed rollup lands with
 * 49.1-24's report.
 *
 * Node built-ins only; the ledger dir is dependency-injectable via
 * opts.calibrationDir (default CALIBRATION_DIR from constants.mjs — never
 * hardcoded here).
 */

import { appendFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { CALIBRATION_DIR } from './constants.mjs'
import { resolveModelId } from './model-version.mjs'

/**
 * The GROUND-TRUTH evidence vocabulary the grade-the-grader pipeline CONSUMES
 * (49.4-02). A grader's verdict is a PREDICTION; deterministic ground truth
 * settles it. Evidence records have the shape { type, planId, at } and are
 * produced by EXISTING mechanisms — never fabricated here (this module only
 * reads them):
 *   - NEGATIVE (the work turned out bad): revert (consequences.openRollbackCandidate),
 *     rework, red-ci (a CI-terminal producer), founder-rejection (the disposition door).
 *   - POSITIVE (the work turned out fine): founder-acceptance, ci-green, clean.
 * A `satisfied` verdict is CONTRADICTED by NEGATIVE evidence within its horizon;
 * an `unsatisfied` verdict is CONTRADICTED by POSITIVE evidence within its
 * horizon (the grader is graded in BOTH directions). Contradiction ALWAYS
 * requires explicit opposite-polarity evidence — mere absence never contradicts.
 */
export const NEGATIVE_EVIDENCE_TYPES = Object.freeze(['revert', 'rework', 'red-ci', 'founder-rejection'])
export const POSITIVE_EVIDENCE_TYPES = Object.freeze(['founder-acceptance', 'ci-green', 'clean'])
export const GROUND_TRUTH_EVIDENCE_TYPES = Object.freeze([...NEGATIVE_EVIDENCE_TYPES, ...POSITIVE_EVIDENCE_TYPES])

/** The domain every separate-context grader verdict is scored under (frozen class-A). */
const GRADER_DOMAIN = 'sma.verification'

function resolveCalibrationDir(opts = {}) {
  return opts.calibrationDir ?? CALIBRATION_DIR
}

/** Domain -> ledger filename (dots kept; path-hostile chars normalized). */
function domainFileName(domain) {
  return `${String(domain ?? 'unknown').replace(/[^\w.-]+/g, '_')}.jsonl`
}

/** Read + parse one domain's .jsonl, skipping corrupt lines (journal.mjs posture). */
function parseFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { records: [], corrupt: 0 }
  }
  const records = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1 // fail-open — skip-and-count, never throw (C9)
    }
  }
  return { records, corrupt }
}

/**
 * appendVerdict(record, opts) — append ONE JSON line to <domain>.jsonl.
 * Append-only by construction (appendFileSync); an existing line is never
 * rewritten.
 *
 * @param {{domain?:string}} record — a scorePlan verdict record
 * @param {{calibrationDir?:string}} [opts]
 * @returns {object} the written record
 */
export function appendVerdict(record, opts = {}) {
  const dir = resolveCalibrationDir(opts)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, domainFileName(record && record.domain))
  appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

/**
 * readLedger(opts) -> {records, corrupt}. Reads one domain's file when
 * opts.domain is given, otherwise every *.jsonl in the ledger dir. Missing
 * dir/file -> honest empty result, never a throw.
 *
 * @param {{calibrationDir?:string, domain?:string}} [opts]
 * @returns {{records: object[], corrupt: number}}
 */
export function readLedger(opts = {}) {
  const dir = resolveCalibrationDir(opts)

  if (opts.domain) {
    return parseFile(join(dir, domainFileName(opts.domain)))
  }

  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { records: [], corrupt: 0 } // missing dir -> empty ledger
  }

  let records = []
  let corrupt = 0
  for (const f of files) {
    const parsed = parseFile(join(dir, f))
    records = records.concat(parsed.records)
    corrupt += parsed.corrupt
  }
  return { records, corrupt }
}

/**
 * hitRate(records) -> {rate, n, hits, misses, skipped, errors}.
 *
 * Only 'hit'/'miss' verdicts count toward n — a skipped-unsafe or error
 * record is not evidence about the CLAIM, only about the check. Empty input
 * -> rate null (honest empty, not a fake 0).
 *
 * @param {object[]} records
 */
export function hitRate(records) {
  let hits = 0
  let misses = 0
  let skipped = 0
  let errors = 0
  for (const r of records ?? []) {
    if (r.verdict === 'hit') hits += 1
    else if (r.verdict === 'miss') misses += 1
    else if (r.verdict === 'skipped-unsafe') skipped += 1
    else if (r.verdict === 'error') errors += 1
  }
  const n = hits + misses
  return { rate: n ? hits / n : null, n, hits, misses, skipped, errors }
}

/**
 * escalations({threshold=0.6, minN=5, calibrationDir}) -> low-calibration
 * domain list [{domain, rate, n, hits, misses}], sorted worst-first.
 *
 * A domain is flagged when hitRate < threshold AND n >= minN — a domain with
 * fewer than minN scored predictions is NEVER flagged (insufficient data).
 * This is the consumer contract for auto-escalation (B20): the caller
 * decides what stricter gates mean; this module only computes.
 *
 * @param {{threshold?:number, minN?:number, calibrationDir?:string}} [opts]
 * @returns {Array<{domain:string, rate:number, n:number, hits:number, misses:number}>}
 */
export function escalations(opts = {}) {
  const threshold = opts.threshold ?? 0.6
  const minN = opts.minN ?? 5

  const { records } = readLedger(opts)
  const byDomain = new Map()
  for (const r of records) {
    const d = r.domain ?? 'unknown'
    if (!byDomain.has(d)) byDomain.set(d, [])
    byDomain.get(d).push(r)
  }

  const flagged = []
  for (const [domain, recs] of byDomain) {
    const { rate, n, hits, misses } = hitRate(recs)
    if (rate != null && n >= minN && rate < threshold) {
      flagged.push({ domain, rate, n, hits, misses })
    }
  }
  flagged.sort((a, b) => a.rate - b.rate)
  return flagged
}

// ── Grade the grader (49.4-02) ────────────────────────────────────────────────
//
// Any separate-context LLM verdict — the blind verifier's, or a vendor
// outcomes-style grader's if ever consumed — is recorded as a PREDICTION here
// and scored later against deterministic ground truth. The vendor can verify; it
// cannot be audited. Recording/scoring/slicing are pure/DI, zero LLM, zero
// network (substrate law): the LLM verdicts being graded arrive as INPUT
// records, never as calls this code makes.

/**
 * recordGraderVerdict({planId, verdict, judgeModelId, source, horizon}, opts) ->
 * the written record. Appends a kind:'grader-verdict' record to the
 * sma.verification ledger via the EXISTING appendVerdict. A missing judgeModelId
 * falls back to resolveModelId({env}) and the record notes stampedBy:'resolved'
 * (explicit id -> 'explicit'; nothing resolvable -> null id + 'unstamped', which
 * hitRateByJudge surfaces in its own bucket, never silently merged).
 *
 * The record's `verdict` is 'satisfied'|'unsatisfied' (a grader vocabulary,
 * NOT the hit/miss/divergence one) so hitRate/classifyEvent ignore the raw
 * verdict by construction — only a SCORED grader-contradiction becomes a
 * class-A event (consequences.graderContradictionEvent), never the bare record.
 *
 * @param {{planId:string, verdict:'satisfied'|'unsatisfied', judgeModelId?:string,
 *          source?:string, horizon?:string}} args
 * @param {{calibrationDir?:string, env?:object, now?:string}} [opts]
 * @returns {object} the written grader-verdict record
 */
export function recordGraderVerdict({ planId, verdict, judgeModelId, source, horizon } = {}, opts = {}) {
  let judge = typeof judgeModelId === 'string' && judgeModelId.trim() ? judgeModelId.trim() : null
  let stampedBy = judge ? 'explicit' : 'unstamped'
  if (!judge) {
    const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {})
    const resolved = resolveModelId({ env })
    if (resolved && resolved.model) {
      judge = resolved.model
      stampedBy = 'resolved'
    }
  }
  const record = {
    kind: 'grader-verdict',
    domain: GRADER_DOMAIN,
    id: planId ?? null,
    planId: planId ?? null,
    verdict: verdict ?? null,
    judgeModelId: judge,
    stampedBy,
    source: source ?? null,
    horizon: horizon ?? null,
    at: opts.now ?? new Date().toISOString(),
  }
  return appendVerdict(record, { calibrationDir: opts.calibrationDir })
}

/**
 * scoreGraderVerdicts({records, evidence, now}) -> the grader-verdict records
 * each augmented with an `outcome` ∈ 'contradicted'|'stood'|'unsettled' (PURE —
 * no fs, no git; evidence arrival is the caller's job, substrate law).
 *
 * For each kind:'grader-verdict' record, matched to evidence by planId:
 *   - CONTRADICTED: explicit OPPOSITE-polarity evidence within the horizon
 *     (satisfied ← negative evidence; unsatisfied ← positive evidence). Carries
 *     `contradictedBy` = the settling evidence record.
 *   - STOOD: horizon passed with no contradicting evidence (evidence that arrived
 *     AFTER the horizon does not settle it — it stood).
 *   - UNSETTLED: horizon not yet passed and no contradicting evidence — visible,
 *     never counted as a hit (an unscored verdict is never a default 'satisfied').
 *
 * @param {{records:object[], evidence?:object[], now?:string}} args
 * @returns {object[]} scored grader-verdict records
 */
export function scoreGraderVerdicts({ records, evidence = [], now } = {}) {
  const evList = Array.isArray(evidence) ? evidence : []
  const out = []
  for (const g of records ?? []) {
    if (!g || g.kind !== 'grader-verdict') continue
    const horizon = g.horizon
    const oppositeTypes = g.verdict === 'satisfied' ? NEGATIVE_EVIDENCE_TYPES : POSITIVE_EVIDENCE_TYPES
    const withinHorizon = (e) =>
      e && e.at != null && horizon != null && String(e.at) <= String(horizon)
    const contradicting = evList.filter(
      (e) => e && e.planId === g.planId && oppositeTypes.includes(e.type) && withinHorizon(e),
    )
    const horizonPassed = now != null && horizon != null && String(now) > String(horizon)

    let outcome
    let contradictedBy
    if (contradicting.length) {
      outcome = 'contradicted'
      contradictedBy = contradicting[0]
    } else if (horizonPassed) {
      outcome = 'stood'
    } else {
      outcome = 'unsettled'
    }
    out.push({ ...g, outcome, ...(contradictedBy ? { contradictedBy } : {}) })
  }
  return out
}

/**
 * hitRateByJudge(records) -> { [judgeModelId]: {hits, misses, rate} }. Slices the
 * grader track record BY WHO JUDGED — a grader change is visible the same way an
 * actor-model change already is. Over SCORED grader records only:
 *   - a verdict that STOOD is a HIT (the judge was right),
 *   - a verdict that was CONTRADICTED is a MISS (the judge was wrong),
 *   - an UNSETTLED verdict counts as neither.
 * Records without a judgeModelId land in an explicit 'unstamped' bucket — never
 * silently merged into another judge's rate (T-49.4-02-A: missing identity is
 * VISIBLE).
 *
 * @param {object[]} records  scored grader-verdict records (from scoreGraderVerdicts)
 * @returns {Object<string,{hits:number, misses:number, rate:(number|null)}>}
 */
export function hitRateByJudge(records) {
  const byJudge = new Map()
  for (const r of records ?? []) {
    if (!r || r.kind !== 'grader-verdict') continue
    if (r.outcome !== 'stood' && r.outcome !== 'contradicted') continue
    const judge = typeof r.judgeModelId === 'string' && r.judgeModelId.trim() ? r.judgeModelId : 'unstamped'
    if (!byJudge.has(judge)) byJudge.set(judge, { hits: 0, misses: 0 })
    const b = byJudge.get(judge)
    if (r.outcome === 'stood') b.hits += 1
    else b.misses += 1
  }
  const out = {}
  for (const [judge, b] of byJudge) {
    const n = b.hits + b.misses
    out[judge] = { hits: b.hits, misses: b.misses, rate: n ? b.hits / n : null }
  }
  return out
}
