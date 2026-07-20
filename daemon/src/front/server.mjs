/**
 * server.mjs — the roster front's node:http server + the CLOSED route table (Phase
 * 9.5 Plan 08; D-9.5-05/05a/09/11, T-9.5-24/25/26/27/34/35).
 *
 * ═══════════════════════ THE FIRST SANCTIONED INBOUND SURFACE ═════════════════════
 * The whole SMA product has, until now, had NO inbound socket (the guard's SMA-NOTIFY-1
 * invariant asserts scripts/sma/lib has no node:http server). This daemon front is the
 * FIRST sanctioned inbound surface — so it lives OUTSIDE scripts/sma/lib (this
 * daemon/ package) and carries a posture as total as notify.mjs's outbound one:
 *   - CLOSED ROUTE TABLE. `ROUTES` is a frozen object of EXACTLY FOURTEEN routes
 *     (re-frozen 2026-07-17 per D-9.5-09 — the harness growth is EXPLICIT, declared
 *     once, never incremental). A path outside the table is 404 BEFORE any auth-error
 *     detail (no route reflection). No command-exec endpoint exists or ever may
 *     (T-9.5-25) — adding a route requires touching THIS table AND the plan-09 guard
 *     invariant that polices it. Object.keys(ROUTES).length === 14 is a test.
 *   - TOKEN EVERYWHERE. Every route (including GET /api/state) is auth-gated before its
 *     handler runs (auth.mjs, timing-safe). Constant-body 401 (no oracle), 429 on a
 *     failure-window breach (T-9.5-24).
 *   - REQUEST TEXT IS NEVER EXECUTED. Handlers explicit-pick their inputs and route
 *     them through validateTask / the merge verb / CAS — founder free text becomes
 *     DATA (a task title, a return note), never a command (T-9.5-25).
 *   - EXPLICIT-PICK RESPONSES, SIZE CAPS. JSON bodies are explicit-pick objects; POST
 *     bodies are capped at 16 KB with a strict content-type check; diffs are capped and
 *     auth'd (T-9.5-27/35).
 *
 * The five D-9.5-09 harness routes (GET /api/harness + POST /api/forge, /api/agent/
 * toggle, /api/skill/assign, /api/mcp/toggle) ship here as NAMED 501 stubs so the table
 * is complete and frozen from the first commit; their handlers land in plan 9.5-11.
 *
 * Node built-ins only (node:http). Every collaborator (deriveState, adapter, ledger,
 * the merge verbRunner, execGit, the event hub, clock) is dependency-injected via
 * `deps`, so tests drive the request handler directly with fake req/res — no real
 * socket needed — plus one real-listen smoke on an ephemeral port. Zero deps.
 */

import { createServer } from 'node:http'

import { authed, tokenEquals, sessionCookie, createFailureLimiter } from './auth.mjs'
import { REASON_LABELS, validateTask } from '../queue/adapter.mjs'
import { casTransition } from '../queue/cas.mjs'
import { readAttempts } from '../queue/attempt-ledger.mjs'
import { DRAFT_KINDS } from '../forge/forge.mjs'
// NOTE: readHarness + the appliers (harness.mjs) are INJECTED via deps — never statically
// imported here — so each per-task commit stays independently green and no request path can
// reach a config/registry write except through the wired applier (T-9.5-38/39). DRAFT_KINDS
// is a frozen leaf constant (forge.mjs), imported for the /api/forge body validation.
// NOTE: parseReceiptSummary (state.mjs, Task 2) is INJECTED via deps.parseReceiptSummary
// — never statically imported here — so server.mjs carries no build edge onto state.mjs
// and each per-task commit stays independently green.

/** A queue-minted task id shape (BL-…/R-…/F-…): strict, so a diff/task path can never
 *  smuggle a path traversal or a shell metacharacter into an injected git call. */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/** POST JSON body cap (V5) — a roster body is a handful of short fields, never a blob. */
const JSON_BODY_CAP = 16 * 1024

/** Diff response cap (T-9.5-27) — a raw diff over LAN is auth'd AND size-bounded. */
const DIFF_CAP = 500 * 1024

/** Commit-log cap on the task-timeline read (bounded, never unbounded git output). */
const COMMIT_CAP = 50

