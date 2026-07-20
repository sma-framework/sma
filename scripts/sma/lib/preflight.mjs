/**
 * preflight.mjs — the already-built pre-dispatch comparator (Phase 9.3 Plan 10).
 *
 * D-9.3-17 / BL-141 verbatim: «it looks into the tree and sees whether the code
 * exists so we don't spend so many tokens — it is critical.» Given a plan file this
 * is a DETERMINISTIC, zero-LLM, read-only check run BEFORE any executor is dispatched:
 * it parses the plan's must_haves (artifact paths + `contains` needles) and its
 * allowlisted `<verify>` commands, checks them against the REAL code tree, and returns
 * exactly ONE verdict — built / partial / absent → skip / reconcile-only / execute.
 * It mechanizes the house verify-before-execute HARD RULE (the 23-02 near-re-execution
 * incident, where a parallel terminal had already committed the plan's code).
 *
 * Consume-never-reimplement (D-9.3-02): this module writes NO second frontmatter
 * parser, NO second command allowlist, NO second tree-comparison engine. It composes
 * three existing substrate modules, all LAZY-imported and tolerated-if-absent:
 *   - bench.mjs      → parseMustHaveArtifacts / parseVerifyCommands / normalizeVerifyCommand
 *   - predict.mjs    → isSafeCommand / SAFE_COMMAND_PATTERNS (the command-safety gate)
 *   - blind-verify.mjs → deriveChecks / compareToClaimed (the partial-verdict reconcile path)
 *
 * Safety locks (the load-bearing invariants this plan exists to guarantee):
 *   - READ-ONLY artifact check: a `contains` needle is a plain String.includes search
 *     over injected file bytes; this module imports NO child_process for the artifact
 *     check. A verify command is RUN only when it is BOTH isSafeCommand-allowlisted AND
 *     the operator opted in (--run-verify) — a non-allowlisted command is reported
 *     `skipped-unsafe`, NEVER executed. Mined/plan content is never run.
 *   - CONSERVATIVE / FAIL-OPEN (C9): any parse error, missing plan, or unreadable tree
 *     degrades to the verdict `absent` (execute — never a false `built` that would SKIP
 *     real work) with confidence 'low'. A preflight bug can never wedge a dispatch.
 *   - A FALSE-BUILT verdict is the ONE forbidden failure: `built` is returned ONLY when
 *     EVERY declared artifact is satisfied; any doubt lands `partial` or `absent`.
 *   - ZERO LLM tokens: the whole comparator is deterministic string+existence checks
 *     over injected file data.
 *
 * Node built-ins only; everything injectable ({ readFile, existsSync, rootDir, runVerify,
 * importBench, ... }) so tests never touch the real tree, never shell out, never spend a
 * token. The CLI supplies the real fs + a read-only exec runner; tests supply doubles.
 */

