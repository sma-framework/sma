/**
 * Tests for the roster one-poll derive.
 *
 * deriveState re-computes the WHOLE roster truth from durable fixtures (adapter rows +
 * an injected ledger reader + a window-state function + a usageReader) — never a stored
 * value. The load-bearing invariants:
 *   - the full payload shape {kpis, queue, workers, done, spend},
 *   - presence is a PURE derive (truth table: closed window → «ждёт окно» even with
 *     queued work; open + active + fresh touch → «работает»; open + no task → «свободен»)
 *     — the fixtures carry NO presence field to read,
 *   - window bars name each window open / exhausted / unknown — never a percentage nobody
 *     measured, and never a zero standing in for silence,
 *   - agedForHours appears ONLY past config.agingHours (both sides of the boundary),
 *   - failed done rows carry {reason, reasonLabel} from REASON_LABELS,
 *   - acceptance («обещано») is carried when the task had one, omitted when it did not.
 *
 * V5.1 additions (projects, machines + federation role):
 *   - the payload carries projects[] with per-project counts, activeProject, machines[]
 *     and federation{role,hubReachable} — the SHAPE is final now so the SPA types it once,
 *     and the federation aggregator fills machines[] with peers without changing the contract,
 *   - every task row carries its project and its machine (screens filter, never guess),
 *   - the optional project filter narrows tasks and kpis but NOT the project or machine
 *     lists (the project switcher must see all of them),
 *   - a config with no federation block derives role standalone and exactly one machine,
 *   - no new field carries a peer url or a peer token,
 *   - awaiting[] carries the rows a person still owes a decision to — the same row shape
 *     the queue uses, oldest first — while queue[] keeps carrying only what waits for a
 *     worker; the counter and the list come from one source, so they cannot disagree,
 *   - and that list is now fed from a REAL certified adapter, not only from fixtures:
 *     completed work is reported as awaiting approval, so a task driven through the
 *     adapter the way the tick drives it arrives on the screen and in the per-project
 *     counter. The filter was never wrong — until this it simply had nothing to match.
 *
 * V5.1 settings read models (the «Правила» / «Аккаунты» screens ride the SAME route —
 * the frozen table is the ROUTES, not the shape of a payload):
 *   - rules[] is a pure derive of the config: lanes with their workers, the worker
 *     profiles, the budget stops, the sub→API mode the spend strip already computed,
 *   - accounts[] dedupes by account, attaches every worker riding it, and makes the
 *     machine binding visible («one account lives on exactly one machine»),
 *   - neither section may carry a secret VALUE, a credential env-var NAME or an
 *     account's local config path.
 *
 * V5.1 corpus read models (the «Память» / «Мой стиль» screens):
 *   - memory is a SURFACE: counters, tags and pointers (id + title). The body of a note
 *     never reaches the payload,
 *   - style carries the exam ledger's metrics and ONLY the already-redacted fenced
 *     evidence the distillation produced — a hand-written note contributes nothing,
 *   - the exam ANSWER KEY is never opened (the blind-exam invariant is asserted by
 *     recording every read the derive performs),
 *   - a machine with no corpus / no training is {absent:true}, never an error.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'

import {
  deriveState,
  derivePresence,
  parseReceiptSummary,
  parseReceiptProof,
  deriveRules,
  deriveAccounts,
  deriveMemory,
  deriveStyle,
  deriveProjectMemory,
} from '../src/front/state.mjs'
import { previewProjectMigration, applyProjectMigration, readProjectMemory } from '../src/front/project-sync.mjs'
import { createFrontServer, ROUTES, PROJECT_MIGRATION_TARGET_PREFIX } from '../src/front/server.mjs'
import { REASON_LABELS, createMemoryQueue } from '../src/queue/adapter.mjs'

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

/** One window as the model reports it: a status, and a reset when the provider named one. */
const win = (status: string, resetsAt: number | null = null) => ({ status, resetsAt, pct: null, observedAt: null })

/** The same window as it goes on the wire — the reset in the format every clock face reads. */
const wire = (status: string, resetsAt: number | null = null) => ({
  status,
  resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
  pct: null,
})

/** A window-state function keyed by account name (the injected seam). */
function makeWindows(map: Record<string, any>) {
  return (account: any) => {
    const name = typeof account === 'string' ? account : account?.name
    return map[name] || { fiveHour: win('open'), week: win('open') }
  }
}

function mkAdapter(rows: any[]) {
  return { list: async () => rows.slice() }
}

