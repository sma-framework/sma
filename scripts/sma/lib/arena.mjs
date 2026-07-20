/**
 * arena.mjs — the comparative benchmark arena scorer (9.3-11, D-9.3-18, BL-142).
 *
 * ═══════════════════════════ WHAT THIS IS ════════════════════════════════════
 *
 * The passport (9.3-02) proves calibration on OUR repo; the arena proves the
 * adoption claim against named rivals on NEUTRAL ground. It hardens the founder-run
 * n=1 pilot (9.3-11-PILOT-*) into a reproducible n>=4 four-arm comparison — vanilla
 * Claude Code / GSD only / Superpowers only / SMA — over a FIXED ticket set on a
 * public repo, scored FULLY DETERMINISTICALLY (git-diff LOC, acceptance test pass
 * count, tokens+cost via the 9.2-09 spend-adapter, plus a separate adversarial
 * safety tier). This module is the in-repo surface: the deterministic scorer /
 * aggregator + the static-HTML report generator. The harness proper (the four
 * isolated per-arm runs) is OUTSIDE this repo, founder-driven (see the ARENA runbook).
 *
 * ═══════════════════════════ THE THREE LOCKS ═════════════════════════════════
 *
 * D-9.3-18 — the tested claim is cost-per-RESULT, not cost-per-task. The headline is
 *   M1 (done-right-first-time) + M2 (rework rounds). M3 (raw tokens/$) is REPORTED but
 *   NEVER the headline and NEVER the sort key. A run where SMA is the most expensive
 *   per task is PUBLISHED as-is — suppressing a negative result is a class-A miss. The
 *   `suppressed` guard is empty BY CONSTRUCTION; no arm is ever dropped for looking bad.
 *
 * D-9.3-02 — consume, never reimplement. The 9.2-09 spend-adapter is the SOLE
 *   token/cost source across all four arms. The operator gathers per-arm cost by running
 *   `SMA_SPEND_LOGS_DIR=<arm-cfg>/... node scripts/sma/cli.mjs spend` from each arm's
 *   clone; arena.mjs INGESTS those version-tagged totals as records — it writes NO second
 *   cost scraper and NEVER re-parses a raw session log. A record whose adapterVersion is
 *   unknown to the injected version set is FLAGGED as drift (counted, never lost), never
 *   silently mis-scored.
 *
 * Determinism — the scorer is a PURE function of the recorded per-arm data. No
 *   wall-clock, no randomness in any aggregate or in the rendered report BODY. The page's
 *   footer timestamp is the SOLE dated field (house HTML rule); re-scoring the same
 *   records yields byte-identical aggregates and a byte-identical report body.
 *
 * Node built-ins only; zero npm deps, zero network, zero LLM, zero child_process.
 */

/** The minimum runs an arm needs before its numbers are a settled arena result. */
export const MIN_ARENA_N = 4

/** The attempt budget from the frozen SCORING contract: first-done + <=2 rework rounds. */
export const MAX_REWORK_ROUNDS = 2

/**
 * ARENA_METRICS — the frozen metric registry (encodes the pilot SCORING M1-M7).
 * `axis` ∈ capability|cost|safety; `headline:true` ONLY for M1+M2 (the cost-per-RESULT
 * claim). M3 is cost, reported-not-headline. M7 is the light safety marker the pilot
 * used; the arena's full adversarial safety tier lives on the same `safety` axis.
 */
export const ARENA_METRICS = [
  { id: 'M1', label: 'Приёмка с первого раза (доля тестов пройдена)', axis: 'capability', headline: true },
  { id: 'M2', label: 'Докрутки до зелёного', axis: 'capability', headline: true },
  { id: 'M3', label: 'Токены и стоимость ($)', axis: 'cost', headline: false },
  { id: 'M4', label: 'Объём изменений (LOC)', axis: 'capability', headline: false },
  { id: 'M6', label: 'Вопросы к человеку', axis: 'capability', headline: false },
  { id: 'M7', label: 'Выход за рамки задачи (safety)', axis: 'safety', headline: false },
]

// ═══════════════════════════ deterministic helpers ═══════════════════════════

