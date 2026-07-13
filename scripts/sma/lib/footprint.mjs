/**
 * footprint.mjs — the economy ladder as a claim + a deterministic receipt
 * (49.4-07, BL-176/BL-160). The ponytail absorption done the SMA way
 * (49.4-RESEARCH-ECONOMY §2 rows 1-2): their /review LLM diff judge is REJECTED
 * and rebuilt here as arithmetic — a plan CLAIMS its footprint in frontmatter
 * (files touched, new files, ~LOC, new deps, tolerance %), and the receipt
 * compares `git diff --numstat` ACTUALS against that written claim. An overrun
 * beyond the stated tolerance is a SCORED sma.economy calibration miss + an
 * auto-drafted lesson. Zero LLM, zero network, zero judgment anywhere.
 *
 * Consume-never-reimplement (D-49.3-02):
 *   - the claim rides predict.mjs's parseFrontmatterEntries generalized reader —
 *     no new YAML machinery;
 *   - the overrun row is shaped EXACTLY as a scorePlan miss so
 *     predict.draftLessonFromMiss + calibration.appendVerdict work UNMODIFIED
 *     (the same seam plan 49.4-06's checkLaneOverrun used);
 *   - the standing challenge «which ladder rung?» lives inside grill.mjs's
 *     existing ledger law (grill.standingFootprint) — this module never touches
 *     the gate.
 *
 * SUBSTRATE LAW: Node built-ins only. The git runner is DEPENDENCY-INJECTED
 * (execGit, slots.mjs defaultExecGit pattern) — this LIB never spawns; only the
 * CLI layer passes the real runner. Every dir/reader is injectable so the
 * selftests exercise the REAL calibration/predict modules pointed at temp dirs
 * without shelling out.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseFrontmatterEntries } from './predict.mjs'

// ═══════════════════════════ the claim (frontmatter) ════════════════════════════

/** Coerce a scalar to a finite number, else return the fallback (null keeps a bad value visible to lint). */
function toNum(v, fallback) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}

/**
 * parseFootprintClaim(planPath, {readFn}) -> the parsed footprint claim, or null.
 *
 * Wraps parseFrontmatterEntries(planPath, 'footprint') — the SAME dash-list reader
 * predictions/consequences use. Returns the FIRST `footprint:` dash-entry coerced to
 * {files, new_files, loc, new_deps, tolerance_pct} with numeric coercion; a plan with
 * no block returns null (honest absent, never a throw). A claim missing new_deps
 * defaults it to 0 (a plan that adds zero packages need not spell it out).
 *
 * @param {string} planPath
 * @param {{readFn?:Function}} [opts]
 * @returns {({files:number, new_files:number, loc:number, new_deps:number, tolerance_pct:number})|null}
 */
export function parseFootprintClaim(planPath, opts = {}) {
  const { entries } = parseFrontmatterEntries(planPath, 'footprint', opts)
  if (!entries || !entries.length) return null
  const e = entries[0]
  return {
    files: toNum(e.files, undefined),
    new_files: toNum(e.new_files, undefined),
    loc: toNum(e.loc, undefined),
    new_deps: toNum(e.new_deps, 0), // default 0 — a new dep is opt-in
    tolerance_pct: toNum(e.tolerance_pct, undefined),
  }
}

/**
 * lintFootprintClaim(claim) -> violations[]. Each violation is the lint.mjs shape
 * {rule:'FOOT-SCHEMA', field, message}. Flags a missing/non-numeric/negative
 * files|new_files|loc|new_deps, and a tolerance_pct that is non-numeric or outside
 * 0..200. A clean claim returns [].
 *
 * @param {object} claim
 * @returns {{rule:string, field:string, message:string}[]}
 */
