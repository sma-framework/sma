/**
 * adapter.mjs — the QueueAdapter seam (D-9.5-02c): ONE interface, a reusable
 * contract test factory, and an in-memory reference backend (Phase 9.5 Plan 01).
 *
 * WHY THIS FILE EXISTS: everything in waves 2-4 (the pg-boss backend, the runner,
 * the tick, the front) builds against THIS interface. Interface-first — the contract
 * lands before any implementation. The seam is honest because `queueAdapterContractSuite`
 * is an EXECUTABLE spec: plan 9.5-03 re-runs this exact suite against the pg-boss
 * backend, and the deferred file backend (D-9.5-02c) will re-run it too. A backend
 * that passes the suite IS a conforming QueueAdapter; nothing else certifies it.
 *
 * BACKEND-FREE BY LAW: this module imports NO backend (no pg-boss, no pg, no fs
 * beyond none). The interface must never learn its implementations. The future file
 * backend (deferred, D-9.5-02c) will implement its atomic checkout via the
 * claims.mjs `mkdirSync`-EEXIST primitive + a JSONL journal of transitions — this is
 * a SEAM NOTE only; it is not implemented here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TASK SHAPE (single source of truth — every later plan consumes this):
 *
 * task = {
 *   id: string,                 // 'BL-96' (backlog), 'R-<epochMs>' (roster), 'F-<epochMs>' (forge, D-9.5-09)
 *   source: 'backlog'|'roster'|'return',
 *   title: string,              // <= 200 chars, plain text
 *   lane: 'prod'|'research'|'paperwork'|'forge',  // 'forge' = draft generation (D-9.5-09)
 *   provider?: 'claude'|'codex'|'api',            // per-task override (D-9.5-04)
 *   model?: string, effort?: string,              // per-task overrides
 *   priority: number,           // 0 default; higher fetched first
 *   attempt: number,            // 1-based; incremented on requeue
 *   storyPoints?: number,       // CUE estimate, Fibonacci ONLY: 1|2|3|5|8|13 (D-9.5-10); REQUIRED when source==='backlog'
 *   acceptance?: string,        // приёмочные критерии, <= 2000; REQUIRED when source==='backlog' (D-9.5-10 DoR)
 *   note?: string,              // return-with-comment text, <= 2000
 *   forge?: {                   // REQUIRED iff lane==='forge', forbidden otherwise (D-9.5-09)
 *     kind: 'agent'|'skill'|'mcp',
 *     description: string       // founder free text, <= 2000 — DATA, never instructions
 *   }
 * }
 *
 * QueueAdapter methods (all async):
 *   enqueue(task)                 → {id, coalesced, coalesceCount}; validateTask on every path
 *   claimNext(workerId, {lanes})  → atomic checkout RESTRICTED to `lanes`; null when empty or
 *                                   no queued task in those lanes. The tick derives eligible
 *                                   lanes from OPEN workers BEFORE claiming (grill CH-9.5-07),
 *                                   so a claimed task is always runnable. lanes:[] → null,
 *                                   no mutation. lanes omitted → all lanes eligible.
 *   touch(taskId)                 → refresh the liveness clock on a claimed task
 *   complete(taskId, result)      → result MUST carry `receiptRef` (Pitfall 6) else NoReceiptError
 *   fail(taskId, reason)          → reason ∈ FAIL_REASONS else InvalidFailReasonError
 *   list(filter)                  → rows expose enqueuedAt/claimedAt/completedAt (D-9.5-10)
 *   stats()                       → per-status counts
 *
 * TIMESTAMPS (D-9.5-10): enqueue stamps enqueuedAt, claimNext stamps claimedAt,
 * complete stamps completedAt — the raw material for post-pilot flow metrics (cycle
 * time, aging WIP). No dashboard in V5; recording them now is three fields, migrating
 * pilot data later would be a chore.
 *
 * Node built-ins only (in fact none needed). `clock` is dependency-injected so the
 * liveness/expiry path is deterministic in tests. The contract suite reads the vitest
 * API from globalThis (test.globals) — NO top-level vitest import, so the production
 * daemon can import this module without dev dependencies.
 */

// ── constants (the closed vocabularies) ──

/** Task intake origins. `backlog` = BL-item scan, `roster` = a founder button, `return` = requeue-with-comment. */
export const TASK_SOURCES = Object.freeze(['backlog', 'roster', 'return'])

