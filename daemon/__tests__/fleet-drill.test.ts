/**
 * fleet-drill.test.ts — a killed worker, a restart, a stranded task and a redelivery
 * (Phase 11 Plan 08, Task 2; canon §10, acceptance item «crash/restart drill loses no task»).
 *
 * WHAT A DRILL IS FOR: the fleet's recovery story is told in four places — pg-boss's own
 * `expireInSeconds`, the liveness sweep, the dead-letter queue and the attempt ledger — and
 * until now nothing ran them together and counted the tasks at the end. Each drill below
 * therefore ends with an explicit CENSUS: the number of tasks accounted for before the
 * incident and after it, asserted equal, with the drill named in the assertion. "Loses no
 * task" is the acceptance criterion, so it gets an assertion that says exactly that rather
 * than an inference from three smaller checks.
 *
 * ═════════ WHAT THIS STANDS ON, AND WHAT IT DELIBERATELY DOES NOT REPEAT ══════════════
 *   - `pgboss-backend.test.ts` already re-runs the whole `queueAdapterContractSuite`
 *     against the backend, and already pins the singleton-key coalescing, the job-option
 *     contract and the lane provisioning. None of that is repeated here.
 *   - `liveness.test.ts` already proves the sweep's arithmetic — audited / requeued /
 *     throttled counts, the cooldown curve, and a kill-drill against a MINIMAL fake
 *     adapter. This file calls the REAL `livenessSweep` against the REAL pg-boss backend
 *     instead of a hand-written adapter, which is the gap that file names in its own
 *     header ("mirrors the pg-boss retry-on-fail semantics" — mirrors, not runs).
 *   - `loop.test.ts` already proves a fresh tick recovers a stale claim from durable
 *     state. The restart drill below is the same idea one layer down: not a fresh tick
 *     over one adapter, but a fresh ADAPTER over the same store.
 *
 * ═════════ NO DATABASE, NO TIMERS, NO WALL CLOCK ══════════════════════════════════════
 * Everything runs against a stateful fake pg-boss over plain Maps, injected exactly as
 * `pgboss-backend.test.ts` injects one: no live Postgres, no real pg-boss, no connection
 * string. Time is advanced by hand through an injected clock — nothing here waits for
 * anything, because a drill that waits is a drill that flakes, and this repository runs
 * several terminals at once by design.
 *
 * ═════════ ONE PLACE THIS FAKE IS MORE FAITHFUL THAN ITS PREDECESSOR ══════════════════
 * `pgboss-backend.test.ts`'s fake sets a failed job to `failed` unconditionally. Real
 * pg-boss v11 retries on failure while `retryLimit` allows and only then routes the job to
 * the dead-letter queue — which is the exact behaviour the dead-letter drill exists to
 * exercise, and which `liveness.test.ts`'s fake adapter already models on the other side
 * ("requeue the SAME record with attempt+1 while retries remain"). The fake below models
 * it once, for both expiry and explicit failure, so the two paths cannot disagree.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPgBossQueue, TASK_QUEUE_LANES, DEAD_LETTER_QUEUE } from '../src/queue/pgboss-backend.mjs'
import { livenessSweep } from '../src/queue/liveness.mjs'
import { recordAttempt, readAttempts } from '../src/queue/attempt-ledger.mjs'
import { applyTransition, idempotencyKey, transitionContract } from '../src/queue/state-machine.mjs'

// ── temp ledger dirs (cleaned once at the end) ────────────────────────────────

const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-drill-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

// ── the injected clock: time moves only when a drill says so ──────────────────

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ── the DURABLE store: it outlives any adapter built over it ──────────────────
//
// This is the whole point of the restart drill. The store is Postgres's stand-in; an
// adapter is a process. Killing the process must not touch the store.

interface Store {
  jobs: Map<string, any>
  approvals: Map<string, string>
  seq: number
}

const makeStore = (): Store => ({ jobs: new Map(), approvals: new Map(), seq: 0 })

/**
 * A job leaves `active` for one of two reasons — its lease expired, or a caller failed it.
 * Both land here, so pg-boss's own expiry and an explicit `fail` can never disagree about
 * when a task is retried and when it is dead-lettered.
 */
