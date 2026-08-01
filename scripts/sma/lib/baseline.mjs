/**
 * baseline.mjs — the MEASUREMENT ORCHESTRATOR of the memory track.
 *
 * Before a memory system is modernized it must be MEASURED, and the measurement must
 * be re-runnable months later by a machine that was not in the room: known retrieval
 * recall, known critical misses, known context cost. This module produces those
 * numbers — and produces them as RECEIPT-SHAPED reports, never as prose. Every report
 * carries a `check_command`: the exact command that reproduces it, so the number can
 * be recorded through receipts.recordReceipt and re-verified by `sma reverify`. A
 * baseline that cannot be re-run is a story, not a baseline.
 *
 * COMPOSED, NEVER RE-IMPLEMENTED (the don't-hand-roll law):
 *   - context-pack.mjs scoreNoteCases — «which notes actually load for this task»,
 *     answered by the real loader path (generator CORE rule + tag-matched periphery),
 *     so the score can never drift from the behavior it measures.
 *   - economy.mjs corpusStats — the ONE versioned token estimator. This module counts
 *     no bytes and no tokens of its own; it passes the estimator's numbers, its
 *     version stamp and its honest approximation caveat straight through.
 *   - receipts.mjs — not imported here (a capture writes nothing); the reports are
 *     shaped so recordReceipt accepts them at capture time, which is where the
 *     workspace records them.
 *
 * PURITY: both captures are pure over their inputs (a corpus directory + a gold-cases
 * file). They read; they never write, never touch a clock, never touch the network.
 * Same inputs → identical report bytes, which is what makes a baseline comparable to
 * a later re-measurement at all.
 *
 * HONEST EMPTIES: zero cases or zero expected notes yield `null` rates, never a
 * fabricated 1.0; a corpus with no index yields `core: null`, never 0-as-if-measured;
 * a corrupt gold-case line is skipped AND COUNTED (`corrupt_lines`), never silently
 * dropped.
 *
 * Node built-ins only; io injectable; zero npm deps, zero LLM, zero child_process.
 */

import { readFileSync } from 'node:fs'

import { scoreNoteCases } from './context-pack.mjs'
import { corpusStats } from './economy.mjs'

/**
 * The re-run commands. Both are bare verb forms on purpose: a check_command must pass
 * the SAFE_COMMAND allowlist AND its charset (no backslashes — a machine-specific
 * absolute path would make the receipt unreproducible on any other checkout). The verb
 * resolves the project's own corpus and gold-cases file itself.
 */
export const RETRIEVAL_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline retrieval'
export const CONTEXT_COST_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline context-cost'

/** Round a rate to 4 decimals (never carry float noise into a recorded number). */
function rate(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  return Math.round((numerator / denominator) * 1e4) / 1e4
}

/**
 * readGoldCases(casesPath, {readFile}) → {cases, corrupt}. One JSON object per line
 * (the note-level subset of the gold format):
 *   {task, expected_notes[], critical_notes[], forbidden_notes[]}
 * A missing file is an honest empty set, a corrupt line is skipped and counted —
 * reading the baseline's own input can never be the thing that fails the baseline.
 *
 * @param {string} casesPath
 * @param {{readFile?:Function}} [opts]
 * @returns {{cases: object[], corrupt: number}}
 */
export function readGoldCases(casesPath, { readFile } = {}) {
  const rf = typeof readFile === 'function' ? readFile : readFileSync
  let raw
  try {
    raw = rf(casesPath, 'utf8')
  } catch {
    return { cases: [], corrupt: 0 }
  }
  const cases = []
  let corrupt = 0
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      corrupt += 1
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      corrupt += 1
      continue
    }
    cases.push(parsed)
  }
  return { cases, corrupt }
}

