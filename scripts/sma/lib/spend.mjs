/**
 * spend.mjs — the deterministic spend BOOK, the rolling window budget, and the
 * hot-path spend-check decision core (49.2-09, D-49.2-13).
 *
 * ═══════════════════════════ THE BOOK ═════════════════════════════════════════
 *
 * buildBook does a DETERMINISTIC parse of the LOCAL Claude Code session journals
 * (discovered + normalized ENTIRELY via spend-adapter.mjs — this module never
 * touches a raw vendor field) into a per-session / per-model / per-day / main-vs-
 * subagent(isSidechain) aggregate. No network, no daemon, no LLM anywhere in the
 * parse path (substrate law). All vendor-format risk is quarantined upstream in
 * the adapter; here an unrecognized-but-usage-bearing line is simply COUNTED
 * (counters.unrecognized — the drift signal), never thrown.
 *
 * ═══════════════════════════ THE INCREMENTAL CACHE ════════════════════════════
 *
 * .sma/spend/cache.json holds a per-file `{size, mtimeMs, offset, tally}` record so
 * the HOT spend-check path is O(appended bytes), not O(history): an untouched file
 * (same size+mtime) is not re-read; an appended file is parsed ONLY from its cached
 * byte offset; a SHRUNK or replaced file invalidates its entry and reparses from
 * zero (fail-open — never wrong-by-cache). This is what keeps a warm spend-check
 * inside `sma pre`'s 300 ms SLO (P49.2-09-2 / key_links).
 *
 * ═══════════════════════════ THE WINDOW BUDGET ════════════════════════════════
 *
 * .sma/spend/budget.json = {windowHours, capUsd, warnAt:[0.7,0.9], by, at}. The
 * 70/90 warn levels are LOCKED (D-49.2-13). capUsd defaults null → report-only: a
 * soft-deny must NEVER fire off an assumed number (Claude's-discretion default).
 *
 * Node built-ins only; every fs touch is behind try/catch and dependency-injectable.
 */

import { statSync } from 'node:fs'
import { readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import {
  parseLogLine,
  discoverLogsDir,
  probeNativeSpend,
  pricingVersion,
  ADAPTER_VERSIONS,
} from './spend-adapter.mjs'

/** The current (latest) adapter version — stamped into every book. */
const CURRENT_ADAPTER_VERSION = ADAPTER_VERSIONS[ADAPTER_VERSIONS.length - 1].version

/** The LOCKED safe-default budget (D-49.2-13). capUsd null = report-only, never deny. */
export const DEFAULT_BUDGET = { windowHours: 5, capUsd: null, warnAt: [0.7, 0.9] }

/** Round a USD amount to 1e-6 (never carry float noise into a report). */
function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6
}

// ═══════════════════════════ tally primitives ═══════════════════════════════════

/** A fresh per-file (or merged) tally. All aggregates live here. */
function emptyTally() {
  return {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    bySession: {},
    byModel: {},
    byDay: {},
    byAgent: { main: { usd: 0, events: 0 }, subagent: { usd: 0, events: 0 } },
    counters: { recognized: 0, nonUsage: 0, corrupt: 0, unrecognized: 0, duplicate: 0, unpriced: 0 },
    events: [],
  }
}

/** Add usd/events into a `{usd, events}` bucket of a keyed map (created on demand). */
function bump(map, key, usd) {
  if (!key) key = 'unknown'
  if (!map[key]) map[key] = { usd: 0, events: 0 }
  map[key].usd = round6(map[key].usd + usd)
  map[key].events += 1
}

/** Fold one parseLogLine result into a tally. */
function tallyOne(tally, r) {
  if (r && r.skip) {
    const c = tally.counters
    if (r.skip === 'non-usage') c.nonUsage += 1
    else if (r.skip === 'corrupt') c.corrupt += 1
    else if (r.skip === 'unrecognized') c.unrecognized += 1
    else if (r.skip === 'duplicate') c.duplicate += 1
    return
  }
  if (!r || typeof r !== 'object') return
  const usd = Number.isFinite(r.costUSD) ? r.costUSD : 0
  tally.counters.recognized += 1
  if (r.costSource === 'unpriced') tally.counters.unpriced += 1
  tally.usd = round6(tally.usd + usd)
  tally.inputTokens += r.inputTokens || 0
  tally.outputTokens += r.outputTokens || 0
  tally.cacheCreationTokens += r.cacheCreationTokens || 0
  tally.cacheReadTokens += r.cacheReadTokens || 0
  bump(tally.bySession, r.sessionId, usd)
  bump(tally.byModel, r.model, usd)
  const day = typeof r.ts === 'string' && r.ts.length >= 10 ? r.ts.slice(0, 10) : 'unknown'
  bump(tally.byDay, day, usd)
  const agent = r.isSidechain ? 'subagent' : 'main'
  tally.byAgent[agent].usd = round6(tally.byAgent[agent].usd + usd)
  tally.byAgent[agent].events += 1
  tally.events.push({ ts: r.ts ?? null, usd, sessionId: r.sessionId ?? '', model: r.model ?? '', isSidechain: !!r.isSidechain })
}

