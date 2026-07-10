/**
 * Tests for the hash chain added to scripts/sma/lib/journal.mjs
 * (Phase 49.2 Plan 03, Task 2; D-49.2-07 tamper-evident journal).
 *
 *   - Test 1: appendEvent writes prev — first line 'genesis'; the third line's
 *     prev equals lineHash of the SECOND raw line's exact bytes.
 *   - Test 2: verifyChain clean on an untampered file; a byte edit of a middle
 *     line -> a break at the successor; deleting a middle line -> a break.
 *   - Test 3: legacy tolerance — a prev-less prefix + chained appends verifies
 *     ok with legacyLines counted; a prev-less line AFTER chaining -> a break.
 *   - Test 4: chainTip deterministic — same tree -> identical tip; one append
 *     changes it; empty/missing dir -> the literal sentinel 'empty'.
 *   - Test 5: back-compat — readJournal merge-sort unchanged (extra fields
 *     ignored); a corrupt line skip-counts in the READER while verifyChain
 *     reports it as a break in the VERIFIER.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readJournal, verifyChain, chainTip, lineHash } from '../lib/journal.mjs'

let journalDir: string
const file = () => join(journalDir, 't1.jsonl')
const raw = () => readFileSync(file(), 'utf8').split('\n').filter((l) => l.trim() !== '')

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), 'sma-jchain-'))
})
afterEach(() => {
  rmSync(journalDir, { recursive: true, force: true })
})

describe('appendEvent — prev link', () => {
  it('first line prev is genesis; the third line prev equals lineHash of the second raw line', () => {
    appendEvent({ type: 'claim', detail: 'a' }, { terminalId: 't1', journalDir, now: 'T1' })
    appendEvent({ type: 'claim', detail: 'b' }, { terminalId: 't1', journalDir, now: 'T2' })
    appendEvent({ type: 'claim', detail: 'c' }, { terminalId: 't1', journalDir, now: 'T3' })

    const lines = raw()
    expect(JSON.parse(lines[0]).prev).toBe('genesis')
    expect(JSON.parse(lines[2]).prev).toBe(lineHash(lines[1]))
  })
})

describe('verifyChain — tamper detection', () => {
  it('untampered -> ok; a middle-byte edit -> break at successor; a deletion -> break', () => {
    appendEvent({ type: 'claim', detail: 'a' }, { terminalId: 't1', journalDir, now: 'T1' })
    appendEvent({ type: 'claim', detail: 'b' }, { terminalId: 't1', journalDir, now: 'T2' })
    appendEvent({ type: 'claim', detail: 'c' }, { terminalId: 't1', journalDir, now: 'T3' })

    expect(verifyChain({ journalDir })).toMatchObject({ ok: true, breaks: [] })

    // Edit a byte of the MIDDLE line (index 1) — the successor's prev no longer matches.
    const lines = raw()
    lines[1] = lines[1].replace('"detail":"b"', '"detail":"X"')
    writeFileSync(file(), lines.join('\n') + '\n')
    const edited = verifyChain({ journalDir })
    expect(edited.ok).toBe(false)
    expect(edited.breaks[0].index).toBe(2) // reported at the successor
    expect(edited.breaks[0].reason).toBe('prev-mismatch')

    // Now DELETE the middle line entirely -> the successor's prev shifts.
    const twoLines = [raw()[0], raw()[2]]
    writeFileSync(file(), twoLines.join('\n') + '\n')
    const deleted = verifyChain({ journalDir })
    expect(deleted.ok).toBe(false)
    expect(deleted.breaks[0].reason).toBe('prev-mismatch')
  })
})

describe('verifyChain — legacy prefix tolerance', () => {
  it('prev-less legacy prefix + chained appends verifies ok with legacyLines counted', () => {
    // Two hand-written V2-era prev-less lines.
    writeFileSync(
      file(),
      [
        JSON.stringify({ ts: 'T0', terminal: 't1', seq: 1, type: 'warn' }),
        JSON.stringify({ ts: 'T0b', terminal: 't1', seq: 2, type: 'warn' }),
      ].join('\n') + '\n',
    )
    // Two chained appends land on top (prev chains onto the last legacy line).
    appendEvent({ type: 'claim', detail: 'c3' }, { terminalId: 't1', journalDir, now: 'T3' })
    appendEvent({ type: 'claim', detail: 'c4' }, { terminalId: 't1', journalDir, now: 'T4' })

    const res = verifyChain({ journalDir })
    expect(res.ok).toBe(true)
    expect(res.legacyLines).toBe(2)
  })

  it('a prev-less line appearing AFTER a chained line -> a break', () => {
    writeFileSync(
      file(),
      [
        JSON.stringify({ ts: 'T1', terminal: 't1', seq: 1, type: 'warn', prev: 'genesis' }),
        JSON.stringify({ ts: 'T2', terminal: 't1', seq: 2, type: 'warn' }), // prev-less AFTER chaining
      ].join('\n') + '\n',
    )
    const res = verifyChain({ journalDir })
    expect(res.ok).toBe(false)
    expect(res.breaks[0].reason).toBe('legacy-after-chain')
  })
})

describe('chainTip — deterministic merged tip', () => {
  it('same tree -> identical tip; one append changes it; empty/missing dir -> empty', () => {
    expect(chainTip({ journalDir: join(journalDir, 'nope') }).tip).toBe('empty')
    expect(chainTip({ journalDir }).tip).toBe('empty') // dir exists, no jsonl files yet

    appendEvent({ type: 'claim', detail: 'a' }, { terminalId: 't1', journalDir, now: 'T1' })
    const tip1 = chainTip({ journalDir }).tip
    const tip1again = chainTip({ journalDir }).tip
    expect(tip1).toBe(tip1again)
    expect(tip1).toMatch(/^[0-9a-f]{64}$/)

    appendEvent({ type: 'claim', detail: 'b' }, { terminalId: 't1', journalDir, now: 'T2' })
    expect(chainTip({ journalDir }).tip).not.toBe(tip1)
  })
})

describe('back-compat — reader stays fail-open while verifier detects', () => {
  it('readJournal ignores extra fields; a corrupt line skip-counts in reader, breaks in verifier', () => {
    writeFileSync(
      file(),
      [
        JSON.stringify({ ts: 'T1', terminal: 't1', seq: 1, type: 'warn', prev: 'genesis' }),
        '{ not json at all',
        JSON.stringify({ ts: 'T2', terminal: 't1', seq: 2, type: 'warn', prev: 'deadbeef' }),
      ].join('\n') + '\n',
    )
    const reader = readJournal({ journalDir })
    expect(reader.events).toHaveLength(2) // fail-open: corrupt line skipped
    expect(reader.corrupt).toBe(1)

    const verifier = verifyChain({ journalDir })
    expect(verifier.ok).toBe(false)
    // the corrupt line is a break in the chained region
    expect(verifier.breaks.some((b) => b.reason === 'corrupt')).toBe(true)
  })
})
