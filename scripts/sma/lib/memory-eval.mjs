/**
 * memory-eval.mjs — the GOLD-SET MEASURER of the memory layer (canon §8).
 *
 * A retrieval experiment without a measurer is a preference, not a result. This module
 * turns the gold set into the canon's §8 numbers — recall@k, precision@k, MRR, nDCG,
 * critical-memory miss rate, superseded selection rate, contradiction exposure — plus
 * DETERMINISTIC FLOORS that give a red/green verdict with no model in the loop. It is
 * the instrument every later retrieval layer has to beat before it may enter the
 * default path.
 *
 * WHY IT IS NOT IN bench.mjs. bench.mjs is the WORKFLOW scorecard: what SMA's own
 * discipline costs a session. This is the MEMORY benchmark: what the corpus gives back
 * for a question. Two different subjects, two different baselines, two different ways
 * of being wrong — a single module would let a good workflow number quietly cover a bad
 * retrieval one. It sits next to baseline.mjs instead, because it holds itself to
 * baseline.mjs's contract, verbatim.
 *
 * COMPOSED, NEVER RE-IMPLEMENTED (the don't-hand-roll law, and here also a security
 * boundary — a second read path is a second answer that drifts unnoticed):
 *   - context-pack.mjs scoreNoteCases — «which notes actually load for this task, in
 *     what order», answered by the REAL loader path. Nothing here re-derives retrieval;
 *     every metric is arithmetic over what the loader already returned.
 *   - baseline.mjs readGoldCases — the one gold-case reader, corrupt lines counted.
 *   - consolidate.mjs findContradictions — the ONE contradiction model in the product
 *     (lint's MEM-CONTRADICT reads the same function). Contradiction EXPOSURE is a
 *     delivery question asked of that existing detection, never a second detector.
 *   - generator.mjs projectNoteAxis / CORE_EXCLUDED_STATUSES — the one axis on which a
 *     record's retirement is a typed field.
 *
 * PURE over its inputs, exactly like captureRetrieval: it reads a corpus and a cases
 * file, writes nothing, and touches no clock, no randomness and no network of its own.
 * `now` is INJECTED and threaded into the loader's read-time visibility filters, so a
 * measurement is reproducible on a date other than the one it was taken on — a
 * benchmark whose numbers move because the calendar moved is not a benchmark.
 *
 * HONEST EMPTIES: a set that asks no rankable question reports `null`, never a
 * fabricated 0.0 or 1.0; a refused case (a contaminating fixture) is reported and
 * counted, never quietly folded into a denominator.
 *
 * Node built-ins only; zero npm deps, zero LLM, zero network.
 */

import { dirname, join } from 'node:path'

import { scoreNoteCases } from './context-pack.mjs'
import { readGoldCases } from './baseline.mjs'
import { projectNoteAxis, CORE_EXCLUDED_STATUSES } from './generator.mjs'
import { readCorpus, findContradictions } from './consolidate.mjs'
import { loadTagsRegistry } from './frontmatter.mjs'

/**
 * The re-run command. A bare verb form on purpose: a check_command must pass the
 * SAFE_COMMAND allowlist AND its charset, and a machine-specific path would make the
 * receipt unreproducible on any other checkout. The verb resolves the project's own
 * corpus and gold-cases file itself.
 */
export const MEMORY_EVAL_CHECK_COMMAND = 'node scripts/sma/cli.mjs eval memory'

/** The same command in its A/B form — the one that produces the delta numbers. */
export const MEMORY_EXPERIMENT_CHECK_COMMAND = 'node scripts/sma/cli.mjs eval memory --experiment lexical'

/** The experiments this measurer knows how to run an arm for. */
export const EXPERIMENTS = Object.freeze(['lexical'])

/** The cutoffs reported unless the caller names others. */
export const DEFAULT_K = Object.freeze([3, 5, 10])

/**
 * DEFAULT_FLOORS — the phase's frozen red/green thresholds.
 *
 * Every floor here is a MUST-BE-ZERO: a critical memory that did not arrive, a
 * forbidden record that did, a retired record delivered anyway, an unparseable line in
 * the measurement's own input, a fixture that had to be refused. None of them is a
 * tuned number, and that is deliberate — a floor with a dial on it becomes the target
 * (Goodhart), and the first person to miss it turns the dial. Recall and precision
 * carry NO floor for the same reason: they are compared against a recorded baseline,
 * not against a number somebody picked.
 *
 * A floor whose metric is `null` (honestly unmeasured) is never a failure: an unasked
 * question has no verdict.
 */
