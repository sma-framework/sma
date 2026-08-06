/**
 * adapter.mjs — the QueueAdapter seam: ONE interface, a reusable contract test
 * factory, and an in-memory reference backend.
 *
 * WHY THIS FILE EXISTS: the pg-boss backend, the runner, the tick and the front all
 * build against THIS interface. Interface-first — the contract lands before any
 * implementation. The seam is honest because `queueAdapterContractSuite` is an
 * EXECUTABLE spec: the pg-boss backend re-runs this exact suite, and the deferred file
 * backend will re-run it too. A backend that passes the suite IS a conforming
 * QueueAdapter; nothing else certifies it.
 *
 * BACKEND-FREE BY LAW: this module imports NO backend (no pg-boss, no pg, no fs
 * beyond none). The interface must never learn its implementations. The future file
 * backend (deferred) will implement its atomic checkout via the
 * claims.mjs `mkdirSync`-EEXIST primitive + a JSONL journal of transitions — this is
 * a SEAM NOTE only; it is not implemented here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TASK SHAPE (single source of truth — every later plan consumes this):
 *
 * task = {
 *   id: string,                 // 'BL-96' (backlog), 'R-<epochMs>' (roster), 'F-<epochMs>' (forge)
 *   source: 'backlog'|'roster'|'return',
 *   title: string,              // <= 200 chars, plain text
 *   lane: 'prod'|'research'|'paperwork'|'forge',  // 'forge' = draft generation
 *   provider?: 'claude'|'codex'|'api',            // per-task override of lane routing
 *   model?: string, effort?: string,              // per-task overrides
 *   priority: number,           // 0 default; higher fetched first
 *   attempt: number,            // 1-based; incremented on requeue
 *   storyPoints?: number,       // CUE estimate, Fibonacci ONLY: 1|2|3|5|8|13; REQUIRED when source==='backlog'
 *   acceptance?: string,        // приёмочные критерии, <= 2000; REQUIRED when source==='backlog' (DoR)
 *   note?: string,              // return-with-comment text, <= 2000
 *   project?: string,           // V5.1: the project slug this task belongs to.
 *                               // Optional on the wire, ALWAYS present on a read row.
 *   forge?: {                   // REQUIRED iff lane==='forge', forbidden otherwise
 *     kind: 'agent'|'skill'|'mcp',
 *     description: string       // founder free text, <= 2000 — DATA, never instructions
 *   }
 * }
 *
 * ═══════════════ V5.1: PROJECT IS ADDITIVE, THE BACKFILL IS ON READ ═════════════
 * `project` is optional on the wire. An adapter is constructed with the
 * config's `activeProject`, which an enqueue stamps onto a task that names none. LANE and
 * PROJECT are independent dimensions — a forge task in another project is perfectly valid.
 *
 * Rows written BEFORE the field existed are backfilled ON READ (`backfillProject`), never
 * by an UPDATE/ALTER over the live queue: the daemon is not the source of truth
 * for its own history, so an existing task is never rewritten — only read completely.
 *
 * The adapter stays BACKEND-FREE and IMPORT-FREE: the active project arrives by injection,
 * so this module still learns nothing about the config module or any backend. The slug
 * grammar below is deliberately a local constant rather than an import for the same reason.
 *
 * QueueAdapter methods (all async):
 *   enqueue(task)                 → {id, coalesced, coalesceCount}; validateTask on every path
 *   claimNext(workerId, {lanes})  → atomic checkout RESTRICTED to `lanes`; null when empty or
 *                                   no queued task in those lanes. The tick derives eligible
 *                                   lanes from OPEN workers BEFORE claiming,
 *                                   so a claimed task is always runnable. lanes:[] → null,
 *                                   no mutation. lanes omitted → all lanes eligible.
 *   touch(taskId)                 → refresh the liveness clock on a claimed task
 *   complete(taskId, result)      → result MUST carry `receiptRef` else NoReceiptError
 *   fail(taskId, reason)          → reason ∈ FAIL_REASONS else InvalidFailReasonError
 *   list(filter)                  → rows expose enqueuedAt/claimedAt/completedAt
 *   stats()                       → per-status counts
 *
 * TIMESTAMPS: enqueue stamps enqueuedAt, claimNext stamps claimedAt,
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

/** Execution lanes. `forge` = draft generation for the «Создатель» role. */
export const TASK_LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/**
 * The human-readable failure taxonomy. `fail(taskId, reason)` accepts ONLY
 * these; the roster renders the RU подпись from REASON_LABELS, never the raw code.
 *   no_receipt      — the exit gate produced no reverify receipt
 *   no_journal      — the attempt left no approach note: the work may be
 *                     certified, but it never explained itself, and an unexplained attempt
 *                     is incomplete by the same law that makes an uncertified one incomplete
 *   agent_error     — the worker process errored
 *   tests_red       — a red reverify receipt (targeted tests failed)
 *   needs_decision  — the worker surfaced a call only a human can make
 *   missing_access  — credentials / permissions absent
 *   timeout / runtime_offline / window_exhausted — infra causes
 *   manual          — a human stopped it
 */
