/**
 * economy.mjs — the SMA economy meters (49.4-06, BL-176/BL-160). The caveman
 * absorption done the SMA way (49.4-RESEARCH-ECONOMY §2 rows 4/6): their local
 * token estimates become a VERSIONED estimator, their per-turn overhead caveat
 * becomes our own self-cost meter, and — unlike them — every savings number is
 * paired with quality guards and every budget derives ONLY from OUR measured
 * history (never a vendor benchmark, never an assumed number).
 *
 * Three meters, one module:
 *   1. corpusStats  — the deterministic, VERSIONED corpus token-cost report
 *                     (core load / per note / per INDEX-*.md / top-N heaviest).
 *   2. selfCost     — the framework's OWN static per-session injection overhead
 *                     (SMA:RULES span, emitted corpus block span, MEMORY.md core);
 *                     names what is NOT counted (variable per-turn hook stdout).
 *   3. lane budgets — per-lane (fix/quick/batch/build) window budgets derived from
 *                     the platform's own spend-ledger percentiles (p75 default);
 *                     an overrun is a SCORED calibration miss + an auto-drafted
 *                     lesson, both produced by CONSUMING the existing machinery.
 *
 * HONESTY POSTURE (mirrors spend.mjs D-49.2-13):
 *   - A lane with fewer than minRuns closed CLEAN runs derives NO budget and stays
 *     report-only (the capUsd:null law — a soft signal never fires off a guess).
 *   - Multi-terminal contamination is COUNTED (sessionsInWindow + overlap flag) and
 *     ACTED on: overlap-flagged runs are EXCLUDED from derivation AND can never score
 *     an overrun miss — report-only (grill CH-49.4-06-1). A miss is NEVER scored off
 *     tokens/dollars another terminal may have burned.
 *   - The book exposes USD per event, not tokens; lane budgets therefore meter the
 *     two per-window signals the book DOES expose (dollars + minutes), and this is
 *     stated plainly. The TOKEN meters are corpusStats + selfCost.
 *
 * SUBSTRATE LAW: Node built-ins only. Zero network, zero LLM, zero child_process in
 * this module. Every input is dependency-injectable ({readFile, spendDir, corpusDir,
 * now, book, appendVerdict, draftLesson}); the CLI layer injects the real io. The
 * scored-miss row is shaped EXACTLY as a scorePlan miss so predict.draftLessonFromMiss
 * works UNMODIFIED (D-49.3-02: consume, never reimplement).
 */

