/**
 * predict.mjs — the P1 prediction engine core (B18; D-9.1-10).
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
 * ONLY change vs the original parsePredictions inline scan (9.2-08 T1): the
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
 * is byte-identical to the pre-9.2-08 inline scan — predict.test.ts is the
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
 * isReceiptEntry(entry) — the receipts discriminator (R1/R2 false class-A
 * lesson, 2026-07-10). A structural receipt pins `expected_sha256` over an
 * observation (the locked D-9.2-06 evidence field); a prediction NEVER
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
 * For each VALID predictions entry: allowlist check -> run (injected runner)
 * -> numeric last-line parse -> comparator compare. Deterministic; zero LLM;
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

    let output
    try {
      output = runCommand(entry.check_command)
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

    const actual = parseNumericLastLine(output)
    if (actual == null) {
      records.push({
        ...base,
        actual: null,
        hit: false,
        verdict: 'error',
        error: 'check_command output has no numeric last line',
      })
      continue
    }

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
 * @param {string} args.planId   the plan identity, e.g. '9.1-09'
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
