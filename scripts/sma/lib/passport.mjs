/**
 * passport.mjs — the calibration passport: a deterministic, reproducible
 * function of COMMITTED data that writes PASSPORT.md + a public README badge
 * (49.3-02, D-49.3-10).
 *
 * The moment we publish a trust number we acquire the incentive to fake it
 * (T-49.3-01). This module makes the honest path the ONLY path:
 *
 *   - The badge is a PURE FUNCTION of the committed PASSPORT.md snapshot
 *     (parseSnapshot -> renderBadgeBlock), NEVER the live gitignored ledger —
 *     so the two cannot silently disagree.
 *   - renderPassport is byte-deterministic (canonicalJson: recursive key sort,
 *     2-space indent, LF), so a stranger re-derives it byte-identically on a
 *     fresh clone (`sma passport --verify`).
 *   - A Claude model change (model-version.modelGuard) HIDES the hit-rate claim
 *     until BADGE_MIN_N fresh hit/miss verdicts accrue under the new model —
 *     one bar for both bootstrap and post-model-change (a «100% hits, n=3»
 *     badge is its own kind of lie).
 *
 * This is a READER over the Track A artifacts — the V2 calibration ledger
 * (calibration.mjs, 49.1-08), the reverify receipt verdicts (49.2-03), the
 * journal chainTip (49.2-03) — and re-implements NONE of them (D-49.3-02). The
 * prediction-calibration claim EXCLUDES sma.receipts (which get their own
 * PASSPORT.md section); inflating the badge n with receipt hits is exactly the
 * statistical dishonesty this plan guards against.
 *
 * Node built-ins only; pure functions over injected data — only writeManagedBlock
 * and the snapshot's ledger reads touch fs, both DI. No LLM, no network: the
 * shields.io badge URL is a text string the VIEWER's browser resolves; the build
 * itself never fetches.
 */

import { readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'

import { readLedger, hitRate } from './calibration.mjs'
import { chainTip as journalChainTip } from './journal.mjs'
import { readModelTimeline, modelGuard } from './model-version.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'

/**
 * BADGE_MIN_N — the single honesty bar. The badge shows NO hit-rate claim until
 * this many FRESH hit/miss verdicts exist under the current model, for BOTH the
 * bootstrap (thin ledger) and post-model-change cases. Read by modelGuard's
 * minFresh AND renderBadgeBlock's gate — one number, one policy.
 */
export const BADGE_MIN_N = 20

const RECEIPTS_DOMAIN = 'sma.receipts'
const SNAPSHOT_FENCE = 'sma-passport-snapshot'
const BADGE_BEGIN = '<!-- sma:passport:begin -->'
const BADGE_END = '<!-- sma:passport:end -->'
const PROVENANCE =
  '<sub>derived from PASSPORT.md, rebuilt each release, reproducible via <code>sma passport --verify</code></sub>'

function resolveNow(now) {
  if (typeof now === 'function') return now()
  if (typeof now === 'string' && now) return now
  return new Date().toISOString()
}

function pctOrDash(rate) {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`
}

/** Recursive key-sort (arrays keep order) so JSON is order-independent. */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k])
    return out
  }
  return v
}

/**
 * canonicalJson(obj) — deterministic JSON: recursive key sort, 2-space indent,
 * LF newlines. Two objects with the same content but different key order
 * serialize byte-identically.
 */
export function canonicalJson(obj) {
  return JSON.stringify(sortDeep(obj), null, 2).replace(/\r\n/g, '\n')
}

/** Group records by a key fn -> sorted [{key, rate, n, hits, misses}]. */
function groupRates(records, keyFn) {
  const map = new Map()
  for (const r of records) {
    const k = keyFn(r)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  const rows = []
  for (const [key, recs] of map) {
    const hr = hitRate(recs)
    rows.push({ key, rate: hr.rate, n: hr.n, hits: hr.hits, misses: hr.misses })
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return rows
}

/** Count receipt_verdict values in the sma.receipts records. */
function countReceipts(receiptRecords) {
  let verified = 0
  let divergent = 0
  let skippedUnsafe = 0
  let errors = 0
  for (const r of receiptRecords) {
    const v = r.receipt_verdict
    if (v === 'verified') verified += 1
    else if (v === 'divergent') divergent += 1
    else if (v === 'skipped-unsafe') skippedUnsafe += 1
    else if (v === 'error') errors += 1
  }
  return { verified, divergent, skippedUnsafe, errors, n: receiptRecords.length }
}

/**
 * buildSnapshot({dirs, chainTipFn, now}) -> the machine snapshot the passport
 * and badge are pure functions of. Reads the calibration ledger + the model
 * timeline; the guard is fed PREDICTION-domain records only (sma.receipts
 * excluded). chainTip is embedded verbatim from the injected fn (defaults to
 * journal.chainTip over dirs.journalDir); capturedAt from the injected now.
 *
 * @param {{dirs:object, chainTipFn?:Function, now?:*, fs?:object}} args
 */
export function buildSnapshot({ dirs = {}, chainTipFn, now, fs } = {}) {
  const { records, corrupt } = readLedger({ calibrationDir: dirs.calibrationDir })
  const predictionRecords = records.filter((r) => (r.domain ?? 'unknown') !== RECEIPTS_DOMAIN)
  const receiptRecords = records.filter((r) => (r.domain ?? 'unknown') === RECEIPTS_DOMAIN)

  const timeline = readModelTimeline({ modelDir: dirs.modelDir, fs })
  const guard = modelGuard({ records: predictionRecords, timeline, minFresh: BADGE_MIN_N })

  const sightings = timeline.sightings || []
  const last = sightings[sightings.length - 1] || null
  const model = {
    id: last ? last.model ?? null : null,
    since: guard.lastChangeAt ?? (sightings[0] ? sightings[0].at ?? null : null),
    source: last ? last.source ?? null : null,
  }

  const domainRows = groupRates(predictionRecords, (r) => r.domain ?? 'unknown').map((r) => ({
    domain: r.key,
    rate: r.rate,
    n: r.n,
    hits: r.hits,
    misses: r.misses,
  }))
  const perModel = groupRates(predictionRecords, (r) => (r.model == null ? 'legacy' : r.model)).map((r) => ({
    model: r.key,
    rate: r.rate,
    n: r.n,
    hits: r.hits,
    misses: r.misses,
  }))
  const totals = hitRate(predictionRecords)

  const tip = typeof chainTipFn === 'function' ? chainTipFn() : journalChainTip({ journalDir: dirs.journalDir })

  return {
    schema: 1,
    capturedAt: resolveNow(now),
    model,
    guard: {
      status: guard.status,
      freshN: guard.freshN,
      freshRate: guard.freshRate,
      requiredN: guard.requiredN,
      lastChangeAt: guard.lastChangeAt,
    },
    calibration: {
      domains: domainRows,
      totals: { hits: totals.hits, misses: totals.misses, n: totals.n, rate: totals.rate },
      perModel,
    },
    receipts: countReceipts(receiptRecords),
    chainTip: tip,
    ledger: { lines: records.length, corrupt },
  }
}

/** Normalize a chainTip (string | {tip}) to its tip string. */
function tipStr(chainTip) {
  if (typeof chainTip === 'string') return chainTip
  if (chainTip && typeof chainTip.tip === 'string') return chainTip.tip
  return 'empty'
}

/**
 * renderPassport(snapshot) -> deterministic English markdown. Sections in order:
 * header, badge-state line, calibration table, per-model breakdown, receipts
 * section, chain anchor, honesty paragraph, then the fenced snapshot block LAST.
 * No multiplier claims anywhere.
 */
export function renderPassport(snapshot) {
  const g = snapshot.guard || {}
  const cal = snapshot.calibration || {}
  const totals = cal.totals || {}
  const rec = snapshot.receipts || {}
  const L = []

  L.push('# SMA Calibration Passport')
  L.push('')
  L.push(
    'This is the public trust-telemetry surface of SMA. It is a deterministic function of committed data: a stranger can re-derive it byte-for-byte on a fresh clone with `sma passport --verify`.',
  )
  L.push('')

  // Badge-state line.
  L.push(`**Badge state:** ${badgeStateLine(snapshot)}`)
  L.push('')

  // Calibration table (per prediction domain).
  L.push('## Prediction calibration (all-time)')
  L.push('')
  L.push('| Domain | Hit-rate | n |')
  L.push('| --- | --- | --- |')
  for (const d of cal.domains || []) {
    L.push(`| ${d.domain} | ${pctOrDash(d.rate)} | ${d.n} |`)
  }
  L.push(`| **Total** | **${pctOrDash(totals.rate)}** | **${totals.n ?? 0}** |`)
  L.push('')
  L.push('_sma.receipts verdicts are excluded from this table and the badge — they have their own section below._')
  L.push('')

  // Per-model breakdown.
  L.push('## Per-model breakdown')
  L.push('')
  L.push('| Model | Hit-rate | n |')
  L.push('| --- | --- | --- |')
  for (const m of cal.perModel || []) {
    L.push(`| ${m.model} | ${pctOrDash(m.rate)} | ${m.n} |`)
  }
  L.push('')
  L.push(
    `Current model: \`${snapshot.model && snapshot.model.id ? snapshot.model.id : 'none recorded'}\` (source: ${snapshot.model && snapshot.model.source ? snapshot.model.source : '—'}). The badge headlines ONLY the current model's fresh window (n=${g.freshN ?? 0}); stale priors never headline.`,
  )
  L.push('')

  // Receipts-reproduced section.
  L.push('## Structural receipts reproduced')
  L.push('')
  L.push(`${rec.verified ?? 0}/${rec.n ?? 0} verified, ${rec.divergent ?? 0} divergent, ${rec.skippedUnsafe ?? 0} skipped-unsafe, ${rec.errors ?? 0} errors.`)
  L.push('')

  // Chain anchor.
  L.push('## Chain anchor')
  L.push('')
  L.push(`Journal chain tip: \`${tipStr(snapshot.chainTip)}\`.`)
  L.push('This tip is pinned into each release tag as `SMA-Journal-Tip`, anchoring this snapshot to the same tamper-evidence line the release pins.')
  L.push('')

  // Honesty paragraph.
  L.push('## What `--verify` proves (and what it does not)')
  L.push('')
  L.push(
    '`sma passport --verify` proves RENDER DETERMINISM: the rendered passport and badge re-derive byte-identically from the embedded snapshot on a fresh clone. It does NOT prove the underlying ledger is truthful — ledger truthfulness is owned upstream by the canary false-dones and the 5% deep audit (49.2-10). This passport reports the ledger line and corrupt counts (' +
      `${snapshot.ledger ? snapshot.ledger.lines : 0} lines, ${snapshot.ledger ? snapshot.ledger.corrupt : 0} corrupt) and says so plainly rather than overclaiming.`,
  )
  L.push('')
  L.push(`Captured at: ${snapshot.capturedAt}`)
  L.push('')

  // Fenced snapshot block LAST.
  L.push('```' + SNAPSHOT_FENCE)
  L.push(canonicalJson(snapshot))
  L.push('```')

  return L.join('\n') + '\n'
}