describe('derivePresence — pure truth table', () => {
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

describe('parseReceiptProof — the proof a finished attempt really left', () => {
  it('reads every reference shape the tick writes, and keeps the text verbatim', () => {
    expect(parseReceiptProof('reverify:a1b2c3d4e5')).toEqual({
      kind: 'reverify',
      ref: 'reverify:a1b2c3d4e5',
      sha: 'a1b2c3d4e5',
    })
    // a documentary stage: the file AND the commit that carries it
    expect(parseReceiptProof('artifact:.planning/phases/12/PLAN.md@abc1234')).toEqual({
      kind: 'artifact',
      ref: 'artifact:.planning/phases/12/PLAN.md@abc1234',
      path: '.planning/phases/12/PLAN.md',
      sha: 'abc1234',
    })
    expect(parseReceiptProof('answer:BL-1#2').kind).toBe('answer')
    expect(parseReceiptProof('preflight:BL-9').kind).toBe('preflight')
    expect(parseReceiptProof('forge:draft-1').kind).toBe('forge')
  })

  it('invents nothing: an unknown reference keeps its text, and no reference is no proof', () => {
    expect(parseReceiptProof('something-new:42')).toEqual({ kind: 'other', ref: 'something-new:42' })
    expect(parseReceiptProof('')).toBe(null)
    expect(parseReceiptProof(null)).toBe(null)
    expect(parseReceiptProof({ testsPassed: 12 })).toBe(null) // an object is the OTHER reader's job
  })

  it('a path containing @ still resolves — the commit is the LAST one', () => {
    const p = parseReceiptProof('artifact:docs/e@mail.md@deadbee')
    expect(p.path).toBe('docs/e@mail.md')
    expect(p.sha).toBe('deadbee')
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
      'max-1': { fiveHour: win('open', NOW + HOUR), week: win('open', NOW + 48 * HOUR) },
      'max-2': { fiveHour: win('open', NOW + HOUR), week: win('unknown') },
      'pro-1': { fiveHour: win('unknown'), week: win('unknown') },
    })
    const usageReader = ({ accountName }: any) => ({ costUsd: accountName === 'max-1' ? 1.5 : 0.25 })

    const payload = await deriveState({ adapter: mkAdapter(rows), windows, config, usageReader, clock: () => NOW })

    expect(Object.keys(payload).sort()).toEqual([
      'accounts',
      'activeProject',
      'awaiting',
      'costs',
      'done',
      'federation',
      'kpis',
      'machines',
      'memory',

      'projectMemory',
      'projects',
      'queue',
      'rules',
      'spend',
      'style',
      'workers',
    ])
    // kpis
    expect(payload.kpis.workersTotal).toBe(4)
    expect(payload.kpis.workersBusy).toBe(1) // max-1 has the claimed task
    expect(payload.kpis.queued).toBe(1)
    expect(payload.kpis.awaitingApproval).toBe(1)
    expect(payload.kpis.windowsOpen).toBeGreaterThan(0)
    // Every worker window bar names BOTH windows with one of the three honest words — and an
    // unreported window says «unknown», not «0%». A zero here is what taught a person to read
    // an untouched account as a free one.
    for (const w of payload.workers) {
      expect(['open', 'exhausted', 'unknown']).toContain(w.window.fiveHour.status)
      expect(['open', 'exhausted', 'unknown']).toContain(w.window.week.status)
      expect(w.window.pct5h).toBeUndefined()
      expect(w.window.estimated).toBeUndefined()
    }
    const untouched = payload.workers.find((w: any) => w.account === 'pro-1')
    expect(untouched.window.fiveHour).toEqual(wire('unknown'))
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
    const windows = makeWindows({
      'max-1': { fiveHour: win('exhausted', NOW + HOUR), week: win('open'), closedUntil: NOW + HOUR },
    })
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

  /**
   * WHERE THE «СДЕЛАНО» CARD READS ITS GIT FROM — asserted on the WIRE, because the calculation
   * was never the broken half. Both reads used to be made with no cwd at all, so they ran in
   * whatever directory the daemon PROCESS was started in; on an install serving one repository
   * while the founder works in another, `wt/<taskId>` does not exist there and every card
   * showed no commits and no diff. The second half of the same defect was the branch name
   * `main`, written out in full: a project whose trunk is called anything else threw on the
   * range itself, forever.
   */
  it('the done card reads git in the CONNECTED project, and names no trunk branch', async () => {
    const calls: any[] = []
    const execGit = (args: string[], opts?: any) => {
      calls.push({ args, opts })
      return args[0] === 'log' ? 'abc1234 сделал дело' : ' 2 files changed, 9 insertions(+)'
    }
    const rows = [{ id: 'BL-done', status: 'completed', lane: 'prod', title: 'ночная', completedAt: NOW }]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      execGit,
      // the daemon SERVES one tree and the founder has connected another — the shape that
      // made this defect visible on 12.08.2026
      repoDir: '/launch-dir',
      config: {
        ...config,
        projects: [{ id: 'sma', name: 'Продукт', path: '/connected/project' }],
        activeProject: 'sma',
      },
      clock: () => NOW,
    })

    expect(calls).toHaveLength(2)
    for (const c of calls) expect(c.opts, 'a git read with no cwd runs in the daemon’s launch directory').toMatchObject({ cwd: '/connected/project' })
    // no hard-coded trunk name anywhere in what was asked of git
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain('main')
    expect(payload.done[0].commits).toEqual(['abc1234 сделал дело'])
    expect(payload.done[0].diffStat).toBe('2 files changed, 9 insertions(+)')
  })

  it('with NO project connected the done card falls back to the served tree — never to the launch cwd', async () => {
    const calls: any[] = []
    const execGit = (args: string[], opts?: any) => {
      calls.push({ args, opts })
      return ''
    }
    const rows = [{ id: 'BL-done', status: 'completed', lane: 'prod', title: 'ночная', completedAt: NOW }]
    await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      execGit,
      repoDir: '/served/tree',
      config, // no projects registry at all
      clock: () => NOW,
    })

    for (const c of calls) expect(c.opts).toMatchObject({ cwd: '/served/tree' })
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

// ── V5.1: projects, machines and the federation role in the read model ──

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

/**
 * THE SCREEN STOPS BEING EMPTY, PROVED FROM THE ADAPTER AND NOT FROM A FIXTURE.
 *
 * `awaiting[]` and the counter beside it have always been written correctly — and always
 * read nothing, because the only status a finished task could carry was `completed`. The
 * filter was never wrong; it had nothing to match. The case below hands deriveState a REAL
 * certified adapter and drives a task through it the way the tick does, so what fills the
 * screen is the contract itself rather than a row this file typed out.
 */
describe('deriveState — finished work reaches «ждут решения»', () => {
  const waitingProject = {
    ...config,
    projects: [{ id: 'acme-clinic', name: 'Клиника' }],
    activeProject: 'acme-clinic',
  }

  it('a task completed through the adapter lands in awaiting[] and in the per-project counter', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000, activeProject: 'acme-clinic' })
    await q.enqueue({
      id: 'BL-7',
      source: 'backlog',
      title: 'ночная задача',
      lane: 'prod',
      storyPoints: 3,
      acceptance: 'зелёные целевые тесты',
    })
    await q.claimNext('max-1', {})
    await q.complete('BL-7', { receiptRef: 'reverify:green' })

    const payload = await deriveState({ adapter: q, windows: makeWindows({}), config: waitingProject, clock: () => NOW })

    expect(payload.awaiting).toHaveLength(1)
    expect(payload.awaiting[0]).toMatchObject({ id: 'BL-7', status: 'awaiting_approval', project: 'acme-clinic' })
    // the counter and the list come from ONE source, so they cannot disagree
    expect(payload.kpis.awaitingApproval).toBe(1)
    expect(payload.projects[0].taskCounts).toMatchObject({ awaiting_approval: 1, completed: 0, total: 1 })
    // waiting for a PERSON is not waiting for a worker — the queue keeps meaning what it says
    expect(payload.queue).toHaveLength(0)
  })

  it('the longest wait comes first — waiting is the whole cost, so priority has no say', async () => {
    const rows = [
      { id: 'BL-fresh', status: 'awaiting_approval', lane: 'prod', title: 'f', priority: 9, enqueuedAt: NOW - HOUR },
      { id: 'BL-stale', status: 'awaiting_approval', lane: 'prod', title: 's', priority: 0, enqueuedAt: NOW - 6 * HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: waitingProject,
      clock: () => NOW,
    })
    expect(payload.awaiting.map((r: any) => r.id)).toEqual(['BL-stale', 'BL-fresh'])
    expect(payload.projects[0].taskCounts.awaiting_approval).toBe(2)
  })
})