/** Execution lanes. `forge` = draft generation for the «Создатель» role (D-9.5-09). */
export const TASK_LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/**
 * The human-readable failure taxonomy (D-9.5-11). `fail(taskId, reason)` accepts ONLY
 * these; the roster renders the RU подпись from REASON_LABELS, never the raw code.
 *   no_receipt      — the exit gate produced no reverify receipt
 *   agent_error     — the worker process errored
 *   tests_red       — a red reverify receipt (targeted tests failed)
 *   needs_decision  — the worker surfaced a call only a human can make
 *   missing_access  — credentials / permissions absent
 *   timeout / runtime_offline / window_exhausted — infra causes
 *   manual          — a human stopped it
 */
export const FAIL_REASONS = Object.freeze([
  'no_receipt',
  'agent_error',
  'tests_red',
  'needs_decision',
  'missing_access',
  'timeout',
  'runtime_offline',
  'window_exhausted',
  'manual',
])

/** RU подписи для красной карточки ростера — single source; план 08 передаёт, план 09 рендерит (D-9.5-11). */
export const REASON_LABELS = Object.freeze({
  no_receipt: 'нет квитанции — работа не подтверждена',
  agent_error: 'ошибка работника',
  tests_red: 'тесты красные',
  needs_decision: 'нужно решение человека',
  missing_access: 'нужен человек: не хватает доступа',
  timeout: 'истекло время',
  runtime_offline: 'среда исполнения недоступна',
  window_exhausted: 'окно подписки исчерпано',
  manual: 'остановлено вручную',
})

const PROVIDERS = Object.freeze(['claude', 'codex', 'api'])
const FORGE_KINDS = Object.freeze(['agent', 'skill', 'mcp'])
const STORY_POINTS = Object.freeze([1, 2, 3, 5, 8, 13]) // Fibonacci ONLY (D-9.5-10)

/** The explicit field allowlist — the ONLY keys a task record carries (notify.mjs explicit-pick posture). */
const ALLOWED_TASK_KEYS = Object.freeze([
  'id', 'source', 'title', 'lane', 'provider', 'model', 'effort',
  'priority', 'attempt', 'storyPoints', 'acceptance', 'note', 'forge',
])

const CAP_TITLE = 200
const CAP_TEXT = 2000

// ── named errors ──

export class InvalidTaskError extends Error {
  constructor(message) { super(message); this.name = 'InvalidTaskError' }
}
/** DoR gate (D-9.5-10): a backlog task without a CUE estimate + acceptance is not ready to dispatch. */
export class NotReadyError extends Error {
  constructor(message) { super(message); this.name = 'NotReadyError' }
}
export class InvalidStoryPointsError extends Error {
  constructor(message) { super(message); this.name = 'InvalidStoryPointsError' }
}
/** Pitfall 6: no self-certified done — complete() refuses without a receiptRef. */
export class NoReceiptError extends Error {
  constructor(message) { super(message); this.name = 'NoReceiptError' }
}
export class InvalidFailReasonError extends Error {
  constructor(message) { super(message); this.name = 'InvalidFailReasonError' }
}
export class UnknownTaskError extends Error {
  constructor(message) { super(message); this.name = 'UnknownTaskError' }
}

// ── validateTask (the enqueue gate — field allowlist + caps + DoR + forge) ──

/**
 * validateTask(task) → a normalized, explicit-pick copy (defaults applied). Throws a
 * named error on any violation. The single validation path every enqueue routes through.
 *
 * @param {object} task
 * @returns {object} normalized task
 */
