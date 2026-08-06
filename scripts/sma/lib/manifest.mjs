/**
 * manifest.mjs — the PR EVIDENCE PASSPORT: a deterministic, reader-only
 * assembler over the Track A trust-spine outputs.
 *
 * WHAT IT IS: `sma manifest` deterministically packs the evidence a reviewer (or
 * a regulator) needs into ONE object + ONE markdown render — which predictions
 * were registered and how they scored, a receipt per claim, the blind-verify
 * verdict, token spend, per-area hit rate, plus the journal chainTip and the
 * 9.3-02 stale-priors guard state as the audit-trail footer.
 *
 * WHAT IT IS NOT — a SECOND GRADER. This module computes ZERO new verdicts. Every
 * number it emits is READ from a calibration-ledger record (predict-score
 * verdicts, sma.receipts records, kind:'divergence' events), a frozen
 * .sma/blind/<planId>.json file, or the spend book. Re-grading is exactly the
 * self-grading dishonesty V3 exists to kill — so it is structurally
 * impossible here: the public API takes NO command runner / no network seam at
 * all. The blind-verify barrier idiom, applied to assembly.
 *
 * DETERMINISM (substrate law): same tree + same .sma state + same injected `now`
 * -> byte-identical JSON and markdown. Every array is stable-sorted (plans by
 * planId, predictions/receipts by id, domains lexicographic); `generatedAt` is
 * the ONLY time-derived field and it is INJECTED. A nondeterministic audit trail
 * is a lying audit trail.
 *
 * FAIL-OPEN (C9): a missing input renders an honest 'absent'/'unscored'/'not-run'
 * section — never a fabricated zero, never a throw. A manifest failure must never
 * block a ship, fail a PR check, or wedge CI.
 *
 * NO NETWORK, NO EXEC, anywhere in this module. The gh comment/attach lives
 * exclusively in the sma-ship SKILL prose and the CI workflow YAML (files+git
 * substrate law). Node built-ins + sibling lib imports only; zero npm deps.
 */

import { join } from 'node:path'

import { readJsonSafe } from './fs-atomics.mjs'
import { parsePredictions } from './predict.mjs'
import { parseReceipts } from './receipts.mjs'
import { readLedger, hitRate } from './calibration.mjs'
import { openBlocks } from './consequences.mjs'
import { windowSpend } from './spend.mjs'

/** Bumped whenever the manifest object/markdown shape changes. */
export const MANIFEST_VERSION = 1

/**
 * The managed-comment upsert key AND the first line of every rendered markdown.
 * The CI terminal finds the existing PR comment by this exact marker and edits
 * it in place — ONE comment, never a comment per push.
 */
export const MANIFEST_MARKER = '<!-- sma-manifest:v1 -->'

/**
 * The line count of the --dense render: one line per passport section, ALWAYS.
 * An empty section prints an explicit marker instead of vanishing, so a reader
 * can tell "nothing to report" from "the section fell out of the build".
 */
export const MANIFEST_DENSE_LINES = 7

/** The explicit-pick keys of the spend aggregate block (P1 allowlist law). */
const SPEND_PICK = ['windowUsd', 'capUsd', 'pct', 'topModels', 'pricingVersion']

/** Cap on the topModels list in the spend block (world-readable — bounded). */
const TOP_MODELS_MAX = 5

/** Round a USD amount to 1e-6 (never carry float noise into the passport). */
function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6
}

/** Truncate a string to n chars, appending an ellipsis when cut. */
function truncate(s, n) {
  const str = String(s ?? '')
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…'
}

/** Short (12-char) form of a sha/tip, or a sentinel for empties. */
function short(sha) {
  const s = String(sha ?? '')
  if (!s || s === 'empty' || s === 'unavailable') return s || 'unknown'
  return s.length > 12 ? s.slice(0, 12) : s
}

/** Normalize a path for cross-platform comparison (backslashes -> forward). */
function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/** The -SUMMARY.md sibling of a -PLAN.md path. */
function summarySibling(planPath) {
  return String(planPath ?? '').replace(/-PLAN\.md$/i, '-SUMMARY.md')
}

/**
 * Simple glob match ('*' = one segment, '**' = any) OR literal equality. Both
 * sides are path-normalized. Deterministic; used only for files_modified.
 */
function pathMatch(changed, pattern) {
  const c = normPath(changed)
  const p = normPath(pattern)
  if (!p.includes('*')) return c === p
  const re = new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') +
      '$',
  )
  return re.test(c)
}