import {
  readFileSync,
  readdirSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { anchorMarkers } from './emit.mjs'
import { RULES_MARKERS } from './claude-embed.mjs'

// ═══════════════════════════ the versioned estimator ════════════════════════════

/**
 * ESTIMATOR_VERSION — stamped into EVERY report so numbers are reproducible run-to-run
 * and never silently swapped (the pricingVersion pattern from spend-adapter.mjs). A
 * change to estimateTokens MUST bump this string.
 */
export const ESTIMATOR_VERSION = 'sma-token-estimate-v1'

/** The approximation caveat carried in every report — never billing truth. */
export const APPROX_CAVEAT =
  'Оценка приблизительная (около 4 UTF-8 байт на токен), а не биллинговая правда; ' +
  `версия оценщика ${ESTIMATOR_VERSION}.`

/**
 * estimateTokens(text) -> a deterministic, non-negative integer token estimate.
 * ONE documented rule: ceil(UTF-8 byte length / 4). Pure; the same input always
 * returns the identical number; empty/non-string input returns 0. Presented as an
 * approximation (ESTIMATOR_VERSION), never as exact token accounting.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : ''
  if (!s) return 0
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 4)
}

/** Round to 1e-6 (never carry float noise into a USD report). */
function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6
}
/** Round to 1e-2 (minutes). */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Default fs readers (used when the CLI does not inject io; tests always inject). */
function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}
function defaultListFiles(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ═══════════════════════════ corpus stats (the token meter) ═════════════════════

/**
 * corpusStats({corpusDir, readFile, listFiles, topN}) -> the deterministic corpus
 * token-cost report. MEMORY.md is the CORE load; every other top-level *.md is either
 * an INDEX-*.md or a note; drafts/ (a subdir) is excluded by the non-recursive listing.
 * A missing MEMORY.md yields an honest core:null (never a throw). Notes + indexes are
 * sorted heaviest-first; `top` is the top-N heaviest across both.
 *
 * @param {{corpusDir:string, readFile?:Function, listFiles?:Function, topN?:number}} opts
 * @returns {{core:(number|null), notes:object[], indexes:object[], top:object[],
 *            totals:object, estimatorVersion:string, caveat:string}}
 */
export function corpusStats({ corpusDir, readFile, listFiles, topN = 10 } = {}) {
  const rf = typeof readFile === 'function' ? readFile : defaultReadFile
  const lf = typeof listFiles === 'function' ? listFiles : defaultListFiles
  const names = (lf(corpusDir) || []).filter(
    (f) => typeof f === 'string' && f.endsWith('.md') && !f.includes('/') && !f.includes('\\'),
  )
  const tokensOf = (name) => {
    try {
      return estimateTokens(rf(join(corpusDir, name)))
    } catch {
      return null
    }
  }

  const core = names.includes('MEMORY.md') ? tokensOf('MEMORY.md') : null
  const notes = []
  const indexes = []
  for (const f of names) {
    if (f === 'MEMORY.md') continue
    const tokens = tokensOf(f)
    if (tokens == null) continue
    if (/^INDEX-.*\.md$/.test(f)) indexes.push({ file: f, tokens })
    else notes.push({ file: f, tokens })
  }
  const byWeight = (a, b) => b.tokens - a.tokens || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  notes.sort(byWeight)
  indexes.sort(byWeight)
  const sum = (arr) => arr.reduce((n, x) => n + x.tokens, 0)
  const notesTotal = sum(notes)
  const indexesTotal = sum(indexes)
  const top = [...notes, ...indexes].sort(byWeight).slice(0, Math.max(0, topN | 0))
  const totals = {
    core,
    notes: notesTotal,
    indexes: indexesTotal,
    all: (core || 0) + notesTotal + indexesTotal,
  }
  return { core, notes, indexes, top, totals, estimatorVersion: ESTIMATOR_VERSION, caveat: APPROX_CAVEAT }
}

// ═══════════════════════════ self-cost (SMA's own overhead) ═════════════════════

/** Token count of the [beginPrefix .. end] line span in `text`, or null if absent. */
function spanTokens(text, beginPrefix, endMarker) {
  const lines = String(text ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(beginPrefix)) {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = -1
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes(endMarker)) {
      end = i
      break
    }
  }
  if (end === -1) end = lines.length - 1
  return estimateTokens(lines.slice(start, end + 1).join('\n'))
}

/**
 * selfCost({readFile, paths}) -> the SMA self-cost report. Measures the framework's
 * OWN static per-session injection overhead across the three surfaces it can attribute:
 *   - the SMA:RULES block span in CLAUDE.md (claude-embed RULES_MARKERS),
 *   - the emitted corpus block span in CLAUDE.md (emit anchorMarkers 'md'),
 *   - the MEMORY.md core load.
 * A surface that is absent is simply not listed (a repo with only a MEMORY.md returns
 * that one surface with total > 0 — the dogfood-repo shape, P49.4-06-C). The honest
 * not-counted line (variable per-turn hook stdout) is part of the report object.
 *
 * @param {{readFile?:Function, paths:{claudeMd?:string, memoryMd?:string}}} opts
 * @returns {{surfaces:object[], total:number, estimatorVersion:string,
 *            notCounted:string, caveat:string}}
 */
