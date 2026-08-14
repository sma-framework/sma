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

import { describe, it, expect, afterEach, afterAll } from 'vitest'
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
import { readWaveHolds } from '../src/queue/wave-holds.mjs'
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

    // `batches` joined the top level with the third kind of unit of work: one request of the
    // owner and the pieces it was broken into. Always present, empty where there is none — a
    // key that appears only once something exists reads on a screen as «no such thing».
    expect(Object.keys(payload).sort()).toEqual([
      'accounts',
      'activeProject',
      'awaiting',
      'batches',
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
      'waves',
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
   * СКОЛЬКО ЗАНЯЛО — the length of a finished task, from the two marks the ledger already had.
   *
   * The list printed «—» in the length column of every completed task, and the reading was one
   * field away the whole time: the attempt that closed the work put down when it started and
   * when it ended. Both cases assert the field in the ROW the door sends, because a length
   * computed and not handed over is exactly the state this was in.
   */
  it('a finished task states how long it took — from the two marks of the attempt that closed it', async () => {
    const rows = [{ id: 'BL-done', status: 'completed', lane: 'prod', title: 'ночная', completedAt: NOW }]
    const ledger = () => [
      // an earlier attempt that did not finish the work: the hours the task then spent back in
      // the queue are NOT part of how long the work took, so the closing attempt is measured
      { taskId: 'BL-done', attempt: 1, workerId: 'max-1', startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR },
      { taskId: 'BL-done', attempt: 2, workerId: 'max-1', startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR },
    ]
    const payload = await deriveState({ adapter: mkAdapter(rows), ledger, windows: makeWindows({}), config, clock: () => NOW })
    expect(payload.done[0].finishedDuration).toBe(HOUR)
  })

  it('one mark, or none, is NO length — never a zero and never «measured against now»', async () => {
    const rows = [{ id: 'BL-half', status: 'completed', lane: 'prod', title: 'ночная', completedAt: NOW }]
    const started = () => [{ taskId: 'BL-half', attempt: 1, workerId: 'max-1', startedAt: NOW - HOUR }]
    const one = await deriveState({ adapter: mkAdapter(rows), ledger: started, windows: makeWindows({}), config, clock: () => NOW })
    // a zero here renders as «заняло нисколько», which is a claim; «нечего мерить» is the truth
    expect(one.done[0].finishedDuration).toBe(null)

    // a task with no ledger rows at all (reconstructed after the fact) says the same
    const none = await deriveState({ adapter: mkAdapter(rows), windows: makeWindows({}), config, clock: () => NOW })
    expect(none.done[0].finishedDuration).toBe(null)
  })

  /**
   * ПОДХОДОВ СТОЛЬКО, СКОЛЬКО ИХ БЫЛО — and the fixture is the whole point of these three.
   *
   * The live ledger writes TWO rows for one attempt: the state machine puts down the
   * transition, the tick puts down who ran it and how it ended. Every suite that counted
   * attempts was green because its fake wrote ONE row per attempt — a shape production never
   * produces — so a card showed «6 подходов» over three tries. The fixture below is the live
   * shape, row for row.
   */
  const liveLedgerRows = (taskId: string) => {
    const rows: any[] = []
    for (const n of [1, 2, 3]) {
      // (a) the transition row: no worker on it, and it is the one carrying the start mark
      rows.push({
        taskId,
        attempt: n,
        startedAt: NOW - (4 - n) * HOUR,
        outcome: n < 3 ? 'failed' : 'completed',
        ...(n < 3 ? { failureReason: 'tests_red' } : {}),
      })
      // (b) the tick's row for the SAME attempt: who ran it, on what, and when it ended
      rows.push({
        taskId,
        attempt: n,
        workerId: 'max-1',
        provider: 'claude',
        endedAt: NOW - (4 - n) * HOUR + HOUR,
        receiptRef: 'reverify:green',
      })
    }
    return rows
  }

  it('three tries written as six rows are counted as THREE — on the done row and the failed one', async () => {
    const rows = [
      { id: 'BL-six', status: 'completed', lane: 'prod', title: 'три подхода', completedAt: NOW },
      { id: 'BL-red', status: 'failed', lane: 'prod', title: 'три подхода и красный', failure_reason: 'tests_red', completedAt: NOW },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      ledger: (id: string) => liveLedgerRows(id),
      windows: makeWindows({}),
      config,
      clock: () => NOW,
    })
    const byId: any = Object.fromEntries(payload.done.map((d: any) => [d.id, d]))
    expect(byId['BL-six'].attempts).toBe(3)
    expect(byId['BL-red'].failed.attemptsCount).toBe(3)
  })

  it('the door of one task lists one entry per try, never the same try twice', async () => {
    const front = createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: {
        adapter: { list: async () => [{ id: 'BL-six', title: 'три подхода', lane: 'prod', status: 'completed', attempt: 3 }] },
        ledger: (id: string) => liveLedgerRows(id),
        parseReceiptSummary,
      },
    })
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ method: 'GET', url: '/api/task/BL-six' }), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.attempts.map((a: any) => a.attempt)).toEqual([1, 2, 3])
    // the two rows of one try are ONE entry, and it carries what each of them wrote
    expect(out.attempts[2]).toMatchObject({ workerId: 'max-1', provider: 'claude', outcome: 'completed' })
  })

  it('the length of a try survives the merge — the two marks live on its two rows', async () => {
    const rows = [{ id: 'BL-six', status: 'completed', lane: 'prod', title: 'три подхода', completedAt: NOW }]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      ledger: (id: string) => liveLedgerRows(id),
      windows: makeWindows({}),
      config,
      clock: () => NOW,
    })
    // the closing try started on one row and ended on the other; merged, it is an hour long
    expect(payload.done[0].finishedDuration).toBe(HOUR)
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

  /**
   * ═══════════ THE HONEST DURATION HAS TO ARRIVE AT THE DOOR, NOT MERELY EXIST ═══════════
   *
   * The queue now keeps two clocks apart: the moment an attempt was taken, and the moment its
   * lease was last renewed. Before that, the renewal moved the only clock there was, so a task
   * that had been running for hours reported about zero — and the number on the screen was not a
   * measurement of anything. Computing the fact is half the sentence; these two cases assert the
   * OTHER half — that it reaches the payload the window reads, from a real certified adapter
   * driven the way the tick drives it.
   */
  it('a running task states when it was taken — from a real adapter, through to the payload', async () => {
    const t = { now: NOW - 3 * HOUR }
    const q = createMemoryQueue({ clock: () => t.now, expireMs: 120000 })
    await q.enqueue({ id: 'R-77', source: 'roster', title: 'долгая работа', lane: 'prod' })
    await q.claimNext('daemon', {})
    await q.assignWorker('R-77', 'max-1')
    // three hours of work later the tick renews the lease, as it does every couple of minutes
    t.now = NOW - 60000
    await q.touch('R-77')
    t.now = NOW

    const payload = await deriveState({ adapter: q, windows: makeWindows({}), config, clock: () => NOW })

    const holder = payload.workers.find((w: any) => w.id === 'max-1')
    expect(holder.taskId).toBe('R-77')
    // measured from the CLAIM: three hours, not the minute since the last renewal
    expect(holder.taskClaimedAt).toBe(NOW - 3 * HOUR)
    // and the sign of life still comes from the renewal — the two answer different questions
    expect(holder.pulseAgeSec).toBe(60)
  })

  it('a task row carries both clocks, and states NULL where the queue does not know — never a zero', async () => {
    const rows = [
      { id: 'BL-1', status: 'queued', lane: 'prod', title: 'a', priority: 0, enqueuedAt: NOW - 1000, claimedAt: null, leaseRenewedAt: null },
      {
        id: 'BL-2',
        status: 'awaiting_approval',
        lane: 'prod',
        title: 'b',
        enqueuedAt: NOW - 5000,
        claimedAt: NOW - 4000,
        leaseRenewedAt: NOW - 2000,
      },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config,
      clock: () => NOW,
    })

    const [queued] = payload.queue
    expect('claimedAt' in queued).toBe(true) // the key is there to be read, holding a null
    expect(queued.claimedAt).toBeNull()
    expect(queued.leaseRenewedAt).toBeNull()

    const [waiting] = payload.awaiting
    expect(waiting.claimedAt).toBe(NOW - 4000)
    expect(waiting.leaseRenewedAt).toBe(NOW - 2000)
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
    // the two marks deliberately disagree: it sat in the queue for 40 hours, and it has been
    // waiting for a PERSON for six of them — the second number is the one a decision is aged by
    completedAt: NOW - 6 * HOUR,
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
      // the two clocks of the attempt this row's work was done in: when it was taken and when
      // its lease was last renewed. Both ride EVERY task row, holding null where the queue does
      // not know, so one row shape answers «how long» on every list that uses it.
      'claimedAt',
      'id',
      'lane',
      'leaseRenewedAt',
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
      agedForHours: 6, // hours spent waiting for a PERSON, from the mark the work stopped at
    })
    expect(payload.awaiting[1].provider).toBe('codex')
    // the second row was never marked as stopped, so its age is not stated at all
    expect(payload.awaiting[1].agedForHours).toBeUndefined()
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

  /**
   * СКОЛЬКО ОНА УЖЕ ЖДЁТ ЧЕЛОВЕКА — the one reading three screens ask for and nobody computed.
   *
   * The age of a decision starts WHEN THE WORK STOPPED, and the queue already writes that
   * mark: `completedAt` is put down at the transition into «ждёт решения» by both backends.
   * It is asserted on the DOOR'S ANSWER rather than on a helper, because the whole defect was
   * a number that existed nowhere in the payload the screens read.
   */
  it('a waiting row states its age from the moment the work stopped — in fractional hours', async () => {
    const rows = [
      {
        id: 'BL-just-stopped',
        status: 'awaiting_approval',
        lane: 'prod',
        title: 'встала 40 минут назад',
        priority: 0,
        enqueuedAt: NOW - 9 * HOUR,
        completedAt: NOW - 40 * 60000,
      },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    // fractional, NOT floored: the screens turn anything under an hour into minutes themselves,
    // and a floor here would hand every fresh decision the word «ноль часов».
    expect(payload.awaiting[0].agedForHours).toBeCloseTo(40 / 60, 5)
    // …and no patience threshold stands in front of it: waiting for a PERSON is the whole cost,
    // so there is no span of it that is «не считается» the way a fresh queue row is.
    expect(payload.awaiting[0].agedForHours).toBeGreaterThan(0)
  })

  it('a row whose stop was never marked says NOTHING about its age', async () => {
    const rows = [
      // reconstructed after the fact: nobody wrote down when it stopped
      { id: 'BL-nomark', status: 'awaiting_approval', lane: 'prod', title: 'без отметки', priority: 0, enqueuedAt: NOW - 40 * HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    // a zero would read as «остановилась только что», which is a claim about work nobody watched
    expect(payload.awaiting[0].agedForHours).toBeUndefined()
  })

  it('the age of a decision is not the claim clock, not the lease clock and not the queue clock', async () => {
    const rows = [
      {
        id: 'BL-far-apart',
        status: 'awaiting_approval',
        lane: 'prod',
        title: 'все часы врозь',
        priority: 0,
        enqueuedAt: NOW - 50 * HOUR, // when it was put in the queue
        claimedAt: NOW - 30 * HOUR, // when a worker took it
        leaseRenewedAt: NOW - 29 * HOUR, // when the worker last said it lived
        completedAt: NOW - 3 * HOUR, // when it STOPPED and started waiting for a person
      },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.awaiting[0].agedForHours).toBeCloseTo(3, 5)
  })

  it('the longest wait comes first by the STOP mark, and falls back to the queue mark without one', async () => {
    const rows = [
      { id: 'BL-a', status: 'awaiting_approval', lane: 'prod', title: 'a', priority: 9, enqueuedAt: NOW - 40 * HOUR, completedAt: NOW - HOUR },
      { id: 'BL-b', status: 'awaiting_approval', lane: 'prod', title: 'b', priority: 0, enqueuedAt: NOW - 2 * HOUR, completedAt: NOW - 6 * HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.awaiting.map((a: any) => [a.id, a.position])).toEqual([
      ['BL-b', 1],
      ['BL-a', 2],
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

// ── ОДНА ЗАДАЧА — ОДНА СТРОКА, ЖДУЩАЯ СЛОВА ───────────────────────────────────────────────
//
// A returned task is put back under its OWN id, and a durable queue keeps the previous row
// beside the new one. Filtering the rows by status therefore counted one task as two for the
// whole span of the return: «ЖДУТ ВАС: 2» over a single piece of work, one of the two lines
// nameless. The fix is not a second definition of «which row wins» — it is the queue's OWN
// rule, applied here, so the queue and the screen cannot answer about a re-enqueued task
// differently.

describe('deriveState — a returned task is ONE task, in every point of the cycle', () => {
  it('while it is being redone it is not waiting for a word at all', async () => {
    const rows = [
      // the row it stopped on, and the row the return put back — the same task, twice
      { id: 'BL-ret', status: 'awaiting_approval', lane: 'prod', title: 'собери отчёт', priority: 0, enqueuedAt: NOW - 9 * HOUR, completedAt: NOW - 3 * HOUR },
      { id: 'BL-ret', status: 'queued', lane: 'prod', title: 'собери отчёт', priority: 0, source: 'return', enqueuedAt: NOW - HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    // the LAST word about it is «в работе», so it owes nobody a decision right now
    expect(payload.awaiting.map((a: any) => a.id)).toEqual([])
    expect(payload.kpis.awaitingApproval).toBe(0)
  })

  it('once it is redone and standing for approval it is ONE line, under its own name', async () => {
    const rows = [
      { id: 'BL-ret', status: 'awaiting_approval', lane: 'prod', title: 'собери отчёт', priority: 0, enqueuedAt: NOW - 9 * HOUR, completedAt: NOW - 5 * HOUR },
      { id: 'BL-ret', status: 'awaiting_approval', lane: 'prod', title: 'собери отчёт', priority: 0, source: 'return', enqueuedAt: NOW - HOUR, completedAt: NOW - 2 * HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    expect(payload.awaiting).toHaveLength(1)
    expect(payload.awaiting[0]).toMatchObject({ id: 'BL-ret', title: 'собери отчёт', status: 'awaiting_approval' })
    // the counter reads the very same list, so it is right for the same reason
    expect(payload.kpis.awaitingApproval).toBe(1)
  })

  it('a task that was never returned is read exactly as before — one row, its own age and place', async () => {
    const rows = [
      { id: 'BL-plain', status: 'awaiting_approval', lane: 'prod', title: 'обычная', priority: 0, enqueuedAt: NOW - 9 * HOUR, completedAt: NOW - 4 * HOUR },
      { id: 'BL-other', status: 'awaiting_approval', lane: 'prod', title: 'вторая', priority: 0, enqueuedAt: NOW - 3 * HOUR, completedAt: NOW - 7 * HOUR },
    ]
    const payload = await deriveState({
      adapter: mkAdapter(rows),
      windows: makeWindows({}),
      config: multiConfig,
      clock: () => NOW,
    })
    // the one waiting longest still comes first, and the age still counts from the STOP mark
    expect(payload.awaiting.map((a: any) => [a.id, a.position])).toEqual([
      ['BL-other', 1],
      ['BL-plain', 2],
    ])
    expect(payload.awaiting[1].agedForHours).toBeCloseTo(4, 5)
    expect(payload.kpis.awaitingApproval).toBe(2)
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
      'batches',
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
      'waves',
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
        'batches',
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
        'waves',
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
  it('the route table is still exactly sixty-one entries and carries no migration route', () => {
    // V5.4 freeze (53) + chat/stop + redirect (phase «Двигатель» re-freeze) + the batch request
    // + the word its owner answers a stopped batch with + the two doors of a task's words
    // + the composition a phrase could have, proposed for confirmation
    // + the order that stops one echelon of one phase and starts it again.
    expect(Object.keys(ROUTES)).toHaveLength(61)
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

// ═══════════ POST /api/batch — one request of the owner, fanned out into work ═══════════
//
// The door is the ONLY thing that writes both halves of a batch in one action: the request row
// and the items wearing its id. These cases are wire tests — they press the door and then ask
// the QUEUE what is in it, because a handler that computed a batch and enqueued nothing would
// answer 200 all the same.

describe('POST /api/batch — the request fans out into the work it names', () => {
  const BATCH_NOW = 1_700_000_000_000

  function mkBatchFront(over: any = {}) {
    return createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: { clock: () => BATCH_NOW, ...over },
    })
  }

  async function callBatch(front: any, body: any) {
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ url: '/api/batch', body }), res)
    return res
  }

  /** A backlog reader over a fixed set of open lines — the same shape the board's derive returns. */
  const backlogOf = (rows: any[]) => () => ({ rows })

  it('a sentence and two items land as THREE rows in the queue, the items wearing one batch id', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({
      adapter,
      deriveBacklog: backlogOf([{ id: 'BL-96', title: 'починить импорт' }]),
    })

    const res = await callBatch(front, {
      title: 'разгреби мелочь перед демо',
      items: ['BL-96', 'подписать хвосты в отчёте'],
    })

    expect(res.statusCode).toBe(200)
    const answer = JSON.parse(res.body)
    expect(answer.ok).toBe(true)
    expect(answer.id).toBe(`B-${BATCH_NOW}`) // the answer names the REQUEST, which is the batch

    const rows = await adapter.list({})
    expect(rows).toHaveLength(3)

    const request = rows.find((r: any) => r.id === answer.id)
    expect(request.title).toBe('разгреби мелочь перед демо')
    expect(request.data.batch).toBe('parent')

    const items = rows.filter((r: any) => r.id !== answer.id)
    expect(items.map((r: any) => r.batchId)).toEqual([answer.id, answer.id])
    // the referenced line carries the FILE's own words, identifier first
    expect(items.map((r: any) => r.title)).toEqual(['BL-96 · починить импорт', 'подписать хвосты в отчёте'])
    // ...and the request itself is not work: nobody may be handed it
    expect((await adapter.claimNext('w1', {})).id).toBe(items[0].id)
  })

  it('ДЛИННАЯ строка бэклога всё равно едет в очередь: заголовок укорочен, идентификатор цел', async () => {
    // Доска держит строку файла целиком (у неё есть место), заголовок строки очереди вдвое
    // короче. До этой правки одна длинная запись роняла постановку ЦЕЛОГО батча — найдено
    // живым прогоном на настоящем бэклоге мастерской, где записи бывают в четыреста символов.
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const long = 'о работе подробно, '.repeat(30) // много длиннее заголовка строки очереди
    const front = mkBatchFront({ adapter, deriveBacklog: backlogOf([{ id: 'BL-42', title: long }]) })

    const res = await callBatch(front, { title: 'разгрести хвосты', items: ['BL-42', 'своя строка'] })
    expect(res.statusCode).toBe(200)

    const rows = await adapter.list({})
    const item = rows.find((r: any) => r.id === `${JSON.parse(res.body).id}-1`)
    expect(item.title.startsWith('BL-42 · ')).toBe(true) // назад к строке файла читается
    expect(item.title.endsWith('…')).toBe(true) // и вслух сказано, что слова укорочены
    expect(item.title.length).toBeLessThanOrEqual(200)
  })

  it('a batch of nothing is refused, and nothing at all is written', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    const res = await callBatch(front, { title: 'пусто', items: [] })
    expect(res.statusCode).toBe(400)
    expect(await adapter.list({})).toHaveLength(0)
  })

  it('the caps hold: too many items, an over-long line and an unknown field are each a 400 that writes nothing', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })

    const many = await callBatch(front, { title: 'много', items: Array.from({ length: 21 }, (_, i) => `дело ${i}`) })
    expect(many.statusCode).toBe(400)

    const long = await callBatch(front, { title: 'длинно', items: ['д'.repeat(201)] })
    expect(long.statusCode).toBe(400)

    const smuggled = await callBatch(front, { title: 'чужое', items: ['дело'], command: 'rm -rf /' })
    expect(smuggled.statusCode).toBe(400)

    expect(await adapter.list({})).toHaveLength(0)
  })

  it('a referenced line that is not in the file is a 404 — a batch never carries an item nobody can trace', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter, deriveBacklog: backlogOf([{ id: 'BL-1', title: 'есть' }]) })
    const res = await callBatch(front, { title: 'разбор', items: ['BL-999'] })
    expect(res.statusCode).toBe(404)
    expect(await adapter.list({})).toHaveLength(0)
  })

  it('an unwired queue answers 501 — never a fabricated ok about work that was never queued', async () => {
    const res = await callBatch(mkBatchFront({}), { title: 'разбор', items: ['дело'] })
    expect(res.statusCode).toBe(501)
  })

  // ── batches[] — the wire from the door, through a REAL queue, into the payload ──
  //
  // Every case below puts the batch in through the door and reads it out of deriveState, so
  // what is asserted is the WIRE and not a computation: a derive that grouped items perfectly
  // and was never handed the request rows would pass a test written any other way.

  async function batchInTheState(front: any, adapter: any, body: any) {
    const res = await callBatch(front, body)
    expect(res.statusCode).toBe(200)
    const payload = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    return { id: JSON.parse(res.body).id, payload }
  }

  it('a batch put in through the door comes out of /api/state with its items and their states', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    const { id, payload } = await batchInTheState(front, adapter, {
      title: 'разгреби мелочь перед демо',
      items: ['первое дело', 'второе дело'],
    })

    expect(payload.batches).toHaveLength(1)
    const batch = payload.batches[0]
    expect(batch.id).toBe(id)
    expect(batch.title).toBe('разгреби мелочь перед демо')
    expect(batch.items.map((i: any) => i.title)).toEqual(['первое дело', 'второе дело'])
    expect(batch.items.map((i: any) => i.state)).toEqual(['waiting', 'waiting'])

    // ...and the request itself is NOT in the queue list, nor in the counter beside it
    expect(payload.queue.map((q: any) => q.id)).toEqual(batch.items.map((i: any) => i.id))
    expect(payload.kpis.queued).toBe(2)
  })

  it('the item waiting for a person is NAMED as what holds the assembly', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    const first = await callBatch(front, { title: 'разбор', items: ['первое дело', 'второе дело'] })
    const id = JSON.parse(first.body).id

    // the first item runs and finishes with a receipt → it now owes a PERSON a word
    const claimed = await adapter.claimNext('w1', {})
    await adapter.complete(claimed.id, { receiptRef: 'reverify:ok' })

    const payload = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    const batch = payload.batches.find((b: any) => b.id === id)
    expect(batch.state).toBe('awaiting_decision')
    expect(batch.holding.id).toBe(claimed.id)
    expect(batch.holding.state).toBe('awaiting_decision') // the state IS the reason
  })

  /**
   * THE CLOSING RULE, on fixtures rather than through the door — deliberately.
   *
   * A batch is closed by its ASSEMBLY: only when every piece has actually produced. Accepted
   * work reads `completed`, and acceptance is a person's word given at the approve door (the
   * queue's own `complete()` hands the task to a person and reads back as awaiting one). So
   * the state this rule turns on is reached by a path outside this door, and the honest way to
   * assert the rule is to state the rows and read the answer.
   */
  const requestRow = (over: any = {}) => ({
    id: 'B-9',
    title: 'разгреби мелочь перед демо',
    lane: 'prod',
    status: 'queued',
    batchId: 'B-9',
    data: { batch: 'parent' },
    enqueuedAt: NOW - 1000,
    priority: 0,
    ...over,
  })
  const itemRow = (id: string, status: string) => ({
    id,
    title: `дело ${id}`,
    lane: 'prod',
    status,
    batchId: 'B-9',
    enqueuedAt: NOW - 1000,
    priority: 0,
  })

  it('every item accepted → the assembly is done and nothing holds it; one live item → not done', async () => {
    const closed = await deriveState({
      adapter: mkAdapter([requestRow(), itemRow('B-9-1', 'completed'), itemRow('B-9-2', 'completed')]),
      windows: makeWindows({}),
      config,
      clock: () => NOW,
    })
    expect(closed.batches[0].state).toBe('done')
    expect(closed.batches[0].holding).toBeNull()

    const open = await deriveState({
      adapter: mkAdapter([requestRow(), itemRow('B-9-1', 'completed'), itemRow('B-9-2', 'claimed')]),
      windows: makeWindows({}),
      config,
      clock: () => NOW,
    })
    expect(open.batches[0].state).toBe('running')
    expect(open.batches[0].holding.id).toBe('B-9-2')
  })

  it('a failed item stops the assembly and is what holds it — nothing retries by itself', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    const res = await callBatch(front, { title: 'разбор', items: ['первое дело', 'второе дело'] })
    const id = JSON.parse(res.body).id

    const a = await adapter.claimNext('w1', {})
    await adapter.complete(a.id, { receiptRef: 'reverify:ok' })
    const b = await adapter.claimNext('w2', {})
    await adapter.fail(b.id, 'agent_error')

    const payload = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    const batch = payload.batches.find((bt: any) => bt.id === id)
    // both rows are terminal for the QUEUE, and the assembly is still open: a failure is a
    // stop that owes its owner a decision, never a closed piece of work
    expect(batch.state).toBe('failed')
    expect(batch.holding.id).toBe(b.id)
  })

  it('nothing about a batch is stored: what holds it is recomputed, and the queue rows carry no such field', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    await callBatch(front, { title: 'разбор', items: ['первое дело'] })

    const rows = await adapter.list({})
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain('holding')
      expect(Object.keys(r)).not.toContain('state')
    }

    // the same rows, read twice with a different world: the reading follows the ITEMS
    const before = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    expect(before.batches[0].state).toBe('waiting')
    const claimed = await adapter.claimNext('w1', {})
    expect(claimed).toBeTruthy()
    const after = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    expect(after.batches[0].state).toBe('running')
    expect(after.batches[0].holding.state).toBe('running')
  })

  it('no batch, no batches: a queue of ordinary work answers with an empty list, never a missing key', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    await adapter.enqueue({ id: 'R-1', source: 'roster', title: 'обычная', lane: 'prod' })
    const payload = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    expect(payload.batches).toEqual([])
  })

  // ── СЛОМАЛОСЬ — СТОП И ВОПРОС ВЛАДЕЛЬЦУ, И ТОЛЬКО ЕГО СЛОВО СДВИГАЕТ ДЕЛО ──
  //
  // The queue already refuses to hand out anything of a stopped assembly (adapter.mjs). What
  // is asserted here is the other half: that the stop is VISIBLE as a question with three
  // named answers, that a door accepts exactly those three, and that each one changes the
  // state in a way a person can check afterwards. A stop nobody is asked about is a hang.

  async function decide(front: any, body: any) {
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ url: '/api/batch/decide', body }), res)
    return res
  }

  /** A batch of two pieces whose FIRST piece has broken — the state every case below starts in. */
  async function stoppedBatch() {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    const res = await callBatch(front, { title: 'разбор', items: ['первое дело', 'второе дело'] })
    const id = JSON.parse(res.body).id
    const broken = await adapter.claimNext('w1', {})
    await adapter.fail(broken.id, 'tests_red')
    return { adapter, front, id, brokenId: broken.id }
  }

  const readBatch = async (adapter: any, id: string) => {
    const payload = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    return payload.batches.find((b: any) => b.id === id)
  }

  it('a broken piece turns the assembly into a QUESTION with three named answers, and hands nothing out', async () => {
    const { adapter, id, brokenId } = await stoppedBatch()

    const batch = await readBatch(adapter, id)
    expect(batch.state).toBe('failed')
    expect(batch.holding.id).toBe(brokenId)
    expect(batch.question.itemId).toBe(brokenId)
    expect(batch.question.options.map((o: any) => o.id)).toEqual(['skip', 'retry', 'cancel'])
    expect(batch.question.options.every((o: any) => typeof o.label === 'string' && o.label !== '')).toBe(true)

    // and the queue keeps its silence for as long as the question is open — no answer, no work
    expect(await adapter.claimNext('w2', {})).toBeNull()
  })

  it('«пропустить»: the piece is named as skipped, stops holding the assembly, and the next one is handed out', async () => {
    const { adapter, front, id, brokenId } = await stoppedBatch()

    const res = await decide(front, { batchId: id, decision: 'skip', itemId: brokenId })
    expect(res.statusCode).toBe(200)

    const batch = await readBatch(adapter, id)
    expect(batch.items.find((i: any) => i.id === brokenId).state).toBe('skipped')
    expect(batch.question).toBeUndefined() // nothing left to ask
    expect(batch.holding.id).not.toBe(brokenId)
    // the assembly moves again
    expect((await adapter.claimNext('w2', {})).id).not.toBe(brokenId)
  })

  it('«повторить»: the SAME piece is queued again, one attempt higher, still of its batch', async () => {
    const { adapter, front, id, brokenId } = await stoppedBatch()

    const res = await decide(front, { batchId: id, decision: 'retry', itemId: brokenId })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).attempt).toBe(2)

    const rows = await adapter.list({})
    const again = rows.find((r: any) => r.id === brokenId)
    expect(again.status).toBe('queued')
    expect(again.batchId).toBe(id)
    expect(again.attempt).toBe(2)
    // ...and it is the piece that runs next — a repeat comes back to its own place
    expect((await adapter.claimNext('w2', {})).id).toBe(brokenId)
  })

  it('«отменить»: the assembly reads as abandoned, the unstarted pieces leave the queue, what produced stays', async () => {
    const adapter = createMemoryQueue({ clock: () => BATCH_NOW })
    const front = mkBatchFront({ adapter })
    const created = await callBatch(front, { title: 'разбор', items: ['первое', 'второе', 'третье'] })
    const id = JSON.parse(created.body).id

    const done = await adapter.claimNext('w1', {})
    await adapter.complete(done.id, { receiptRef: 'reverify:ok' }) // this one produced
    const broken = await adapter.claimNext('w1', {})
    await adapter.fail(broken.id, 'agent_error')

    const res = await decide(front, { batchId: id, decision: 'cancel' })
    expect(res.statusCode).toBe(200)

    const batch = await readBatch(adapter, id)
    expect(batch.state).toBe('cancelled')
    expect(batch.question).toBeUndefined()
    expect(batch.holding).toBeNull()
    // what produced is untouched by the abandonment: it still stands where it stood, owing a
    // person a word about itself. Cancelling a batch is not a way to un-do finished work.
    expect(batch.items.find((i: any) => i.id === done.id).status).toBe('awaiting_approval')
    expect(await adapter.claimNext('w2', {})).toBeNull()
    const payload = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    expect(payload.kpis.queued).toBe(0) // a counter an abandoned batch could never bring down
  })

  it('the door answers only about a BROKEN piece, only with one of the three words, and only about a batch that exists', async () => {
    const { front, id, brokenId } = await stoppedBatch()

    expect((await decide(front, { batchId: id, decision: 'выполнить', itemId: brokenId })).statusCode).toBe(400)
    expect((await decide(front, { batchId: id, decision: 'skip', itemId: brokenId, force: true })).statusCode).toBe(400)
    expect((await decide(front, { batchId: 'B-nope', decision: 'cancel' })).statusCode).toBe(404)
    expect((await decide(front, { batchId: id, decision: 'skip', itemId: `${id}-2` })).statusCode).toBe(409)
  })
})