/**
 * selectPlans({changedFiles, planIndex}) -> the in-range plans. PURE over
 * injected state (grill.prePushPlan idiom — the lib NEVER scans .planning or
 * shells out; the CLI supplies changedFiles + planIndex). A plan is selected when
 * its PLAN path is in the diff, its SUMMARY sibling is in the diff, OR any of its
 * files_modified intersects a changed file. Sorted by planId, duplicates folded;
 * an empty diff -> empty selection, never a throw.
 *
 * planIndex entry shape: {planId, path, files_modified, predictionDomains}.
 *
 * @param {{changedFiles?:string[], planIndex?:object[]}} args
 * @returns {object[]}
 */
export function selectPlans({ changedFiles = [], planIndex = [] } = {}) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).map(normPath)
  const changedSet = new Set(changed)
  const picked = new Map()
  for (const plan of Array.isArray(planIndex) ? planIndex : []) {
    if (!plan || plan.planId == null) continue
    const planPath = normPath(plan.path)
    const summaryPath = normPath(summarySibling(plan.path))
    const files = Array.isArray(plan.files_modified) ? plan.files_modified : []
    const hit =
      (planPath && changedSet.has(planPath)) ||
      (summaryPath && changedSet.has(summaryPath)) ||
      files.some((f) => changed.some((c) => pathMatch(c, f)))
    if (hit && !picked.has(plan.planId)) picked.set(plan.planId, plan)
  }
  return [...picked.values()].sort((a, b) => String(a.planId).localeCompare(String(b.planId)))
}

/** Latest ledger record (by scoredAt) whose id matches, or null. */
function latestById(records, id) {
  let best = null
  for (const r of records) {
    if (!r || r.id !== id) continue
    if (best == null || String(r.scoredAt ?? '') >= String(best.scoredAt ?? '')) best = r
  }
  return best
}

/**
 * collectEvidence({plans, dirs, readFn}) -> the raw evidence bundle. READER-ONLY:
 * every value is joined from an existing ledger record, a frozen blind file, or
 * the spend book — nothing is graded here.
 *
 *   predictions : per plan, parsePredictions joined with the latest matching
 *                 calibration record per id (none -> verdict 'unscored').
 *   receipts    : per plan, parseReceipts on the -SUMMARY sibling joined with the
 *                 latest sma.receipts record per id (receipt_verdict verbatim;
 *                 none -> 'unverified').
 *   blind       : per plan, readJsonSafe(.sma/blind/<planId>.json) -> verdict
 *                 counts; missing -> status 'not-run'.
 *   divergences : count of kind:'divergence' ledger records naming an in-scope plan.
 *   calibration : per-domain {domain, rate, n} via calibration.hitRate for every
 *                 domain in scope + sma.receipts + sma.verification (n>0 only).
 *   openClassA  : consequences.openBlocks length (the preship open class-A count).
 *
 * @param {{plans:object[], dirs:object, readFn?:Function}} args
 * @returns {object}
 */