export function selfCost({ readFile, paths } = {}) {
  const rf = typeof readFile === 'function' ? readFile : defaultReadFile
  const p = paths || {}
  const readSafe = (path) => {
    try {
      return typeof path === 'string' && path ? rf(path) : null
    } catch {
      return null
    }
  }

  const claudeText = readSafe(p.claudeMd)
  const rulesTokens = claudeText != null ? spanTokens(claudeText, RULES_MARKERS.beginPrefix, RULES_MARKERS.end) : null
  const md = anchorMarkers('md')
  const emittedTokens = claudeText != null ? spanTokens(claudeText, md.beginPrefix, md.end) : null
  const memText = readSafe(p.memoryMd)
  const memoryTokens = memText != null ? estimateTokens(memText) : null

  const surfaces = []
  if (rulesTokens != null) surfaces.push({ surface: 'SMA:RULES block', path: p.claudeMd, tokens: rulesTokens })
  if (emittedTokens != null) surfaces.push({ surface: 'emitted corpus block', path: p.claudeMd, tokens: emittedTokens })
  if (memoryTokens != null) surfaces.push({ surface: 'MEMORY.md core load', path: p.memoryMd, tokens: memoryTokens })

  const total = surfaces.reduce((n, s) => n + s.tokens, 0)
  return {
    surfaces,
    total,
    estimatorVersion: ESTIMATOR_VERSION,
    notCounted:
      'НЕ учитывается: переменный вывод хуков за ход (per-turn hook stdout) — он зависит от ' +
      'действий сессии и не является статической инъекцией, поэтому в статический self-cost не входит.',
    caveat: APPROX_CAVEAT,
  }
}

// ═══════════════════════════ lane records (open/close ledger) ═══════════════════

/** The lane ledger file (append-only) lives in the EXISTING spendDir — no new subdir. */
function laneFile(spendDir) {
  return join(spendDir, 'lanes.jsonl')
}

/**
 * appendLaneEvent({spendDir, event}) — append ONE open/close record to lanes.jsonl.
 * Append-only by construction; an existing line is never rewritten. The record carries
 * {type, lane, terminalId, ts, ...attribution} — attribution fields (usd/minutes/
 * sessionsInWindow/overlap) are present only on a 'close' the CLI attributed.
 *
 * @param {{spendDir:string, event:object}} opts
 * @returns {object} the written record
 */
export function appendLaneEvent({ spendDir, event } = {}) {
  mkdirSync(spendDir, { recursive: true })
  const record = { ...event, ts: (event && event.ts) || new Date().toISOString() }
  appendFileSync(laneFile(spendDir), JSON.stringify(record) + '\n')
  return record
}

/**
 * readLaneRuns({spendDir, readFile}) -> {runs, corrupt}. Tolerant JSONL reader
 * (journal.mjs posture: a corrupt line is skip-and-counted, never a throw). Folds
 * open/close records into runs: a 'close' pairs with the SAME terminal's latest still-
 * open 'open' (LIFO). A run carries {lane, terminalId, openedAt, closedAt, minutes,
 * usd, sessionsInWindow, overlap, open:false}; an open with no close stays {open:true}.
 *
 * @param {{spendDir:string, readFile?:Function}} opts
 * @returns {{runs:object[], corrupt:number}}
 */
