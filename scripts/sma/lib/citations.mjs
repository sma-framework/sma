/**
 * citations.mjs — the B4 usage-citation ledger of the layered memory (49.1-11).
 *
 * Every note consumption is a citation event: a 'load' (the loader returned the
 * note to a session — `sma load`, pre-act injection) or a 'fire' (a promoted
 * reflex surfaced it via 49.1-10's PreToolUse consumer). One usage model over
 * both makes «which notes are actually used and which are dead weight»
 * answerable with data — the input FI-9's demotion ordering needs.
 *
 * Ledger shape mirrors journal.mjs exactly (PATTERNS exact analog): one
 * append-only JSONL file PER terminal under `.sma/usage/<terminal>.jsonl` — no
 * shared-append race by construction (Windows appends are not atomic, SPEC R10).
 * Reader is tolerant: a corrupt line is skipped-and-counted, never a throw (C9).
 *
 * Fail-open discipline (C9/P4): recordCitation NEVER throws — a citation write
 * failure must never break the load it instruments (49.1-11 Test 5).
 *
 * Exports (consumed by loader.mjs wiring + `sma usage` + 49.1-12/13):
 *   - recordCitation(evt, opts) — append one citation line (fail-open, null on error)
 *   - readUsage(opts)           — merged citation events (usage ledger + reflex fires)
 *   - usageStats(opts)          — per-note counts split by kind, with lastCitedAt
 *   - deadWeight(opts)          — corpus notes with zero citations across the last N sessions
 *
 * Node built-ins only; the usage dir is dependency-injectable via opts.usageDir.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { USAGE_DIR } from './constants.mjs'
import { readJournal } from './journal.mjs'

/** Structural corpus files that are never notes (mirrors loader.mjs). */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

function resolveUsageDir(opts = {}) {
  return opts.usageDir ?? USAGE_DIR
}

/** Read + parse one terminal's usage .jsonl, skipping corrupt lines (C9). */
function parseFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { events: [], corrupt: 0 }
  }
  const events = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1 // fail-open — skip-and-count, never throw
    }
  }
  return { events, corrupt }
}

/**
 * recordCitation(evt, opts) — append ONE citation line to <terminal>.jsonl.
 * seq = last line's seq + 1 (missing file -> 1), matching journal.appendEvent.
 * FAIL-OPEN: any error returns null — a citation must never break the load
 * it instruments (49.1-11 Test 5).
 *
 * @param {{noteId:string, kind:'load'|'fire', terminal:string, session?:string|null}} evt
 * @param {{usageDir?:string, now?:string}} [opts]
 * @returns {object|null} the written record, or null on failure
 */
export function recordCitation(evt, opts = {}) {
  try {
    const dir = resolveUsageDir(opts)
    mkdirSync(dir, { recursive: true })
    const terminal = evt.terminal ?? 'unknown'
    const file = join(dir, `${terminal}.jsonl`)

    const { events } = parseFile(file)
    const lastSeq = events.length ? events[events.length - 1].seq ?? events.length : 0

    const record = {
      ts: opts.now ?? new Date().toISOString(),
      terminal,
      seq: lastSeq + 1,
      noteId: evt.noteId ?? null,
      kind: evt.kind === 'fire' ? 'fire' : 'load',
      session: evt.session ?? null,
    }
    appendFileSync(file, JSON.stringify(record) + '\n')
    return record
  } catch {
    return null // fail-open (C9) — a citation write failure never breaks the load
  }
}

/** Stable comparator: (ts, terminal, seq) — same ordering truth as journal.mjs. */
function compareEvents(a, b) {
  if (a.ts < b.ts) return -1
  if (a.ts > b.ts) return 1
  const ta = a.terminal ?? ''
  const tb = b.terminal ?? ''
  if (ta < tb) return -1
  if (ta > tb) return 1
  return (a.seq ?? 0) - (b.seq ?? 0)
}

/**
 * readUsage(opts) -> {events, corrupt}. Merges the usage ledger with the reflex
 * journal's fire events (49.1-10 journals each surviving fire as type 'reflex'
 * with detail.noteId) — ONE usage model over both consumption points.
 *
 * @param {{usageDir?:string, journalDir?:string}} [opts]
 */