function retire(store: Store, j: any, reason: string, now: number): void {
  j.output = { reason }
  if ((j.retry_count ?? 0) < (j.retryLimit ?? 2)) {
    j.state = 'created' // pg-boss `retry` — the adapter maps both onto `queued`
    j.retry_count = (j.retry_count ?? 0) + 1
    j.started_on = null
    return
  }
  j.state = 'failed'
  store.seq += 1
  const id = `dead-${store.seq}`
  store.jobs.set(id, {
    id,
    name: DEAD_LETTER_QUEUE,
    singleton_key: j.singleton_key,
    data: j.data,
    priority: 0,
    state: 'created',
    retry_count: 0,
    retryLimit: 0,
    expireInSeconds: j.expireInSeconds,
    created_on: now,
    started_on: null,
    completed_on: null,
    output: { reason },
  })
}

function makeFakeBoss(store: Store, clock: () => number) {
  const now = () => clock()

  /** pg-boss maintenance: an active job past its lease is retried, or dead-lettered. */
  function maintain() {
    const t = now()
    for (const j of store.jobs.values()) {
      if (j.name === DEAD_LETTER_QUEUE) continue
      if (j.state !== 'active' || j.started_on == null) continue
      if (t - j.started_on > j.expireInSeconds * 1000) retire(store, j, 'runtime_offline', t)
    }
  }

  function pendingWithKey(name: string, key: string) {
    for (const j of store.jobs.values()) {
      if (j.name === name && j.singleton_key === key && (j.state === 'created' || j.state === 'active')) return j
    }
    return null
  }

  return {
    maintain,
    async start() {
      return true
    },
    async stop() {
      return true
    },
    on() {
      /* no-op */
    },
    async createQueue() {
      return true
    },
    async send(name: string, data: any, opts: any = {}) {
      maintain()
      if (opts.singletonKey && pendingWithKey(name, opts.singletonKey)) return null // coalesced
      store.seq += 1
      const id = `job-${store.seq}`
      store.jobs.set(id, {
        id,
        name,
        singleton_key: opts.singletonKey ?? null,
        data,
        priority: opts.priority ?? 0,
        state: 'created',
        retry_count: 0,
        retryLimit: opts.retryLimit ?? 2,
        expireInSeconds: opts.expireInSeconds ?? 120,
        created_on: now(),
        started_on: null,
        completed_on: null,
        output: null,
      })
      return id
    },
    async fetch(name: string, options: any = {}) {
      maintain()
      const batchSize = options.batchSize ?? 1
      const avail = [...store.jobs.values()].filter((j) => j.name === name && j.state === 'created')
      avail.sort((a, b) => b.priority - a.priority || a.created_on - b.created_on)
      const picked = avail.slice(0, batchSize)
      for (const j of picked) {
        j.state = 'active'
        j.started_on = now()
      }
      return picked.map((j) => ({ id: j.id, name: j.name, data: j.data, priority: j.priority, retrycount: j.retry_count }))
    },
    async touch(_name: string, id: string) {
      const j = store.jobs.get(id)
      if (j && j.state === 'active') j.started_on = now()
      return true
    },
    async complete(_name: string, id: string, out: any) {
      const j = store.jobs.get(id)
      if (j) {
        j.state = 'completed'
        j.completed_on = now()
        j.output = out
      }
      return true
    },
    async fail(_name: string, id: string, out: any) {
      const j = store.jobs.get(id)
      if (j) retire(store, j, (out && out.reason) || 'agent_error', now())
      return true
    },
    async getQueueStats(name: string) {
      maintain()
      const s: any = { queued: 0, active: 0, completed: 0, failed: 0 }
      for (const j of store.jobs.values()) {
        if (j.name !== name) continue
        if (j.state === 'created') s.queued += 1
        else if (j.state === 'active') s.active += 1
        else if (j.state === 'completed') s.completed += 1
        else if (j.state === 'failed') s.failed += 1
      }
      return s
    },
  }
}