/** Round to 1e-6 so floating-point re-scoring is byte-identical. */
function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6
}

/** Finite number or a fallback. */
function fin(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** Deterministic mean over a numeric array (sorted-order-independent; empty → 0). */
function mean(arr) {
  const xs = (arr || []).map((x) => fin(x))
  if (!xs.length) return 0
  return round6(xs.reduce((a, b) => a + b, 0) / xs.length)
}

/** Deterministic median over a numeric array (sorted copy; empty → 0). */
function median(arr) {
  const xs = (arr || []).map((x) => fin(x)).sort((a, b) => a - b)
  if (!xs.length) return 0
  const mid = Math.floor(xs.length / 2)
  return round6(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2)
}

/**
 * A rework-round value normalized to a number. `null`/'не сошлось'/undefined (budget
 * exhausted without green) becomes MAX_REWORK_ROUNDS+1 — a deterministic penalty that
 * ranks below any arm that converged, and is separately counted as `notConverged`.
 */
function normRounds(v) {
  if (v === null || v === undefined || v === 'не сошлось' || v === 'not-converged') {
    return MAX_REWORK_ROUNDS + 1
  }
  return fin(v)
}

// ═══════════════════════════ scoreArm ════════════════════════════════════════

/**
 * scoreArm(rawArmRecord, opts) → the arm's deterministic scored row.
 *
 * rawArmRecord: { arm, label?, m1PassCounts:[{pass,total}], m2Rounds:[n|null],
 *   m3Cost:[{cost,adapterVersion,events}], m4Loc:[{added,removed}], m6Questions:[n],
 *   m7Scope:[bool] } — the metric arrays aligned by run index (n = number of runs).
 *
 * opts.adapterVersions: the KNOWN spend-adapter version set (DI — the caller injects
 *   `ADAPTER_VERSIONS.map(a=>a.version)` from spend-adapter.mjs; D-9.3-02). A cost
 *   record tagged with a version NOT in this set is booked but flagged as drift.
 *
 * Returns { arm, label, n, m1Median, m1FirstDoneRate, m2MeanRounds, m2NotConverged,
 *   m3MeanCost, m3MeanCostPerResult, m4MeanLoc, m6MeanQuestions, safetyFlags,
 *   underpowered, adapterVersions, unknownAdapterVersions }. Pure — two calls on the
 *   same input are deep-equal.
 */
export function scoreArm(rawArmRecord, opts = {}) {
  const rec = rawArmRecord || {}
  const known = new Set(opts.adapterVersions || [])
  const m1 = Array.isArray(rec.m1PassCounts) ? rec.m1PassCounts : []
  const m2 = Array.isArray(rec.m2Rounds) ? rec.m2Rounds : []
  const m3 = Array.isArray(rec.m3Cost) ? rec.m3Cost : []
  const m4 = Array.isArray(rec.m4Loc) ? rec.m4Loc : []
  const m6 = Array.isArray(rec.m6Questions) ? rec.m6Questions : []
  const m7 = Array.isArray(rec.m7Scope) ? rec.m7Scope : []
  const n = m1.length

  // M1 — pass rate per run; done-right-first-time = a full pass (pass === total).
  const passRates = m1.map((c) => {
    const total = fin(c && c.total, 0)
    return total > 0 ? fin(c && c.pass) / total : 0
  })
  const firstDone = m1.map((c) => fin(c && c.total) > 0 && fin(c && c.pass) === fin(c && c.total))
  const firstDoneCount = firstDone.filter(Boolean).length
  const m1FirstDoneRate = n > 0 ? round6(firstDoneCount / n) : 0

  // M2 — rounds to green (a non-converged run is penalized + counted).
  const rounds = m2.map(normRounds)
  const m2NotConverged = m2.filter((v) => normRounds(v) > MAX_REWORK_ROUNDS).length

  // M3 — cost is CONSUMED from the version-tagged adapter records (never re-parsed).
  const costs = m3.map((c) => fin(c && c.cost))
  const seenVersions = new Set()
  const unknown = new Set()
  for (const c of m3) {
    const v = c && c.adapterVersion
    if (typeof v === 'string' && v) {
      seenVersions.add(v)
      if (known.size && !known.has(v)) unknown.add(v)
    }
  }
  const m3MeanCost = mean(costs)
  const totalCost = round6(costs.reduce((a, b) => a + b, 0))
  // cost-per-RESULT = total spend / results done right first time (provisional if none).
  const m3MeanCostPerResult = firstDoneCount > 0 ? round6(totalCost / firstDoneCount) : null

  // M4 — LOC churn.
  const added = m4.map((c) => fin(c && c.added))
  const removed = m4.map((c) => fin(c && c.removed))
  const m4MeanLoc = {
    added: mean(added),
    removed: mean(removed),
    churn: round6(mean(added) + mean(removed)),
  }

  // M7 — the safety axis (scope-creep), kept SEPARATE from the capability numbers.
  const scopeCreepRuns = m7.filter(Boolean).length
  const safetyFlags = { flagged: scopeCreepRuns > 0, scopeCreepRuns }

  return {
    arm: String(rec.arm ?? ''),
    label: typeof rec.label === 'string' && rec.label ? rec.label : String(rec.arm ?? ''),
    n,
    m1Median: median(passRates),
    m1FirstDoneRate,
    m2MeanRounds: mean(rounds),
    m2NotConverged,
    m3MeanCost,
    m3MeanCostPerResult,
    m4MeanLoc,
    m6MeanQuestions: mean(m6.map((x) => fin(x))),
    safetyFlags,
    underpowered: n < MIN_ARENA_N,
    adapterVersions: [...seenVersions].sort(),
    unknownAdapterVersions: [...unknown].sort(),
  }
}

// ═══════════════════════════ rankByCostPerResult ═════════════════════════════

/**
 * rankByCostPerResult(scoredArms) → a NEW array ordered by the done-right-first-time
 * composite: m1FirstDoneRate DESC, then m2MeanRounds ASC. m3MeanCost is a CARRIED
 * column, NEVER the sort key (D-9.3-18) — so an arm that is expensive per task can
 * still rank first if it gets the result right first time. A tie on both keys preserves
 * input order (stable), independent of raw cost. Does not mutate the input.
 */
export function rankByCostPerResult(scoredArms) {
  return (scoredArms || [])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (b.s.m1FirstDoneRate !== a.s.m1FirstDoneRate) return b.s.m1FirstDoneRate - a.s.m1FirstDoneRate
      if (a.s.m2MeanRounds !== b.s.m2MeanRounds) return a.s.m2MeanRounds - b.s.m2MeanRounds
      return a.i - b.i // stable: ties keep input order, cost is irrelevant here
    })
    .map((x) => x.s)
}

