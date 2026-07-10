/**
 * curriculum.mjs — the weekly miss-curriculum (49.3-06, D-49.3-16).
 *
 * Turns error clusters (calibration misses + journal incidents + ignored-broke
 * fires) into two engineer-facing artifacts, MECHANICALLY — zero LLM, zero hidden
 * clock:
 *   - prediction TEMPLATES (append-only JSONL the planner reads when authoring a
 *     PLAN's predictions block), and
 *   - a bounded weak-spots BRIEF markdown for the next /sma-discuss preload.
 *
 * Both are DETERMINISTIC and byte-identical on re-run over the same inputs (the
 * injected `week`/`now` make the clock explicit). Every function is pure over its
 * injected inputs; the CLI (Task 3) assembles the journal/calibration/classified
 * inputs — this module never reads process.env or the wall clock directly.
 *
 * The templates + briefs live under dirs.curriculumDir (.sma/curriculum/ —
 * gitignored runtime). The brief is an engineer artifact, not a shareholder
 * surface, so the plain-language HARD RULE does not apply.
 *
 * Node built-ins only; DI dirs; fail-open throughout (C9) — a corrupt line is
 * skip-and-counted, an empty dir yields an honest empty result, never a throw.
 */

import { appendFileSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteRaw } from './fs-atomics.mjs'
// The ONE allowlist boundary (49.2-10 lock): isSafeCommand = charset + pattern guard;
// SAFE_COMMAND_PATTERNS is the anchored shape a template's check_command must match to
// be safe for the planner to run unedited. Both IMPORTED, never re-declared here.
import { isSafeCommand, SAFE_COMMAND_PATTERNS } from './predict.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

/** Max clusters ranked into the curriculum (bounded, deterministic). */
const MAX_CLUSTERS = 7
/** Max evidence refs pinned per cluster/template (bound the brief well under 4096 B). */
const MAX_REFS = 6
/** Staleness horizon: a brief older than this needs a re-run. */
const STALE_MS = 7 * DAY_MS

// ── week formatting (the injected clock) ────────────────────────────────────────

/** normalizeWeek(week) -> {year, week, ww, isoLabel, fileLabel}. Accepts {year,week}
 * or a 'YYYY-Www' string. Deterministic — no clock read. */
function normalizeWeek(week) {
  let year
  let wk
  if (week && typeof week === 'object') {
    year = Number(week.year)
    wk = Number(week.week)
  } else if (typeof week === 'string') {
    const m = /^(\d{4})-?W(\d{1,2})$/.exec(week.trim())
    if (m) {
      year = Number(m[1])
      wk = Number(m[2])
    }
  }
  if (!Number.isFinite(year)) year = 1970
  if (!Number.isFinite(wk)) wk = 1
  const ww = String(wk).padStart(2, '0')
  return { year, week: wk, ww, isoLabel: `${year}W${ww}`, fileLabel: `${year}-W${ww}` }
}

/** isoWeek(now) -> {year, week} (ISO-8601 week-numbering). Injected clock only. */
export function isoWeek(now) {
  const d = new Date(typeof now === 'number' ? now : Date.parse(now))
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day) // Thursday of this week decides the year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t - yearStart) / DAY_MS + 1) / 7)
  return { year: t.getUTCFullYear(), week }
}

// ── clustering ──────────────────────────────────────────────────────────────────

/** The first two path segments of a scope (the targetClass dir prefix), else the scope. */
function dirPrefix2(scope) {
  const s = String(scope ?? '')
  if (!s.includes('/')) return s
  const segs = s.split('/').filter(Boolean)
  return segs.slice(0, 2).join('/') || s
}

/** Sanitize a cluster key into an id-safe token (word chars, dot, dash kept). */
function idToken(key) {
  return String(key ?? 'unknown').replace(/[^\w.-]+/g, '_')
}

function inWindow(tsMs, nowMs, windowMs) {
  if (!windowMs || !Number.isFinite(nowMs)) return true
  return !Number.isFinite(tsMs) || tsMs >= nowMs - windowMs
}

/**
 * clusterMisses({ledgers, events, classified, windowMs, now}) -> cluster[]. Groups
 * calibration misses by domain and journal incidents / ignored-broke fires by
 * targetClass dir prefix; ranks by count desc with an alphabetical key tie-break;
 * caps at 7. Deterministic (deep-equal on re-run). Fail-open.
 *
 * cluster shape: {key, kind:'domain'|'targetClass', count, refs:[], checkCommand}.
 * @returns {object[]}
 */
