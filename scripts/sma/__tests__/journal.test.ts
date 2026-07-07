/**
 * Tests for scripts/sma/lib/journal.mjs (Phase 49 Plan 03, Task 3).
 *
 * R10 per-terminal collision-event journal:
 *   - Test 1: appendEvent writes one JSON line to <terminalId>.jsonl; seq
 *     increments monotonically per terminal file.
 *   - Test 2: readJournal over three terminal files with interleaved + EQUAL
 *     timestamps merge-sorts by (ts, terminal, seq) — stable, deterministic.
 *   - Test 3: empty/missing journal dir -> readJournal() returns [] + a status
 *     summary reporting zero events, no error (SPEC edge: empty R10).
 *   - Test 4: a corrupted line is skipped with a counted warning, never a throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readJournal, journalTail } from '../lib/journal.mjs'

let journalDir: string

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'sma-journal-'))
})

afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

describe('appendEvent', () => {
  it('writes one JSON line per event; seq increments monotonically per terminal', () => {
    appendEvent({ type: 'claim', scope: 'mig-070', detail: 'won' }, { terminalId: 't1', journalDir })
    appendEvent({ type: 'release', scope: 'mig-070', detail: 'done' }, { terminalId: 't1', journalDir })

    const raw = readFileSync(join(journalDir, 't1.jsonl'), 'utf8').trim()
    const lines = raw.split('\n')
    expect(lines).toHaveLength(2)
    const e1 = JSON.parse(lines[0])
    const e2 = JSON.parse(lines[1])
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e1.terminal).toBe('t1')
    expect(typeof e1.ts).toBe('string')
    expect(e1.type).toBe('claim')
  })
})

describe('readJournal — merge-sort (ordering R10)', () => {
  it('merge-sorts three terminal files by (ts, terminal, seq), stable on equal ts', () => {
    const T = '2026-07-02T10:00:00.000Z'
    // Same ts across terminals -> tie-break by terminal then seq.
    appendFileSync(join(journalDir, 'tb.jsonl'), JSON.stringify({ ts: T, terminal: 'tb', seq: 1, type: 'warn' }) + '\n')
    appendFileSync(join(journalDir, 'ta.jsonl'), JSON.stringify({ ts: T, terminal: 'ta', seq: 2, type: 'warn' }) + '\n')
    appendFileSync(join(journalDir, 'ta.jsonl'), JSON.stringify({ ts: T, terminal: 'ta', seq: 1, type: 'warn' }) + '\n')
    // A later ts on a third terminal must sort last.
    appendFileSync(join(journalDir, 'tc.jsonl'), JSON.stringify({ ts: '2026-07-02T11:00:00.000Z', terminal: 'tc', seq: 1, type: 'warn' }) + '\n')

    const { events } = readJournal({ journalDir })
    expect(events.map((e) => `${e.terminal}#${e.seq}`)).toEqual([
      'ta#1', // same ts, terminal ta before tb, seq 1 before 2
      'ta#2',
      'tb#1',
      'tc#1', // later ts last
    ])
  })
})

describe('readJournal — empty (empty R10)', () => {
  it('missing/empty journal dir -> [] + zero-event summary, no throw', () => {
    const gone = join(journalDir, 'nope')
    const res = readJournal({ journalDir: gone })
    expect(res.events).toEqual([])
    expect(res.count).toBe(0)
    expect(res.corrupt).toBe(0)
  })
})

describe('readJournal — corrupt line (fail-open C9)', () => {
  it('skips a corrupt line with a counted warning, never a throw', () => {
    const f = join(journalDir, 't1.jsonl')
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: '2026-07-02T10:00:00.000Z', terminal: 't1', seq: 1, type: 'warn' }),
        '{ this is not json',
        JSON.stringify({ ts: '2026-07-02T10:01:00.000Z', terminal: 't1', seq: 2, type: 'warn' }),
      ].join('\n') + '\n',
    )

    const res = readJournal({ journalDir })
    expect(res.events).toHaveLength(2)
    expect(res.corrupt).toBe(1)
  })
})

describe('journalTail', () => {
  it('returns the bounded last-n events for a terminal', () => {
    for (let i = 0; i < 5; i++) {
      appendEvent({ type: 'warn', scope: 's', detail: String(i) }, { terminalId: 't1', journalDir })
    }
    const tail = journalTail('t1', 2, { journalDir })
    expect(tail).toHaveLength(2)
    expect(tail[0].seq).toBe(4)
    expect(tail[1].seq).toBe(5)
  })
})