export function readLaneRuns({ spendDir, readFile } = {}) {
  const rf = typeof readFile === 'function' ? readFile : defaultReadFile
  let raw
  try {
    raw = rf(laneFile(spendDir))
  } catch {
    return { runs: [], corrupt: 0 }
  }
  let corrupt = 0
  const openStacks = new Map() // terminalId -> [openEvent,...]
  const closed = []
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let evt
    try {
      evt = JSON.parse(trimmed)
    } catch {
      corrupt += 1
      continue
    }
    if (!evt || typeof evt !== 'object') {
      corrupt += 1
      continue
    }
    const term = evt.terminalId || 'unknown'
    if (evt.type === 'open') {
      if (!openStacks.has(term)) openStacks.set(term, [])
      openStacks.get(term).push(evt)
    } else if (evt.type === 'close') {
      const stack = openStacks.get(term)
      const open = stack && stack.length ? stack.pop() : null
      const openedAt = open ? open.ts : evt.openedAt || null
      const lane = (open && open.lane) || evt.lane || 'unknown'
      const minutes = Number.isFinite(evt.minutes)
        ? evt.minutes
        : openedAt && evt.ts
          ? round2(Math.max(0, (Date.parse(evt.ts) - Date.parse(openedAt)) / 60000))
          : 0
      closed.push({
        lane,
        terminalId: term,
        openedAt,
        closedAt: evt.ts || null,
        minutes,
        usd: Number.isFinite(evt.usd) ? evt.usd : 0,
        sessionsInWindow: Number.isFinite(evt.sessionsInWindow) ? evt.sessionsInWindow : 0,
        overlap: !!evt.overlap,
        open: false,
      })
    } else {
      corrupt += 1
    }
  }
  const stillOpen = []
  for (const [term, stack] of openStacks) {
    for (const open of stack) {
      stillOpen.push({ lane: open.lane || 'unknown', terminalId: term, openedAt: open.ts || null, open: true })
    }
  }
  return { runs: [...closed, ...stillOpen], corrupt }
}

/**
 * attributeLaneRun({run, book, now}) -> {usd, events, sessionsInWindow, overlap, minutes}.
 * Attributes a lane run from the book's events inside [openedAt, closedAt] (windowSpend
 * boundary rules: both ends inclusive). The book exposes USD per event, not tokens, so
 * the cost signal is USD; contamination is COUNTED — sessionsInWindow is the distinct
 * session count in the window, and overlap is true when a session other than the run's
 * own contributed events (a parallel terminal burned spend concurrently).
 *
 * @param {{run:object, book:object, now?:number}} opts
 * @returns {{usd:number, events:number, sessionsInWindow:number, overlap:boolean, minutes:number}}
 */
export function attributeLaneRun({ run, book, now } = {}) {
  const openedAt = run && run.openedAt ? Date.parse(run.openedAt) : NaN
  const closedAt = run && run.closedAt ? Date.parse(run.closedAt) : Number.isFinite(now) ? now : Date.now()
  const events = book && Array.isArray(book.events) ? book.events : []
  let usd = 0
  let n = 0
  const sessions = new Set()
  for (const e of events) {
    const t = Date.parse(e.ts)
    if (!Number.isFinite(t)) continue
    if (t >= openedAt && t <= closedAt) {
      usd += e.usd || 0
      n += 1
      if (e.sessionId) sessions.add(e.sessionId)
    }
  }
  const ownSession = run && run.sessionId ? run.sessionId : null
  const otherSessions = ownSession
    ? [...sessions].filter((s) => s !== ownSession).length
    : Math.max(0, sessions.size - 1)
  const minutes = Number.isFinite(openedAt) ? round2(Math.max(0, (closedAt - openedAt) / 60000)) : 0
  return { usd: round6(usd), events: n, sessionsInWindow: sessions.size, overlap: otherSessions > 0, minutes }
}

// ═══════════════════════════ derivation + overrun ═══════════════════════════════

/** Nearest-rank percentile over a numeric list ([] -> 0). Deterministic. */
function percentile(values, pct) {
  const arr = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!arr.length) return 0
  const rank = Math.ceil((pct / 100) * arr.length)
  const idx = Math.min(arr.length - 1, Math.max(0, rank - 1))
  return arr[idx]
}

/**
 * deriveLaneBudgets({runs, pct, minRuns}) -> { [lane]: budget }. A budget derives ONLY
 * for lanes with >= minRuns closed CLEAN runs — overlap-flagged runs are EXCLUDED (they
 * neither count toward minRuns nor shape the percentile; grill CH-49.4-06-1). A lane below
 * the floor returns {insufficient:true, n}. The budget records n + source pct (the
 * D-49.2-13 capUsd:null honesty posture: a soft signal never fires off an assumed number).
 *
 * @param {{runs:object[], pct?:number, minRuns?:number, now?:string}} opts
 * @returns {Object<string, object>}
 */