export function clusterMisses({ ledgers = [], events = [], classified = [], windowMs = 30 * DAY_MS, now } = {}) {
  const nowMs = now == null ? Date.now() : typeof now === 'number' ? now : Date.parse(now)
  const map = new Map() // key -> {key, kind, count, refs:Set, cmdCounts:Map}

  const bump = (key, kind, ref, cmd) => {
    if (!key) return
    let c = map.get(key)
    if (!c) {
      c = { key, kind, count: 0, refs: new Set(), cmdCounts: new Map() }
      map.set(key, c)
    }
    c.count += 1
    if (ref) c.refs.add(ref)
    if (cmd && isSafeCommand(cmd)) c.cmdCounts.set(cmd, (c.cmdCounts.get(cmd) ?? 0) + 1)
  }

  // (a) calibration misses -> domain clusters.
  for (const r of Array.isArray(ledgers) ? ledgers : []) {
    if (!r || r.verdict !== 'miss') continue
    const tsMs = Date.parse(r.scoredAt ?? r.ts)
    if (!inWindow(tsMs, nowMs, windowMs)) continue
    bump(r.domain ?? 'unknown', 'domain', `${r.domain ?? 'unknown'}@${r.scoredAt ?? r.ts ?? ''}`, r.check_command)
  }

  // (b) journal incidents / gate-overrides -> targetClass clusters.
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || (e.type !== 'incident' && e.type !== 'gate-override')) continue
    const tsMs = Date.parse(e.ts)
    if (!inWindow(tsMs, nowMs, windowMs)) continue
    bump(dirPrefix2(e.scope ?? (e.detail && e.detail.scope)), 'targetClass', `${e.terminal ?? '?'}#${e.seq ?? ''}`)
  }

  // (c) ignored-broke fires -> targetClass clusters.
  for (const c of Array.isArray(classified) ? classified : []) {
    if (!c || c.classification !== 'ignored-broke') continue
    const tsMs = Date.parse(c.ts)
    if (!inWindow(tsMs, nowMs, windowMs)) continue
    bump(dirPrefix2(c.targetClass ?? c.scope), 'targetClass', c.ref)
  }

  const clusters = [...map.values()].map((c) => {
    // most frequent allowlisted check_command (alphabetical tie-break for determinism).
    let checkCommand = ''
    let best = 0
    for (const [cmd, n] of [...c.cmdCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n > best) {
        best = n
        checkCommand = cmd
      }
    }
    return { key: c.key, kind: c.kind, count: c.count, refs: [...c.refs].sort().slice(0, MAX_REFS), checkCommand }
  })

  clusters.sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return clusters.slice(0, MAX_CLUSTERS)
}

// ── prediction templates (append-only JSONL) ────────────────────────────────────

/** Read templates.jsonl tolerantly -> {ids:Set, count, corrupt}. Never throws. */
function readTemplateIds(file) {
  const ids = new Set()
  let corrupt = 0
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ids, count: 0, corrupt: 0 }
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t)
      if (obj && obj.id) ids.add(obj.id)
    } catch {
      corrupt += 1 // fail-open — skip-and-count
    }
  }
  return { ids, count: ids.size, corrupt }
}

/**
 * predictionTemplates({clusters, week, dirs}) -> template[]. One template per cluster
 * with >= 2 members. Appends new ids to dirs.curriculumDir/templates.jsonl (append-only,
 * tolerant reader); a same-ISO-week re-run adds ZERO duplicate ids (idempotent).
 *
 * template shape: {id:'TPL-<domain>-<yyyy>W<ww>', domain, claimTemplate, metric,
 * check_command, comparator, threshold:null, evidence:{count, refs}}.
 * @returns {object[]}
 */
export function predictionTemplates({ clusters = [], week, dirs = {} } = {}) {
  const w = normalizeWeek(week)
  const curriculumDir = dirs.curriculumDir
  const file = curriculumDir ? join(curriculumDir, 'templates.jsonl') : null
  const existing = file ? readTemplateIds(file) : { ids: new Set() }

  const templates = []
  for (const c of Array.isArray(clusters) ? clusters : []) {
    if (!c || (c.count ?? 0) < 2) continue
    const id = `TPL-${idToken(c.key)}-${w.isoLabel}`
    // allowlist-shaped or empty: the planner may run it unedited only if it matches
    // the anchored SAFE_COMMAND_PATTERNS shape (and the full isSafeCommand charset guard).
    const check = c.checkCommand && SAFE_COMMAND_PATTERNS.some((re) => re.test(c.checkCommand)) && isSafeCommand(c.checkCommand) ? c.checkCommand : ''
    templates.push({
      id,
      domain: c.key,
      claimTemplate: `«${c.key}» has ${c.count} misses in the window — the next plan touching it registers a prediction with a measured base`,
      metric: `${idToken(c.key)}_miss_base`,
      check_command: check,
      comparator: '>=',
      threshold: null,
      evidence: { count: c.count, refs: Array.isArray(c.refs) ? c.refs.slice(0, MAX_REFS) : [] },
    })
  }

  // Append only ids not already present (idempotent per ISO week). Fail-open.
  if (file) {
    try {
      mkdirSync(curriculumDir, { recursive: true })
      for (const t of templates) {
        if (existing.ids.has(t.id)) continue
        appendFileSync(file, JSON.stringify(t) + '\n')
        existing.ids.add(t.id)
      }
    } catch {
      /* fail-open — a write failure never throws the caller */
    }
  }
  return templates
}

// ── the weak-spots brief ────────────────────────────────────────────────────────

