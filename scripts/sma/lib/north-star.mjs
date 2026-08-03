/**
 * north-star.mjs — the ONE NUMBER the layer is answerable to, and the GATE new features
 * must pass to reach the default path.
 *
 * Three instruments, one subject: is the discipline WORTH what it costs?
 *
 *   captureNorthStar  — COST PER VERIFIED CORRECT RESULT: tokens + compute + wall-clock
 *                       + human minutes, divided by the results the §8 measurer judged
 *                       correct. It is the only metric that can fall while every
 *                       component metric rises, which is exactly why it exists.
 *   guardrailPanel    — the recorded receipts and the §8 guardrails in ONE panel, each
 *                       row carrying the command that reproduces it.
 *   evalFeatureGate   — the five-element admission check: failure class · baseline ·
 *                       falsifiable prediction · acceptance · rollback.
 *
 * COMPOSED, NEVER RE-IMPLEMENTED (the don't-hand-roll law — and here it is also the
 * whole honesty argument: a north star computed from its OWN second set of meters
 * would drift away from the numbers it claims to summarize, and nobody would notice):
 *   - spend.mjs windowSpend + the book's own token totals — the compute price and the
 *     token volume. This module counts no tokens and prices nothing.
 *   - economy.mjs selfCost — the STATIC per-session injection, the fallback token
 *     measure when no spend book exists. It answers a narrower question, and the report
 *     says which question it answered (`basis`) rather than blurring the two.
 *   - memory-eval.mjs — the verified-result COUNT is read from the §8 report's own
 *     verdicts (critical misses, forbidden hits, abstention failures). Nothing here
 *     re-scores retrieval; a second definition of «correct» is a second answer.
 *   - baseline.mjs BASELINE_METRICS + receiptIdFor — the guardrail row names come from
 *     the module that owns the baseline, not from a list typed a second time here.
 *   - predict.mjs COMPARATORS + isSafeCommand — the gate's prediction is held to the
 *     SAME boundary the predictions ledger enforces. A gate with a looser notion of
 *     «checkable» than the ledger would be a way around the ledger.
 *
 * THE HONEST HOLE. Human minutes are measured by NOTHING in this product today. The
 * component is reported `null` with the source of its future measurement named, the
 * status degrades to `partial`, and the formula falls back to the measurable terms. A 0
 * is never substituted: 0 there reads as «humans spend no time on this», which is the
 * exact opposite of the truth, and a north star that lies about its biggest term is
 * worse than no north star at all.
 *
 * PURE over its inputs: it reads nothing on its own — book, reports, receipts and the
 * wall-clock number are all INJECTED by the caller that measured them. No clock, no
 * randomness, no network, no writes.
 *
 * Node built-ins only; zero npm deps, zero LLM, zero network.
 */

import { selfCost } from './economy.mjs'
import { windowSpend } from './spend.mjs'
import { flattenSummary, MEMORY_EVAL_CHECK_COMMAND } from './memory-eval.mjs'
import { BASELINE_METRICS, receiptIdFor } from './baseline.mjs'
import { COMPARATORS, isSafeCommand } from './predict.mjs'

/** The ONE flattener (memory-eval's), re-exported so a verb needs one import, not two. */
export { flattenSummary }

/**
 * The re-run command. A bare verb form on purpose: a check_command must pass the
 * SAFE_COMMAND allowlist AND its charset, and a machine-specific path would make the
 * receipt unreproducible on any other checkout.
 */
export const NORTH_STAR_CHECK_COMMAND = 'node scripts/sma/cli.mjs eval north-star'

/**
 * HUMAN_MINUTES_SOURCE — the honest note carried where a number would be.
 *
 * It names the FUTURE measurement rather than apologizing: the execution journal already
 * timestamps the moments a run stops for a person and the moment it resumes, and that
 * pair is the minutes. Until the pair is read and reported, the component is null.
 */
export const HUMAN_MINUTES_SOURCE =
  'НЕ ИЗМЕРЯЕТСЯ сегодня ни одним инструментом продукта. Источник будущего замера назван: ' +
  'таймстемпы чекпойнтов журнала исполнения — пара «остановка на человека» / «возобновление» ' +
  'и есть минуты человека. До того как эта пара считывается и репортится, компонент null: ' +
  'ноль здесь читался бы как «человек не тратит времени», а это обратное правде.'

