/**
 * policy.test.ts — the executor-routing POLICY suite.
 *
 * Three describe blocks, one per module of the policy layer:
 *   1. routing.mjs  — default lanes + override precedence + day-priority protection
 *   2. windows.mjs  — estimated window state + rate-limit ground truth (Assumption A3)
 *   3. budget.mjs   — sub→API switch + monthly budget stop
 *
 * Every module is pure with an injected clock / usageReader; no test spawns a CLI,
 * touches the real ~/.sma-daemon, or spends a token.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRoute } from '../src/policy/routing.mjs'
import { windowState, markWindowClosed, markWindowObserved, isOpen } from '../src/policy/windows.mjs'
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
    expect(r.workerId).not.toBe('max-1') // founder account protected
    expect(r.provider).toBe('claude')
    expect(r.workerId).toBe('max-2')
  })

  it('day-priority: even when it is the ONLY open window the task WAITS', () => {
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

/**
 * THE MONEY RULE, AS THE DISPATCHER NOW ASKS IT.
 *
 * Until 10.08.2026 `shouldApiFallback` had no caller anywhere: an explicit `provider:'api'`
 * task went straight past the cap, and a fleet with every window shut simply waited while
 * three screens told the owner it would continue on the paid channel. These cases hold the
 * JOIN — the router asking, and obeying both answers.
 */