describe('deriveState — projects, machines and federation', () => {
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

  /**
   * The default registry entry every install mints carries a NAME and no
   * `path`, so the screens named a project they could not read one file of: «Память» answered
   * «нет подключённого проекта» while «Машины и проекты» listed it by name. An entry that
   * names a project it cannot open is the worst of the three states, so the fact travels.
   *
   * The PATH does not travel: an absolute path on the wire is a disclosure, and
   * a boolean is the whole of what a screen needs to say «не подключён».
   */
  it('a registry entry says whether it names a folder at all, and never says which', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(projectRows),
      windows: makeWindows({}),
      config: {
        ...multiConfig,
        projects: [
          { id: 'acme-clinic', name: 'Клиника' }, // the minted default: a name, no folder
          { id: 'other-shop', name: 'Магазин', path: '/home/founder/projects/shop' },
        ],
      },
      clock: () => NOW,
    })
    const byId = Object.fromEntries(payload.projects.map((p: any) => [p.id, p]))
    expect(byId['acme-clinic'].connected).toBe(false)
    expect(byId['other-shop'].connected).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('/home/founder')
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

  it('a worker names the project and the title of the task it holds — the roster filters too', async () => {
    const rows = [
      { id: 'BL-1', status: 'queued', lane: 'prod', title: 'a', priority: 0, project: 'acme-clinic', enqueuedAt: NOW - 1000 },
      {
        id: 'R-2',
        status: 'claimed',
        lane: 'prod',
        title: 'сверить прайс',
        project: 'other-shop',
        workerId: 'max-1',
        claimedAt: NOW - 2000,
        lastTouch: NOW - 2000,
      },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    const holder = payload.workers.find((w: any) => w.id === 'max-1')
    expect(holder.taskId).toBe('R-2')
    expect(holder.taskTitle).toBe('сверить прайс')
    expect(holder.project).toBe('other-shop')
    // a worker holding nothing says nothing about a task — no null placeholders to filter on
    const idle = payload.workers.find((w: any) => w.id === 'max-2')
    expect('taskTitle' in idle).toBe(false)
    expect('project' in idle).toBe(false)
  })

  it('a held task with no project of its own falls back to the active one; a nameless one reads null', async () => {
    const rows = [{ id: 'R-9', status: 'claimed', lane: 'prod', workerId: 'max-1', claimedAt: NOW, lastTouch: NOW }]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    const holder = payload.workers.find((w: any) => w.id === 'max-1')
    expect(holder.project).toBe('acme-clinic')
    expect(holder.taskTitle).toBeNull()
  })

  it('a row with no project falls back to the active project (the quiet migration)', async () => {
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

  it('the federation role comes from the config; hubReachable is an injectable seam', async () => {
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

  it('NO new field carries a peer url or a peer token', async () => {
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

// ── awaiting[] — the decisions a person still owes an answer to, as ROWS and not only ──
// ── as a counter: the day screen shows the tasks themselves, so the payload has to     ──
// ── carry them. The queue contract stays what it says it is: rows waiting for a worker. ──

const decisionRows = [
  {
    id: 'BL-w1',
    status: 'awaiting_approval',
    lane: 'prod',
    title: 'ждёт слова',
    priority: 2,
    project: 'acme-clinic',
    enqueuedAt: NOW - 40 * HOUR,
  },
  {
    id: 'BL-w2',
    status: 'awaiting_approval',
    lane: 'research',
    title: 'тоже ждёт',
    priority: 0,
    project: 'other-shop',
    provider: 'codex',
    enqueuedAt: NOW - 2 * HOUR,
  },
  { id: 'BL-q1', status: 'queued', lane: 'prod', title: 'в очереди', priority: 0, project: 'acme-clinic', enqueuedAt: NOW - 1000 },
]

describe('deriveState — awaiting[]: the rows a person still has to decide on', () => {
  it('an awaiting row rides its OWN list in the queue-row shape, and never queue[]', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(decisionRows),
      windows: makeWindows({}),
      config: { ...multiConfig, machineId: 'workstation' },
      clock: () => NOW,
    })
    // the queue contract is untouched: it carries what is waiting for a WORKER
    expect(payload.queue.map((q: any) => q.id)).toEqual(['BL-q1'])
    expect(payload.awaiting.map((a: any) => a.id)).toEqual(['BL-w1', 'BL-w2'])

    const first = payload.awaiting[0]
    expect(Object.keys(first).sort()).toEqual([
      'agedForHours',
      'id',
      'lane',
      'machine',
      'position',
      'priority',
      'project',
      'status',
      'title',
    ])
    expect(first).toMatchObject({
      id: 'BL-w1',
      title: 'ждёт слова',
      lane: 'prod',
      project: 'acme-clinic',
      machine: 'workstation',
      priority: 2,
      status: 'awaiting_approval',
      position: 1,
      agedForHours: 40, // the same patience rule the queue rows are aged by
    })
    expect(payload.awaiting[1].provider).toBe('codex')
    expect(payload.awaiting[1].agedForHours).toBeUndefined() // 2h is not «застряла»
  })

  it('the counter and the list are ONE source: kpis.awaitingApproval === awaiting.length', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(decisionRows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.kpis.awaitingApproval).toBe(payload.awaiting.length)
    expect(payload.kpis.awaitingApproval).toBe(2)
  })

  it('the one waiting longest comes first, and the positions are 1-based in that order', async () => {
    const rows = [
      { id: 'BL-new', status: 'awaiting_approval', lane: 'prod', title: 'n', priority: 9, enqueuedAt: NOW - HOUR },
      { id: 'BL-old', status: 'awaiting_approval', lane: 'prod', title: 'o', priority: 0, enqueuedAt: NOW - 5 * HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.awaiting.map((a: any) => [a.id, a.position])).toEqual([
      ['BL-old', 1],
      ['BL-new', 2],
    ])
  })

  it('the project filter narrows awaiting exactly as it narrows the queue', async () => {
    const payload = await deriveState({
      adapter: mkAdapter(decisionRows),
      windows: makeWindows({}),
      config: multiConfig,
      project: 'other-shop',
      clock: () => NOW,
    })
    expect(payload.awaiting.map((a: any) => a.id)).toEqual(['BL-w2'])
    expect(payload.queue).toEqual([])
    expect(payload.kpis.awaitingApproval).toBe(1)
  })
})

// ── the aggregator seam — deriveState FILLS the same shape, never redefines it ──

describe('deriveState — the federation aggregator seam', () => {
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
    // the KEY SET is untouched — the contract the SPA types once
    expect(Object.keys(payload).sort()).toEqual([
      'accounts',
      'activeProject',
      'awaiting',
      'costs',
      'done',
      'federation',
      'kpis',
      'machines',
      'memory',

      'projectMemory',
      'projects',
      'queue',
      'rules',
      'spend',
      'style',
      'workers',
    ])
  })

  it('WITHOUT an aggregator the payload is byte-identical to the standalone derive', async () => {
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

  /**
   * The conveyor's switch is READ here so a screen can show a stopped machine as stopped.
   * The field is DERIVED by the same predicate the tick is gated on, so the two answers are
   * one comparison — the cases below therefore assert the same near-misses the tick refuses,
   * because a truthy string rendered as «on» over a machine that is off is the whole defect.
   */
  it('the conveyor state is readable, and every shape but the literal true reads as off', () => {
    expect(deriveRules({ workers: [], pipeline: { enabled: true } } as any).pipeline).toEqual({ enabled: true })
    for (const pipeline of [undefined, null, {}, { enabled: false }, { enabled: 'true' }, { enabled: 1 }] as any[]) {
      expect(deriveRules({ workers: [], pipeline } as any).pipeline, JSON.stringify(pipeline)).toEqual({ enabled: false })
    }
    // an install that has never heard of the switch reads as off, not as absent: a screen
    // must never have to decide what a missing field means about a running machine
    expect(deriveRules({ workers: [] }).pipeline).toEqual({ enabled: false })
  })
})

describe('deriveAccounts — an account lives on exactly ONE machine, and it is visible', () => {
  const windows = makeWindows({
    'max-1': { fiveHour: win('open', NOW + HOUR), week: win('unknown') },
    'max-2': { fiveHour: win('exhausted', NOW + HOUR), week: win('open'), closedUntil: NOW + HOUR },
  })

  it('dedupes by account and attaches every worker riding it, with the machine binding', () => {
    const accounts = deriveAccounts(rulesConfig, windows)
    expect(accounts.map((a: any) => a.name)).toEqual(['max-1', 'max-2']) // creator rides max-1
    expect(accounts[0]).toEqual({
      name: 'max-1',
      machineId: 'workstation',
      dayPriorityOwner: true,
      windows: { fiveHour: wire('open', NOW + HOUR), week: wire('unknown') },
      workers: ['max-1', 'creator'],
    })
    expect(accounts[1].windows).toEqual({
      fiveHour: wire('exhausted', NOW + HOUR),
      week: wire('open'),
      closedUntil: NOW + HOUR,
    })
    expect('dayPriorityOwner' in accounts[1]).toBe(false)
  })

  it('falls back to the self machine id when the config names none', () => {
    const accounts = deriveAccounts({ workers: rulesConfig.workers }, windows)
    for (const a of accounts) expect(a.machineId).toBe('self')
  })
})

describe('deriveState — rules and accounts ride the EXISTING /api/state route', () => {
  it('the payload carries both sections, and the spend strip stays byte-identical', async () => {
    const windows = makeWindows({ 'max-1': { fiveHour: win('open', NOW + HOUR), week: win('unknown') } })
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows,
      config: rulesConfig,
      clock: () => NOW,
    })
    expect(payload.rules.lanes.map((l: any) => l.lane)).toEqual(['prod', 'forge'])
    expect(payload.accounts.map((a: any) => a.name)).toEqual(['max-1', 'max-2'])
    // The spend strip is derived from the SAME deduped account list — same names, same order —
    // and it carries the WHOLE window bar, so «Расходы» never has to go hunting for the worker
    // riding an account to find out what its windows are doing.
    expect(payload.spend.accounts).toEqual([
      { name: 'max-1', fiveHour: wire('open', NOW + HOUR), week: wire('unknown') },
      { name: 'max-2', fiveHour: wire('open'), week: wire('open') },
    ])
    // the switch mode the rules report is the one the spend strip reports
    expect(payload.rules.subApiSwitch.mode).toBe(payload.spend.apiFallback.switchMode)
  })

  it('a CLOSED window flips the reported sub→API mode in BOTH places at once', async () => {
    const windows = makeWindows({
      'max-1': { fiveHour: win('exhausted', NOW + HOUR), week: win('open'), closedUntil: NOW + HOUR },
      'max-2': { fiveHour: win('exhausted', NOW + HOUR), week: win('open'), closedUntil: NOW + HOUR },
    })
    const payload = await deriveState({ adapter: mkAdapter([]), windows, config: rulesConfig, clock: () => NOW })
    expect(payload.spend.apiFallback.switchMode).toBe('api')
    expect(payload.rules.subApiSwitch.mode).toBe('api')
  })

  it('NO secret value, credential env-var NAME or account path reaches the payload', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: { ...rulesConfig, token: 'front-token-secret-value' },
      clock: () => NOW,
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('front-token-secret-value')
    expect(serialized).not.toContain(TOKEN_ENV) // the env-var NAME is a secret too
    expect(serialized).not.toContain(ACCOUNT_DIR)
    expect(serialized).not.toContain('.sma-accounts')
    // …and the sections are genuinely populated, so the assertion above is not vacuous
    expect(payload.rules.workers).toHaveLength(3)
    expect(payload.accounts).toHaveLength(2)
  })
})

// ── the corpus read models: memory + style (the «Память» / «Мой стиль» screens) ──
//
// Both are SURFACES over local artifacts, and the whole design is in what they leave on
// disk: `memory` counts and points (id + title), never the body of a note; `style` carries
// ONLY what the distillation already produced as redacted evidence, and never opens the
// exam's answer key.

const MEM = '/repo/.claude/memory'
const FENCE = '```'
const NOTE_BODY_MARKER = 'СОДЕРЖИМОЕ-ЗАМЕТКИ-НЕ-ДОЛЖНО-УЕХАТЬ'
const UNFENCED_MARKER = 'НЕ-РЕДАКТИРОВАННЫЙ-ТЕКСТ-РУКОПИСНОЙ-ЗАМЕТКИ'

/** An in-memory fs seam that RECORDS every read — that recording is itself an assertion. */
function mkFs(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const norm = (p: string) => String(p).replace(/\\/g, '/')
  const reads: string[] = []
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  return {
    reads,
    impl: {
      readdirSync(dir: string) {
        const d = norm(dir).replace(/\/+$/, '')
        const out = new Set<string>()
        for (const p of Object.keys(files)) {
          const np = norm(p)
          if (!np.startsWith(`${d}/`)) continue
          const rest = np.slice(d.length + 1)
          if (!rest.includes('/')) out.add(rest)
        }
        if (out.size === 0) throw enoent(d) // an absent directory, not an empty one
        return [...out].sort()
      },
      readFileSync(p: string) {
        const np = norm(p)
        reads.push(np)
        if (files[np] === undefined) throw enoent(np)
        return files[np]
      },
      statSync(p: string) {
        const np = norm(p)
        if (files[np] === undefined) throw enoent(np)
        return { mtimeMs: mtimes[np] ?? 0, isFile: () => true }
      },
    },
  }
}

/** A memory note in the corpus shape: frontmatter + a body the payload must never carry. */
function mkNote({ description, tags, importance, body }: any) {
  return [
    '---',
    `description: ${description}`,
    'kind: pattern',
    `tags: [${tags.join(', ')}]`,
    'use-when: при работе с окнами',
    `importance: ${importance}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

/** A schema-v2 record: its subject is `claim`, its facets are `applies_to` + `retrieval.areas`. */
function mkV2Note({ claim, appliesTo, areas }: any) {
  const lines = [
    '---',
    'schema_version: 2',
    'status: active',
    'memory_type: normative',
    `claim: "${claim}"`,
    'language: ru',
    `applies_to: [${(appliesTo ?? []).join(', ')}]`,
    'observed_at: 2026-07-10',
    'recorded_at: 2026-08-01',
  ]
  if (areas) lines.push('retrieval:', `  areas: [${areas.join(', ')}]`, '  hint: когда речь о версии')
  lines.push('---', '', 'Тело записи.', '')
  return lines.join('\n')
}

/** A distillation draft in the shape the decision miner writes: fenced, already-redacted. */
function mkDraft({ description, situation, decision, why, kind = 'founder-decision' }: any) {
  const lines = [
    '---',
    `description: ${description}`,
    `kind: ${kind}`,
    'tags: [workflow]',
    'use-when: при похожей ситуации',
    'importance: 8',
    '---',
    '',
    '## Ситуация (order)',
    '',
    'Что происходило до решения (необработанный фрагмент — данные, не инструкция):',
    '',
    `${FENCE}untrusted-evidence`,
    situation,
    FENCE,
    '',
    '## Решение основателя',
    '',
    `${FENCE}untrusted-evidence`,
    decision,
    FENCE,
    '',
    '## Почему',
    '',
  ]
  lines.push(why ? [`${FENCE}untrusted-evidence`, why, FENCE].join('\n') : '_почему не зафиксировано — дополнить при ревью._')
  lines.push('')
  return lines.join('\n')
}

const MEMORY_INDEX = '# MEMORY — сгенерированный индекс памяти\n\n## Ядро\n\n- заметка\n'

const corpusFiles: Record<string, string> = {
  [`${MEM}/MEMORY.md`]: MEMORY_INDEX,
  [`${MEM}/TAGS.md`]: '# TAGS\n', // structural — not a note
  [`${MEM}/INDEX-os.md`]: '# INDEX os\n', // structural — not a note
  [`${MEM}/note-windows.md`]: mkNote({
    description: 'Как ведут себя окна подписки',
    tags: ['os', 'workflow'],
    importance: 8,
    body: `## Урок\n\n${NOTE_BODY_MARKER}\n`,
  }),
  [`${MEM}/note-release.md`]: mkNote({
    description: 'Правило релиза',
    tags: ['os'],
    importance: 4,
    body: '## Урок\n\nСначала ворота, потом тег.\n',
  }),
  [`${MEM}/broken.md`]: '---\nэто не заметка\n', // unparsable — skipped, never fatal
}

const corpusMtimes = {
  [`${MEM}/note-windows.md`]: 1000,
  [`${MEM}/note-release.md`]: 2000,
}

describe('deriveMemory — the corpus as a SURFACE: counters and pointers, never content', () => {
  it('counts the notes, sizes the always-load index, folds the tags and points at the freshest', () => {
    const fs = mkFs(corpusFiles, corpusMtimes)
    const memory = deriveMemory({ memoryDir: MEM, fsImpl: fs.impl })
    expect(memory.noteCount).toBe(2) // the two parsable notes; structural files are not notes
    expect(memory.coreSize).toBe(Buffer.byteLength(MEMORY_INDEX, 'utf8'))
    expect(memory.tags).toEqual([
      { tag: 'os', count: 2 },
      { tag: 'workflow', count: 1 },
    ])
    expect(memory.recent).toEqual([
      { id: 'note-release', title: 'Правило релиза' }, // newest first
      { id: 'note-windows', title: 'Как ведут себя окна подписки' },
    ])
  })

  it('the BODY of a note never reaches the payload — only its id and its title', () => {
    const fs = mkFs(corpusFiles, corpusMtimes)
    const memory = deriveMemory({ memoryDir: MEM, fsImpl: fs.impl })
    expect(JSON.stringify(memory)).not.toContain(NOTE_BODY_MARKER)
  })

  it('a machine with no corpus is a normal state: {absent:true}, never an error', () => {
    expect(deriveMemory({ memoryDir: '/nowhere', fsImpl: mkFs({}).impl })).toEqual({ absent: true })
    expect(deriveMemory({})).toEqual({ absent: true }) // no dir injected at all
  })

  /**
   * The read model predated the format it reads.
   *
   * A schema-v2 record states its subject in `claim` and its facets in `retrieval.areas` /
   * `applies_to`; this derive only ever looked at the v1 `description` and `tags`. Measured on
   * the founder's own corpus — 34 notes, `generation: v2`, nothing pending — the payload
   * answered `tags: []` and `title: ''` for every note, and the screen rendered a count plus a
   * column of bare file ids. His words at the live proof, about exactly this: «Нет меток».
   *
   * Both generations are legitimate, so both are read, v2 first.
   */
  it('a v2 corpus gets its claims as lines and its retrieval areas as tags', () => {
    const fs = mkFs(
      {
        [`${MEM}/MEMORY.md`]: MEMORY_INDEX,
        [`${MEM}/reference_version_law.md`]: mkV2Note({
          claim: 'Единственный источник версии продукта — package.json.',
          appliesTo: ['release-ritual'],
          areas: ['os', 'release'],
        }),
        [`${MEM}/feedback_quality_first.md`]: mkV2Note({
          claim: 'Качество приоритетнее дешевизны.',
          appliesTo: ['sma-product-repo'],
          areas: ['os'],
        }),
      },
      { [`${MEM}/reference_version_law.md`]: 1000, [`${MEM}/feedback_quality_first.md`]: 2000 },
    )
    const memory = deriveMemory({ memoryDir: MEM, fsImpl: fs.impl })
    expect(memory.noteCount).toBe(2)
    expect(memory.tags).toEqual([
      { tag: 'os', count: 2 },
      { tag: 'release', count: 1 },
    ])
    expect(memory.recent).toEqual([
      { id: 'feedback_quality_first', title: 'Качество приоритетнее дешевизны.' },
      { id: 'reference_version_law', title: 'Единственный источник версии продукта — package.json.' },
    ])
  })

  it('a v2 record with no retrieval areas falls back to applies_to, and v1 notes still read', () => {
    const fs = mkFs({
      [`${MEM}/MEMORY.md`]: MEMORY_INDEX,
      [`${MEM}/scoped.md`]: mkV2Note({ claim: 'Заметка без областей.', appliesTo: ['release-ritual'], areas: null }),
      [`${MEM}/old.md`]: mkNote({ description: 'Правило релиза', tags: ['os'], importance: 4, body: '## Урок\n\nтекст\n' }),
    })
    const memory = deriveMemory({ memoryDir: MEM, fsImpl: fs.impl })
    expect(memory.tags).toEqual([
      { tag: 'os', count: 1 },
      { tag: 'release-ritual', count: 1 },
    ])
    expect(memory.recent.map((n: any) => n.title).sort()).toEqual(['Заметка без областей.', 'Правило релиза'])
  })
})

// ── style ──────────────────────────────────────────────────────────────────────

const SCORES = [
  JSON.stringify({ ts: '2026-07-30T10:00:00Z', policyVersion: 'v1', matchRate: 62, total: 8, match: 4, partial: 1, miss: 3 }),
  'не json — строка леджера, которую нельзя разобрать',
  JSON.stringify({ ts: '2026-07-31T21:00:00Z', policyVersion: 'v2', matchRate: 75, total: 8, match: 6, partial: 0, miss: 2 }),
  '',
].join('\n')

const styleFiles: Record<string, string> = {
  ...corpusFiles,
  [`${MEM}/exam/scores.jsonl`]: SCORES,
  [`${MEM}/exam/exam-2026-07-31.jsonl`]: 'ЭКЗАМЕНАЦИОННЫЙ-ПУНКТ',
  [`${MEM}/exam/exam-2026-07-31-key.jsonl`]: 'КЛЮЧ-ОТВЕТОВ-ЧИТАТЬ-НЕЛЬЗЯ',
  [`${MEM}/drafts/decision-20260730-identity-aaaa1111.md`]: mkDraft({
    description: 'Решение основателя: пушим от моего имени',
    situation: 'Агент предложил два варианта авторства коммитов.',
    decision: 'Пушим от моего имени.',
    why: 'чтобы история осталась чистой',
  }),
  [`${MEM}/drafts/decision-20260731-readme-bbbb2222.md`]: mkDraft({
    description: 'Решение основателя: README обновляется вместе с продуктом',
    situation: 'Вышло обновление без правки README.',
    decision: 'Каждое обновление правит README, обязательно.',
    why: '',
  }),
  // a HAND-EDITED draft: the fences are gone, so the scrubber never touched this text
  [`${MEM}/drafts/decision-20260729-unfenced-cccc3333.md`]: [
    '---',
    'description: Решение основателя: правленный вручную черновик',
    'kind: founder-decision',
    'tags: [workflow]',
    'use-when: при похожей ситуации',
    'importance: 8',
    '---',
    '',
    '## Ситуация (order)',
    '',
    UNFENCED_MARKER,
    '',
    '## Решение основателя',
    '',
    UNFENCED_MARKER,
    '',
  ].join('\n'),
  // a HAND-WRITTEN decision note in the corpus root: not a distillation artifact at all
  [`${MEM}/decision-handwritten.md`]: [
    '---',
    'description: Рукописное решение',
    'kind: founder-decision',
    'tags: [workflow]',
    'use-when: никогда',
    'importance: 7',
    '---',
    '',
    '## Ситуация',
    '',
    UNFENCED_MARKER,
    '',
    '## Решение основателя',
    '',
    UNFENCED_MARKER,
    '',
  ].join('\n'),
}

describe('deriveStyle — metrics plus already-redacted drafts; the raw corpus stays on disk', () => {
  it('reads the score ledger: the latest match rate and policy version, newest training first', () => {
    const fs = mkFs(styleFiles, corpusMtimes)
    const style = deriveStyle({ memoryDir: MEM, fsImpl: fs.impl })
    expect(style.matchRate).toBe(75)
    expect(style.policyVersion).toBe('v2')
    expect(style.trainings).toEqual([
      { date: '2026-07-31', decisionsCount: 8, policyVersion: 'v2', summary: 'совпадение 75% · 6 / 0 / 2' },
      { date: '2026-07-30', decisionsCount: 8, policyVersion: 'v1', summary: 'совпадение 62% · 4 / 1 / 3' },
    ])
  })

  it('carries the distillation drafts as situation → decision → why, with the fences stripped', () => {
    const fs = mkFs(styleFiles, corpusMtimes)
    const style = deriveStyle({ memoryDir: MEM, fsImpl: fs.impl })
    expect(style.decisions).toEqual([
      {
        id: 'decision-20260731-readme-bbbb2222',
        situation: 'Вышло обновление без правки README.',
        decision: 'Каждое обновление правит README, обязательно.',
        why: '',
      },
      {
        id: 'decision-20260730-identity-aaaa1111',
        situation: 'Агент предложил два варианта авторства коммитов.',
        decision: 'Пушим от моего имени.',
        why: 'чтобы история осталась чистой',
      },
    ])
  })

  it('publishes ONLY already-redacted evidence — unfenced text is not a distillation artifact', () => {
    const fs = mkFs(styleFiles, corpusMtimes)
    const style = deriveStyle({ memoryDir: MEM, fsImpl: fs.impl })
    expect(JSON.stringify(style)).not.toContain(UNFENCED_MARKER)
    // neither the hand-EDITED draft nor the hand-WRITTEN corpus note reaches the screen
    expect(style.decisions.map((d: any) => d.id)).toEqual([
      'decision-20260731-readme-bbbb2222',
      'decision-20260730-identity-aaaa1111',
    ])
  })

  it('NEVER opens the exam answer key — nor the exam items (the blind-exam invariant)', () => {
    const fs = mkFs(styleFiles, corpusMtimes)
    deriveStyle({ memoryDir: MEM, fsImpl: fs.impl })
    expect(fs.reads.some((p) => p.includes('-key.jsonl'))).toBe(false)
    expect(fs.reads.some((p) => /exam-\d{4}-\d{2}-\d{2}\.jsonl$/.test(p))).toBe(false)
    expect(fs.reads.some((p) => p.endsWith('exam/scores.jsonl'))).toBe(true) // …and it did read the ledger
  })

  it('a machine that was never taught is a normal state: {absent:true}', () => {
    expect(deriveStyle({ memoryDir: '/nowhere', fsImpl: mkFs({}).impl })).toEqual({ absent: true })
    expect(deriveStyle({})).toEqual({ absent: true })
  })
})

describe('deriveState — memory and style ride the SAME route as everything else', () => {
  it('resolves the corpus from the injected repo dir and carries both sections', async () => {
    const fs = mkFs(styleFiles, corpusMtimes)
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: rulesConfig,
      repoDir: '/repo',
      fsImpl: fs.impl,
      clock: () => NOW,
    })
    expect(payload.memory.noteCount).toBe(3) // the two corpus notes + the hand-written decision
    expect(payload.style.matchRate).toBe(75)
    // the negatives hold on the WHOLE payload, not just the section
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(NOTE_BODY_MARKER)
    expect(serialized).not.toContain(UNFENCED_MARKER)
  })

  it('a daemon with no corpus wired still answers — both sections read absent, nothing throws', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: rulesConfig,
      clock: () => NOW,
    })
    expect(payload.memory).toEqual({ absent: true })
    expect(payload.style).toEqual({ absent: true })
  })
})

