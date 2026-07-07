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