export function validateTask(task) {
  if (!task || typeof task !== 'object') throw new InvalidTaskError('task is not an object')
  if (!task.id || typeof task.id !== 'string') throw new InvalidTaskError('task missing string "id"')
  if (!TASK_SOURCES.includes(task.source)) throw new InvalidTaskError(`task "${task.id}" has invalid source "${task.source}"`)
  if (typeof task.title !== 'string' || task.title.length === 0) throw new InvalidTaskError(`task "${task.id}" missing "title"`)
  if (task.title.length > CAP_TITLE) throw new InvalidTaskError(`task "${task.id}" title exceeds ${CAP_TITLE} chars`)
  if (!TASK_LANES.includes(task.lane)) throw new InvalidTaskError(`task "${task.id}" has invalid lane "${task.lane}"`)
  if (task.provider !== undefined && !PROVIDERS.includes(task.provider)) {
    throw new InvalidTaskError(`task "${task.id}" has invalid provider "${task.provider}"`)
  }
  if (task.note !== undefined && String(task.note).length > CAP_TEXT) {
    throw new InvalidTaskError(`task "${task.id}" note exceeds ${CAP_TEXT} chars`)
  }
  if (task.acceptance !== undefined && String(task.acceptance).length > CAP_TEXT) {
    throw new InvalidTaskError(`task "${task.id}" acceptance exceeds ${CAP_TEXT} chars`)
  }
  if (task.priority !== undefined && typeof task.priority !== 'number') {
    throw new InvalidTaskError(`task "${task.id}" priority must be a number`)
  }

  // forge object: REQUIRED iff lane==='forge', forbidden otherwise (D-9.5-09)
  if (task.lane === 'forge') {
    if (!task.forge || typeof task.forge !== 'object') {
      throw new InvalidTaskError(`forge task "${task.id}" requires a forge object`)
    }
    if (!FORGE_KINDS.includes(task.forge.kind)) {
      throw new InvalidTaskError(`forge task "${task.id}" has invalid forge.kind "${task.forge.kind}"`)
    }
    if (typeof task.forge.description !== 'string' || task.forge.description.length === 0) {
      throw new InvalidTaskError(`forge task "${task.id}" requires a non-empty forge.description`)
    }
    if (task.forge.description.length > CAP_TEXT) {
      throw new InvalidTaskError(`forge task "${task.id}" description exceeds ${CAP_TEXT} chars`)
    }
  } else if (task.forge !== undefined) {
    throw new InvalidTaskError(`non-forge task "${task.id}" must not carry a forge object`)
  }

  // DoR gate (D-9.5-10): backlog REQUIRES storyPoints ∈ Fibonacci AND non-empty acceptance.
  // roster/return are founder-explicit and exempt (expedite by nature — no friction).
  if (task.source === 'backlog') {
    const hasAcceptance = task.acceptance !== undefined && String(task.acceptance).trim() !== ''
    if (task.storyPoints === undefined || !hasAcceptance) {
      throw new NotReadyError(
        `backlog task "${task.id}" is not ready: storyPoints + acceptance both required (D-9.5-10 DoR)`,
      )
    }
    if (!STORY_POINTS.includes(task.storyPoints)) {
      throw new InvalidStoryPointsError(`task "${task.id}" storyPoints must be one of ${STORY_POINTS.join('|')}`)
    }
  } else if (task.storyPoints !== undefined && !STORY_POINTS.includes(task.storyPoints)) {
    // exempt from the DoR requirement, but a supplied estimate must still be valid Fibonacci
    throw new InvalidStoryPointsError(`task "${task.id}" storyPoints must be one of ${STORY_POINTS.join('|')}`)
  }

  // explicit-pick normalized copy (allowlist) + defaults
  const out = {}
  for (const k of ALLOWED_TASK_KEYS) if (task[k] !== undefined) out[k] = task[k]
  out.priority = typeof task.priority === 'number' ? task.priority : 0
  out.attempt = typeof task.attempt === 'number' && task.attempt >= 1 ? task.attempt : 1
  return out
}

// ── in-memory reference backend (the executable spec) ──

/**
 * createMemoryQueue({clock, expireMs}) — the reference QueueAdapter over plain Maps.
 * Used by the contract suite AND as the executable spec for the pg-boss backend
 * (plan 9.5-03) and the future file backend. Any `Map` of live tasks in the DAEMON
 * would be a bug (D-9.5-02 stateless-tick law) — but THIS is the reference backend
 * itself, whose whole job is to hold the durable state a real backend keeps in PG.
 *
 * @param {{clock?:Function|number, expireMs?:number}} [opts]
 * @returns {object} a QueueAdapter
 */
