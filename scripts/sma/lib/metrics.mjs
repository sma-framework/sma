/**
 * metrics.mjs — read-only process telemetry from git + artifacts (9.1-24, B23,
 * D-9.1-07; CODING #8 pattern).
 *
 * The public product's "how is delivery actually going" layer, computed from data
 * that already exists on disk — NO new state, NO writes, NO network:
 *   - leadTime(journals)        — per-plan plan_start..plan_complete duration from
 *                                 the exec journals (9.1-20).
 *   - reworkRate({commits,plans}) — share of commits that touch a plan's files AFTER
 *                                 that plan's plan_complete (churn after "done").
 *   - deviationCounts(events)   — gate fires + stall detections + collision warns
 *                                 from the coordination journals, grouped by kind.
 *
 * HONESTY (no-fake-dashboard-data lesson): every metric returns an explicit
 * `available:false` + null/empty marker when its source is absent. A missing
 * source is never rendered as a measured zero.
 *
 * Every function is a PURE transform over injected data so the report (report.mjs)
 * and the tests both feed it fixtures. gatherSources() is the ONE impure helper
 * (read-only fs + an injected git runner), fail-open on every source.
 *
 * Node built-ins only; zero npm deps.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── pure transforms ──────────────────────────────────────────────────────────

/** Coerce a bare array OR a { journals } / { events } / { commits } wrapper to the array. */
function unwrap(input, key) {
  if (Array.isArray(input)) return input
  if (input && Array.isArray(input[key])) return input[key]
  return []
}

/** Millisecond delta between two ISO timestamps, or null if either is unparseable. */
function msBetween(startTs, endTs) {
  const a = Date.parse(startTs)
  const b = Date.parse(endTs)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return b - a
}

/**
 * leadTime(input) -> { available, plans:[{ id, start, end, ms, incomplete }] }.
 *
 * Per plan: start = the `plan_start` event ts when present, else the earliest
 * event ts (task_start fallback); end = the `plan_complete` event ts. A plan with
 * no plan_complete has ms:null + incomplete:true (honest, never a fabricated 0).
 * No journals -> { available:false, plans:[] }.
 *
 * @param {Array<{id:string, events:object[]}>|{journals:object[]}} input
 */
export function leadTime(input) {
  const journals = unwrap(input, 'journals')
  if (!journals.length) return { available: false, plans: [] }

  const plans = []
  for (const j of journals) {
    const events = Array.isArray(j?.events) ? j.events : []
    const withTs = events.filter((e) => e && typeof e.ts === 'string')

    const startEvt = withTs.find((e) => e.event === 'plan_start')
    let start = startEvt ? startEvt.ts : null
    if (!start && withTs.length) {
      // earliest event ts (task_start fallback)
      start = withTs.map((e) => e.ts).sort()[0]
    }
    const endEvt = withTs.find((e) => e.event === 'plan_complete')
    const end = endEvt ? endEvt.ts : null

    const ms = start && end ? msBetween(start, end) : null
    plans.push({ id: j?.id ?? null, start: start ?? null, end, ms, incomplete: ms == null })
  }
  return { available: true, plans }
}

/**
 * reworkRate({ commits, plans }) -> { available, rate, rework, total }.
 *
 * A commit is REWORK when, for some plan, commit.ts > plan.completeTs AND the
 * commit touches at least one of that plan's files. rate = rework / total (each
 * commit counted once even if it reworks multiple plans). No commits ->
 * { available:false, rate:null } (honest empty, not 0/0).
 *
 * @param {{commits:Array<{sha:string,ts:string,files:string[]}>, plans:Array<{id:string,files:string[],completeTs:string}>}} input
 */
export function reworkRate(input = {}) {
  const commits = Array.isArray(input.commits) ? input.commits : []
  const plans = Array.isArray(input.plans) ? input.plans : []
  const total = commits.length
  if (!total) return { available: false, rate: null, rework: 0, total: 0 }

  let rework = 0
  for (const c of commits) {
    const cTs = Date.parse(c?.ts)
    const cFiles = new Set(Array.isArray(c?.files) ? c.files : [])
    let isRework = false
    for (const p of plans) {
      const pTs = Date.parse(p?.completeTs)
      if (!Number.isFinite(cTs) || !Number.isFinite(pTs)) continue
      if (cTs <= pTs) continue // built-during, not rework
      const pFiles = Array.isArray(p?.files) ? p.files : []
      if (pFiles.some((f) => cFiles.has(f))) {
        isRework = true
        break
      }
    }
    if (isRework) rework += 1
  }
  return { available: true, rate: rework / total, rework, total }
}

/**
 * deviationCounts(input) -> { available, byKind, total }.
 *
 * Groups coordination-journal events by their `type` (gate | collision | stall |
 * reflex | ...) and counts each. No events -> { available:false, byKind:{}, total:0 }.
 *
 * @param {object[]|{events:object[]}} input
 */
