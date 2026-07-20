/**
 * sp-report.mjs — SP-калибровка «оценил ↔ факт» (Phase 9.5 Plan 07, Task 4;
 * D-9.5-11 item 2, D-9.5-10).
 *
 * WHAT IT IS: a deterministic, ZERO-LLM report that lets the founder compare the CUE
 * estimate against reality per SP bucket. It groups COMPLETED tasks by storyPoints and,
 * per bucket, computes the median cycle time (enqueuedAt→completedAt), median work time
 * (claimedAt→completedAt), € (total + median) and diff size, plus a 3×-median cycle-time
 * outlier cut. Tasks missing a needed timestamp are SKIPPED and counted — never a crash.
 *
 * WHY IT LIVES DAEMON-SIDE (D-9.5-11 item 2): the queue timestamps this report consumes
 * (enqueuedAt/claimedAt/completedAt — D-9.5-10) live in the daemon's Postgres; the
 * daemon owns the data. This module is PURE — no I/O, an injectable clock, every reader
 * injected (adapter.list, a per-task usageReader, an optional ledger) — so the suite runs
 * on fixtures alone.
 *
 * ═══ THE PROHIBITION IS STRUCTURAL (D-9.5-10 запрет п.4) ═══
 * renderSpReport's FIRST content line after the title is ALWAYS, verbatim:
 *   «SP не переводятся в часы и не используются как KPI»
 * A test greps the rendered output for that exact sentence. This is what makes the report
 * structurally incapable of quietly becoming an hours converter or a worker KPI — the
 * moment someone deletes the line, the suite goes red.
 *
 * Node built-ins only (in fact none needed). Zero deps; zero network.
 */

/** The prohibition line — printed verbatim as the report's first content line (D-9.5-10). */
export const SP_PROHIBITION = 'SP не переводятся в часы и не используются как KPI'

/** The Fibonacci SP buckets (D-9.5-10). A no-SP bucket ('none') catches roster/return tasks. */
const SP_BUCKETS = Object.freeze([1, 2, 3, 5, 8, 13])

const HOUR_MS = 3600000

/** Median of a numeric array (avg of the two middles for an even count). NaN → skipped upstream. */
function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

/** Sum of a numeric array. */
function sum(nums) {
  let t = 0
  for (const n of nums) t += n
  return t
}

/** Parse a diffStat (`'+10 -2'` or a number) to a total changed-line count; NaN if unparseable. */
function parseDiffSize(diffStat) {
  if (typeof diffStat === 'number') return Number.isFinite(diffStat) ? diffStat : NaN
  if (typeof diffStat !== 'string') return NaN
  let total = 0
  let found = false
  for (const m of diffStat.matchAll(/([+-])(\d+)/g)) {
    total += Number.parseInt(m[2], 10)
    found = true
  }
  return found ? total : NaN
}

/** The bucket key for a task: its Fibonacci SP if valid, else 'none'. */
function bucketKey(storyPoints) {
  return SP_BUCKETS.includes(storyPoints) ? storyPoints : 'none'
}

/**
 * buildSpReport({adapter, ledger, usageReader, clock, windowDays}) → the calibration data.
 * Reads adapter.list(), keeps COMPLETED tasks inside the window with ALL THREE timestamps,
 * groups them by storyPoints, and computes the per-bucket medians + the outlier list. Rows
 * that are terminal but missing a timestamp are counted in `skipped`, never fatal.
 *
 * @param {{adapter:{list:Function}, ledger?:object, usageReader?:(taskId:string)=>number, clock?:()=>number, windowDays?:number}} deps
 * @returns {Promise<{windowDays:number, generatedAt:string, buckets:object[], outliers:object[], skipped:number}>}
 */
export function buildSpReport(deps = {}) {
  // A thin sync wrapper over the async body (the adapter.list read is async): keeps the
  // exported name a plain `export function buildSpReport(` while returning the promise.
  return _buildSpReport(deps)
}

