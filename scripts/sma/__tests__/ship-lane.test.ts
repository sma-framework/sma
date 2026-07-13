/**
 * Tests for scripts/sma/lib/ship-lane.mjs (49.4-08, BL-177 — the ship lanes).
 *
 * The five load-bearing behaviors of the quick-ship substrate:
 *   Test 1 — delta count leg: a 6-commit origin-delta refuses «this is a full /sma-ship»
 *            naming the delta leg; a 3-commit delta passes that leg.
 *   Test 2 — migration leg: a migrations-glob-matching path in the diff refuses naming the
 *            migration leg; the same delta without migration paths passes.
 *   Test 3 — push-claim leg: a live FOREIGN claim refuses naming the holder; own/absent
 *            passes; ALL failing legs are reported together, not just the first.
 *   Test 4 — changelog determinism: draftChangelog groups by conventional prefix preserving
 *            in-group order; identical output on identical input; a scope prefix keeps scope.
 *   Test 5 — records + stats: fold tolerantly; a pending run finalized by a same-startedAt
 *            record (last-wins); report lists pending first + flags >24h orphaned; stats
 *            sentinels (9999 quick-active < 3 runs; 0 red-diff no quick runs; quickRedPct
 *            alone when quick has runs but full has none); corrupt line skip-and-counted.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkQuickPrecondition,
  draftChangelog,
  appendShipLaneRun,
  readShipLaneRuns,
  laneStats,
  laneReport,
  shipLaneSelftest,
} from '../lib/ship-lane.mjs'

/** A fake execGit that answers `log` and `diff` from canned strings. */
function fakeGit({ log = '', diff = '' } = {}) {
  return (args) => {
    if (args[0] === 'log') return log
    if (args[0] === 'diff') return diff
    return ''
  }
}

const logOf = (n) => Array.from({ length: n }, (_, i) => `abc${i} subject ${i}`).join('\n') + '\n'

// ── Test 1 — the delta-count leg ──────────────────────────────────────────────
describe('ship-lane — delta count leg (Test 1)', () => {
  it('refuses a 6-commit delta and passes a 3-commit delta', () => {
    const over = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(6), diff: 'src/app/page.tsx\n' }),
      checkPushClaim: () => ({ live: false }),
      maxDelta: 5,
    })
    expect(over.allowed).toBe(false)
    expect(over.delta).toBe(6)
    expect(over.reasons.join(' ')).toContain('this is a full /sma-ship')
    expect(over.reasons.join(' ').toLowerCase()).toContain('delta')

    const ok = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(3), diff: 'src/app/page.tsx\n' }),
      checkPushClaim: () => ({ live: false }),
      maxDelta: 5,
    })
    expect(ok.allowed).toBe(true)
    expect(ok.delta).toBe(3)
    expect(ok.reasons).toEqual([])
  })
})

// ── Test 2 — the migration leg ────────────────────────────────────────────────
describe('ship-lane — migration leg (Test 2)', () => {
  it('refuses a migration path in the delta and passes without one', () => {
    const withMig = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(2), diff: 'src/app/page.tsx\nsrc/migrations/078_x.ts\n' }),
      checkPushClaim: () => ({ live: false }),
      maxDelta: 5,
    })
    expect(withMig.allowed).toBe(false)
    expect(withMig.migrations).toContain('src/migrations/078_x.ts')
    expect(withMig.reasons.join(' ').toLowerCase()).toContain('migration')

    const without = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(2), diff: 'src/app/page.tsx\nsrc/lib/util.ts\n' }),
      checkPushClaim: () => ({ live: false }),
      maxDelta: 5,
    })
    expect(without.allowed).toBe(true)
    expect(without.migrations).toEqual([])
  })

  it('matches a top-level migrations dir and a nested one via the default globs', () => {
    const nested = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(1), diff: 'packages/db/migrations/0001_init.sql\n' }),
      checkPushClaim: () => ({ live: false }),
    })
    expect(nested.allowed).toBe(false)
    expect(nested.migrations.length).toBe(1)
  })
})

// ── Test 3 — the push-claim leg + all-legs-reported ───────────────────────────
describe('ship-lane — push-claim leg (Test 3)', () => {
  it('refuses a live foreign claim naming the holder; own/absent passes', () => {
    const foreign = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(2), diff: 'src/app/page.tsx\n' }),
      checkPushClaim: () => ({ live: true, who: 'terminal-B' }),
      self: 'terminal-A',
    })
    expect(foreign.allowed).toBe(false)
    expect(foreign.reasons.join(' ')).toContain('terminal-B')

    const own = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(2), diff: 'src/app/page.tsx\n' }),
      checkPushClaim: () => ({ live: true, who: 'terminal-A' }),
      self: 'terminal-A',
    })
    expect(own.allowed).toBe(true)

    const absent = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(2), diff: 'src/app/page.tsx\n' }),
      checkPushClaim: () => ({ live: false }),
    })
    expect(absent.allowed).toBe(true)
  })

  it('reports EVERY failing leg together, not just the first', () => {
    const allBad = checkQuickPrecondition({
      execGit: fakeGit({ log: logOf(9), diff: 'src/migrations/079_y.ts\n' }),
      checkPushClaim: () => ({ live: true, who: 'terminal-Z' }),
      self: 'terminal-A',
      maxDelta: 5,
    })
    expect(allBad.allowed).toBe(false)
    const blob = allBad.reasons.join(' ').toLowerCase()
    expect(blob).toContain('delta')
    expect(blob).toContain('migration')
    expect(blob).toContain('terminal-z')
  })
})