export function collectEvidence({ plans = [], dirs = {}, readFn } = {}) {
  const readOpt = readFn ? { readFn } : {}
  const predictions = []
  const receipts = []
  const blind = []
  const inScope = new Set()

  // Read the WHOLE ledger once (all domains) for divergences; per-domain reads
  // for predictions/hitRate stay scoped by domain (fewer records to scan).
  const { records: allLedger } = readLedger({ calibrationDir: dirs.calibrationDir })

  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || plan.planId == null) continue
    const planId = String(plan.planId)
    inScope.add(planId)
    const planPath = plan.path

    // — predictions: join with the latest per-id calibration record for its domain.
    const { predictions: preds } = parsePredictions(planPath, readOpt)
    for (const p of preds) {
      if (!p || p.id == null) continue
      const domain = p.domain ?? 'unknown'
      const { records } = readLedger({ calibrationDir: dirs.calibrationDir, domain })
      const rec = latestById(records, p.id)
      predictions.push({
        id: p.id,
        plan: planId,
        claim: p.claim ?? '',
        domain,
        metric: p.metric ?? '',
        comparator: p.comparator ?? '',
        threshold: p.threshold ?? null,
        verdict: rec ? rec.verdict ?? 'unscored' : 'unscored',
        actual: rec ? (rec.actual ?? null) : null,
        scoredAt: rec ? (rec.scoredAt ?? null) : null,
      })
    }

    // — receipts: parse the -SUMMARY sibling, join with the latest sma.receipts record.
    const summaryPath = summarySibling(planPath)
    const { records: receiptLedger } = readLedger({ calibrationDir: dirs.calibrationDir, domain: 'sma.receipts' })
    const { receipts: parsed } = parseReceipts(summaryPath, readOpt)
    for (const r of parsed) {
      if (!r || r.id == null) continue
      const rec = latestById(receiptLedger, r.id)
      const expected = rec ? (rec.expected_sha256 ?? r.expected_sha256 ?? null) : (r.expected_sha256 ?? null)
      const observed = rec ? (rec.observed_sha256 ?? null) : null
      receipts.push({
        id: r.id,
        plan: planId,
        assertion: r.assertion ?? '',
        verdict: rec ? (rec.receipt_verdict ?? 'unverified') : 'unverified',
        expected_sha256: expected,
        observed_sha256: observed,
        hashMatch: expected != null && observed != null ? expected === observed : null,
      })
    }

    // — blind: read the frozen verdicts; missing -> 'not-run'.
    const frozen = readJsonSafe(join(dirs.blindDir ?? '.', `${planId}.json`))
    if (!frozen || !Array.isArray(frozen.verdicts)) {
      blind.push({ plan: planId, status: 'not-run', counts: {}, total: 0 })
    } else {
      const counts = {}
      for (const v of frozen.verdicts) {
        const key = v && v.verdict != null ? String(v.verdict) : 'unknown'
        counts[key] = (counts[key] ?? 0) + 1
      }
      blind.push({ plan: planId, status: 'present', counts, total: frozen.verdicts.length })
    }
  }

  // — divergences: kind:'divergence' records naming an in-scope plan.
  const divergences = allLedger.filter(
    (r) => r && r.kind === 'divergence' && (inScope.has(String(r.planId)) || inScope.has(String(r.plan))),
  ).length

  // — per-domain hit-rate table (n>0 only; empty ledger -> empty table).
  const domains = new Set(['sma.receipts', 'sma.verification'])
  for (const plan of Array.isArray(plans) ? plans : []) {
    for (const d of Array.isArray(plan && plan.predictionDomains) ? plan.predictionDomains : []) {
      if (d) domains.add(d)
    }
  }
  const calibration = []
  for (const domain of [...domains].sort()) {
    const { records } = readLedger({ calibrationDir: dirs.calibrationDir, domain })
    const hr = hitRate(records)
    if (hr.n > 0) calibration.push({ domain, rate: hr.rate, n: hr.n })
  }

  // — preship open class-A count (the footer's regulatory signal).
  let openClassA = 0
  try {
    openClassA = openBlocks({ calibrationDir: dirs.calibrationDir }).blocks.length
  } catch {
    openClassA = 0 // fail-open — an absent ledger cannot fabricate a block
  }

  return {
    predictions: predictions.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    receipts: receipts.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    blind: blind.sort((a, b) => String(a.plan).localeCompare(String(b.plan))),
    divergences,
    calibration,
    openClassA,
  }
}

/**
 * Reduce the spend book + budget to the explicit-pick aggregate block (P1 law):
 * ONLY {windowUsd, capUsd, pct, topModels(<=5), pricingVersion}. No session ids,
 * no machine paths, no extra fields. A null book -> the 'absent' sentinel.
 */
function reduceSpend(spendBook, spendBudget, nowMs) {
  if (!spendBook || typeof spendBook !== 'object') return 'absent'
  const budget = spendBudget && typeof spendBudget === 'object' ? spendBudget : {}
  const windowHours = Number.isFinite(Number(budget.windowHours)) ? Number(budget.windowHours) : 5
  const capUsd = Number.isFinite(Number(budget.capUsd)) && Number(budget.capUsd) > 0 ? Number(budget.capUsd) : null
  const windowUsd = round6(windowSpend({ book: spendBook, now: nowMs, windowHours }).usd)
  const pct = capUsd ? round6((windowUsd / capUsd) * 100) : null

  const byModel = spendBook.byModel && typeof spendBook.byModel === 'object' ? spendBook.byModel : {}
  const topModels = Object.entries(byModel)
    .map(([model, v]) => ({ model: String(model), usd: round6(v && v.usd) }))
    .sort((a, b) => (b.usd - a.usd) || a.model.localeCompare(b.model))
    .slice(0, TOP_MODELS_MAX)

  const block = { windowUsd, capUsd, pct, topModels, pricingVersion: spendBook.pricingVersion ?? null }
  // Explicit re-pick so a future book field can never leak into the public block.
  const picked = {}
  for (const k of SPEND_PICK) picked[k] = block[k]
  return picked
}