export function deriveLaneBudgets({ runs, pct = 75, minRuns = 5, now } = {}) {
  const byLane = new Map()
  for (const r of runs || []) {
    if (!r || r.open || r.overlap) continue // closed CLEAN runs only
    const lane = r.lane || 'unknown'
    if (!byLane.has(lane)) byLane.set(lane, [])
    byLane.get(lane).push(r)
  }
  const out = {}
  for (const [lane, list] of byLane) {
    if (list.length < minRuns) {
      out[lane] = { insufficient: true, n: list.length }
      continue
    }
    out[lane] = {
      n: list.length,
      pct,
      usd: round6(percentile(list.map((r) => r.usd || 0), pct)),
      minutes: round2(percentile(list.map((r) => r.minutes || 0), pct)),
      estimatorVersion: ESTIMATOR_VERSION,
      derivedAt: now || new Date().toISOString(),
    }
  }
  return out
}

/**
 * maxLaneClosedRuns(runs) -> the max count of closed CLEAN runs across lanes (0 when
 * none). The P49.4-06-F accrual stat: >= 5 means at least one lane can derive a budget.
 * @param {object[]} runs
 * @returns {number}
 */
export function maxLaneClosedRuns(runs) {
  const byLane = new Map()
  for (const r of runs || []) {
    if (!r || r.open || r.overlap) continue
    const lane = r.lane || 'unknown'
    byLane.set(lane, (byLane.get(lane) || 0) + 1)
  }
  let max = 0
  for (const n of byLane.values()) if (n > max) max = n
  return max
}

/**
 * checkLaneOverrun({run, budgets, appendVerdict, draftLesson, now}) -> a decision object.
 * On an over-budget CLOSED CLEAN run whose lane has a derived budget, it CONSUMES the
 * injected appendVerdict once (a scorePlan-miss-shaped record, domain sma.economy) and
 * the injected draftLesson once. It scores NOTHING when: the run is still open, the lane
 * has no derived budget (report-only), or the run is OVERLAP-FLAGGED (report-only WARN —
 * a miss is never scored off tokens another terminal may have burned; grill CH-49.4-06-1).
 * Whole body fail-open (T-49.4-06-B): any internal throw -> {reportOnly:true} — never a
 * false miss.
 *
 * The miss record is shaped EXACTLY as a predict.mjs scorePlan miss so
 * draftLessonFromMiss works unmodified: {verdict:'miss', domain, metric, id, claim,
 * check_command, comparator, expected, actual, scoredAt}.
 *
 * @param {{run:object, budgets:object, appendVerdict?:Function, draftLesson?:Function, now?:string}} opts
 * @returns {object}
 */
export function checkLaneOverrun({ run, budgets, appendVerdict, draftLesson, now } = {}) {
  try {
    if (!run || run.open) return { reportOnly: true, reason: 'open' }
    if (run.overlap) return { reportOnly: true, reason: 'overlap' } // CH-49.4-06-1
    const lane = run.lane || 'unknown'
    const b = budgets && budgets[lane]
    if (!b || b.insufficient || !Number.isFinite(b.usd)) return { reportOnly: true, reason: 'no-budget', lane }

    const actual = round6(run.usd || 0)
    if (actual <= b.usd) return { within: true, lane, budgetUsd: b.usd, actualUsd: actual }

    const ts = now || new Date().toISOString()
    const stamp = run.closedAt ? Date.parse(run.closedAt) || ts : ts
    const verdict = {
      verdict: 'miss',
      domain: 'sma.economy',
      metric: 'lane_budget_overrun',
      id: `LANE-${lane}-${stamp}`,
      claim: `полоса ${lane}: расход остался в пределах бюджета p${b.pct} ($${b.usd}), выведенного из ${b.n} собственных прогонов`,
      check_command: 'pnpm sma spend lane report',
      comparator: '<=',
      expected: b.usd,
      actual,
      scoredAt: ts,
    }

    let appended = false
    let draftedPath = null
    if (typeof appendVerdict === 'function') {
      appendVerdict(verdict)
      appended = true
    }
    if (typeof draftLesson === 'function') {
      const d = draftLesson({ verdict, planId: 'lane-economy' })
      draftedPath = d && d.path ? d.path : null
    }
    return { miss: true, lane, budgetUsd: b.usd, actualUsd: actual, verdict, appended, draftedPath }
  } catch {
    return { reportOnly: true, reason: 'error' } // fail-open — never a false miss (T-49.4-06-B)
  }
}

