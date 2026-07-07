/**
 * Tests for scripts/sma/lib/calibration.mjs (Phase 49.1 Plan 08, Task 2 — B20).
 *
 * Per-domain calibration ledger, mirroring journal.mjs's append-only-JSONL
 * shape (PATTERNS analog: exact):
 *   - Test 1: appendVerdict writes one JSONL line to
 *     .sma/calibration/<domain>.jsonl (temp DI dir); readLedger round-trips
 *     it; the file is append-only (prior lines never rewritten).
 *   - Test 2: hitRate over a fixture ledger (7 hits / 3 misses) returns 0.7
 *     with n=10.
 *   - Test 3: escalations() flags domains with hitRate < 0.6 AND n >= 5; a
 *     domain with n=3 is NEVER flagged (insufficient data).
 *   - Test 4: a corrupt JSONL line is skipped tolerantly (journal.mjs
 *     posture), not fatal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendVerdict, readLedger, hitRate, escalations } from '../lib/calibration.mjs'

let calibrationDir: string

beforeEach(() => {
  calibrationDir = mkdtempSync(join(tmpdir(), 'sma-calibration-'))
})

afterEach(() => {
  rmSync(calibrationDir, { recursive: true, force: true })
})

/** Minimal verdict record as scorePlan emits it. */
function verdict(domain: string, v: 'hit' | 'miss' | 'skipped-unsafe' | 'error', id = 'P1') {
  return {
    id,
    domain,
    metric: 'exit_code',
    comparator: '==',
    expected: 0,
    actual: v === 'hit' ? 0 : 1,
    hit: v === 'hit',
    verdict: v,
    confidence: null,
    scoredAt: '2026-07-06T10:00:00.000Z',
  }
}

describe('appendVerdict + readLedger — round-trip, append-only (Test 1)', () => {
  it('writes one JSONL line to <domain>.jsonl and readLedger round-trips it', () => {
    appendVerdict(verdict('tech.migrations', 'hit'), { calibrationDir })

    const raw = readFileSync(join(calibrationDir, 'tech.migrations.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)

    const { records, corrupt } = readLedger({ calibrationDir })
    expect(corrupt).toBe(0)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: 'P1', domain: 'tech.migrations', verdict: 'hit' })
  })

  it('is append-only: a second append preserves the first line byte-identically', () => {
    appendVerdict(verdict('tech.migrations', 'hit', 'P1'), { calibrationDir })
    const file = join(calibrationDir, 'tech.migrations.jsonl')
    const firstLine = readFileSync(file, 'utf8')

    appendVerdict(verdict('tech.migrations', 'miss', 'P2'), { calibrationDir })
    const after = readFileSync(file, 'utf8')

    expect(after.startsWith(firstLine)).toBe(true) // prior line never rewritten
    expect(after.trim().split('\n')).toHaveLength(2)
  })

  it('separate domains land in separate ledger files', () => {
    appendVerdict(verdict('tech.migrations', 'hit'), { calibrationDir })
    appendVerdict(verdict('crm.hooks', 'miss'), { calibrationDir })

    expect(readFileSync(join(calibrationDir, 'tech.migrations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(readFileSync(join(calibrationDir, 'crm.hooks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)

    const one = readLedger({ calibrationDir, domain: 'crm.hooks' })
    expect(one.records).toHaveLength(1)
    expect(one.records[0].domain).toBe('crm.hooks')
  })

  it('missing calibration dir -> honest empty ledger, no throw', () => {
    const res = readLedger({ calibrationDir: join(calibrationDir, 'nope') })
    expect(res.records).toEqual([])
    expect(res.corrupt).toBe(0)
  })
})

describe('hitRate (Test 2)', () => {
  it('7 hits / 3 misses -> rate 0.7 with n=10', () => {
    const records = [
      ...Array.from({ length: 7 }, (_, i) => verdict('tech.migrations', 'hit', `H${i}`)),
      ...Array.from({ length: 3 }, (_, i) => verdict('tech.migrations', 'miss', `M${i}`)),
    ]
    const res = hitRate(records)
    expect(res.rate).toBeCloseTo(0.7)
    expect(res.n).toBe(10)
    expect(res.hits).toBe(7)
    expect(res.misses).toBe(3)
  })

  it('skipped-unsafe and error verdicts do not count toward n', () => {
    const records = [
      verdict('d', 'hit'),
      verdict('d', 'miss'),
      verdict('d', 'skipped-unsafe'),
      verdict('d', 'error'),
    ]
    const res = hitRate(records)
    expect(res.n).toBe(2)
    expect(res.rate).toBeCloseTo(0.5)
  })

  it('empty ledger -> n=0, rate null (honest empty, not 0-divide)', () => {
    const res = hitRate([])
    expect(res.n).toBe(0)
    expect(res.rate).toBeNull()
  })
})

describe('escalations (Test 3 — B20 auto-escalation contract)', () => {
  it('flags a domain with hitRate < 0.6 AND n >= 5; never a domain with n=3', () => {
    // low: 2 hits / 3 misses -> rate 0.4, n=5 -> FLAGGED
    for (let i = 0; i < 2; i++) appendVerdict(verdict('low', 'hit', `h${i}`), { calibrationDir })
    for (let i = 0; i < 3; i++) appendVerdict(verdict('low', 'miss', `m${i}`), { calibrationDir })
    // small: 0 hits / 3 misses -> rate 0.0 but n=3 -> insufficient data, NOT flagged
    for (let i = 0; i < 3; i++) appendVerdict(verdict('small', 'miss', `s${i}`), { calibrationDir })
    // good: 5 hits / 1 miss -> rate ~0.83 -> NOT flagged
    for (let i = 0; i < 5; i++) appendVerdict(verdict('good', 'hit', `g${i}`), { calibrationDir })
    appendVerdict(verdict('good', 'miss', 'gm'), { calibrationDir })

    const flagged = escalations({ calibrationDir })
    expect(flagged.map((f: { domain: string }) => f.domain)).toEqual(['low'])
    expect(flagged[0].rate).toBeCloseTo(0.4)
    expect(flagged[0].n).toBe(5)
  })

  it('honors custom threshold/minN options', () => {
    for (let i = 0; i < 2; i++) appendVerdict(verdict('d', 'hit', `h${i}`), { calibrationDir })
    for (let i = 0; i < 1; i++) appendVerdict(verdict('d', 'miss', `m${i}`), { calibrationDir })
    // rate ~0.67, n=3
    expect(escalations({ calibrationDir, threshold: 0.7, minN: 3 }).map((f: { domain: string }) => f.domain)).toEqual(['d'])
    expect(escalations({ calibrationDir, threshold: 0.6, minN: 3 })).toEqual([])
  })
})

describe('corrupt line tolerance (Test 4 — journal.mjs posture)', () => {
  it('skips a corrupt JSONL line with a counted warning, never a throw', () => {
    const file = join(calibrationDir, 'tech.migrations.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify(verdict('tech.migrations', 'hit', 'ok1')),
        '{ this is not json',
        JSON.stringify(verdict('tech.migrations', 'miss', 'ok2')),
      ].join('\n') + '\n',
    )

    const res = readLedger({ calibrationDir })
    expect(res.records).toHaveLength(2)
    expect(res.corrupt).toBe(1)
  })
})