/** Deep clone a tally (JSON round-trip — deterministic, no shared refs). */
function cloneTally(t) {
  return JSON.parse(JSON.stringify(t))
}

/** Merge tally `b` into `a` (a is mutated + returned). */
function mergeTally(a, b) {
  a.usd = round6(a.usd + b.usd)
  a.inputTokens += b.inputTokens
  a.outputTokens += b.outputTokens
  a.cacheCreationTokens += b.cacheCreationTokens
  a.cacheReadTokens += b.cacheReadTokens
  for (const map of ['bySession', 'byModel', 'byDay']) {
    for (const [k, v] of Object.entries(b[map])) {
      if (!a[map][k]) a[map][k] = { usd: 0, events: 0 }
      a[map][k].usd = round6(a[map][k].usd + v.usd)
      a[map][k].events += v.events
    }
  }
  for (const agent of ['main', 'subagent']) {
    a.byAgent[agent].usd = round6(a.byAgent[agent].usd + b.byAgent[agent].usd)
    a.byAgent[agent].events += b.byAgent[agent].events
  }
  for (const k of Object.keys(a.counters)) a.counters[k] += b.counters[k] || 0
  for (const e of b.events) a.events.push(e)
  return a
}

/**
 * parseChunk(chunk) -> {tally, consumedBytes}. Parses only WHOLE lines (up to the
 * last newline); a trailing partial line is left unconsumed so the next incremental
 * pass re-reads it complete. Dedups within the chunk via one Set.
 */
function parseChunk(chunk) {
  const tally = emptyTally()
  const seen = new Set()
  const text = typeof chunk === 'string' ? chunk : ''
  const nlIdx = text.lastIndexOf('\n')
  const consumed = nlIdx >= 0 ? text.slice(0, nlIdx + 1) : ''
  const consumedBytes = Buffer.byteLength(consumed, 'utf8')
  for (const raw of consumed.split('\n')) {
    if (!raw.trim()) continue
    tallyOne(tally, parseLogLine(raw, { seen }))
  }
  return { tally, consumedBytes }
}

// ═══════════════════════════ file readers (injectable) ══════════════════════════

/** Default byte-offset reader: read the file, return UTF-8 from byte `start` to EOF. */
function defaultReadRange(path, start) {
  try {
    const buf = fsReadFileSync(path)
    return buf.slice(start || 0).toString('utf8')
  } catch {
    return ''
  }
}

/** Default stat: {size, mtimeMs} or throws (caller catches). */
function defaultStat(path) {
  const st = statSync(path)
  return { size: st.size, mtimeMs: st.mtimeMs }
}

// ═══════════════════════════ buildBook ══════════════════════════════════════════

/**
 * buildBook(opts) -> book. Deterministic aggregate over the local session logs.
 *
 * @param {{
 *   logsDir?:string, files?:string[], spendDir?:string, cache?:object, now?:number,
 *   persist?:boolean, readRange?:Function, statFile?:Function,
 *   env?:object, repoRoot?:string, homedir?:string
 * }} [opts]
 * @returns {object} the book (JSON-serializable, deterministic under a fixed `now`)
 */