/** writeLaneBudgets(budgets, {spendDir, now}) — persist lane-budgets.json atomically. */
export function writeLaneBudgets(budgets, { spendDir, now } = {}) {
  const record = {
    version: 1,
    estimatorVersion: ESTIMATOR_VERSION,
    derivedAt: now || new Date().toISOString(),
    budgets: budgets || {},
  }
  if (spendDir) {
    try {
      atomicWriteJson(join(spendDir, 'lane-budgets.json'), record)
    } catch {
      /* fail-open — a budget write failure only costs a re-derive next time */
    }
  }
  return record
}

/** readLaneBudgets({spendDir}) — the derived budgets file, or null when absent/corrupt. */
export function readLaneBudgets({ spendDir } = {}) {
  return spendDir ? readJsonSafe(join(spendDir, 'lane-budgets.json')) : null
}

// ═══════════════════════════ selftests (self-proving) ═══════════════════════════

/**
 * memoryStatsSelftest() -> 1|0. Runs corpusStats over an inline fixture corpus in a temp
 * dir TWICE and requires byte-identical JSON both times with ESTIMATOR_VERSION stamped
 * (P49.4-06-A: deterministic + versioned).
 * @returns {number}
 */
export function memoryStatsSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'sma-econ-mem-'))
  try {
    const corpusDir = join(root, 'memory')
    mkdirSync(corpusDir, { recursive: true })
    writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\ncore load line one\ncore load line two\n')
    writeFileSync(join(corpusDir, 'reference_a.md'), 'a'.repeat(400))
    writeFileSync(join(corpusDir, 'reference_bb.md'), 'b'.repeat(120))
    writeFileSync(join(corpusDir, 'INDEX-crm.md'), 'crm '.repeat(30))
    // drafts/ must be excluded (non-recursive listing) — plant one to prove it.
    mkdirSync(join(corpusDir, 'drafts'), { recursive: true })
    writeFileSync(join(corpusDir, 'drafts', 'bug-lesson-x.md'), 'z'.repeat(9999))

    const s1 = JSON.stringify(corpusStats({ corpusDir }))
    const s2 = JSON.stringify(corpusStats({ corpusDir }))
    if (s1 !== s2) return 0
    const parsed = JSON.parse(s1)
    if (parsed.estimatorVersion !== ESTIMATOR_VERSION) return 0
    if (!Number.isFinite(parsed.core) || parsed.core <= 0) return 0
    if (parsed.notes.length !== 2) return 0 // drafts excluded, MEMORY.md is core, INDEX is an index
    if (parsed.indexes.length !== 1) return 0
    if (parsed.notes[0].tokens < parsed.notes[1].tokens) return 0 // heaviest-first
    return 1
  } catch {
    return 0
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  }
}

/**
 * laneSelftest() -> 1|0. Proves the lane machinery end-to-end in a temp spendDir using the
 * REAL calibration.appendVerdict + predict.draftLessonFromMiss pointed at temp dirs:
 *   - p75 derivation is correct on a known distribution;
 *   - an under-minRuns lane derives NO budget (insufficient);
 *   - an OVERLAP-flagged run is excluded from derivation AND scores no overrun (report-only);
 *   - a synthetic over-budget run appends ONE sma.economy calibration miss AND drafts ONE lesson.
 * (P49.4-06-B.)
 * @returns {Promise<number>}
 */
