/**
 * journal.mjs — per-terminal collision-event journal (R10, B15/B20).
 *
 * Each terminal appends to its OWN <terminalId>.jsonl file — there is no shared
 * append-file race by construction (shared-file appends are NOT atomic on Windows,
 * SPEC R10). The reader merge-sorts across all terminal files by (ts, terminal, seq)
 * so the timeline is stable even under equal timestamps.
 *
 * Fail-open (C9): a corrupted line is skipped-and-counted, never a throw; an empty
 * or missing journal dir yields a zero-event report.
 *
 * Node built-ins only; the journal dir is dependency-injectable via the option.
 */

import {
  appendFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from 'node:fs'
import { join } from 'node:path'

import { JOURNAL_DIR } from './constants.mjs'

function resolveJournalDir(opts = {}) {
  return opts.journalDir ?? JOURNAL_DIR
}

/** Read + parse one terminal's .jsonl, skipping corrupt lines. */
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
      corrupt += 1 // fail-open — skip-and-count, never throw (C9)
    }
  }
  return { events, corrupt }
}

/**
 * appendEvent(evt, opts) — append one JSON line to <terminalId>.jsonl.
 * seq = last line's seq + 1 (missing file -> 1). The per-terminal file avoids the
 * shared-append race (SPEC R10).
 * @param {{type?:string, scope?:*, detail?:*, actors?:Array}} evt
 * @param {{terminalId:string, journalDir?:string, now?:string}} opts
 * @returns {object} the written event
 */
export function appendEvent(evt, opts = {}) {
  const dir = resolveJournalDir(opts)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${opts.terminalId}.jsonl`)

  const { events } = parseFile(file)
  const lastSeq = events.length ? events[events.length - 1].seq ?? events.length : 0

  const record = {
    ts: opts.now ?? new Date().toISOString(),
    terminal: opts.terminalId,
    seq: lastSeq + 1,
    type: evt.type ?? 'warn', // 'warn'|'collision'|'claim'|'release'|'steal'|'snapshot-fail'
    actors: evt.actors ?? [],
    scope: evt.scope ?? null,
    detail: evt.detail ?? null,
  }
  appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

/** Stable comparator: (ts, terminal, seq). */
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
 * readJournal(opts) -> {events, count, corrupt}. Reads all *.jsonl files, parses
 * line-wise (skipping corrupt lines), merge-sorts by (ts, terminal, seq).
 * @param {{journalDir?:string}} [opts]
 */
export function readJournal(opts = {}) {
  const dir = resolveJournalDir(opts)
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { events: [], count: 0, corrupt: 0 } // missing dir -> zero-event report (empty R10)
  }

  let all = []
  let corrupt = 0
  for (const f of files) {
    const { events, corrupt: c } = parseFile(join(dir, f))
    all = all.concat(events)
    corrupt += c
  }
  all.sort(compareEvents)
  return { events: all, count: all.length, corrupt }
}

/**
 * journalTail(terminalId, n, opts) -> last n events for one terminal (bounded tail
 * for the snapshot payload; RESEARCH Open Question 1 resolution).
 * @param {string} terminalId
 * @param {number} n
 * @param {{journalDir?:string}} [opts]
 */
export function journalTail(terminalId, n, opts = {}) {
  const dir = resolveJournalDir(opts)
  const { events } = parseFile(join(dir, `${terminalId}.jsonl`))
  return n >= 0 ? events.slice(-n) : events
}
