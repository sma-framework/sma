/**
 * blind-verify.mjs — tree-only re-derivation with a STRUCTURAL information barrier +
 * divergence as the heaviest calibration-ledger event (49.2-07, D-49.2-11).
 *
 * The verifier re-derives every «done» from the plan file + the code tree ALONE. It is
 * «blind» as a PROPERTY OF THE CODE, not of the caller's discipline:
 *   - blindVerify takes NO claimed/summary input parameter at all;
 *   - an internal assertBlindPath guard refuses any *-SUMMARY.md / exec-journal read and
 *     scores 'refused-blind' WITHOUT a read;
 *   - the CLI freezes the blind verdicts to .sma/blind/<planId>.json BEFORE it ever
 *     parses the claimed side (compareToClaimed refuses until that frozen file exists),
 *     so the executor's report can never contaminate the blind pass (T-49.2-07B).
 *
 * A claimed-pass / reproduced-fail DIVERGENCE reuses the V2 ledger EXACTLY
 * (calibration.appendVerdict — calibration.mjs stays untouched): it carries
 * verdict:'divergence' so plan 08's shipped classifyEvent scores it class A (the
 * auto-block), PLUS kind:'divergence' so plan 07's divergenceStats and plan 10's canary
 * audit key on it. (The 49.2-07 plan text said verdict:'miss'; reconciled to the SHIPPED
 * plan-08 consumer, whose classifyEvent keys class-A on verdict:'divergence' — never on
 * kind — so the block fires for EVERY divergence regardless of the check's domain.)
 *
 * Every check_command crosses the SAME SAFE_COMMAND boundary as predictions — isSafeCommand
 * from predict.mjs, reused VERBATIM, never a second allowlist (T-49.2-07A). Node built-ins
 * only; DI runner + readFn + dirs so tests never shell out; zero LLM; fail-open (C9) —
 * blindVerify never throws.
 */

import { isAbsolute, join, dirname, basename } from 'node:path'

import { isSafeCommand, parsePredictions, parseFrontmatterEntries } from './predict.mjs'
import { appendVerdict, readLedger } from './calibration.mjs'
import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'

/** The default domain for a divergence/under-claim with no domain of its own. */
const DEFAULT_DOMAIN = 'sma.verification'

/**
 * A path the blind verifier must NEVER read — an executor report or the journal. A
 * match scores 'refused-blind' with the reader never invoked. This regex IS the barrier
 * (guard invariant GRILL-1 keeps it from regressing).
 */
const BLIND_FORBIDDEN = /(-SUMMARY\.md$)|(exec-journal)/i

/** True when a path is one the verdict must never be allowed to see. */
function isForbiddenPath(p) {
  return BLIND_FORBIDDEN.test(String(p ?? ''))
}

/**
 * Public alias of the barrier predicate so the CLI (and any programmatic caller) can
 * refuse a forbidden INPUT path BEFORE any freeze / ledger write. The blind pass takes
 * ONLY a -PLAN.md; a SUMMARY/exec-journal positional is an operator error that would
 * otherwise diff a report against itself and poison the ledger (49.2-07, D-49.2-11).
 */
export function isForbiddenBlindPath(p) {
  return isForbiddenPath(p)
}

/** The structural-refusal message for a forbidden blind-verify input path. */
function blindRefusalReason(planPath) {
  return `blind-verify СТРУКТУРНО ОТКАЗАНО: вход «${basename(String(planPath ?? ''))}» — это отчёт исполнителя (SUMMARY/exec-journal). Слепой проход выводит «done» из файла -PLAN.md и дерева кода, НИКОГДА из отчёта. Ничего не записано, реестр не тронут.`
}