export function deviationCounts(input) {
  const events = unwrap(input, 'events')
  if (!events.length) return { available: false, byKind: {}, total: 0 }

  const byKind = {}
  let total = 0
  for (const e of events) {
    const kind = e && typeof e.type === 'string' ? e.type : 'unknown'
    byKind[kind] = (byKind[kind] ?? 0) + 1
    total += 1
  }
  return { available: true, byKind, total }
}

/**
 * parseGitLog(raw) -> [{ sha, ts, files }]. Parses the output of
 * `git log --name-only --pretty=format:%H|%cI` (header line `sha|isoTs` followed
 * by name-only file lines, commits separated by blank lines). Fail-open: empty /
 * garbage -> []. READ-ONLY parsing — this module never invokes git itself.
 *
 * @param {string} raw
 * @returns {Array<{sha:string, ts:string, files:string[]}>}
 */
export function parseGitLog(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const commits = []
  let current = null
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed.trim()) {
      // blank line separates commits
      if (current) {
        commits.push(current)
        current = null
      }
      continue
    }
    const headerMatch = /^([0-9a-f]{7,40})\|(.+)$/i.exec(trimmed)
    if (headerMatch && !current) {
      current = { sha: headerMatch[1], ts: headerMatch[2].trim(), files: [] }
    } else if (current) {
      current.files.push(trimmed.trim())
    }
  }
  if (current) commits.push(current)
  return commits
}

// ── impure gather (read-only fs + injected git runner; fail-open) ─────────────

/** Kinds counted as deviations in the coordination journal. */
const DEVIATION_KINDS = new Set(['gate', 'collision', 'stall', 'reflex'])

/**
 * readExecJournals({ execDir }) -> [{ id, events }]. Reads every
 * `<phase>-<plan>.jsonl` under the exec dir, tolerant of corrupt lines. Missing
 * dir -> []. Never throws.
 */
function readExecJournals(opts = {}) {
  const dir = opts.execDir
  if (!dir) return []
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const journals = []
  for (const f of files) {
    const events = []
    try {
      const raw = readFileSync(join(dir, f), 'utf8')
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          events.push(JSON.parse(t))
        } catch {
          /* skip corrupt line (fail-open) */
        }
      }
    } catch {
      /* skip unreadable file */
    }
    journals.push({ id: f.replace(/\.jsonl$/, ''), events })
  }
  return journals
}

/**
 * gatherMetrics({ dirs, execGit, since }) -> { leadTime, reworkRate, deviations }.
 *
 * The ONE impure entry: reads exec journals (9.1-20) + the coordination journal
 * (deviation events) + `git log` (via the injected execGit runner) and computes
 * all three metrics. Every source is fail-open — a missing source yields that
 * metric's honest empty marker, never a throw. READ-ONLY (git log / --name-only
 * never mutates the tree).
 *
 * @param {{dirs:object, execGit?:Function, since?:string}} opts
 */
export function gatherMetrics(opts = {}) {
  const dirs = opts.dirs ?? {}

  // (1) exec journals -> lead time.
  const journals = readExecJournals({ execDir: dirs.execDir })
  const lt = leadTime(journals)

  // (2) coordination journal -> deviation events (gate/collision/stall/reflex).
  let deviationEvents = []
  try {
    // Lazy require to keep metrics.mjs importable without the journal module.
    // eslint-disable-next-line no-undef
    const journalMod = opts.journalMod
    if (journalMod && typeof journalMod.readJournal === 'function') {
      const { events } = journalMod.readJournal({ journalDir: dirs.journalDir })
      deviationEvents = (events || []).filter((e) => e && DEVIATION_KINDS.has(e.type))
    }
  } catch {
    /* fail-open — no journal module / dir */
  }
  const dev = deviationCounts(deviationEvents)

  // (3) git log -> rework rate. Plans + their complete ts come from the exec
  // journals (plan_complete event); commit files from --name-only.
  let commits = []
  if (typeof opts.execGit === 'function') {
    try {
      const args = ['log', '--name-only', '--pretty=format:%H|%cI']
      if (opts.since) args.push(`--since=${opts.since}`)
      commits = parseGitLog(opts.execGit(args))
    } catch {
      commits = [] // fail-open — offline / bad ref
    }
  }
  const plans = lt.plans
    .filter((p) => p.end)
    .map((p) => ({ id: p.id, completeTs: p.end, files: planFilesFrom(journals, p.id) }))
  const rw = reworkRate({ commits, plans })

  return { leadTime: lt, reworkRate: rw, deviations: dev }
}

/** Collect the distinct `file` values a plan's exec journal recorded (fail-open []). */
function planFilesFrom(journals, id) {
  const j = journals.find((x) => x.id === id)
  if (!j) return []
  const files = new Set()
  for (const e of j.events) {
    if (e && typeof e.file === 'string' && e.file) files.add(e.file)
  }
  return [...files]
}
