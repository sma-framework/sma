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
 *   batchId?: string,           // the batch this row belongs to — see BATCH below
 *   forge?: {                   // REQUIRED iff lane==='forge', forbidden otherwise
 *     kind: 'agent'|'skill'|'mcp',
 *     description: string       // founder free text, <= 2000 — DATA, never instructions
 *   }
 * }
 *
 * ═══════════ A BATCH IS A FACT OF THE QUEUE, NEVER A GROUPING ON A SCREEN ═══════════
 * One request of the owner («разгреби мелочь перед демо») fans out into N pieces of work and
 * converges back into one assembly. Both halves of that sentence have to be true somewhere
 * durable, or a screen drawing a batch would be drawing a word over ordinary tasks: kinship
 * that lives only in a payload the front assembles is kinship two readers can disagree about.
 *
 * So the queue carries both halves and nothing else does:
 *   - AN ITEM names its batch in `batchId`. It is ordinary work in every other respect —
 *     claimed, run, completed and failed exactly like a task with no batch at all.
 *   - THE REQUEST ITSELF is a row too, marked `data.batch === 'parent'` and carrying the same
 *     `batchId` (its own id, so nothing has to hold two identifiers that could disagree).
 *
 * AND THE PARENT IS NEVER HANDED TO A WORKER. It is a record of what was asked, not a piece
 * of work: `claimNext` may not return it on any ordering, and `stats()` does not count it as
 * queued work — a row no worker will ever take, counted in the number beside «в очереди»,
 * is a number that never goes down. Each backend keeps that promise its own way (the
 * reference backend by refusing the record, the durable one by keeping parents out of the
 * lane queues entirely), and the contract suite asserts the PROMISE rather than either
 * mechanism. What holds an assembly open is computed by a reader from the items' statuses and
 * is never stored — a stored one would be a second truth about the same five statuses.
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
 *   list(filter)                  → rows expose enqueuedAt/claimedAt/leaseRenewedAt/completedAt
 *   stats()                       → per-status counts, one key per TASK_STATUSES entry
 *
 * FINISHED IS NOT ACCEPTED. `complete()` carries a receipt, and a receipt is the worker's
 * half of done — the other half is a person saying so. So a completed task reads back as
 * `awaiting_approval`, never as `completed`, at EVERY backend: the status a screen shows is
 * a property of the task, and a front that had to derive «waiting for a person» for itself
 * would be a second reading path, silently diverging from the first.
 *
 * TIMESTAMPS: enqueue stamps enqueuedAt, claimNext stamps claimedAt,
 * complete stamps completedAt — the raw material for post-pilot flow metrics (cycle
 * time, aging WIP). No dashboard in V5; recording them now is three fields, migrating
 * pilot data later would be a chore.
 *
 * A FOURTH ONE, BECAUSE «TAKEN» AND «STILL ALIVE» ARE TWO FACTS. `touch` renews the lease, and
 * a durable backend renews it by restamping the very clock it recorded the claim on — so for as
 * long as one field answered both questions, every running task reported a duration of about
 * zero, refreshed every couple of minutes, while the work actually ran for an hour. `claimedAt`
 * is now the moment the attempt in flight was taken and is never moved by a renewal;
 * `leaseRenewedAt` is the renewal clock, and it is what a liveness sweep must read. Both are
 * null while nothing holds the task. The contract suite asserts the difference on every backend
 * — a backend that keeps answering both from one clock is not a conforming adapter.
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
 * THE CLOSED STATUS VOCABULARY of a read row — every `list()` row and every `stats()` key
 * of every backend is one of these five, and a backend that answers anything else is not a
 * conforming adapter.
 *
 *   queued            — waiting for a WORKER
 *   claimed           — a worker holds it
 *   awaiting_approval — the work is done and certified, and now owes a PERSON a word
 *   completed         — a person said yes
 *   failed            — the attempt did not produce
 *
 * `awaiting_approval` is here rather than derived on a screen for one reason: a durable
 * backend already RECORDS that state (the daemon's own approval row), so deriving it a
 * second time in the front would be a second source of the same truth. The two would
 * disagree the first time either changed, and nothing would say so.
 */
export const TASK_STATUSES = Object.freeze([
  'queued',
  'claimed',
  'awaiting_approval',
  'completed',
  'failed',
])

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
 *   no_artifact     — a DOCUMENTARY stage claimed to be done and left no document: the file
 *                     its stage is supposed to produce is absent from the phase directory, or
 *                     it is on disk but was never committed. It is the exact counterpart of
 *                     `no_receipt` for work whose product is prose rather than code — the two
 *                     exist so that «done» is never the worker's own word on either side
 *   timeout / runtime_offline / window_exhausted — infra causes
 *   manual          — a human stopped it
 */
export const FAIL_REASONS = Object.freeze([
  'no_receipt',
  'no_journal',
  'no_artifact',
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
  no_artifact: 'нет документа — стадия не оставила своего файла',
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

/**
 * WHAT KIND OF WORK THIS IS — and therefore WHICH EXIT GATE it must pass.
 *
 *   code     — the product changes. Done = a green reverify receipt (the original law).
 *   document — a stage of the phase cycle changes documents. Done = the document its stage
 *              is supposed to produce, on disk AND committed.
 *
 * The distinction rides in `data` rather than in a new LANE on purpose: a lane is a routing
 * dimension (which worker, which window), and these two are routed identically. Adding a
 * fifth lane would have made every lane table, every envelope and every eligibility probe
 * grow a member that means nothing to any of them.
 */
export const TASK_KINDS = Object.freeze(['code', 'document'])

/**
 * The stages of the phase cycle a task may stand for. The exit gate asks a different question
 * of each, so the vocabulary is CLOSED: a stage nobody declared cannot silently pick the
 * loosest gate. `execute` is the one stage whose product is code AND whose questions are
 * documents — which is exactly why it is named here alongside the other three.
 */
export const TASK_STAGES = Object.freeze(['discuss', 'plan', 'execute', 'verify'])

/**
 * The role a row plays in its batch — a CLOSED vocabulary of exactly one value, and the one
 * value names the exception rather than the rule.
 *
 * There is deliberately no 'item' here. An item is already recognised by carrying a
 * `batchId`, and a second way of saying the same thing is a second thing that can be wrong:
 * a row marked 'item' with no batch id, or a row with a batch id and no mark, would each
 * have to mean something, and no reader could say what. Only the ROLE THAT CHANGES
 * BEHAVIOUR — the request itself, which no worker may ever be handed — is declared.
 */
export const BATCH_PARENT = 'parent'
const BATCH_ROLES = Object.freeze([BATCH_PARENT])

/** The keys the `data` envelope may carry — a field allowlist inside the field allowlist. */
const ALLOWED_DATA_KEYS = Object.freeze(['kind', 'stage', 'phase', 'batch'])

/** The explicit field allowlist — the ONLY keys a task record carries (notify.mjs explicit-pick posture). */
const ALLOWED_TASK_KEYS = Object.freeze([
  'id', 'source', 'title', 'lane', 'provider', 'model', 'effort',
  'priority', 'attempt', 'storyPoints', 'acceptance', 'note', 'project', 'batchId', 'forge', 'data',
])

/**
 * isBatchParent(taskOrRow) → is this the REQUEST of a batch rather than a piece of its work?
 *
 * ONE predicate for a task on its way in and for a row on its way out, because both carry the
 * envelope under the same name — and because a backend, a door and a screen answering this
 * question three times in three files is three chances to answer it differently. PURE; a
 * nullish argument is simply not a parent.
 *
 * @param {object|null} taskOrRow
 * @returns {boolean}
 */
export function isBatchParent(taskOrRow) {
  const env = taskOrRow && typeof taskOrRow === 'object' ? taskOrRow.data : null
  return !!env && typeof env === 'object' && env.batch === BATCH_PARENT
}

/**
 * The project slug grammar. A LOCAL constant, not an import: this module must
 * stay free of the config module to keep the backend-free/import-free law intact. Kept in
 * agreement with config.mjs's PROJECT_ID_RE by the tests on both sides.
 */
const TASK_PROJECT_RE = /^[a-z0-9-]{1,64}$/

/**
 * The batch identifier grammar. It is minted by a door from a clock, but it ARRIVES on the
 * wire like everything else, and it ends up inside a `data->>` comparison and beside task ids
 * in logs — so it is bounded and spelled out here rather than trusted for being ours. Same
 * shape and same cap as a task id.
 */
const TASK_BATCH_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

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
  // batchId: STRUCTURAL only, exactly like project. Whether a batch with this id has a
  // request row is the DOOR's question — it is the one that writes both halves in one action.
  if (task.batchId !== undefined && (typeof task.batchId !== 'string' || !TASK_BATCH_ID_RE.test(task.batchId))) {
    throw new InvalidTaskError(`task "${task.id}" has an invalid batchId "${task.batchId}"`)
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

  // data envelope: OPTIONAL (absent → a plain code task, byte-for-byte today's behaviour), and
  // fail-closed when present. A typo in `kind` or `stage` must never fall through to «code» by
  // default — a document stage silently gated on reverify would fail red forever with nothing
  // saying why, and a code task silently gated on an artifact would complete without one.
  if (task.data !== undefined) {
    if (typeof task.data !== 'object' || task.data === null || Array.isArray(task.data)) {
      throw new InvalidTaskError(`task "${task.id}" data must be an object`)
    }
    for (const key of Object.keys(task.data)) {
      if (!ALLOWED_DATA_KEYS.includes(key)) throw new InvalidTaskError(`task "${task.id}" data has unknown key "${key}"`)
    }
    if (task.data.kind !== undefined && !TASK_KINDS.includes(task.data.kind)) {
      throw new InvalidTaskError(`task "${task.id}" has invalid data.kind "${task.data.kind}"`)
    }
    if (task.data.stage !== undefined && !TASK_STAGES.includes(task.data.stage)) {
      throw new InvalidTaskError(`task "${task.id}" has invalid data.stage "${task.data.stage}"`)
    }
    if (
      task.data.phase !== undefined &&
      typeof task.data.phase !== 'string' &&
      typeof task.data.phase !== 'number'
    ) {
      throw new InvalidTaskError(`task "${task.id}" data.phase must be a string or a number`)
    }
    if (task.data.batch !== undefined && !BATCH_ROLES.includes(task.data.batch)) {
      throw new InvalidTaskError(`task "${task.id}" has invalid data.batch "${task.data.batch}"`)
    }
  }

  // A REQUEST THAT NAMES NO BATCH IS NOT A REQUEST. The parent exists to be the thing items
  // hang off; without an id nothing can hang off it, and it would sit in the queue forever as
  // a row no worker may take and no reader can group. Refused at the gate rather than becoming
  // an orphan the front has to learn to ignore.
  if (isBatchParent(task) && task.batchId === undefined) {
    throw new InvalidTaskError(`batch request "${task.id}" requires a batchId`)
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
      // THE STAGE ENVELOPE TRAVELS ON THE ROW. Without it the only thing a reader could
      // recognise a phase stage by is its title — text a person can retype — and the door
      // that must refuse to start the same stage twice would have nothing to ask. It is the
      // same object the tick reads to choose a gate; carried only when the task has one, so a
      // row of ordinary code work states nothing about a stage rather than carrying a null.
      ...(rec.task.data ? { data: rec.task.data } : {}),
      // THE KINSHIP TRAVELS ON THE ROW, and only when there is one: a row of ordinary work
      // states nothing about a batch rather than carrying a null every grouping would then
      // have to skip. Without it, a reader could group items by nothing but their titles.
      ...(rec.task.batchId ? { batchId: rec.task.batchId } : {}),
      attempt: rec.attempt,
      coalesceCount: rec.coalesceCount,
      workerId: rec.workerId,
      storyPoints: rec.task.storyPoints,
      acceptance: rec.task.acceptance,
      enqueuedAt: rec.enqueuedAt,
      // WHEN THE WORK WAS TAKEN, and — a DIFFERENT fact — when its lease was last renewed.
      // A screen asking «how long has this been running» measures from the first, and a sweep
      // asking «is this worker still alive» measures from the second. One field cannot answer
      // both: a durable backend renews the lease by restamping its clock, so a shared field
      // made every live task report a duration of about zero no matter how long it had run.
      // Both are null while nothing holds the task — a waiting row has nothing to measure, and
      // a zero there reads as «just started» rather than as «not started».
      claimedAt: rec.claimedAt,
      leaseRenewedAt: rec.lastTouch ?? null,
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
      // THE REQUEST OF A BATCH IS NOT WORK. Handing it to a worker would dispatch «разгреби
      // мелочь перед демо» as a task of its own, in parallel with the very items it was
      // broken into. Skipped BEFORE the ordering so no priority and no arrival time can
      // surface it — the durable backend keeps the same promise by never putting a parent in
      // a lane queue at all.
      if (isBatchParent(rec.task)) continue
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

  /**
   * assignWorker(taskId, workerId) — record WHICH worker executes a claimed task.
   *
   * The claim is made by the daemon; routing picks the worker one step later, so the
   * executing identity is only knowable after the checkout. Every reader of «who is busy»
   * — the board, the worker strip, the busy counter — matches a claimed row's workerId
   * against the configured workers, so a row that never gets one reads as nobody working.
   */
  async function assignWorker(taskId, workerId) {
    const rec = records.get(taskId)
    if (!rec || rec.status !== 'claimed') return false
    rec.workerId = workerId ?? null
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
    // NOT 'completed': the receipt certifies the WORK, and the work now owes a person a
    // word. The durable backend records exactly this state in its own approval row; the
    // reference backend has to say the same thing or the contract suite would certify two
    // different meanings of the same call.
    rec.status = 'awaiting_approval'
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
    // Every status of the closed vocabulary is a KEY, present at zero — a counter that
    // appears only once something lands in it reads as «no such thing» on the screen that
    // asks for it, which is a different statement from «none right now».
    // STATS COUNT WORK, and a batch request is not work: it is queued, nobody will ever
    // claim it, and counted here it would add one to «в очереди» that no amount of working
    // could ever take away. It stays in list() — a reader has to see it to draw the batch.
    const work = [...records.values()].filter((rec) => !isBatchParent(rec.task))
    const s = { total: work.length }
    for (const st of TASK_STATUSES) s[st] = 0
    for (const rec of work) s[rec.status] = (s[rec.status] ?? 0) + 1
    return s
  }

  return { enqueue, claimNext, touch, assignWorker, complete, fail, list, stats }
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
      expect(r.status).toBe('awaiting_approval')
    })

    // COMPLETED WORK IS REPORTED AS AWAITING APPROVAL. Certified work is not accepted work:
    // the receipt is the worker's half and a person owes the other half. Every backend has
    // to say so in its own read path, because the screen that shows «ждут решения» reads
    // list()/stats() and nothing else — where this row said 'completed', that screen was
    // empty at all times and the counter beside it read zero while work piled up.
    it('after complete() with a receipt the row reads awaiting_approval, never completed, and stats() counts it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      await q.complete('BL-96', { receiptRef: 'reverify:abc' })

      const [r] = await q.list({})
      expect(r.status).toBe('awaiting_approval')
      expect(r.status).not.toBe('completed')

      // the filter the front's «ждут решения» screen actually runs
      expect(await q.list({ status: 'awaiting_approval' })).toHaveLength(1)
      expect(await q.list({ status: 'completed' })).toHaveLength(0)

      const s = await q.stats()
      expect(s.awaiting_approval).toBe(1)
      expect(s.completed).toBe(0)
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

    /**
     * RENEWING THE LEASE MAY NEVER MOVE THE MOMENT THE WORK WAS TAKEN.
     *
     * The durable backend has no renewal call in its library, so it renews by restamping the
     * job's own start clock — and that clock was ALSO the answer to «when was this taken». So
     * a task that had been running for an hour reported a couple of minutes, then a couple of
     * minutes again, forever: the number on the screen was not a measurement of anything. The
     * two facts now live in two fields, and this case is the one that keeps them apart on
     * every backend — a backend answering both from one clock fails here rather than on a
     * screen.
     */
    it('a lease renewal moves leaseRenewedAt and NEVER claimedAt — «how long» is measured from the claim', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})

      const [claimed] = await q.list({})
      expect(claimed.claimedAt).toBe(1000)
      expect(claimed.leaseRenewedAt).toBe(1000)

      c.advance(4000)
      await q.touch('BL-96')

      const [renewed] = await q.list({})
      expect(renewed.status).toBe('claimed')
      expect(renewed.claimedAt).toBe(1000) // the claim did not happen again
      expect(renewed.leaseRenewedAt).toBe(5000) // only the lease clock moved
    })

    /**
     * A row waiting for a worker has nothing to measure, and says so with a null rather than
     * with a zero: a zero renders as «just started», which is a statement about work that is
     * not happening.
     */
    it('a task that lost its lease and went back to the queue reports NO claim time and no renewal', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(6000) // past the lease, no renewal

      const [r] = await q.list({})
      expect(r.status).toBe('queued')
      expect(r.claimedAt).toBeNull()
      expect(r.leaseRenewedAt).toBeNull()
    })

    /**
     * The claim stamp belongs to the ATTEMPT IN FLIGHT, not to the task's first ever claim: a
     * second attempt that reported the first attempt's clock would say the work has been
     * running since before it started.
     */
    it('an attempt claimed again after a requeue is measured from the NEW claim', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(6000) // the lease expires, the task returns to the queue
      c.advance(1000)
      const again = await q.claimNext('w2', {})
      expect(again.id).toBe('BL-96')

      const [r] = await q.list({})
      expect(r.status).toBe('claimed')
      expect(r.claimedAt).toBe(8000)
      expect(r.leaseRenewedAt).toBe(8000)
    })

    it('assignWorker records the executing worker, and list() reports it', async () => {
      // WHY THIS IS A CONTRACT TEST AND NOT A BACKEND DETAIL: the claim is made by the
      // daemon, and routing picks the actual worker one step later. Every «who is busy»
      // reader — the board, the worker strip, the busy counter — answers by matching a
      // claimed row's workerId against the configured workers. A backend that accepts the
      // assignment and forgets it renders as an empty queue and an idle worker while an
      // attempt is running, which is exactly what shipped on 12.08.2026.
      const q = makeAdapter({ clock: clockOf().fn, expireMs: 60000 })
      await q.enqueue(backlog())
      await q.claimNext('daemon', {})

      expect(await q.assignWorker('BL-96', 'local-1')).toBe(true)
      const [r] = await q.list({})
      expect(r.status).toBe('claimed')
      expect(r.workerId).toBe('local-1')

      // An unknown task is answered, never thrown at: the caller is a fail-open dispatcher.
      expect(await q.assignWorker('BL-does-not-exist', 'local-1')).toBe(false)
    })

    // ── the batch: kinship is a fact of the queue, and the request is not work ──

    /** The request row of a batch: a roster action, marked as the parent, naming its batch. */
    const parent = (batchId, over = {}) => ({
      id: batchId,
      source: 'roster',
      title: 'разгреби мелочь перед демо',
      lane: 'prod',
      batchId,
      data: { batch: 'parent' },
      ...over,
    })

    it('an item states which batch it belongs to, and the row says so', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({ id: 'B-1-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-1' })
      await q.enqueue({ id: 'R-alone', source: 'roster', title: 'сама по себе', lane: 'prod' })

      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-1-1').batchId).toBe('B-1')
      // A task belonging to no batch says nothing about one — never a null to be skipped.
      expect(rows.find((r) => r.id === 'R-alone').batchId).toBeUndefined()
    })

    /**
     * The parent is a RECORD OF WHAT WAS ASKED. A worker handed it would run the founder's
     * sentence as a task of its own, beside the items it was already broken into — so no
     * priority, no arrival order and no lane filter may surface it.
     */
    it('the request of a batch is NEVER claimed — not at the top priority, not when it arrived first', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(parent('B-2', { priority: 9 })) // first in, and the loudest
      await q.enqueue({ id: 'B-2-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-2', priority: 0 })

      const claimed = await q.claimNext('w1', {})
      expect(claimed.id).toBe('B-2-1')
      // and with the item gone there is still nothing to hand out
      expect(await q.claimNext('w2', {})).toBeNull()
    })

    it('a batch request is not counted as queued WORK, and is still listed so a reader can draw it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(parent('B-3'))
      await q.enqueue({ id: 'B-3-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-3' })

      const s = await q.stats()
      expect(s.queued).toBe(1) // the item — the request is not work waiting for a worker

      const rows = await q.list({})
      const row = rows.find((r) => r.id === 'B-3')
      expect(row.batchId).toBe('B-3')
      expect(row.data.batch).toBe('parent')
    })

    /**
     * THE VOCABULARY IS STILL CLOSED, and it is closed in the two different ways it always
     * was — worth stating in one case, because the batch added a key to each list.
     *
     * A key outside the task allowlist is DROPPED: the normalized copy is explicit-pick, so
     * an invented field cannot ride into the queue and be read back out by anybody. A key
     * inside the `data` envelope is REFUSED outright, because that envelope is what chooses a
     * gate and a role — a typo there falling through to a default is the fault the refusal
     * was written for. Neither loosened when `batchId` and `data.batch` joined them.
     */
    it('the vocabulary stayed CLOSED: an unknown key never travels, an unknown batch role is refused', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({ ...parent('B-4'), whenever: 'tomorrow' })
      const [row] = await q.list({})
      expect(row.id).toBe('B-4')
      expect(JSON.stringify(row)).not.toContain('tomorrow')

      await expect(q.enqueue({ ...parent('B-5'), data: { batch: 'child' } })).rejects.toThrow(/data\.batch/)
      // ...and a request that names no batch is not a request at all
      await expect(q.enqueue({ ...parent('B-6'), batchId: undefined })).rejects.toThrow(/batchId/)
      expect(await q.list({})).toHaveLength(1)
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
