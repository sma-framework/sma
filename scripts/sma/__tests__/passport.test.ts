/**
 * Tests for scripts/sma/lib/passport.mjs (Phase 49.3 Plan 02, Task 2 —
 * D-49.3-10).
 *
 * The calibration passport: a deterministic, reproducible function of committed
 * data that writes PASSPORT.md + a public README badge.
 *   - Test 1: buildSnapshot over a fixture ledger (totals exclude sma.receipts;
 *     receipts section counts receipt_verdict; ledger meta {lines, corrupt}).
 *   - Test 2: anchors (chainTip embedded verbatim; 'empty' sentinel honest;
 *     capturedAt from injected now).
 *   - Test 3: render determinism (byte-identical; fenced sma-passport-snapshot;
 *     canonicalJson sorts keys recursively).
 *   - Test 4: round-trip (parseSnapshot(renderPassport(s)) deep-equals s;
 *     null on a missing block, never throws).
 *   - Test 5: badge states (ok+n / stale-priors / collecting / no-model-data).
 *   - Test 6: managed block (outside-untouched, EOF append, idempotent).
 *   - Test 7: fresh-window numbers (badge = current model's window; passport
 *     still shows all-time + per-model).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BADGE_MIN_N,
  buildSnapshot,
  canonicalJson,
  renderPassport,
  parseSnapshot,
  renderBadgeBlock,
  writeManagedBlock,
  spliceManagedBlock,
  readManagedBlock,
} from '../lib/passport.mjs'

let calibrationDir: string
let modelDir: string
let workDir: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'sma-passport-'))
  calibrationDir = join(base, 'calibration')
  modelDir = join(base, 'model')
  workDir = base
  mkdirSync(calibrationDir, { recursive: true })
  mkdirSync(modelDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeLedger(domain: string, records: object[]) {
  const lines = records.map((r) => JSON.stringify({ domain, ...r })).join('\n') + '\n'
  writeFileSync(join(calibrationDir, `${domain}.jsonl`), lines)
}

function writeSightings(sightings: object[]) {
  writeFileSync(join(modelDir, 'sightings.jsonl'), sightings.map((s) => JSON.stringify(s)).join('\n') + '\n')
}

function hit(extra: object = {}) {
  return { id: 'P', verdict: 'hit', scoredAt: '2026-07-01T00:00:00Z', ...extra }
}
function miss(extra: object = {}) {
  return { id: 'P', verdict: 'miss', scoredAt: '2026-07-01T00:00:00Z', ...extra }
}

const dirsFor = () => ({ calibrationDir, modelDir })

describe('Test 1 — buildSnapshot over a fixture ledger', () => {
  it('computes per-domain rows, totals exclude sma.receipts, receipts counted separately', () => {
    writeSightings([{ model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('sma.bench', [hit({ model: 'claude-x-1' }), hit({ model: 'claude-x-1' }), miss({ model: 'claude-x-1' })])
    writeLedger('platform.crm', [hit({ model: 'claude-x-1' })])
    writeLedger('sma.receipts', [
      { id: 'R1', verdict: 'hit', receipt_verdict: 'verified' },
      { id: 'R2', verdict: 'miss', receipt_verdict: 'divergent' },
      { id: 'R3', verdict: 'skipped-unsafe', receipt_verdict: 'skipped-unsafe' },
    ])

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'deadbeef', now: '2026-07-09T00:00:00Z' })

    // prediction totals exclude sma.receipts: 3 hits, 1 miss over bench+crm = 4 n
    expect(snap.calibration.totals).toMatchObject({ hits: 3, misses: 1, n: 4 })
    const benchRow = snap.calibration.domains.find((d) => d.domain === 'sma.bench')
    expect(benchRow).toMatchObject({ n: 3, hits: 2, misses: 1 })
    expect(snap.calibration.domains.some((d) => d.domain === 'sma.receipts')).toBe(false)

    // receipts section counts receipt_verdict
    expect(snap.receipts).toMatchObject({ verified: 1, divergent: 1, skippedUnsafe: 1, errors: 0, n: 3 })

    // ledger meta reports lines + corrupt
    expect(snap.ledger).toMatchObject({ lines: 7, corrupt: 0 })
  })
})

describe('Test 2 — anchors', () => {
  it('embeds the injected chainTip verbatim and capturedAt from the injected now', () => {
    writeSightings([{ model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' }])
    const snap = buildSnapshot({
      dirs: dirsFor(),
      chainTipFn: () => ({ tip: 'abc123', files: [] }),
      now: '2026-07-09T11:22:33Z',
    })
    expect(snap.chainTip).toEqual({ tip: 'abc123', files: [] })
    expect(snap.capturedAt).toBe('2026-07-09T11:22:33Z')
  })

  it('passes the empty sentinel honestly when the journal is missing', () => {
    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'empty', now: 't' })
    expect(snap.chainTip).toBe('empty')
  })
})

describe('Test 3 — render determinism', () => {
  it('renders byte-identical twice and holds a fenced sma-passport-snapshot block', () => {
    writeSightings([{ model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('sma.bench', [hit({ model: 'claude-x-1' })])
    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })
    const a = renderPassport(snap)
    const b = renderPassport(snap)
    expect(a).toBe(b)
    expect(a).toContain('```sma-passport-snapshot')
    expect(a.endsWith('\n')).toBe(true)
  })

  it('canonicalJson sorts keys recursively -> order-independent bytes', () => {
    const one = { b: 1, a: { d: 4, c: 3 } }
    const two = { a: { c: 3, d: 4 }, b: 1 }
    expect(canonicalJson(one)).toBe(canonicalJson(two))
    expect(canonicalJson(one)).not.toContain('\r')
  })
})

describe('Test 4 — round-trip', () => {
  it('parseSnapshot(renderPassport(s)) deep-equals s', () => {
    writeSightings([{ model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('sma.bench', [hit({ model: 'claude-x-1' }), miss({ model: 'claude-x-1' })])
    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })
    const parsed = parseSnapshot(renderPassport(snap))
    expect(parsed).toEqual(snap)
  })

  it('returns null on a file without the fenced block, never throws', () => {
    expect(parseSnapshot('# just a readme\n\nno block here')).toBeNull()
    expect(parseSnapshot('')).toBeNull()
  })
})

describe('Test 5 — badge states', () => {
  function snapWithGuard(guard: object, model = 'claude-x-1') {
    return {
      schema: 1,
      capturedAt: 't',
      model: { id: model, since: null, source: 'env' },
      guard,
      calibration: { domains: [], totals: { hits: 0, misses: 0, n: 0, rate: null }, perModel: [] },
      receipts: { verified: 0, divergent: 0, skippedUnsafe: 0, errors: 0, n: 0 },
      chainTip: 'tip',
      ledger: { lines: 0, corrupt: 0 },
    }
  }

  it('ok + n>=BADGE_MIN_N -> shields badge with the claim + link', () => {
    const block = renderBadgeBlock(snapWithGuard({ status: 'ok', freshN: 142, freshRate: 0.87, requiredN: BADGE_MIN_N }))
    expect(block).toContain('SMA-calibrated: 87% hits, n=142')
    expect(block).toContain('img.shields.io/badge/')
    expect(block).toContain('PASSPORT.md')
  })

  it('stale-priors -> recalibrating notice, NO percent claim', () => {
    const block = renderBadgeBlock(snapWithGuard({ status: 'stale-priors', freshN: 7, freshRate: null, requiredN: 20 }))
    expect(block).toContain('recalibrating after model change (n=7/20)')
    expect(block).not.toMatch(/\d+% hits/)
  })

  it('ok but n<BADGE_MIN_N -> collecting notice, NO percent claim', () => {
    const block = renderBadgeBlock(snapWithGuard({ status: 'ok', freshN: 3, freshRate: 1, requiredN: 20 }))
    expect(block).toContain('collecting calibration data (n=3/20)')
    expect(block).not.toMatch(/\d+% hits/)
  })

  it('no-model-data -> hidden with reason', () => {
    const block = renderBadgeBlock(snapWithGuard({ status: 'no-model-data', freshN: 0, freshRate: null, requiredN: 20 }))
    expect(block).toContain('hidden')
    expect(block).not.toMatch(/\d+% hits/)
  })
})

describe('Test 6 — managed block', () => {
  it('replaces ONLY the span between markers; bytes outside untouched', () => {
    const before = '# Title\n\nintro text\n'
    const after = '\n## Footer\nbye\n'
    const initial =
      before + '<!-- sma:passport:begin -->\nOLD\n<!-- sma:passport:end -->' + after
    const next = spliceManagedBlock(initial, 'NEW')
    expect(next.startsWith('# Title\n\nintro text\n')).toBe(true)
    expect(next).toContain('## Footer\nbye')
    expect(next).toContain('<!-- sma:passport:begin -->\nNEW\n<!-- sma:passport:end -->')
    expect(next).not.toContain('OLD')
  })

  it('appends the block at EOF with one blank-line separator when markers are absent', () => {
    const next = spliceManagedBlock('# Readme\ncontent\n', 'BADGE')
    expect(next).toBe('# Readme\ncontent\n\n<!-- sma:passport:begin -->\nBADGE\n<!-- sma:passport:end -->\n')
  })

  it('is idempotent (same content -> byte-identical) via writeManagedBlock', () => {
    const file = join(workDir, 'README.md')
    writeFileSync(file, '# Readme\ncontent\n')
    writeManagedBlock({ filePath: file, content: 'BADGE' })
    const once = readFileSync(file, 'utf8')
    writeManagedBlock({ filePath: file, content: 'BADGE' })
    const twice = readFileSync(file, 'utf8')
    expect(twice).toBe(once)
    expect(readManagedBlock(twice)).toBe('BADGE')
  })
})

describe('Test 7 — fresh-window numbers', () => {
  it('badge headlines the current model window while passport shows all-time + per-model', () => {
    // model change: x-1 -> x-2. 50 old-model records at 90%, 22 fresh at ~80%.
    writeSightings([
      { model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' },
      { model: 'claude-x-2', source: 'env', at: '2026-07-01T00:00:00Z' },
    ])
    const oldRecs = [
      ...Array.from({ length: 45 }, () => hit({ model: 'claude-x-1' })),
      ...Array.from({ length: 5 }, () => miss({ model: 'claude-x-1' })),
    ]
    const freshRecs = [
      ...Array.from({ length: 18 }, () => hit({ model: 'claude-x-2', scoredAt: '2026-07-05T00:00:00Z' })),
      ...Array.from({ length: 4 }, () => miss({ model: 'claude-x-2', scoredAt: '2026-07-05T00:00:00Z' })),
    ]
    writeLedger('sma.bench', [...oldRecs, ...freshRecs])

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })
    // fresh window: 18/22 ~ 82%
    expect(snap.guard.freshN).toBe(22)
    expect(Math.round((snap.guard.freshRate ?? 0) * 100)).toBe(82)

    const badge = renderBadgeBlock(snap)
    expect(badge).toContain('82% hits, n=22')

    const passport = renderPassport(snap)
    // all-time table present (72 total), per-model breakdown shows both models
    expect(passport).toContain('claude-x-1')
    expect(passport).toContain('claude-x-2')
    expect(passport).toContain('| **Total** |')
  })
})
