/**
 * policy.test.ts — the executor-routing POLICY suite (Phase 9.5 Plan 05).
 *
 * Three describe blocks, one per module of the policy layer:
 *   1. routing.mjs  — default lanes + override precedence + day-priority protection (D-9.5-04/03a)
 *   2. windows.mjs  — estimated window state + rate-limit ground truth (Assumption A3)
 *   3. budget.mjs   — sub→API switch + monthly budget stop (D-9.5-03b)
 *
 * Every module is pure with an injected clock / usageReader; no test spawns a CLI,
 * touches the real ~/.sma-daemon, or spends a token.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRoute } from '../src/policy/routing.mjs'
import { windowState, markWindowClosed, isOpen } from '../src/policy/windows.mjs'
import { shouldApiFallback } from '../src/policy/budget.mjs'

// --------------------------------------------------------------------------
// Shared fixtures — a pool mirroring the default config (3 claude + 1 codex).
// --------------------------------------------------------------------------

/** The default worker pool (max-1 is the founder's daytime-priority account). */
function pool() {
  return [
    { id: 'max-1', lane: 'prod', provider: 'claude', dayPriorityOwner: true, account: { name: 'max-1' }, enabled: true },
    { id: 'max-2', lane: 'prod', provider: 'claude', account: { name: 'max-2' }, enabled: true },
    { id: 'max-3', lane: 'prod', provider: 'claude', account: { name: 'max-3' }, enabled: true },
    { id: 'pro-1', lane: 'research', provider: 'codex', account: { name: 'pro-1' }, enabled: true },
  ]
}

// Local-time clocks: `new Date(y,m,d,h)` (local ctor) round-trips with `getHours()`
// (local getter) on ANY runner timezone, so the day/night split is deterministic.
const dayClock = () => new Date(2026, 6, 17, 14, 0, 0).getTime() // 14:00 local — founder active
const nightClock = () => new Date(2026, 6, 17, 2, 0, 0).getTime() // 02:00 local — night park

const allOpen = () => true
/** window predicate that opens exactly one worker id. */
const only = (id) => (w) => w.id === id

describe('policy/routing — default lanes + override precedence + day-priority', () => {
  it('default: prod lane routes to a claude worker', () => {
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: allOpen, clock: nightClock })
    expect(r.provider).toBe('claude')
    expect(r.workerId).toBe('max-1') // night → day-priority owner participates, picked first
    expect(r.reason).toContain('default')
  })

  it('default: research lane routes to a codex worker', () => {
    const r = resolveRoute({ lane: 'research' }, { workers: pool(), windows: allOpen, clock: nightClock })
    expect(r.provider).toBe('codex')
    expect(r.workerId).toBe('pro-1')
  })

  it('precedence 1/3 — per-TASK override beats per-worker override', () => {
    const workers = pool()
    workers[1].model = 'sonnet-worker' // max-2 carries a per-worker model
    workers[1].effort = 'medium'
    const r = resolveRoute(
      { lane: 'prod', model: 'opus-task', effort: 'high' },
      { workers, windows: only('max-2'), clock: nightClock },
    )
    expect(r.workerId).toBe('max-2')
    expect(r.model).toBe('opus-task') // task wins over worker
    expect(r.effort).toBe('high')
    expect(r.reason).toContain('per-task')
  })

  it('precedence 2/3 — per-WORKER override beats lane default', () => {
    const workers = pool()
    workers[1].model = 'sonnet-worker'
    workers[1].effort = 'medium'
    const r = resolveRoute({ lane: 'prod' }, { workers, windows: only('max-2'), clock: nightClock })
    expect(r.workerId).toBe('max-2')
    expect(r.model).toBe('sonnet-worker') // worker wins over (empty) default
    expect(r.effort).toBe('medium')
    expect(r.reason).toContain('per-worker')
  })

  it('precedence 3/3 — lane default when neither task nor worker override', () => {
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: only('max-3'), clock: nightClock })
    expect(r.workerId).toBe('max-3')
    expect(r.model == null).toBe(true) // no default model
    expect(r.effort == null).toBe(true)
    expect(r.reason).toContain('default')
  })

  it('day-priority: dayPriorityOwner is SKIPPED during active hours when another window is open', () => {
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: allOpen, clock: dayClock })
    expect(r.workerId).not.toBe('max-1') // founder account protected (D-9.5-03a)
    expect(r.provider).toBe('claude')
    expect(r.workerId).toBe('max-2')
  })

  it('day-priority: even when it is the ONLY open window the task WAITS (grill CH-9.5-05-1)', () => {
    // Only max-1 (the day-priority owner) has an open window; day hours.
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: only('max-1'), clock: dayClock })
    expect(r.workerId).toBe(null)
    expect(r.reason).toBe('window_exhausted') // NO only-open-window carve-out — it waits
  })

  it('day-priority: at night the owner participates normally', () => {
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: only('max-1'), clock: nightClock })
    expect(r.workerId).toBe('max-1')
    expect(r.reason).not.toBe('window_exhausted')
  })

  it('no eligible worker (all windows closed) → the task waits, never fails', () => {
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: () => false, clock: nightClock })
    expect(r.workerId).toBe(null)
    expect(r.reason).toBe('window_exhausted')
  })
})