/**
 * buildManifest(args) -> the canonical manifest object. Pure assembly + stable
 * sort; NO grading, NO command runner, NO network. `now` is the ONLY time input
 * and it is INJECTED (determinism). Serialize with JSON.stringify(manifest, null,
 * 2) for the one canonical byte form.
 *
 * @param {{range?:string, headSha?:string, plans?:object[], evidence?:object,
 *          spendBook?:object|null, spendBudget?:object, chainTip?:string,
 *          staleness?:string, now?:string}} args
 * @returns {object}
 */
export function buildManifest({
  range = '',
  headSha = '',
  plans = [],
  evidence = {},
  spendBook = null,
  spendBudget = {},
  chainTip = 'empty',
  staleness = 'unavailable',
  now,
} = {}) {
  const generatedAt = now ?? new Date().toISOString()
  const nowMs = Date.parse(generatedAt)
  const ev = evidence ?? {}

  const planIds = [...new Set((Array.isArray(plans) ? plans : []).map((p) => p && p.planId).filter((x) => x != null).map(String))].sort()
  const predictions = Array.isArray(ev.predictions) ? ev.predictions : []
  const receipts = Array.isArray(ev.receipts) ? ev.receipts : []
  const blindPlans = Array.isArray(ev.blind) ? ev.blind : []
  const calibration = Array.isArray(ev.calibration) ? ev.calibration : []

  return {
    manifestVersion: MANIFEST_VERSION,
    generatedAt,
    range: String(range ?? ''),
    headSha: String(headSha ?? ''),
    plans: planIds,
    // The loss detector: registeredPredictions is the recount from
    // the same inputs; manifestStats('prediction-coverage') = present/registered.
    coverage: { registeredPredictions: predictions.length },
    predictions,
    receipts,
    blind: { plans: blindPlans, divergences: Number(ev.divergences ?? 0) },
    spend: reduceSpend(spendBook, spendBudget, Number.isFinite(nowMs) ? nowMs : Date.now()),
    calibration,
    consequences: { openClassA: Number(ev.openClassA ?? 0) },
    chainTip: String(chainTip ?? 'empty'),
    staleness: String(staleness ?? 'unavailable'),
  }
}

/**
 * The three-state verdict CODE over a built manifest: 'red' | 'amber' | 'green'.
 * One derivation, two renders — the markdown roll-up and the dense `verdict=` token
 * can never drift apart into two different opinions of the same evidence.
 */
function verdictCode(manifest) {
  const m = manifest ?? {}
  const divergences = m.blind && Number(m.blind.divergences) > 0
  const openClassA = m.consequences && Number(m.consequences.openClassA) > 0
  if (divergences || openClassA) return 'red'
  const preds = Array.isArray(m.predictions) ? m.predictions : []
  const receipts = Array.isArray(m.receipts) ? m.receipts : []
  const notAllHit = preds.some((p) => p.verdict !== 'hit') || receipts.some((r) => r.verdict !== 'verified')
  return notAllHit ? 'amber' : 'green'
}

/** The three-state, emoji-prefixed verdict roll-up over a built manifest. */
function verdictRollup(manifest) {
  switch (verdictCode(manifest)) {
    case 'red':
      return '🔴 divergence or open class-A — the audit trail flags an unresolved block'
    case 'amber':
      return '🟡 unscored or unverified evidence present — not every claim is green yet'
    default:
      return '🟢 all evidence scored and green'
  }
}

/**
 * renderManifestMarkdown(manifest) -> the passport markdown. Line 1 is
 * MANIFEST_MARKER (the CI upsert key). Deterministic given a deterministic
 * manifest — English copy (the manifest ships on the public product repo).
 *
 * @param {object} manifest
 * @returns {string}
 */