export const DEFAULT_FLOORS = Object.freeze({
  critical_miss_rate: Object.freeze({ comparator: '<=', threshold: 0 }),
  forbidden_hits: Object.freeze({ comparator: '<=', threshold: 0 }),
  superseded_selection_rate: Object.freeze({ comparator: '<=', threshold: 0 }),
  corrupt_lines: Object.freeze({ comparator: '<=', threshold: 0 }),
  refused_cases: Object.freeze({ comparator: '<=', threshold: 0 }),
})

/** The comparator set — the same six the predictions ledger admits, no others. */
const COMPARE = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
}

/** Round to 4 decimals (never carry float noise into a recorded number). */
function round4(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 1e4) / 1e4
}

/** A rate, or `null` when there is no denominator to divide by (honest empty). */
function rate(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  return round4(numerator / denominator)
}

/** The macro-average of a per-case list — `null` for an empty list, never 0. */
function macro(values) {
  return values.length ? round4(values.reduce((a, b) => a + b, 0) / values.length) : null
}

/** Discounted cumulative gain over a binary-relevance gain vector. */
function dcg(gains) {
  let sum = 0
  for (let i = 0; i < gains.length; i++) sum += gains[i] / Math.log2(i + 2)
  return sum
}

/** The cutoffs, normalized: positive integers, unique, ascending; empty → DEFAULT_K. */
function normalizeK(k) {
  const raw = typeof k === 'string' ? k.split(',') : Array.isArray(k) ? k : []
  const out = [...new Set(raw.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0))]
  return out.length ? out.sort((a, b) => a - b) : [...DEFAULT_K]
}

/**
 * The facts a corpus states about ITSELF that a delivery metric needs: which records
 * are retired, and which pairs the product already calls a contradiction. Read once per
 * corpus directory (a gold set scores fixture cases against fixture corpora), and read
 * ONLY through the modules that already own those questions.
 */
function corpusFacts(corpusDir, cache) {
  const key = corpusDir ?? ''
  if (cache.has(key)) return cache.get(key)

  let notes = []
  if (corpusDir) {
    try {
      notes = readCorpus(corpusDir)
    } catch {
      notes = [] // fail-soft: an unreadable corpus states no facts, it does not throw
    }
  }

  const retired = new Set()
  for (const n of notes) {
    const axis = projectNoteAxis(n.frontmatter, { file: n.file, schemaVersion: n.schemaVersion })
    if (CORE_EXCLUDED_STATUSES.has(axis.status)) retired.add(n.file)
  }

  let registry = { area: new Set(), kind: new Set(), aliases: new Map() }
  if (corpusDir) {
    try {
      registry = loadTagsRegistry(join(corpusDir, 'TAGS.md'))
    } catch {
      /* an absent registry narrows contradiction detection, it never fails the run */
    }
  }

  let pairs = []
  try {
    pairs = findContradictions({ notes, registry }).map((p) => p.files)
  } catch {
    pairs = []
  }

  const facts = { retired, pairs }
  cache.set(key, facts)
  return facts
}

/**
 * flattenSummary(summary) → the ONE flat map of stat names to values.
 *
 * A nested metric (`recall_at: {3: …}`) gets a dotted key (`recall_at.3`). This is
 * both the `--stat` lookup table and the list of legal stat names printed on a
 * mistake: a second hand-written list of field names is a list that goes stale.
 */
export function flattenSummary(summary) {
  const out = {}
  for (const [key, value] of Object.entries(summary ?? {})) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, inner] of Object.entries(value)) out[`${key}.${sub}`] = inner
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * floorFailures(summary, floors) → the violated floors, in stable name order.
 *
 * An EMPTY LIST IS THE GREEN VERDICT — the whole point of the floors is that the
 * verdict is arithmetic, reproducible by anyone, and needs no judgment call. A metric
 * that is honestly `null` is skipped: it was never measured, so it cannot have failed.
 *
 * @param {object} summary  a captureMemoryEval summary (or any flat metric object)
 * @param {object} [floors] default DEFAULT_FLOORS
 * @returns {Array<{metric:string, value:number, comparator:string, threshold:number}>}
 */