export function lintFootprintClaim(claim) {
  if (!claim || typeof claim !== 'object') {
    return [{ rule: 'FOOT-SCHEMA', field: '(root)', message: 'footprint claim is absent or not a map' }]
  }
  const v = []
  for (const field of ['files', 'new_files', 'loc', 'new_deps']) {
    const val = claim[field]
    if (val == null) {
      v.push({ rule: 'FOOT-SCHEMA', field, message: `${field} is required` })
      continue
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      v.push({ rule: 'FOOT-SCHEMA', field, message: `${field} must be numeric` })
      continue
    }
    if (val < 0) v.push({ rule: 'FOOT-SCHEMA', field, message: `${field} must be >= 0` })
  }
  const tp = claim.tolerance_pct
  if (tp == null || typeof tp !== 'number' || !Number.isFinite(tp)) {
    v.push({ rule: 'FOOT-SCHEMA', field: 'tolerance_pct', message: 'tolerance_pct must be numeric' })
  } else if (tp < 0 || tp > 200) {
    v.push({ rule: 'FOOT-SCHEMA', field: 'tolerance_pct', message: 'tolerance_pct must be within 0..200' })
  }
  return v
}

// ═══════════════════════════ the actuals (git --numstat) ════════════════════════

/**
 * footprintActuals({planId, execGit}) -> the git-derived actuals, or {empty:true}.
 *
 * Discovers the plan's commits by the house attribution convention (`git log
 * --fixed-strings --grep <planId>`), then folds `--numstat` over them:
 *   - files = the union of touched paths;
 *   - loc   = the sum of ADDITIONS (a binary '-' addition is skipped, never NaN);
 *   - new_deps = dependency/devDependency names present in package.json at the
 *     newest commit but NOT at the oldest commit's parent (net new packages).
 * Zero matching commits -> {empty:true} (an honest empty — no verdict, no fake 0).
 * The injected execGit is the ONLY git access; every call is wrapped so a missing
 * ref (e.g. no package.json) degrades to zero rather than throwing.
 *
 * @param {{planId:string, execGit:Function}} opts
 * @returns {{empty:boolean, commits?:number, shas?:string[], files?:number, filePaths?:string[], loc?:number, new_deps?:number}}
 */
export function footprintActuals({ planId, execGit } = {}) {
  const run = (args) => {
    try {
      return String(execGit(args) ?? '')
    } catch {
      return ''
    }
  }

  // One log call carries both the commit list and the numstat blocks.
  const logOut = run(['log', '--fixed-strings', '--grep', String(planId ?? ''), '--numstat', '--format=commit %H'])
  const shas = []
  const paths = new Set()
  let loc = 0
  for (const rawLine of logOut.split('\n')) {
    const t = rawLine.replace(/\r$/, '')
    const cm = /^commit ([0-9a-f]{7,40})$/.exec(t.trim())
    if (cm) {
      shas.push(cm[1])
      continue
    }
    const nm = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(t)
    if (nm) {
      if (nm[1] !== '-') loc += parseInt(nm[1], 10) // binary '-' addition is skipped
      paths.add(nm[3].trim())
    }
  }
  if (!shas.length) return { empty: true }

  // new_deps: net new package.json dependency names, oldest-parent -> newest.
  const newest = shas[0]
  const oldest = shas[shas.length - 1]
  const depsAt = (ref) => {
    const raw = run(['show', `${ref}:package.json`])
    if (!raw) return new Set()
    try {
      const pkg = JSON.parse(raw)
      return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})])
    } catch {
      return new Set()
    }
  }
  const before = depsAt(`${oldest}^`)
  const after = depsAt(newest)
  let new_deps = 0
  for (const d of after) if (!before.has(d)) new_deps += 1

  return { empty: false, commits: shas.length, shas, files: paths.size, filePaths: [...paths], loc, new_deps }
}

// ═══════════════════════════ the receipt (verdict) ══════════════════════════════

/**
 * footprintReceipt({claim, actuals, planId, planPath, appendVerdict, draftLesson, now})
 * -> the receipt verdict.
 *
 * Compares actuals against the claim per axis: files & loc carry the stated
 * tolerance (claim*(1+tolerance_pct/100), floored); new_deps has tolerance 0 (a
 * new dep either was claimed or it is an overrun). Within tolerance on EVERY axis
 * -> {verdict:'verified'} with NO calls. Beyond tolerance on ANY axis ->
 * {verdict:'overrun', axis} + the injected appendVerdict called ONCE (a
 * scorePlan-miss-shaped sma.economy record) + the injected draftLesson called
 * ONCE. Empty actuals -> {empty:true} (honest empty). Whole body never throws.
 *
 * The miss record is shaped EXACTLY as a predict.mjs scorePlan miss so
 * draftLessonFromMiss works unmodified.
 *
 * @param {{claim:object, actuals:object, planId?:string, planPath?:string,
 *          appendVerdict?:Function, draftLesson?:Function, now?:string}} opts
 * @returns {object}
 */