export function renderManifestMarkdown(manifest) {
  const m = manifest ?? {}
  const out = []
  out.push(MANIFEST_MARKER)
  out.push('')
  out.push('## SMA Evidence Passport')
  out.push('')
  out.push(
    `head \`${short(m.headSha)}\` · range \`${m.range || '—'}\` · generated ${m.generatedAt} · manifest v${m.manifestVersion}`,
  )
  out.push('')
  out.push(verdictRollup(m))
  out.push('')

  // Predictions table.
  const preds = Array.isArray(m.predictions) ? m.predictions : []
  out.push('### Predictions')
  out.push('')
  if (!preds.length) {
    out.push('_No predictions registered in range._')
  } else {
    out.push('| id | plan | claim | verdict | scoredAt |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const p of preds) {
      out.push(`| ${p.id} | ${p.plan} | ${truncate(p.claim, 80)} | ${p.verdict} | ${p.scoredAt ?? '—'} |`)
    }
  }
  out.push('')

  // Receipts table.
  const receipts = Array.isArray(m.receipts) ? m.receipts : []
  out.push('### Receipts')
  out.push('')
  if (!receipts.length) {
    out.push('_No receipts in range._')
  } else {
    out.push('| id | assertion | verdict | hash-match |')
    out.push('| --- | --- | --- | --- |')
    for (const r of receipts) {
      const hm = r.hashMatch == null ? '—' : r.hashMatch ? 'yes' : 'no'
      out.push(`| ${r.id} | ${truncate(r.assertion, 60)} | ${r.verdict} | ${hm} |`)
    }
  }
  out.push('')

  // Blind section.
  const blind = m.blind && Array.isArray(m.blind.plans) ? m.blind.plans : []
  out.push('### Blind verify')
  out.push('')
  if (!blind.length) {
    out.push('_No plans in range._')
  } else {
    for (const b of blind) {
      if (b.status === 'not-run') {
        out.push(`- ${b.plan}: not-run`)
      } else {
        const parts = Object.keys(b.counts)
          .sort()
          .map((k) => `${k}=${b.counts[k]}`)
          .join(', ')
        out.push(`- ${b.plan}: ${parts || 'no verdicts'} (total ${b.total})`)
      }
    }
  }
  out.push(`- divergences: ${m.blind ? Number(m.blind.divergences) || 0 : 0}`)
  out.push('')

  // Spend line.
  out.push('### Token spend')
  out.push('')
  if (m.spend === 'absent' || m.spend == null) {
    out.push('_Spend book absent._')
  } else {
    const s = m.spend
    const cap = s.capUsd == null ? 'no cap' : `$${s.capUsd}`
    const pct = s.pct == null ? '' : ` (${s.pct}%)`
    const models = Array.isArray(s.topModels) && s.topModels.length
      ? ' · top: ' + s.topModels.map((t) => `${t.model} $${t.usd}`).join(', ')
      : ''
    out.push(`Window: $${s.windowUsd} of ${cap}${pct}${models} · pricing ${s.pricingVersion ?? '—'}`)
  }
  out.push('')

  // Per-area hit-rate table.
  const cal = Array.isArray(m.calibration) ? m.calibration : []
  out.push('### Per-area hit rate')
  out.push('')
  if (!cal.length) {
    out.push('_No scored domains yet._')
  } else {
    out.push('| domain | hit rate | n |')
    out.push('| --- | --- | --- |')
    for (const c of cal) {
      const rate = c.rate == null ? '—' : `${Math.round(c.rate * 100)}%`
      out.push(`| ${c.domain} | ${rate} | ${c.n} |`)
    }
  }
  out.push('')

  // Trust footer.
  out.push('---')
  out.push(
    `chainTip \`${short(m.chainTip)}\` · staleness \`${m.staleness}\` · open class-A: ${m.consequences ? Number(m.consequences.openClassA) || 0 : 0}`,
  )
  out.push('')
  return out.join('\n')
}

/**
 * Tally a field across records into a deterministic `key=n key=n` string: keys are
 * sorted lexicographically, so the same evidence always prints the same bytes.
 */