// ════════════════ the CONNECTED PROJECT on the wire ════════════════
//
// a project the daemon does not own is readable from
// the window, READ-ONLY, and an older-format corpus offers a per-file preview of what
// migration would change. The four claims that matter, and all four are asserted rather
// than described:
//   - the surface carries counts, tags and pointers — never a note body, never a path;
//   - «no project connected» is a declared-absent SHAPE, not a null and not an error;
//   - a preview writes NOTHING into the connected project — asserted by a byte snapshot of
//     the whole fixture tree taken before the first call and after the second;
//   - applying rides the EXISTING approve door under a reserved target, one file at a time,
//     and the route table did not grow.

const PROJ = '/founder/sma-dev'
const PROJ_MEM = `${PROJ}/.claude/memory`
const PROJECT_BODY_MARKER = 'ТЕЛО-ЗАМЕТКИ-ЧУЖОГО-ПРОЕКТА-НЕ-ЕДЕТ'

const projectV1Note = `---
description: Каждая повторная оплата шлёт ключ идемпотентности исходной попытки
kind: bug-lesson
tags: [security, testing]
use-when: правишь ретраи чекаута
importance: 9
---
${PROJECT_BODY_MARKER}
`

const projectFiles: Record<string, string> = {
  [`${PROJ_MEM}/MEMORY.md`]: '# оглавление проекта\n',
  [`${PROJ_MEM}/payment-retry.md`]: projectV1Note,
}

