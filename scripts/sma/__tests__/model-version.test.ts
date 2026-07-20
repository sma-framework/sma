/**
 * Tests for scripts/sma/lib/model-version.mjs (Phase 9.3 Plan 02, Task 1 —
 * D-9.3-10, grill missing-leaps ICE 567).
 *
 * The model-sighting timeline + stale-priors guard that keeps the calibration
 * badge honest across a Claude-model change.
 *   - Test 1: recordModelSighting dedup timeline (append one, dedup a repeat,
 *     append a distinct model; readModelTimeline returns them ordered).
 *   - Test 2: resolveModelId probe order (model.id > display_name > plain
 *     string > env SMA_MODEL; nothing -> null; recordModelSighting NO-OP).
 *   - Test 3: honest empty (currentModel null, empty timeline, corrupt line
 *     skip-and-counted).
 *   - Test 4: modelGuard states (no-model-data / ok / stale-priors / ok again).
 *   - Test 5: freshN counting rules (stamped current vs old vs legacy vs
 *     non-hit/miss verdicts).
 *   - Test 6: stampRecords pure additive stamp.
 *   - Test 7: recorder fail-open under a throwing fs double.
 *   - Test 8: freshN dedupes by prediction id — the LATEST hit/miss verdict
 *     wins; re-scoring never inflates n (2026-07-10 dogfood lesson: 55 ledger
 *     records vs 45 unique predictions).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordModelSighting,
  readModelTimeline,
  currentModel,
  modelGuard,
  stampRecords,
  resolveModelId,
  timelineSchemaOk,
  JUDGE_MODEL_FIELD,
} from '../lib/model-version.mjs'

let modelDir: string

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), 'sma-model-'))
})

afterEach(() => {
  rmSync(modelDir, { recursive: true, force: true })
})

const FIXED_NOW = '2026-07-09T12:00:00.000Z'

/**
 * A minimal calibration verdict record. Ids auto-increment: freshN counts
 * UNIQUE prediction ids (Test 8), so fixtures that mean N distinct predictions
 * must carry N distinct ids. Pass an explicit id to model a re-score.
 */
let recSeq = 0
function rec(
  verdict: 'hit' | 'miss' | 'skipped-unsafe' | 'error',
  extra: Record<string, unknown> = {},
) {
  recSeq += 1
  return { id: `P${recSeq}`, domain: 'sma.bench', verdict, scoredAt: '2026-07-01T00:00:00.000Z', ...extra }
}

describe('Test 1 — recordModelSighting dedup timeline', () => {
  it('appends one line, dedups a repeat, appends a distinct model', () => {
    expect(recordModelSighting({ model: 'claude-x-1', source: 'stdin-json', modelDir, now: FIXED_NOW })).toMatchObject({
      ok: true,
      appended: true,
    })
    // A second call with the SAME model appends nothing (dedup against last line).
    expect(recordModelSighting({ model: 'claude-x-1', source: 'stdin-json', modelDir, now: FIXED_NOW })).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'dedup',
    })
    // A distinct model appends a second line.
    recordModelSighting({ model: 'claude-x-2', source: 'stdin-json', modelDir, now: FIXED_NOW })

    const raw = readFileSync(join(modelDir, 'sightings.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)

    const { sightings, corrupt } = readModelTimeline({ modelDir })
    expect(corrupt).toBe(0)
    expect(sightings.map((s) => s.model)).toEqual(['claude-x-1', 'claude-x-2'])
    expect(sightings[0]).toMatchObject({ model: 'claude-x-1', source: 'stdin-json', at: FIXED_NOW })
  })
})

describe('Test 2 — resolveModelId probe order', () => {
  it('model.id wins over display_name wins over a plain string', () => {
    expect(resolveModelId({ stdinJson: { model: { id: 'id-1', display_name: 'Display' } } })).toEqual({
      model: 'id-1',
      source: 'stdin-json',
    })
    expect(resolveModelId({ stdinJson: { model: { display_name: 'Display' } } })).toEqual({
      model: 'Display',
      source: 'stdin-json',
    })
    expect(resolveModelId({ stdinJson: { model: 'plain-model' } })).toEqual({
      model: 'plain-model',
      source: 'stdin-json',
    })
  })

  it('falls back to env SMA_MODEL with source env, and returns null when nothing is present', () => {
    expect(resolveModelId({ stdinJson: {}, env: { SMA_MODEL: 'env-model' } })).toEqual({
      model: 'env-model',
      source: 'env',
    })
    expect(resolveModelId({ stdinJson: {}, env: {} })).toBeNull()
  })

  it('recordModelSighting is a NO-OP when the model is null (no file created)', () => {
    const res = recordModelSighting({ model: null, source: 'stdin-json', modelDir, now: FIXED_NOW })
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'no-model' })
    expect(() => readFileSync(join(modelDir, 'sightings.jsonl'), 'utf8')).toThrow()
  })
})