import { existsSync as fsExistsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Verdict → numeric code. `sma preflight --count` prints this code as its last line. */
export const VERDICT_CODES = { built: 0, partial: 1, absent: 2 }

const DEFAULT_READ = (p) => readFileSync(p, 'utf8')

/** Lazy, tolerated-if-absent substrate loaders (D-9.3-02). */
async function loadBench(inject) {
  if (typeof inject === 'function') return inject()
  return import('./bench.mjs')
}
async function loadPredict(inject) {
  if (typeof inject === 'function') return inject()
  return import('./predict.mjs')
}

/**
 * checkArtifact({path, contains, existsSync, readFile, rootDir}) -> per-artifact result.
 * `satisfied` = the path EXISTS on disk AND (no `contains` needle OR the needle is
 * present via a plain read-only String.includes over the file bytes). The needle is
 * only searched for — never executed, never treated as a regex.
 */
export function checkArtifact({ path, contains, existsSync, readFile, rootDir } = {}) {
  const exists_ = typeof existsSync === 'function' ? existsSync : fsExistsSync
  const read = typeof readFile === 'function' ? readFile : DEFAULT_READ
  const root = rootDir ?? '.'
  const resolved = isAbsolute(String(path)) ? String(path) : join(root, String(path))

  let exists = false
  try {
    exists = !!exists_(resolved)
  } catch {
    exists = false
  }

  const needle = contains == null || contains === '' ? null : String(contains)
  let needleFound = null
  if (!exists) {
    needleFound = false
  } else if (needle == null) {
    needleFound = true // existence alone satisfies when no needle is declared
  } else {
    try {
      needleFound = String(read(resolved, 'utf8')).includes(needle)
    } catch {
      needleFound = false // unreadable existing file → not satisfied (conservative)
    }
  }

  const satisfied = exists && needleFound === true
  return { path: String(path), resolved, exists, contains: needle, needleFound, satisfied }
}

/**
 * aggregateVerdict(results) -> {verdict, code, ...}. The fixed, order-independent rule:
 *   all satisfied  → built  (code 0)
 *   none satisfied → absent (code 2)   [empty artifact list is also absent — unprovable]
 *   any mix        → partial(code 1)   [+ a `reconcile` list of present-but-divergent artifacts]
 * `built` is returned ONLY when EVERY artifact is satisfied — the false-built exclusion.
 */
export function aggregateVerdict(results) {
  const list = Array.isArray(results) ? results : []
  const total = list.length
  const satisfied = list.filter((r) => r && r.satisfied)
  const missing = list.filter((r) => r && !r.exists)
  const divergent = list.filter((r) => r && r.exists && !r.satisfied)

  let verdict
  if (total === 0 || satisfied.length === 0) verdict = 'absent'
  else if (satisfied.length === total) verdict = 'built'
  else verdict = 'partial'

  const code = VERDICT_CODES[verdict]
  const out = { verdict, code, artifacts: list, satisfied, missing }
  if (verdict === 'partial') out.reconcile = divergent // hand to blind-verify for a precise reconcile diff
  return out
}

/**
 * runVerifyCommands({planText, opted, runVerify, importBench, importPredict}) ->
 * [{command, inner, status, ...}]. Opt-in ONLY. A command is handed to the injected
 * `runVerify` runner ONLY when it passes predict.mjs's isSafeCommand AND `opted` is true.
 * A non-allowlisted command is `skipped-unsafe` (runner never called); a safe command
 * with `opted` false is `not-run`. The default (no --run-verify) path spawns nothing.
 */
export async function runVerifyCommands({ planText, opted, runVerify, importBench, importPredict } = {}) {
  const out = []
  let bench
  let predict
  try {
    bench = await loadBench(importBench)
    predict = await loadPredict(importPredict)
  } catch {
    return out // substrate missing → no command handling (fail-open); artifact verdict stands
  }
  const cmds = bench.parseVerifyCommands(planText) || []
  for (const raw of cmds) {
    let inner = raw
    let cwd = null
    try {
      const norm = bench.normalizeVerifyCommand(raw)
      inner = norm.inner
      cwd = norm.cwd
    } catch {
      /* keep raw */
    }
    let safe = false
    try {
      safe = predict.isSafeCommand(inner)
    } catch {
      safe = false
    }
    if (!safe) {
      out.push({ command: raw, inner, status: 'skipped-unsafe' })
      continue
    }
    if (!opted || typeof runVerify !== 'function') {
      out.push({ command: raw, inner, status: 'not-run' })
      continue
    }
    let res
    try {
      res = runVerify(inner, { cwd })
    } catch (err) {
      out.push({ command: raw, inner, status: 'ran', exitCode: 1, error: String((err && err.message) ?? err) })
      continue
    }
    out.push({ command: raw, inner, status: 'ran', exitCode: res?.exitCode ?? 0, stdout: res?.stdout ?? '' })
  }
  return out
}

/**
 * preflightPlan(opts) -> the ONE verdict object. Fail-open: never throws — any error
 * degrades to the conservative `absent` verdict with confidence 'low'.
 *
 * @param {{planPath?:string, planText?:string, readFile?:Function, existsSync?:Function,
 *   rootDir?:string, cwd?:string, runVerify?:Function, optVerify?:boolean,
 *   importBench?:Function, importPredict?:Function}} opts
 * @returns {Promise<{verdict:'built'|'partial'|'absent', code:0|1|2, artifacts:object[],
 *   missing:object[], reconcile?:object[], verify?:object[], confidence:'high'|'low',
 *   planPath:?string, error?:string}>}
 */
export async function preflightPlan(opts = {}) {
  const {
    planPath = null,
    planText = null,
    readFile,
    existsSync,
    rootDir,
    cwd,
    runVerify,
    optVerify = false,
    importBench,
    importPredict,
  } = opts

  try {
    const read = typeof readFile === 'function' ? readFile : DEFAULT_READ
    let text = planText
    if (text == null) {
      if (!planPath) throw new Error('preflightPlan: neither planText nor planPath supplied')
      text = read(planPath, 'utf8')
    }

    const root = rootDir ?? cwd ?? '.'
    const bench = await loadBench(importBench)
    const artifacts = bench.parseMustHaveArtifacts(text) || []
    const results = artifacts.map((a) =>
      checkArtifact({ path: a.path, contains: a.contains, existsSync, readFile: read, rootDir: root }),
    )
    const agg = aggregateVerdict(results)

    let verify = null
    if (optVerify) {
      verify = await runVerifyCommands({
        planText: text,
        opted: true,
        runVerify,
        importBench,
        importPredict,
      })
    }

    return { ...agg, planPath, confidence: 'high', verify }
  } catch (err) {
    // Fail-open C9: conservative absent (execute) — NEVER a false built on doubt.
    return {
      verdict: 'absent',
      code: VERDICT_CODES.absent,
      artifacts: [],
      missing: [],
      confidence: 'low',
      planPath,
      error: String((err && err.message) ?? err),
    }
  }
}
