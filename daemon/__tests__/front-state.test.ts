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
 *
 * V5.1 additions (D-9.7-01 projects, D-9.7-04 machines + federation role):
 *   - the payload carries projects[] with per-project counts, activeProject, machines[]
 *     and federation{role,hubReachable} — the SHAPE is final now so the SPA types it once,
 *     and plan 9.7-13 fills machines[] with peers without changing the contract,
 *   - every task row carries its project and its machine (screens filter, never guess),
 *   - the optional project filter narrows tasks and kpis but NOT the project or machine
 *     lists (the project switcher must see all of them),
 *   - a config with no federation block derives role standalone and exactly one machine,
 *   - no new field carries a peer url or a peer token.
 *
 * V5.1 settings read models (the «Правила» / «Аккаунты» screens ride the SAME route —
 * the frozen table is the ROUTES, not the shape of a payload):
 *   - rules[] is a pure derive of the config: lanes with their workers, the worker
 *     profiles, the budget stops, the sub→API mode the spend strip already computed,
 *   - accounts[] dedupes by account, attaches every worker riding it, and makes the
 *     machine binding visible («one account lives on exactly one machine»),
 *   - neither section may carry a secret VALUE, a credential env-var NAME or an
 *     account's local config path.
 */

import { describe, it, expect } from 'vitest'

import { deriveState, derivePresence, parseReceiptSummary, deriveRules, deriveAccounts } from '../src/front/state.mjs'
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

    expect(Object.keys(payload).sort()).toEqual([
      'accounts',
      'activeProject',
      'costs',
      'done',
      'federation',
      'kpis',
      'machines',
      'projects',
      'queue',
      'rules',
      'spend',
      'workers',
    ])
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

// ── V5.1: projects, machines and the federation role in the read model (D-9.7-01/04) ──

const multiConfig = {
  ...config,
  projects: [
    { id: 'acme-clinic', name: 'Клиника' },
    { id: 'other-shop', name: 'Магазин' },
  ],
  activeProject: 'acme-clinic',
}

const projectRows = [
  { id: 'BL-1', status: 'queued', lane: 'prod', title: 'a', priority: 0, project: 'acme-clinic', enqueuedAt: NOW - 1000 },
  { id: 'BL-2', status: 'queued', lane: 'prod', title: 'b', priority: 0, project: 'other-shop', enqueuedAt: NOW - 900 },
  { id: 'BL-3', status: 'completed', lane: 'prod', title: 'c', project: 'other-shop', completedAt: NOW },
]

