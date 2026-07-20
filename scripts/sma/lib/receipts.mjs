/**
 * receipts.mjs — STRUCTURAL receipts: the claims schema over the V2 coverage
 * block (9.2-03, D-9.2-06). The single new-CLASS capability of V3.
 *
 * A `done` stops being a sentence and becomes a data structure: a claim
 * {id, assertion, re-runnable check_command, expected hash} that any machine
 * can re-execute and diff. `sma reverify` re-runs every claim across the
 * SAFE_COMMAND boundary — on a fresh clone (only COMMITTED evidence counts) —
 * and reports observed-vs-expected. The RECEIPT-PROSE lint (in lint.mjs) fails
 * any 9.2+ SUMMARY whose machine-verifiable coverage item carries no receipt.
 *
 * SCHEMA (flat frontmatter dash-list `receipts:`), the four locked fields of
 * D-9.2-06 plus this plan's discretion encoding (D-9.2-06 Claude's-discretion):
 *   { id, assertion, check_command, expected_sha256,
 *     expected_exit?, hash_stdout?, coverage_id? }
 *   - id               : receipt identity (unique within the SUMMARY)
 *   - assertion        : the human claim, verbatim (renders in reverify output)
 *   - check_command    : a re-runnable command; MUST pass isSafeCommand
 *   - expected_sha256  : sha256 hex of the canonical OBSERVATION (see below)
 *   - expected_exit    : optional — the observed process exit code, for the record
 *   - hash_stdout      : optional bool — when true the observation includes
 *                        normalized stdout; default false (exit-only receipts
 *                        survive nondeterministic vitest timing noise). Deterministic
 *                        outputs (`--json`, `--count`) SHOULD set hash_stdout true.
 *   - coverage_id      : optional — back-reference to a V2 coverage item {id};
 *                        RECEIPT-PROSE uses it to bind a receipt to a machine-
 *                        verifiable coverage item (human_judgment: false).
 *
 * EVIDENCE ENCODING (the hash is over a canonical OBSERVATION string, not raw
 * bytes): observationOf({exitCode, stdout, hashStdout}) = `exit:<code>` plus,
 * when hashStdout, `\n` + normalizeOutput(stdout). normalizeOutput folds CRLF,
 * strips ANSI, rstrips each line and drops trailing blank lines — so a receipt
 * is stable across shells and terminals. expected_sha256 = sha256(observation),
 * machine-comparable, uniform schema whether or not stdout is hashed.
 *
 * SECURITY BOUNDARY (T-9.2-03-01, Elevation of Privilege — mitigate): receipt
 * check_command strings arrive from SUMMARY files (which may be imported from
 * untrusted sources) and get EXECUTED. The boundary is NOT re-derived here — it
 * is the SAME isSafeCommand + SAFE_COMMAND_PATTERNS imported from predict.mjs
 * (the 9.1-08 single-execution-boundary lock, T-9.1-14 extension). Every path
 * that would run a command — verifyReceipts AND the emit path recordReceipt —
 * gates on isSafeCommand FIRST; a non-matching command scores 'skipped-unsafe'
 * and the runner is NEVER invoked.
 *
 * RUNNER CONTRACT (DI so tests never shell out): runCommand(cmd, {cwd}) ->
 * {stdout, exitCode}. This is RICHER than predict.mjs's string-returning runner
 * on purpose: a receipt must observe a nonzero exit as DATA (a claim can assert
 * a command fails), not as a thrown error. A runner that throws, or returns a
 * shape without a numeric exitCode, scores verdict 'error' — verifyReceipts
 * itself NEVER throws (fail-open C9).
 *
 * FRESH CLONE (freshClone): `git clone --no-hardlinks --quiet <repoRoot>
 * <targetDir>` via the injected git runner. Only COMMITTED receipts exist in a
 * clone — that is the POINT, not a limitation: uncommitted local doctoring is
 * invisible to a fresh-clone reverify by construction (T-9.2-03-03 partial
 * mitigation; the committed-code residual is plan 10's Goodhart layer).
 *
 * Node built-ins only; zero npm deps; zero LLM/network anywhere (substrate law).
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { isSafeCommand, parseFrontmatterEntries } from './predict.mjs'

/** The four locked fields of D-9.2-06 — every receipt MUST carry them. */
export const RECEIPT_REQUIRED_FIELDS = ['id', 'assertion', 'check_command', 'expected_sha256']