/** A demotion proposal (to note/retired, not refused). */
function isDemotion(p) {
  return p && !p.refused && (p.to === 'note' || p.to === 'retired')
}
/** A promotion / re-arm proposal, or a gate-candidate advisory. */
function isPromotion(p) {
  return p && p.kind === 'gate-candidate' ? true : p && !p.refused && (p.to === 'warn' || p.to === 'soft-deny' || p.to === 'auto-fix')
}

/**
 * weakSpotsBrief({clusters, proposals, templates, week, dirs, now}) -> {path, text, bytes}.
 * Writes dirs.curriculumDir/brief-<yyyy>-W<ww>.md with EXACTLY five sections, <= 4096
 * bytes, byte-identical on re-render over the same inputs (zero LLM, zero clock beyond
 * the injected week). Bounded: every refs list is capped before assembly. Fail-open.
 */
export function weakSpotsBrief({ clusters = [], proposals = [], templates = [], week, dirs = {} } = {}) {
  const w = normalizeWeek(week)
  const lines = []

  lines.push(`# Weak-spots brief — ${w.fileLabel}`)
  lines.push('')

  lines.push('## Top miss clusters')
  const topClusters = (Array.isArray(clusters) ? clusters : []).slice(0, MAX_CLUSTERS)
  if (!topClusters.length) lines.push('_none in the window_')
  for (const c of topClusters) {
    const refs = (Array.isArray(c.refs) ? c.refs : []).slice(0, MAX_REFS).join(', ')
    lines.push(`- **${c.key}** (${c.kind}) — ${c.count} hits${refs ? ` · refs: ${refs}` : ''}`)
  }
  lines.push('')

  lines.push('## Noise demoted')
  const demotions = (Array.isArray(proposals) ? proposals : []).filter(isDemotion).slice().sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))
  if (!demotions.length) lines.push('_none_')
  for (const p of demotions) lines.push(`- ${p.ruleId}: ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`)
  lines.push('')

  lines.push('## Rules rising')
  const promotions = (Array.isArray(proposals) ? proposals : []).filter(isPromotion).slice().sort((a, b) => ((a.ruleId ?? '') < (b.ruleId ?? '') ? -1 : (a.ruleId ?? '') > (b.ruleId ?? '') ? 1 : 0))
  if (!promotions.length) lines.push('_none_')
  for (const p of promotions) {
    if (p.kind === 'gate-candidate') lines.push(`- ${p.ruleId}: gate-candidate (reflex earned soft-deny evidence — a human authors the gate)`)
    else lines.push(`- ${p.ruleId}: ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`)
  }
  lines.push('')

  lines.push('## New prediction templates')
  const tpls = (Array.isArray(templates) ? templates : []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!tpls.length) lines.push('_none_')
  for (const t of tpls) lines.push(`- \`${t.id}\` — ${t.domain} (${t.evidence ? t.evidence.count : 0} misses)`)
  lines.push('')

  lines.push('## Ask at the next discuss')
  const questions = topClusters.slice(0, 5).map((c) => `- «${c.key}» took ${c.count} hits this window — what changed, and what prevents the recurrence?`)
  if (!questions.length) lines.push('_no weak spots surfaced_')
  for (const q of questions) lines.push(q)
  lines.push('')

  let text = lines.join('\n')
  // Hard byte-cap (bounded already; this is the belt-and-braces clamp on a line boundary).
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    const kept = []
    let bytes = 0
    for (const l of lines) {
      const b = Buffer.byteLength(l + '\n', 'utf8')
      if (bytes + b > 4096) break
      kept.push(l)
      bytes += b
    }
    text = kept.join('\n')
  }

  const path = dirs.curriculumDir ? join(dirs.curriculumDir, `brief-${w.fileLabel}.md`) : null
  if (path) {
    try {
      atomicWriteRaw(path, text)
    } catch {
      /* fail-open */
    }
  }
  return { path, text, bytes: Buffer.byteLength(text, 'utf8') }
}

/**
 * latestBrief({dirs, now}) -> {path, ageDays, stale}. The newest brief-*.md by name
 * (yyyy-Www sorts chronologically); stale when it is older than 7 days OR none exists.
 * @returns {{path:(string|null), ageDays:(number|null), stale:boolean}}
 */
export function latestBrief({ dirs = {}, now } = {}) {
  const nowMs = now == null ? Date.now() : typeof now === 'number' ? now : Date.parse(now)
  const curriculumDir = dirs.curriculumDir
  let files
  try {
    files = readdirSync(curriculumDir).filter((f) => /^brief-\d{4}-W\d{2}\.md$/.test(f)).sort()
  } catch {
    return { path: null, ageDays: null, stale: true }
  }
  if (!files.length) return { path: null, ageDays: null, stale: true }
  const path = join(curriculumDir, files[files.length - 1])
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return { path, ageDays: null, stale: true }
  }
  const ageDays = (nowMs - mtimeMs) / DAY_MS
  return { path, ageDays, stale: nowMs - mtimeMs > STALE_MS }
}