export function buildBook(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const persist = opts.persist !== false
  const readRange = typeof opts.readRange === 'function' ? opts.readRange : defaultReadRange
  const statFile = typeof opts.statFile === 'function' ? opts.statFile : defaultStat
  const spendDir = opts.spendDir

  // Discover files (adapter-owned) unless an explicit list is injected.
  let files = opts.files
  let logsDir = opts.logsDir
  if (!Array.isArray(files)) {
    const disc = discoverLogsDir({ env: opts.env || {}, logsDir: opts.logsDir, repoRoot: opts.repoRoot, homedir: opts.homedir })
    files = disc.files
    logsDir = disc.dir
  }

  // Cache: an injected in-memory object wins; else load from disk; else fresh.
  let cache = opts.cache && typeof opts.cache === 'object' ? opts.cache : null
  if (!cache && spendDir) {
    const disk = readJsonSafe(join(spendDir, 'cache.json'))
    if (disk && disk.files && typeof disk.files === 'object') cache = disk
  }
  if (!cache) cache = {}
  if (!cache.files || typeof cache.files !== 'object') cache.files = {}

  const perFile = []
  for (const file of Array.isArray(files) ? files : []) {
    let st = null
    try {
      st = statFile(file)
    } catch {
      st = null
    }
    if (!st) continue

    const entry = cache.files[file]
    let tally
    if (entry && entry.tally && entry.size === st.size && entry.mtimeMs === st.mtimeMs) {
      tally = entry.tally // unchanged — no read at all (the O(0) fast path)
    } else if (entry && entry.tally && Number.isFinite(entry.offset) && st.size > entry.size) {
      // appended — parse ONLY from the cached byte offset, merge into the cached tally.
      const { tally: added, consumedBytes } = parseChunk(readRange(file, entry.offset))
      tally = mergeTally(cloneTally(entry.tally), added)
      cache.files[file] = { size: st.size, mtimeMs: st.mtimeMs, offset: entry.offset + consumedBytes, tally }
    } else {
      // cold / shrunk / replaced — reparse from zero (fail-open, never wrong-by-cache).
      const { tally: fresh, consumedBytes } = parseChunk(readRange(file, 0))
      tally = fresh
      cache.files[file] = { size: st.size, mtimeMs: st.mtimeMs, offset: consumedBytes, tally }
    }
    perFile.push(tally)
  }

  const book = mergeIntoBook(perFile, { now, logsDir })

  if (persist && spendDir) {
    try {
      atomicWriteJson(join(spendDir, 'cache.json'), { version: 1, files: cache.files })
    } catch {
      /* fail-open — a cache write failure only costs a re-parse next time */
    }
  }
  return book
}

/** Stable total-order comparator for the retained event list (determinism). */
function compareEvents(a, b) {
  const ta = a.ts ?? ''
  const tb = b.ts ?? ''
  if (ta < tb) return -1
  if (ta > tb) return 1
  if ((a.sessionId ?? '') < (b.sessionId ?? '')) return -1
  if ((a.sessionId ?? '') > (b.sessionId ?? '')) return 1
  if ((a.model ?? '') < (b.model ?? '')) return -1
  if ((a.model ?? '') > (b.model ?? '')) return 1
  return (a.usd || 0) - (b.usd || 0)
}

/** Fold the per-file tallies into the final book (totals + maps + sorted events). */
function mergeIntoBook(perFile, { now, logsDir }) {
  const merged = emptyTally()
  for (const t of perFile) mergeTally(merged, t)
  merged.events.sort(compareEvents)
  return {
    totals: {
      usd: merged.usd,
      inputTokens: merged.inputTokens,
      outputTokens: merged.outputTokens,
      cacheCreationTokens: merged.cacheCreationTokens,
      cacheReadTokens: merged.cacheReadTokens,
      events: merged.events.length,
    },
    bySession: merged.bySession,
    byModel: merged.byModel,
    byDay: merged.byDay,
    byAgent: merged.byAgent,
    counters: merged.counters,
    events: merged.events,
    pricingVersion,
    adapterVersion: CURRENT_ADAPTER_VERSION,
    builtAt: new Date(now).toISOString(),
    logsDir: logsDir ?? null,
  }
}

// ═══════════════════════════ windowSpend ════════════════════════════════════════

/**
 * windowSpend({book, now, windowHours}) -> {usd, events}. Sums ONLY the book's events
 * inside the rolling [now - windowHours, now] window; an event exactly at the start
 * boundary is INCLUDED. An empty window (or windowHours 0) → {usd:0, events:0}.
 * @param {{book:object, now:number, windowHours:number}} opts
 * @returns {{usd:number, events:number}}
 */
export function windowSpend({ book, now, windowHours } = {}) {
  const n = Number.isFinite(now) ? now : Date.now()
  const h = Number.isFinite(windowHours) ? windowHours : 5
  const cutoff = n - h * 3600 * 1000
  let usd = 0
  let events = 0
  const list = book && Array.isArray(book.events) ? book.events : []
  for (const e of list) {
    const t = Date.parse(e.ts)
    if (!Number.isFinite(t)) continue
    if (t >= cutoff && t <= n) {
      usd += e.usd || 0
      events += 1
    }
  }
  return { usd: round6(usd), events }
}