describe('deriveState — projects, machines and federation (D-9.7-01, D-9.7-04)', () => {
  it('carries projects[] with per-project counts and the active project', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.activeProject).toBe('acme-clinic')
    expect(payload.projects.map((p: any) => p.id)).toEqual(['acme-clinic', 'other-shop'])
    const byId = Object.fromEntries(payload.projects.map((p: any) => [p.id, p]))
    expect(byId['acme-clinic'].name).toBe('Клиника')
    expect(byId['acme-clinic'].taskCounts).toMatchObject({ queued: 1, total: 1 })
    expect(byId['other-shop'].taskCounts).toMatchObject({ queued: 1, completed: 1, total: 2 })
  })

  it('every task row carries its project and its machine — screens filter, never guess', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: { ...multiConfig, machineId: 'workstation' },
      clock: () => NOW,
    })
    for (const row of payload.queue) {
      expect(typeof row.project).toBe('string')
      expect(row.machine).toBe('workstation')
    }
    for (const row of payload.done) {
      expect(typeof row.project).toBe('string')
      expect(row.machine).toBe('workstation')
    }
  })

  it('a row with no project falls back to the active project (the quiet migration, D-9.7-08)', async () => {
    const legacy = [{ id: 'BL-old', status: 'queued', lane: 'prod', title: 'old', priority: 0, enqueuedAt: NOW }]
    const payload = await deriveState({
      adapter: mkAdapter(legacy),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.queue[0].project).toBe('acme-clinic')
  })

  it('the project filter narrows tasks and kpis but NOT the project or machine lists', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: multiConfig,
      project: 'other-shop',
      clock: () => NOW,
    })
    expect(payload.queue.map((q: any) => q.id)).toEqual(['BL-2'])
    expect(payload.done.map((d: any) => d.id)).toEqual(['BL-3'])
    expect(payload.kpis.queued).toBe(1)
    // the switcher must still see every project and every machine
    expect(payload.projects).toHaveLength(2)
    expect(payload.machines).toHaveLength(1)
    expect(payload.projects.find((p: any) => p.id === 'acme-clinic').taskCounts.total).toBe(1)
  })

  it('a config with NO federation block derives role standalone and exactly one machine', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.federation).toEqual({ role: 'standalone', hubReachable: true })
    expect(payload.machines).toEqual([{ id: 'self', title: 'Эта машина', role: 'self', online: true }])
  })

  it('the federation role comes from the config; hubReachable is an injectable seam for 9.7-13', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: {
        ...multiConfig,
        machineId: 'mac-mini',
        machineTitle: 'Mac mini',
        federation: { role: 'peer', peers: [{ id: 'hub', url: 'http://10.0.0.9:7777', token: 'peer-secret-value' }] },
      },
      hubReachable: false,
      clock: () => NOW,
    })
    expect(payload.federation).toEqual({ role: 'peer', hubReachable: false })
    expect(payload.machines).toEqual([{ id: 'mac-mini', title: 'Mac mini', role: 'self', online: true }])
  })

  it('NO new field carries a peer url or a peer token (T-9.7-05)', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: {
        ...multiConfig,
        federation: { role: 'hub', peers: [{ id: 'mac-mini', url: 'http://10.0.0.4:7777', token: 'peer-secret-value' }] },
      },
      clock: () => NOW,
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('peer-secret-value')
    expect(serialized).not.toContain('10.0.0.4')
    expect(payload.federation.role).toBe('hub')
  })
})

// ── 9.7-13: the aggregator seam — deriveState FILLS the same shape, never redefines it ──

describe('deriveState — the federation aggregator seam (D-9.7-01, plan 9.7-13)', () => {
  /** A fake aggregator standing in for createFederation().aggregateState. */
  function fakeAggregator(payload: any) {
    return {
      ...payload,
      machines: [...payload.machines, { id: 'mac-mini', title: 'Mac mini', role: 'peer', online: true, lastSeenSec: 3 }],
      queue: [...payload.queue, { id: 'BL-peer', title: 'p', status: 'queued', project: 'shop', machine: 'mac-mini', position: 1 }],
      kpis: { ...payload.kpis, queued: payload.kpis.queued + 1 },
    }
  }

  it('an injected aggregator fills machines[] and pours in the peers’ rows', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: { ...multiConfig, machineId: 'this-pc', federation: { role: 'hub', peers: [] } },
      aggregator: fakeAggregator,
      clock: () => NOW,
    })
    expect(payload.machines.map((m: any) => [m.id, m.role])).toEqual([
      ['this-pc', 'self'],
      ['mac-mini', 'peer'],
    ])
    expect(payload.queue.map((q: any) => q.machine)).toEqual(['this-pc', 'this-pc', 'mac-mini'])
    expect(payload.kpis.queued).toBe(3)
    // the KEY SET is untouched — the 9.7-02 contract the SPA types once
    expect(Object.keys(payload).sort()).toEqual([
      'accounts',
      'activeProject',
      'costs',
      'done',
      'federation',
      'kpis',
      'machines',
      'projects',
      'queue',
      'rules',
      'spend',
      'workers',
    ])
  })

  it('WITHOUT an aggregator the payload is byte-identical to the standalone derive (regression 9.7-02)', async () => {
    const args = { adapter: mkAdapter(projectRows), windows: makeWindows({}), config: multiConfig, clock: () => NOW }
    const standalone = await deriveState(args)
    const withUndefined = await deriveState({ ...args, aggregator: undefined })
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(standalone))
    expect(standalone.machines).toEqual([{ id: 'self', title: 'Эта машина', role: 'self', online: true }])
  })

  it('an aggregator that THROWS is fail-open: the founder still sees their own machine', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: multiConfig,
      aggregator: () => {
        throw new Error('peer storm')
      },
      clock: () => NOW,
    })
    expect(payload.machines).toEqual([{ id: 'self', title: 'Эта машина', role: 'self', online: true }])
    expect(payload.queue.map((q: any) => q.id)).toEqual(['BL-1', 'BL-2'])
  })

  it('an aggregator that returns junk is ignored (the local payload is never replaced by it)', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: multiConfig,
      aggregator: () => null,
      clock: () => NOW,
    })
    expect(payload.machines).toHaveLength(1)
    expect(payload.kpis.queued).toBe(2)
  })
})

