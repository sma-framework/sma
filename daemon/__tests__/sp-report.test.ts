/**
 * Tests for daemon/src/sp-report.mjs — SP-калибровка «оценил ↔ факт»
 * (Phase 9.5 Plan 07, Task 4; D-9.5-11 item 2, D-9.5-10 prohibition).
 *
 * Deterministic, zero-LLM: completed tasks grouped by storyPoints; medians of cycle time
 * (enqueuedAt→completedAt) and work time (claimedAt→completedAt), € and diff size; the
 * 3×-median outlier cut; a skip counter for rows missing a timestamp (never a crash). The
 * rendered report's first content line after the title MUST be the D-9.5-10 prohibition
 * verbatim (structurally mandatory — this is what makes it incapable of becoming an hours
 * converter or a worker KPI).
 */

import { describe, it, expect } from 'vitest'

import { buildSpReport, renderSpReport } from '../src/sp-report.mjs'

const NOW = 1_700_000_000_000
const H = 3600000 // one hour in ms

// A fixture task set: three sp:3 completed tasks (one a cycle-time outlier), one no-SP
// roster task, one FAILED task (no completedAt → skipped), and one completed task missing
// claimedAt (→ skipped). All within the 30-day window.
const ROWS = [
  { id: 'T1', title: 'быстрая', storyPoints: 3, status: 'completed', enqueuedAt: NOW - 10 * H, claimedAt: NOW - 9 * H, completedAt: NOW - 8 * H, diffStat: '+10 -2' },
  { id: 'T2', title: 'средняя', storyPoints: 3, status: 'completed', enqueuedAt: NOW - 20 * H, claimedAt: NOW - 19 * H, completedAt: NOW - 14 * H, diffStat: '+4 -0' },
  { id: 'T3', title: 'застряла', storyPoints: 3, status: 'completed', enqueuedAt: NOW - 110 * H, claimedAt: NOW - 12 * H, completedAt: NOW - 10 * H, diffStat: '+100 -0' },
  { id: 'R1', title: 'ростер', status: 'completed', enqueuedAt: NOW - 5 * H, claimedAt: NOW - 4 * H, completedAt: NOW - 3 * H, diffStat: '+2 -0' },
  { id: 'F1', title: 'провал', storyPoints: 2, status: 'failed', enqueuedAt: NOW - 6 * H, claimedAt: NOW - 5 * H, completedAt: null },
  { id: 'M1', title: 'без claim', storyPoints: 5, status: 'completed', enqueuedAt: NOW - 7 * H, claimedAt: null, completedAt: NOW - 2 * H },
]

const EUR: Record<string, number> = { T1: 5, T2: 7, T3: 3, R1: 2 }

function makeDeps() {
  const adapter = { async list() { return ROWS.map((r) => ({ ...r })) } }
  const ledger = { readAttempts: () => [] }
  const usageReader = (id: string) => EUR[id] ?? 0
  return { adapter, ledger, usageReader, clock: () => NOW, windowDays: 30 }
}

describe('buildSpReport — deterministic zero-LLM calibration data', () => {
  it('groups completed tasks by storyPoints with cycle/work medians', async () => {
    const data = await buildSpReport(makeDeps())
    const sp3 = data.buckets.find((b: any) => b.storyPoints === 3)
    expect(sp3.count).toBe(3)
    // cycle times: T1=2h, T2=6h, T3=100h → median 6h
    expect(sp3.medianCycleMs).toBe(6 * H)
    // work times: T1=1h, T2=5h, T3=2h → median 2h
    expect(sp3.medianWorkMs).toBe(2 * H)
  })

  it('has a no-SP bucket for roster/return tasks', async () => {
    const data = await buildSpReport(makeDeps())
    const none = data.buckets.find((b: any) => b.storyPoints === 'none')
    expect(none.count).toBe(1) // R1 only
  })

  it('sums and medians € and diff size per bucket', async () => {
    const data = await buildSpReport(makeDeps())
    const sp3 = data.buckets.find((b: any) => b.storyPoints === 3)
    expect(sp3.totalEur).toBe(15) // 5 + 7 + 3
    expect(sp3.medianEur).toBe(5) // median of [3,5,7]
    expect(sp3.medianDiff).toBe(12) // median of [4,12,100]
  })

  it('counts rows missing a timestamp in a skip note — never crashes', async () => {
    const data = await buildSpReport(makeDeps())
    // F1 (no completedAt) + M1 (no claimedAt) → 2 skipped
    expect(data.skipped).toBe(2)
  })

  it('flags cycle-time outliers beyond 3× the bucket median', async () => {
    const data = await buildSpReport(makeDeps())
    const ids = data.outliers.map((o: any) => o.id)
    expect(ids).toContain('T3') // 100h > 3 × 6h = 18h
    expect(ids).not.toContain('T1')
    expect(ids).not.toContain('T2')
  })

  it('does not throw on an empty task set', async () => {
    const data = await buildSpReport({ adapter: { async list() { return [] } }, usageReader: () => 0, clock: () => NOW })
    expect(data.buckets).toEqual([])
    expect(data.skipped).toBe(0)
    expect(data.outliers).toEqual([])
  })
})

describe('renderSpReport — the mandatory D-9.5-10 prohibition header', () => {
  it('prints «SP не переводятся в часы и не используются как KPI» as the first content line', async () => {
    const data = await buildSpReport(makeDeps())
    const text = renderSpReport(data)
    expect(text).toContain('SP не переводятся в часы и не используются как KPI')
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    // line 0 = title; line 1 = the prohibition (structurally mandatory)
    expect(lines[1]).toContain('SP не переводятся в часы и не используются как KPI')
  })

  it('renders each non-empty bucket and the outliers section', async () => {
    const text = renderSpReport(await buildSpReport(makeDeps()))
    expect(text).toMatch(/SP=3/)
    expect(text).toMatch(/T3/) // the outlier is listed
  })
})
