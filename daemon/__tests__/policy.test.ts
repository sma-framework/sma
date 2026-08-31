/**
 * policy.test.ts — the executor-routing POLICY suite.
 *
 * Three describe blocks, one per module of the policy layer:
 *   1. routing.mjs  — default lanes + override precedence + day-priority protection
 *   2. windows.mjs  — what the provider said about a subscription window, and nothing else
 *   3. budget.mjs   — sub→API switch + monthly budget stop
 *
 * Every module is pure with an injected clock / usageReader; no test spawns a CLI,
 * touches the real ~/.sma-daemon, or spends a token.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRoute } from '../src/policy/routing.mjs'
import { windowState, markWindowClosed, markWindowObserved, isOpen, readingSaysExhausted } from '../src/policy/windows.mjs'
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

  /**
   * THE WAIT IS NAMED BY WHAT CAUSED IT, NOT BY WHAT PRECEDED IT.
   *
   * This case used to assert `window_exhausted` here, and that assertion was the defect
   * written down as a requirement: the shut windows are why the money rule was ASKED, its
   * refusal is why nothing is running, and only the second is actionable. The task still
   * waits — nothing about the outcome changed — but it now waits under its own word.
   */
  it('every window shut + money refused → the task waits under the MONEY word, not the window word', () => {
    const r = resolveRoute(
      { lane: 'prod' },
      { workers: pool(), windows: allShut, clock: nightClock, budget: () => ({ fallback: false, reason: 'budget_stop' }) },
    )
    expect(r.useApiFallback).toBe(false)
    expect(r.reasonCode).toBe('budget_stop')
    // The human string keeps BOTH facts: the roster reader still learns the pool was empty.
    expect(r.reason).toContain('all windows closed')
    expect(r.reason).toContain('cap is spent')
  })

  it('every window shut + no money rule at all → the old word stands, letter for letter', () => {
    const r = resolveRoute({ lane: 'prod' }, { workers: pool(), windows: allShut, clock: nightClock })
    expect(r.useApiFallback).toBe(false)
    expect(r.reasonCode).toBe('window_exhausted')
    expect(r.reason).toBe('window_exhausted')
  })

  it('the protected account emptied the pool → the money verdict never overwrites that fact', () => {
    // Day hours, only the founder's own account has an open window: the rule is not even
    // asked, because holding work for his subscription must never become spending.
    const r = resolveRoute(
      { lane: 'prod' },
      { workers: pool(), windows: only('max-1'), clock: dayClock, budget: () => ({ fallback: false, reason: 'budget_stop' }) },
    )
    expect(r.reasonCode).toBe('day_priority_protected')
    expect(r.reason).toBe('window_exhausted')
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

/**
 * THE BAR STOPPED GUESSING, AND THEN STOPPED PRETENDING.
 *
 * The window model was written around «there is no official quota API», so both bars were
 * estimated from what THIS daemon had spawned. On a machine where a person also works in his
 * own terminal all day that is not merely coarse: it read near zero on a subscription three
 * quarters spent, and a zero bar is read as «the quota is free» — the exact opposite of the
 * question the screen exists to answer.
 *
 * The frame the CLI really sends carries three facts and no fourth: which window, whether it
 * is still allowing work, and when it resets. It has NEVER carried a utilization fraction.
 * The estimate is gone; what is not known is reported as `unknown`.
 */
describe('policy/windows — only what the provider actually said', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
  })
  const mkTmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-policy-win-'))
    tmpDirs.push(d)
    return d
  }
  const fixedClock = () => new Date(2026, 6, 17, 12, 0, 0).getTime()
  const hour = 60 * 60 * 1000

  /**
   * THE CASE THE OLD MODEL GOT BACKWARDS. Nothing has been heard about this account, so the
   * only honest answer is «unknown» — and it must not be a zero, because a zero is a claim
   * that the window is empty.
   */
  it('an account nothing has been heard about is UNKNOWN, never zero per cent', () => {
    const state = windowState({ account: { name: 'max-2' }, clock: fixedClock })
    expect(state.fiveHour).toEqual({ status: 'unknown', resetsAt: null, pct: null, observedAt: null })
    expect(state.week).toEqual({ status: 'unknown', resetsAt: null, pct: null, observedAt: null })
    expect(state.pct5h).toBeUndefined() // the invented percentage is gone from the model entirely
    expect(state.pctWeek).toBeUndefined()
    expect(state.closedUntil).toBeUndefined()
    expect(isOpen(state, fixedClock)).toBe(true) // silence never stops the conveyor
  })

  /**
   * THE READING THE STREAM REALLY CARRIES — status and reset, no fraction. This exact shape
   * was DROPPED on the floor before: the store required a utilization, so every real reading
   * the daemon was ever handed was thrown away while the tests, which passed a fraction, stayed
   * green.
   */
  it('stores a reading that has NO utilization — status and reset are the whole fact', () => {
    const dataDir = mkTmp()
    const resetsAt = fixedClock() + 3 * hour
    const record = markWindowObserved({
      dataDir,
      accountName: 'max-2',
      observation: { limitType: 'five_hour', status: 'allowed', resetsAt, usingOverage: false },
      clock: fixedClock,
    })
    expect(record).not.toBeNull()

    const state = windowState({ account: { name: 'max-2' }, clock: fixedClock, dataDir })
    expect(state.fiveHour.status).toBe('open')
    expect(state.fiveHour.resetsAt).toBe(resetsAt)
    expect(state.fiveHour.pct).toBeNull() // no fraction was sent, so none is shown
    expect(state.week.status).toBe('unknown') // the other window was not reported
    expect(isOpen(state, fixedClock)).toBe(true)
  })

  it('a refused window is EXHAUSTED, and it closes the account for the router', () => {
    const dataDir = mkTmp()
    markWindowObserved({
      dataDir,
      accountName: 'm',
      observation: { limitType: 'five_hour', status: 'rejected', resetsAt: fixedClock() + hour },
      clock: fixedClock,
    })
    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.fiveHour.status).toBe('exhausted')
    expect(isOpen(state, fixedClock)).toBe(false) // the load can be routed elsewhere
  })

  /**
   * A NEW WORD FOR «REFUSED» MUST READ AS REFUSED. The healthy statuses all begin with
   * `allowed`; matching on the open wording rather than on a list of refusal words means an
   * unfamiliar spelling errs towards stopping, not towards spending.
   */
  it('an unfamiliar status is treated as a refusal; the allowed-family is treated as open', () => {
    expect(readingSaysExhausted({ status: 'allowed' })).toBe(false)
    expect(readingSaysExhausted({ status: 'allowed_warning' })).toBe(false)
    expect(readingSaysExhausted({ status: 'rejected' })).toBe(true)
    expect(readingSaysExhausted({ status: 'some_new_refusal_word' })).toBe(true)
    expect(readingSaysExhausted({})).toBe(false) // nothing said is not a refusal
    expect(readingSaysExhausted({ utilization: 1 })).toBe(true) // for the day a fraction arrives
  })

  it('the weekly window is read under either of the names the provider uses for it', () => {
    for (const limitType of ['seven_day', 'week']) {
      const dataDir = mkTmp()
      markWindowObserved({
        dataDir,
        accountName: 'm',
        observation: { limitType, status: 'allowed', resetsAt: fixedClock() + 48 * hour },
        clock: fixedClock,
      })
      const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
      expect(state.week.status, `weekly window under «${limitType}»`).toBe('open')
      expect(state.week.resetsAt).toBe(fixedClock() + 48 * hour)
    }
  })

  it('WRITING ONE WINDOW DOES NOT ERASE THE OTHER — the CLI reports whichever is closest', () => {
    // consecutive spawns write DIFFERENT keys; a whole-file write would silently drop the rest
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'seven_day', status: 'rejected', resetsAt: fixedClock() + 40 * hour }, clock: fixedClock })
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', status: 'allowed', resetsAt: fixedClock() + hour }, clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.week.status).toBe('exhausted')
    expect(state.fiveHour.status).toBe('open')
  })

  it('an observation EXPIRES at its reset — a rolled-over window goes back to «unknown»', () => {
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', status: 'rejected', resetsAt: fixedClock() - 1 }, clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.fiveHour.status).toBe('unknown') // not stuck on a refusal that has since lapsed
    expect(isOpen(state, fixedClock)).toBe(true)
  })

  it('a reading that cannot be dated is DROPPED — an answer that never expires is worse than none', () => {
    const dataDir = mkTmp()
    expect(markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'seven_day', status: 'allowed' }, clock: fixedClock })).toBeNull()
    expect(markWindowObserved({ dataDir, accountName: 'm', observation: { status: 'allowed', resetsAt: fixedClock() + hour }, clock: fixedClock })).toBeNull()
    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.fiveHour.status).toBe('unknown')
    expect(state.week.status).toBe('unknown')
  })

  it('ground-truth close (a persisted refusal) shuts the account whatever the windows say', () => {
    const dataDir = mkTmp()
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', status: 'allowed', resetsAt: fixedClock() + hour }, clock: fixedClock })
    markWindowClosed({ dataDir, accountName: 'm', resetAt: fixedClock() + 2 * hour, limitType: 'five_hour', clock: fixedClock })
    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.fiveHour.resetsAt).toBe(fixedClock() + hour) // the reading survives the merge…
    expect(state.fiveHour.status).toBe('exhausted') // …and the close it belongs to is said on ITS line
    expect(state.closedUntil).toBeDefined()
    expect(isOpen(state, fixedClock)).toBe(false) // …and a refusal still wins
  })

  it('a persisted close whose reset is in the PAST no longer closes the window', () => {
    const dataDir = mkTmp()
    markWindowClosed({ dataDir, accountName: 'max-2', resetAt: fixedClock() - 60 * 1000, limitType: 'five_hour', clock: fixedClock })
    const state = windowState({ account: { name: 'max-2' }, clock: fixedClock, dataDir })
    expect(state.closedUntil).toBeUndefined() // expired close is dropped
    expect(isOpen(state, fixedClock)).toBe(true)
  })

  /**
   * ═════════ A WINDOW WE CANNOT NAME HAS NO RIGHT TO STOP US ═════════
   *
   * Measured on 31.08.2026. The provider refused `seven_day_overage_included` — the weekly
   * window WITH the paid overage folded in, on an account where the paid channel is switched
   * off and its ceiling is zero. That name is on neither of this module's lists, so nothing
   * about it ever reached a screen; the close it wrote went in at the top of the record, where
   * it outranks both windows, and shut the whole subscription for five days. Thirty tasks
   * queued, no worker busy. Half an hour later the window that actually governs — `seven_day` —
   * answered `allowed_warning` at 74 %, and a live call on the same account returned 0.
   *
   * Two places disagreed about which windows exist: the close fired on ANY name, the screen
   * drew only the names it knew. The three cases below are that disagreement, closed.
   */
  it('a refusal on a window this daemon cannot NAME does not close the account', () => {
    const dataDir = mkTmp()
    const resetAt = fixedClock() + 5 * 24 * hour
    // The reading is still filed — an unknown window is stored, merely not drawn and not obeyed.
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'seven_day_overage_included', status: 'rejected', resetsAt: resetAt }, clock: fixedClock })
    expect(markWindowClosed({ dataDir, accountName: 'm', resetAt, limitType: 'seven_day_overage_included', clock: fixedClock })).toBeNull()

    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.closedUntil).toBeUndefined()
    expect(state.fiveHour.status).toBe('unknown') // neither window is slandered on its behalf
    expect(state.week.status).toBe('unknown')
    expect(isOpen(state, fixedClock)).toBe(true) // the conveyor keeps moving
  })

  it('a refusal on a window we CAN name closes the account — and that window says which and until when', () => {
    const dataDir = mkTmp()
    const resetAt = fixedClock() + 40 * hour
    expect(markWindowClosed({ dataDir, accountName: 'm', resetAt, limitType: 'week', clock: fixedClock })).not.toBeNull()

    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.closedUntil).toBe(resetAt)
    expect(state.week.status).toBe('exhausted') // «ждёт окно» can never sit beside two open rows
    expect(state.week.resetsAt).toBe(resetAt) // and the row carries the hour it opens again
    expect(state.fiveHour.status).toBe('unknown')
    expect(isOpen(state, fixedClock)).toBe(false)
  })

  it('a FRESHER «allowed» on the same window lifts an earlier close', () => {
    const dataDir = mkTmp()
    const resetAt = fixedClock() + 40 * hour
    markWindowClosed({ dataDir, accountName: 'm', resetAt, limitType: 'seven_day', clock: fixedClock })
    const later = () => fixedClock() + 30 * 60 * 1000
    markWindowObserved({
      dataDir,
      accountName: 'm',
      observation: { limitType: 'seven_day', status: 'allowed_warning', resetsAt: resetAt, utilization: 0.74 },
      clock: later,
    })

    const state = windowState({ account: { name: 'm' }, clock: later, dataDir })
    expect(state.closedUntil).toBeUndefined() // the provider changed its mind, and we heard it
    expect(state.week.status).toBe('open')
    expect(isOpen(state, later)).toBe(true)
  })

  it('an OLDER «allowed» does NOT lift a close that came after it', () => {
    const dataDir = mkTmp()
    const resetAt = fixedClock() + 3 * hour
    markWindowObserved({ dataDir, accountName: 'm', observation: { limitType: 'five_hour', status: 'allowed', resetsAt: resetAt }, clock: fixedClock })
    const later = () => fixedClock() + 10 * 60 * 1000
    markWindowClosed({ dataDir, accountName: 'm', resetAt, limitType: 'five_hour', clock: later })

    const state = windowState({ account: { name: 'm' }, clock: later, dataDir })
    expect(state.closedUntil).toBe(resetAt)
    expect(state.fiveHour.status).toBe('exhausted')
    expect(isOpen(state, later)).toBe(false)
  })

  /**
   * A close laid down by the code that could not tell one window name from another carries no
   * window at all — and an un-attributable close is exactly what cost a week of work. It is
   * not honoured, because there is no way to show it came from a window we can name, and a
   * refusal that cannot say which window it is about cannot be shown on any row either.
   */
  it('a close that names NO window is not honoured', () => {
    const dataDir = mkTmp()
    const path = join(dataDir, 'windows', 'm.json')
    mkdirSync(join(dataDir, 'windows'), { recursive: true })
    writeFileSync(path, JSON.stringify({ accountName: 'm', resetAt: fixedClock() + 4 * 24 * hour, closedAt: new Date(fixedClock()).toISOString() }))

    const state = windowState({ account: { name: 'm' }, clock: fixedClock, dataDir })
    expect(state.closedUntil).toBeUndefined()
    expect(isOpen(state, fixedClock)).toBe(true)
  })
})