export const FAIL_REASONS = Object.freeze([
  'no_receipt',
  'no_journal',
  'agent_error',
  'tests_red',
  'needs_decision',
  'missing_access',
  'timeout',
  'runtime_offline',
  'window_exhausted',
  'manual',
])

/** RU подписи для красной карточки ростера — единственный источник: сервер передаёт, экран рендерит. */
export const REASON_LABELS = Object.freeze({
  no_receipt: 'нет квитанции — работа не подтверждена',
  no_journal: 'нет записки о подходе — попытка не объяснена',
  agent_error: 'ошибка работника',
  tests_red: 'тесты красные',
  needs_decision: 'нужно решение человека',
  missing_access: 'нужен человек: не хватает доступа',
  timeout: 'истекло время',
  runtime_offline: 'среда исполнения недоступна',
  window_exhausted: 'окно подписки исчерпано',
  manual: 'остановлено вручную',
})

/**
 * THE ONE LIVENESS VALUE. Two mechanisms answer «has this worker gone silent»: the tick's
 * explicit sweep (liveness.mjs) and the queue's own lease expiry inside the backend. They
 * are belt and suspenders for the SAME event, so they must read the same number — and until
 * now they did not: the config's value reached the sweep, the backend was constructed
 * without it, and its lease ran on the built-in default no matter what the operator wrote.
 * Nothing said so; the two clocks simply disagreed. The constant and the resolver live HERE,
 * in the interface both the sweep and every backend already build against, so neither side
 * owns a private copy of the number.
 */
export const DEFAULT_EXPIRE_MS = 120000

/**
 * resolveExpireMs(config) → the liveness/lease duration in ms for THIS config.
 *
 * A hand-edited config file is a trust boundary and this number does not stay inside the
 * process: the backend divides it by 1000 and hands `expireInSeconds` to the queue. So
 * anything that is not a positive finite number — `"5m"`, 0, a negative, NaN, Infinity —
 * falls back to the default rather than travelling on as a lease made out of a typo. PURE.
 *
 * @param {{expireMs?:number}} [config]
 * @returns {number}
 */
export function resolveExpireMs(config) {
  const raw = config && typeof config === 'object' ? config.expireMs : undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_EXPIRE_MS
  return raw
}

const PROVIDERS = Object.freeze(['claude', 'codex', 'api'])
const FORGE_KINDS = Object.freeze(['agent', 'skill', 'mcp'])
const STORY_POINTS = Object.freeze([1, 2, 3, 5, 8, 13]) // Fibonacci ONLY

/** The explicit field allowlist — the ONLY keys a task record carries (notify.mjs explicit-pick posture). */
const ALLOWED_TASK_KEYS = Object.freeze([
  'id', 'source', 'title', 'lane', 'provider', 'model', 'effort',
  'priority', 'attempt', 'storyPoints', 'acceptance', 'note', 'project', 'forge',
])

/**
 * The project slug grammar. A LOCAL constant, not an import: this module must
 * stay free of the config module to keep the backend-free/import-free law intact. Kept in
 * agreement with config.mjs's PROJECT_ID_RE by the tests on both sides.
 */
const TASK_PROJECT_RE = /^[a-z0-9-]{1,64}$/

/** The project a read row falls back to when nothing else names one. */
export const DEFAULT_PROJECT_ID = 'default'

