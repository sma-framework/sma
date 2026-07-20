/**
 * Tests for the roster one-poll derive (Phase 9.5 Plan 08, Task 2).
 *
 * deriveState re-computes the WHOLE roster truth from durable fixtures (adapter rows +
 * an injected ledger reader + a window-state function + a usageReader) — never a stored
 * value. The load-bearing invariants:
 *   - the full payload shape {kpis, queue, workers, done, spend},
 *   - presence is a PURE derive (truth table: closed window → «ждёт окно» even with
 *     queued work; open + active + fresh touch → «работает»; open + no task → «свободен»)
 *     — the fixtures carry NO presence field to read (Pitfall 2),
 *   - window bars carry estimated: true (honest labels),
 *   - agedForHours appears ONLY past config.agingHours (both sides of the boundary),
 *   - failed done rows carry {reason, reasonLabel} from REASON_LABELS,
 *   - acceptance («обещано») is carried when the task had one, omitted when it did not.
 */

import { describe, it, expect } from 'vitest'

import { deriveState, derivePresence, parseReceiptSummary } from '../src/front/state.mjs'
import { REASON_LABELS } from '../src/queue/adapter.mjs'

const HOUR = 3600000
const NOW = 1_000_000_000_000

const config = {
  agingHours: 24,
  budget: { monthlyApiCapEur: 50 },
  workers: [
    { id: 'max-1', lane: 'prod', account: { name: 'max-1' } },
    { id: 'max-2', lane: 'prod', account: { name: 'max-2' } },
    { id: 'pro-1', lane: 'research', account: { name: 'pro-1' } },
    { id: 'creator', lane: 'forge', account: { name: 'max-1' } }, // rides max-1's account
  ],
}

/** A window-state function keyed by account name (the plan-05 seam). */
function makeWindows(map: Record<string, any>) {
  return (account: any) => {
    const name = typeof account === 'string' ? account : account?.name
    return map[name] || { pct5h: 10, pctWeek: 20, estimated: true }
  }
}

function mkAdapter(rows: any[]) {
  return { list: async () => rows.slice() }
}

describe('derivePresence — pure truth table (Pitfall 2)', () => {
  it('a CLOSED window → «ждёт окно» even with an active task', () => {
    expect(derivePresence({ windowOpen: false, hasActiveTask: true, pulseAgeSec: 1 })).toBe('ждёт окно')
    expect(derivePresence({ windowOpen: false, hasActiveTask: false })).toBe('ждёт окно')
  })
  it('an OPEN window + active task + fresh touch → «работает»', () => {
    expect(derivePresence({ windowOpen: true, hasActiveTask: true, pulseAgeSec: 5 })).toBe('работает')
  })
  it('an OPEN window with no active task → «свободен»; a stale touch → «свободен»', () => {
    expect(derivePresence({ windowOpen: true, hasActiveTask: false })).toBe('свободен')
    expect(derivePresence({ windowOpen: true, hasActiveTask: true, pulseAgeSec: 9999 })).toBe('свободен')
  })
})

describe('parseReceiptSummary', () => {
  it('reads a structured receipt object', () => {
    expect(parseReceiptSummary({ testsPassed: 12, testsTotal: 12, tscClean: true, guardClean: true })).toEqual({
      testsPassed: 12,
      testsTotal: 12,
      tscClean: true,
      guardClean: true,
    })
  })
  it('returns an all-null summary when there is no receipt', () => {
    expect(parseReceiptSummary(null)).toEqual({
      testsPassed: null,
      testsTotal: null,
      tscClean: null,
      guardClean: null,
    })
  })
})