describe('policy/budget — sub→API switch + monthly budget stop', () => {
  const clock = () => new Date(2026, 6, 17, 12, 0, 0).getTime()
  // Потолок 100 ДОЛЛАРОВ — в той же валюте, в какой поставщик выставляет расход, потому что
  // пересчёта курса в продукте нет. Прежде здесь стояли «100 EUR» и курс `usdToEur: 1`: пока
  // курс единица, разницы не видно, и ровно поэтому она дожила бы до дня, когда станет видна.
  const budget = { monthlyApiCapUsd: 100, warnPct: [70, 90], apiAccountName: 'api' }
  // Подделка читателя: расход ПЛАТНОГО канала (`apiCostUsd`) — то самое поле, которое читает
  // и экран. `costUsd` (все каналы) намеренно другое: читатель, у которого эти два числа
  // совпадают, не поймал бы того, что порог и экран смотрели в разные колонки.
  const reader = (apiCostUsd) => () => ({ inputTokens: 0, outputTokens: 0, costUsd: apiCostUsd + 1000, apiCostUsd, rows: 1 })

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
      task: { lane: 'prod', apiCostCeilingUsd: 10 },
      windows: { allClosed: true },
      budget,
      usageReader: reader(95), // 95 + 10 ceiling = 105 > 100
      clock,
    })
    expect(r.fallback).toBe(false)
    expect(r.reason).toBe('budget_stop')
  })

  /**
   * NO CAP IS NOT AN EMPTY WALLET, AND THE DIFFERENCE IS NOT COSMETIC.
   *
   * 0 is the SHIPPED DEFAULT, so this branch is what a fresh install answers on its very
   * first busy night. It used to answer «budget_stop» — the money ran out — while the queue
   * plaque, on the same facts, said the paid channel was never configured. Both sentences
   * were shown to a person, and «raise your limit» is unactionable advice about a limit he
   * never set. The word is now the state's own.
   */
  it('no monthly cap configured (0) → api_cap_unset, NOT «the money ran out»', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: { allClosed: true }, budget: { monthlyApiCapUsd: 0 }, usageReader: reader(0), clock })
    expect(r.fallback).toBe(false)
    expect(r.reason).toBe('api_cap_unset')
    // …and it is emphatically NOT the word that means a ceiling was reached: the two send a
    // person to do different things, which is the entire point of splitting them.
    expect(r.reason).not.toBe('budget_stop')
  })

  it('accepts a bare boolean for the windows-closed signal', () => {
    const r = shouldApiFallback({ task: { lane: 'prod' }, windows: true, budget, usageReader: reader(10), clock })
    expect(r.fallback).toBe(true)
  })
})