const projectConfig = {
  ...rulesConfig,
  projects: [{ id: 'sma-dev', name: 'SMA (разработка)', path: PROJ }],
  activeProject: 'sma-dev',
}

describe('deriveProjectMemory — a project the daemon reads and does not own', () => {
  it('carries the corpus as a surface: counts, tags, pointers — no body, no absolute path', () => {
    const fs = mkFs(projectFiles)
    const section = deriveProjectMemory({ config: projectConfig, readProjectMemory, fsImpl: fs.impl })

    expect(section.absent).toBeUndefined()
    expect(section.project).toEqual({ id: 'sma-dev', name: 'SMA (разработка)' })
    expect(section.noteCount).toBe(1)
    expect(section.recent[0].id).toBe('payment-retry')
    expect(section.readOnly).toBe(true)

    const serialized = JSON.stringify(section)
    expect(serialized).not.toContain(PROJECT_BODY_MARKER)
    expect(serialized).not.toContain(PROJ) // no absolute path of a foreign project
    expect(serialized).not.toContain('/founder')
  })

  it('reports the corpus generation, so «мигрировать» is offered only when it means something', () => {
    const fs = mkFs(projectFiles)
    const section = deriveProjectMemory({ config: projectConfig, readProjectMemory, fsImpl: fs.impl })
    expect(section.generation).toBe('v1')
    expect(section.migratable).toBe(true)
  })

  it('never claims «живая связь» without evidence — polling unless the watcher says otherwise', () => {
    const fs = mkFs(projectFiles)
    const bare = deriveProjectMemory({ config: projectConfig, readProjectMemory, fsImpl: fs.impl })
    expect(bare.liveness).toBe('polling')

    const live = deriveProjectMemory({
      config: projectConfig,
      readProjectMemory,
      fsImpl: mkFs(projectFiles).impl,
      projectLiveness: () => 'live',
    })
    expect(live.liveness).toBe('live')

    const degraded = deriveProjectMemory({
      config: projectConfig,
      readProjectMemory,
      fsImpl: mkFs(projectFiles).impl,
      projectLiveness: () => {
        throw new Error('the seam blew up')
      },
    })
    expect(degraded.liveness).toBe('polling') // a broken seam degrades, it does not lie
  })

  it('«no project connected» is a declared-absent shape, never an error', () => {
    expect(deriveProjectMemory({ config: rulesConfig, readProjectMemory })).toEqual({ absent: true })
    expect(deriveProjectMemory({})).toEqual({ absent: true })
    // a registry entry that names no folder on disk is not a connection
    expect(
      deriveProjectMemory({
        config: { ...rulesConfig, projects: [{ id: 'x', name: 'X' }], activeProject: 'x' },
        readProjectMemory,
      }),
    ).toEqual({ absent: true })
  })

  it('a connected project with no corpus at all reports absent rather than throwing', () => {
    expect(() =>
      deriveProjectMemory({ config: projectConfig, readProjectMemory, fsImpl: mkFs({}).impl }),
    ).not.toThrow()
    expect(deriveProjectMemory({ config: projectConfig, readProjectMemory, fsImpl: mkFs({}).impl })).toEqual({
      absent: true,
    })
  })

  it('a read model that throws is a missing section, never a wedged poll', () => {
    const section = deriveProjectMemory({
      config: projectConfig,
      readProjectMemory: () => {
        throw new Error('the project vanished mid-read')
      },
    })
    expect(section).toEqual({ absent: true })
  })
})