/**
 * The read-only SQL seam, over the SAME store. It honours the lane-name filter the
 * backend's `list()` actually sends, so a dead-lettered job is invisible to `list()` here
 * exactly as it is in production — which is why the census below has to look for it
 * separately instead of trusting one query.
 */
function makeExecSql(store: Store, boss: { maintain: () => void }) {
  return async (sql: string, params: any[] = []) => {
    boss.maintain()
    if (sql.includes("state = 'active'")) {
      const taskId = params[0]
      const match = [...store.jobs.values()]
        .filter((j) => j.state === 'active' && j.data && j.data.id === taskId)
        .sort((a, b) => (b.started_on ?? 0) - (a.started_on ?? 0))[0]
      return { rows: match ? [{ id: match.id, name: match.name }] : [] }
    }
    if (sql.includes('CREATE TABLE')) return { rows: [] }
    if (sql.includes('INSERT INTO')) {
      store.approvals.set(String(params[0]), String(params[1]))
      return { rows: [] }
    }
    const names: string[] = Array.isArray(params[0]) ? params[0] : []
    return {
      rows: [...store.jobs.values()]
        .filter((j) => names.length === 0 || names.includes(j.name))
        .map((j) => ({
          id: j.id,
          name: j.name,
          priority: j.priority,
          data: j.data,
          state: j.state,
          retry_count: j.retry_count,
          created_on: j.created_on,
          started_on: j.started_on,
          completed_on: j.completed_on,
          output: j.output,
        })),
    }
  }
}

/** Build ONE adapter over a store. Call it twice on the same store to model a restart. */
function mountAdapter(store: Store, { clock, expireMs, ledgerDir }: { clock: () => number; expireMs: number; ledgerDir?: string }) {
  const boss = makeFakeBoss(store, clock)
  const execSql = makeExecSql(store, boss)
  return createPgBossQueue({ boss, execSql, clock, expireMs, ledgerDir })
}

/**
 * THE CENSUS. Every task the system can still account for, counted once: the rows the
 * lane queues expose plus anything sitting in the dead-letter queue. A task that vanished
 * from both is a lost task, and that is the thing every drill here is looking for.
 */
async function census(adapter: any, store: Store): Promise<number> {
  const rows = await adapter.list({})
  const ids = new Set<string>(rows.map((r: any) => r.id))
  for (const j of store.jobs.values()) {
    if (j.name === DEAD_LETTER_QUEUE && j.data && j.data.id) ids.add(j.data.id)
  }
  return ids.size
}

const backlog = (over: any = {}) => ({
  id: 'BL-500',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  attempt: 1,
  storyPoints: 3,
  acceptance: 'green targeted tests + reverify receipt',
  ...over,
})

// ═══════════════════════════ DRILL 1 — THE KILL DRILL ═════════════════════════