// ═══════════════════════════ the window budget ══════════════════════════════════

/**
 * readBudget({spendDir}) -> budget. Reads spendDir/budget.json; a missing OR corrupt
 * file yields the LOCKED safe default {windowHours:5, capUsd:null, warnAt:[0.7,0.9]}.
 * The 70/90 warnAt levels are always re-applied (locked, D-49.2-13) — a tampered
 * warnAt in the file is ignored. capUsd null → report-only.
 * @param {{spendDir?:string}} [opts]
 * @returns {object}
 */
export function readBudget(opts = {}) {
  const spendDir = opts.spendDir
  const stored = spendDir ? readJsonSafe(join(spendDir, 'budget.json')) : null
  const wh = stored && Number.isFinite(Number(stored.windowHours)) ? Number(stored.windowHours) : DEFAULT_BUDGET.windowHours
  const cap = stored && Number.isFinite(Number(stored.capUsd)) && Number(stored.capUsd) > 0 ? Number(stored.capUsd) : null
  const budget = { windowHours: wh, capUsd: cap, warnAt: [...DEFAULT_BUDGET.warnAt] }
  if (stored && typeof stored.by === 'string') budget.by = stored.by
  if (stored && typeof stored.at === 'string') budget.at = stored.at
  return budget
}

/**
 * writeBudget(budget, {spendDir, by, now}) — persist the budget atomically with
 * provenance {by, at}. The warnAt levels are LOCKED and always written as [0.7,0.9].
 * @param {{windowHours?:number, capUsd?:number|null}} budget
 * @param {{spendDir:string, by?:string, now?:number}} opts
 * @returns {object} the written budget
 */
export function writeBudget(budget = {}, opts = {}) {
  const spendDir = opts.spendDir
  const wh = Number.isFinite(Number(budget.windowHours)) ? Number(budget.windowHours) : DEFAULT_BUDGET.windowHours
  const cap = Number.isFinite(Number(budget.capUsd)) && Number(budget.capUsd) > 0 ? Number(budget.capUsd) : null
  const record = {
    windowHours: wh,
    capUsd: cap,
    warnAt: [...DEFAULT_BUDGET.warnAt],
    by: typeof opts.by === 'string' ? opts.by : 'unknown',
    at: new Date(Number.isFinite(opts.now) ? opts.now : Date.now()).toISOString(),
  }
  if (spendDir) {
    try {
      atomicWriteJson(join(spendDir, 'budget.json'), record)
    } catch {
      /* fail-open */
    }
  }
  return record
}

// ═══════════════════════════ the --stat scorer contract ═════════════════════════

/**
 * spendStats(name, opts) -> a single finite number. The predict-score scorer parses
 * the numeric LAST line of a `--stat` run (49.1-08 contract). Every stat resolves to
 * ONE finite number, never NaN/Infinity.
 *
 *   parse-coverage    recognized / (recognized + unrecognized) * 100 (no drift → 100)
 *   window-usd        windowSpend usd over the configured budget window
 *   window-pct        window usd as a percent of capUsd (no cap → 0, report-only)
 *   probe-native      1 when a native local spend surface is detected, else 0
 *   bench-check-p95-ms (Task 3) warm checkSpend p95 over 20 runs
 *
 * @param {string} name
 * @param {{book?:object, spendDir?:string, now?:number, windowHours?:number, env?:object}} [opts]
 * @returns {number}
 */
export function spendStats(name, opts = {}) {
  const env = opts.env || process.env
  if (name === 'probe-native') {
    return probeNativeSpend({ env }).native ? 1 : 0
  }
  const book = opts.book || buildBook(opts)
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const budget = readBudget({ spendDir: opts.spendDir })
  const windowHours = Number.isFinite(opts.windowHours) ? opts.windowHours : budget.windowHours

  switch (name) {
    case 'parse-coverage': {
      const rec = book.counters.recognized
      const unrec = book.counters.unrecognized
      const denom = rec + unrec
      return denom > 0 ? round6((rec / denom) * 100) : 100
    }
    case 'window-usd':
      return windowSpend({ book, now, windowHours }).usd
    case 'window-pct': {
      if (!Number.isFinite(budget.capUsd) || budget.capUsd <= 0) return 0
      const w = windowSpend({ book, now, windowHours })
      return round6((w.usd / budget.capUsd) * 100)
    }
    default:
      return 0
  }
}