function tally(items, pick) {
  const counts = {}
  for (const it of Array.isArray(items) ? items : []) {
    const key = String(pick(it) ?? 'unknown')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.keys(counts)
    .sort()
    .map((k) => `${k}=${counts[k]}`)
    .join(' ')
}

/**
 * renderManifestDense(manifest) -> the COMPACT passport: exactly
 * MANIFEST_DENSE_LINES lines, one per section, `label: payload` on every line,
 * no markdown at all. This is the render an AGENT reads — one command, one
 * screenful, parseable by a two-line splitter instead of a table parser.
 *
 * THE SHAPE IS THE CONTRACT. An empty section is MARKED ('(none)', '(absent)'),
 * never dropped: a reader that counts lines can tell "nothing to report" apart
 * from "the section fell out of the build". Line count is therefore constant.
 *
 * Deterministic by construction: every count is tallied over sorted keys, every
 * list is already stable-sorted upstream, and the ONLY time-derived value
 * (generatedAt) is the injected one. Two renders of one manifest are byte-equal;
 * two builds over one state render byte-equal.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function renderManifestDense(manifest) {
  const m = manifest ?? {}
  const preds = Array.isArray(m.predictions) ? m.predictions : []
  const receipts = Array.isArray(m.receipts) ? m.receipts : []
  const blindPlans = m.blind && Array.isArray(m.blind.plans) ? m.blind.plans : []
  const cal = Array.isArray(m.calibration) ? m.calibration : []
  const out = []

  // 1. header — what this passport is, over what range, at what head.
  out.push(
    `manifest: v${m.manifestVersion ?? MANIFEST_VERSION} head=${short(m.headSha)} range=${m.range || '(none)'} generated=${m.generatedAt ?? '(none)'} plans=${Array.isArray(m.plans) ? m.plans.length : 0}`,
  )

  // 2. predictions — the registered claims and how they scored.
  out.push(preds.length ? `predictions: n=${preds.length} ${tally(preds, (p) => p.verdict)}` : 'predictions: n=0 (none)')

  // 3. receipts — the re-runnable claims and their hash agreement.
  if (receipts.length) {
    const mismatch = receipts.filter((r) => r.hashMatch === false).length
    out.push(`receipts: n=${receipts.length} ${tally(receipts, (r) => r.verdict)} hash-mismatch=${mismatch}`)
  } else {
    out.push('receipts: n=0 (none)')
  }

  // 4. blind verify — the frozen independent verdicts plus the divergence count.
  const divergences = m.blind ? Number(m.blind.divergences) || 0 : 0
  if (blindPlans.length) {
    const verdicts = {}
    for (const b of blindPlans) {
      for (const k of Object.keys(b && b.counts ? b.counts : {})) verdicts[k] = (verdicts[k] ?? 0) + b.counts[k]
    }
    const verdictStr = Object.keys(verdicts)
      .sort()
      .map((k) => `${k}=${verdicts[k]}`)
      .join(' ')
    const status = tally(blindPlans, (b) => b.status)
    out.push(`blind: plans=${blindPlans.length} ${status}${verdictStr ? ' ' + verdictStr : ''} divergences=${divergences}`)
  } else {
    out.push(`blind: plans=0 (none) divergences=${divergences}`)
  }

  // 5. spend — the window aggregate (the explicit-pick block, nothing more).
  if (m.spend === 'absent' || m.spend == null) {
    out.push('spend: (absent)')
  } else {
    const s = m.spend
    const top = Array.isArray(s.topModels) && s.topModels.length
      ? s.topModels.map((t) => `${t.model}:${t.usd}`).join(',')
      : '(none)'
    out.push(
      `spend: window=${s.windowUsd ?? 0} cap=${s.capUsd == null ? '(none)' : s.capUsd} pct=${s.pct == null ? '(none)' : s.pct} pricing=${s.pricingVersion ?? '(none)'} top=${top}`,
    )
  }

  // 6. hit-rate — the per-area calibration table, one token per domain.
  out.push(
    cal.length
      ? 'hit-rate: ' +
          cal.map((c) => `${c.domain}=${c.rate == null ? 'na' : Math.round(c.rate * 100) + '%'}(n=${c.n})`).join(' ')
      : 'hit-rate: (none)',
  )

  // 7. trust footer — the audit-trail anchors and the single verdict token.
  out.push(
    `trust: chainTip=${short(m.chainTip)} staleness=${m.staleness ?? 'unavailable'} open-class-A=${m.consequences ? Number(m.consequences.openClassA) || 0 : 0} verdict=${verdictCode(m)}`,
  )

  return out.join('\n') + '\n'
}

/**
 * manifestStats(manifest, name) -> a single finite number (the scorer
 * contract). 'prediction-coverage' = present/registered * 100 computed against
 * the manifest's own recount, so a build that DROPS a prediction from the present
 * list scores below 100 while an honest empty set scores 100. determinism and
 * bench-build-ms are CLI-level (they need double-build orchestration).
 *
 * @param {object} manifest
 * @param {string} name
 * @returns {number}
 */
export function manifestStats(manifest, name) {
  const m = manifest ?? {}
  switch (name) {
    case 'prediction-coverage': {
      const registered = m.coverage && Number.isFinite(Number(m.coverage.registeredPredictions))
        ? Number(m.coverage.registeredPredictions)
        : 0
      const present = Array.isArray(m.predictions) ? m.predictions.length : 0
      if (registered <= 0) return 100 // coverage of an empty set is honestly full
      return round6((present / registered) * 100)
    }
    default:
      return 0
  }
}