export async function laneSelftest() {
  const rd = readdirSync
  const root = mkdtempSync(join(tmpdir(), 'sma-econ-lane-'))
  try {
    const spendDir = join(root, 'spend')
    const calibrationDir = join(root, 'calibration')
    const draftsDir = join(root, 'drafts')
    mkdirSync(spendDir, { recursive: true })

    // Write a fixture ledger: 5 clean closed 'fix' runs (usd 10..50 → p75 = 40),
    // 4 clean closed 'quick' runs (insufficient), 1 overlap-flagged 'fix' run (excluded).
    const t0 = Date.parse('2026-07-13T10:00:00.000Z')
    const iso = (ms) => new Date(ms).toISOString()
    let clock = t0
    const closeRun = (lane, usd, overlap = false) => {
      const openTs = iso(clock)
      clock += 60000
      const closeTs = iso(clock)
      clock += 60000
      appendLaneEvent({ spendDir, event: { type: 'open', lane, terminalId: 'self', ts: openTs } })
      appendLaneEvent({
        spendDir,
        event: { type: 'close', lane, terminalId: 'self', ts: closeTs, usd, minutes: 1, sessionsInWindow: overlap ? 2 : 1, overlap },
      })
    }
    for (const usd of [10, 20, 30, 40, 50]) closeRun('fix', usd)
    for (const usd of [11, 22, 33, 44]) closeRun('quick', usd)
    closeRun('fix', 999, true) // overlap-flagged — MUST be excluded from derivation

    const { runs } = readLaneRuns({ spendDir })
    if (runs.filter((r) => !r.open).length !== 10) return 0

    const budgets = deriveLaneBudgets({ runs, pct: 75, minRuns: 5 })
    if (!budgets.fix || budgets.fix.insufficient) return 0
    if (budgets.fix.usd !== 40) return 0 // p75 nearest-rank of [10,20,30,40,50]
    if (budgets.fix.n !== 5) return 0 // the overlap run did NOT inflate n
    if (!budgets.quick || !budgets.quick.insufficient || budgets.quick.n !== 4) return 0
    if (maxLaneClosedRuns(runs) !== 5) return 0

    const calibration = await import('./calibration.mjs')
    const predict = await import('./predict.mjs')
    const appendVerdict = (rec) => calibration.appendVerdict(rec, { calibrationDir })
    const draftLesson = ({ verdict, planId }) => predict.draftLessonFromMiss({ verdict, planId, dirs: { draftsDir } })

    // An overlap-flagged run scores NOTHING even over budget (report-only).
    const overlapRun = { lane: 'fix', open: false, overlap: true, usd: 999, closedAt: iso(clock) }
    const rep = checkLaneOverrun({ run: overlapRun, budgets, appendVerdict, draftLesson })
    if (!rep.reportOnly || rep.reason !== 'overlap') return 0

    // An over-budget CLEAN run appends exactly ONE miss + drafts ONE lesson.
    const overRun = { lane: 'fix', open: false, overlap: false, usd: 100, closedAt: iso(clock + 120000) }
    const res = checkLaneOverrun({ run: overRun, budgets, appendVerdict, draftLesson })
    if (!res.miss || !res.appended || !res.draftedPath) return 0

    const led = calibration.readLedger({ calibrationDir, domain: 'sma.economy' })
    if (led.records.length !== 1 || led.records[0].metric !== 'lane_budget_overrun') return 0
    let draftCount = 0
    try {
      draftCount = rd(draftsDir).filter((f) => f.endsWith('.md')).length
    } catch {
      draftCount = 0
    }
    if (draftCount !== 1) return 0

    // A within-budget CLEAN run scores nothing.
    const okRun = { lane: 'fix', open: false, overlap: false, usd: 10, closedAt: iso(clock + 240000) }
    const okRes = checkLaneOverrun({ run: okRun, budgets, appendVerdict, draftLesson })
    if (!okRes.within) return 0

    return 1
  } catch {
    return 0
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  }
}
