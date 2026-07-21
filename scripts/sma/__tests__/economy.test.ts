/**
 * Tests for scripts/sma/lib/economy.mjs (9.4-06, BL-176/BL-160 — the economy meters).
 *
 * The six load-bearing behaviors:
 *   Test 1 — estimator: estimateTokens is pure/deterministic; ESTIMATOR_VERSION stamped; empty -> 0
 *   Test 2 — corpus stats: core/notes/indexes over an inline corpus; drafts excluded; missing MEMORY.md -> core:null
 *   Test 3 — lane fold: readLaneRuns folds open/close from lanes.jsonl; corrupt line skip-and-counted; open-without-close stays open
 *   Test 3b — cross-process close pairing: pickOpenRunToClose prefers this terminal's newest open, falls back to the newest overall (crossTerminal:true), lane filter, null when nothing matches
 *   Test 4 — derivation honesty: budget only for >=5 closed CLEAN runs; overlap excluded; <5 -> insufficient; p75 exact; maxLaneClosedRuns
 *   Test 5 — overrun consumption: over-budget CLEAN run consumes appendVerdict + draftLesson once; within/no-budget/overlap consume neither
 *   Test 6 — self-cost: per-surface tokens over a fixture CLAUDE.md + MEMORY.md; MEMORY.md-only repo -> total>0; no surfaces -> 0; not-counted caveat present
 */

import { describe, it, expect } from 'vitest'
import {
  ESTIMATOR_VERSION,
  estimateTokens,
  corpusStats,
  readLaneRuns,
  deriveLaneBudgets,
  maxLaneClosedRuns,
  checkLaneOverrun,
  selfCost,
  pickOpenRunToClose,
} from '../lib/economy.mjs'

// ── Test 1 — the versioned estimator ─────────────────────────────────────────
describe('economy — estimator (Test 1)', () => {
  it('is pure, deterministic, versioned, and 0 on empty', () => {
    expect(typeof ESTIMATOR_VERSION).toBe('string')
    expect(ESTIMATOR_VERSION.length).toBeGreaterThan(0)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens(null as unknown as string)).toBe(0)
    const a = estimateTokens('the quick brown fox')
    const b = estimateTokens('the quick brown fox')
    expect(a).toBe(b)
    expect(a).toBeGreaterThan(0)
    // longer text -> more tokens (monotonic in bytes)
    expect(estimateTokens('x'.repeat(400))).toBeGreaterThan(estimateTokens('x'.repeat(40)))
  })
})

// ── Test 2 — corpus stats ────────────────────────────────────────────────────
describe('economy — corpusStats (Test 2)', () => {
  function fixture(): { corpusDir: string; readFile: (p: string) => string; listFiles: (d: string) => string[] } {
    const files: Record<string, string> = {
      'c/MEMORY.md': '# index\ncore load lines\n',
      'c/reference_heavy.md': 'h'.repeat(800),
      'c/reference_light.md': 'l'.repeat(80),
      'c/INDEX-crm.md': 'crm '.repeat(40),
    }
    return {
      corpusDir: 'c',
      readFile: (p: string) => {
        const key = p.replace(/\\/g, '/')
        if (!(key in files)) throw new Error('ENOENT ' + key)
        return files[key]
      },
      listFiles: () => ['MEMORY.md', 'reference_heavy.md', 'reference_light.md', 'INDEX-crm.md', 'drafts'],
    }
  }

  it('splits core / notes / indexes, sorts heaviest-first, excludes drafts and stamps the version', () => {
    const { corpusDir, readFile, listFiles } = fixture()
    const s = corpusStats({ corpusDir, readFile, listFiles })
    expect(s.estimatorVersion).toBe(ESTIMATOR_VERSION)
    expect(s.core).toBeGreaterThan(0)
    expect(s.notes.map((n) => n.file)).toEqual(['reference_heavy.md', 'reference_light.md'])
    expect(s.indexes.map((n) => n.file)).toEqual(['INDEX-crm.md'])
    // drafts/ (a subdir entry, no .md) never appears as a note
    expect(s.notes.some((n) => n.file === 'drafts')).toBe(false)
    expect(s.totals.all).toBe((s.core || 0) + s.totals.notes + s.totals.indexes)
    // deterministic
    expect(JSON.stringify(corpusStats({ corpusDir, readFile, listFiles }))).toBe(JSON.stringify(s))
  })

  it('a missing MEMORY.md yields an honest core:null, never a throw', () => {
    const s = corpusStats({
      corpusDir: 'c',
      readFile: (p: string) => {
        if (p.endsWith('MEMORY.md')) throw new Error('ENOENT')
        return 'x'.repeat(40)
      },
      listFiles: () => ['reference_a.md'],
    })
    expect(s.core).toBeNull()
    expect(s.notes.length).toBe(1)
  })
})