/**
 * РЕГУЛЯТОР: ЗАНЯТОМУ РАБОТНИКУ ВТОРУЮ ПОПЫТКУ НЕ ДАЮТ.
 *
 * Фильтр кандидатов спрашивал «включён / провайдер / окно открыто / не дневной приоритет»
 * и НЕ спрашивал, есть ли у работника живая попытка, — а тик заводится таймером и не ждёт
 * предыдущего прохода. Пол под происшествием 12.08.2026: три параллельных процесса жгли
 * подписку при пустой доске.
 *
 * Второе утверждение важнее первого: «все заняты» — это НЕ «все окна закрыты». Переводить
 * занятость в платный канал значило бы платить деньгами за то, что работа просто идёт.
 */
describe('policy/routing — занятый работник не получает вторую попытку', () => {
  it('занятый работник пропускается, свободный выбирается', () => {
    const r = resolveRoute(
      { lane: 'prod' },
      { workers: pool(), windows: allOpen, clock: nightClock, busyWorkers: new Set(['max-1', 'max-2']) },
    )
    expect(r.workerId, 'выбран занятый работник — регулятора нет').toBe('max-3')
  })

  it('все заняты — задача ЖДЁТ с названной причиной и НЕ уходит в платный канал', () => {
    const r = resolveRoute(
      { lane: 'prod' },
      {
        workers: pool(),
        windows: allOpen,
        clock: nightClock,
        busyWorkers: new Set(['max-1', 'max-2', 'max-3']),
        // деньги отвечают «да» на любой вопрос — если их спросят, это будет видно
        budget: () => ({ fallback: true }),
      },
    )
    expect(r.workerId, 'занятость не должна выдавать работника').toBe(null)
    expect(r.useApiFallback, 'занятость — не «все окна закрыты»: платить за неё нельзя').toBe(false)
    expect(r.reasonCode, 'причина обязана называть занятость, а не исчерпанное окно').toBe('worker_busy')
  })
})
