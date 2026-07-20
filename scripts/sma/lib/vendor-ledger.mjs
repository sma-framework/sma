/**
 * vendor-ledger.mjs — the standing Anthropic-update triage ledger linter
 * (9.4-01, BL-160; §3.4 of 9.4-RESEARCH).
 *
 * The founder's standing mandate mechanized: every Anthropic dev update becomes
 * ONE append-only row in docs/VENDOR-LEDGER.md carrying a mandatory verdict
 * (CORE-threat|BRIDGE-candidate|ABSORB|IRRELEVANT|WATCH) and a mandatory
 * disposition (a BL-id, a tripwire P-id, or `none`). This module is the
 * deterministic READER/LINTER that keeps those rows honest — it never writes a
 * verdict itself (a verdict is a human judgment) and it never touches the
 * network (the ledger is written by whoever read the release notes; the verb
 * only counts and lints).
 *
 * CONSUME-NEVER-REIMPLEMENT (D-9.3-02), the house patterns this mirrors:
 *   - journal.mjs's tolerant-reader posture: a missing/corrupt ledger never
 *     throws — a missing file is a warning + empty rows, a malformed table line
 *     is skip-and-counted into `errors`.
 *   - upstream.mjs's DI convention: every input is injected ({ ledgerPath,
 *     readFile }) so tests never touch the real docs/ tree or the network.
 *   - predict.mjs's numeric-last-line scorer contract: countUntriaged() is the
 *     bare number `sma vendor --count untriaged` prints as its last stdout line.
 *   - lint.mjs's violation shape { rule, field, message }.
 *
 * SUBSTRATE LAW: Node built-ins only. Zero LLM, zero network, zero
 * child_process. The DI'd-fetch convenience from upstream.mjs is deliberately
 * NOT in v1 — a `--check-releases` path would go through that review pattern
 * later, never here.
 */

import { readFileSync } from 'node:fs'

/**
 * LEDGER_VERDICTS — the §3.4 verdict vocabulary, byte-exact and frozen. A row's
 * verdict cell must be one of these (or it is a VENDOR-SCHEMA violation).
 * @type {readonly string[]}
 */
export const LEDGER_VERDICTS = Object.freeze([
  'CORE-threat',
  'BRIDGE-candidate',
  'ABSORB',
  'IRRELEVANT',
  'WATCH',
])

/** The two legal runtime cells — where the vendor capability lives. */
export const LEDGER_RUNTIMES = Object.freeze(['api', 'claude-code'])

/** The heading under which the append-only table lives. */
const LEDGER_HEADING_RE = /^##\s+Ledger\s*$/

/** A markdown table separator row: only |, -, :, and spaces. */
const SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/

/** The seven ordered columns of a ledger row. */
const COLUMNS = ['date', 'source', 'capability', 'runtime', 'verdict', 'disposition', 'triagedBy']

/** Split a markdown table line into trimmed cells (leading/trailing pipe stripped). */
function splitCells(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/**
 * parseLedger({ ledgerPath, readFile }) -> { rows, errors, warnings }.
 *
 * Parses the markdown table under the `## Ledger` heading of
 * docs/VENDOR-LEDGER.md into one row per sighting. TOLERANT (journal.mjs
 * posture): a missing/unreadable file yields empty rows + a warning and never
 * throws; a table line with the wrong column count lands in `errors` while
 * every valid row still parses; a file with no `## Ledger` section is a warning.
 *
 * readFile is INJECTED (tests pass a fixture string returner); production
 * defaults to node:fs readFileSync. ledgerPath is passed through to readFile.
 *
 * Row shape: { date, source, capability, runtime, verdict, disposition,
 * triagedBy, line, raw }.
 *
 * @param {{ledgerPath:string, readFile?:Function}} opts
 * @returns {{rows:object[], errors:object[], warnings:string[]}}
 */
export function parseLedger({ ledgerPath, readFile = readFileSync } = {}) {
  const rows = []
  const errors = []
  const warnings = []

  let text
  try {
    text = readFile(ledgerPath, 'utf8')
  } catch (err) {
    warnings.push(`ledger not readable at ${ledgerPath}: ${String((err && err.message) || err)}`)
    return { rows, errors, warnings }
  }

  const lines = String(text).replace(/\r\n/g, '\n').split('\n')

  // Find the `## Ledger` heading, then read every table line until the next
  // `##` heading (or EOF). Header + separator rows are skipped.
  let i = 0
  while (i < lines.length && !LEDGER_HEADING_RE.test(lines[i])) i++
  if (i >= lines.length) {
    warnings.push('no `## Ledger` section found — the ledger is empty or malformed')
    return { rows, errors, warnings }
  }
  i++ // step past the heading

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line)) break // next section closes the table
    if (line.trim() === '') continue
    if (!line.trim().startsWith('|')) continue // non-table prose inside the section
    if (SEPARATOR_RE.test(line)) continue // the |---|---| rule

    const cells = splitCells(line)
    // The header row carries the literal column label in cell 0.
    if (cells[0].toLowerCase() === 'date') continue

    if (cells.length !== COLUMNS.length) {
      errors.push({
        line: i + 1,
        raw: line,
        message: `expected ${COLUMNS.length} columns, found ${cells.length}`,
      })
      continue
    }

    const row = { line: i + 1, raw: line }
    COLUMNS.forEach((col, idx) => {
      row[col] = cells[idx]
    })
    rows.push(row)
  }

  return { rows, errors, warnings }
}

/** A finding factory — mirrors lint.mjs's { rule, field, message } shape. */
function violation(rule, field, message) {
  return { rule, field, message }
}

/** A short human label for a row, used inside violation messages. */
function rowLabel(row) {
  const src = row.source || '(no source)'
  const cap = row.capability || '(no capability)'
  return `${src} — ${cap}`
}