/**
 * ROUTES — THE FINAL FROZEN TABLE (D-9.5-09, re-frozen 2026-07-17). Exactly FOURTEEN
 * entries mapping `${METHOD} ${path-pattern}` → handler name. `:id` marks the two
 * dynamic segments (/api/task/:id, /api/diff/:id), both bound to ID_RE. This object IS
 * the contract the plan-09 guard invariant polices — its size is a test
 * (Object.keys(ROUTES).length === 14) and no route may be added without also touching
 * that guard invariant.
 */
export const ROUTES = Object.freeze({
  'GET /': 'handleIndex',
  'GET /api/state': 'handleState',
  'GET /api/done': 'handleDone',
  'GET /api/task/:id': 'handleTask',
  'GET /api/diff/:id': 'handleDiff',
  'GET /api/events': 'handleEvents',
  'GET /api/harness': 'handleHarness',
  'POST /api/enqueue': 'handleEnqueue',
  'POST /api/approve': 'handleApprove',
  'POST /api/return': 'handleReturn',
  'POST /api/forge': 'handleForge',
  'POST /api/agent/toggle': 'handleAgentToggle',
  'POST /api/skill/assign': 'handleSkillAssign',
  'POST /api/mcp/toggle': 'handleMcpToggle',
})

// ── response helpers (explicit-pick, no-store, nosniff; constant 401 body) ──

function baseHeaders(contentType) {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, baseHeaders('application/json; charset=utf-8'))
  res.end(JSON.stringify(obj))
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, baseHeaders(contentType))
  res.end(text)
}

/** The 401 body is a CONSTANT — no reason, no route, no oracle (T-9.5-24). */
const UNAUTHORIZED_BODY = 'unauthorized'
const send401 = (res) => sendText(res, 401, UNAUTHORIZED_BODY)
const send404 = (res) => sendText(res, 404, 'not found')
const send400 = (res, msg = 'bad request') => sendText(res, 400, msg)
const send409 = (res, msg = 'conflict') => sendText(res, 409, msg)
const send429 = (res) => sendText(res, 429, 'rate limited')
const send503 = (res, msg = 'unavailable') => sendText(res, 503, msg)
const send501 = (res) => sendText(res, 501, 'not implemented') // harness stubs → plan 9.5-11

// ── request parsing ──

/** parseTarget(url) → { pathname, query } (query values as a plain object of strings). */
function parseTarget(url) {
  const u = new URL(String(url ?? '/'), 'http://localhost')
  const query = Object.create(null)
  for (const [k, v] of u.searchParams) query[k] = v
  return { pathname: u.pathname, query }
}

/** remoteAddr(req) — the connecting address for the rate-limit key. */
function remoteAddr(req) {
  return (req && req.socket && req.socket.remoteAddress) || 'unknown'
}

/**
 * matchRoute(method, pathname) → { handler, params } | { badId:true } | null.
 * Static routes hit the frozen table by key; the two dynamic routes match a prefix and
 * validate the id against ID_RE (a failing id → badId → 400, never a 404 that would hint
 * the route shape). Anything else → null → 404.
 */
export function matchRoute(method, pathname) {
  const key = `${method} ${pathname}`
  if (ROUTES[key]) return { handler: ROUTES[key], params: {} }

  if (method === 'GET') {
    const diff = pathname.match(/^\/api\/diff\/(.+)$/)
    if (diff) return ID_RE.test(diff[1]) ? { handler: 'handleDiff', params: { id: diff[1] } } : { badId: true }
    const task = pathname.match(/^\/api\/task\/(.+)$/)
    if (task) return ID_RE.test(task[1]) ? { handler: 'handleTask', params: { id: task[1] } } : { badId: true }
  }
  return null
}

/**
 * readJsonBody(req, {cap}) → Promise<{ ok, value?, error? }>. Strict: the content-type
 * must be application/json, and the accumulated body is capped (V5); an over-cap body is
 * refused WITHOUT buffering the whole thing. A parse failure is a clean {ok:false}.
 */