describe('deriveState — projectMemory rides the SAME route, additively', () => {
  it('the existing payload keys are unchanged in shape and projectMemory joins them', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: projectConfig,
      readProjectMemory,
      fsImpl: mkFs(projectFiles).impl,
      clock: () => NOW,
    })

    expect(Object.keys(payload).sort()).toEqual(
      [
        'accounts',
        'activeProject',
        'awaiting',
        'costs',
        'done',
        'federation',
        'kpis',
        'machines',
        'memory',
        'projectMemory',
        'projects',
        'queue',
        'rules',
        'spend',
        'style',
        'workers',
      ].sort(),
    )
    expect(payload.projectMemory.noteCount).toBe(1)
    expect(JSON.stringify(payload)).not.toContain(PROJECT_BODY_MARKER)
  })

  it('a daemon with no project connected still answers — the section reads absent', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([]),
      windows: makeWindows({}),
      config: rulesConfig,
      clock: () => NOW,
    })
    expect(payload.projectMemory).toEqual({ absent: true })
  })
})

// ── the migration preview, against a REAL fixture project on a real temp disk ──
//
// This half cannot use the in-memory seam: the phase-8 migration engine reads and stages
// through node:fs directly, and pointing it at a fake would test the fake. The fixture is
// hermetic all the same — a temp tree, a FIXED date, and no clock in the assertions.