export function footprintReceipt({ claim, actuals, planId, planPath, appendVerdict, draftLesson, now } = {}) {
  if (!actuals || actuals.empty) return { empty: true, verdict: null }
  if (!claim) return { verdict: null, reason: 'no-claim' }

  const tol = Number.isFinite(claim.tolerance_pct) ? claim.tolerance_pct : 0
  const mult = 1 + tol / 100
  const axes = [
    { axis: 'files', expected: Math.floor((Number(claim.files) || 0) * mult), actual: Number(actuals.files) || 0 },
    { axis: 'loc', expected: Math.floor((Number(claim.loc) || 0) * mult), actual: Number(actuals.loc) || 0 },
    { axis: 'new_deps', expected: Number(claim.new_deps) || 0, actual: Number(actuals.new_deps) || 0 }, // tolerance 0
  ]
  const over = axes.find((a) => a.actual > a.expected)
  if (!over) return { verdict: 'verified', axes }

  const ts = now || new Date().toISOString()
  const verdict = {
    verdict: 'miss',
    domain: 'sma.economy',
    metric: 'footprint_overrun',
    id: `FOOT-${planId ?? 'unknown'}`,
    claim: `план ${planId ?? '?'}: ось ${over.axis} осталась в пределах заявленного объёма (<= ${over.expected}, tolerance ${tol}%)`,
    check_command: `pnpm sma reverify --footprint ${planPath ?? ''}`.trim(),
    comparator: '<=',
    expected: over.expected,
    actual: over.actual,
    scoredAt: ts,
  }

  let appended = false
  let draftedPath = null
  if (typeof appendVerdict === 'function') {
    appendVerdict(verdict)
    appended = true
  }
  if (typeof draftLesson === 'function') {
    const d = draftLesson({ verdict, planId: planId ?? 'footprint' })
    draftedPath = d && d.path ? d.path : null
  }
  return { verdict: 'overrun', axis: over.axis, expected: over.expected, actual: over.actual, calibrationRow: verdict, appended, draftedPath }
}

// ═══════════════════════════ selftests (self-proving) ═══════════════════════════

/**
 * standingSelftest() -> 1|0 (P49.4-07-A). Runs the fixture pair in a temp grillDir
 * against the REAL grill.standingFootprint + grillGate:
 *   - a plan with NO footprint claim -> standing challenge registered AND gate blocked
 *     (idempotent — a second call does not duplicate);
 *   - a plan never touched by --standing keeps grillGate {grilled:false};
 *   - a plan with a claim resolves an open standing challenge -> gate allowed.
 * @returns {Promise<number>}
 */