describe('deriveState — the one-poll payload', () => {
  it('produces the full {kpis, queue, workers, done, spend} shape with honest window bars', async () => {
    const rows = [
      { id: 'BL-1', status: 'queued', lane: 'prod', title: 'a', priority: 0, enqueuedAt: NOW - 1000 },
      { id: 'R-2', status: 'claimed', lane: 'prod', title: 'b', workerId: 'max-1', claimedAt: NOW - 2000, lastTouch: NOW - 2000 },
      { id: 'BL-3', status: 'awaiting_approval', lane: 'prod', title: 'c' },
    ]
    const windows = makeWindows({
      'max-1': { pct5h: 40, pctWeek: 55, estimated: true },
      'max-2': { pct5h: 5, pctWeek: 8, estimated: true },
      'pro-1': { pct5h: 0, pctWeek: 0, estimated: true },
    })
    const usageReader = ({ accountName }: any) => ({ costUsd: accountName === 'max-1' ? 1.5 : 0.25 })

    const payload = await deriveState({ adapter: mkAdapter(rows), windows, config, usageReader, clock: () => NOW })

    expect(Object.keys(payload).sort()).toEqual(['costs', 'done', 'kpis', 'queue', 'spend', 'workers'])
    // kpis
    expect(payload.kpis.workersTotal).toBe(4)
    expect(payload.kpis.workersBusy).toBe(1) // max-1 has the claimed task
    expect(payload.kpis.queued).toBe(1)
    expect(payload.kpis.awaitingApproval).toBe(1)
    expect(payload.kpis.windowsOpen).toBeGreaterThan(0)
    // every worker window bar carries estimated:true
    for (const w of payload.workers) expect(w.window.estimated).toBe(true)
    // the active worker resolves its branch + presence «работает»
    const active = payload.workers.find((w: any) => w.id === 'max-1')
    expect(active.taskId).toBe('R-2')
    expect(active.branch).toBe('wt/R-2')
    expect(active.presence).toBe('работает')
    // queue row carries position, no agedForHours (fresh)
    expect(payload.queue[0]).toMatchObject({ id: 'BL-1', position: 1 })
    expect(payload.queue[0].agedForHours).toBeUndefined()
    // spend strip: deduped accounts (max-1 once) + api-fallback cap
    expect(payload.spend.accounts.map((a: any) => a.name)).toEqual(['max-1', 'max-2', 'pro-1'])
    expect(payload.spend.apiFallback.capEur).toBe(50)
  })

  it('a CLOSED window forces «ждёт окно» even with queued work in that lane', async () => {
    const rows = [{ id: 'BL-9', status: 'queued', lane: 'prod', title: 'x', priority: 0, enqueuedAt: NOW }]
    const windows = makeWindows({ 'max-1': { pct5h: 100, pctWeek: 90, estimated: true, closedUntil: NOW + HOUR } })
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows,
      config: { ...config, workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }] },
      clock: () => NOW,
    })
    expect(payload.workers[0].presence).toBe('ждёт окно')
    expect(payload.workers[0].window.closedUntil).toBe(NOW + HOUR)
  })

  it('agedForHours appears ONLY past config.agingHours (both sides of the boundary)', async () => {
    const windows = makeWindows({})
    const fresh = { id: 'BL-fresh', status: 'queued', lane: 'prod', title: 'f', priority: 0, enqueuedAt: NOW - 23 * HOUR }
    const stuck = { id: 'BL-stuck', status: 'queued', lane: 'prod', title: 's', priority: 0, enqueuedAt: NOW - 30 * HOUR }
    const payload = await deriveState({ adapter: mkAdapter([fresh, stuck]), windows, config, clock: () => NOW })
    const byId = Object.fromEntries(payload.queue.map((q: any) => [q.id, q]))
    expect(byId['BL-fresh'].agedForHours).toBeUndefined() // 23h < 24h boundary
    expect(byId['BL-stuck'].agedForHours).toBe(30) // 30h > 24h → «застряла»
  })

  it('a failed done row carries {reason, reasonLabel} from REASON_LABELS + attemptsCount', async () => {
    const rows = [
      { id: 'BL-f', status: 'failed', lane: 'prod', title: 'boom', failure_reason: 'tests_red', attempt: 3, completedAt: NOW },
    ]
    const ledger = (id: string) =>
      id === 'BL-f'
        ? [
            { taskId: id, attempt: 1, workerId: 'max-1', failureReason: 'agent_error' },
            { taskId: id, attempt: 3, workerId: 'max-1', failureReason: 'tests_red', receiptRef: { testsPassed: 3, testsTotal: 5 } },
          ]
        : []
    const payload = await deriveState({ adapter: mkAdapter(rows), ledger, windows: makeWindows({}), config, clock: () => NOW })
    const d = payload.done[0]
    expect(d.failed.reason).toBe('tests_red')
    expect(d.failed.reasonLabel).toBe(REASON_LABELS['tests_red'])
    expect(d.failed.attemptsCount).toBe(2) // two ledger rows
    expect(d.receipt.testsPassed).toBe(3)
    expect(d.receipt.testsTotal).toBe(5)
  })

  it('acceptance («обещано») is carried on a done row that had one, omitted otherwise', async () => {
    const rows = [
      { id: 'BL-a', status: 'completed', lane: 'prod', title: 'promised', acceptance: 'green targeted tests', completedAt: NOW },
      { id: 'R-b', status: 'completed', lane: 'prod', title: 'roster expedite', completedAt: NOW }, // no acceptance
    ]
    const payload = await deriveState({ adapter: mkAdapter(rows), windows: makeWindows({}), config, clock: () => NOW })
    const byId = Object.fromEntries(payload.done.map((d: any) => [d.id, d]))
    expect(byId['BL-a'].acceptance).toBe('green targeted tests')
    expect('acceptance' in byId['R-b']).toBe(false)
  })
})