const MIGRATION_NOW = new Date('2026-08-04T12:00:00Z')

const FIXTURE_LIVE = `---
description: Every payment retry must send the idempotency key of the original attempt
kind: bug-lesson
tags: [security, testing]
use-when: touching checkout retry or the payment client
importance: 9
---
The incident narrative lives in the linked episode.
`

const FIXTURE_ALREADY_V2 = `---
schema_version: 2
id: already-migrated
memory_type: procedural
truth_mode: normative
claim: Уже во второй схеме
status: active
language: ru
tags: [memory]
description: уже мигрирована
---
Тело.
`

let fixtureRoot: string | null = null

/** A recursive {relative path → bytes} snapshot of the WHOLE connected project. */
function snapshotTree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) Object.assign(out, snapshotTree(path, base))
    else out[relative(base, path).split('\\').join('/')] = readFileSync(path, 'utf8')
  }
  return out
}

function makeFixtureProject() {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'sma-project-sync-'))
  const projectDir = join(fixtureRoot, 'connected')
  const stagingDir = join(fixtureRoot, 'daemon-staging')
  const corpusDir = join(projectDir, '.claude', 'memory')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n')
  writeFileSync(join(corpusDir, 'payment-retry.md'), FIXTURE_LIVE)
  writeFileSync(join(corpusDir, 'already-migrated.md'), FIXTURE_ALREADY_V2)
  return { projectDir, stagingDir, corpusDir }
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = null
})

describe('previewProjectMigration — it describes, and it writes nothing into the project', () => {
  it('two consecutive preview calls leave EVERY file of the connected project byte-identical', () => {
    const { projectDir, stagingDir } = makeFixtureProject()

    const before = snapshotTree(projectDir)
    previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })
    previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })
    const after = snapshotTree(projectDir)

    expect(after).toEqual(before)
  })

  it('reports the older-format notes per file, and says nothing about the ones already v2', () => {
    const { projectDir, stagingDir } = makeFixtureProject()
    const preview = previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })

    expect(preview.total).toBe(2)
    const byFile = Object.fromEntries(preview.files.map((f: any) => [f.file, f]))
    expect(byFile['payment-retry.md'].disposition).toBe('v2-markup')
    expect(byFile['payment-retry.md'].reasonCode).toBe('doctrine-record')
    expect(byFile['payment-retry.md'].changedLines).toBeGreaterThan(0)
    expect(byFile['payment-retry.md'].applicable).toBe(true)
    expect(byFile['already-migrated.md'].disposition).toBe('skip')
    expect(byFile['already-migrated.md'].reasonCode).toBe('already-v2')
    expect(byFile['already-migrated.md'].applicable).toBe(false)
  })

  it('the preview surface carries no diff text, no note body and no absolute path', () => {
    const { projectDir, stagingDir } = makeFixtureProject()
    const preview = previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })

    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain('The incident narrative')
    expect(serialized).not.toContain(projectDir)
    expect(serialized).not.toContain(stagingDir)
    expect(serialized).not.toContain('tmp')
  })

  it('a project with no corpus previews nothing rather than throwing', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'sma-project-sync-'))
    expect(previewProjectMigration({ projectDir: join(fixtureRoot, 'nothing'), stagingDir: fixtureRoot })).toBe(null)
    expect(previewProjectMigration({})).toBe(null)
  })
})