export function createMemoryQueue({ clock = Date.now, expireMs = 15 * 60 * 1000 } = {}) {
  /** id -> internal record */
  const records = new Map()
  const now = () => (typeof clock === 'function' ? clock() : clock)

  /** Liveness sweep: a claimed task not touched within expireMs returns to queued, attempt+1. */
  function sweep() {
    const t = now()
    for (const rec of records.values()) {
      if (rec.status === 'claimed' && t - rec.lastTouch > expireMs) {
        rec.status = 'queued'
        rec.workerId = null
        rec.claimedAt = null
        rec.lastTouch = null
        rec.attempt += 1
        rec.task = { ...rec.task, attempt: rec.attempt }
      }
    }
  }

  function row(rec) {
    return {
      id: rec.task.id,
      source: rec.task.source,
      lane: rec.task.lane,
      title: rec.task.title,
      priority: rec.task.priority,
      status: rec.status,
      attempt: rec.attempt,
      coalesceCount: rec.coalesceCount,
      workerId: rec.workerId,
      storyPoints: rec.task.storyPoints,
      acceptance: rec.task.acceptance,
      enqueuedAt: rec.enqueuedAt,
      claimedAt: rec.claimedAt,
      completedAt: rec.completedAt,
      failure_reason: rec.failure_reason,
    }
  }

  async function enqueue(task) {
    const norm = validateTask(task)
    const existing = records.get(norm.id)
    if (existing && existing.status === 'queued') {
      // Pattern 5: ONE pending entry per item — coalesce, keep the original enqueuedAt.
      existing.coalesceCount += 1
      return { id: norm.id, coalesced: true, coalesceCount: existing.coalesceCount }
    }
    const t = now()
    records.set(norm.id, {
      task: norm,
      status: 'queued',
      coalesceCount: 1,
      attempt: norm.attempt,
      workerId: null,
      enqueuedAt: t,
      claimedAt: null,
      completedAt: null,
      lastTouch: null,
      result: null,
      failure_reason: null,
    })
    return { id: norm.id, coalesced: false, coalesceCount: 1 }
  }

  async function claimNext(workerId, { lanes } = {}) {
    sweep()
    // lanes:[] → nothing eligible, return null WITHOUT mutating anything (grill CH-9.5-07-1).
    if (Array.isArray(lanes) && lanes.length === 0) return null
    const laneSet = Array.isArray(lanes) ? new Set(lanes) : null

    let best = null
    for (const rec of records.values()) {
      if (rec.status !== 'queued') continue
      if (laneSet && !laneSet.has(rec.task.lane)) continue
      if (!best) { best = rec; continue }
      if (rec.task.priority > best.task.priority) best = rec
      else if (rec.task.priority === best.task.priority && rec.enqueuedAt < best.enqueuedAt) best = rec
    }
    if (!best) return null

    const t = now()
    best.status = 'claimed'
    best.workerId = workerId
    best.claimedAt = t
    best.lastTouch = t
    return { ...best.task }
  }

  async function touch(taskId) {
    const rec = records.get(taskId)
    if (!rec || rec.status !== 'claimed') return false
    rec.lastTouch = now()
    return true
  }

  async function complete(taskId, result) {
    const rec = records.get(taskId)
    if (!rec) throw new UnknownTaskError(`complete: unknown task "${taskId}"`)
    if (!result || !result.receiptRef) {
      throw new NoReceiptError(`complete("${taskId}") refused: result must carry a receiptRef (Pitfall 6)`)
    }
    rec.status = 'completed'
    rec.completedAt = now()
    rec.result = result
    return true
  }

  async function fail(taskId, reason) {
    if (!FAIL_REASONS.includes(reason)) {
      throw new InvalidFailReasonError(`fail: "${reason}" is not one of ${FAIL_REASONS.join('|')}`)
    }
    const rec = records.get(taskId)
    if (!rec) throw new UnknownTaskError(`fail: unknown task "${taskId}"`)
    rec.status = 'failed'
    rec.failure_reason = reason
    return true
  }

  async function list(filter = {}) {
    sweep()
    let rows = [...records.values()]
    if (filter.status) rows = rows.filter((r) => r.status === filter.status)
    if (filter.lane) rows = rows.filter((r) => r.task.lane === filter.lane)
    return rows.map(row)
  }

  async function stats() {
    sweep()
    const s = { queued: 0, claimed: 0, completed: 0, failed: 0, total: records.size }
    for (const rec of records.values()) s[rec.status] = (s[rec.status] ?? 0) + 1
    return s
  }

  return { enqueue, claimNext, touch, complete, fail, list, stats }
}

// ── the reusable contract suite (executable spec any backend must pass) ──

/**
 * queueAdapterContractSuite(name, makeAdapter) — register the full QueueAdapter
 * contract as a vitest describe/it block against ANY adapter factory. This is what
 * makes the D-9.5-02c seam honest: plan 9.5-03 re-runs this exact suite against the
 * pg-boss backend, the future file backend re-runs it too.
 *
 * `makeAdapter({clock, expireMs})` returns a fresh adapter. The suite owns a mutable
 * fake clock per test so the liveness/expiry path is deterministic.
 *
 * The vitest API is read from globalThis (test.globals) — NO top-level vitest import,
 * so the production daemon imports this module dependency-free.
 *
 * @param {string} name
 * @param {(opts:{clock:Function, expireMs:number}) => object} makeAdapter
 */
