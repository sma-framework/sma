/**
 * predict.mjs — the P1 prediction engine core (49.1-08, B18; D-49.1-10).
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
 * Security boundary (T-49.1-14, Elevation of Privilege — mitigate): plan files
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
 * Exported so 49.1-09's PRED-* lint reuses the exact same boundary.
 */
export const SAFE_COMMAND_PATTERNS = [
  /^node scripts\/sma\//,
  /^pnpm vitest run /,
  /^pnpm sma /,
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
 * ONLY change vs the original parsePredictions inline scan (49.2-08 T1): the
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
 * is byte-identical to the pre-49.2-08 inline scan — predict.test.ts is the
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
 * Charset guard closing the shell-injection gap the prefix allowlist alone
 * leaves open (T-49.1-14): `node scripts/sma/x.mjs; rm -rf /` matches the
 * prefix but carries shell metacharacters. Only plain words, spaces, and
 * path/flag characters may appear — no ; & | ` $ < > ( ) quotes or newlines.
 */
const SAFE_COMMAND_CHARSET = /^[\w ./=:@-]+$/

/** True when the command matches the anchored allowlist AND the safe charset. */
export function isSafeCommand(command) {
  const cmd = String(command)
  return SAFE_COMMAND_CHARSET.test(cmd) && SAFE_COMMAND_PATTERNS.some((re) => re.test(cmd))
}

/**
 * scorePlan({planPath, runCommand, now}) -> {records, invalid}.
 *
 * For each VALID predictions entry: allowlist check -> run (injected runner)
 * -> numeric last-line parse -> comparator compare. Deterministic; zero LLM;
 * confidence copied into the record verbatim, never read for the verdict.
 * scorePlan itself NEVER throws — a throwing runner or non-numeric output
 * becomes verdict 'error' on that record (fail-open C9).
 *
 * Record shape: {id, domain, metric, claim, check_command, actual, expected,
 * comparator, hit, verdict: 'hit'|'miss'|'skipped-unsafe'|'error',
 * confidence, scoredAt, plan, error?}
 *
 * @param {{planPath: string, runCommand: Function, now?: string}} args
 * @returns {{records: object[], invalid: object[]}}
 */
export function scorePlan({ planPath, runCommand, now }) {
  const { predictions, error } = parsePredictions(planPath)
  const records = []
  const invalid = []
  if (error) return { records, invalid: [{ id: null, missing: [], errors: [error] }] }

  for (const entry of predictions) {
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

    // T-49.1-14: allowlist BEFORE any run — the runner is never invoked for a
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

  return { records, invalid }
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
 * @param {string} args.planId   the plan identity, e.g. '49.1-09'
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