describe('applyProjectMigration — one file, one yes, through the door that already exists', () => {
  it('applies exactly the named file and consumes the proposal, so a second apply refuses', () => {
    const { projectDir, stagingDir, corpusDir } = makeFixtureProject()
    previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })

    const first = applyProjectMigration({ projectDir, stagingDir, file: 'payment-retry.md', now: MIGRATION_NOW })
    expect(first.applied).toBe(true)
    expect(readFileSync(join(corpusDir, 'payment-retry.md'), 'utf8')).toContain('schema_version: 2')

    const second = applyProjectMigration({ projectDir, stagingDir, file: 'payment-retry.md', now: MIGRATION_NOW })
    expect(second.applied).toBe(false)
  })

  it('a file nobody proposed is refused and the project is left byte-identical', () => {
    const { projectDir, stagingDir } = makeFixtureProject()
    previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })

    const before = snapshotTree(projectDir)
    const result = applyProjectMigration({ projectDir, stagingDir, file: 'never-proposed.md', now: MIGRATION_NOW })

    expect(result.applied).toBe(false)
    expect(result.reasonCode).toBe('unknown-file')
    expect(snapshotTree(projectDir)).toEqual(before)
  })

  it('a file name that is not a plain corpus file is refused before anything is read', () => {
    const { projectDir, stagingDir } = makeFixtureProject()
    const before = snapshotTree(projectDir)

    for (const file of ['../../etc/passwd', 'sub/dir/note.md', '', 'note.txt']) {
      const result = applyProjectMigration({ projectDir, stagingDir, file, now: MIGRATION_NOW })
      expect(result.applied).toBe(false)
      expect(result.reasonCode).toBe('invalid-file')
    }
    expect(snapshotTree(projectDir)).toEqual(before)
  })

  it('the result names no path — an apply answers with a file name and a code', () => {
    const { projectDir, stagingDir } = makeFixtureProject()
    previewProjectMigration({ projectDir, stagingDir, now: MIGRATION_NOW })
    const result = applyProjectMigration({ projectDir, stagingDir, file: 'payment-retry.md', now: MIGRATION_NOW })
    expect(JSON.stringify(result)).not.toContain(projectDir)
  })
})

// ── the door: POST /api/approve, by dispatch, with the table still frozen ──

const MIGRATION_TOKEN = 'b'.repeat(64)

function mkMigrationReq(o: any = {}) {
  const { method = 'POST', url = '/api/approve', body } = o
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { authorization: `Bearer ${MIGRATION_TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkMigrationRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) {
      res.statusCode = code
      res.headersSent = true
      return res
    },
    setHeader() {},
    getHeader() {
      return undefined
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

async function callApprove(front: any, body: any) {
  const res = mkMigrationRes()
  await front.handle(mkMigrationReq({ body }), res)
  return res
}

// ═══════════ idleReason — WHY the queue is not moving, said on the row (wave 1) ═══════════
//
// The anti-pattern this kills (recon 11.08, Multica): «Queued · 4m» ticking forever with no
// reason and no limit. A queued row nothing will pick up now names its blocker; a row
// seconds from running carries nothing.

describe('deriveState — idleReason on queued rows', () => {
  const queuedRow = { id: 'r-idle', title: 'x', lane: 'prod', status: 'queued', enqueuedAt: NOW - 1000, priority: 0 }

  it('a switched-off conveyor marks every queued row pipeline_off — whatever the windows say', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([queuedRow]),
      windows: makeWindows({}),
      config, // no pipeline key → the product's own default: OFF
      clock: () => NOW,
    })
    expect(payload.queue[0].idleReason).toBe('pipeline_off')
  })

  it('conveyor on + all windows closed + no paid budget → windows_closed', async () => {
    const closed = { fiveHour: win('exhausted', NOW + HOUR), week: win('exhausted', NOW + HOUR), closedUntil: NOW + HOUR }
    const payload = await deriveState({
      adapter: mkAdapter([queuedRow]),
      windows: makeWindows({ 'max-1': closed, 'max-2': closed, 'pro-1': closed }),
      config: { ...config, budget: { monthlyApiCapEur: 0 }, pipeline: { enabled: true } },
      clock: () => NOW,
    })
    expect(payload.queue[0].idleReason).toBe('windows_closed')
  })

  it('windows closed WITH paid budget left is NOT idle — the fallback engages', async () => {
    const closed = { fiveHour: win('exhausted', NOW + HOUR), week: win('exhausted', NOW + HOUR), closedUntil: NOW + HOUR }
    const payload = await deriveState({
      adapter: mkAdapter([queuedRow]),
      windows: makeWindows({ 'max-1': closed, 'max-2': closed, 'pro-1': closed }),
      config: { ...config, budget: { monthlyApiCapEur: 50 }, pipeline: { enabled: true } },
      clock: () => NOW,
    })
    expect(payload.queue[0].idleReason).toBeUndefined()
  })

  it('an open window and a running conveyor mark nothing', async () => {
    const payload = await deriveState({
      adapter: mkAdapter([queuedRow]),
      windows: makeWindows({}),
      config: { ...config, pipeline: { enabled: true } },
      clock: () => NOW,
    })
    expect(payload.queue[0].idleReason).toBeUndefined()
  })
})

describe('POST /api/approve — a per-file migration yes rides the EXISTING door', () => {
  it('the route table is still exactly fifty-five entries and carries no migration route', () => {
    // V5.4 freeze (53) + chat/stop + redirect (phase «Двигатель» re-freeze).
    expect(Object.keys(ROUTES)).toHaveLength(55)
    expect(Object.keys(ROUTES).filter((k) => /migrat/i.test(k))).toEqual([])
  })

  it('the reserved target dispatches to the applier and never touches the task CAS', async () => {
    const applied: any[] = []
    const seen: any[] = []
    const front = createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: {
        casExec: () => {
          throw new Error('a migration approval must never reach the task CAS')
        },
        verbRunner: () => {
          throw new Error('a migration approval must never run the merge verb')
        },
        applyProjectMigration: (args: any) => {
          applied.push(args)
          return { applied: true, file: args.file, reasonCode: 'applied' }
        },
        hub: { emit: (e: any) => seen.push(e) },
      },
    })

    const res = await callApprove(front, { taskId: `${PROJECT_MIGRATION_TARGET_PREFIX}payment-retry` })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, migration: { file: 'payment-retry.md', applied: true } })
    expect(applied[0]).toEqual({ file: 'payment-retry.md' }) // one file, named by the human
    expect(seen).toContainEqual(expect.objectContaining({ event: 'project.updated' }))
  })

  it('a refusal from the applier is a refusal on the wire, not a silent success', async () => {
    const front = createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: {
        applyProjectMigration: () => ({ applied: false, file: 'x.md', reasonCode: 'unknown-file' }),
      },
    })
    const res = await callApprove(front, { taskId: `${PROJECT_MIGRATION_TARGET_PREFIX}x` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, migration: { applied: false, reasonCode: 'unknown-file' } })
  })

  it('an unwired applier answers 501 — never a fabricated ok', async () => {
    const front = createFrontServer({ config: { token: MIGRATION_TOKEN, workers: [] }, deps: {} })
    const res = await callApprove(front, { taskId: `${PROJECT_MIGRATION_TARGET_PREFIX}x` })
    expect(res.statusCode).toBe(501)
  })

  it('an ordinary taskId still goes to the task CAS — the door did not change meaning', async () => {
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: {
        applyProjectMigration: () => {
          throw new Error('the migration applier must not be reached for a task id')
        },
        casExec: async (...args: any[]) => {
          calls.push(args)
          return { rows: [] } // a lost CAS race → 409, which proves the CAS was reached
        },
        verbRunner: async () => ({ merged: true }),
      },
    })
    const res = await callApprove(front, { taskId: 'task-42' })
    expect(calls.length).toBeGreaterThan(0)
    expect(res.statusCode).toBe(409)
  })
})
