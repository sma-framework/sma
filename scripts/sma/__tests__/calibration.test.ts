/**
 * Tests for scripts/sma/lib/calibration.mjs (Phase 9.1 Plan 08, Task 2 — B20).
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

import {
  appendVerdict,
  readLedger,
  hitRate,
  escalations,
  recordGraderVerdict,
  scoreGraderVerdicts,
  hitRateByJudge,
} from '../lib/calibration.mjs'

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

// ── Grade the grader (9.4-02) ────────────────────────────────────────────────

/** A ground-truth evidence record for planId at `at` of the given type. */
function ev(type: string, planId: string, at: string) {
  return { type, planId, at }
}

describe('recordGraderVerdict (Test 1 — verdict-as-prediction record)', () => {
  it('appends a kind:grader-verdict record to the sma.verification ledger via appendVerdict', () => {
    const rec = recordGraderVerdict(
      { planId: '9.4-02', verdict: 'satisfied', judgeModelId: 'claude-judge-x', source: 'blind-verify', horizon: '2026-08-31' },
      { calibrationDir },
    )
    expect(rec).toMatchObject({
      kind: 'grader-verdict',
      domain: 'sma.verification',
      planId: '9.4-02',
      verdict: 'satisfied',
      judgeModelId: 'claude-judge-x',
      stampedBy: 'explicit',
      source: 'blind-verify',
    })
    // It landed in the sma.verification ledger file.
    const raw = readFileSync(join(calibrationDir, 'sma.verification.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    const { records } = readLedger({ calibrationDir, domain: 'sma.verification' })
    expect(records[0]).toMatchObject({ kind: 'grader-verdict', judgeModelId: 'claude-judge-x' })
  })

  it('missing judgeModelId falls back to resolveModelId({env}) and records stampedBy:resolved', () => {
    const rec = recordGraderVerdict(
      { planId: 'P', verdict: 'satisfied', source: 'verifier', horizon: 'h' },
      { calibrationDir, env: { SMA_MODEL: 'claude-from-env' } },
    )
    expect(rec.judgeModelId).toBe('claude-from-env')
    expect(rec.stampedBy).toBe('resolved')
  })

  it('nothing resolvable -> null judge id + stampedBy:unstamped (never a fake id)', () => {
    const rec = recordGraderVerdict(
      { planId: 'P', verdict: 'unsatisfied', source: 'verifier' },
      { calibrationDir, env: {} },
    )
    expect(rec.judgeModelId).toBeNull()
    expect(rec.stampedBy).toBe('unstamped')
  })

  it('a raw grader-verdict record is NOT a hit/miss and never distorts hitRate', () => {
    recordGraderVerdict({ planId: 'P', verdict: 'satisfied', judgeModelId: 'j' }, { calibrationDir })
    const { records } = readLedger({ calibrationDir, domain: 'sma.verification' })
    expect(hitRate(records).n).toBe(0) // 'satisfied' is not 'hit'/'miss'
  })
})

describe('scoreGraderVerdicts (Test 2/3 — ground-truth scoring, both directions)', () => {
  function graderRec(over: Record<string, unknown> = {}) {
    return {
      kind: 'grader-verdict',
      domain: 'sma.verification',
      planId: 'P',
      id: 'P',
      verdict: 'satisfied',
      judgeModelId: 'j',
      horizon: '2026-08-31T00:00:00.000Z',
      at: '2026-07-01T00:00:00.000Z',
      ...over,
    }
  }

  it('Test 2: satisfied + revert within horizon -> contradicted; after horizon or none (past horizon) -> stood; before horizon -> unsettled', () => {
    const rec = graderRec()
    // revert within horizon → contradicted
    const contra = scoreGraderVerdicts({
      records: [rec],
      evidence: [ev('revert', 'P', '2026-07-15T00:00:00.000Z')],
      now: '2026-09-01T00:00:00.000Z',
    })
    expect(contra[0].outcome).toBe('contradicted')
    expect(contra[0].contradictedBy).toMatchObject({ type: 'revert' })

    // evidence AFTER horizon → stood (horizon passed, nothing within)
    const late = scoreGraderVerdicts({
      records: [rec],
      evidence: [ev('revert', 'P', '2026-09-15T00:00:00.000Z')],
      now: '2026-10-01T00:00:00.000Z',
    })
    expect(late[0].outcome).toBe('stood')

    // no evidence + horizon passed → stood
    const stood = scoreGraderVerdicts({ records: [rec], evidence: [], now: '2026-09-01T00:00:00.000Z' })
    expect(stood[0].outcome).toBe('stood')

    // horizon not yet passed + no evidence → unsettled
    const unsettled = scoreGraderVerdicts({ records: [rec], evidence: [], now: '2026-07-10T00:00:00.000Z' })
    expect(unsettled[0].outcome).toBe('unsettled')
  })

  it('Test 3: unsatisfied verdict contradicted by clean ground truth (ci-green / founder-acceptance)', () => {
    const rec = graderRec({ verdict: 'unsatisfied' })
    const contra = scoreGraderVerdicts({
      records: [rec],
      evidence: [ev('ci-green', 'P', '2026-07-20T00:00:00.000Z')],
      now: '2026-09-01T00:00:00.000Z',
    })
    expect(contra[0].outcome).toBe('contradicted')

    // negative evidence CONFIRMS an unsatisfied verdict → it stood (grader was right)
    const stood = scoreGraderVerdicts({
      records: [rec],
      evidence: [ev('revert', 'P', '2026-07-20T00:00:00.000Z')],
      now: '2026-09-01T00:00:00.000Z',
    })
    expect(stood[0].outcome).toBe('stood')
  })

  it('Test 5: scoring is pure over injected records+evidence+now — a non-grader record is ignored', () => {
    const mixed = [graderRec(), verdict('sma.verification', 'hit', 'X')]
    const scored = scoreGraderVerdicts({ records: mixed, evidence: [], now: '2026-09-01T00:00:00.000Z' })
    expect(scored).toHaveLength(1) // only the grader-verdict record is scored
    expect(scored[0].kind).toBe('grader-verdict')
  })
})

describe('hitRateByJudge (Test 4 — judge slicing)', () => {
  function scored(judge: string | null, outcome: string) {
    return { kind: 'grader-verdict', judgeModelId: judge, outcome }
  }

  it('groups scored grader records by judgeModelId; stood=hit, contradicted=miss, unsettled ignored', () => {
    const res = hitRateByJudge([
      scored('judge-a', 'stood'),
      scored('judge-a', 'stood'),
      scored('judge-a', 'contradicted'),
      scored('judge-b', 'contradicted'),
      scored('judge-b', 'unsettled'), // ignored
    ])
    expect(res['judge-a']).toEqual({ hits: 2, misses: 1, rate: 2 / 3 })
    expect(res['judge-b']).toEqual({ hits: 0, misses: 1, rate: 0 })
  })

  it('records without a judge id land in an explicit unstamped bucket, never merged', () => {
    const res = hitRateByJudge([scored(null, 'stood'), scored('judge-a', 'stood')])
    expect(res.unstamped).toEqual({ hits: 1, misses: 0, rate: 1 })
    expect(res['judge-a']).toEqual({ hits: 1, misses: 0, rate: 1 })
    expect(Object.keys(res).sort()).toEqual(['judge-a', 'unstamped'])
  })
})