function readJsonBody(req, { cap = JSON_BODY_CAP } = {}) {
  return new Promise((resolve) => {
    const ct = (req && req.headers && req.headers['content-type']) || ''
    if (!/^application\/json\b/.test(String(ct))) {
      resolve({ ok: false, error: 'content-type must be application/json' })
      return
    }
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) {
        finish({ ok: false, error: 'body too large' })
        try {
          req.destroy()
        } catch {
          /* best-effort */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(text) })
      } catch {
        finish({ ok: false, error: 'invalid json' })
      }
    })
    req.on('error', () => finish({ ok: false, error: 'read error' }))
  })
}

// ── handlers (each: (ctx) => void|Promise; ctx = {req,res,params,query,config,deps}) ──

function handleIndex({ res }) {
  // The rich page is plan 9.5-09; this authed bootstrap placeholder is replaced there.
  const html =
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>SMA · ростер</title></head><body>' +
    '<main><h1>SMA ростер</h1><p>Страница появится в плане 9.5-09.</p></main>' +
    '</body></html>'
  sendText(res, 200, html, 'text/html; charset=utf-8')
}

/** Assemble the full deriveState collaborator set from the injected front deps. */
function stateDeps(config, deps) {
  return {
    adapter: deps.adapter,
    ledger: deps.ledger,
    ledgerDir: deps.ledgerDir,
    windows: deps.windows,
    config,
    usageReader: deps.usageReader,
    usageSeries: deps.usageSeries,
    readReceipt: deps.readReceipt,
    execGit: deps.execGit,
    clock: deps.clock,
  }
}

/** GET /api/state — the one-poll roster payload (deriveState; Task 2 + costs in Task 4). */
async function handleState({ res, config, deps }) {
  if (typeof deps.deriveState !== 'function') return send501(res)
  const payload = await deps.deriveState(stateDeps(config, deps))
  sendJson(res, 200, payload)
}

/** GET /api/done — the «сделано за ночь» feed (the done[] slice of the state derive). */
async function handleDone({ res, config, deps }) {
  if (typeof deps.deriveState !== 'function') return send501(res)
  const payload = await deps.deriveState(stateDeps(config, deps))
  sendJson(res, 200, { done: Array.isArray(payload.done) ? payload.done : [] })
}

/**
 * GET /api/task/:id — the explicit-pick task-timeline read model (Task 4). Surfaces the
 * task's `acceptance` (D-9.5-11 item 1 — the DoR contract wherever the task is judged),
 * the per-attempt chain (readAttempts) with failure_reason + reasonLabel, a parsed
 * receipt summary per attempt, the branch, a capped commit log, and returned notes. The
 * 9.6 Task-card renders from this alone. Unknown id → 404.
 */
async function handleTask({ res, params, config, deps }) {
  const id = params.id
  const adapter = deps.adapter
  if (!adapter || typeof adapter.list !== 'function') return send501(res)

  let rows = []
  try {
    rows = await adapter.list({})
  } catch {
    rows = []
  }
  const row = rows.find((r) => r && r.id === id)
  if (!row) return send404(res)

  // The per-attempt ledger is a DI seam (fn / {readAttempts} / ledgerDir) — same posture
  // as state.mjs — so tests read fixtures with no fs.
  let rawAttempts = []
  try {
    if (typeof deps.ledger === 'function') rawAttempts = deps.ledger(id) || []
    else if (deps.ledger && typeof deps.ledger.readAttempts === 'function') rawAttempts = deps.ledger.readAttempts(id) || []
    else if (deps.ledgerDir) rawAttempts = readAttempts(deps.ledgerDir, id)
  } catch {
    rawAttempts = []
  }
  const parseReceipt = typeof deps.parseReceiptSummary === 'function' ? deps.parseReceiptSummary : () => null
  const attempts = rawAttempts.map((a) => ({
    attempt: a.attempt ?? null,
    workerId: a.workerId ?? null,
    provider: a.provider ?? null,
    startedAt: a.startedAt ?? null,
    endedAt: a.endedAt ?? null,
    outcome: a.outcome ?? null,
    failureReason: a.failureReason ?? null,
    reasonLabel: a.failureReason ? REASON_LABELS[a.failureReason] ?? null : null,
    receipt: parseReceipt(a.receiptRef, { execGit: deps.execGit }),
  }))

  const branch = `wt/${id}`
  let commits = []
  if (typeof deps.execGit === 'function') {
    try {
      const out = deps.execGit(['log', '--oneline', `-${COMMIT_CAP}`, branch], { cwd: config.repoDir })
      commits = String(out || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, COMMIT_CAP)
    } catch {
      commits = []
    }
  }

  const returnedNotes = rawAttempts
    .filter((a) => a.outcome === 'returned' && typeof a.note === 'string')
    .map((a) => String(a.note).slice(0, 2000))

  sendJson(res, 200, {
    task: {
      id: row.id,
      title: row.title ?? null,
      lane: row.lane ?? null,
      status: row.status ?? null,
      attempt: row.attempt ?? null,
      acceptance: row.acceptance ?? null, // D-9.5-11 item 1 — DoR contract, «обещано»
    },
    attempts,
    branch,
    commits,
    returnedNotes,
  })
}