// ── Test 4 — changelog determinism ────────────────────────────────────────────
describe('ship-lane — changelog drafter (Test 4)', () => {
  it('groups by conventional prefix, preserves in-group order, is deterministic', () => {
    const commits = [
      { sha: 'a1', subject: 'feat(economy): meters' },
      { sha: 'a2', subject: 'fix: null guard' },
      { sha: 'a3', subject: 'feat: ship lanes' },
      { sha: 'a4', subject: 'docs: readme row' },
      { sha: 'a5', subject: 'random unstructured line' },
    ]
    const d1 = draftChangelog({ commits })
    const d2 = draftChangelog({ commits })
    expect(d1).toBe(d2) // byte-identical on identical input

    // feat group carries both feat lines, first-seen order preserved
    const featIdx1 = d1.indexOf('meters')
    const featIdx2 = d1.indexOf('ship lanes')
    expect(featIdx1).toBeGreaterThan(-1)
    expect(featIdx2).toBeGreaterThan(featIdx1)
    // the scope survives
    expect(d1).toContain('economy')
    // the unstructured line lands under "other"
    expect(d1.toLowerCase()).toContain('other')
    expect(d1).toContain('random unstructured line')
  })
})

// ── Test 5 — records, fold, report, stats ─────────────────────────────────────
describe('ship-lane — records + stats (Test 5)', () => {
  it('folds pending->final last-wins, flags orphans, computes sentinel stats', () => {
    const root = mkdtempSync(join(tmpdir(), 'sma-shiplane-'))
    try {
      const spendDir = join(root, 'spend')
      // A pending quick run at push time, finalized later by a same-startedAt green.
      appendShipLaneRun({ spendDir, run: { lane: 'quick', startedAt: '2026-07-13T10:00:00.000Z', outcome: 'pending' } })
      appendShipLaneRun({
        spendDir,
        run: { lane: 'quick', startedAt: '2026-07-13T10:00:00.000Z', endedAt: '2026-07-13T10:06:00.000Z', outcome: 'green' },
      })
      // A stale pending (never finalized) — must be listed + orphan-flagged.
      appendShipLaneRun({ spendDir, run: { lane: 'quick', startedAt: '2026-07-01T10:00:00.000Z', outcome: 'pending' } })
      // a corrupt line
      writeFileSync(join(spendDir, 'ship-lanes.jsonl'), '{not json\n', { flag: 'a' })

      const { runs, corrupt } = readShipLaneRuns({ spendDir })
      expect(corrupt).toBe(1)
      // last-wins fold: the 10:00 run is green, not pending
      const folded = runs.find((r) => r.startedAt === '2026-07-13T10:00:00.000Z')
      expect(folded.outcome).toBe('green')

      const now = Date.parse('2026-07-13T12:00:00.000Z')
      const report = laneReport({ runs, now })
      // pending listed first
      expect(report.pending.length).toBe(1)
      expect(report.pending[0].startedAt).toBe('2026-07-01T10:00:00.000Z')
      expect(report.orphaned.length).toBe(1) // >24h old pending

      // Only 1 finalized (green) quick run -> < 3 -> 9999 sentinel
      const s = laneStats({ runs, now })
      expect(s.quickActiveP50Min).toBe(9999)
      // quick has runs, full has none -> red-diff = quickRedPct alone (0 red so far)
      expect(s.quickRedMinusFullRedPct).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('computes p50 active minutes over >= 3 quick runs and a first-quick-red guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'sma-shiplane-'))
    try {
      const spendDir = join(root, 'spend')
      const mk = (start, mins, outcome, lane = 'quick') =>
        appendShipLaneRun({
          spendDir,
          run: {
            lane,
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(start + mins * 60000).toISOString(),
            outcome,
          },
        })
      const base = Date.parse('2026-07-13T08:00:00.000Z')
      mk(base, 6, 'green')
      mk(base + 3600000, 8, 'green')
      mk(base + 7200000, 10, 'red')
      const { runs } = readShipLaneRuns({ spendDir })
      const s = laneStats({ runs, now: base + 100000000 })
      expect(s.quickActiveP50Min).toBe(8) // p50 of [6,8,10]
      // one quick red of three, no full baseline -> quickRedPct alone = 33.33
      expect(s.quickRedMinusFullRedPct).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

// ── the self-proving selftest ─────────────────────────────────────────────────
describe('ship-lane — selftest', () => {
  it('the canned-git fixture pack returns 1', () => {
    expect(shipLaneSelftest()).toBe(1)
  })
})