// ═══ POST /api/batch/suggest — состав, который фраза МОГЛА БЫ иметь, на подтверждение ═══
//
// Решение основателя: он пишет фразу, система предлагает состав — подбирает записи бэклога И
// разбивает фразу на новые подзадачи, — а ставит по-прежнему он, другой дверью. Поэтому
// каждый кейс ниже — проводной: он жмёт дверь и потом спрашивает ОЧЕРЕДЬ, что в ней, потому
// что обработчик, разобравший фразу и тихо поставивший работу, ответил бы теми же 200.

describe('POST /api/batch/suggest — предложение состава, которое ничего не ставит', () => {
  const SUGGEST_NOW = 1_700_000_000_000

  function mkSuggestFront(over: any = {}) {
    return createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: { clock: () => SUGGEST_NOW, ...over },
    })
  }

  async function suggestBatch(front: any, body: any) {
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ url: '/api/batch/suggest', body }), res)
    return res
  }

  /** Чтение бэклога поверх готовых открытых строк — та же форма, что отдаёт derive доски. */
  const backlogOf = (rows: any[]) => () => ({ rows })

  it('фраза возвращает кандидатов ОБЕИХ природ — запись бэклога и новый кусок, — и очередь остаётся ПУСТОЙ', async () => {
    const adapter = createMemoryQueue({ clock: () => SUGGEST_NOW })
    const front = mkSuggestFront({
      adapter,
      deriveBacklog: backlogOf([
        { id: 'BL-96', title: 'импорт агентов падает на втором файле' },
        { id: 'BL-97', title: 'переписать главу про установку' },
        { id: 'BL-98', title: 'агентов в списке стало больше' },
      ]),
    })

    const res = await suggestBatch(front, { phrase: 'Почини импорт агентов и почисти хвосты в отчёте' })
    expect(res.statusCode).toBe(200)
    const answer = JSON.parse(res.body)
    expect(answer.ok).toBe(true)
    // фраза целиком — это заголовок будущей постановки, а не один из её кусков
    expect(answer.draft.title).toBe('Почини импорт агентов и почисти хвосты в отчёте')

    const kinds = answer.draft.items.map((i: any) => i.kind)
    expect(kinds).toContain('backlog')
    expect(kinds).toContain('subtask')

    // запись бэклога приезжает СЛОВАМИ ИЗ ФАЙЛА и называет, по каким словам совпала —
    // подбор по словам ошибается, и молчаливый подбор ошибается незаметно
    const picked = answer.draft.items.find((i: any) => i.kind === 'backlog')
    expect(picked.id).toBe('BL-96')
    expect(picked.title).toBe('импорт агентов падает на втором файле')
    expect(picked.why).toContain('импорт')
    // строка бэклога, которой фраза не касалась, не предложена
    expect(answer.draft.items.some((i: any) => i.id === 'BL-97')).toBe(false)
    // ...и строка, задетая ОДНИМ общим словом, тоже: рядом с совпадением по двум словам она
    // учила бы не доверять всему списку. Отметить её руками в той же форме никто не мешает
    expect(answer.draft.items.some((i: any) => i.id === 'BL-98')).toBe(false)

    // куски — это куски САМОЙ фразы, а не выдуманная работа
    const pieces = answer.draft.items.filter((i: any) => i.kind === 'subtask').map((i: any) => i.title)
    expect(pieces).toEqual(['Почини импорт агентов', 'Почисти хвосты в отчёте'])
    expect(answer.question).toBeNull()

    // ВОТ РАДИ ЧЕГО ВСЁ: предложить — не поставить. В очереди ноль записей.
    expect(await adapter.list({})).toHaveLength(0)
    expect((await adapter.stats()).total).toBe(0)
  })

  it('обрывок фразы работой не назначается: кусок обязан называть действие, и один кусок разбором не считается', async () => {
    const adapter = createMemoryQueue({ clock: () => SUGGEST_NOW })
    const front = mkSuggestFront({ adapter, deriveBacklog: backlogOf([]) })

    const res = await suggestBatch(front, { phrase: 'Почини импорт агентов, он падает на втором файле' })
    const answer = JSON.parse(res.body)
    // «он падает на втором файле» — придаток предыдущего куска, а не отдельная работа;
    // оставшийся один кусок — та же фраза другими словами, и батчем из одного она не станет
    expect(answer.draft.items).toEqual([])
    expect(answer.question).not.toBeNull()
    expect(await adapter.list({})).toHaveLength(0)
  })

  it('когда назвать нечего — ответ несёт ВОПРОС, а не пустое предложение и не выдуманный состав', async () => {
    const adapter = createMemoryQueue({ clock: () => SUGGEST_NOW })
    const front = mkSuggestFront({ adapter, deriveBacklog: backlogOf([{ id: 'BL-1', title: 'совсем про другое' }]) })

    const res = await suggestBatch(front, { phrase: 'Разгреби мелочь перед демо' })
    expect(res.statusCode).toBe(200)
    const answer = JSON.parse(res.body)
    expect(answer.draft.items).toEqual([])
    expect(answer.question.question).toBe('Из чего состоит эта работа?')
    expect(answer.question.options).toEqual([]) // вариантов нет — ответ своими словами
    expect(await adapter.list({})).toHaveLength(0)
  })

  it('неподключённое чтение бэклога — 501: половина предложения читалась бы как пустой бэклог', async () => {
    const front = mkSuggestFront({ adapter: createMemoryQueue({ clock: () => SUGGEST_NOW }) })
    expect((await suggestBatch(front, { phrase: 'почини импорт и почисти хвосты' })).statusCode).toBe(501)
  })

  it('пустая фраза, фраза длиннее заголовка постановки и чужое поле — каждое 400', async () => {
    const front = mkSuggestFront({ deriveBacklog: backlogOf([]) })
    expect((await suggestBatch(front, { phrase: '   ' })).statusCode).toBe(400)
    expect((await suggestBatch(front, { phrase: 'д'.repeat(201) })).statusCode).toBe(400)
    expect((await suggestBatch(front, { phrase: 'ок', items: ['протащить'] })).statusCode).toBe(400)
  })
})

