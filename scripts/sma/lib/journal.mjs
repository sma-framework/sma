/**
 * journal.mjs — per-terminal collision-event journal (R10, B15/B20), made
 * TAMPER-EVIDENT by a per-file hash chain (49.2-03, D-49.2-07).
 *
 * Each terminal appends to its OWN <terminalId>.jsonl file — there is no shared
 * append-file race by construction (shared-file appends are NOT atomic on Windows,
 * SPEC R10). The reader merge-sorts across all terminal files by (ts, terminal, seq)
 * so the timeline is stable even under equal timestamps.
 *
 * HASH CHAIN (D-49.2-07): every line appendEvent writes now carries `prev` =
 * lineHash of the previous non-blank raw line in that file ('genesis' for the
 * first). verifyChain detects any edit, deletion, or post-chain insertion; the
 * whole V2 history is a legacy prev-less PREFIX that is NEVER retro-broken, and
 * chaining's tamper-evidence begins the moment the first `prev` line lands. The
 * chain is PER FILE (the per-terminal no-shared-append-race construction is
 * unchanged). chainTip emits a deterministic merged tip that the sma-ship
 * release ritual pins into the annotated V1.N tag — making local edits to
 * yesterday's journal detectable by anyone holding the tag. A break IS the
 * evidence and is NEVER auto-repaired: the only forward path is a new
 * chain-start appended on top, with the break preserved.
 *
 * Two postures, two jobs: the READER (readJournal/parseFile) stays FAIL-OPEN —
 * a corrupt line is skip-and-counted, never a throw. The VERIFIER (verifyChain)
 * is the tamper detector — the same corrupt line is a reported break. Neither
 * ever WRITES (verifyChain/chainTip are read-only).
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
import { createHash } from 'node:crypto'

import { JOURNAL_DIR } from './constants.mjs'

function resolveJournalDir(opts = {}) {
  return opts.journalDir ?? JOURNAL_DIR
}

/**
 * lineHash(rawLine) -> sha256 hex of the exact line bytes (UTF-8, no trailing
 * newline). The chain link primitive; exported so plan 04's subagent receipts
 * and any future ledger reuse the SAME hash of a journal line (never re-derive).
 * @param {string} rawLine
 * @returns {string}
 */
export function lineHash(rawLine) {
  return createHash('sha256').update(String(rawLine), 'utf8').digest('hex')
}

/** sha256 hex of an arbitrary UTF-8 string (the merged-tip digest). */
function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** The non-blank raw lines of a file, in order ([] on a missing/unreadable file). */
function rawLines(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter((l) => l.trim() !== '')
}

/** The last non-blank raw line of a file, or null when there is none. */
function lastRawLine(path) {
  const nb = rawLines(path)
  return nb.length ? nb[nb.length - 1] : null
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

  // Hash-chain (D-49.2-07): prev = lineHash of the last non-blank raw line, or
  // 'genesis' for the first line of the file. Computed over the RAW bytes so a
  // later verifyChain re-derives the identical link.
  const last = lastRawLine(file)
  const prev = last == null ? 'genesis' : lineHash(last)

  const record = {
    ts: opts.now ?? new Date().toISOString(),
    terminal: opts.terminalId,
    seq: lastSeq + 1,
    type: evt.type ?? 'warn', // 'warn'|'collision'|'claim'|'release'|'steal'|'snapshot-fail'
    actors: evt.actors ?? [],
    scope: evt.scope ?? null,
    detail: evt.detail ?? null,
    prev, // hash-chain link (D-49.2-07) — MUST stay last so JSON.stringify order is deterministic
  }
  appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

/**
 * verifyChain(opts) -> {ok, breaks, legacyLines, files}. The tamper detector:
 * walks each file's non-blank lines in order. Prev-less lines are allowed ONLY
 * as a contiguous LEGACY PREFIX (the whole V2 history); from the first chained
 * line onward every line MUST parse AND carry prev === lineHash(previous raw
 * line). Detects edits (successor's prev no longer matches), deletions (the
 * successor's expected prev shifts), and post-chain prev-less insertions. An
 * unparseable line inside the chained region is a break (reason 'corrupt').
 * NEVER writes anything.
 *
 * break shape: {file, seq, index, reason}. reasons: 'prev-mismatch' (edit or
 * deletion), 'legacy-after-chain' (a prev-less line after chaining started),
 * 'corrupt' (unparseable line in the chained region).
 *
 * @param {{journalDir?:string}} [opts]
 * @returns {{ok:boolean, breaks:object[], legacyLines:number, files:string[]}}
 */
export function verifyChain(opts = {}) {
  const dir = resolveJournalDir(opts)
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return { ok: true, breaks: [], legacyLines: 0, files: [] } // missing dir -> honest clean-empty
  }

  const breaks = []
  let legacyLines = 0

  for (const f of files) {
    const nb = rawLines(join(dir, f))
    let chaining = false
    for (let i = 0; i < nb.length; i++) {
      const line = nb[i]
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        if (chaining) {
          breaks.push({ file: f, seq: null, index: i, reason: 'corrupt' })
        }
        // an unparseable line in the legacy prefix is skipped (reader fail-open)
        continue
      }
      const hasPrev = obj != null && obj.prev != null && obj.prev !== ''
      if (!hasPrev) {
        if (chaining) {
          breaks.push({ file: f, seq: obj?.seq ?? null, index: i, reason: 'legacy-after-chain' })
        } else {
          legacyLines += 1 // contiguous legacy prefix — never retro-broken
        }
        continue
      }
      // A chained line: tamper-evidence is live from here on.
      chaining = true
      const expected = i === 0 ? 'genesis' : lineHash(nb[i - 1])
      if (obj.prev !== expected) {
        breaks.push({ file: f, seq: obj.seq ?? null, index: i, reason: 'prev-mismatch' })
      }
    }
  }

  return { ok: breaks.length === 0, breaks, legacyLines, files }
}

/**
 * chainTip(opts) -> {tip, files}. Deterministic merged tip over the per-file
 * chain tips (the last raw line's hash, 'empty' for an empty file). merged tip
 * = sha256 over the sorted `<file>:<fileTip>` list joined with '\n'. No .jsonl
 * files (or a missing dir) -> the literal sentinel 'empty' — an honest empty
 * state, never a fake hash. The sma-ship ritual pins this into the annotated
 * release tag (SMA-Journal-Tip).
 *
 * @param {{journalDir?:string}} [opts]
 * @returns {{tip:string, files:Array<{file:string, tip:string, lines:number}>}}
 */
export function chainTip(opts = {}) {
  const dir = resolveJournalDir(opts)
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return { tip: 'empty', files: [] }
  }
  const perFile = files.map((f) => {
    const nb = rawLines(join(dir, f))
    const last = nb.length ? nb[nb.length - 1] : null
    return { file: f, tip: last == null ? 'empty' : lineHash(last), lines: nb.length }
  })
  if (!perFile.length) return { tip: 'empty', files: [] }
  const merged = perFile.map((p) => `${p.file}:${p.tip}`).sort().join('\n')
  return { tip: sha256(merged), files: perFile }
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