describe('policy/windows — estimated state + rate-limit ground truth', () => {
  const tmpDirs = []
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true })
  })
  const mkTmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-policy-win-'))
    tmpDirs.push(d)
    return d
  }
  const fixedClock = () => new Date(2026, 6, 17, 12, 0, 0).getTime()
  // A fake usageReader (windows.mjs never imports usage.mjs — the loop injects readUsage).
  const fakeReader = ({ inputTokens = 60, outputTokens = 40 } = {}) => () => ({ inputTokens, outputTokens, costUsd: 0, rows: 1 })

  it('derives pct5h/pctWeek from usage against capacity and ALWAYS labels estimated:true', () => {
    const state = windowState({
      account: { name: 'max-2' },
      usageReader: fakeReader(),
      clock: fixedClock,
      capacity: { fiveHourTokens: 1000, weekTokens: 10000 },
    })
    expect(state.estimated).toBe(true) // honest label, always present
    expect(state.pct5h).toBe(10) // 100 tokens / 1000
    expect(state.pctWeek).toBe(1) // 100 tokens / 10000
    expect(state.closedUntil).toBeUndefined()
    expect(isOpen(state, fixedClock)).toBe(true)
  })

  it('ground-truth close (a CLI rate-limit) OVERRIDES a low estimate', () => {
    const dataDir = mkTmp()
    const resetAt = fixedClock() + 60 * 60 * 1000 // one hour into the future
    markWindowClosed({ dataDir, accountName: 'max-2', resetAt, clock: fixedClock })

    const state = windowState({
      account: { name: 'max-2' },
      usageReader: fakeReader(), // pct5h would be ~10 — but the ground-truth close wins
      clock: fixedClock,
      dataDir,
      capacity: { fiveHourTokens: 1000, weekTokens: 10000 },
    })
    expect(state.pct5h).toBe(10)
    expect(state.estimated).toBe(true)
    expect(state.closedUntil).toBeDefined()
    expect(isOpen(state, fixedClock)).toBe(false) // closed despite the low estimate
  })

  it('a persisted close whose reset is in the PAST no longer closes the window', () => {
    const dataDir = mkTmp()
    const resetAt = fixedClock() - 60 * 1000 // already expired
    markWindowClosed({ dataDir, accountName: 'max-2', resetAt, clock: fixedClock })

    const state = windowState({
      account: { name: 'max-2' },
      usageReader: fakeReader(),
      clock: fixedClock,
      dataDir,
      capacity: { fiveHourTokens: 1000, weekTokens: 10000 },
    })
    expect(state.closedUntil).toBeUndefined() // expired close is dropped
    expect(isOpen(state, fixedClock)).toBe(true)
  })

  it('isOpen: pct5h >= 100 closes the window even with no ground-truth close', () => {
    const state = windowState({
      account: { name: 'max-2' },
      usageReader: fakeReader({ inputTokens: 700, outputTokens: 400 }), // 1100 / 1000 = 110%
      clock: fixedClock,
      capacity: { fiveHourTokens: 1000, weekTokens: 10000 },
    })
    expect(state.pct5h).toBe(110)
    expect(isOpen(state, fixedClock)).toBe(false)
  })

  it('missing usage book → all-zero estimate, window open (fail-open)', () => {
    const state = windowState({ account: 'max-9', usageReader: () => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, rows: 0 }), clock: fixedClock })
    expect(state.pct5h).toBe(0)
    expect(state.estimated).toBe(true)
    expect(isOpen(state, fixedClock)).toBe(true)
  })
})

describe('policy/budget — sub→API switch + monthly budget stop', () => {
  const clock = () => new Date(2026, 6, 17, 12, 0, 0).getTime()
  // cap 100 EUR, 1:1 USD→EUR so boundary math is exact.
  const budget = { monthlyApiCapEur: 100, usdToEur: 1, warnPct: [70, 90], apiAccountName: 'api' }
  // Fake reader: month-to-date API spend of `costUsd` on the API account.
  const reader = (costUsd) => () => ({ inputTokens: 0, outputTokens: 0, costUsd, rows: 1 })

  it('windows still open → wait_for_window, never spends', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: false }, budget, usageReader: reader(0), clock })
    expect(r.fallback).toBe(false)
    expect(r.reason).toBe('wait_for_window')
  })

  it('under cap + all lane windows closed → fallback allowed, no warn', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: true }, budget, usageReader: reader(50), clock })
    expect(r.fallback).toBe(true)
    expect(r.warn).toBeUndefined()
  })

  it('at 70% → warn:70 surfaces in the shape (fallback still allowed)', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: true }, budget, usageReader: reader(70), clock })
    expect(r.fallback).toBe(true)
    expect(r.warn).toBe(70)
  })

  it('at 90% → warn:90 surfaces in the shape (fallback still allowed)', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: true }, budget, usageReader: reader(90), clock })
    expect(r.fallback).toBe(true)
    expect(r.warn).toBe(90)
  })

  it('at/over cap → hard budget_stop, no fallback', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: true }, budget, usageReader: reader(100), clock })
    expect(r.fallback).toBe(false)
    expect(r.reason).toBe('budget_stop')
  })

  it('per-task cost ceiling that would breach the cap → budget_stop', () => {
    const r = shouldApiFallback({
      task: { lane: 'prod', apiCostCeilingEur: 10 },
      windows: { allClosed: true },
      budget,
      usageReader: reader(95), // 95 + 10 ceiling = 105 > 100
      clock,
    })
    expect(r.fallback).toBe(false)
    expect(r.reason).toBe('budget_stop')
  })

  it('no monthly cap configured (0) → no fallback budget (config default)', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: true }, budget: { monthlyApiCapEur: 0 }, usageReader: reader(0), clock })
    expect(r.fallback).toBe(false)
    expect(r.reason).toBe('budget_stop')
  })

  it('accepts a bare boolean for the windows-closed signal', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: true, budget, usageReader: reader(10), clock })
    expect(r.fallback).toBe(true)
  })
})
