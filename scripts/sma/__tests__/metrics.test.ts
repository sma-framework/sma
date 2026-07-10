/**
 * Tests for scripts/sma/lib/metrics.mjs (Phase 49.1 Plan 24, Task 1 — D-49.1-07, B23).
 *
 * Read-only process telemetry over INJECTED sources (git log + exec journals +
 * gate/collision/stall journals). No writes, no network. The four behaviours the
 * plan pins:
 *   - Test 1: leadTime over a fixture exec journal (plan_start..plan_complete)
 *     returns per-plan durations.
 *   - Test 2: reworkRate — commits touching a plan's files AFTER its plan_complete
 *     event count as rework; 2 rework over 10 commits returns 0.2.
 *   - Test 3: deviationCounts sums gate fires + stall detections + collision warns
 *     from fixture journals, grouped by kind.
 *   - Test 4: every metric returns an honest null/empty marker when its source is
 *     absent (no invented zeros presented as measurements).
 */

import { describe, it, expect } from 'vitest'

import { leadTime, reworkRate, deviationCounts, parseGitLog } from '../lib/metrics.mjs'

describe('leadTime — per-plan duration from the exec journal', () => {
  it('computes plan_start..plan_complete duration per plan', () => {
    const journals = [
      {
        id: '49.1-01',
        events: [
          { event: 'plan_start', ts: '2026-07-01T10:00:00Z' },
          { event: 'task_complete', task: 1, ts: '2026-07-01T10:30:00Z' },
          { event: 'plan_complete', ts: '2026-07-01T12:00:00Z' },
        ],
      },
    ]
    const res = leadTime(journals)
    expect(res.available).toBe(true)
    expect(res.plans).toHaveLength(1)
    expect(res.plans[0].id).toBe('49.1-01')
    expect(res.plans[0].ms).toBe(2 * 3600 * 1000)
  })

  it('falls back to the earliest task_start when no plan_start event is present', () => {
    const journals = [
      {
        id: 'p2',
        events: [
          { event: 'task_start', task: 1, ts: '2026-07-01T09:00:00Z' },
          { event: 'task_complete', task: 1, ts: '2026-07-01T09:30:00Z' },
          { event: 'plan_complete', ts: '2026-07-01T10:00:00Z' },
        ],
      },
    ]
    const res = leadTime(journals)
    expect(res.plans[0].ms).toBe(3600 * 1000)
  })

  it('marks a plan with no plan_complete as incomplete (ms null, honest)', () => {
    const journals = [
      { id: 'p3', events: [{ event: 'plan_start', ts: '2026-07-01T10:00:00Z' }] },
    ]
    const res = leadTime(journals)
    expect(res.available).toBe(true)
    expect(res.plans[0].ms).toBeNull()
    expect(res.plans[0].incomplete).toBe(true)
  })

  it('accepts a { journals } wrapper as well as a bare array', () => {
    const journals = [
      {
        id: 'p4',
        events: [
          { event: 'plan_start', ts: '2026-07-01T10:00:00Z' },
          { event: 'plan_complete', ts: '2026-07-01T11:00:00Z' },
        ],
      },
    ]
    expect(leadTime({ journals }).plans[0].ms).toBe(3600 * 1000)
  })
})

describe('reworkRate — commits after plan_complete touching plan files', () => {
  it('returns 0.2 for 2 rework commits over 10 total', () => {
    const plans = [{ id: 'p1', files: ['a.ts'], completeTs: '2026-07-01T12:00:00Z' }]
    const commits = []
    // 8 commits BEFORE plan_complete (touch a.ts, but not rework — they built it).
    for (let i = 0; i < 8; i++) {
      commits.push({ sha: `pre${i}`, ts: '2026-07-01T11:00:00Z', files: ['a.ts'] })
    }
    // 2 commits AFTER plan_complete touching the plan's files -> rework.
    commits.push({ sha: 'rw1', ts: '2026-07-02T09:00:00Z', files: ['a.ts'] })
    commits.push({ sha: 'rw2', ts: '2026-07-02T10:00:00Z', files: ['a.ts', 'b.ts'] })

    const res = reworkRate({ commits, plans })
    expect(res.available).toBe(true)
    expect(res.rate).toBeCloseTo(0.2)
    expect(res.rework).toBe(2)
    expect(res.total).toBe(10)
  })

  it('does not count a post-complete commit that touches unrelated files', () => {
    const plans = [{ id: 'p1', files: ['a.ts'], completeTs: '2026-07-01T12:00:00Z' }]
    const commits = [
      { sha: 'x1', ts: '2026-07-02T09:00:00Z', files: ['unrelated.ts'] },
      { sha: 'x2', ts: '2026-07-02T10:00:00Z', files: ['a.ts'] }, // rework
    ]
    const res = reworkRate({ commits, plans })
    expect(res.rework).toBe(1)
    expect(res.rate).toBeCloseTo(0.5)
  })
})

describe('deviationCounts — grouped by kind', () => {
  it('sums gate fires + stall detections + collision warns grouped by kind', () => {
    const events = [
      { type: 'gate' },
      { type: 'gate' },
      { type: 'collision' },
      { type: 'stall' },
      { type: 'stall' },
      { type: 'stall' },
    ]
    const res = deviationCounts(events)
    expect(res.available).toBe(true)
    expect(res.byKind.gate).toBe(2)
    expect(res.byKind.collision).toBe(1)
    expect(res.byKind.stall).toBe(3)
    expect(res.total).toBe(6)
  })

  it('accepts a { events } wrapper', () => {
    const res = deviationCounts({ events: [{ type: 'reflex' }] })
    expect(res.byKind.reflex).toBe(1)
    expect(res.total).toBe(1)
  })
})

describe('absent-source honesty (test 4)', () => {
  it('leadTime with no journals -> available:false, empty plans', () => {
    const res = leadTime([])
    expect(res.available).toBe(false)
    expect(res.plans).toEqual([])
  })

  it('reworkRate with no commits -> available:false, rate null (not a fake 0)', () => {
    const res = reworkRate({ commits: [], plans: [] })
    expect(res.available).toBe(false)
    expect(res.rate).toBeNull()
  })

  it('deviationCounts with no events -> available:false, total 0, empty byKind', () => {
    const res = deviationCounts([])
    expect(res.available).toBe(false)
    expect(res.total).toBe(0)
    expect(res.byKind).toEqual({})
  })
})

describe('parseGitLog — read-only commit parsing', () => {
  it('parses %H|%cI header lines + following name-only file lists', () => {
    const raw = [
      'abc1234|2026-07-02T10:00:00Z',
      'scripts/sma/lib/metrics.mjs',
      'scripts/sma/cli.mjs',
      '',
      'def5678|2026-07-01T09:00:00Z',
      'README.md',
      '',
    ].join('\n')
    const commits = parseGitLog(raw)
    expect(commits).toHaveLength(2)
    expect(commits[0].sha).toBe('abc1234')
    expect(commits[0].ts).toBe('2026-07-02T10:00:00Z')
    expect(commits[0].files).toEqual(['scripts/sma/lib/metrics.mjs', 'scripts/sma/cli.mjs'])
    expect(commits[1].files).toEqual(['README.md'])
  })

  it('returns an empty array for empty/garbage input (fail-open)', () => {
    expect(parseGitLog('')).toEqual([])
    expect(parseGitLog(null)).toEqual([])
  })
})