/** The component names, in the order a reader meets them. */
export const COST_COMPONENTS = Object.freeze(['tokens', 'wall_clock_ms', 'compute', 'human_minutes'])

/**
 * The §8 metrics the panel watches. Every one of them is a guardrail in the strict
 * sense: a number that must not get WORSE while the north star gets better. Ordered
 * floors first — the three that are already floors in the §8 measurer — then the
 * ranking numbers a new retriever is supposed to move.
 */
export const GUARDRAIL_EVAL_METRICS = Object.freeze([
  'forbidden_hits',
  'critical_miss_rate',
  'superseded_selection_rate',
  'contradiction_exposure',
  'recall_at.3',
  'precision_at.3',
  'ndcg',
])

/** The five elements of the admission gate, in the order a declaration states them. */
export const GATE_ELEMENTS = Object.freeze(['failure_class', 'baseline_ref', 'prediction', 'acceptance', 'rollback'])

/** The four keys a gate prediction must carry to be checkable at all. */
export const GATE_PREDICTION_KEYS = Object.freeze(['metric', 'comparator', 'threshold', 'check_command'])

/** Round to 4 decimals (never carry float noise into a recorded number). */
function round4(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 1e4) / 1e4
}

/** A finite number, or null. A boolean is NOT a number, however hard Number() tries. */
function num(v) {
  if (typeof v === 'boolean' || v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A non-empty trimmed string, or null. */
function str(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** A measured component. */
function measured(value, unit, source, extra = {}) {
  return { value, unit, status: 'measured', source, ...extra }
}

/** An unmeasured component — value null, and the reason said out loud. */
function unmeasured(unit, source, extra = {}) {
  return { value: null, unit, status: 'unmeasured', source, ...extra }
}

/**
 * countVerifiedResults(evalReport) → how many gold cases came back CORRECT, or null.
 *
 * «Correct» is not defined here — it is READ from the §8 report's own verdicts: a case
 * is verified when the measurer recorded no critical miss, no forbidden hit and no
 * abstention failure against it. Defining correctness a second time in this module
 * would produce a second answer that drifts from the benchmark it summarizes, and the
 * north star would then be a number about nothing in particular.
 *
 * Refused cases (a contaminating fixture) are already excluded from `cases_total` by the
 * scorer, so they are not subtracted again — an unmeasured case is neither a success nor
 * a failure.
 *
 * @param {object} evalReport a captureMemoryEval report
 * @returns {number|null} null when there is no report — no question asked, no answer
 */
export function countVerifiedResults(evalReport) {
  if (!evalReport || typeof evalReport !== 'object') return null
  const total = num(evalReport.summary?.cases_total)
  if (total == null) return null
  const failed = new Set()
  for (const key of ['critical_misses', 'forbidden_cases', 'abstain_failures']) {
    for (const entry of Array.isArray(evalReport[key]) ? evalReport[key] : []) {
      if (entry && typeof entry.case === 'string') failed.add(entry.case)
    }
  }
  return Math.max(0, total - failed.size)
}

/**
 * guardrailPanel({receipts, evalReport}) → the recorded evidence in ONE panel.
 *
 * Report: {metric:'guardrail-panel', rows:[{metric, value, unit, source_command,
 * status}], missing, check_command}
 *
 * Two families of row, and the difference between them is stated rather than blurred:
 *   - the RECORDED BASELINE RECEIPTS: value is the pinned digest, because that is what
 *     a receipt actually asserts — «this measurement still reproduces». The numbers
 *     themselves live in the reports the command re-runs.
 *   - the §8 GUARDRAILS: value is the measured number, straight out of the eval
 *     summary, with the eval command beside it.
 *
 * A guardrail with nothing recorded is a row with status `missing`, value `null`, and
 * the command that would PRODUCE it. That is the whole point of a panel: the empty
 * slots have to be as visible as the full ones, or the panel becomes a way of showing
 * only the measurements that went well.
 *
 * @param {object} [opts]
 * @param {object[]} [opts.receipts]   recorded baseline receipts (.sma/baseline/receipts.json)
 * @param {object} [opts.evalReport]   a captureMemoryEval report
 * @returns {object}
 */
export function guardrailPanel({ receipts = [], evalReport = null } = {}) {
  const rows = []
  const stored = new Map()
  for (const r of Array.isArray(receipts) ? receipts : []) {
    if (r && typeof r.id === 'string') stored.set(r.id, r)
  }

  // ── the recorded baseline receipts ──
  for (const metric of BASELINE_METRICS) {
    const id = receiptIdFor(metric)
    const receipt = stored.get(id)
    if (receipt && typeof receipt.expected_sha256 === 'string' && isSafeCommand(receipt.check_command)) {
      rows.push({
        metric: id,
        value: `${String(receipt.expected_sha256).slice(0, 12)} exit:${receipt.expected_exit ?? 0}`,
        unit: 'digest',
        source_command: receipt.check_command,
        status: 'recorded',
      })
      continue
    }
    rows.push({
      metric: id,
      value: null,
      unit: 'digest',
      // the command that PRODUCES the missing receipt, not one that re-runs a number
      // nobody recorded — one template, never five hand-copied strings
      source_command: `node scripts/sma/cli.mjs baseline capture --only ${metric} --record`,
      status: 'missing',
    })
  }

  // ── the §8 guardrails ──
  const flat = evalReport ? flattenSummary(evalReport.summary) : {}
  for (const metric of GUARDRAIL_EVAL_METRICS) {
    const has = Object.prototype.hasOwnProperty.call(flat, metric)
    const value = has ? flat[metric] : null
    rows.push({
      metric,
      value: has ? value : null,
      unit: 'metric',
      source_command: MEMORY_EVAL_CHECK_COMMAND,
      // present-but-null is «asked, no answer»; absent is «never asked» — different facts
      status: !has ? 'missing' : value == null ? 'unmeasured' : 'measured',
    })
  }

  return {
    metric: 'guardrail-panel',
    rows,
    missing: rows.filter((r) => r.status === 'missing').length,
    check_command: NORTH_STAR_CHECK_COMMAND,
  }
}

/**
 * captureNorthStar(opts) → cost per verified correct result, composed from the
 * measurers that already exist.
 *
 * Report:
 *   {metric:'north-star', components:{tokens, wall_clock_ms, compute, human_minutes},
 *    verified_results_count, verified_results_source, cost_per_verified_result|null,
 *    status:'measured'|'partial', measured_components, unmeasured_components,
 *    partial_reason, guardrail, summary, check_command}
 *
 * `cost_per_verified_result` at the TOP LEVEL is the ANSWER: `null` means there was
 * nothing to divide by, and no answer is a legitimate answer. Inside `summary` the same
 * name always exists with null members — that object is the STAT TABLE, and a table
 * whose column names appear and disappear between runs cannot be scripted against.
 *
 * @param {object} [opts]
 * @param {object} [opts.evalReport]     a captureMemoryEval report — the result counter
 * @param {object} [opts.book]           a spend.buildBook book — tokens and compute
 * @param {number} [opts.now]            epoch ms for the spend window (INJECTED)
 * @param {number} [opts.windowHours]    spend window (default 5, the product default)
 * @param {number} [opts.wallClockMs]    the timed duration of the verified run
 * @param {string} [opts.wallClockSource]what was timed, in words
 * @param {number} [opts.humanMinutes]   INJECTED; nothing measures it today
 * @param {object} [opts.selfCostPaths]  {claudeMd, memoryMd} — the static-injection fallback
 * @param {Function} [opts.readFile]
 * @param {object[]} [opts.receipts]     recorded baseline receipts (for the panel)
 * @param {string} [opts.checkCommand]
 * @returns {object}
 */
export function captureNorthStar(opts = {}) {
  const {
    evalReport = null,
    book = null,
    now,
    windowHours = 5,
    wallClockMs,
    wallClockSource,
    humanMinutes,
    selfCostPaths = null,
    readFile,
    receipts = [],
    checkCommand = NORTH_STAR_CHECK_COMMAND,
  } = opts

  // ── tokens: the spend book's own totals, or the static injection, or nothing ──
  //
  // A book built over NO session logs is not a measurement of zero — it is the absence
  // of a measurement, and the two must never print the same digit. buildBook fails open
  // (an undiscoverable logs directory returns an empty book rather than throwing), so
  // the emptiness arrives here looking exactly like a thrifty session. The event count
  // is what tells them apart, and it is checked ONCE, here, for both components.
  const t = book && typeof book.totals === 'object' ? book.totals : null
  const bookHasEvidence = t != null && (num(t.events) ?? 0) > 0

  let tokens
  const bookTokens = bookHasEvidence
    ? (num(t.inputTokens) ?? 0) + (num(t.outputTokens) ?? 0) + (num(t.cacheCreationTokens) ?? 0) + (num(t.cacheReadTokens) ?? 0)
    : null
  if (bookTokens != null) {
    tokens = measured(bookTokens, 'tokens', 'spend-книга (buildBook): вход + выход + запись и чтение кэша', {
      basis: 'session-book',
    })
  } else if (selfCostPaths) {
    // A NARROWER question, and the report says so: this is the static per-session
    // injection SMA itself costs, not the tokens a session spent producing results.
    const sc = selfCost({ readFile, paths: selfCostPaths })
    tokens =
      sc.total > 0
        ? measured(sc.total, 'tokens', `economy.selfCost: статическая инъекция за сессию (${sc.estimatorVersion})`, {
            basis: 'static-injection',
          })
        : unmeasured('tokens', 'economy.selfCost не нашёл ни одной инъекционной поверхности', { basis: 'static-injection' })
  } else {
    tokens = unmeasured('tokens', 'книга трат пуста или недоступна (ни одного события) — снять: node scripts/sma/cli.mjs spend', {
      basis: null,
    })
  }

  // ── compute: the priced dollars of the same window, from the same book ──
  // An empty window inside a book that HAS events is a real zero (nothing was spent in
  // those hours); an empty book is not a zero at all.
  const compute = bookHasEvidence
    ? measured(
        round4(windowSpend({ book, now, windowHours }).usd),
        'usd',
        `spend.windowSpend за окно ${windowHours} ч (прайсинг ${book.pricingVersion ?? 'не указан'})`,
      )
    : unmeasured('usd', 'книга трат пуста или недоступна (ни одного события) — снять: node scripts/sma/cli.mjs spend')

  // ── wall clock: whatever the caller actually TIMED, in the baseline discipline ──
  const wall =
    num(wallClockMs) != null
      ? measured(
          num(wallClockMs),
          'ms',
          str(wallClockSource) ?? 'настенно-часовой капчер: измеренная длительность прогона, который произвёл проверенные результаты',
        )
      : unmeasured('ms', 'ни один прогон не был измерен по времени — капчер настенных часов не вызывался')

  // ── human minutes: the honest hole ──
  const human =
    num(humanMinutes) != null
      ? measured(num(humanMinutes), 'minutes', 'минуты переданы вызывающим (замера в продукте по-прежнему нет)')
      : unmeasured('minutes', HUMAN_MINUTES_SOURCE)

  const components = { tokens, wall_clock_ms: wall, compute, human_minutes: human }

  const measuredNames = COST_COMPONENTS.filter((n) => components[n].status === 'measured').sort()
  const unmeasuredNames = COST_COMPONENTS.filter((n) => components[n].status !== 'measured').sort()

  // ── the divisor: read from the §8 verdicts, never re-derived ──
  const verified = countVerifiedResults(evalReport)
  const per = (v) => (verified != null && verified > 0 && v != null ? round4(v / verified) : null)
  const quotients = {
    tokens: per(tokens.value),
    wall_clock_ms: per(wall.value),
    compute_usd: per(compute.value),
    human_minutes: per(human.value),
  }
  // `null` when there was nothing to divide by. No answer is an answer; a fabricated
  // one is not.
  const costPer = verified != null && verified > 0 ? quotients : null

  const status = unmeasuredNames.length === 0 ? 'measured' : 'partial'
  const guardrail = guardrailPanel({ receipts, evalReport })

  const summary = {
    verified_results_count: verified,
    status,
    tokens: tokens.value,
    wall_clock_ms: wall.value,
    compute_usd: compute.value,
    human_minutes: human.value,
    cost_per_verified_result: quotients,
    unmeasured_components: unmeasuredNames.length,
    guardrail_rows: guardrail.rows.length,
    guardrail_missing: guardrail.missing,
  }

  return {
    metric: 'north-star',
    components,
    verified_results_count: verified,
    verified_results_source:
      'вердикты бенчмарка §8 (eval memory): кейс проверен, когда измеритель не записал против него ' +
      'ни критического промаха, ни запрещённого попадания, ни провала воздержания',
    cost_per_verified_result: costPer,
    status,
    measured_components: measuredNames,
    unmeasured_components: unmeasuredNames,
    partial_reason:
      unmeasuredNames.length === 0
        ? null
        : `формула деградирована до измеримых слагаемых; не измерено: ${unmeasuredNames.join(', ')}`,
    guardrail,
    summary,
    check_command: checkCommand,
  }
}

/**
 * evalFeatureGate(decl) → {ok, missing, errors, elements, feature}.
 *
 * The five-element admission check for a new feature: FAILURE CLASS (which observed way
 * of being wrong this addresses) · BASELINE (the recorded number it will be compared
 * against) · PREDICTION (falsifiable: a metric, a comparator, a numeric threshold and a
 * command that produces the number) · ACCEPTANCE (what «it worked» means before the work
 * starts) · ROLLBACK (how it leaves the default path again).
 *
 * A PURE validator: no I/O, no clock, no network. It refuses BY NAME — an element that
 * is absent is named in `missing`, an element that is present but unusable is named in
 * `errors` with the reason. A gate that answers only «no» teaches nobody anything.
 *
 * The prediction is held to the SAME boundary as the predictions ledger (predict.mjs
 * COMPARATORS + isSafeCommand): a gate with a looser notion of «checkable» than the
 * ledger would be a documented way around the ledger. A non-numeric threshold is the
 * refusal that matters most — «it will be better» is not a prediction, it is a wish,
 * and a wish cannot be wrong, which is precisely what makes it useless as evidence.
 *
 * @param {object} decl
 * @returns {{ok:boolean, missing:string[], errors:Array<{element:string, reason:string}>,
 *            elements:readonly string[], feature:(string|null)}}
 */
export function evalFeatureGate(decl) {
  const d = decl && typeof decl === 'object' && !Array.isArray(decl) ? decl : {}
  const missing = []
  const errors = []

  for (const element of GATE_ELEMENTS) {
    const value = d[element]
    if (element === 'prediction') {
      if (value == null) {
        missing.push(element)
        continue
      }
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ element, reason: 'прогноз обязан быть объектом {metric, comparator, threshold, check_command}' })
        continue
      }
      continue
    }
    if (str(value) == null) missing.push(element)
  }

  // The prediction's own four keys — named with their parent, so a refusal points at
  // the line to fix rather than at the block that contains it.
  const p = d.prediction && typeof d.prediction === 'object' && !Array.isArray(d.prediction) ? d.prediction : {}
  const predictionUsable = !missing.includes('prediction') && !errors.some((e) => e.element === 'prediction')

  for (const key of GATE_PREDICTION_KEYS) {
    const name = `prediction.${key}`
    const raw = p[key]
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      missing.push(name)
      continue
    }
    if (!predictionUsable) continue
    if (key === 'comparator' && !COMPARATORS.includes(raw)) {
      errors.push({ element: name, reason: `компаратор «${raw}» не входит в набор [${COMPARATORS.join(', ')}]` })
    }
    if (key === 'threshold' && num(raw) == null) {
      errors.push({ element: name, reason: `порог «${raw}» не число — прогноз без числа нельзя опровергнуть` })
    }
    if (key === 'metric' && str(raw) == null) {
      errors.push({ element: name, reason: 'имя метрики обязано быть непустой строкой' })
    }
    if (key === 'check_command' && !isSafeCommand(String(raw))) {
      errors.push({ element: name, reason: 'команда проверки вне разрешённого списка — числа никто не сможет получить заново' })
    }
  }

  return {
    ok: missing.length === 0 && errors.length === 0,
    missing,
    errors,
    elements: GATE_ELEMENTS,
    feature: str(d.feature),
  }
}