/** sha256 hex of a UTF-8 string. */
function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** Coerce a frontmatter scalar to a boolean (true only for the literal 'true'). */
function coerceBool(v) {
  return v === true || String(v ?? '').trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '') === 'true'
}

/**
 * parseReceipts(summaryPath, {readFn?}) -> {receipts, error?}.
 *
 * Delegates the fence scan + dash-list walk to predict.mjs's shared
 * parseFrontmatterEntries keyed to 'receipts' — NEVER a forked parser (the
 * NO-new-YAML-lib lock; one extractor for predictions, consequences AND
 * receipts). Missing file / no fence / no block -> {receipts: []} honest-empty,
 * never a throw (fail-open C9 — reverify is an observer, not a gate).
 *
 * @param {string} summaryPath
 * @param {{readFn?:Function}} [opts]
 * @returns {{receipts: object[], error?: string}}
 */
export function parseReceipts(summaryPath, opts = {}) {
  const { entries, error } = parseFrontmatterEntries(summaryPath, 'receipts', opts)
  return error ? { receipts: entries, error } : { receipts: entries }
}

/**
 * parseCoverage(summaryPath, {readFn?}) -> {coverage}.
 *
 * The V2 `coverage:` block carries NESTED `verification:` sub-lists — 6+-space
 * indented `- kind:` / `ref:` / `status:` lines. parseFrontmatterEntries breaks
 * on that dedent-shape; parseCoverage deliberately TOLERATES it (skips lines
 * indented 6+ spaces, treating them as part of the current entry rather than a
 * block-closer). Extracts ONLY {id, human_judgment} per coverage item.
 * human_judgment absent -> false: a coverage item is machine-verifiable BY
 * DEFAULT and must OPT OUT of receipts, never silently evade them (D-9.2-06).
 *
 * @param {string} summaryPath
 * @param {{readFn?:Function}} [opts]
 * @returns {{coverage: object[], error?: string}}
 */
export function parseCoverage(summaryPath, opts = {}) {
  const readFn = opts.readFn ?? readFileSync
  let text
  try {
    text = readFn(summaryPath, 'utf8')
  } catch (err) {
    return { coverage: [], error: `cannot read ${summaryPath}: ${err && err.message}` }
  }
  text = text.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return { coverage: [] }
  const closeIdx = text.indexOf('\n---\n', 3)
  if (closeIdx === -1) return { coverage: [] }

  const lines = text.slice(4, closeIdx + 1).split('\n')
  let i = 0
  while (i < lines.length && !/^coverage:\s*$/.test(lines[i])) i++
  if (i >= lines.length) return { coverage: [] }
  i++

  const coverage = []
  let current = null
  const scalar = (raw) => String(raw).trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')

  while (i < lines.length) {
    const line = lines[i]
    const entryStart = /^  - ([A-Za-z_][\w-]*):\s?(.*)$/.exec(line) // exactly 2 spaces
    if (entryStart) {
      current = {}
      if (entryStart[1] === 'id') current.id = scalar(entryStart[2])
      else if (entryStart[1] === 'human_judgment') current.human_judgment = coerceBool(entryStart[2])
      coverage.push(current)
    } else if (/^ {6,}/.test(line)) {
      // nested verification sub-list line — skip (NOT a block-closer). This is
      // exactly where parseCoverage differs from parseFrontmatterEntries'
      // break-on-dedent.
    } else {
      const entryCont = /^    ([A-Za-z_][\w-]*):\s?(.*)$/.exec(line) // exactly 4 spaces
      if (entryCont && current) {
        if (entryCont[1] === 'id') current.id = scalar(entryCont[2])
        else if (entryCont[1] === 'human_judgment') current.human_judgment = coerceBool(entryCont[2])
      } else if (line.trim() === '') {
        // blank line inside the block — tolerate
      } else {
        break // dedent / next top-level key closes the block
      }
    }
    i++
  }

  // human_judgment defaults to false (machine-verifiable unless it opts out).
  for (const c of coverage) if (c.human_judgment == null) c.human_judgment = false
  return { coverage }
}