/**
 * captureRetrieval(opts) → the retrieval-recall measurement of the CURRENT loader.
 *
 * Report:
 *   {metric:'retrieval-recall', cases, expected, hits, corrupt_lines,
 *    misses:[{case, missing_notes}], critical_misses:[{case, missing_notes}],
 *    forbidden_hits:[{case, forbidden_notes}], core_loaded:[...],
 *    summary:{recall, critical_miss_rate}, check_command}
 *
 *   - recall            = expected notes that loaded / all expected notes  (null when none)
 *   - critical_miss_rate= cases missing >= 1 critical note / cases         (null when none)
 *   - core_loaded       = the always-load set the corpus produces (the same for every case)
 *
 * @param {object} opts
 * @param {string} opts.corpusDir
 * @param {string} opts.casesPath   gold cases, one JSON object per line
 * @param {string} [opts.tagsPath]  defaults to <corpusDir>/TAGS.md through the loader
 * @param {object} [opts.dateMap]   file → last-commit ISO (INJECTED; ordering only)
 * @param {string} [opts.commit]    INJECTED (pack identity only, never the score)
 * @param {number} [opts.budget]    pack budget override
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.compile] compilePack double (tests)
 * @param {string} [opts.checkCommand] override the recorded re-run command
 * @returns {object}
 */
export function captureRetrieval(opts = {}) {
  const {
    corpusDir,
    casesPath,
    tagsPath,
    dateMap = {},
    commit = '',
    budget,
    readFile,
    compile,
    checkCommand = RETRIEVAL_CHECK_COMMAND,
  } = opts

  const { cases, corrupt } = readGoldCases(casesPath, { readFile })
  const scored = scoreNoteCases({
    cases,
    corpusDir,
    tagsPath,
    dateMap,
    commit,
    ...(budget == null ? {} : { budget }),
    ...(compile == null ? {} : { compile }),
  })

  const misses = []
  const criticalMisses = []
  const forbiddenHits = []
  for (const c of scored.cases) {
    if (c.missing.length) misses.push({ case: c.task, missing_notes: c.missing })
    if (c.criticalMissing.length) criticalMisses.push({ case: c.task, missing_notes: c.criticalMissing })
    if (c.forbiddenPresent.length) forbiddenHits.push({ case: c.task, forbidden_notes: c.forbiddenPresent })
  }

  const t = scored.totals
  return {
    metric: 'retrieval-recall',
    cases: t.cases,
    expected: t.expected,
    hits: t.hits,
    corrupt_lines: corrupt,
    misses,
    critical_misses: criticalMisses,
    forbidden_hits: forbiddenHits,
    core_loaded: scored.coreLoaded,
    summary: {
      recall: rate(t.hits, t.expected),
      critical_miss_rate: rate(t.casesWithCriticalMiss, t.cases),
    },
    check_command: checkCommand,
  }
}

/**
 * captureContextCost(opts) → the context-cost measurement of the corpus.
 *
 * Report:
 *   {metric:'context-cost', per_file:[{file, kind, tokens}], totals, top,
 *    estimator_version, caveat, check_command}
 *
 * Every number comes from economy.corpusStats — this function classifies and orders,
 * it does not count. `kind` is 'core' (the always-loaded index), 'index' (a per-area
 * INDEX-*.md) or 'note'. per_file is heaviest-first within each kind, core first.
 *
 * @param {object} opts
 * @param {string} opts.corpusDir
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.listFiles]
 * @param {number} [opts.topN]
 * @param {string} [opts.checkCommand]
 * @returns {object}
 */
export function captureContextCost(opts = {}) {
  const { corpusDir, readFile, listFiles, topN = 10, checkCommand = CONTEXT_COST_CHECK_COMMAND } = opts

  const stats = corpusStats({ corpusDir, readFile, listFiles, topN })

  const perFile = []
  if (stats.core != null) perFile.push({ file: 'MEMORY.md', kind: 'core', tokens: stats.core })
  for (const n of stats.notes) perFile.push({ file: n.file, kind: 'note', tokens: n.tokens })
  for (const i of stats.indexes) perFile.push({ file: i.file, kind: 'index', tokens: i.tokens })

  return {
    metric: 'context-cost',
    per_file: perFile,
    totals: stats.totals,
    top: stats.top,
    estimator_version: stats.estimatorVersion,
    caveat: stats.caveat,
    check_command: checkCommand,
  }
}