// ── Test 3 — lane fold from lanes.jsonl ──────────────────────────────────────
describe('economy — readLaneRuns (Test 3)', () => {
  it('folds open/close into runs, skip-and-counts a corrupt line, keeps an unclosed open', () => {
    const lines = [
      JSON.stringify({ type: 'open', lane: 'fix', terminalId: 'A', ts: '2026-07-13T10:00:00.000Z' }),
      '{ this is not json',
      JSON.stringify({ type: 'close', terminalId: 'A', ts: '2026-07-13T10:05:00.000Z', usd: 0.3, minutes: 5, sessionsInWindow: 1, overlap: false }),
      JSON.stringify({ type: 'open', lane: 'build', terminalId: 'B', ts: '2026-07-13T11:00:00.000Z' }),
    ].join('\n')
    const { runs, corrupt } = readLaneRuns({ spendDir: 's', readFile: () => lines })
    expect(corrupt).toBe(1)
    const closed = runs.filter((r) => !r.open)
    const open = runs.filter((r) => r.open)
    expect(closed.length).toBe(1)
    expect(closed[0].lane).toBe('fix')
    expect(closed[0].usd).toBe(0.3)
    expect(closed[0].minutes).toBe(5)
    expect(open.length).toBe(1)
    expect(open[0].lane).toBe('build')
  })

  it('a missing lanes.jsonl yields an empty result, never a throw', () => {
    const { runs, corrupt } = readLaneRuns({
      spendDir: 's',
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(runs).toEqual([])
    expect(corrupt).toBe(0)
  })
})

// ── Test 3b — pickOpenRunToClose (cross-process close, the 2026-07-21 fix) ───
// Every CLI invocation is its OWN process on agent-driven terminals, so open and
// close almost never share a terminalId — strict same-terminal matching left the
// ledger with 0 closed runs ever. The picker prefers the same terminal, then
// falls back to the newest open run overall (optionally lane-filtered), reporting
// crossTerminal honestly.
describe('economy — pickOpenRunToClose (Test 3b)', () => {
  const opens = [
    { lane: 'fix', terminalId: 'A', openedAt: '2026-07-21T08:00:00.000Z', open: true },
    { lane: 'quick', terminalId: 'B', openedAt: '2026-07-21T09:00:00.000Z', open: true },
    { lane: 'build', terminalId: 'C', openedAt: '2026-07-21T10:00:00.000Z', open: true },
    { lane: 'fix', terminalId: 'D', openedAt: '2026-07-21T07:00:00.000Z', open: false },
  ]

  it('prefers the newest open run of the SAME terminal (crossTerminal false)', () => {
    const res = pickOpenRunToClose(opens, { terminalId: 'B' })
    expect(res).not.toBeNull()
    expect(res!.run.terminalId).toBe('B')
    expect(res!.crossTerminal).toBe(false)
  })

  it('falls back to the newest open run overall when this terminal has none', () => {
    const res = pickOpenRunToClose(opens, { terminalId: 'Z' })
    expect(res).not.toBeNull()
    expect(res!.run.terminalId).toBe('C') // newest by openedAt
    expect(res!.run.lane).toBe('build')
    expect(res!.crossTerminal).toBe(true)
  })

  it('lane filter narrows both the same-terminal and the fallback pick', () => {
    const res = pickOpenRunToClose(opens, { terminalId: 'Z', lane: 'quick' })
    expect(res).not.toBeNull()
    expect(res!.run.terminalId).toBe('B')
    expect(res!.crossTerminal).toBe(true)
    const own = pickOpenRunToClose(opens, { terminalId: 'A', lane: 'fix' })
    expect(own!.run.terminalId).toBe('A')
    expect(own!.crossTerminal).toBe(false)
  })

  it('returns null when nothing is open (or nothing matches the lane)', () => {
    expect(pickOpenRunToClose([], { terminalId: 'A' })).toBeNull()
    expect(pickOpenRunToClose(opens, { terminalId: 'Z', lane: 'nope' })).toBeNull()
    const onlyClosed = opens.filter((r) => !r.open)
    expect(pickOpenRunToClose(onlyClosed, { terminalId: 'D' })).toBeNull()
  })
})

// ── Test 4 — derivation honesty ──────────────────────────────────────────────
describe('economy — deriveLaneBudgets (Test 4)', () => {
  function closedRuns(lane: string, usds: number[], overlap = false) {
    return usds.map((usd) => ({ lane, open: false, overlap, usd, minutes: 1 }))
  }

  it('derives p75 only for >=5 closed CLEAN runs; overlap excluded; <5 -> insufficient', () => {
    const runs = [
      ...closedRuns('fix', [10, 20, 30, 40, 50]),
      ...closedRuns('fix', [999], true), // overlap-flagged — excluded from n and the percentile
      ...closedRuns('quick', [11, 22, 33, 44]), // only 4 clean -> insufficient
    ]
    const budgets = deriveLaneBudgets({ runs, pct: 75, minRuns: 5 })
    expect(budgets.fix.insufficient).toBeUndefined()
    expect(budgets.fix.n).toBe(5) // overlap run did NOT inflate n
    expect(budgets.fix.usd).toBe(40) // p75 nearest-rank of [10,20,30,40,50]
    expect(budgets.fix.pct).toBe(75)
    expect(budgets.quick.insufficient).toBe(true)
    expect(budgets.quick.n).toBe(4)
    expect(maxLaneClosedRuns(runs)).toBe(5)
  })
})

// ── Test 5 — overrun consumption ─────────────────────────────────────────────
describe('economy — checkLaneOverrun (Test 5)', () => {
  const budgets = { fix: { n: 5, pct: 75, usd: 40, minutes: 1 } }
  function spies() {
    const appended: unknown[] = []
    const drafted: unknown[] = []
    return {
      appended,
      drafted,
      appendVerdict: (rec: unknown) => appended.push(rec),
      draftLesson: (args: unknown) => {
        drafted.push(args)
        return { drafted: true, path: '.claude/memory/drafts/bug-lesson-lane.md' }
      },
    }
  }

  it('an over-budget CLEAN run consumes appendVerdict + draftLesson exactly once with a scorePlan-miss record', () => {
    const s = spies()
    const res = checkLaneOverrun({
      run: { lane: 'fix', open: false, overlap: false, usd: 100, closedAt: '2026-07-13T10:05:00.000Z' },
      budgets,
      appendVerdict: s.appendVerdict,
      draftLesson: s.draftLesson,
    })
    expect(res.miss).toBe(true)
    expect(s.appended.length).toBe(1)
    expect(s.drafted.length).toBe(1)
    const v = s.appended[0] as Record<string, unknown>
    expect(v.verdict).toBe('miss')
    expect(v.domain).toBe('sma.economy')
    expect(v.metric).toBe('lane_budget_overrun')
    expect(v.comparator).toBe('<=')
    expect(v.expected).toBe(40)
    expect(v.actual).toBe(100)
    // the drafter is called with {verdict, planId}
    expect((s.drafted[0] as Record<string, unknown>).planId).toBeTruthy()
  })

  it('within budget / no derived budget / overlap all consume neither (report-only)', () => {
    const within = spies()
    expect(
      checkLaneOverrun({ run: { lane: 'fix', open: false, overlap: false, usd: 10 }, budgets, ...within }).within,
    ).toBe(true)
    expect(within.appended.length).toBe(0)
    expect(within.drafted.length).toBe(0)

    const nobudget = spies()
    const r2 = checkLaneOverrun({ run: { lane: 'quick', open: false, overlap: false, usd: 999 }, budgets, ...nobudget })
    expect(r2.reportOnly).toBe(true)
    expect(r2.reason).toBe('no-budget')
    expect(nobudget.appended.length).toBe(0)

    const ov = spies()
    const r3 = checkLaneOverrun({ run: { lane: 'fix', open: false, overlap: true, usd: 999 }, budgets, ...ov })
    expect(r3.reportOnly).toBe(true)
    expect(r3.reason).toBe('overlap')
    expect(ov.appended.length).toBe(0)
    expect(ov.drafted.length).toBe(0)
  })
})

// ── Test 6 — self-cost meter ─────────────────────────────────────────────────
describe('economy — selfCost (Test 6)', () => {
  const claudeWithBlocks =
    'intro line\n' +
    '<!-- SMA:RULES:BEGIN v1 -->\nrule one\nrule two\n<!-- SMA:RULES:END -->\n' +
    'middle user bytes\n' +
    '<!-- SMA:EXPORT:BEGIN v1 fmt=md commit=abc -->\nnote line\n<!-- SMA:EXPORT:END -->\n' +
    'tail\n'

  it('measures each present surface + total, and carries the not-counted caveat', () => {
    const files: Record<string, string> = { 'CLAUDE.md': claudeWithBlocks, 'MEMORY.md': 'm'.repeat(200) }
    const s = selfCost({ readFile: (p: string) => files[p], paths: { claudeMd: 'CLAUDE.md', memoryMd: 'MEMORY.md' } })
    const surfaces = s.surfaces.map((x) => x.surface)
    expect(surfaces).toContain('SMA:RULES block')
    expect(surfaces).toContain('emitted corpus block')
    expect(surfaces).toContain('MEMORY.md core load')
    expect(s.total).toBeGreaterThan(0)
    expect(s.estimatorVersion).toBe(ESTIMATOR_VERSION)
    expect(s.notCounted).toMatch(/per-turn hook stdout/i)
  })

  it('the dogfood shape — a MEMORY.md but NO managed blocks — returns the MEMORY surface alone with total>0 (P9.4-06-C)', () => {
    const files: Record<string, string> = { 'CLAUDE.md': 'plain project rules, no SMA blocks\n', 'MEMORY.md': 'm'.repeat(200) }
    const s = selfCost({ readFile: (p: string) => files[p], paths: { claudeMd: 'CLAUDE.md', memoryMd: 'MEMORY.md' } })
    expect(s.surfaces.length).toBe(1)
    expect(s.surfaces[0].surface).toBe('MEMORY.md core load')
    expect(s.total).toBeGreaterThan(0)
  })

  it('none of the three surfaces present -> 0 surfaces, honestly', () => {
    const s = selfCost({
      readFile: () => {
        throw new Error('ENOENT')
      },
      paths: { claudeMd: 'CLAUDE.md', memoryMd: 'MEMORY.md' },
    })
    expect(s.surfaces.length).toBe(0)
    expect(s.total).toBe(0)
  })
})