/**
 * GET /api/diff/:id — the plain-text worktree-branch diff, auth'd (T-9.5-27) and capped
 * at DIFF_CAP. The id already passed ID_RE, so it is safe to hand to the injected git.
 */
async function handleDiff({ res, params, config, deps }) {
  const id = params.id
  if (typeof deps.execGit !== 'function') return send501(res)
  const branch = `wt/${id}`
  let text = ''
  try {
    text = String(deps.execGit(['show', '--stat', '-p', branch], { cwd: config.repoDir }) || '')
  } catch {
    return send404(res)
  }
  if (text.length > DIFF_CAP) text = text.slice(0, DIFF_CAP) + '\n… (обрезано)'
  sendText(res, 200, text)
}

/**
 * GET /api/events — the SSE handshake. Auth already happened in the dispatcher (like
 * every route); a query-string token is rejected there because authed() never reads the
 * query (T-9.5-34). addClient returns the SSE stream, or false at capacity → 503
 * (T-9.5-36). The stream is left open — no res.end here.
 */
function handleEvents({ res, deps }) {
  const hub = deps.hub
  if (!hub || typeof hub.addClient !== 'function') return send501(res)
  const client = hub.addClient(res)
  if (!client) return send503(res, 'too many event clients')
  return undefined // SSE stream stays open (hint transport; truth stays in /api/state)
}

/**
 * POST /api/enqueue — a founder roster button. Body {title, lane, provider?, model?,
 * effort?, priority?}. validateTask gates it; the id is minted `R-<epochMs>` with
 * source:'roster' (founder-explicit → DoR-exempt). Founder text becomes a task TITLE,
 * never a command (T-9.5-25).
 */