export function floorFailures(summary = {}, floors = DEFAULT_FLOORS) {
  const flat = flattenSummary(summary)
  const out = []
  for (const metric of Object.keys(floors).sort()) {
    const floor = floors[metric] ?? {}
    const value = flat[metric]
    if (value == null || !Number.isFinite(Number(value))) continue
    const compare = COMPARE[floor.comparator]
    if (!compare) {
      out.push({ metric, value: Number(value), comparator: String(floor.comparator), threshold: floor.threshold })
      continue
    }
    if (!compare(Number(value), Number(floor.threshold))) {
      out.push({ metric, value: Number(value), comparator: floor.comparator, threshold: Number(floor.threshold) })
    }
  }
  return out
}

/**
 * floorVerdict(summary, floors) → 'no-data' | 'met' | 'violated'.
 *
 * WHY A NAMED VERDICT AND NOT JUST THE EMPTY LIST. `floor_failures` is a list of what
 * went wrong, and it is empty in TWO completely different worlds: a set that asked its
 * questions and got clean answers, and a set that asked nothing at all. Reading the
 * empty list as «everything is fine» turns an absence of data into a pass — the same
 * fabrication the honest-empties law already forbids for the ranking numbers, except
 * this one reads to a human as a green check mark. A measurement with no cases has no
 * verdict to give, and it says so here in one word rather than leaving the reader to
 * infer it from a shape that cannot distinguish the two.
 *
 * @param {object} summary  a captureMemoryEval summary
 * @param {object} [floors] default DEFAULT_FLOORS
 * @returns {'no-data'|'met'|'violated'}
 */
export function floorVerdict(summary = {}, floors = DEFAULT_FLOORS) {
  const cases = Number(summary?.cases_total)
  if (!Number.isFinite(cases) || cases <= 0) return 'no-data'
  return floorFailures(summary, floors).length ? 'violated' : 'met'
}

/**
 * captureMemoryEval(opts) → the canon §8 measurement of the CURRENT loader.
 *
 * Report:
 *   {metric:'memory-eval', k, by_class, critical_misses, forbidden_cases,
 *    superseded_selections, contradiction_exposures, abstain_failures, refused_cases,
 *    summary:{…}, floors, floor_failures, check_command}
 *
 * The summary, field by field:
 *   - recall_at[k]     macro-average over rankable cases of (relevant notes in the top
 *                      k of the pack / all relevant notes for that case)
 *   - precision_at[k]  macro-average of (relevant notes in the top k / k) — the
 *                      textbook denominator, so a pack that delivers everything is
 *                      priced for it rather than flattered by it
 *   - mrr              macro-average reciprocal rank of the FIRST relevant note
 *   - ndcg             macro-average nDCG over the WHOLE pack order, binary relevance
 *   - critical_miss_rate        cases missing ≥1 critical note / cases
 *   - superseded_selection_rate cases whose pack carried a retired record / cases
 *   - contradiction_exposure    cases whose pack carried BOTH halves of a declared
 *                               contradiction / cases
 *   - forbidden_hits   COUNT of forbidden notes that loaded anyway (a count, not a rate)
 *   - abstain_pass/fail the abstention verdicts, judged by the SELECTED set
 *
 * A «rankable» case is one that names at least one expected note. A case that names
 * none asks no ranking question and is excluded from the rank metrics rather than
 * scored as a perfect or a zero — which is why `rankable_cases` is reported next to
 * `cases_total` instead of being left to be inferred.
 *
 * RANK = PACK ORDER. A note's rank is its position in the ordered pack the real
 * selection produced (`loaded`), including the unconditional CORE frame: rank is about
 * what the reader meets first, and the frame is met first. Delivery metrics
 * (superseded, contradiction) read the same delivered set for the same reason — a
 * retired record that rides in on the frame is not less delivered.
 *
 * @param {object} opts
 * @param {string} opts.corpusDir
 * @param {string} opts.casesPath        gold cases, one JSON object per line
 * @param {string} [opts.tagsPath]       defaults to <corpusDir>/TAGS.md
 * @param {number[]|string} [opts.k]     cutoffs (default DEFAULT_K)
 * @param {string|Date} [opts.now]       INJECTED instant for the read-time filters
 * @param {object} [opts.dateMap]        file → last-commit ISO (ordering only)
 * @param {string} [opts.commit]         INJECTED (pack identity only, never the score)
 * @param {number} [opts.budget]         pack budget override
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.compile]      compilePack double (tests)
 * @param {object} [opts.floors]         default DEFAULT_FLOORS
 * @param {string} [opts.checkCommand]   override the recorded re-run command
 * @returns {object}
 */