async function _buildSpReport({ adapter, ledger, usageReader, clock = Date.now, windowDays = 30 } = {}) {
  const now = clock()
  const windowStart = now - windowDays * 24 * HOUR_MS
  const eurOf = typeof usageReader === 'function' ? usageReader : () => 0

  let rows = []
  try {
    rows = await adapter.list({})
  } catch {
    rows = [] // a list failure yields an empty report, never a crash
  }

  // Collect per-bucket contributing tasks; count skips for terminal-but-incomplete rows.
  const contributors = [] // {key, id, title, storyPoints, cycleMs, workMs, eur, diff}
  let skipped = 0

  for (const r of rows) {
    if (r.status !== 'completed' && r.status !== 'failed') continue // only terminal tasks
    const enq = toMs(r.enqueuedAt)
    const claim = toMs(r.claimedAt)
    const done = toMs(r.completedAt)
    // A calibration contribution needs the full timeline; anything short is skipped honestly.
    if (r.status !== 'completed' || !Number.isFinite(enq) || !Number.isFinite(claim) || !Number.isFinite(done)) {
      skipped += 1
      continue
    }
    if (done < windowStart) continue // outside the window — not a skip, just out of scope

    // diff: prefer a completed attempt row's diffStat, else the task row's diffStat.
    let diff = NaN
    if (ledger && typeof ledger.readAttempts === 'function') {
      const attempts = ledger.readAttempts(r.id) || []
      const finished = attempts.find((a) => a && a.outcome === 'completed' && a.diffStat !== undefined)
      if (finished) diff = parseDiffSize(finished.diffStat)
    }
    if (!Number.isFinite(diff)) diff = parseDiffSize(r.diffStat)

    contributors.push({
      key: bucketKey(r.storyPoints),
      id: r.id,
      title: r.title,
      storyPoints: r.storyPoints ?? null,
      cycleMs: done - enq,
      workMs: done - claim,
      eur: Number(eurOf(r.id)) || 0,
      diff: Number.isFinite(diff) ? diff : null,
    })
  }

  // Assemble buckets in the fixed SP order + a trailing 'none' bucket, omitting empties.
  const buckets = []
  const outliers = []
  for (const key of [...SP_BUCKETS, 'none']) {
    const inBucket = contributors.filter((c) => c.key === key)
    if (!inBucket.length) continue
    const cycles = inBucket.map((c) => c.cycleMs)
    const medianCycleMs = median(cycles)
    const diffs = inBucket.map((c) => c.diff).filter((d) => Number.isFinite(d))
    buckets.push({
      storyPoints: key,
      count: inBucket.length,
      medianCycleMs,
      medianWorkMs: median(inBucket.map((c) => c.workMs)),
      totalEur: round2(sum(inBucket.map((c) => c.eur))),
      medianEur: round2(median(inBucket.map((c) => c.eur)) ?? 0),
      medianDiff: diffs.length ? median(diffs) : null,
    })
    // Outliers: cycle time beyond 3× the bucket median.
    if (Number.isFinite(medianCycleMs) && medianCycleMs > 0) {
      for (const c of inBucket) {
        if (c.cycleMs > 3 * medianCycleMs) {
          outliers.push({ id: c.id, title: c.title, storyPoints: c.storyPoints, cycleTimeMs: c.cycleMs })
        }
      }
    }
  }

  return { windowDays, generatedAt: new Date(now).toISOString(), buckets, outliers, skipped }
}

/** Coerce a timestamp (number ms or ISO string) to epoch ms, or NaN. */
function toMs(v) {
  if (typeof v === 'number') return v
  if (v == null) return NaN
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : NaN
}

/** Round to 2 decimals (money). */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Hours label for an ms duration (display only — NEVER an SP→hours conversion). */
function hrs(ms) {
  if (!Number.isFinite(ms)) return '—'
  return `${(ms / HOUR_MS).toFixed(1)}ч`
}

/**
 * renderSpReport(data) → a plain-text RU report. The FIRST content line after the title is
 * the D-9.5-10 prohibition VERBATIM (structurally mandatory). Then one line per bucket and
 * an outliers section. Display hours are for reading the medians only — they are NOT an
 * SP→hours conversion (the prohibition line says so).
 *
 * @param {object} data  the buildSpReport output
 * @returns {string}
 */
export function renderSpReport(data = {}) {
  const windowDays = data.windowDays ?? 30
  const lines = []
  lines.push(`Отчёт SP-калибровки «оценил ↔ факт» (окно ${windowDays} дн.)`)
  lines.push(SP_PROHIBITION) // ← first content line after the title, verbatim (D-9.5-10)
  lines.push('')

  const buckets = Array.isArray(data.buckets) ? data.buckets : []
  if (!buckets.length) {
    lines.push('Нет завершённых задач в окне.')
  } else {
    lines.push('Бакеты:')
    for (const b of buckets) {
      const label = b.storyPoints === 'none' ? 'SP=нет' : `SP=${b.storyPoints}`
      const diff = Number.isFinite(b.medianDiff) ? `${b.medianDiff} стр.` : '—'
      lines.push(
        `  ${label}: задач ${b.count}; медиана цикла ${hrs(b.medianCycleMs)}; ` +
          `медиана в работе ${hrs(b.medianWorkMs)}; € всего ${b.totalEur}, медиана ${b.medianEur}; медиана диффа ${diff}`,
      )
    }
  }

  const outliers = Array.isArray(data.outliers) ? data.outliers : []
  lines.push('')
  lines.push(`Выбросы (цикл > 3× медианы бакета): ${outliers.length}`)
  for (const o of outliers) {
    const sp = o.storyPoints == null ? 'нет' : o.storyPoints
    lines.push(`  ${o.id} (SP=${sp}, «${o.title}»): цикл ${hrs(o.cycleTimeMs)}`)
  }

  lines.push('')
  lines.push(`Пропущено строк (нет таймстемпа): ${data.skipped ?? 0}`)
  return lines.join('\n')
}