async function handleEnqueue({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const task = {
    id: `R-${clock()}`,
    source: 'roster',
    title: b.title,
    lane: b.lane,
    ...(b.provider !== undefined ? { provider: b.provider } : {}),
    ...(b.model !== undefined ? { model: b.model } : {}),
    ...(b.effort !== undefined ? { effort: b.effort } : {}),
    ...(b.priority !== undefined ? { priority: b.priority } : {}),
  }
  let norm
  try {
    norm = validateTask(task)
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid task'))
  }
  const result = await adapter.enqueue(norm)
  emitSafe(deps, { event: 'task.queued', taskId: norm.id })
  sendJson(res, 200, { ok: true, id: result.id, coalesced: !!result.coalesced })
}

/**
 * POST /api/approve — the HUMAN-only approve path (it exists ONLY behind the token the
 * founder holds; the daemon never calls it). Body {taskId}. CAS the row
 * awaiting_approval→approving (claim generation), run the EXISTING serialized merge verb
 * on wt/<taskId> LOCALLY (never a push), then CAS to approved on green / back to
 * awaiting_approval on red with the merge receipt. A lost CAS race → 409 (T-9.5-26).
 */
async function handleApprove({ req, res, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const taskId = body.value && body.value.taskId
  if (!taskId || typeof taskId !== 'string' || !ID_RE.test(taskId)) return send400(res, 'invalid taskId')
  if (typeof deps.casExec !== 'function' || typeof deps.verbRunner !== 'function') return send501(res)

  const table = deps.taskTable || 'sma_task_attempts'
  const claim = await casTransition(deps.casExec, {
    table,
    id: taskId,
    from: 'awaiting_approval',
    to: 'approving',
    ...(deps.dispatchedAt !== undefined ? { dispatchedAt: deps.dispatchedAt } : {}),
  })
  if (!claim.won) return send409(res, 'approve race lost (already handled)')

  const branch = `wt/${taskId}`
  let merge
  try {
    merge = await deps.verbRunner({ branch, by: 'roster', cwd: deps.repoDir })
  } catch (err) {
    merge = { merged: false, message: String((err && err.message) || 'merge failed') }
  }
  const green = !!(merge && (merge.merged === true || merge.ok === true) && merge.testsPassed !== false)

  await casTransition(deps.casExec, {
    table,
    id: taskId,
    from: 'approving',
    to: green ? 'approved' : 'awaiting_approval',
    ...(merge && merge.receipt ? { extra: { merge_receipt: JSON.stringify(merge.receipt) } } : {}),
  })

  emitSafe(deps, { event: green ? 'task.approved' : 'task.failed', taskId })
  emitSafe(deps, { event: 'worker.presence', taskId })
  sendJson(res, 200, {
    ok: green,
    taskId,
    merged: green,
    ...(merge && merge.receipt ? { receipt: merge.receipt } : {}),
    ...(merge && merge.softDenied ? { softDenied: true } : {}),
  })
}

/**
 * POST /api/return — return-with-comment. Body {taskId, note} (note <= 2000). CAS
 * awaiting_approval→returned, then re-enqueue with source:'return' + the note +
 * attempt+1. The note is DATA (T-9.5-25). A lost race → 409.
 */
async function handleReturn({ req, res, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const v = body.value || {}
  const taskId = v.taskId
  if (!taskId || typeof taskId !== 'string' || !ID_RE.test(taskId)) return send400(res, 'invalid taskId')
  const note = v.note == null ? '' : String(v.note)
  if (note.length > 2000) return send400(res, 'note exceeds 2000 chars')
  if (typeof deps.casExec !== 'function' || !deps.adapter || typeof deps.adapter.enqueue !== 'function') {
    return send501(res)
  }

  const table = deps.taskTable || 'sma_task_attempts'
  const cas = await casTransition(deps.casExec, {
    table,
    id: taskId,
    from: 'awaiting_approval',
    to: 'returned',
    extra: { returned_note: note },
  })
  if (!cas.won) return send409(res, 'return race lost (already handled)')

  // Re-queue the returned task for another attempt with the founder's comment.
  let prevAttempt = 1
  try {
    const rows = await deps.adapter.list({})
    const row = rows.find((r) => r && r.id === taskId)
    if (row && Number.isFinite(row.attempt)) prevAttempt = row.attempt
  } catch {
    /* fail-open — default to attempt 1 → requeue as attempt 2 */
  }
  await deps.adapter.enqueue({
    id: taskId,
    source: 'return',
    title: v.title || `return:${taskId}`,
    lane: v.lane || 'prod',
    note,
    attempt: prevAttempt + 1,
  })

  emitSafe(deps, { event: 'task.returned', taskId })
  emitSafe(deps, { event: 'task.queued', taskId })
  sendJson(res, 200, { ok: true, taskId, attempt: prevAttempt + 1 })
}

/** emitSafe — fire a hint event through the injected hub if present (never throws). */
function emitSafe(deps, event) {
  try {
    if (deps && deps.hub && typeof deps.hub.emit === 'function') deps.hub.emit(event)
  } catch {
    /* a hint is best-effort — never blocks the durable action */
  }
}

// ── the five D-9.5-09 harness handlers (the route table stays FROZEN at 14) ──
//
// All consume readHarness + the appliers via INJECTED deps (never a static import), so no
// request path reaches a config/registry write except through the wired applier. Every body
// is EXPLICIT-PICK: an unknown key → 400 BEFORE any applier runs (a smuggled `command` on
// /api/mcp/toggle is rejected at the parse layer, so RCE-through-the-toggle is structurally
// impossible — T-9.5-38). Applier named errors map to 404 (unknown id / missing definition
// file) or 400 (validation). Success returns the updated slice + a `harness.updated` hint.

/** Reject any body key outside `allowed` (explicit-pick) → returns true if a 400 was sent. */
function rejectUnknownKeys(res, body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      send400(res, `unexpected field "${k}"`)
      return true
    }
  }
  return false
}

/** Map an applier's named error → 404 (unknown/missing) or 400 (validation). */
function applierError(res, err) {
  const name = (err && err.name) || ''
  if (/^(Unknown|MissingDefinition)/.test(name)) return send404(res)
  return send400(res, String((err && err.message) || 'bad request'))
}

/** GET /api/harness — the explicit-pick read model for modules 8/9/12 (readHarness). */
async function handleHarness({ res, config, deps }) {
  if (typeof deps.readHarness !== 'function') return send501(res)
  const registry = typeof deps.loadMcpRegistry === 'function' ? deps.loadMcpRegistry() : { servers: [] }
  const payload = await deps.readHarness({
    config,
    registry,
    adapter: deps.adapter,
    repoDir: deps.repoDir,
    fsImpl: deps.fsImpl,
    env: deps.env,
  })
  sendJson(res, 200, payload)
}

/**
 * POST /api/forge — the sanctioned FRONT producer for the «Создатель» lane. Body
 * {kind ∈ DRAFT_KINDS, description <= 2000, slugHint?} → a lane-forge task {source:'roster',
 * id `F-<epochMs>`, forge:{kind, description}} → 202. The description becomes forge DATA, never
 * a command. Entry convergence: a queue-side producer enqueuing lane 'forge' directly is
 * indistinguishable at validateTask + claim; /api/enqueue with lane 'forge' but no forge
 * object → 400 via validateTask (this dedicated route is the front entry).
 */
async function handleForge({ req, res, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['kind', 'description', 'slugHint']))) return undefined
  if (!DRAFT_KINDS.includes(b.kind)) return send400(res, 'invalid forge kind')
  if (typeof b.description !== 'string' || b.description.length === 0) return send400(res, 'description required')
  if (b.description.length > 2000) return send400(res, 'description exceeds 2000 chars')

  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const task = {
    id: `F-${clock()}`,
    source: 'roster',
    title: `forge:${b.kind}: ${b.description}`.slice(0, 200),
    lane: 'forge',
    forge: { kind: b.kind, description: b.description },
  }
  let norm
  try {
    norm = validateTask(task)
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid forge task'))
  }
  const result = await adapter.enqueue(norm)
  emitSafe(deps, { event: 'task.queued', taskId: norm.id })
  sendJson(res, 202, { ok: true, id: result.id, kind: b.kind })
}

