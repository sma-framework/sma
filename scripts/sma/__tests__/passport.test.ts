/**
 * Tests for scripts/sma/lib/passport.mjs.
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
 *   - Test 8: re-scored predictions never inflate the passport — calibration
 *     totals/domains/perModel count UNIQUE prediction ids (latest verdict
 *     wins), in agreement with modelGuard's freshN; receipts counts and the
 *     ledger line count stay per-record (2026-07-10 dogfood lesson).
 *   - Test 10: THE WIRE — a verdict written into the ledger actually reaches
 *     the public badge, and the bar is read from BOTH sides: at the bar the
 *     claim shows, one short of it it does not, a model change hides it
 *     again, and re-scoring one prediction of one plan never walks up to it.
 *   - Test 11: the badge is rebuilt into EVERY README of the repository, and
 *     the passport says out loud what it is able to count and what it is not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
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
  snapshotSchemaOk,
  writeBadgeToReadmes,
  resolveWorkingTreeRoot,
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

/**
 * Ids auto-increment: the passport counts UNIQUE prediction ids (Test 8), so
 * fixtures that mean N distinct predictions must carry N distinct ids. Pass an
 * explicit id to model a re-score of the same prediction.
 */
let predSeq = 0
function hit(extra: object = {}) {
  predSeq += 1
  return { id: `P${predSeq}`, verdict: 'hit', scoredAt: '2026-07-01T00:00:00Z', ...extra }
}
function miss(extra: object = {}) {
  predSeq += 1
  return { id: `P${predSeq}`, verdict: 'miss', scoredAt: '2026-07-01T00:00:00Z', ...extra }
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

describe('Test 8 — re-scored predictions never inflate the passport (dedupe by id, latest verdict wins)', () => {
  it('totals + domains + guard count unique predictions; receipts and ledger lines stay per-record', () => {
    writeSightings([{ model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('sma.bench', [
      hit({ id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-07-01T00:00:00Z' }),
      miss({ id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-07-02T00:00:00Z' }), // re-score — latest wins
      hit({ id: 'P-solo', model: 'claude-x-1' }),
    ])
    writeLedger('sma.receipts', [
      { id: 'R1', verdict: 'hit', receipt_verdict: 'verified' },
      { id: 'R1', verdict: 'hit', receipt_verdict: 'verified' }, // R1 reused by ANOTHER summary — never deduped
    ])

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })

    // 3 bench records, 2 unique predictions; P-dup stands at its latest verdict (miss).
    expect(snap.calibration.totals).toMatchObject({ n: 2, hits: 1, misses: 1 })
    expect(snap.calibration.domains.find((d) => d.domain === 'sma.bench')).toMatchObject({
      n: 2,
      hits: 1,
      misses: 1,
    })
    // The guard counts the SAME deduped set — passport and badge can never disagree.
    expect(snap.guard.freshN).toBe(2)
    expect(snap.guard.freshRate).toBe(0.5)
    // Receipt ids are only unique within one SUMMARY — receipts counts stay per-record.
    expect(snap.receipts).toMatchObject({ verified: 2, n: 2 })
    // Ledger meta stays the raw line count (a size stat, not a calibration claim).
    expect(snap.ledger).toMatchObject({ lines: 5, corrupt: 0 })
  })

  it('perModel counts a re-scored prediction ONCE, under the model of its latest verdict', () => {
    writeSightings([
      { model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' },
      { model: 'claude-x-2', source: 'env', at: '2026-07-01T00:00:00Z' },
    ])
    writeLedger('sma.bench', [
      hit({ id: 'P-dup', model: 'claude-x-1', scoredAt: '2026-06-15T00:00:00Z' }),
      miss({ id: 'P-dup', model: 'claude-x-2', scoredAt: '2026-07-05T00:00:00Z' }),
    ])

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })

    expect(snap.calibration.totals).toMatchObject({ n: 1, hits: 0, misses: 1 })
    // The superseded claude-x-1 verdict does not surface a per-model row at all.
    expect(snap.calibration.perModel.find((m) => m.model === 'claude-x-1')).toBeUndefined()
    expect(snap.calibration.perModel.find((m) => m.model === 'claude-x-2')).toMatchObject({ n: 1, misses: 1 })
  })
})

describe('Test 9 — snapshotSchemaOk: the --schema-check contract', () => {
  it('accepts null (the honest {} read surface), an empty-ledger snapshot, AND a populated one — accrual never flips it', () => {
    expect(snapshotSchemaOk(null)).toBe(true) // PASSPORT.md absent/no fence -> --json honestly prints {}
    const empty = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'empty', now: 't' })
    expect(snapshotSchemaOk(empty)).toBe(true)

    writeSightings([{ model: 'claude-x-1', source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('sma.bench', [hit({ model: 'claude-x-1' }), miss({ model: 'claude-x-1' })])
    const populated = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })
    expect(snapshotSchemaOk(populated)).toBe(true)
    // round-trip: the committed-passport read path yields a schema-valid snapshot
    expect(snapshotSchemaOk(parseSnapshot(renderPassport(populated)))).toBe(true)
  })

  it('rejects a wrong schema version and a mis-shaped snapshot', () => {
    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })
    expect(snapshotSchemaOk({ ...snap, schema: 2 })).toBe(false)
    expect(snapshotSchemaOk({ ...snap, guard: null })).toBe(false)
    expect(snapshotSchemaOk({ ...snap, calibration: { ...snap.calibration, domains: 'x' } })).toBe(false)
    expect(snapshotSchemaOk({ ...snap, ledger: { lines: NaN, corrupt: 0 } })).toBe(false)
    expect(snapshotSchemaOk('not an object')).toBe(false)
  })
})

describe('Test 10 — THE WIRE: a verdict written into the ledger reaches the public badge', () => {
  // This block is an assertion about a WIRE, not about arithmetic. Until the accounting key
  // became «plan file + id», the very same input below produced ONE observation instead of
  // twenty: every plan reusing the same short id collapsed into a single data point, so the
  // bar was unreachable by construction and the badge could never show — no matter how many
  // real verdicts a project earned. The first case proves the collapse is gone; the last one
  // proves the anti-inflation guard that the collapse used to impersonate is still there.
  // They belong side by side: either one alone can be satisfied by a wrong fix.
  const CURRENT = 'claude-x-1'

  /** n verdicts sharing ONE short id, each belonging to a DIFFERENT plan; `hits` of them hits. */
  function acrossPlans(n: number, hits: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: 'P1',
      plan: `.planning/phases/demo/demo-${String(i + 1).padStart(2, '0')}-PLAN.md`,
      verdict: i < hits ? 'hit' : 'miss',
      model: CURRENT,
      scoredAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
  }

  it('twenty verdicts of one id from twenty DIFFERENT plans are twenty observations — and the claim shows', () => {
    writeSightings([{ model: CURRENT, source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('tech.wire', acrossPlans(BADGE_MIN_N, 17))

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })

    // twenty, not one: the ledger side and the guard side agree on what a prediction IS
    expect(snap.guard.freshN).toBe(BADGE_MIN_N)
    expect(snap.guard.status).toBe('ok')
    expect(snap.calibration.totals).toMatchObject({ n: BADGE_MIN_N, hits: 17, misses: 3 })

    // and the number travels all the way out to the public surface
    const badge = renderBadgeBlock(snap)
    expect(badge).toContain(`85% hits, n=${BADGE_MIN_N}`)
    expect(badge).toContain('img.shields.io/badge/')
    expect(renderPassport(snap)).toContain(`SMA-calibrated: 85% hits, n=${BADGE_MIN_N}`)
  })

  it('one verdict short of the bar the claim is withheld, and the line says the number out loud', () => {
    writeSightings([{ model: CURRENT, source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger('tech.wire', acrossPlans(BADGE_MIN_N - 1, BADGE_MIN_N - 1))

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })

    expect(snap.guard.freshN).toBe(BADGE_MIN_N - 1)
    const badge = renderBadgeBlock(snap)
    expect(badge).toContain(`collecting calibration data (n=${BADGE_MIN_N - 1}/${BADGE_MIN_N})`)
    expect(badge).not.toMatch(/\d+% hits/) // a 100%-hits claim over 19 points is exactly the lie the bar exists to stop
    expect(renderPassport(snap)).toContain(`collecting calibration data (n=${BADGE_MIN_N - 1}/${BADGE_MIN_N})`)
  })

  it('the same twenty verdicts stop counting the moment the model underneath them changes', () => {
    writeSightings([
      { model: CURRENT, source: 'env', at: '2026-06-01T00:00:00Z' },
      { model: 'claude-x-2', source: 'env', at: '2026-08-01T00:00:00Z' },
    ])
    writeLedger('tech.wire', acrossPlans(BADGE_MIN_N, 17))

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })

    expect(snap.guard.status).toBe('stale-priors')
    expect(snap.guard.freshN).toBe(0)
    const badge = renderBadgeBlock(snap)
    expect(badge).toContain(`recalibrating after model change (n=0/${BADGE_MIN_N})`)
    expect(badge).not.toMatch(/\d+% hits/)
    // the all-time table still remembers them — hidden is not deleted
    expect(snap.calibration.totals).toMatchObject({ n: BADGE_MIN_N })
  })

  it('twenty re-scores of ONE prediction of ONE plan stay one observation — the bar cannot be walked up to', () => {
    writeSightings([{ model: CURRENT, source: 'env', at: '2026-06-01T00:00:00Z' }])
    writeLedger(
      'tech.wire',
      Array.from({ length: BADGE_MIN_N }, (_, i) => ({
        id: 'P1',
        plan: '.planning/phases/demo/demo-01-PLAN.md',
        verdict: 'hit',
        model: CURRENT,
        scoredAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      })),
    )

    const snap = buildSnapshot({ dirs: dirsFor(), chainTipFn: () => 'tip', now: 't' })

    expect(snap.guard.freshN).toBe(1)
    expect(snap.calibration.totals).toMatchObject({ n: 1 })
    const badge = renderBadgeBlock(snap)
    expect(badge).toContain(`collecting calibration data (n=1/${BADGE_MIN_N})`)
    expect(badge).not.toMatch(/\d+% hits/)
  })
})

describe('Test 11 — the rebuilt badge reaches EVERY README, and the passport says what it can count', () => {
  // Until now the rebuild wrote the recalculated badge into ONE readme. The other language
  // carried a badge typed by hand, so the two could drift apart and nothing would say so —
  // and a promise stated in one language and not the other is the oldest way to break the
  // rule that both languages change in the same edit.
  function snapWith(guard: object) {
    return {
      schema: 1,
      capturedAt: 't',
      model: { id: 'claude-x-1', since: null, source: 'env' },
      guard,
      calibration: { domains: [], totals: { hits: 0, misses: 0, n: 0, rate: null }, perModel: [] },
      receipts: { verified: 0, divergent: 0, skippedUnsafe: 0, errors: 0, n: 0 },
      chainTip: 'tip',
      ledger: { lines: 0, corrupt: 0 },
    }
  }

  it('the rebuild writes the block into BOTH readmes, and the two carry the same content', () => {
    writeFileSync(join(workDir, 'README.md'), '# Readme\n\nintro\n')
    writeFileSync(join(workDir, 'README.ru.md'), '# Читайте\n\nвступление\n')

    const content = renderBadgeBlock(snapWith({ status: 'ok', freshN: 42, freshRate: 0.9, requiredN: BADGE_MIN_N }))
    const res = writeBadgeToReadmes({ repoRoot: workDir, content })

    expect(res.written.map((w) => w.file).sort()).toEqual(['README.md', 'README.ru.md'])
    expect(res.skipped).toEqual([])

    const en = readManagedBlock(readFileSync(join(workDir, 'README.md'), 'utf8'))
    const ru = readManagedBlock(readFileSync(join(workDir, 'README.ru.md'), 'utf8'))
    expect(en).toBe(content)
    expect(ru).toBe(en) // one source, two files — they cannot drift apart any more
  })

  it('the block is shaped like the badges it stands among: one line of a centred badge row', () => {
    const shown = renderBadgeBlock(snapWith({ status: 'ok', freshN: 42, freshRate: 0.9, requiredN: BADGE_MIN_N }))
    const hidden = renderBadgeBlock(snapWith({ status: 'no-model-data', freshN: 0, freshRate: null, requiredN: 20 }))
    for (const block of [shown, hidden]) {
      expect(block.split('\n').filter((l) => l.trim())).toHaveLength(1)
      expect(block).toContain('<img src="https://img.shields.io/badge/')
      expect(block).toContain('<a href="PASSPORT.md">')
      expect(block).not.toContain('![') // markdown image syntax would render as literal text inside the html row
    }
  })

  it('a readme that already carries the markers is replaced IN PLACE, never appended to', () => {
    const file = join(workDir, 'README.md')
    writeFileSync(file, '# Readme\n\n<!-- sma:passport:begin -->\nOLD BADGE\n<!-- sma:passport:end -->\n\ntail\n')
    writeBadgeToReadmes({ repoRoot: workDir, content: 'NEW BADGE', files: ['README.md'] })
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('NEW BADGE')
    expect(after).not.toContain('OLD BADGE')
    expect(after).toContain('tail')
    expect(after.match(/sma:passport:begin/g)).toHaveLength(1) // no second badge appeared at the end
  })

  it('a missing second readme never breaks the rebuild — it is NAMED as skipped, not passed over in silence', () => {
    writeFileSync(join(workDir, 'README.md'), '# Readme\n')
    const res = writeBadgeToReadmes({ repoRoot: workDir, content: 'BADGE' })
    expect(res.written.map((w) => w.file)).toEqual(['README.md'])
    expect(res.skipped).toEqual([{ file: 'README.ru.md', reason: 'missing' }])
    // and the absent file is not conjured into existence by the rebuild
    expect(existsSync(join(workDir, 'README.ru.md'))).toBe(false)
  })

  it('the passport states the boundary of its own count in BOTH badge states', () => {
    const shown = renderPassport(snapWith({ status: 'ok', freshN: 42, freshRate: 0.9, requiredN: BADGE_MIN_N }))
    const hidden = renderPassport(snapWith({ status: 'no-model-data', freshN: 0, freshRate: null, requiredN: 20 }))
    for (const text of [shown, hidden]) {
      expect(text).toContain('counts only what this repository can reproduce')
      expect(text).toContain('never copied here')
    }
  })
})

describe('Test 12 — the passport documents are written into the working tree the command ran in', () => {
  // Found by running the rebuild, not by reading it. The shared state root deliberately points
  // at the MAIN checkout so every linked working tree coordinates through one set of claims and
  // sessions — correct for state, wrong for documents: deriving the document root from it made
  // a rebuild launched inside a linked working tree silently edit the main checkout's passport
  // and readmes, and leave its own untouched. State is shared on purpose; documents belong to
  // the tree you are standing in.
  it('a linked working tree gets its OWN documents, never the main checkout files', () => {
    expect(
      resolveWorkingTreeRoot({
        gitToplevelFn: () => 'C:/projects/product-green',
        fallbackRoot: 'C:/projects/product',
      }),
    ).toBe('C:/projects/product-green')
  })

  it('falls back to the shared state root when git cannot answer — never throws, never guesses', () => {
    const boom = () => {
      throw new Error('not a git repository')
    }
    expect(resolveWorkingTreeRoot({ gitToplevelFn: boom, fallbackRoot: 'C:/projects/product' })).toBe(
      'C:/projects/product',
    )
    expect(resolveWorkingTreeRoot({ gitToplevelFn: () => '   ', fallbackRoot: 'C:/projects/product' })).toBe(
      'C:/projects/product',
    )
  })
})