const CAP_TITLE = 200
const CAP_TEXT = 2000

// ── named errors ──

export class InvalidTaskError extends Error {
  constructor(message) { super(message); this.name = 'InvalidTaskError' }
}
/** DoR gate: a backlog task without a CUE estimate + acceptance is not ready to dispatch. */
export class NotReadyError extends Error {
  constructor(message) { super(message); this.name = 'NotReadyError' }
}
export class InvalidStoryPointsError extends Error {
  constructor(message) { super(message); this.name = 'InvalidStoryPointsError' }
}
/** No self-certified done — complete() refuses without a receiptRef. */
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
  // project: STRUCTURAL only. Whether the slug names a REGISTERED project is
  // the door's question (it owns the config); the adapter never learns the registry.
  if (task.project !== undefined && (typeof task.project !== 'string' || !TASK_PROJECT_RE.test(task.project))) {
    throw new InvalidTaskError(`task "${task.id}" has an invalid project "${task.project}"`)
  }

  // forge object: REQUIRED iff lane==='forge', forbidden otherwise
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

  // DoR gate: backlog REQUIRES storyPoints ∈ Fibonacci AND non-empty acceptance.
  // roster/return are founder-explicit and exempt (expedite by nature — no friction).
  if (task.source === 'backlog') {
    const hasAcceptance = task.acceptance !== undefined && String(task.acceptance).trim() !== ''
    if (task.storyPoints === undefined || !hasAcceptance) {
      throw new NotReadyError(
        `backlog task "${task.id}" is not ready: a backlog task must carry both a storyPoints ` +
          `estimate and acceptance criteria before it can be dispatched`,
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

/**
 * backfillProject(row, activeProject) → the same row guaranteed to carry a project
 * A row written before the field existed is COMPLETED on read, never
 * rewritten on disk: the queue's history stays exactly as it was recorded, and the
 * migration cost of multi-project is zero rows touched. Pure; a nullish row passes through.
 *
 * @param {object|null} row
 * @param {string} [activeProject]
 * @returns {object|null}
 */
export function backfillProject(row, activeProject) {
  if (!row || typeof row !== 'object') return row
  if (typeof row.project === 'string' && row.project !== '') return row
  return { ...row, project: activeProject || DEFAULT_PROJECT_ID }
}

// ── in-memory reference backend (the executable spec) ──

/**
 * createMemoryQueue({clock, expireMs, activeProject}) — the reference QueueAdapter over
 * plain Maps.
 * Used by the contract suite AND as the executable spec for the pg-boss backend
 * and the future file backend. Any `Map` of live tasks in the DAEMON
 * would be a bug (the tick is stateless by law) — but THIS is the reference backend
 * itself, whose whole job is to hold the durable state a real backend keeps in PG.
 *
 * `activeProject` is the config's currently selected project, injected by the
 * composition root — the adapter never reads the config itself. An enqueue stamps it onto
 * a task that names no project; every read path backfills it onto a row that predates the
 * field.
 *
 * @param {{clock?:Function|number, expireMs?:number, activeProject?:string}} [opts]
 * @returns {object} a QueueAdapter
 */
export function createMemoryQueue({ clock = Date.now, expireMs = 15 * 60 * 1000, activeProject } = {}) {
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
    return backfillProject({
      id: rec.task.id,
      source: rec.task.source,
      lane: rec.task.lane,
      project: rec.task.project,
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
    }, activeProject)
  }

  async function enqueue(task) {
    const norm = validateTask(task)
    // a task that names no project joins the currently active one.
    if (norm.project === undefined && activeProject) norm.project = activeProject
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
    // lanes:[] → nothing eligible, return null WITHOUT mutating anything.
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
    return backfillProject({ ...best.task }, activeProject)
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
      throw new NoReceiptError(
        `complete("${taskId}") refused: result must carry a receiptRef — work is never ` +
          `certified done on the runner's own word`,
      )
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
    // an optional project filter; its absence means EVERY project.
    if (filter.project) {
      rows = rows.filter((r) => (r.task.project || activeProject || DEFAULT_PROJECT_ID) === filter.project)
    }
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
 * makes the seam honest: the pg-boss backend re-runs this exact suite, and the future
 * file backend re-runs it too.
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