// ═══════════════════════════ aggregateArena ══════════════════════════════════

/**
 * aggregateArena(scoredArms) → the arena table + the SEPARATE safety axis + the honesty
 * guards. Returns { arms, ranking, safetyAxis, suppressed, underpowered, metrics }.
 *   - arms: every scored arm, in input order — NO arm dropped (Test 3).
 *   - ranking: rankByCostPerResult(arms) — cost-per-result order (M1+M2), not cost.
 *   - safetyAxis: per-arm { arm, flagged, scopeCreepRuns } — safety on its OWN axis,
 *     reported alongside, never averaged into capability (Test 5).
 *   - suppressed: [] ALWAYS, by construction — the anti-cherry-pick invariant (Test 3).
 *   - underpowered: the arm names with n<MIN_ARENA_N, marked provisional (Test 6).
 * Pure — the same scored arms always aggregate identically.
 */
export function aggregateArena(scoredArms) {
  const arms = (scoredArms || []).slice()
  return {
    arms,
    ranking: rankByCostPerResult(arms),
    safetyAxis: arms.map((a) => ({
      arm: a.arm,
      flagged: !!(a.safetyFlags && a.safetyFlags.flagged),
      scopeCreepRuns: (a.safetyFlags && a.safetyFlags.scopeCreepRuns) || 0,
    })),
    suppressed: [], // NEVER populated — a negative result is structurally un-droppable
    underpowered: arms.filter((a) => a.underpowered).map((a) => a.arm),
    metrics: ARENA_METRICS,
  }
}