export function readUsage(opts = {}) {
  const dir = resolveUsageDir(opts)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    /* missing dir -> zero usage events (fail-open) */
  }

  let all = []
  let corrupt = 0
  for (const f of files) {
    const { events, corrupt: c } = parseFile(join(dir, f))
    all = all.concat(events)
    corrupt += c
  }

  // Fold reflex fires from the journal (event kind 'reflex', 49.1-10).
  if (opts.journalDir) {
    try {
      const { events } = readJournal({ journalDir: opts.journalDir })
      for (const e of events) {
        if (e && e.type === 'reflex' && e.detail && e.detail.noteId) {
          all.push({
            ts: e.ts,
            terminal: e.terminal ?? 'unknown',
            seq: e.seq ?? 0,
            noteId: e.detail.noteId,
            kind: 'fire',
            session: e.session ?? null,
          })
        }
      }
    } catch {
      /* fail-open — a broken journal never breaks the usage read */
    }
  }

  all.sort(compareEvents)
  return { events: all, corrupt }
}

/**
 * usageStats(opts) -> {notes, corrupt}. Per-note citation counts split by kind
 * ('load' vs 'fire'), with lastCitedAt = the newest citation ts. Sorted by
 * total desc → noteId asc (stable report ordering).
 *
 * @param {{usageDir?:string, journalDir?:string}} [opts]
 * @returns {{notes:Array<{noteId:string, load:number, fire:number, total:number, lastCitedAt:string|null}>, corrupt:number}}
 */
export function usageStats(opts = {}) {
  const { events, corrupt } = readUsage(opts)
  const byNote = new Map()
  for (const e of events) {
    if (!e || !e.noteId) continue
    if (!byNote.has(e.noteId)) {
      byNote.set(e.noteId, { noteId: e.noteId, load: 0, fire: 0, total: 0, lastCitedAt: null })
    }
    const n = byNote.get(e.noteId)
    if (e.kind === 'fire') n.fire += 1
    else n.load += 1
    n.total += 1
    if (typeof e.ts === 'string' && (n.lastCitedAt == null || e.ts > n.lastCitedAt)) {
      n.lastCitedAt = e.ts
    }
  }
  const notes = [...byNote.values()].sort(
    (a, b) => b.total - a.total || a.noteId.localeCompare(b.noteId),
  )
  return { notes, corrupt }
}

/** List corpus note files (*.md, non-structural) — mirrors loader.mjs's listing.
 * The FI-11 per-area INDEX-<area>.md files (49.1-13) are structural, not notes. */
function listCorpusNotes(corpusDir) {
  let entries
  try {
    entries = readdirSync(corpusDir)
  } catch {
    return []
  }
  return entries
    .filter((f) => f.endsWith('.md') && !STRUCTURAL_FILES.has(f) && !/^INDEX-[^/\\]+\.md$/.test(f))
    .sort()
}

/**
 * deadWeight(opts) -> {dead, cited, sessionsConsidered}. Notes present in the
 * corpus with ZERO citations across the last N sessions — FI-9's demotion
 * ordering data source (least-recently-cited demotes first).
 *
 * A "session" is the citation event's session key (evt.session when recorded,
 * else the terminal id), ordered by each session's newest citation ts; the
 * last N sessions are considered. Omitted sessions -> all sessions.
 *
 * @param {{usageDir?:string, journalDir?:string, corpusDir:string, sessions?:number}} opts
 * @returns {{dead:string[], cited:string[], sessionsConsidered:number}}
 */
export function deadWeight(opts = {}) {
  const { events } = readUsage(opts)

  // Group events by session key; remember each session's newest ts.
  const sessionMax = new Map()
  for (const e of events) {
    const key = e.session ?? e.terminal ?? 'unknown'
    const prev = sessionMax.get(key)
    if (prev == null || (typeof e.ts === 'string' && e.ts > prev)) sessionMax.set(key, e.ts ?? '')
  }
  const orderedSessions = [...sessionMax.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([key]) => key)
  const wanted = Number.isFinite(opts.sessions) ? Math.max(0, opts.sessions) : orderedSessions.length
  const taken = new Set(orderedSessions.slice(0, wanted))

  const cited = new Set()
  for (const e of events) {
    const key = e.session ?? e.terminal ?? 'unknown'
    if (taken.has(key) && e.noteId) cited.add(e.noteId)
  }

  const dead = listCorpusNotes(opts.corpusDir).filter((f) => !cited.has(f))
  return { dead, cited: [...cited].sort(), sessionsConsidered: taken.size }
}