/** A one-line human description of the current badge state. */
function badgeStateLine(snapshot) {
  const g = snapshot.guard || {}
  if (g.status === 'no-model-data') return 'hidden — no Claude model recorded yet'
  if (g.status === 'stale-priors') return `recalibrating after model change (n=${g.freshN ?? 0}/${BADGE_MIN_N})`
  if ((g.freshN ?? 0) < BADGE_MIN_N) return `collecting calibration data (n=${g.freshN ?? 0}/${BADGE_MIN_N})`
  return `SMA-calibrated: ${Math.round((g.freshRate ?? 0) * 100)}% hits, n=${g.freshN}`
}

/**
 * parseSnapshot(passportText) -> the embedded snapshot object, or null (never
 * throws) when the fenced block is absent/corrupt.
 */
export function parseSnapshot(passportText) {
  const src = String(passportText ?? '').replace(/\r\n/g, '\n')
  const re = new RegExp('```' + SNAPSHOT_FENCE + '\\n([\\s\\S]*?)\\n```')
  const m = re.exec(src)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

/**
 * renderBadgeBlock(snapshot) -> the INNER content of the README managed block
 * (writeManagedBlock wraps it with the markers). Four states:
 *   - guard ok AND freshN >= BADGE_MIN_N -> a shields.io badge claiming
 *     «SMA-calibrated: NN% hits, n=N» linked to PASSPORT.md;
 *   - 'stale-priors' -> a «recalibrating after model change» notice, NO claim;
 *   - ok but freshN < BADGE_MIN_N -> a «collecting calibration data» notice;
 *   - 'no-model-data' -> hidden with its reason.
 * The percent claim is structurally unreachable on the hidden paths.
 */
export function renderBadgeBlock(snapshot) {
  const g = (snapshot && snapshot.guard) || {}
  let body
  if (g.status === 'stale-priors') {
    body = `**SMA calibration:** recalibrating after model change (n=${g.freshN ?? 0}/${BADGE_MIN_N}) — hit-rate claim hidden until fresh priors accrue.`
  } else if (g.status === 'no-model-data') {
    body = '**SMA calibration:** badge hidden — no Claude model recorded yet.'
  } else if ((g.freshN ?? 0) < BADGE_MIN_N) {
    body = `**SMA calibration:** collecting calibration data (n=${g.freshN ?? 0}/${BADGE_MIN_N}) — hit-rate claim hidden until the bar is reached.`
  } else {
    const pct = Math.round((g.freshRate ?? 0) * 100)
    const label = `SMA-calibrated: ${pct}% hits, n=${g.freshN}`
    const message = encodeURIComponent(`${pct}% hits, n=${g.freshN}`).replace(/-/g, '--')
    const url = `https://img.shields.io/badge/SMA--calibrated-${message}-brightgreen`
    body = `[![${label}](${url})](PASSPORT.md)`
  }
  return `${body}\n\n${PROVENANCE}`
}

/**
 * spliceManagedBlock(existing, content, beginMarker, endMarker) -> new text.
 * Replaces ONLY the span between the markers (bytes before/after untouched);
 * when the markers are absent the block is appended at EOF with one blank-line
 * separator. Idempotent: same content -> byte-identical output.
 */
export function spliceManagedBlock(existing, content, beginMarker = BADGE_BEGIN, endMarker = BADGE_END) {
  const src = String(existing ?? '').replace(/\r\n/g, '\n')
  const block = `${beginMarker}\n${content}\n${endMarker}`
  const bi = src.indexOf(beginMarker)
  const ei = src.indexOf(endMarker)
  if (bi !== -1 && ei !== -1 && ei > bi) {
    return src.slice(0, bi) + block + src.slice(ei + endMarker.length)
  }
  if (!src.trim()) return block + '\n'
  const base = src.replace(/\n*$/, '\n') // exactly one trailing newline
  return base + '\n' + block + '\n'
}

/**
 * readManagedBlock(text, beginMarker, endMarker) -> the inner content between
 * the markers, or null. Used by `passport --check-badge` to compare the live
 * README block against renderBadgeBlock(committed snapshot).
 */
export function readManagedBlock(text, beginMarker = BADGE_BEGIN, endMarker = BADGE_END) {
  const src = String(text ?? '').replace(/\r\n/g, '\n')
  const bi = src.indexOf(beginMarker)
  const ei = src.indexOf(endMarker)
  if (bi === -1 || ei === -1 || ei <= bi) return null
  return src.slice(bi + beginMarker.length, ei).replace(/^\n/, '').replace(/\n$/, '')
}

/**
 * writeManagedBlock({filePath, content, beginMarker, endMarker}) — read the
 * file (fail-open to ''), splice the managed block, write atomically. Exported
 * for 49.3-04's emit reuse (the MEMORY.md/MEM-REGEN managed-artifact pattern).
 *
 * @param {{filePath:string, content:string, beginMarker?:string, endMarker?:string, fs?:object}} args
 * @returns {{filePath:string, bytes:number}}
 */
export function writeManagedBlock({ filePath, content, beginMarker = BADGE_BEGIN, endMarker = BADGE_END, fs } = {}) {
  const readFn = (fs && fs.readFileSync) || fsReadFileSync
  let existing = ''
  try {
    existing = readFn(filePath, 'utf8')
  } catch {
    existing = ''
  }
  const next = spliceManagedBlock(existing, content, beginMarker, endMarker)
  atomicWriteRaw(filePath, next, fs ? { writeFn: fs.writeFileSync, mkdirFn: fs.mkdirSync, renameFn: fs.renameSync } : {})
  return { filePath, bytes: Buffer.byteLength(next, 'utf8') }
}

/** The README badge markers, exported for the CLI's check-badge comparison. */
export const BADGE_MARKERS = { begin: BADGE_BEGIN, end: BADGE_END }