/** POST /api/agent/toggle — body {id, enabled:boolean} → applyAgentToggle (file-derived). */
async function handleAgentToggle({ req, res, config, deps }) {
  if (typeof deps.applyAgentToggle !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'enabled']))) return undefined
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return send400(res, 'invalid id')
  if (typeof b.enabled !== 'boolean') return send400(res, 'enabled must be a boolean')
  try {
    const next = deps.applyAgentToggle({ config, id: b.id, enabled: b.enabled, repoDir: deps.repoDir, fsImpl: deps.fsImpl })
    const worker = (next && next.workers ? next.workers : []).find((w) => w && w.id === b.id)
    emitSafe(deps, { event: 'harness.updated' })
    return sendJson(res, 200, { ok: true, agent: { id: b.id, enabled: worker ? worker.enabled !== false : b.enabled } })
  } catch (err) {
    return applierError(res, err)
  }
}

/** POST /api/skill/assign — body {skillId, workerIds:string[<=16]} → applySkillAssign. */
async function handleSkillAssign({ req, res, config, deps }) {
  if (typeof deps.applySkillAssign !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['skillId', 'workerIds']))) return undefined
  if (typeof b.skillId !== 'string' || !ID_RE.test(b.skillId)) return send400(res, 'invalid skillId')
  if (!Array.isArray(b.workerIds)) return send400(res, 'workerIds must be an array')
  if (b.workerIds.length > 16) return send400(res, 'workerIds exceeds 16 entries')
  for (const w of b.workerIds) {
    if (typeof w !== 'string' || !ID_RE.test(w)) return send400(res, 'invalid workerId')
  }
  try {
    deps.applySkillAssign({ config, skillId: b.skillId, workerIds: b.workerIds, repoDir: deps.repoDir, fsImpl: deps.fsImpl })
    emitSafe(deps, { event: 'harness.updated' })
    return sendJson(res, 200, { ok: true, skill: { id: b.skillId, assignedTo: b.workerIds } })
  } catch (err) {
    return applierError(res, err)
  }
}