describe('kill drill — a worker stops refreshing its lease', () => {
  it('the liveness sweep recovers the task, and the dead worker\'s attempt row survives in the ledger', async () => {
    const c = mkClock(1000)
    const ledgerDir = mkLedgerDir()
    const store = makeStore()
    // The job's OWN lease is long; the sweep's patience is short. So the sweep is what
    // notices first — the belt-and-suspenders audit doing the job it exists for.
    const adapter = mountAdapter(store, { clock: c.clock, expireMs: 600000, ledgerDir })

    await adapter.enqueue(backlog({ id: 'BL-K1' }))
    await adapter.enqueue(backlog({ id: 'BL-K2' }))
    await adapter.enqueue(backlog({ id: 'BL-K3' }))
    const before = await census(adapter, store)
    expect(before).toBe(3)

    const claimed = await adapter.claimNext('w1', {})
    expect(claimed.id).toBe('BL-K1')

    // The worker dies here. No complete, no fail, no touch — the lease simply stops.
    c.advance(200000)

    const ledger = { readAttempts: (id: string) => readAttempts(ledgerDir, id) }
    const swept = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(swept.requeued).toBe(1)

    // The task is claimable again — by a DIFFERENT worker, on its next attempt.
    const reclaimed = await adapter.claimNext('w2', {})
    expect(reclaimed.id).toBe('BL-K1')
    expect(reclaimed.attempt).toBe(2)

    // The evidence that the dead worker ran is still there. A lost worker must not erase
    // the record that it existed — that is the repudiation half of the invariant.
    const rows = readAttempts(ledgerDir, 'BL-K1')
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].failureReason).toBe('runtime_offline')

    const after = await census(adapter, store)
    expect(after, 'kill drill: the number of tasks accounted for after the kill must equal the number before').toBe(before)
  })

  it('pg-boss\'s own lease expiry also recovers the task — but on that path the ledger records NOTHING', async () => {
    const c = mkClock(1000)
    const ledgerDir = mkLedgerDir()
    const store = makeStore()
    // Short lease, and NO sweep runs: this is the daemon being down while a worker dies.
    const adapter = mountAdapter(store, { clock: c.clock, expireMs: 5000, ledgerDir })

    await adapter.enqueue(backlog({ id: 'BL-K9' }))
    const before = await census(adapter, store)
    await adapter.claimNext('w1', {})
    c.advance(6000) // past the lease, nobody touched it

    const reclaimed = await adapter.claimNext('w2', {})
    expect(reclaimed.id).toBe('BL-K9')
    expect(reclaimed.attempt).toBe(2) // recovered, with the retry counted

    // RECORDED HOLE, not an accident: recovery by pg-boss expiry writes NO attempt row,
    // because only `adapter.fail` / `adapter.complete` reach the ledger. So the evidence
    // that a worker ran and died exists ONLY when the liveness sweep fires first. This
    // assertion pins today's behaviour so a future change to it is a visible decision.
    expect(readAttempts(ledgerDir, 'BL-K9')).toHaveLength(0)

    const after = await census(adapter, store)
    expect(after, 'kill drill (queue-expiry path): the number of tasks accounted for must be unchanged').toBe(before)
  })
})

// ═══════════════════════════ DRILL 2 — THE RESTART DRILL ══════════════════════

describe('restart drill — a fresh adapter over the same store', () => {
  it('every task that existed before the restart exists after it, in the same or a legal successor state', async () => {
    const c = mkClock(1000)
    const ledgerDir = mkLedgerDir()
    const store = makeStore()
    const first = mountAdapter(store, { clock: c.clock, expireMs: 300000, ledgerDir })

    for (const id of ['BL-R1', 'BL-R2', 'BL-R3', 'BL-R4']) await first.enqueue(backlog({ id }))
    const before = await census(first, store)
    expect(before).toBe(4)

    // One task is finished and certified; another is claimed and still running when the
    // process goes away.
    const done = await first.claimNext('w1', {})
    await first.complete(done.id, { receiptRef: 'reverify:green', workerId: 'w1' })
    const inFlight = await first.claimNext('w1', {})
    expect(inFlight.id).toBe('BL-R2')

    const beforeStatuses = new Map((await first.list({})).map((r: any) => [r.id, r.status]))
    await first.stop()

    // ── the process is gone. Nothing it held in memory survives. ──
    const second = mountAdapter(store, { clock: c.clock, expireMs: 300000, ledgerDir })
    const afterRows = await second.list({})
    const afterStatuses = new Map(afterRows.map((r: any) => [r.id, r.status]))

    expect([...afterStatuses.keys()].sort()).toEqual(['BL-R1', 'BL-R2', 'BL-R3', 'BL-R4'])
    expect(afterStatuses.get('BL-R1')).toBe('completed')
    // The task that was claimed at the moment of the restart is STILL claimed with a live
    // lease — not lost, and not silently completed.
    expect(afterStatuses.get('BL-R2')).toBe('claimed')
    expect(beforeStatuses.get('BL-R2')).toBe('claimed')
    expect(afterStatuses.get('BL-R3')).toBe('queued')

    // The ledger written before the restart is readable after it.
    expect(readAttempts(ledgerDir, 'BL-R1')).toHaveLength(1)
    expect(readAttempts(ledgerDir, 'BL-R1')[0].receiptRef).toBe('reverify:green')

    // The only thing a restart is allowed to forget is the SOFT coalesce display counter.
    // It is not task truth, and the header of the backend says so; this pins that the loss
    // is limited to exactly that.
    expect(afterRows.every((r: any) => r.coalesceCount === 1)).toBe(true)

    // And the in-flight task is not stranded: once its lease expires it comes back.
    c.advance(400000)
    const recovered = await second.claimNext('w2', {})
    expect(recovered.id).toBe('BL-R2')

    const after = await census(second, store)
    expect(after, 'restart drill: the number of tasks accounted for after the restart must equal the number before').toBe(before)
  })
})

