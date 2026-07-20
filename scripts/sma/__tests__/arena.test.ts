/**
 * Tests for scripts/sma/lib/arena.mjs (Phase 9.3 Plan 11, D-9.3-18, BL-142).
 *
 * The comparative benchmark arena scorer: harden the n=1 pilot into a reproducible
 * n>=4 four-arm comparison (vanilla / GSD / Superpowers / SMA), scored FULLY
 * DETERMINISTICALLY. The two integrity proofs the phase exists for:
 *   - Test 3: a negative result is STRUCTURALLY un-droppable (the arm where SMA is
 *     most expensive still renders, `suppressed` is empty by construction).
 *   - Test 2: the headline is cost-per-RESULT (done-right-first-time), NEVER
 *     cost-per-task — raw cost is a carried column, never the sort key.
 *
 * Everything is DI: raw per-arm records + an injected spend-adapter version set, so
 * no test touches a real log, spawns a process, or spends a token. arena.mjs imports
 * no LLM/network/child_process on the score path (D-9.3-02: the 9.2-09 spend-adapter
 * is the SOLE cost source; the arena CONSUMES version-tagged totals, never re-parses).
 *
 * Test 1 — per-arm score determinism (two calls deep-equal)
 * Test 2 — cost-per-result is the headline (rank by M1+M2, cost carried not sorted)
 * Test 3 — negative result preserved (highest-cost SMA row survives; suppressed empty)
 * Test 4 — spend-adapter is the cost source (version-tagged; unknown version flagged)
 * Test 5 — safety tier is a SEPARATE axis from capability metrics
 * Test 6 — insufficient-n honesty (n<4 → underpowered/provisional, never settled)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  scoreArm,
  aggregateArena,
  rankByCostPerResult,
  renderArenaReport,
  ARENA_METRICS,
} from '../lib/arena.mjs'
import { ADAPTER_VERSIONS } from '../lib/spend-adapter.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, '..', 'fixtures', 'arena', 'sample-results.json'), 'utf8'),
)
const KNOWN_VERSIONS = ADAPTER_VERSIONS.map((a) => a.version)
const armByName = (name: string) => FIXTURE.arms.find((a: any) => a.arm === name)

describe('arena.mjs — deterministic four-arm benchmark scorer (9.3-11)', () => {
  it('Test 1: scoreArm is deterministic — two calls on identical input are deep-equal', () => {
    const rec = armByName('vanilla')
    const a = scoreArm(rec, { adapterVersions: KNOWN_VERSIONS })
    const b = scoreArm(rec, { adapterVersions: KNOWN_VERSIONS })
    expect(a).toEqual(b)
    // shape sanity — the frozen scored contract
    expect(a.arm).toBe('vanilla')
    expect(a.n).toBe(4)
    expect(typeof a.m1FirstDoneRate).toBe('number')
    expect(typeof a.m2MeanRounds).toBe('number')
    expect(typeof a.m3MeanCost).toBe('number')
    expect('m3MeanCostPerResult' in a).toBe(true)
    expect('safetyFlags' in a).toBe(true)
  })

  it('Test 2: cost-per-result is the headline — rank by M1+M2, raw cost never the sort key', () => {
    const scored = FIXTURE.arms
      .filter((r: any) => r.arm !== 'sma-solo-recon')
      .map((r: any) => scoreArm(r, { adapterVersions: KNOWN_VERSIONS }))
    const ranked = rankByCostPerResult(scored)

    // SMA has the HIGHEST raw M3 cost of all arms...
    const smaScore = scored.find((s: any) => s.arm === 'sma')
    const maxCost = Math.max(...scored.map((s: any) => s.m3MeanCost))
    expect(smaScore.m3MeanCost).toBe(maxCost)
    // ...yet it ranks FIRST because it is done-right-first-time (rate 1.0, 0 rounds).
    expect(ranked[0].arm).toBe('sma')
    expect(smaScore.m1FirstDoneRate).toBe(1)
    expect(smaScore.m2MeanRounds).toBe(0)

    // Ranking must NOT be cost ascending (that would sort SMA to the BOTTOM).
    const costAsc = [...scored].sort((a: any, b: any) => a.m3MeanCost - b.m3MeanCost).map((s: any) => s.arm)
    expect(ranked.map((s: any) => s.arm)).not.toEqual(costAsc)

    // A tie on the result composite is stable regardless of raw cost.
    const armX = { arm: 'x', n: 4, m1FirstDoneRate: 1, m2MeanRounds: 0, m3MeanCost: 9.99, m3MeanCostPerResult: 9.99, m4MeanLoc: { churn: 0 }, safetyFlags: { flagged: false, scopeCreepRuns: 0 }, underpowered: false, unknownAdapterVersions: [], adapterVersions: [] }
    const armY = { ...armX, arm: 'y', m3MeanCost: 0.01, m3MeanCostPerResult: 0.01 }
    expect(rankByCostPerResult([armX, armY]).map((s) => s.arm)).toEqual(['x', 'y'])
    expect(rankByCostPerResult([armY, armX]).map((s) => s.arm)).toEqual(['y', 'x'])
  })

  it('Test 3: negative result preserved — SMA (highest cost) row survives, suppressed is empty', () => {
    const scored = FIXTURE.arms
      .filter((r: any) => r.arm !== 'sma-solo-recon')
      .map((r: any) => scoreArm(r, { adapterVersions: KNOWN_VERSIONS }))
    const agg = aggregateArena(scored)

    // The anti-cherry-pick guard is empty BY CONSTRUCTION.
    expect(agg.suppressed).toEqual([])

    // Every arm — including the expensive SMA one — is in the table with its cost.
    const smaRow = agg.arms.find((a: any) => a.arm === 'sma')
    expect(smaRow).toBeTruthy()
    expect(smaRow.m3MeanCost).toBeGreaterThan(0)
    const maxCost = Math.max(...agg.arms.map((a: any) => a.m3MeanCost))
    expect(smaRow.m3MeanCost).toBe(maxCost) // it is genuinely the most expensive
    expect(agg.arms.length).toBe(4) // no arm dropped for looking bad

    // The negative row must render on the page, not be hidden.
    const html = renderArenaReport(agg, { now: Date.UTC(2026, 6, 9, 12, 44) })
    expect(html).toContain('sma')
    expect(html).toContain(String(smaRow.m3MeanCost))
  })

  it('Test 4: the spend-adapter is the cost source — version-tagged, unknown version flagged', () => {
    // A clean arm: every cost record carries a KNOWN adapter version (consumed as-is).
    const clean = scoreArm(armByName('vanilla'), { adapterVersions: KNOWN_VERSIONS })
    expect(clean.adapterVersions).toEqual(['v1-claude-jsonl-2026-07'])
    expect(clean.unknownAdapterVersions).toEqual([])

    // Inject a spend-adapter DOUBLE whose known-set EXCLUDES the record's version →
    // the version is flagged as drift, never silently mis-scored (fail-open, D-9.2-13).
    const flagged = scoreArm(armByName('vanilla'), { adapterVersions: ['v-something-else'] })
    expect(flagged.unknownAdapterVersions).toEqual(['v1-claude-jsonl-2026-07'])
    // The cost is still BOOKED (counted as drift, never lost) — the total is non-zero.
    expect(flagged.m3MeanCost).toBeGreaterThan(0)
  })

  it('Test 5: the safety tier is a SEPARATE axis from the capability metrics', () => {
    const scored = FIXTURE.arms
      .filter((r: any) => r.arm !== 'sma-solo-recon')
      .map((r: any) => scoreArm(r, { adapterVersions: KNOWN_VERSIONS }))
    const agg = aggregateArena(scored)

    // Safety lives on its own axis, keyed by arm — not folded into a capability average.
    expect(Array.isArray(agg.safetyAxis)).toBe(true)
    const spSafety = agg.safetyAxis.find((s: any) => s.arm === 'superpowers')
    expect(spSafety.scopeCreepRuns).toBe(1) // superpowers had one scope-creep run
    expect(spSafety.flagged).toBe(true)

    // Superpowers still appears in the capability table with its numbers intact —
    // the safety flag is reported ALONGSIDE, never averaged away.
    const spCap = agg.arms.find((a: any) => a.arm === 'superpowers')
    expect(spCap).toBeTruthy()
    expect(spCap.m1FirstDoneRate).toBeGreaterThan(0)
    // ARENA_METRICS records the axis of every metric (capability / cost / safety).
    const axes = new Set(ARENA_METRICS.map((m: any) => m.axis))
    expect(axes.has('capability')).toBe(true)
    expect(axes.has('cost')).toBe(true)
    expect(axes.has('safety')).toBe(true)
    // Exactly the headline metrics are M1 + M2 (capability), never M3 (cost).
    const headline = ARENA_METRICS.filter((m: any) => m.headline).map((m: any) => m.id)
    expect(headline).toContain('M1')
    expect(headline).toContain('M2')
    expect(headline).not.toContain('M3')
  })

  it('Test 6: insufficient-n honesty — an arm with n<4 is underpowered/provisional', () => {
    const recon = scoreArm(armByName('sma-solo-recon'), { adapterVersions: KNOWN_VERSIONS })
    expect(recon.n).toBe(1)
    expect(recon.underpowered).toBe(true)

    // A full arm is NOT flagged underpowered.
    const full = scoreArm(armByName('sma'), { adapterVersions: KNOWN_VERSIONS })
    expect(full.underpowered).toBe(false)

    // aggregateArena surfaces the underpowered arms as a provisional list.
    const agg = aggregateArena([recon, full])
    expect(agg.underpowered).toContain('sma-solo-recon')
    expect(agg.underpowered).not.toContain('sma')
  })
})