/**
 * lintLedger(rows) -> { ok, violations }.
 *
 * Two rules:
 *   - VENDOR-UNTRIAGED: an empty verdict OR an empty disposition (the row was
 *     never triaged — the whole point of the ledger is that it cannot ship in
 *     this state).
 *   - VENDOR-SCHEMA: a non-empty verdict token outside LEDGER_VERDICTS, a
 *     runtime outside LEDGER_RUNTIMES, or a missing date/source.
 *
 * Judgment stays human: the linter enforces PRESENCE + shape, never the verdict
 * itself.
 *
 * @param {object[]} rows
 * @returns {{ok:boolean, violations:object[]}}
 */
export function lintLedger(rows) {
  const violations = []
  for (const row of rows || []) {
    const label = rowLabel(row)
    const verdict = (row.verdict ?? '').trim()
    const disposition = (row.disposition ?? '').trim()
    const runtime = (row.runtime ?? '').trim()
    const date = (row.date ?? '').trim()
    const source = (row.source ?? '').trim()

    // VENDOR-UNTRIAGED — the row exists but has no judgment/disposition yet.
    if (verdict === '') {
      violations.push(violation('VENDOR-UNTRIAGED', 'verdict', `row "${label}" has no verdict — a sighting must carry a ${LEDGER_VERDICTS.join('|')} verdict`))
    } else if (!LEDGER_VERDICTS.includes(verdict)) {
      // A non-empty but unknown token is a schema error, not an untriaged row.
      violations.push(violation('VENDOR-SCHEMA', 'verdict', `row "${label}" has unknown verdict "${verdict}" — must be one of ${LEDGER_VERDICTS.join('|')}`))
    }
    if (disposition === '') {
      violations.push(violation('VENDOR-UNTRIAGED', 'disposition', `row "${label}" has no disposition — record a BL-id, a tripwire P-id, or "none"`))
    }

    // VENDOR-SCHEMA — structural fields.
    if (date === '') {
      violations.push(violation('VENDOR-SCHEMA', 'date', `row "${label}" is missing a date`))
    }
    if (source === '') {
      violations.push(violation('VENDOR-SCHEMA', 'source', `row "${label}" is missing a source`))
    }
    if (runtime !== '' && !LEDGER_RUNTIMES.includes(runtime)) {
      violations.push(violation('VENDOR-SCHEMA', 'runtime', `row "${label}" has bad runtime "${runtime}" — must be one of ${LEDGER_RUNTIMES.join('|')}`))
    }
  }
  return { ok: violations.length === 0, violations }
}

/**
 * countUntriaged(rows) -> number. The bare count behind the scorer contract:
 * rows with an empty verdict OR an empty disposition. This is the number
 * `sma vendor --count untriaged` prints as its last stdout line and the value
 * the ship gate blocks on.
 *
 * @param {object[]} rows
 * @returns {number}
 */
export function countUntriaged(rows) {
  let n = 0
  for (const row of rows || []) {
    const verdict = (row.verdict ?? '').trim()
    const disposition = (row.disposition ?? '').trim()
    if (verdict === '' || disposition === '') n += 1
  }
  return n
}

// ── selftest: the linter proves itself against an inline fixture pair ─────────

const SELFTEST_HEADER = '| date | source | capability | runtime | verdict | disposition | triaged-by |'
const SELFTEST_SEP = '|---|---|---|---|---|---|---|'

/** An untriaged fixture — one row is missing its verdict, so lint MUST fail. */
const SELFTEST_UNTRIAGED = [
  '## Ledger',
  '',
  SELFTEST_HEADER,
  SELFTEST_SEP,
  '| 2026-07-10 | S1 multi-agent | hub-and-spoke, 20 agents | api | IRRELEVANT | none | selftest |',
  '| 2026-07-10 | S6 grader opacity | outcomes grader is opaque | api |  | none | selftest |',
  '',
].join('\n')

/** A fully-triaged fixture — every row carries a verdict + disposition. */
const SELFTEST_TRIAGED = [
  '## Ledger',
  '',
  SELFTEST_HEADER,
  SELFTEST_SEP,
  '| 2026-07-10 | S1 multi-agent | hub-and-spoke, 20 agents | api | IRRELEVANT | none | selftest |',
  '| 2026-07-10 | S6 grader opacity | outcomes grader is opaque | api | CORE-threat | BL-160 | selftest |',
  '',
].join('\n')

/**
 * selftest({ untriagedText, triagedText }) -> 1|0.
 *
 * Runs the inline fixture pair through parseLedger + lintLedger: the untriaged
 * fixture MUST fail lint and the triaged fixture MUST pass. Returns 1 only when
 * BOTH halves behave; sabotaging either fixture (a triaged "untriaged" half, or
 * an untriaged "triaged" half) returns 0. This is the self-proving contract
 * behind `sma vendor --selftest`.
 *
 * The fixtures are overridable so a test can sabotage a half and assert 0.
 *
 * @param {{untriagedText?:string, triagedText?:string}} [opts]
 * @returns {number} 1 when both halves behave, else 0
 */
export function selftest({ untriagedText = SELFTEST_UNTRIAGED, triagedText = SELFTEST_TRIAGED } = {}) {
  const untriaged = parseLedger({ ledgerPath: 'SELFTEST-UNTRIAGED', readFile: () => untriagedText })
  const triaged = parseLedger({ ledgerPath: 'SELFTEST-TRIAGED', readFile: () => triagedText })
  const untriagedFailsLint = lintLedger(untriaged.rows).ok === false
  const triagedPassesLint = lintLedger(triaged.rows).ok === true
  return untriagedFailsLint && triagedPassesLint ? 1 : 0
}