// ── the settings read models: rules + accounts (the «Правила» / «Аккаунты» screens) ──
//
// Both are PURE derives of the config (plus the same window seam the roster already rides).
// The load-bearing invariant is negative: neither section may carry a secret VALUE, a
// credential env-var NAME, or an account's local config path — the payload leaves the
// machine over the LAN, the config never does.

const TOKEN_ENV = 'SMA_MAX_1_TOKEN'
const ACCOUNT_DIR = '/home/founder/.sma-accounts/max-1'

const maxOne = { name: 'max-1', configDir: ACCOUNT_DIR, oauthTokenEnv: TOKEN_ENV }
const maxTwo = { name: 'max-2', configDir: '/home/founder/.sma-accounts/max-2', oauthTokenEnv: 'SMA_MAX_2_TOKEN' }

const rulesConfig = {
  agingHours: 24,
  machineId: 'workstation',
  budget: { monthlyApiCapEur: 50, warnPct: [70, 90] },
  workers: [
    { id: 'max-1', lane: 'prod', provider: 'claude', model: 'opus', effort: 'high', account: maxOne, dayPriorityOwner: true, enabled: true },
    { id: 'max-2', lane: 'prod', provider: 'claude', model: 'sonnet', effort: 'medium', account: maxTwo, enabled: false },
    { id: 'creator', lane: 'forge', provider: 'claude', account: maxOne, enabled: true }, // rides max-1's account
  ],
}

describe('deriveRules — the «Правила» screen rides the config, never a stored field', () => {
  it('groups the lanes with their workers, in config order', () => {
    const rules = deriveRules(rulesConfig)
    expect(rules.lanes).toEqual([
      { lane: 'prod', workers: ['max-1', 'max-2'] },
      { lane: 'forge', workers: ['creator'] },
    ])
  })

  it('carries the worker profile — provider/model/effort/enabled — and the account by NAME', () => {
    const rules = deriveRules(rulesConfig)
    const byId = Object.fromEntries(rules.workers.map((w: any) => [w.id, w]))
    expect(byId['max-1']).toEqual({
      id: 'max-1',
      lane: 'prod',
      account: 'max-1',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      enabled: true,
    })
    expect(byId['max-2'].enabled).toBe(false) // the roster toggle is visible, not guessed
    // a profile the config does not carry is OMITTED, never invented as null
    expect('model' in byId['creator']).toBe(false)
    expect('effort' in byId['creator']).toBe(false)
  })

  it('carries the budget stops when the config has them, and omits the section when it does not', () => {
    expect(deriveRules(rulesConfig).budgetStops).toEqual({ monthlyApiCapEur: 50, warnPct: [70, 90] })
    expect('budgetStops' in deriveRules({ workers: [] })).toBe(false)
  })

  it('the sub→API switch reports the mode the spend strip already computed — one truth', () => {
    expect(deriveRules(rulesConfig, { switchMode: 'subscription' }).subApiSwitch).toEqual({
      mode: 'subscription',
      capEur: 50,
      budgeted: true,
    })
    expect(deriveRules(rulesConfig, { switchMode: 'api' }).subApiSwitch.mode).toBe('api')
    // no cap set → no API fallback is budgeted at all
    expect(deriveRules({ workers: [] }).subApiSwitch).toEqual({ mode: 'subscription', capEur: 0, budgeted: false })
  })
})