// ═══════════════════════════ DRILL 3 — THE DEAD-LETTER DRILL ══════════════════

describe('dead-letter drill — an exhausted task stays put until somebody decides', () => {
  it('no ordinary path returns it, and an explicit disposition does', async () => {
    const c = mkClock(1000)
    const ledgerDir = mkLedgerDir()
    const store = makeStore()
    const adapter = mountAdapter(store, { clock: c.clock, expireMs: 600000, ledgerDir })

    await adapter.enqueue(backlog({ id: 'BL-D1' }))
    await adapter.enqueue(backlog({ id: 'BL-D2' })) // a bystander, to prove the census counts more than one
    const before = await census(adapter, store)
    expect(before).toBe(2)

    // Three failures: retryLimit is 2, so the third exhausts the budget.
    for (let i = 0; i < 3; i += 1) {
      const claimed = await adapter.claimNext('w1', { lanes: ['prod'] })
      expect(claimed.id).toBe('BL-D1')
      await adapter.fail('BL-D1', 'tests_red')
    }

    const dead = [...store.jobs.values()].filter((j) => j.name === DEAD_LETTER_QUEUE)
    expect(dead).toHaveLength(1)
    expect(dead[0].data.id).toBe('BL-D1')

    // ── half one: no ORDINARY path brings it back ──
    // Across ALL four lane queues the only thing still claimable is the bystander. The
    // dead-lettered task is not offered to anyone, and after the bystander there is
    // nothing left at all — so its absence is proven by exhaustion, not by one null.
    const nextClaim = await adapter.claimNext('w2', { lanes: [...TASK_QUEUE_LANES] })
    expect(nextClaim && nextClaim.id).toBe('BL-D2')
    expect(await adapter.claimNext('w2b', { lanes: [...TASK_QUEUE_LANES] })).toBeNull()
    // The liveness sweep does not resurrect it either: a failed task is terminal and is
    // not audited at all.
    const swept = await livenessSweep({
      adapter,
      ledger: { readAttempts: (id: string) => readAttempts(ledgerDir, id) },
      clock: c.clock,
      expireMs: 120000,
    })
    expect(swept.requeued).toBe(0)
    // And the state machine refuses the shortcut by name.
    const noDisposition: any = applyTransition({
      state: 'DEAD_LETTER',
      to: 'READY',
      actor: 'dispatcher',
      taskId: 'BL-D1',
      attemptId: 'BL-D1#3',
    })
    expect(noDisposition.applied).toBe(false)
    expect(noDisposition.refusal).toMatch(/canon invariant 7/)
    expect(transitionContract('DEAD_LETTER', 'READY')).toBeNull()

    // Every one of the three attempts left its own immutable row behind.
    expect(readAttempts(ledgerDir, 'BL-D1')).toHaveLength(3)

    // ── half two: an EXPLICIT disposition does bring it back — as a new attempt ──
    const withDisposition: any = applyTransition({
      state: 'DEAD_LETTER',
      to: 'READY',
      actor: 'dispatcher',
      taskId: 'BL-D1',
      attemptId: 'BL-D1#3',
      disposition: 'human-approved',
    })
    // Still not a move of THIS attempt — it opens a new one through the enqueue path.
    expect(withDisposition.requiresNewAttempt).toBe(true)
    await adapter.enqueue(backlog({ id: 'BL-D1', attempt: 4 }))
    const revived = await adapter.claimNext('w3', { lanes: ['prod'] })
    expect(revived.id).toBe('BL-D1')

    // The dead-lettered attempt is still dead-lettered — the gate is a gate, not an undo.
    expect([...store.jobs.values()].filter((j) => j.name === DEAD_LETTER_QUEUE)).toHaveLength(1)

    const after = await census(adapter, store)
    expect(after, 'dead-letter drill: the number of tasks accounted for after the exhaustion must equal the number before').toBe(before)
  })
})