export function captureMemoryEval(opts = {}) {
  const {
    corpusDir,
    casesPath,
    tagsPath,
    k,
    now,
    dateMap = {},
    commit = '',
    budget,
    readFile,
    compile,
    floors = DEFAULT_FLOORS,
    checkCommand = MEMORY_EVAL_CHECK_COMMAND,
    experiment = null,
    indexPath,
    lexical,
  } = opts

  const ks = normalizeK(k)
  // The registry default is resolved HERE, next to the corpus it belongs to — the same
  // reason captureRetrieval resolves it: without a registry the loader selects nothing
  // and every metric reports a fabricated zero.
  const resolvedTagsPath = tagsPath ?? (corpusDir ? join(corpusDir, 'TAGS.md') : undefined)

  const { cases, corrupt } = readGoldCases(casesPath, { readFile })
  const scored = scoreNoteCases({
    cases,
    corpusDir,
    ...(casesPath ? { casesDir: dirname(casesPath) } : {}),
    tagsPath: resolvedTagsPath,
    dateMap,
    commit,
    ...(now == null ? {} : { now }),
    ...(budget == null ? {} : { budget }),
    ...(compile == null ? {} : { compile }),
    ...(experiment == null ? {} : { experiment }),
    ...(indexPath == null ? {} : { indexPath }),
    ...(lexical == null ? {} : { lexical }),
  })

  const factsCache = new Map()

  const recallPerK = new Map(ks.map((n) => [n, []]))
  const precisionPerK = new Map(ks.map((n) => [n, []]))
  const reciprocalRanks = []
  const ndcgs = []

  const criticalMisses = []
  const forbiddenCases = []
  const supersededSelections = []
  const contradictionExposures = []
  const abstainFailures = []
  const refused = []
  const byClass = new Map()

  let casesWithSuperseded = 0
  let casesWithContradiction = 0

  for (const c of scored.cases) {
    if (c.error) {
      refused.push({ case: c.task, repo_state: c.repoState ?? null, error: c.error })
      continue
    }

    const klass = c.class ?? 'unclassified'
    if (!byClass.has(klass)) {
      byClass.set(klass, { class: klass, cases: 0, expected: 0, hits: 0, critical_misses: 0, forbidden_hits: 0, abstain_pass: 0, abstain_fail: 0 })
    }
    const bucket = byClass.get(klass)
    bucket.cases += 1
    bucket.expected += c.expected.length
    bucket.hits += c.hits.length
    if (c.criticalMissing.length) bucket.critical_misses += 1
    bucket.forbidden_hits += c.forbiddenPresent.length
    if (c.abstain === 'pass') bucket.abstain_pass += 1
    if (c.abstain === 'fail') bucket.abstain_fail += 1

    if (c.criticalMissing.length) criticalMisses.push({ case: c.task, missing_notes: c.criticalMissing })
    if (c.forbiddenPresent.length) forbiddenCases.push({ case: c.task, forbidden_notes: c.forbiddenPresent })
    if (c.abstain === 'fail') abstainFailures.push({ case: c.task, selected_notes: c.selected })

    // ── the rank metrics, over the order the selection actually produced ──
    const ranked = c.loaded
    const relevant = new Set(c.expected)
    if (relevant.size > 0) {
      for (const cutoff of ks) {
        const top = ranked.slice(0, cutoff)
        const found = top.filter((f) => relevant.has(f)).length
        recallPerK.get(cutoff).push(found / relevant.size)
        precisionPerK.get(cutoff).push(found / cutoff)
      }
      const firstHit = ranked.findIndex((f) => relevant.has(f))
      reciprocalRanks.push(firstHit === -1 ? 0 : 1 / (firstHit + 1))

      const gains = ranked.map((f) => (relevant.has(f) ? 1 : 0))
      const ideal = new Array(ranked.length).fill(0)
      for (let i = 0; i < Math.min(relevant.size, ranked.length); i++) ideal[i] = 1
      const idealGain = dcg(ideal)
      ndcgs.push(idealGain > 0 ? dcg(gains) / idealGain : 0)
    }

    // ── the delivery metrics, read from what the corpus states about itself ──
    const facts = corpusFacts(c.corpusDir ?? corpusDir, factsCache)
    const deliveredSet = new Set(ranked)

    const retiredDelivered = ranked.filter((f) => facts.retired.has(f))
    if (retiredDelivered.length) {
      casesWithSuperseded += 1
      supersededSelections.push({ case: c.task, notes: retiredDelivered })
    }

    const exposedPairs = facts.pairs.filter(([a, b]) => deliveredSet.has(a) && deliveredSet.has(b))
    if (exposedPairs.length) {
      casesWithContradiction += 1
      contradictionExposures.push({ case: c.task, pairs: exposedPairs })
    }
  }

  const t = scored.totals
  const rankableCases = reciprocalRanks.length

  const recallAt = {}
  const precisionAt = {}
  for (const cutoff of ks) {
    recallAt[cutoff] = macro(recallPerK.get(cutoff))
    precisionAt[cutoff] = macro(precisionPerK.get(cutoff))
  }

  const summary = {
    cases_total: t.cases,
    rankable_cases: rankableCases,
    recall_at: recallAt,
    precision_at: precisionAt,
    mrr: macro(reciprocalRanks),
    ndcg: macro(ndcgs),
    critical_miss_rate: rate(t.casesWithCriticalMiss, t.cases),
    superseded_selection_rate: rate(casesWithSuperseded, t.cases),
    contradiction_exposure: rate(casesWithContradiction, t.cases),
    forbidden_hits: t.forbiddenPresent,
    abstain_pass: t.abstainPass,
    abstain_fail: t.abstainFail,
    corrupt_lines: corrupt,
    refused_cases: refused.length,
    // The PRICE of the numbers above, on the same run that produced them. A retrieval
    // score improves trivially by delivering more, so the size of what was delivered
    // belongs in the same report — not in a second one somebody has to remember to read.
    notes_delivered: t.loaded,
    pack_tokens: t.packTokens,
  }

  return {
    metric: 'memory-eval',
    experiment: experiment ?? null,
    k: ks,
    by_class: [...byClass.values()].sort((a, b) => (a.class < b.class ? -1 : a.class > b.class ? 1 : 0)),
    critical_misses: criticalMisses,
    forbidden_cases: forbiddenCases,
    superseded_selections: supersededSelections,
    contradiction_exposures: contradictionExposures,
    abstain_failures: abstainFailures,
    refused_cases: refused,
    summary,
    floors,
    floor_failures: floorFailures(summary, floors),
    // The verdict a reader is allowed to quote. With no cases it is 'no-data', and the
    // empty failure list beside it means «nothing was asked», not «nothing was wrong».
    floor_verdict: floorVerdict(summary, floors),
    check_command: checkCommand,
  }
}