describe('deriveAccounts — an account lives on exactly ONE machine, and it is visible', () => {
  const windows = makeWindows({
    'max-1': { pct5h: 40, pctWeek: 55, estimated: true },
    'max-2': { pct5h: 100, pctWeek: 90, estimated: false, closedUntil: NOW + HOUR },
  })

  it('dedupes by account and attaches every worker riding it, with the machine binding', () => {
    const accounts = deriveAccounts(rulesConfig, windows)
    expect(accounts.map((a: any) => a.name)).toEqual(['max-1', 'max-2']) // creator rides max-1
    expect(accounts[0]).toEqual({
      name: 'max-1',
      machineId: 'workstation',
      dayPriorityOwner: true,
      windows: { pct5h: 40, pctWeek: 55, estimated: true },
      workers: ['max-1', 'creator'],
    })
    expect(accounts[1].windows).toEqual({ pct5h: 100, pctWeek: 90, estimated: false, closedUntil: NOW + HOUR })
    expect('dayPriorityOwner' in accounts[1]).toBe(false)
  })

  it('falls back to the self machine id when the config names none', () => {
    const accounts = deriveAccounts({ workers: rulesConfig.workers }, windows)
    for (const a of accounts) expect(a.machineId).toBe('self')
  })
})

describe('deriveState — rules and accounts ride the EXISTING /api/state route (D-9.7-09)', () => {
  it('the payload carries both sections, and the spend strip stays byte-identical', async () => {
    const windows = makeWindows({ 'max-1': { pct5h: 40, pctWeek: 55, estimated: true } })
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows,
      config: rulesConfig,
      clock: () => NOW,
    })
    expect(payload.rules.lanes.map((l: any) => l.lane)).toEqual(['prod', 'forge'])
    expect(payload.accounts.map((a: any) => a.name)).toEqual(['max-1', 'max-2'])
    // the spend strip is derived from the SAME deduped account list — same names, same order
    expect(payload.spend.accounts).toEqual([
      { name: 'max-1', pct5h: 40, pctWeek: 55 },
      { name: 'max-2', pct5h: 10, pctWeek: 20 },
    ])
    // the switch mode the rules report is the one the spend strip reports
    expect(payload.rules.subApiSwitch.mode).toBe(payload.spend.apiFallback.switchMode)
  })

  it('a CLOSED window flips the reported sub→API mode in BOTH places at once', async () => {
    const windows = makeWindows({
      'max-1': { pct5h: 100, pctWeek: 90, estimated: true, closedUntil: NOW + HOUR },
      'max-2': { pct5h: 100, pctWeek: 90, estimated: true, closedUntil: NOW + HOUR },
    })
    const payload = await deriveState({ adapter: mkAdapter([]), windows, config: rulesConfig, clock: () => NOW })
    expect(payload.spend.apiFallback.switchMode).toBe('api')
    expect(payload.rules.subApiSwitch.mode).toBe('api')
  })

  it('NO secret value, credential env-var NAME or account path reaches the payload (T-9.7-36)', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: { ...rulesConfig, token: 'front-token-secret-value' },
      clock: () => NOW,
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('front-token-secret-value')
    expect(serialized).not.toContain(TOKEN_ENV) // the env-var NAME is a secret too (T-9.5-01)
    expect(serialized).not.toContain(ACCOUNT_DIR)
    expect(serialized).not.toContain('.sma-accounts')
    // …and the sections are genuinely populated, so the assertion above is not vacuous
    expect(payload.rules.workers).toHaveLength(3)
    expect(payload.accounts).toHaveLength(2)
  })
})