// ═══════════════════════════ DRILL 4 — THE REDELIVERY DRILL ═══════════════════

describe('redelivery drill — the same effect delivered twice', () => {
  it('the effect is applied once, the second delivery reports itself as already applied, and a new attempt is a different key', async () => {
    const c = mkClock(1000)
    const ledgerDir = mkLedgerDir()
    const store = makeStore()
    const adapter = mountAdapter(store, { clock: c.clock, expireMs: 600000, ledgerDir })

    await adapter.enqueue(backlog({ id: 'BL-X1' }))
    const before = await census(adapter, store)
    await adapter.claimNext('w1', {})

    // The effect ledger: what the outside world has actually been told to do.
    const effects: string[] = []
    const appliedKeys = new Set<string>()
    const deliver = (attemptId: string) => {
      const result: any = applyTransition({
        state: 'CLAIMED',
        to: 'RUNNING',
        actor: 'worker',
        taskId: 'BL-X1',
        attemptId,
        attempt: Number(attemptId.split('#')[1]),
        appliedKeys,
      })
      if (result.applied) {
        for (const effect of result.externalEffects) effects.push(`${effect}@${result.idempotencyKey}`)
        appliedKeys.add(result.idempotencyKey)
        recordAttempt(ledgerDir, {
          taskId: 'BL-X1',
          attempt: Number(attemptId.split('#')[1]),
          idempotencyKey: result.idempotencyKey,
          stateMachineVersion: result.stateMachineVersion,
          recordedAt: '2026-08-04T00:00:00.000Z',
        } as any)
      }
      return result
    }

    const first = deliver('BL-X1#1')
    expect(first.applied).toBe(true)
    expect(first.alreadyApplied).toBe(false)

    // The SAME message again — a redelivery, which at-least-once delivery guarantees will
    // happen sooner or later.
    const second = deliver('BL-X1#1')
    expect(second.applied).toBe(false)
    expect(second.alreadyApplied).toBe(true) // reports itself, rather than being refused
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(effects).toHaveLength(1) // the world was told once

    // A NEW attempt is a different key by construction, and is allowed to run the effect
    // again — that is the second branch of the invariant, not a violation of the first.
    const third = deliver('BL-X1#2')
    expect(third.applied).toBe(true)
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(third.idempotencyKey).toBe(idempotencyKey('BL-X1', 'BL-X1#2', 'CLAIMED->RUNNING'))
    expect(effects).toHaveLength(2)

    // At the QUEUE layer the same duplication is answered by the singleton key: a repeated
    // enqueue while the item is pending coalesces instead of creating a second task.
    // (The send-call recorder proving the option is sent lives in pgboss-backend.test.ts;
    // what matters here is only that the census does not move.)
    const again = await adapter.enqueue(backlog({ id: 'BL-X1' }))
    expect(again.coalesced).toBe(true)

    const after = await census(adapter, store)
    expect(after, 'redelivery drill: the number of tasks accounted for after the duplicate delivery must equal the number before').toBe(before)
  })
})
