/**
 * Tests for scripts/sma/lib/model-version.mjs (Phase 49.3 Plan 02, Task 1 —
 * D-49.3-10, grill missing-leaps ICE 567).
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
} from '../lib/model-version.mjs'

let modelDir: string

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), 'sma-model-'))
})

afterEach(() => {
  rmSync(modelDir, { recursive: true, force: true })
})

const FIXED_NOW = '2026-07-09T12:00:00.000Z'

/** A minimal calibration verdict record. */
function rec(
  verdict: 'hit' | 'miss' | 'skipped-unsafe' | 'error',
  extra: Record<string, unknown> = {},
) {
  return { id: 'P1', domain: 'sma.bench', verdict, scoredAt: '2026-07-01T00:00:00.000Z', ...extra }
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