/**
 * validateReceipt(entry) -> {valid, missing, errors}.
 *
 * Required: id/assertion/check_command/expected_sha256. expected_sha256 must be
 * 64 lowercase hex chars; expected_exit, when present, must be numeric. No field
 * is a gate on the assertion prose — the schema is about re-runnability.
 *
 * @param {object} entry
 * @returns {{valid: boolean, missing: string[], errors: string[]}}
 */
export function validateReceipt(entry) {
  const e = entry ?? {}
  const missing = RECEIPT_REQUIRED_FIELDS.filter((k) => e[k] == null || e[k] === '')
  const errors = []
  if (!missing.includes('expected_sha256') && !/^[0-9a-f]{64}$/.test(String(e.expected_sha256))) {
    errors.push(`expected_sha256 "${e.expected_sha256}" is not 64 lowercase hex chars`)
  }
  if (e.expected_exit != null && e.expected_exit !== '' && !Number.isFinite(Number(e.expected_exit))) {
    errors.push(`expected_exit "${e.expected_exit}" is not numeric`)
  }
  return { valid: missing.length === 0 && errors.length === 0, missing, errors }
}

/**
 * normalizeOutput(stdout) -> canonical text: CRLF->LF, strip ANSI CSI escapes,
 * rstrip each line, drop trailing empty lines. Makes a receipt hash stable
 * across shells/terminals for deterministic outputs.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function normalizeOutput(stdout) {
  let s = String(stdout ?? '').replace(/\r\n/g, '\n')
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // strip ANSI CSI sequences
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * observationOf({exitCode, stdout, hashStdout}) -> the canonical observation
 * string that gets hashed. Exit-only by default; stdout folded in (normalized)
 * only when hashStdout. `exit:<code>` is always present so an exit-only receipt
 * is still a real, comparable observation.
 *
 * @param {{exitCode:number, stdout?:string, hashStdout?:boolean}} args
 * @returns {string}
 */
export function observationOf({ exitCode, stdout, hashStdout }) {
  const head = `exit:${exitCode}`
  return hashStdout ? `${head}\n${normalizeOutput(stdout)}` : head
}

/** Run one command through the injected runner; normalize its shape or throw-shape. */
function runOne(runCommand, cmd, cwd) {
  const res = runCommand(cmd, { cwd })
  if (res == null || typeof res !== 'object' || !Number.isFinite(Number(res.exitCode))) {
    throw new Error('runner returned a non-conforming shape (need {stdout, exitCode})')
  }
  return { stdout: res.stdout ?? '', exitCode: Number(res.exitCode) }
}

/**
 * verifyReceipt(entry, {runCommand, cwd, now, summary}) -> one verdict record.
 *
 * Allowlist gate FIRST (T-9.2-03-01) -> run -> recompute observation hash ->
 * compare. Never throws. Verdicts: 'verified' | 'divergent' | 'skipped-unsafe'
 * | 'error'. A divergent record carries BOTH observed_sha256 and
 * expected_sha256 — the observed-vs-expected diff is the product.
 *
 * @param {object} entry a receipt entry (assumed already validateReceipt-valid)
 * @param {{runCommand:Function, cwd?:string, now?:string, summary?:string}} ctx
 * @returns {object}
 */