// ═════ the words of a task: the system PROPOSES them, the owner CORRECTS them ═════
//
// The founder's rule, in his own words: «почему мы должны всё писать, если SMA-фреймворк всё
// это делает?». So the words are derived — and, because a machine that both decides what work
// means AND starts it would be answering a question nobody asked it, the deriving door writes
// NOTHING. These are wire tests: they press the door and then ask the QUEUE what happened,
// because a handler that computed a proposal and quietly enqueued it would answer 200 too.

describe('POST /api/task/suggest — words come out, nothing goes in', () => {
  const WORDS_NOW = 1_700_000_000_000

  function mkWordsFront(over: any = {}) {
    return createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: { clock: () => WORDS_NOW, ...over },
    })
  }

  async function suggest(front: any, body: any) {
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ url: '/api/task/suggest', body }), res)
    return res
  }

  it('a formulation comes back as a description and a list of criteria — and the queue stays EMPTY', async () => {
    const adapter = createMemoryQueue({ clock: () => WORDS_NOW })
    const front = mkWordsFront({ adapter })

    const res = await suggest(front, { title: 'Почини импорт агентов — падает на втором файле' })
    expect(res.statusCode).toBe(200)
    const answer = JSON.parse(res.body)
    expect(answer.ok).toBe(true)
    // the kind of work was recognised from the owner's own verb, and said back to him
    expect(answer.kind).toBe('fix')
    expect(answer.text).toContain('починку')
    // his whole sentence is the description — the title is what gets shortened, not this
    expect(answer.draft.description).toBe('Почини импорт агентов — падает на втором файле')
    expect(Array.isArray(answer.draft.acceptance)).toBe(true)
    expect(answer.draft.acceptance.length).toBeGreaterThan(1)
    // the two the daemon itself enforces are in there — they are true, and invisible otherwise
    expect(answer.draft.acceptance.join(' | ')).toContain('закоммичены в ветку задачи')
    expect(answer.draft.acceptance.join(' | ')).toContain('записка о подходе')

    // THE WHOLE POINT: proposing is not putting. Nothing was written anywhere.
    expect(await adapter.list({})).toHaveLength(0)
    expect((await adapter.stats()).total).toBe(0)
  })

  it('work whose product is prose is not promised a test receipt it will never give', async () => {
    const front = mkWordsFront({ adapter: createMemoryQueue({ clock: () => WORDS_NOW }) })
    const res = await suggest(front, { title: 'Разберись, почему окно показывает пустую очередь' })
    const answer = JSON.parse(res.body)
    expect(answer.kind).toBe('research')
    expect(answer.draft.acceptance.join(' | ')).not.toContain('целевых тестов')
    expect(answer.draft.acceptance.join(' | ')).toContain('записка о подходе')
  })

  it('a sentence whose kind is not recognised says so, and still proposes what the machine checks', async () => {
    const front = mkWordsFront({ adapter: createMemoryQueue({ clock: () => WORDS_NOW }) })
    const res = await suggest(front, { title: 'Хвосты по отчёту' })
    const answer = JSON.parse(res.body)
    expect(answer.kind).toBe('unknown')
    expect(answer.text).toContain('не опознан')
    expect(answer.draft.acceptance.length).toBeGreaterThan(0)
  })

  it('an empty formulation and an unknown field are each a 400', async () => {
    const front = mkWordsFront({ adapter: createMemoryQueue({ clock: () => WORDS_NOW }) })
    expect((await suggest(front, { title: '   ' })).statusCode).toBe(400)
    expect((await suggest(front, { title: 'ок', lane: 'prod' })).statusCode).toBe(400)
  })
})