/**
 * POST /api/mcp/toggle — body {serverId, enabled:boolean} → applyMcpToggle (boolean-only). A
 * smuggled `command` (or any other) key is rejected by rejectUnknownKeys BEFORE the registry
 * is even loaded, so zero applier calls occur — RCE-through-the-toggle is impossible by
 * construction (T-9.5-38).
 */
async function handleMcpToggle({ req, res, deps }) {
  if (typeof deps.applyMcpToggle !== 'function' || typeof deps.loadMcpRegistry !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['serverId', 'enabled']))) return undefined
  if (typeof b.serverId !== 'string' || !b.serverId) return send400(res, 'serverId required')
  if (typeof b.enabled !== 'boolean') return send400(res, 'enabled must be a boolean')
  try {
    const registry = deps.loadMcpRegistry()
    deps.applyMcpToggle({ registry, serverId: b.serverId, enabled: b.enabled, fsImpl: deps.fsImpl })
    emitSafe(deps, { event: 'harness.updated' })
    return sendJson(res, 200, { ok: true, mcp: { id: b.serverId, enabled: b.enabled } })
  } catch (err) {
    return applierError(res, err)
  }
}

const HANDLERS = Object.freeze({
  handleIndex,
  handleState,
  handleDone,
  handleTask,
  handleDiff,
  handleEvents,
  handleHarness,
  handleEnqueue,
  handleApprove,
  handleReturn,
  handleForge,
  handleAgentToggle,
  handleSkillAssign,
  handleMcpToggle,
})

// ── the dispatcher ──

function failAuth(res, limiter, addr) {
  limiter.record(addr)
  return limiter.isLimited(addr) ? send429(res) : send401(res)
}

async function dispatch(req, res, ctx) {
  const { expectedToken, limiter, config, deps } = ctx
  const { pathname, query } = parseTarget(req.url)

  const match = matchRoute(req.method, pathname)
  if (!match) return send404(res) // closed table — no route reflection (T-9.5-25)
  if (match.badId) return send400(res, 'invalid id')

  const addr = remoteAddr(req)
  if (limiter.isLimited(addr)) return send429(res)

  // Bootstrap: GET / with ?token= exchanges a CORRECT token (once) for the HttpOnly
  // cookie. A query token is honoured ONLY here — never by authed() (T-9.5-34).
  if (match.handler === 'handleIndex' && query.token != null) {
    if (tokenEquals(query.token, expectedToken)) {
      res.writeHead(302, {
        location: '/',
        'set-cookie': sessionCookie(expectedToken),
        'cache-control': 'no-store',
      })
      res.end()
      return undefined
    }
    return failAuth(res, limiter, addr)
  }

  if (!authed(req, expectedToken)) return failAuth(res, limiter, addr)

  const handler = HANDLERS[match.handler]
  return handler({ req, res, params: match.params || {}, query, config, deps })
}

/**
 * createFrontServer({config, deps}) — wire the closed route table to the auth-gated
 * dispatcher. Returns { server, handle, routes, listen }. `handle(req, res)` is the raw
 * request listener (fail-closed: any throw → 500, never a leak); tests call it directly
 * with fake req/res. `server` is the node:http.Server for the real-listen smoke.
 *
 * @param {{config?:object, deps?:object}} [opts]
 * @returns {{server:object, handle:Function, routes:object, listen:Function}}
 */
export function createFrontServer({ config = {}, deps = {} } = {}) {
  const expectedToken = config.token || ''
  const limiter = deps.limiter || createFailureLimiter({ clock: deps.clock })
  const ctx = { expectedToken, limiter, config, deps }

  async function handle(req, res) {
    try {
      await dispatch(req, res, ctx)
    } catch {
      if (!res.headersSent && typeof res.writeHead === 'function') {
        try {
          sendText(res, 500, 'internal error')
        } catch {
          /* the socket is already gone — nothing to do */
        }
      }
    }
  }

  const server = createServer((req, res) => {
    handle(req, res)
  })

  return {
    server,
    handle,
    routes: ROUTES,
    listen(cb) {
      server.listen(config.port, config.bind, cb)
      return server
    },
  }
}