export function verifyReceipt(entry, { runCommand, cwd, now, summary } = {}) {
  const base = {
    id: entry.id,
    coverage_id: entry.coverage_id ?? null,
    assertion: entry.assertion,
    check_command: entry.check_command,
    expected_sha256: entry.expected_sha256,
    observed_sha256: null,
    exitCode: null,
    scoredAt: now ?? new Date().toISOString(),
    summary: summary ?? null,
    domain: 'sma.receipts',
  }

  // T-9.2-03-01: allowlist BEFORE any run — the runner is never invoked for a
  // non-matching command.
  if (!isSafeCommand(entry.check_command)) {
    return { ...base, verdict: 'skipped-unsafe' }
  }

  let observed
  try {
    observed = runOne(runCommand, entry.check_command, cwd)
  } catch (err) {
    return { ...base, verdict: 'error', error: String((err && err.message) ?? err) }
  }

  const hashStdout = coerceBool(entry.hash_stdout)
  const observed_sha256 = sha256(
    observationOf({ exitCode: observed.exitCode, stdout: observed.stdout, hashStdout }),
  )
  const verdict = observed_sha256 === entry.expected_sha256 ? 'verified' : 'divergent'
  return { ...base, observed_sha256, exitCode: observed.exitCode, verdict }
}

/**
 * verifyReceipts({summaryPath, receipts, runCommand, cwd, now, readFn}) ->
 * {records, invalid}. Parses the SUMMARY's receipts (or uses an injected
 * `receipts` array), validates each, and verifies the valid ones. Deterministic,
 * zero LLM, NEVER throws.
 *
 * @param {object} args
 * @returns {{records: object[], invalid: object[]}}
 */
export function verifyReceipts({ summaryPath, receipts, runCommand, cwd, now, readFn } = {}) {
  const list = Array.isArray(receipts)
    ? receipts
    : parseReceipts(summaryPath, readFn ? { readFn } : {}).receipts
  const records = []
  const invalid = []
  for (const entry of list) {
    const v = validateReceipt(entry)
    if (!v.valid) {
      invalid.push({ id: entry.id ?? null, missing: v.missing, errors: v.errors })
      continue
    }
    records.push(verifyReceipt(entry, { runCommand, cwd, now, summary: summaryPath }))
  }
  return { records, invalid }
}

/**
 * recordReceipt({entry, runCommand, cwd}) -> the entry with expected_sha256 (+
 * expected_exit) filled — the EMIT path executors use at SUMMARY time.
 *
 * Allowlist gate FIRST: refuses (returns {error}) for a non-allowlisted
 * command — forging a receipt for an unrunnable command is structurally
 * impossible (T-9.2-03-03). recordReceipt is the programmatic twin of the
 * `sma receipt-hash` CLI.
 *
 * @param {{entry:object, runCommand:Function, cwd?:string}} args
 * @returns {{receipt?:object, error?:string}}
 */
export function recordReceipt({ entry, runCommand, cwd } = {}) {
  const e = entry ?? {}
  if (!isSafeCommand(e.check_command)) {
    return { error: `check_command "${e.check_command}" is not on the SAFE_COMMAND allowlist — refusing to record` }
  }
  let observed
  try {
    observed = runOne(runCommand, e.check_command, cwd)
  } catch (err) {
    return { error: String((err && err.message) ?? err) }
  }
  const hashStdout = coerceBool(e.hash_stdout)
  const expected_sha256 = sha256(
    observationOf({ exitCode: observed.exitCode, stdout: observed.stdout, hashStdout }),
  )
  return { receipt: { ...e, expected_sha256, expected_exit: observed.exitCode } }
}

/**
 * freshClone({repoRoot, execGit, targetDir}) -> targetDir.
 *
 * `git clone --no-hardlinks --quiet <repoRoot> <targetDir>` via the injected git
 * runner. Only COMMITTED evidence exists in the clone (the point — uncommitted
 * doctoring is invisible). All downstream git/receipt ops run cwd-relative to
 * the returned path (the PRED-POSTEDIT Windows 8.3 short-path lesson).
 *
 * @param {{repoRoot:string, execGit:Function, targetDir:string}} args
 * @returns {string} the clone path
 */
export function freshClone({ repoRoot, execGit, targetDir }) {
  execGit(['clone', '--no-hardlinks', '--quiet', repoRoot, targetDir])
  return targetDir
}
