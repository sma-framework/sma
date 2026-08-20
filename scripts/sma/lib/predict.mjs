/**
 * predict.mjs — the P1 prediction engine core (B18).
 *
 * A PLAN.md may carry an optional `predictions:` block in frontmatter — a
 * pre-registered, machine-checkable claim set scored DETERMINISTICALLY at
 * verify-time. Zero LLM involvement anywhere in scoring (plan prohibition).
 *
 * Schema per entry (RESEARCH Architecture Pattern 1):
 *   {id, claim, metric, check_command, comparator, threshold, horizon, domain,
 *    confidence?}
 * `confidence` is recorded VERBATIM and NEVER gates a verdict — the
 * verbalized-confidence anti-pattern lock carried forward from V1 (RESEARCH
 * cites systematic LLM overconfidence).
 *
 * Security boundary (Elevation of Privilege — mitigate): plan files
 * can arrive via import from untrusted sources, and check_command strings get
 * executed. SAFE_COMMAND_PATTERNS is the anchored allowlist enforced BEFORE
 * any run; a non-matching command scores 'skipped-unsafe' with the runner
 * never invoked.
 *
 * Parsing note: frontmatter.mjs's parseNote deliberately throws on any nested
 * structure other than `metadata:` (its memory-note contract, B12). The
 * `predictions:` dash-list-of-maps shape therefore gets its OWN narrow
 * line-oriented extractor here — same hand-rolled posture, NO new YAML lib
 * (frontmatter.mjs:1-19 lock), no change to the note parser's loud-throw
 * contract.
 *
 * Node built-ins only; the runner is dependency-injected ({runCommand}) so
 * tests never shell out. Pure functions over injected state (collision.mjs
 * shape).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { serializeNote } from './frontmatter.mjs'

/**
 * Anchored command allowlist — the ONLY shapes a check_command may take.
 * Exported so the PRED-* lint reuses the exact same boundary.
 */
export const SAFE_COMMAND_PATTERNS = [
  /^node scripts\/sma\//,
  /^pnpm vitest run /,
  /^pnpm sma /,
  // Release-gate forms: the package manager running the LOCAL project's own
  // manifest. `test` and `pack` are fixed verbs; `run` takes a script NAME,
  // which resolves in the local package.json — the same trust class as the
  // local scripts/ tree the first pattern already admits (a hostile plan file
  // controls the command string, never the manifest it names). Deliberately
  // absent, and never to be added here: `install`/`add`/`exec`/`npx`/`dlx` —
  // those fetch and execute registry code the local tree never vouched for.
  /^(npm|pnpm|yarn) (test|pack)( |$)/,
  /^(npm|pnpm|yarn) run [\w.:-]+( |$)/,
]

/** The fixed comparator set — anything else fails validation. */
export const COMPARATORS = ['==', '!=', '>=', '<=', '>', '<']

/** Required fields of a predictions entry (PRED-NOMETRIC superset). */
const REQUIRED_FIELDS = [
  'id',
  'claim',
  'metric',
  'check_command',
  'comparator',
  'threshold',
  'horizon',
  'domain',
]