describe('POST /api/task/words — the owner corrects what a task says about itself', () => {
  const WORDS_NOW = 1_700_000_000_000

  function mkWordsFront(over: any = {}) {
    return createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [] },
      deps: { clock: () => WORDS_NOW, ...over },
    })
  }

  async function words(front: any, body: any) {
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ url: '/api/task/words', body }), res)
    return res
  }

  const live = async (adapter: any) =>
    adapter.enqueue({
      id: 'R-1',
      source: 'roster',
      title: 'починить импорт',
      lane: 'prod',
      description: 'выведено системой',
      acceptance: ['выведенный признак'],
    })

  it('the words of a LIVE task change, and the field the body did not name is left alone', async () => {
    const adapter = createMemoryQueue({ clock: () => WORDS_NOW })
    await live(adapter)
    const front = mkWordsFront({ adapter })

    const res = await words(front, { taskId: 'R-1', acceptance: ['поправлено рукой', 'и второе'] })
    expect(res.statusCode).toBe(200)

    const [row] = await adapter.list({})
    expect(row.acceptance).toEqual(['поправлено рукой', 'и второе'])
    expect(row.description).toBe('выведено системой') // untouched, because unnamed
  })

  it('a task whose work is OVER is refused — the standard is not rewritten after the measuring', async () => {
    const adapter = createMemoryQueue({ clock: () => WORDS_NOW })
    await live(adapter)
    await adapter.claimNext('w1', {})
    await adapter.complete('R-1', { receiptRef: 'reverify:abc' })
    const front = mkWordsFront({ adapter })

    const res = await words(front, { taskId: 'R-1', acceptance: ['так уже нельзя'] })
    expect(res.statusCode).toBe(409)
    const [row] = await adapter.list({})
    expect(row.acceptance).toEqual(['выведенный признак'])
  })

  it('a task nobody put in is a 404, and a body that changes nothing is a 400', async () => {
    const adapter = createMemoryQueue({ clock: () => WORDS_NOW })
    await live(adapter)
    const front = mkWordsFront({ adapter })
    expect((await words(front, { taskId: 'R-nope', description: 'x' })).statusCode).toBe(404)
    expect((await words(front, { taskId: 'R-1' })).statusCode).toBe(400)
    expect((await words(front, { taskId: 'R-1', smuggled: 'x' })).statusCode).toBe(400)
  })

  it('the caps of the queue hold at this door too — a refusal writes nothing', async () => {
    const adapter = createMemoryQueue({ clock: () => WORDS_NOW })
    await live(adapter)
    const front = mkWordsFront({ adapter })

    const many = await words(front, { taskId: 'R-1', acceptance: Array.from({ length: 13 }, (_, i) => `к ${i}`) })
    expect(many.statusCode).toBe(400)
    const long = await words(front, { taskId: 'R-1', description: 'д'.repeat(2001) })
    expect(long.statusCode).toBe(400)

    const [row] = await adapter.list({})
    expect(row.acceptance).toEqual(['выведенный признак'])
    expect(row.description).toBe('выведено системой')
  })

  it('an unwired queue answers 501 — never a fabricated ok', async () => {
    const front = createFrontServer({ config: { token: MIGRATION_TOKEN, workers: [] }, deps: {} })
    expect((await words(front, { taskId: 'R-1', description: 'x' })).statusCode).toBe(501)
  })
})