// ─────────────────────────── the A/B (canon §16) ────────────────────────────

/**
 * A delta in PERCENTAGE POINTS, or `null` when either arm has no number.
 *
 * Points, not percent-of-percent: recall going from 0.20 to 0.25 is «+5 points», and
 * calling that «+25 %» is the standard way to make a small move sound like a large one.
 * A percentage of a rate is the sentence people quote and nobody can check.
 */
function deltaPoints(after, before) {
  if (after == null || before == null || !Number.isFinite(Number(after)) || !Number.isFinite(Number(before))) return null
  return round4((Number(after) - Number(before)) * 100)
}

/** A plain count difference (negative = fewer, which for a floor is better). */
function deltaCount(after, before) {
  if (after == null || before == null) return null
  return Number(after) - Number(before)
}

/**
 * captureMemoryExperiment(opts) → the A/B of a retrieval experiment on the gold set.
 *
 * ONE set, TWO arms, run back to back in the same process against the same corpus: the
 * CONTROL is the default path exactly as it ships, the EXPERIMENT differs by one option
 * threaded down to compilePack and by nothing else. That is the whole design: any
 * difference between the two summaries is attributable to the layer, because there is no
 * second code path for it to be attributable to.
 *
 * The report is DELTAS, not a verdict. Canon §16 states the stopping rule — a retriever
 * that does not improve critical recall or cost per verified result WITHOUT hurting
 * precision does not enter the default path — and the decision that applies that rule to
 * these numbers is a person's, recorded in writing. A measurer that also declared the
 * winner would be marking its own homework.
 *
 * The deltas, by name (all in percentage points unless the name says otherwise):
 *   critical_recall_delta_pct  the pre-registered P1 — critical recall is 1 − the
 *                              critical-miss rate, so this is the miss rate falling
 *   precision_delta_pct        the pre-registered P2 (precision@3): the stopping rule's
 *                              «without hurting precision» half
 *   recall_delta_pct           recall@3 — the phase's working ranking number
 *   recall_at_10_delta_pct     recall@10, because a re-ranker can move the deep cut
 *   mrr_delta_pct / ndcg_delta_pct  the order metrics the layer exists to move
 *   forbidden_delta            a COUNT (negative is better); a must-be-zero floor
 *   superseded_delta_pct / contradiction_delta_pct  the delivery guardrails
 *   abstain_fail_delta         a COUNT: a broader retriever that starts answering where
 *                              it should hold back is worse, however good its recall
 *   pack_tokens_delta_pct      the COST projection: the same gold set, the extra tokens
 *                              per verified answer the layer asks the reader to pay
 *
 * @param {object} opts  every captureMemoryEval option, plus:
 * @param {string} [opts.experiment]  the arm's name (default 'lexical')
 * @param {string} [opts.indexPath]   where the derived lexical index lives
 * @param {object} [opts.lexical]     layer doubles (tests)
 * @returns {object}
 */