// ═══════════════════════════ renderArenaReport ═══════════════════════════════

/** Minimal HTML escape (the arm labels are ours, but escape defensively). */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A sentinel wrapping the generated timestamp — the SOLE dated field on the page. */
const GEN_OPEN = '<span class="arena-generated">'
const GEN_CLOSE = '</span>'

/**
 * stripGeneratedTimestamp(html) → the report BODY with the footer timestamp removed, so
 * two renders at DIFFERENT wall-clock times can be byte-compared for body determinism
 * (P9.3-11-A). The timestamp is the only field that legitimately varies over time.
 */
export function stripGeneratedTimestamp(html) {
  const start = String(html).indexOf(GEN_OPEN)
  if (start < 0) return String(html)
  const end = String(html).indexOf(GEN_CLOSE, start)
  if (end < 0) return String(html)
  return String(html).slice(0, start + GEN_OPEN.length) + String(html).slice(end)
}

/** Format an epoch-ms as the house Munich stamp: DD.MM.YYYY, HH:MM (Мюнхен, CET/CEST). */
function munichStamp(now) {
  const d = new Date(fin(now, Date.now()))
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || ''
  // Munich is CET (UTC+1) or CEST (UTC+2); derive the label from the offset.
  const offMin = -new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getTimezoneOffset()
  const tz = offMin === 120 ? 'CEST' : 'CET'
  return `${g('day')}.${g('month')}.${g('year')}, ${g('hour')}:${g('minute')} (Мюнхен, ${tz})`
}

/**
 * renderArenaReport(aggregate, opts) → a STATIC HTML page (string). No daemon, no
 * `sma ui` — the `sma report` posture (substrate law). It shows:
 *   - the cost-per-RESULT ranking table (M1+M2 the headline),
 *   - the raw M1-M7 columns INCLUDING every arm's cost row (negatives shown, not hidden),
 *   - the SEPARATE safety axis,
 *   - the provisional (underpowered n<4) note,
 *   - a Munich last-updated footer timestamp (the sole dated field; opts.now).
 * The BODY is a pure function of `aggregate`; only the footer varies with `opts.now`.
 * Plain language, formal Вы, NO em-dashes in the RU copy (D-9.3-15).
 */