/** Strip one layer of surrounding quotes (frontmatter.mjs unquote posture). */
function unquote(v) {
  const t = String(v).trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** Strip a trailing `# comment` from an UNQUOTED scalar, then unquote. */
function scalarValue(raw) {
  const t = String(raw).trim()
  if (t.startsWith('"') || t.startsWith("'")) return unquote(t)
  const noComment = t.replace(/\s+#.*$/, '')
  const un = unquote(noComment)
  // Coerce fully-numeric scalars so threshold/confidence arrive as numbers.
  if (un !== '' && /^-?\d+(\.\d+)?$/.test(un)) return Number(un)
  return un
}

/**
 * parseFrontmatterEntries(planPath, key, opts) -> {entries, error?}.
 *
 * The generalized dash-list-of-maps frontmatter reader: locates the leading
 * `---` fence, finds the top-level `<key>:` line, and parses its entries:
 *   `  - key: value` starts an entry; `    key: value` continues it; the
 * first line outside that indentation closes the block. Missing file, no
 * fence, or no block -> honest empty array, never a throw (fail-open C9 — the
 * consumers are observers, not gates). Parameterizing the top-level key is the
 * ONLY change vs the original parsePredictions inline scan: the
 * `predictions:` and `consequences:` blocks share one narrow extractor rather
 * than two hand-rolled copies.
 *
 * @param {string} planPath
 * @param {string} key  the top-level frontmatter key whose dash-list to parse
 * @param {{readFn?:Function}} [opts]
 * @returns {{entries: object[], error?: string}}
 */
export function parseFrontmatterEntries(planPath, key, opts = {}) {
  const readFn = opts.readFn ?? readFileSync
  let text
  try {
    text = readFn(planPath, 'utf8')
  } catch (err) {
    return { entries: [], error: `cannot read ${planPath}: ${err && err.message}` }
  }
  // Normalize CRLF so the fence/indent scans see one shape.
  text = text.replace(/\r\n/g, '\n')

  if (!text.startsWith('---\n')) return { entries: [] }
  const closeIdx = text.indexOf('\n---\n', 3)
  if (closeIdx === -1) return { entries: [] }

  const lines = text.slice(4, closeIdx + 1).split('\n')
  const entries = []
  let i = 0

  // Find the top-level `<key>:` line.
  const keyRe = new RegExp(`^${key}:\\s*$`)
  while (i < lines.length && !keyRe.test(lines[i])) i++
  if (i >= lines.length) return { entries: [] }
  i++

  let current = null
  while (i < lines.length) {
    const line = lines[i]
    const entryStart = /^  - ([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
    const entryCont = /^    ([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
    if (entryStart) {
      current = { [entryStart[1]]: scalarValue(entryStart[2]) }
      entries.push(current)
    } else if (entryCont && current) {
      current[entryCont[1]] = scalarValue(entryCont[2])
    } else if (line.trim() === '') {
      // blank line inside the block — tolerate
    } else {
      break // dedent / next top-level key closes the block
    }
    i++
  }

  return { entries }
}

/**
 * parsePredictions(planPath, opts) -> {predictions, error?}.
 *
 * Thin wrapper over parseFrontmatterEntries keyed to 'predictions'. Behavior
 * is byte-identical to the original inline scan — predict.test.ts is the
 * regression proof.
 *
 * @param {string} planPath
 * @param {{readFn?:Function}} [opts]
 * @returns {{predictions: object[], error?: string}}
 */
export function parsePredictions(planPath, opts = {}) {
  const { entries, error } = parseFrontmatterEntries(planPath, 'predictions', opts)
  return error ? { predictions: entries, error } : { predictions: entries }
}

/**
 * validatePrediction(entry) -> {valid, missing, errors}.
 *
 * Required fields: id/claim/metric/check_command/comparator/threshold/
 * horizon/domain. comparator must be in the fixed set; threshold must be
 * numeric. `confidence` is OPTIONAL and never validated as a gate — it is
 * data, not a signal.
 *
 * @param {object} entry
 * @returns {{valid: boolean, missing: string[], errors: string[]}}
 */
export function validatePrediction(entry) {
  const e = entry ?? {}
  const missing = REQUIRED_FIELDS.filter((k) => e[k] == null || e[k] === '')
  const errors = []
  if (!missing.includes('comparator') && !COMPARATORS.includes(e.comparator)) {
    errors.push(`comparator "${e.comparator}" not in [${COMPARATORS.join(', ')}]`)
  }
  if (!missing.includes('threshold') && !Number.isFinite(Number(e.threshold))) {
    errors.push(`threshold "${e.threshold}" is not numeric`)
  }
  // `measure` is OPTIONAL — absent means the historical last-line reading, so
  // every entry written before the field existed stays valid. When present it
  // must name one of the two known ways: a typo falling back silently would
  // turn an exit-code claim into a guaranteed non-verdict, which is the very
  // failure this field was added to end.
  if (e.measure != null && e.measure !== '' && !MEASURES.includes(String(e.measure))) {
    errors.push(`measure "${e.measure}" not in [${MEASURES.join(', ')}]`)
  }
  return { valid: missing.length === 0 && errors.length === 0, missing, errors }
}

/** Parse the numeric LAST non-empty line of a command's output -> number|null. */
function parseNumericLastLine(output) {
  const lines = String(output ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return null
  const last = lines[lines.length - 1]
  if (!/^-?\d+(\.\d+)?$/.test(last)) return null
  return Number(last)
}

/** Deterministic numeric compare — the ONLY verdict signal (never confidence). */
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
 * The two ways a check_command can state a FACT.
 *
 * `last-line` (the default, and the ONLY behaviour before this) reads the
 * numeric last line of the output. `exit-code` reads the process exit code.
 * Omitting the field means `last-line`, so every prediction written before the
 * field existed behaves byte for byte as it did.
 *
 * Why the second one exists: the scorer's runner used to throw on a nonzero
 * exit, so «the suite is green» produced 'error' when the suite failed and
 * 'error' when it passed (no numeric last line). A claim that cannot be WRONG
 * is not a claim — the mechanism built to catch our mistakes could not catch
 * one. The exit code is DATA, and reading it costs the command allowlist
 * nothing: not one character of SAFE_COMMAND_CHARSET or SAFE_COMMAND_PATTERNS
 * moves for it.
 */
export const MEASURE_LAST_LINE = 'last-line'
export const MEASURE_EXIT_CODE = 'exit-code'
export const MEASURES = [MEASURE_LAST_LINE, MEASURE_EXIT_CODE]

/**
 * RUN_BUDGET_MS — the wall-clock budget one check_command is given.
 *
 * THIRTY MINUTES, and the number is named here rather than buried at every
 * call site, because the previous budget was TWO minutes and that is smaller
 * than the thing this runner is most often asked to measure. This product's
 * own suite (170 files, ~3665 cases) was measured TWICE: 134 seconds on an
 * idle machine and 715 seconds with other work running beside it. A budget
 * below the measured thing does not measure — it manufactures a failure and
 * files it as an observation about the world; a budget that merely clears the
 * idle case does the same thing on a busy day. Thirty minutes clears the
 * loaded measurement with room, and a genuinely hung command is still cut off
 * rather than waited on forever.
 */
export const RUN_BUDGET_MS = 1_800_000

/**
 * runResultFromExecError(err) -> {stdout, exitCode, notMeasured}.
 *
 * The one place a failed child process is read, and the whole point of it is
 * the distinction the old inline `err.status ?? 1` erased:
 *
 *   - the command RAN and exited nonzero -> that code is DATA. A claim about
 *     it can be right or wrong, and a wrong one is a MISS. Nothing here
 *     softens that.
 *   - the command NEVER FINISHED (killed by the time budget, killed by a
 *     signal, never started at all) -> there is no exit code in existence.
 *     `status` is null and `signal`/`code` say why. Substituting 1 turns «I
 *     could not measure» into «you were wrong» — a sentence about the world
 *     that nobody observed.
 *
 * The discriminator is taken from the RUN ITSELF (signal / missing status /
 * the ETIMEDOUT code), never guessed from the text of the output. The command
 * allowlist is untouched by any of this: a budget and a kill signal are data
 * about a process, not characters in a string handed to a shell.
 */
export function runResultFromExecError(err) {
  const e = err ?? {}
  const status = e.status
  const signal = e.signal
  const code = e.code
  let notMeasured = null
  if (code === 'ETIMEDOUT') notMeasured = 'timeout'
  else if (signal) notMeasured = `signal:${String(signal)}`
  else if (status == null) notMeasured = 'did-not-start'
  return {
    stdout: String(e.stdout == null ? '' : e.stdout),
    exitCode: notMeasured ? null : Number(status),
    notMeasured,
  }
}

/**
 * makeExecRunner({execSync, cwd, timeoutMs}) -> runCommand(cmd, {cwd}).
 *
 * The ONE runner every verdict-producing verb builds from, so that the same
 * kill by the same budget can never be read one way by the scorer and another
 * way by the mirror or by re-verification. The working directory arrives as a
 * PARAMETER, exactly as before; it is never spliced into the command string.
 */
export function makeExecRunner({ execSync, cwd, timeoutMs } = {}) {
  const budget = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : RUN_BUDGET_MS
  return (cmd, o = {}) => {
    try {
      const stdout = execSync(cmd, { encoding: 'utf8', timeout: budget, cwd: o.cwd ?? cwd ?? process.cwd() })
      return { stdout, exitCode: 0, notMeasured: null }
    } catch (err) {
      return runResultFromExecError(err)
    }
  }
}

/** The declared measure of an entry, defaulting to the historical one. */
export function measureOf(entry) {
  const m = String((entry && entry.measure) != null ? entry.measure : '').trim()
  return m === '' ? MEASURE_LAST_LINE : m
}

/**
 * Run options for an entry — the ONLY channel the working directory travels.
 *
 * `cwd` is a FIELD of the record and is handed to the runner as a parameter.
 * It is NEVER concatenated into the command string: a joined `cd X && cmd`
 * would put a shell metacharacter inside the trust boundary, which is exactly
 * what the allowlist exists to refuse — and still refuses (the reverse tests
 * pin it). Precedent: the receipt-hash verb already takes a --cwd of its own,
 * so this is the existing semantics, not a new concept.
 */
export function runOptions(entry) {
  const cwd = entry && entry.cwd
  return cwd == null || String(cwd).trim() === '' ? {} : { cwd: String(cwd) }
}

/**
 * normalizeRunResult(res) -> {stdout, exitCode}.
 *
 * A runner may report both halves of a run ({stdout, exitCode} — the posture
 * the receipts runner has always had) or output only (a plain string, the
 * historical shape). Output-only reporting yields exitCode `null`: «not
 * observed», which is honestly different from zero.
 */
export function normalizeRunResult(res) {
  if (res && typeof res === 'object' && 'stdout' in res) {
    const code = Number(res.exitCode)
    // «The run never finished» outranks any exit code the shape may carry:
    // there is nothing to report, and reporting anything would be an
    // observation nobody made. Note that WITHOUT this branch a null exitCode
    // coerces to 0 — a killed process would read as a clean success.
    const notMeasured =
      res.notMeasured == null || String(res.notMeasured).trim() === '' ? null : String(res.notMeasured)
    return {
      stdout: String(res.stdout == null ? '' : res.stdout),
      exitCode: notMeasured ? null : Number.isFinite(code) ? code : null,
      notMeasured,
    }
  }
  return { stdout: String(res == null ? '' : res), exitCode: null, notMeasured: null }
}

/**
 * factFromRun(entry, res) -> {actual, error}.
 *
 * The single place a run becomes a number, shared by the scorer and the blind
 * mirror so the two sides can never measure the same claim differently. A
 * runner that reports output only cannot answer an exit-code claim: that is an
 * ERROR and says so, rather than quietly passing zero off as an observation.
 */
export function factFromRun(entry, res) {
  const { stdout, exitCode, notMeasured } = normalizeRunResult(res)
  // A run that never finished yields no fact under EITHER measure: neither a
  // wrong exit code nor a wrong number on the last line. It is «could not
  // measure», and it says so with the reason attached.
  if (notMeasured) {
    return {
      actual: null,
      error: `the run did not complete (${notMeasured}) — the check was not measured, so this is no observation about the world`,
      notMeasured,
    }
  }
  if (measureOf(entry) === MEASURE_EXIT_CODE) {
    if (exitCode == null) {
      return {
        actual: null,
        error: 'measure exit-code needs a runner reporting {stdout, exitCode}; got output only',
      }
    }
    return { actual: exitCode, error: null }
  }
  const n = parseNumericLastLine(stdout)
  if (n == null) return { actual: null, error: 'check_command output has no numeric last line' }
  return { actual: n, error: null }
}

/**
 * isReceiptEntry(entry) — the receipts discriminator (R1/R2 false class-A
 * lesson, 2026-07-10). A structural receipt pins `expected_sha256` over an
 * observation (the locked evidence field); a prediction NEVER
 * carries it — its expectation is a numeric `threshold`. A receipt is a
 * BUILD-TIME claim: re-scoring it later as a standing prediction against
 * ACCRUING .sma state (e.g. `subagent-receipts --json` output) is a guaranteed
 * drift-miss that opens a false class-A event. Receipts are `sma reverify`
 * territory — predict-score writes NO verdict for them, even when one is
 * misfiled under `predictions:` (field-completion cannot make it scoreable:
 * this check runs BEFORE validation).
 */
export function isReceiptEntry(entry) {
  const e = entry ?? {}
  return e.expected_sha256 != null && e.expected_sha256 !== ''
}

/**
 * Charset guard closing the shell-injection gap the prefix allowlist alone
 * leaves open: `node scripts/sma/x.mjs; rm -rf /` matches the
 * prefix but carries shell metacharacters. Only plain words, spaces, and
 * path/flag characters may appear — no ; & | ` $ < > ( ) quotes or newlines.
 */
const SAFE_COMMAND_CHARSET = /^[\w ./=:@-]+$/

/** True when the command matches the anchored allowlist AND the safe charset. */
export function isSafeCommand(command) {
  const cmd = String(command)
  return SAFE_COMMAND_CHARSET.test(cmd) && SAFE_COMMAND_PATTERNS.some((re) => re.test(cmd))
}

/** A calendar horizon: `2026-08-01`, with or without a trailing time part. */
const DATE_HORIZON_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/
/** A version horizon in the release-tag spelling: `V3.2`, `v3.2.1`, `3.2`. */
const VERSION_HORIZON_RE = /^[Vv]?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

/** Parse a version horizon into comparable parts, or null when it is not one. */
function versionParts(s) {
  const m = VERSION_HORIZON_RE.exec(String(s ?? '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/**
 * horizonReached(horizon, {now, currentVersion}) -> true | false | null.
 *
 * A prediction states WHEN its claim comes due. Scoring one whose horizon has
 * not arrived manufactures a verdict about a future the check cannot see — and
 * two scorers doing it independently manufacture a DISAGREEMENT about it, which
 * is how a not-yet-due claim once blocked a release as a false divergence.
 *
 * The gate is deliberately timid, because a wrong skip hides a real miss:
 *   - `false` ONLY when the horizon is unambiguously ahead — a calendar date
 *     later than today, or a version greater than the current one;
 *   - `true` when it is parseable and has arrived;
 *   - `null` for everything else — no horizon, prose («after the next release»),
 *     or a version horizon with no current version to compare against. `null`
 *     means "cannot tell", and the caller keeps its existing behaviour: score it.
 *
 * @param {string} horizon
 * @param {{now?:string, currentVersion?:string}} [ctx]
 * @returns {boolean|null}
 */
export function horizonReached(horizon, { now, currentVersion } = {}) {
  const h = String(horizon ?? '').trim()
  if (h === '') return null

  const dm = DATE_HORIZON_RE.exec(h)
  if (dm) {
    const today = String(now ?? new Date().toISOString()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
    return dm[1] <= today
  }

  const hv = versionParts(h)
  if (hv) {
    const cv = versionParts(currentVersion)
    if (!cv) return null // nothing to compare against — not a skip, just unknown
    for (let i = 0; i < 3; i += 1) {
      if (hv[i] !== cv[i]) return hv[i] < cv[i]
    }
    return true // the horizon IS the current version — it has arrived
  }

  return null // prose horizon — unchanged behaviour
}

/**
 * scorePlan({planPath, runCommand, now, currentVersion}) -> {records, invalid,
 * excluded, notDue}.
 *
 * Scores plan-frontmatter `predictions:` entries ONLY — the `receipts:` block
 * (a SUMMARY's build-time structural claims) is NEVER consumed
 * here; re-verifying receipts is `sma reverify`'s territory (R1/R2 false
 * class-A lesson, 2026-07-10). A receipt-shaped entry misfiled inside
 * `predictions:` (see isReceiptEntry) lands in `excluded` with NO verdict and
 * the runner never invoked.
 *
 * For each VALID predictions entry: allowlist check -> run (injected runner,
 * given the entry's optional `cwd` as a run PARAMETER) -> fact (the numeric
 * last line by default, the process exit code when `measure: exit-code`) ->
 * comparator compare. Deterministic; zero LLM;
 * confidence copied into the record verbatim, never read for the verdict.
 * scorePlan itself NEVER throws — a throwing runner or non-numeric output
 * becomes verdict 'error' on that record (fail-open C9).
 *
 * An entry whose `horizon` has not arrived (see horizonReached) lands in
 * `notDue` with NO verdict and the runner never invoked — it is registered and
 * awaiting its horizon, which is a different thing from having been checked.
 *
 * Record shape: {id, domain, metric, claim, check_command, actual, expected,
 * comparator, hit, verdict: 'hit'|'miss'|'skipped-unsafe'|'error',
 * confidence, scoredAt, plan, error?}
 *
 * @param {{planPath: string, runCommand: Function, now?: string, currentVersion?: string}} args
 * @returns {{records: object[], invalid: object[], excluded: object[], notDue: object[]}}
 */
export function scorePlan({ planPath, runCommand, now, currentVersion }) {
  const { predictions, error } = parsePredictions(planPath)
  const records = []
  const invalid = []
  const excluded = []
  const notDue = []
  if (error) return { records, invalid: [{ id: null, missing: [], errors: [error] }], excluded, notDue }

  for (const entry of predictions) {
    // Receipts are reverify's territory — excluded BEFORE validation so no
    // field-completion can ever turn a receipt into a scoreable prediction.
    if (isReceiptEntry(entry)) {
      excluded.push({
        id: entry.id ?? null,
        reason: 'receipt',
        assertion: entry.assertion ?? entry.claim ?? null,
      })
      continue
    }

    const v = validatePrediction(entry)
    if (!v.valid) {
      invalid.push({ id: entry.id ?? null, missing: v.missing, errors: v.errors })
      continue
    }

    const base = {
      id: entry.id,
      domain: entry.domain,
      metric: entry.metric,
      claim: entry.claim,
      check_command: entry.check_command,
      expected: Number(entry.threshold),
      comparator: entry.comparator,
      confidence: entry.confidence ?? null, // recorded verbatim — NEVER gates
      measure: measureOf(entry),
      cwd: entry.cwd ?? null,
      scoredAt: now ?? new Date().toISOString(),
      plan: planPath,
    }

    // Horizon gate BEFORE any run: a claim whose due date has not arrived gets
    // no verdict at all — not a hit, not a miss, not an error. It stays
    // registered and becomes scoreable the moment the horizon does arrive.
    if (horizonReached(entry.horizon, { now: base.scoredAt, currentVersion }) === false) {
      notDue.push({
        id: entry.id,
        horizon: entry.horizon,
        claim: entry.claim ?? null,
        reason: 'horizon-not-reached',
      })
      continue
    }

    // allowlist BEFORE any run — the runner is never invoked for a
    // non-matching command.
    if (!isSafeCommand(entry.check_command)) {
      records.push({ ...base, actual: null, hit: false, verdict: 'skipped-unsafe' })
      continue
    }

    let ran
    try {
      // The working directory travels as a PARAMETER (runOptions) — never as
      // a connector glued into the command string.
      ran = runCommand(entry.check_command, runOptions(entry))
    } catch (err) {
      records.push({
        ...base,
        actual: null,
        hit: false,
        verdict: 'error',
        error: String((err && err.message) ?? err),
      })
      continue
    }

    // A nonzero exit is an OBSERVATION, not a crash: the runner hands back both
    // halves of the run, so a failing check can finally be a MISS with a number
    // instead of an error that says nothing.
    const fact = factFromRun(entry, ran)
    if (fact.error) {
      records.push({
        ...base,
        actual: null,
        hit: false,
        verdict: 'error',
        error: fact.error,
        // Present ONLY when the run itself never finished, so the ledger can
        // be read apart later: «could not measure» is not «was wrong».
        ...(fact.notMeasured ? { not_measured: fact.notMeasured } : {}),
      })
      continue
    }

    const actual = fact.actual
    const hit = compare(actual, entry.comparator, base.expected)
    records.push({ ...base, actual, hit, verdict: hit ? 'hit' : 'miss' })
  }

  return { records, invalid, excluded, notDue }
}

/**
 * draftLessonFromMiss({verdict, planId, dirs}) -> {drafted, path}.
 *
 * A scorer MISS auto-DRAFTS a bug-lesson candidate (B19) — DRAFT ONLY, never
 * auto-committed to the corpus (RESEARCH anti-pattern lock). Drafts land in
 * `.claude/memory/drafts/` which the generator/loader DO NOT index (their
 * note discovery lists only top-level *.md files); the ONLY path into the
 * corpus is the reviewed promotion gate documented in the draft header.
 *
 * Idempotent: an existing draft (possibly human-edited pre-promotion) is
 * NEVER overwritten — the re-run returns {drafted:false} and leaves it alone.
 * A non-miss verdict drafts nothing (a hit is not a surprise).
 *
 * @param {object} args
 * @param {object} args.verdict  a scorePlan record ({verdict:'miss', id, claim, ...})
 * @param {string} args.planId   the plan identity, e.g. '3.1-09'
 * @param {{draftsDir?:string}} [args.dirs]  DI dir (default .claude/memory/drafts)
 * @returns {{drafted: boolean, path: string|null}}
 */
export function draftLessonFromMiss({ verdict, planId, dirs = {} }) {
  if (!verdict || verdict.verdict !== 'miss') return { drafted: false, path: null }

  const draftsDir = dirs.draftsDir ?? join('.claude', 'memory', 'drafts')
  const path = join(draftsDir, `bug-lesson-${planId}-${verdict.id}.md`)
  if (existsSync(path)) return { drafted: false, path }

  const predictedFrom = `${planId}-${verdict.id}`
  const frontmatter = {
    description: `DRAFT bug-lesson: prediction ${verdict.id} in plan ${planId} missed — ${verdict.claim}`,
    kind: 'bug-lesson',
    // Placeholder facet — the promoter sets real canonical tags at review time.
    tags: ['workflow'],
    'use-when': `reviewing the missed prediction ${verdict.id} of plan ${planId}`,
    importance: 5,
    predicted_from: predictedFrom,
  }

  const actual = verdict.actual == null ? '—' : String(verdict.actual)
  const body = [
    '',
    '<!--',
    '  DRAFT — NOT part of the memory corpus. Auto-drafted from a prediction MISS.',
    `  predicted_from: ${predictedFrom}`,
    '',
    '  PROMOTION GATE (all 3 conditions, reviewed by a human/agent — the ONLY path in):',
    '    1. a verified fix exists (the mechanism was actually corrected, not just observed);',
    '    2. the failure is named (one-sentence mechanism, not a raw incident log);',
    '    3. the dead-end is ruled out (the miss was not a broken check_command or fixture).',
    '  Promote = move this file OUT of drafts/ into .claude/memory/, canonicalize the',
    '  tags, and fill the stubs below — MEM-BUGLESSON lint then applies in full.',
    '-->',
    '',
    '## Что предсказывали (what was predicted)',
    '',
    `${verdict.claim} — \`${verdict.metric} ${verdict.comparator} ${verdict.expected}\` via \`${verdict.check_command}\`.`,
    '',
    '## Что произошло (what actually happened)',
    '',
    `Факт: \`${actual}\` (verdict: miss, scored ${verdict.scoredAt ?? '—'}).`,
    '',
    '## Подозреваемый механизм (suspected mechanism)',
    '',
    '_TODO: name the mechanism, not the incident._',
    '',
    '**Why:** _TODO — why does this failure mode exist; what invariant broke._',
    '',
    '**How to apply:** _TODO — the rule a future agent follows to avoid the burn._',
    '',
  ].join('\n')

  mkdirSync(draftsDir, { recursive: true })
  writeFileSync(path, serializeNote({ frontmatter, body }), 'utf8')
  return { drafted: true, path }
}

/**
 * draftLessonsForRecords({records, planId, dirs, draft}) -> [{id, path, drafted}].
 *
 * The ONE place that decides which verdicts deserve a lesson draft, so the
 * decision can be tested by counting calls instead of by reading a loop.
 * ONLY a `miss` drafts. A hit is not a surprise; a skipped command is not a
 * verdict; and a run that never finished (verdict 'error' carrying
 * `not_measured`) is the case this gate exists for — a lesson drafted from a
 * failure that never happened would be a lesson that should not exist, and
 * the flywheel would start by teaching a falsehood.
 *
 * Drafting stays best-effort: a failing drafter never blocks scoring.
 *
 * @param {{records?: object[], planId?: string, dirs?: object, draft?: Function}} args
 * @returns {{id: string, path: string, drafted: boolean}[]}
 */
export function draftLessonsForRecords({ records = [], planId, dirs = {}, draft = draftLessonFromMiss } = {}) {
  const out = []
  for (const r of records) {
    if (!r || r.verdict !== 'miss') continue
    try {
      const d = draft({ verdict: r, planId, dirs })
      if (d && d.path) out.push({ id: r.id, path: d.path, drafted: d.drafted })
    } catch {
      /* drafting is best-effort — a failed draft never blocks scoring */
    }
  }
  return out
}