describe('policy/routing — the paid channel is asked for permission, not assumed', () => {
  const allShut = () => false

  it('an explicit «api» task is REFUSED when the cap says no — it waits instead of spending', () => {
    const r = resolveRoute(
      { lane: 'prod', provider: 'api' },
      { workers: pool(), windows: allOpen, clock: nightClock, budget: () => ({ fallback: false, reason: 'budget_stop' }) },
    )
    expect(r.useApiFallback).toBe(false)
    expect(r.provider).toBe(null)
    expect(r.reasonCode).toBe('budget_stop')
  })

  it('an explicit «api» task still runs when the cap allows it', () => {
    const r = resolveRoute(
      { lane: 'prod', provider: 'api' },
      { workers: pool(), windows: allOpen, clock: nightClock, budget: () => ({ fallback: true, reason: 'api_fallback' }) },
    )
    expect(r.useApiFallback).toBe(true)
    expect(r.provider).toBe('api')
  })

  it('every window shut + money allowed → the documented switch finally happens', () => {
    const r = resolveRoute(
      { lane: 'prod' },
      { workers: pool(), windows: allShut, clock: nightClock, budget: () => ({ fallback: true, reason: 'api_fallback' }) },
    )
    expect(r.useApiFallback).toBe(true)
    expect(r.provider).toBe('api')
    expect(r.reasonCode).toBe('api_fallback')
  })

  it('every window shut + money refused → the task waits, exactly as before', () => {
    const r = resolveRoute(
      { lane: 'prod' },
      { workers: pool(), windows: allShut, clock: nightClock, budget: () => ({ fallback: false, reason: 'budget_stop' }) },
    )
    expect(r.useApiFallback).toBe(false)
    expect(r.reasonCode).toBe('window_exhausted')
  })

  it('a budget rule that throws never takes the dispatcher down — no answer leaves the old path', () => {
    const r = resolveRoute(
      { lane: 'prod', provider: 'api' },
      {
        workers: pool(),
        windows: allOpen,
        clock: nightClock,
        budget: () => {
          throw new Error('spend book unreadable')
        },
      },
    )
    expect(r.useApiFallback).toBe(true) // the old behaviour, not an invented refusal
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

/**
 * THE BAR STOPS GUESSING.
 *
 * The window model was written around «there is no official quota API», so both bars were
 * estimated from what THIS daemon had spawned. On a machine where a person also works in their
 * own terminal all day that is not merely coarse: the estimate read near zero on a
 * subscription three quarters spent, which is the exact opposite of the question the screen
 * exists to answer. The CLI has been emitting its own reading on every spawn the whole time.
 */
describe('policy/windows — the vendor reading beats the estimate', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
  })
  const mkTmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-policy-obs-'))
    tmpDirs.push(d)
    return d
  }
  const fixedClock = () => new Date(2026, 6, 17, 12, 0, 0).getTime()
  const hour = 60 * 60 * 1000
  // usage that would estimate a nearly EMPTY window, so a measured bar cannot pass by accident
  const lowReader = () => () => ({ inputTokens: 10, outputTokens: 10, costUsd: 0, rows: 1 })
  const cap = { fiveHourTokens: 1_000_000, weekTokens: 10_000_000 }

  it('a seven-day reading replaces the weekly estimate and says so', () => {
    const dataDir = mkTmp()
    markWindowObserved({
      dataDir,
      accountName: 'max-2',
      observation: { limitType: 'seven_day', utilization: 0.73, resetsAt: fixedClock() + 48 * hour },
      clock: fixedClock,
    })
    const state = windowState({ account: { name: 'max-2' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.pctWeek).toBe(73) // the subscription's own number, not ours
    expect(state.pct5h).toBe(0) // nobody reported this window; it stays an estimate
    expect(state.measured).toEqual({ fiveHour: false, week: true })
    expect(state.estimated).toBe(true) // one bar is still a guess, and the label still says so
    expect(state.weekResetsAt).toBe(fixedClock() + 48 * hour)
  })

  it('both windows reported → nothing on this state is a guess any more', () => {
    const dataDir = mkTmp()
    const obs = (limitType: string, utilization: number) =>
      markWindowObserved({ dataDir, accountName: 'max-2', observation: { limitType, utilization, resetsAt: fixedClock() + 3 * hour }, clock: fixedClock })
    obs('five_hour', 0.42)
    obs('seven_day', 0.73)
    const state = windowState({ account: { name: 'max-2' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.pct5h).toBe(42)
    expect(state.pctWeek).toBe(73)
    expect(state.estimated).toBe(false)
    expect(state.measured).toEqual({ fiveHour: true, week: true })
  })

  it('WRITING ONE WINDOW DOES NOT ERASE THE OTHER — the CLI reports whichever is closest', () => {
    // consecutive spawns write DIFFERENT keys; a whole-file write would silently drop the rest
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'seven_day', utilization: 0.9, resetsAt: fixedClock() + 40 * hour }, clock: fixedClock })
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', utilization: 0.1, resetsAt: fixedClock() + hour }, clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.pctWeek).toBe(90)
    expect(state.pct5h).toBe(10)
  })

  it('an observation EXPIRES at its reset — a rolled-over window must not look exhausted', () => {
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', utilization: 0.99, resetsAt: fixedClock() - 1 }, clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.pct5h).toBe(0) // back to the estimate, not stuck at 99
    expect(state.measured.fiveHour).toBe(false)
  })

  it('a real 100% closes the window for the router — exhaustion is now a fact, not a guess', () => {
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', utilization: 1, resetsAt: fixedClock() + hour }, clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.pct5h).toBe(100)
    expect(isOpen(state, fixedClock)).toBe(false) // the load can be routed elsewhere
  })

  it('a reading that cannot be dated is DROPPED — an unexpiring percentage is worse than an estimate', () => {
    const dataDir = mkTmp()
    expect(markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'seven_day', utilization: 0.5 }, clock: fixedClock })).toBeNull()
    expect(markWindowObserved({ dataDir, accountName: 'm', observation: { utilization: 0.5, resetsAt: fixedClock() + hour }, clock: fixedClock })).toBeNull()
    const state = windowState({ account: { name: 'm' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.estimated).toBe(true)
  })

  it('a ground-truth CLOSE still outranks a comfortable measured bar', () => {
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', utilization: 0.2, resetsAt: fixedClock() + hour }, clock: fixedClock })
    markWindowClosed({ dataDir, accountName: 'm', resetAt: fixedClock() + 2 * hour, clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, usageReader: lowReader(), clock: fixedClock, dataDir, capacity: cap })
    expect(state.pct5h).toBe(20) // the reading survives the merge…
    expect(isOpen(state, fixedClock)).toBe(false) // …and a refusal still wins
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