/**
 * ═══════════ POST /api/wave/hold — «ОСТАНОВИ ВОЛНУ 2» ЧЕРЕЗ ДВЕРЬ ═════════════════════
 *
 * The door writes ONE thing: the owner's word, into a register on disk. Everything else — which
 * rows stop being handed out, which live tasks are asked to stand — happens in the loop, from
 * that register, on the next tick. So what belongs here is exactly what the door owns: the
 * address is narrow and checked, the vocabulary is closed, and the word is DURABLE — read back
 * out of the file rather than out of a status code.
 */
describe('POST /api/wave/hold — слово владельца об эшелоне, записанное на диск', () => {
  const WAVE_NOW = 1_700_000_000_000
  const dirs: string[] = []
  const mkDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-wave-door-'))
    dirs.push(d)
    return d
  }
  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  const mkWaveFront = (dataDir: string) =>
    createFrontServer({
      config: { token: MIGRATION_TOKEN, workers: [], dataDir },
      deps: { clock: () => WAVE_NOW },
    })

  async function hold(front: any, body: any) {
    const res = mkMigrationRes()
    await front.handle(mkMigrationReq({ url: '/api/wave/hold', body }), res)
    return res
  }

  it('останов записан в реестр — и оттуда его читает кто угодно, включая перезапущенный демон', async () => {
    const dataDir = mkDir()
    const res = await hold(mkWaveFront(dataDir), { phase: '14', wave: 2, action: 'hold' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, phase: '14', wave: '2', action: 'hold', already: false })
    // не по коду ответа, а по самому реестру: слово лежит на диске
    expect(readWaveHolds({ dataDir })).toEqual([{ phase: '14', wave: '2', since: WAVE_NOW }])
  })

  it('снятие — тоже слово владельца, и после него реестр пуст', async () => {
    const dataDir = mkDir()
    const front = mkWaveFront(dataDir)
    await hold(front, { phase: '14', wave: 2, action: 'hold' })
    await hold(front, { phase: '14', wave: 3, action: 'hold' })
    await hold(front, { phase: '14', wave: 2, action: 'release' })

    expect(readWaveHolds({ dataDir }).map((h: any) => h.wave)).toEqual(['3'])
  })

  it('второе нажатие говорит честно, что ничего не изменило', async () => {
    const dataDir = mkDir()
    const front = mkWaveFront(dataDir)
    expect(JSON.parse((await hold(front, { phase: '9', wave: 1, action: 'hold' })).body).already).toBe(false)
    expect(JSON.parse((await hold(front, { phase: '9', wave: 1, action: 'hold' })).body).already).toBe(true)
  })

  it('адрес узкий и проверенный: без фазы, без волны и с выдуманным словом — отказ, реестр пуст', async () => {
    const dataDir = mkDir()
    const front = mkWaveFront(dataDir)

    expect((await hold(front, { wave: 2, action: 'hold' })).statusCode).toBe(400)
    expect((await hold(front, { phase: '14', action: 'hold' })).statusCode).toBe(400)
    expect((await hold(front, { phase: '14', wave: 'вторую', action: 'hold' })).statusCode).toBe(400)
    expect((await hold(front, { phase: '14', wave: 2, action: 'заморозить' })).statusCode).toBe(400)
    // и лишнее поле в теле — тоже отказ: словарь двери закрыт, как у всех соседних
    expect((await hold(front, { phase: '14', wave: 2, action: 'hold', lane: 'prod' })).statusCode).toBe(400)

    expect(readWaveHolds({ dataDir })).toEqual([])
  })

  it('без каталога данных дверь отвечает 501, а не выдуманным согласием', async () => {
    const front = createFrontServer({ config: { token: MIGRATION_TOKEN, workers: [] }, deps: {} })
    expect((await hold(front, { phase: '14', wave: 2, action: 'hold' })).statusCode).toBe(501)
  })

  /**
   * РЯД ЭШЕЛОНОВ — то, из чего окно СОБИРАЕТ фразу подтверждения вместо того, чтобы её выдумать.
   *
   * Реплика макета обещает поимённо: «10.8 и 10.9 доведут текущий шаг и встанут, 10.7 уже
   * стоит». Без этого ряда экран мог бы только напечатать те же слова с числами внутри — ровно
   * то, что критерий приёмки фазы запрещает. Поэтому проверяется не форма, а СОДЕРЖАНИЕ: кто в
   * эшелоне бежит, кто ждёт, и стоит ли на нём приказ.
   */
  it('ряд эшелона называет поимённо, кто бежит и кто ждёт, и стоит ли на нём приказ', async () => {
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: () => WAVE_NOW })
    const plan = (id: string, phase: string, wave: number) => ({
      id,
      source: 'roster',
      title: `план ${id}`,
      lane: 'prod',
      data: { phase, wave },
    })
    await adapter.enqueue(plan('P-a', '14', 2))
    await adapter.enqueue(plan('P-b', '14', 2))
    await adapter.enqueue(plan('P-c', '14', 3))
    await adapter.enqueue({ id: 'R-plain', source: 'roster', title: 'обычная', lane: 'prod' })
    await adapter.claimNext('w1', {}) // одна задача эшелона уже у работника

    await hold(mkWaveFront(dataDir), { phase: '14', wave: 2, action: 'hold' })

    const payload: any = await deriveState({
      adapter,
      windows: makeWindows({}),
      config: { ...config, dataDir },
      clock: () => NOW,
    })

    const two = payload.waves.find((w: any) => w.phase === '14' && w.wave === '2')
    expect(two.held).toBe(true)
    expect(two.heldSince).toBe(WAVE_NOW)
    expect(two.running.map((t: any) => t.id)).toEqual(['P-a']) // доведёт текущий шаг и встанет
    expect(two.waiting.map((t: any) => t.id)).toEqual(['P-b']) // уже стоит

    // соседний эшелон той же фазы приказом не задет, а работа без эшелона в ряду не значится
    expect(payload.waves.find((w: any) => w.wave === '3').held).toBe(false)
    expect(JSON.stringify(payload.waves)).not.toContain('R-plain')
  })

  it('приказ виден, даже если задач эшелона в очереди ещё нет — иначе экран показал бы «идёт»', async () => {
    const dataDir = mkDir()
    const adapter = createMemoryQueue({ clock: () => WAVE_NOW })
    await hold(mkWaveFront(dataDir), { phase: '77', wave: 4, action: 'hold' })

    const payload: any = await deriveState({
      adapter,
      windows: makeWindows({}),
      config: { ...config, dataDir },
      clock: () => NOW,
    })
    expect(payload.waves).toHaveLength(1)
    expect(payload.waves[0]).toMatchObject({ phase: '77', wave: '4', held: true, running: [], waiting: [] })
  })

  it('без реестра ряд эшелонов пуст — нарисованных остановов не бывает', async () => {
    const adapter = createMemoryQueue({ clock: () => WAVE_NOW })
    await adapter.enqueue({ id: 'R-1', source: 'roster', title: 'обычная', lane: 'prod' })
    const payload: any = await deriveState({ adapter, windows: makeWindows({}), config, clock: () => NOW })
    expect(payload.waves).toEqual([])
  })
})