/** Strip one layer of surrounding quotes (frontmatter unquote posture). */
function unquote(v) {
  const t = String(v ?? '').trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** planId from a plan path: basename minus the -PLAN.md / -SUMMARY.md suffix. */
function planIdFromPath(planPath) {
  return basename(String(planPath ?? '')).replace(/-(PLAN|SUMMARY)\.md$/i, '').replace(/\.md$/i, '')
}

/**
 * parseArtifacts(text) -> [{path, contains}]. A narrow line-oriented walk of the
 * nested `must_haves: > artifacts:` block (parseFrontmatterEntries only reads
 * top-level dash-lists — the artifacts list is two levels deep, like receipts.mjs's
 * parseCoverage). Tolerates the sibling truths/key_links/prohibitions sub-lists. NO
 * new YAML lib (frontmatter.mjs:1-19 lock).
 */
function parseArtifacts(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  if (!norm.startsWith('---\n')) return []
  const closeIdx = norm.indexOf('\n---\n', 3)
  const fm = closeIdx === -1 ? norm.slice(4) : norm.slice(4, closeIdx + 1)
  const lines = fm.split('\n')

  const out = []
  let inArtifacts = false
  for (const line of lines) {
    if (/^  artifacts:\s*$/.test(line)) {
      inArtifacts = true
      continue
    }
    if (!inArtifacts) continue
    // a `- path:` entry (any indent deeper than the `artifacts:` key)
    const mPath = /^\s+-\s+path:\s*(.+)$/.exec(line)
    const mCont = /^\s+contains:\s*(.+)$/.exec(line)
    if (mPath) {
      out.push({ path: unquote(mPath[1]), contains: null })
      continue
    }
    if (mCont && out.length) {
      out[out.length - 1].contains = unquote(mCont[1])
      continue
    }
    // a 2-space sibling key (key_links: / prohibitions: / truths:) or a dedent closes it
    if (/^  [A-Za-z_][\w-]*:/.test(line) || /^\S/.test(line) || line.trim() === '---') {
      inArtifacts = false
    }
  }
  return out
}

/**
 * deriveChecks({planPath, readFn, rootDir}) -> {checks}. Extracts checks ONLY from the
 * plan file: must_haves artifacts (existence + contains-string), predictions entries
 * (check_command via the allowlist), and a receipts claims block when present — each
 * tagged source:'artifact'|'prediction'|'claim'. A plan with none of the three yields
 * an honest empty list, never a throw.
 *
 * @param {{planPath:string, readFn?:Function, rootDir?:string}} args
 * @returns {{checks: object[]}}
 */
export function deriveChecks({ planPath, readFn, rootDir } = {}) {
  const read = readFn ?? ((p) => p) // caller injects the real reader
  const root = rootDir ?? dirname(String(planPath ?? '.'))
  const checks = []

  // INPUT BARRIER (D-49.2-11): a SUMMARY/exec-journal input is refused BEFORE any read —
  // deriving checks from an executor report is exactly the contamination the barrier kills.
  if (isForbiddenPath(planPath)) {
    return { checks, refused: true, reason: blindRefusalReason(planPath) }
  }

  let text = ''
  try {
    text = read(planPath, 'utf8')
  } catch {
    return { checks } // unreadable plan → honest empty (fail-open C9)
  }

  // 1. artifact checks (must_haves > artifacts).
  for (const a of parseArtifacts(text)) {
    const abs = isAbsolute(a.path) ? a.path : join(root, a.path)
    checks.push({ source: 'artifact', id: a.path, path: a.path, resolved: abs, contains: a.contains })
  }

  // 2. prediction checks — reuse parsePredictions (same extractor as the scorer).
  const { predictions } = parsePredictions(planPath, { readFn: read })
  for (const p of predictions) {
    if (!p || !p.check_command) continue
    checks.push({
      source: 'prediction',
      id: p.id,
      check_command: p.check_command,
      comparator: p.comparator,
      threshold: Number(p.threshold),
      domain: p.domain ?? DEFAULT_DOMAIN,
    })
  }

  // 3. claim checks — a receipts block when present (usually empty in a PLAN).
  const { entries: receipts } = parseFrontmatterEntries(planPath, 'receipts', { readFn: read })
  for (const r of receipts) {
    if (!r || !r.check_command) continue
    checks.push({
      source: 'claim',
      id: r.id,
      check_command: r.check_command,
      expected_sha256: r.expected_sha256 ?? null,
      domain: r.domain ?? DEFAULT_DOMAIN,
    })
  }

  return { checks }
}

/** Parse the numeric LAST non-empty line of a command's output -> number|null. */
function numericLastLine(output) {
  const lines = String(output ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return null
  const last = lines[lines.length - 1]
  return /^-?\d+(\.\d+)?$/.test(last) ? Number(last) : null
}

/** Deterministic numeric compare (mirrors predict.mjs — the ONLY verdict signal). */
function compare(actual, comparator, threshold) {
  switch (comparator) {
    case '==': return actual === threshold
    case '!=': return actual !== threshold
    case '>=': return actual >= threshold
    case '<=': return actual <= threshold
    case '>': return actual > threshold
    case '<': return actual < threshold
    default: return false
  }
}

/**
 * verifyArtifact(check, readFn) -> verdict. A forbidden path (SUMMARY/exec-journal)
 * scores 'refused-blind' with the reader NEVER invoked (the barrier). Otherwise: read
 * the file; a read error → 'fail' (absent); a `contains` string present → 'pass' iff
 * found; no `contains` → 'pass' (exists). Never throws.
 */
function verifyArtifact(check, readFn) {
  if (isForbiddenPath(check.path) || isForbiddenPath(check.resolved)) {
    return 'refused-blind' // structural barrier — no read of an executor report
  }
  let content
  try {
    content = readFn(check.resolved, 'utf8')
  } catch {
    return 'fail' // missing artifact
  }
  if (check.contains != null && String(check.contains) !== '') {
    return String(content).includes(String(check.contains)) ? 'pass' : 'fail'
  }
  return 'pass'
}

/**
 * verifyCommand(check, runCommand) -> verdict. The allowlist gate FIRST (T-49.2-07A):
 * a non-matching command scores 'skipped-unsafe' with runCommand NEVER invoked. A safe
 * command runs; non-numeric output or a throwing runner → 'error'; else numeric compare.
 */
function verifyCommand(check, runCommand) {
  if (!isSafeCommand(check.check_command)) return 'skipped-unsafe'
  let output
  try {
    output = runCommand(check.check_command)
  } catch {
    return 'error'
  }
  const actual = numericLastLine(output)
  if (actual == null) return 'error'
  return compare(actual, check.comparator, Number(check.threshold)) ? 'pass' : 'fail'
}

/**
 * blindVerify({planPath, runCommand, readFn, dirs, rootDir, planId}) -> {planId,
 * verdicts, frozenPath}. Derives checks from the tree, scores each, and FREEZES the
 * verdicts to .sma/blind/<planId>.json (atomicWriteJson). Accepts NO claimed input.
 * Never throws (fail-open C9).
 *
 * verdict ∈ 'pass' | 'fail' | 'skipped-unsafe' | 'error' | 'refused-blind'.
 *
 * @param {{planPath:string, runCommand:Function, readFn:Function, dirs:{blindDir:string},
 *          rootDir?:string, planId?:string, now?:string}} args
 * @returns {{planId:string, verdicts:object[], frozenPath:string}}
 */
export function blindVerify({ planPath, runCommand, readFn, dirs = {}, rootDir, planId, now } = {}) {
  const pid = planId ?? planIdFromPath(planPath)
  const verdicts = []

  // INPUT BARRIER (D-49.2-11): refuse a SUMMARY/exec-journal input path — nothing frozen,
  // no ledger touched. The blind pass accepts ONLY a -PLAN.md.
  if (isForbiddenPath(planPath)) {
    return { planId: pid, verdicts, refused: true, reason: blindRefusalReason(planPath), frozenPath: null }
  }

  try {
    const { checks } = deriveChecks({ planPath, readFn, rootDir })
    for (const check of checks) {
      let verdict
      if (check.source === 'artifact') {
        verdict = verifyArtifact(check, readFn)
      } else {
        verdict = verifyCommand(check, runCommand)
      }
      verdicts.push({
        id: check.id,
        source: check.source,
        verdict,
        ...(check.path != null ? { path: check.path } : {}),
        ...(check.domain != null ? { domain: check.domain } : {}),
      })
    }
  } catch {
    /* fail-open — a derivation bug never crashes the blind pass */
  }

  const frozenPath = join(dirs.blindDir ?? '.', `${pid}.json`)
  const frozen = { planId: pid, frozenAt: now ?? new Date().toISOString(), verdicts }
  try {
    atomicWriteJson(frozenPath, frozen)
  } catch {
    /* a freeze failure degrades to an in-memory result — never throws */
  }
  return { planId: pid, verdicts, frozenPath }
}

/** Normalize a claimed-side input (array or map) to a Map<id, verdict>. */
function claimedMap(claimed) {
  const m = new Map()
  if (Array.isArray(claimed)) {
    for (const c of claimed) if (c && c.id != null) m.set(c.id, c.verdict)
  } else if (claimed && typeof claimed === 'object') {
    for (const [k, v] of Object.entries(claimed)) m.set(k, typeof v === 'object' ? v.verdict : v)
  }
  return m
}

/**
 * compareToClaimed({claimed, planId, dirs, lastGoodSha, now}) -> {ok, divergences,
 * underClaims, count} | {ok:false, reason}.
 *
 * REFUSES ({ok:false}) unless the frozen .sma/blind/<planId>.json already exists — the
 * blind side must be committed to disk BEFORE the claimed side is read (Test 5). For
 * each frozen verdict:
 *   claimed-pass + blind-fail  -> ONE divergence record (calibration.appendVerdict, the
 *                                 heaviest ledger event) to the check's domain ledger;
 *   claimed-fail + blind-fail  -> nothing (an honest fail);
 *   blind-pass  + claimed-fail -> a kind:'under-claim' NOTE (never a divergence).
 * calibration.mjs is untouched — we only APPEND via its public writer.
 *
 * @param {{claimed:(object[]|object), planId:string, dirs:{blindDir:string, calibrationDir:string},
 *          lastGoodSha?:string, now?:string}} args
 * @returns {{ok:boolean, reason?:string, divergences?:object[], underClaims?:object[], count?:number}}
 */
export function compareToClaimed({ claimed, planId, dirs = {}, lastGoodSha, now } = {}) {
  const frozenPath = join(dirs.blindDir ?? '.', `${planId}.json`)
  const frozen = readJsonSafe(frozenPath)
  if (!frozen || !Array.isArray(frozen.verdicts)) {
    return { ok: false, reason: `blind verdicts not frozen for ${planId} — run blind-verify first (the claimed side must never precede the freeze)` }
  }

  const claims = claimedMap(claimed)
  const at = now ?? new Date().toISOString()
  const divergences = []
  const underClaims = []

  for (const v of frozen.verdicts) {
    const blindPass = v.verdict === 'pass'
    const blindFail = v.verdict === 'fail'
    if (!blindPass && !blindFail) continue // skipped-unsafe / error / refused-blind carry no comparison
    if (!claims.has(v.id)) continue
    const claimedPass = claims.get(v.id) === 'pass'
    const claimedFail = claims.get(v.id) === 'fail'
    const domain = v.domain ?? DEFAULT_DOMAIN

    if (claimedPass && blindFail) {
      // DIVERGENCE — reconciled to plan 08's shipped classifyEvent: verdict:'divergence'
      // is class A ALWAYS (regardless of domain), kind:'divergence' is plan 07/10's key.
      const rec = {
        verdict: 'divergence',
        kind: 'divergence',
        id: v.id,
        checkId: v.id,
        planId,
        plan: planId,
        domain,
        claimedVerdict: 'pass',
        blindVerdict: 'fail',
        claimed: 'pass',
        reproduced: 'fail',
        ...(lastGoodSha ? { lastGoodSha } : {}),
        at,
        scoredAt: at,
      }
      appendVerdict(rec, { calibrationDir: dirs.calibrationDir })
      divergences.push(rec)
    } else if (blindPass && claimedFail) {
      // UNDER-CLAIM — a plain note (NO verdict field → hitRate/classifyEvent ignore it).
      const rec = {
        kind: 'under-claim',
        id: v.id,
        checkId: v.id,
        planId,
        plan: planId,
        domain,
        claimedVerdict: 'fail',
        blindVerdict: 'pass',
        at,
      }
      appendVerdict(rec, { calibrationDir: dirs.calibrationDir })
      underClaims.push(rec)
    }
    // claimed-fail + blind-fail (honest fail) and agree cases record nothing.
  }

  return { ok: true, divergences, underClaims, count: divergences.length }
}

/**
 * divergenceStats({calibrationDir}) -> {count}. Counts kind:'divergence' records across
 * ALL domain ledgers — the P49.2-07-B instrument (numeric-last-line via the CLI). Missing
 * ledger dir → 0, never throws.
 *
 * @param {{calibrationDir:string}} opts
 * @returns {{count:number}}
 */
export function divergenceStats(opts = {}) {
  const { records } = readLedger({ calibrationDir: opts.calibrationDir })
  return { count: records.filter((r) => r && r.kind === 'divergence').length }
}