describe('Test 3 — honest empty + corrupt tolerance', () => {
  it('currentModel is null on an empty/missing dir; readModelTimeline is empty', () => {
    expect(currentModel({ modelDir })).toBeNull()
    expect(readModelTimeline({ modelDir })).toEqual({ sightings: [], corrupt: 0 })
  })

  it('a corrupt JSONL line is skip-and-counted, never fatal', () => {
    // Inject a reader that returns one good + one corrupt line.
    const fs = { readFileSync: () => '{"model":"claude-x-1","source":"env","at":"t"}\n{not json}\n' }
    const { sightings, corrupt } = readModelTimeline({ modelDir, fs })
    expect(sightings).toHaveLength(1)
    expect(corrupt).toBe(1)
  })
})

describe('Test 4 — modelGuard states', () => {
  it('no timeline -> no-model-data', () => {
    expect(modelGuard({ records: [], timeline: { sightings: [] } })).toMatchObject({
      status: 'no-model-data',
      freshN: 0,
    })
  })

  it('single sighting + 25 stamped hit/miss records -> ok, freshN 25', () => {
    const timeline = { sightings: [{ model: 'claude-x-1', source: 'env', at: 't0' }] }
    const records = Array.from({ length: 25 }, () => rec('hit', { model: 'claude-x-1' }))
    expect(modelGuard({ records, timeline })).toMatchObject({ status: 'ok', freshN: 25 })
  })

  it('a model change with only 7 fresh records -> stale-priors, requiredN 20', () => {
    const timeline = {
      sightings: [
        { model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' },
        { model: 'claude-x-2', source: 'env', at: '2026-07-01T00:00:00Z' },
      ],
    }
    const records = Array.from({ length: 7 }, () => rec('hit', { model: 'claude-x-2' }))
    expect(modelGuard({ records, timeline })).toMatchObject({
      status: 'stale-priors',
      freshN: 7,
      requiredN: 20,
    })
  })

  it('20 fresh records after a change -> ok', () => {
    const timeline = {
      sightings: [
        { model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' },
        { model: 'claude-x-2', source: 'env', at: '2026-07-01T00:00:00Z' },
      ],
    }
    const records = Array.from({ length: 20 }, () => rec('hit', { model: 'claude-x-2' }))
    expect(modelGuard({ records, timeline })).toMatchObject({ status: 'ok', freshN: 20 })
  })
})

describe('Test 5 — freshN counting rules', () => {
  const timeline = {
    sightings: [
      { model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' },
      { model: 'claude-x-2', source: 'env', at: '2026-07-01T00:00:00Z' },
    ],
  }

  it('current-model stamped counts; old-model stamped does not', () => {
    const records = [rec('hit', { model: 'claude-x-2' }), rec('hit', { model: 'claude-x-1' })]
    expect(modelGuard({ records, timeline }).freshN).toBe(1)
  })

  it('an unstamped legacy record counts iff scoredAt > last change at', () => {
    const records = [
      rec('hit', { scoredAt: '2026-07-15T00:00:00Z' }), // after the change -> counts
      rec('hit', { scoredAt: '2026-06-15T00:00:00Z' }), // before the change -> does not
    ]
    expect(modelGuard({ records, timeline }).freshN).toBe(1)
  })

  it('skipped-unsafe and error verdicts never count', () => {
    const records = [
      rec('skipped-unsafe', { model: 'claude-x-2' }),
      rec('error', { model: 'claude-x-2' }),
      rec('hit', { model: 'claude-x-2' }),
    ]
    expect(modelGuard({ records, timeline }).freshN).toBe(1)
  })
})

describe('Test 6 — stampRecords pure additive', () => {
  it('stamps model onto each record without mutating other fields', () => {
    const src = [
      { id: 'A', verdict: 'hit' },
      { id: 'B', verdict: 'miss' },
    ]
    const out = stampRecords(src, { model: 'claude-x-1' })
    expect(out).toEqual([
      { id: 'A', verdict: 'hit', model: 'claude-x-1' },
      { id: 'B', verdict: 'miss', model: 'claude-x-1' },
    ])
    // originals untouched
    expect(src[0]).toEqual({ id: 'A', verdict: 'hit' })
  })

  it('a null model leaves records untouched (no model key)', () => {
    const src = [{ id: 'A', verdict: 'hit' }]
    const out = stampRecords(src, { model: null })
    expect(out).toEqual([{ id: 'A', verdict: 'hit' }])
    expect('model' in out[0]).toBe(false)
  })

  it('stamps an optional judgeModelId under JUDGE_MODEL_FIELD; both stamps are independent (9.4-02)', () => {
    const src = [{ id: 'A', verdict: 'hit' }]
    // judge-only stamp
    expect(stampRecords(src, { judgeModelId: 'judge-x' })).toEqual([{ id: 'A', verdict: 'hit', judgeModelId: 'judge-x' }])
    // both actor + judge stamps
    expect(stampRecords(src, { model: 'actor-1', judgeModelId: 'judge-x' })).toEqual([
      { id: 'A', verdict: 'hit', model: 'actor-1', judgeModelId: 'judge-x' },
    ])
    // BOTH null → untouched (existing callers passing only {model} unchanged)
    const out = stampRecords(src, { model: null, judgeModelId: null })
    expect(out).toEqual([{ id: 'A', verdict: 'hit' }])
    expect('judgeModelId' in out[0]).toBe(false)
    expect(JUDGE_MODEL_FIELD).toBe('judgeModelId')
  })
})

describe('Test 7 — recorder fail-open', () => {
  it('a throwing fs double yields {ok:false, error} and never throws', () => {
    const throwingFs = {
      readFileSync: () => {
        throw new Error('boom-read')
      },
      mkdirSync: () => {
        throw new Error('boom-mkdir')
      },
      appendFileSync: () => {
        throw new Error('boom-append')
      },
    }
    let res: ReturnType<typeof recordModelSighting>
    expect(() => {
      res = recordModelSighting({ model: 'claude-x-1', source: 'env', modelDir, fs: throwingFs, now: FIXED_NOW })
    }).not.toThrow()
    expect(res!).toMatchObject({ ok: false })
    expect(res!.error).toBeTruthy()
  })
})

describe('Test 8 — freshN dedupes by prediction id (latest verdict wins)', () => {
  const timeline = { sightings: [{ model: 'claude-x-1', source: 'env', at: 't0' }] }

  it('re-scoring the same prediction does not inflate n; the LATEST verdict stands', () => {
    const records = [
      rec('hit', { id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-07-01T00:00:00Z' }),
      rec('miss', { id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-07-02T00:00:00Z' }),
    ]
    const g = modelGuard({ records, timeline })
    expect(g.freshN).toBe(1)
    expect(g.freshHits).toBe(0)
    expect(g.freshRate).toBe(0)
  })

  it('latest is picked by scoredAt, not array position; a timestamp tie falls to ledger (append) order', () => {
    const records = [
      rec('miss', { id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-07-02T00:00:00Z' }),
      rec('hit', { id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-07-01T00:00:00Z' }), // earlier, later in array
    ]
    expect(modelGuard({ records, timeline })).toMatchObject({ freshN: 1, freshHits: 0 })

    const tied = [
      rec('hit', { id: 'P-tie', model: 'claude-x-1', scoredAt: '2026-07-02T00:00:00Z' }),
      rec('miss', { id: 'P-tie', model: 'claude-x-1', scoredAt: '2026-07-02T00:00:00Z' }), // appended later -> wins
    ]
    expect(modelGuard({ records: tied, timeline })).toMatchObject({ freshN: 1, freshHits: 0 })
  })

  it('55 records over 45 unique predictions count as n=45 (2026-07-10 dogfood lesson)', () => {
    const uniques = Array.from({ length: 45 }, (_, i) =>
      rec('hit', { id: `P-u${i}`, model: 'claude-x-1', scoredAt: '2026-07-01T00:00:00Z' }),
    )
    const rescored = Array.from({ length: 10 }, (_, i) =>
      rec('miss', { id: `P-u${i}`, model: 'claude-x-1', scoredAt: '2026-07-08T00:00:00Z' }),
    )
    const g = modelGuard({ records: [...uniques, ...rescored], timeline })
    expect(g.freshN).toBe(45)
    expect(g.freshHits).toBe(35) // the 10 re-scored predictions stand at their LATEST verdict (miss)
    expect(g.freshRate).toBeCloseTo(35 / 45, 10)
  })

  it('records without an id are never collapsed together', () => {
    const records = [
      rec('hit', { id: undefined, model: 'claude-x-1' }),
      rec('hit', { id: undefined, model: 'claude-x-1' }),
    ]
    expect(modelGuard({ records, timeline }).freshN).toBe(2)
  })
})

describe('Test 9 — timelineSchemaOk: the --schema-check contract (BL-172)', () => {
  it('accepts the honest-empty timeline AND a populated one — the sighting COUNT never changes the verdict', () => {
    expect(timelineSchemaOk({ sightings: [], corrupt: 0 })).toBe(true)
    expect(timelineSchemaOk(readModelTimeline({ modelDir }))).toBe(true) // real reader, empty dir
    const sightings = Array.from({ length: 8 }, (_, i) => ({ model: `m-${i}`, source: 'env', at: `t${i}` }))
    expect(timelineSchemaOk({ sightings, corrupt: 0 })).toBe(true)
  })

  it('rejects a malformed sighting, a non-numeric corrupt count, and a non-object', () => {
    expect(timelineSchemaOk({ sightings: [{ source: 'env', at: 't' }], corrupt: 0 })).toBe(false) // no model
    expect(timelineSchemaOk({ sightings: [{ model: '', source: 'env', at: 't' }], corrupt: 0 })).toBe(false)
    expect(timelineSchemaOk({ sightings: [{ model: 'm', source: 'env' }], corrupt: 0 })).toBe(false) // no at
    expect(timelineSchemaOk({ sightings: 'nope', corrupt: 0 })).toBe(false)
    expect(timelineSchemaOk({ sightings: [], corrupt: NaN })).toBe(false)
    expect(timelineSchemaOk(null)).toBe(false)
  })
})