export function queueAdapterContractSuite(name, makeAdapter) {
  const { describe, it, expect } = globalThis
  if (!describe || !it || !expect) {
    throw new Error('queueAdapterContractSuite requires the vitest globals (test.globals: true)')
  }

  const backlog = (over = {}) => ({
    id: 'BL-96',
    source: 'backlog',
    title: 'do the thing',
    lane: 'prod',
    priority: 0,
    attempt: 1,
    storyPoints: 3,
    acceptance: 'green targeted tests + reverify receipt',
    ...over,
  })

  const clockOf = (start = 1000) => {
    const s = { now: start }
    return { fn: () => s.now, advance: (ms) => (s.now += ms) }
  }

  describe(`QueueAdapter contract: ${name}`, () => {
    it('enqueue then claimNext returns the task; a second claimNext returns null (atomic checkout)', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      const claimed = await q.claimNext('w1', {})
      expect(claimed.id).toBe('BL-96')
      expect(await q.claimNext('w2', {})).toBeNull()
    })

    it('a repeated enqueue while pending coalesces to one entry with a counter', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      const again = await q.enqueue(backlog())
      expect(again.coalesced).toBe(true)
      expect(again.coalesceCount).toBe(2)
      expect(await q.list({ status: 'queued' })).toHaveLength(1)
    })

    it('complete refuses without a receiptRef (NoReceiptError) and accepts one with it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      await expect(q.complete('BL-96', {})).rejects.toThrow(/receipt/i)
      await q.complete('BL-96', { receiptRef: 'reverify:abc' })
      const [r] = await q.list({})
      expect(r.status).toBe('completed')
    })

    it('fail rejects an unknown reason and records a valid one', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      await expect(q.fail('BL-96', 'bogus')).rejects.toThrow()
      await q.fail('BL-96', 'missing_access')
      const [r] = await q.list({})
      expect(r.status).toBe('failed')
      expect(r.failure_reason).toBe('missing_access')
    })

    it('a claimed task not touched within expireMs returns to queued with attempt+1', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(6000) // past expireMs, no touch
      const [r] = await q.list({})
      expect(r.status).toBe('queued')
      expect(r.attempt).toBe(2)
    })

    it('touch keeps a claimed task alive past what would otherwise expire it', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(4000)
      await q.touch('BL-96')
      c.advance(4000) // 8000 since claim, but only 4000 since touch
      const [r] = await q.list({})
      expect(r.status).toBe('claimed')
    })

    it('higher priority is claimed first', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-low', priority: 0 }))
      await q.enqueue(backlog({ id: 'BL-high', priority: 5 }))
      const claimed = await q.claimNext('w1', {})
      expect(claimed.id).toBe('BL-high')
    })

    it('enqueue stamps enqueuedAt, claimNext claimedAt, complete completedAt — all in list() rows', async () => {
      const c = clockOf(5000)
      const q = makeAdapter({ clock: c.fn, expireMs: 100000 })
      await q.enqueue(backlog())
      c.advance(100)
      await q.claimNext('w1', {})
      c.advance(100)
      await q.complete('BL-96', { receiptRef: 'reverify:xyz' })
      const [r] = await q.list({})
      expect(r.enqueuedAt).toBe(5000)
      expect(r.claimedAt).toBe(5100)
      expect(r.completedAt).toBe(5200)
    })

    it('the DoR gate rejects a backlog task with no estimate; a roster task is exempt', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await expect(q.enqueue(backlog({ storyPoints: undefined }))).rejects.toThrow(/not ready|DoR/i)
      await q.enqueue({ id: 'R-1', source: 'roster', title: 'expedite', lane: 'prod' })
      expect(await q.list({ status: 'queued' })).toHaveLength(1)
    })

    it('claimNext with a lane filter returns ONLY those lanes even when a higher-priority other-lane task waits', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-prod', lane: 'prod', priority: 9 }))
      await q.enqueue({ id: 'R-res', source: 'roster', title: 'research it', lane: 'research', priority: 0 })
      const claimed = await q.claimNext('w-research', { lanes: ['research'] })
      expect(claimed.id).toBe('R-res')
      // the high-priority prod task is untouched
      const prod = (await q.list({ lane: 'prod' }))[0]
      expect(prod.status).toBe('queued')
    })

    it('claimNext with lanes:[] returns null and mutates nothing', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      expect(await q.claimNext('w1', { lanes: [] })).toBeNull()
      const [r] = await q.list({})
      expect(r.status).toBe('queued')
    })

    it('stats() reflects every transition', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-a' }))
      await q.enqueue(backlog({ id: 'BL-b' }))
      await q.claimNext('w1', {})
      const s = await q.stats()
      expect(s.total).toBe(2)
      expect(s.queued).toBe(1)
      expect(s.claimed).toBe(1)
    })
  })
}