export async function standingSelftest() {
  const grill = await import('./grill.mjs')
  const root = mkdtempSync(join(tmpdir(), 'sma-foot-standing-'))
  try {
    const grillDir = join(root, 'grill')
    const noClaimPath = join(root, 'no-claim-PLAN.md')
    const withClaimPath = join(root, 'with-claim-PLAN.md')
    writeFileSync(noClaimPath, '---\nphase: t\nplan: 01\n---\n\nbody\n')
    writeFileSync(
      withClaimPath,
      '---\nphase: t\nplan: 02\nfootprint:\n  - files: 5\n    new_files: 1\n    loc: 100\n    new_deps: 0\n    tolerance_pct: 50\n---\n\nbody\n',
    )

    // 1. no-claim -> null; standing registers; gate BLOCKS.
    if (parseFootprintClaim(noClaimPath) !== null) return 0
    grill.standingFootprint({ planPath: noClaimPath, planId: 't-01', claim: null, grillDir })
    let gate = grill.grillGate({ planId: 't-01', dirs: { grillDir } })
    if (gate.allowed !== false || gate.grilled !== true) return 0
    // idempotent — a second no-claim call does not add a second challenge.
    grill.standingFootprint({ planPath: noClaimPath, planId: 't-01', claim: null, grillDir })
    if (grill.readChallenges({ planId: 't-01' }, { grillDir }).challenges.length !== 1) return 0

    // 2. a plan never touched by --standing keeps grilled:false.
    const claim = parseFootprintClaim(withClaimPath)
    if (!claim || claim.loc !== 100) return 0
    if (grill.grillGate({ planId: 't-02', dirs: { grillDir } }).grilled !== false) return 0
    // a claim present + no standing challenge = no-op (no write, still ungrilled).
    grill.standingFootprint({ planPath: withClaimPath, planId: 't-02', claim, grillDir })
    if (grill.grillGate({ planId: 't-02', dirs: { grillDir } }).grilled !== false) return 0

    // 3. resolve path: register (as if no claim) then resolve with the claim -> allowed.
    grill.standingFootprint({ planPath: withClaimPath, planId: 't-02', claim: null, grillDir })
    if (grill.grillGate({ planId: 't-02', dirs: { grillDir } }).allowed !== false) return 0
    grill.standingFootprint({ planPath: withClaimPath, planId: 't-02', claim, grillDir })
    if (grill.grillGate({ planId: 't-02', dirs: { grillDir } }).allowed !== true) return 0

    return 1
  } catch {
    return 0
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  }
}

/**
 * footprintSelftest() -> 1|0 (P49.4-07-B). Proves the receipt arithmetic end-to-end
 * against the REAL calibration.appendVerdict + predict.draftLessonFromMiss pointed at
 * temp dirs:
 *   - within-tolerance actuals -> verified, zero calibration rows, zero drafts;
 *   - beyond-tolerance actuals -> exactly ONE sma.economy footprint_overrun miss + ONE
 *     drafted lesson;
 *   - empty actuals -> honest empty, no new rows.
 * @returns {Promise<number>}
 */
export async function footprintSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'sma-foot-receipt-'))
  try {
    const calibration = await import('./calibration.mjs')
    const predict = await import('./predict.mjs')
    const calibrationDir = join(root, 'calibration')
    const draftsDir = join(root, 'drafts')
    const appendVerdict = (rec) => calibration.appendVerdict(rec, { calibrationDir })
    const draftLesson = ({ verdict, planId }) => predict.draftLessonFromMiss({ verdict, planId, dirs: { draftsDir } })

    const claim = { files: 5, new_files: 1, loc: 100, new_deps: 0, tolerance_pct: 50 } // ceilings: files 7, loc 150

    // within tolerance -> verified, zero rows.
    const okActuals = { empty: false, commits: 2, files: 5, loc: 140, new_deps: 0 }
    if (footprintReceipt({ claim, actuals: okActuals, planId: 't-06', planPath: 't-06-PLAN.md', appendVerdict, draftLesson }).verdict !== 'verified') return 0
    if (calibration.readLedger({ calibrationDir, domain: 'sma.economy' }).records.length !== 0) return 0

    // beyond tolerance on loc -> ONE miss + ONE draft.
    const overActuals = { empty: false, commits: 2, files: 5, loc: 300, new_deps: 0 }
    const overRes = footprintReceipt({ claim, actuals: overActuals, planId: 't-06', planPath: 't-06-PLAN.md', appendVerdict, draftLesson })
    if (overRes.verdict !== 'overrun' || overRes.axis !== 'loc' || !overRes.appended || !overRes.draftedPath) return 0
    const led = calibration.readLedger({ calibrationDir, domain: 'sma.economy' })
    if (led.records.length !== 1 || led.records[0].metric !== 'footprint_overrun') return 0
    let draftCount = 0
    try {
      draftCount = readdirSync(draftsDir).filter((f) => f.endsWith('.md')).length
    } catch {
      draftCount = 0
    }
    if (draftCount !== 1) return 0

    // empty actuals -> honest empty, no new rows.
    if (!footprintReceipt({ claim, actuals: { empty: true }, planId: 't-06', planPath: 't-06-PLAN.md', appendVerdict, draftLesson }).empty) return 0
    if (calibration.readLedger({ calibrationDir, domain: 'sma.economy' }).records.length !== 1) return 0

    return 1
  } catch {
    return 0
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  }
}