export function renderArenaReport(aggregate, opts = {}) {
  const agg = aggregate || {}
  const arms = agg.arms || []
  const ranking = agg.ranking || rankByCostPerResult(arms)
  const rankIndex = new Map(ranking.map((a, i) => [a.arm, i + 1]))
  const fmtCPR = (v) => (v === null || v === undefined ? 'предварительно' : `$${v}`)

  const rankRows = ranking
    .map((a, i) => {
      const prov = a.underpowered ? ' <em>(предварительно, n&lt;4)</em>' : ''
      return `        <tr>
          <td class="rank">${i + 1}</td>
          <td>${esc(a.label)}${prov}</td>
          <td>${Math.round(a.m1FirstDoneRate * 100)}%</td>
          <td>${a.m2MeanRounds}</td>
          <td class="cost">${fmtCPR(a.m3MeanCostPerResult)}</td>
        </tr>`
    })
    .join('\n')

  const rawRows = arms
    .map((a) => {
      const flagged = a.safetyFlags && a.safetyFlags.flagged
      return `        <tr${a.underpowered ? ' class="provisional"' : ''}>
          <td>#${rankIndex.get(a.arm) ?? '-'}</td>
          <td>${esc(a.label)}</td>
          <td>${a.n}</td>
          <td>${Math.round(a.m1FirstDoneRate * 100)}%</td>
          <td>${a.m2MeanRounds}</td>
          <td class="cost">$${a.m3MeanCost}</td>
          <td>${fmtCPR(a.m3MeanCostPerResult)}</td>
          <td>${a.m4MeanLoc ? a.m4MeanLoc.churn : 0}</td>
          <td>${a.m6MeanQuestions}</td>
          <td>${flagged ? `⚠ ${a.safetyFlags.scopeCreepRuns}` : 'нет'}</td>
        </tr>`
    })
    .join('\n')

  const safetyRows = (agg.safetyAxis || [])
    .map(
      (s) => `        <tr>
          <td>${esc(s.arm)}</td>
          <td>${s.flagged ? `⚠ выход за рамки в ${s.scopeCreepRuns} прогонах` : 'чисто'}</td>
        </tr>`,
    )
    .join('\n')

  const underNote = (agg.underpowered || []).length
    ? `<p class="note">Предварительные руки (менее ${MIN_ARENA_N} прогонов, разведка, не итоговая цифра): ${(agg.underpowered || []).map(esc).join(', ')}.</p>`
    : ''

  const stamp = munichStamp(opts.now)

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Арена сравнения: цена за результат</title>
<style>
  :root { --ink:#0A0D14; --surface:#11151F; --line:#243B66; --blue:#3B82F6; --text:#E8ECF4; --muted:#8FA0BF; }
  body { margin:0; background:var(--ink); color:var(--text); font-family:'Cormorant',Georgia,serif; padding:2.5rem 1.5rem; }
  .wrap { max-width:960px; margin:0 auto; }
  h1 { font-size:2rem; font-weight:600; margin:0 0 .5rem; }
  .lede { color:var(--muted); font-size:1.1rem; margin:0 0 2rem; max-width:60ch; }
  h2 { font-size:1.35rem; margin:2rem 0 .75rem; border-bottom:1px solid var(--line); padding-bottom:.35rem; }
  table { width:100%; border-collapse:collapse; font-size:.95rem; }
  th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid rgba(36,59,102,.5); }
  th { color:var(--muted); font-weight:600; }
  td.rank { color:var(--blue); font-weight:700; }
  td.cost { font-variant-numeric:tabular-nums; }
  tr.provisional td { color:var(--muted); font-style:italic; }
  .note { color:var(--muted); font-size:.9rem; margin-top:.75rem; }
  footer { margin-top:3rem; color:var(--muted); font-size:.85rem; border-top:1px solid var(--line); padding-top:1rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Арена сравнения четырёх сетапов</h1>
  <p class="lede">Мы меряем цену за РЕЗУЛЬТАТ, а не за задачу. Главные метрики: сделано правильно с первого раза (M1) и сколько докруток до зелёного (M2). Стоимость (M3) показана, но она не заголовок. Там, где SMA дороже за задачу, строка всё равно опубликована. Так и задумано: продавец не может честно оценивать работу своего же агента, поэтому мы показываем и то, где проигрываем.</p>

  <h2>Рейтинг по цене за результат (M1 плюс M2)</h2>
  <table>
    <thead><tr><th>Место</th><th>Сетап</th><th>С первого раза</th><th>Докрутки</th><th>Цена за результат</th></tr></thead>
    <tbody>
${rankRows}
    </tbody>
  </table>

  <h2>Сырые метрики (все строки, включая дорогие)</h2>
  <table>
    <thead><tr><th>Ранг</th><th>Сетап</th><th>n</th><th>M1</th><th>M2</th><th>M3 за задачу</th><th>Цена за результат</th><th>M4 LOC</th><th>M6 вопросов</th><th>M7 safety</th></tr></thead>
    <tbody>
${rawRows}
    </tbody>
  </table>
  ${underNote}

  <h2>Отдельная ось безопасности (M7 и adversarial tier)</h2>
  <p class="note">Флаг безопасности показан рядом со способностями, а не усреднён в них. Сильная по способностям рука с флагом безопасности публикуется с флагом.</p>
  <table>
    <thead><tr><th>Сетап</th><th>Выход за рамки задачи</th></tr></thead>
    <tbody>
${safetyRows}
    </tbody>
  </table>

  <footer>
    Данные воспроизводимы: страница пересобирается из сырых записей по прогонам (arena report). Единственное меняющееся поле ниже это отметка времени.<br>
    Последнее обновление: ${GEN_OPEN}${stamp}${GEN_CLOSE}
  </footer>
</div>
</body>
</html>
`
}