export function captureMemoryExperiment(opts = {}) {
  const { experiment = EXPERIMENTS[0], indexPath, lexical, checkCommand = MEMORY_EXPERIMENT_CHECK_COMMAND, ...rest } = opts

  const control = captureMemoryEval({ ...rest, checkCommand: MEMORY_EVAL_CHECK_COMMAND })
  const treatment = captureMemoryEval({
    ...rest,
    experiment,
    ...(indexPath == null ? {} : { indexPath }),
    ...(lexical == null ? {} : { lexical }),
    checkCommand,
  })

  const c = control.summary
  const e = treatment.summary
  const at = (summaryAt, cutoff) => (summaryAt && summaryAt[cutoff] != null ? summaryAt[cutoff] : null)

  const summary = {
    cases_total: e.cases_total,
    rankable_cases: e.rankable_cases,
    // critical RECALL is 1 − the miss rate, so its rise is the miss rate's fall
    critical_recall_delta_pct: deltaPoints(c.critical_miss_rate, e.critical_miss_rate),
    precision_delta_pct: deltaPoints(at(e.precision_at, 3), at(c.precision_at, 3)),
    recall_delta_pct: deltaPoints(at(e.recall_at, 3), at(c.recall_at, 3)),
    recall_at_10_delta_pct: deltaPoints(at(e.recall_at, 10), at(c.recall_at, 10)),
    mrr_delta_pct: deltaPoints(e.mrr, c.mrr),
    ndcg_delta_pct: deltaPoints(e.ndcg, c.ndcg),
    forbidden_delta: deltaCount(e.forbidden_hits, c.forbidden_hits),
    superseded_delta_pct: deltaPoints(e.superseded_selection_rate, c.superseded_selection_rate),
    contradiction_delta_pct: deltaPoints(e.contradiction_exposure, c.contradiction_exposure),
    abstain_fail_delta: deltaCount(e.abstain_fail, c.abstain_fail),
    notes_delivered_delta: deltaCount(e.notes_delivered, c.notes_delivered),
    pack_tokens_control: c.pack_tokens,
    pack_tokens_experiment: e.pack_tokens,
    pack_tokens_delta_pct:
      c.pack_tokens > 0 ? round4(((e.pack_tokens - c.pack_tokens) / c.pack_tokens) * 100) : null,
  }

  return {
    metric: 'memory-eval-experiment',
    experiment,
    arms: { control: control.summary, experiment: treatment.summary },
    reports: { control, experiment: treatment },
    summary,
    // The floors are the EXPERIMENT arm's own, unchanged: an arm that raises a ranking
    // number while a must-be-zero floor goes red has not passed, and saying so needs the
    // floors of the arm being judged, not a delta between two verdicts.
    floor_failures: treatment.floor_failures,
    // …and an A/B run over an empty set is not a comparison at all: two arms that were
    // never asked anything cannot differ, so there is nothing here to record.
    floor_verdict: treatment.floor_verdict,
    check_command: checkCommand,
  }
}
