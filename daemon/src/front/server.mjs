/**
 * server.mjs — the roster front's node:http server + the CLOSED route table (Phase
 * 9.5 Plan 08; D-9.5-05/05a/09/11, T-9.5-24/25/26/27/34/35).
 *
 * ═══════════════════════ THE FIRST SANCTIONED INBOUND SURFACE ═════════════════════
 * The whole SMA product has, until now, had NO inbound socket (the guard's SMA-NOTIFY-1
 * invariant asserts scripts/sma/lib has no node:http server). This daemon front is the
 * FIRST sanctioned inbound surface — so it lives OUTSIDE scripts/sma/lib (this
 * daemon/ package) and carries a posture as total as notify.mjs's outbound one:
 *   - CLOSED ROUTE TABLE. `ROUTES` is a frozen object of EXACTLY THIRTY routes
 *     (re-frozen 2026-08-01 per D-9.7-09 — the V5.1 growth is EXPLICIT, declared ONCE
 *     for the whole release and never incremental; the previous freeze was FOURTEEN,
 *     2026-07-17, D-9.5-09). A path outside the table is 404 BEFORE any auth-error
 *     detail (no route reflection). No command-exec endpoint exists or ever may
 *     (T-9.5-25) — adding a route requires touching THIS table AND the guard
 *     invariant that polices it. Object.keys(ROUTES).length === 30 is a test.
 *   - ONE DOOR PER ACTION, EVEN ACROSS MACHINES. Sending an action to another machine
 *     adds NO route: /api/enqueue, /api/approve and /api/return take an OPTIONAL
 *     `machine` field in their explicit-pick allowlist — an IDENTIFIER, never a url, so
 *     the address is resolved server-side from the peers registry and a request can
 *     never name an arbitrary host. The entry point stays the same and only the
 *     addressee changes, so the DoR/approve gates can never be re-implemented a second
 *     time behind a parallel «peer» route (D-9.7-07).
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
 * toggle, /api/skill/assign, /api/mcp/toggle) shipped as NAMED 501 stubs so the table
 * was complete and frozen from the first commit; their handlers landed in plan 9.5-11.
 *
 * The SIXTEEN D-9.7-09 routes (SPA asset serving, projects, machines/federation, chat,
 * import, onboarding) shipped the SAME way — named 501 stubs, present and auth-gated from
 * the first commit of the release, so every screen was built against the final contract
 * instead of an imagined one. Their handlers landed in plans 9.7-09 (static + projects),
 * 9.7-15 (machines + chat) and 9.7-20 (import + onboarding), and no plan of the release
 * added a route. THE TABLE IS NOW FULL: every one of the thirty answers for real, and
 * ZERO handlers are stubs (a test asserts the shape, not a list). A 501 that remains means
 * one thing only — a collaborator THIS daemon was not wired with (no derive, no federation,
 * no applier): «not available here», never «not written yet».
 *
 * Node built-ins only (node:http). Every collaborator (deriveState, adapter, ledger,
 * the merge verbRunner, execGit, the event hub, clock) is dependency-injected via
 * `deps`, so tests drive the request handler directly with fake req/res — no real
 * socket needed — plus one real-listen smoke on an ephemeral port. Zero deps.
 */

import { createServer } from 'node:http'
import { readFileSync as fsReadFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authed, tokenEquals, sessionCookie, createFailureLimiter } from './auth.mjs'
import { REASON_LABELS, validateTask } from '../queue/adapter.mjs'
import { casTransition } from '../queue/cas.mjs'
import { readAttempts, readJournalEntries } from '../queue/attempt-ledger.mjs'
import { readJournal, DISPATCH_REASONS } from './journal.mjs'
import { DRAFT_KINDS } from '../forge/forge.mjs'
import { buildPairingInstruction } from './federation.mjs'
import { scanEstate, enrollSelections } from './import-scanner.mjs'
import { createOnboarding } from './onboarding.mjs'
// NOTE: the import scanner and the onboarding interview are STATICALLY imported — unlike
// the appliers and the chat engine — because neither holds a capability worth gating: both
// are pure over an INJECTED fs, neither reaches a model or a spawn (their suites prove it
// by grep), and every byte either writes goes through a door that already exists — the
// forge's (draftPathFor → lintDraft → receipt → awaiting_approval) and the profile
// writer's. There is nothing here to switch off, because no enable path exists to switch.
// NOTE: only the pairing INSTRUCTION BUILDER is imported from federation.mjs — a pure text
// function with no fetch and no state. The federation ENGINE (poll/aggregate/proxy/pairing
// book) is injected via deps.federation, so no request path can open an outbound daemon→
// daemon call except through the instance the composition root wired (D-9.7-07).
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

/**
 * The reserved POST /api/agent/toggle target meaning «the whole shipped SMA team» rather than
 * one agent id (SB-031 part 1). DECLARED HERE rather than imported, because harness.mjs is the
 * appliers module and this file must carry no static edge onto it — the same reason readHarness
 * and the appliers arrive through deps. It is the same literal as harness.mjs's
 * STOCK_TEAM_TARGET, and harness.test.ts asserts the two never drift apart.
 */
export const STOCK_TEAM_TARGET = '__stock-team__'

/**
 * The reserved POST /api/approve target PREFIX meaning «apply the migration proposal for one
 * note of the connected project» rather than «approve a task» (SB-031 part 2, phase 11 plan
 * 09). It rides the approve door for the same reason the stock team rides the toggle door:
 * the route table is frozen at thirty and a per-file yes is, structurally, exactly what
 * approve already is — a human's word, serialized, on one named unit of work.
 *
 * The suffix is the note's stem; `<prefix><stem>` stays inside ID_RE, so the id validation
 * that guards every other approve applies unchanged. The applier arrives through deps and
 * validates the reconstructed filename again on its own side.
 */
export const PROJECT_MIGRATION_TARGET_PREFIX = '__migrate__'

/** POST JSON body cap (V5) — a roster body is a handful of short fields, never a blob. */
const JSON_BODY_CAP = 16 * 1024

/** Diff response cap (T-9.5-27) — a raw diff over LAN is auth'd AND size-bounded. */
const DIFF_CAP = 500 * 1024

/** Commit-log cap on the task-timeline read (bounded, never unbounded git output). */
const COMMIT_CAP = 50

/** A static-asset file name: FLAT and hashed (Vite output), never a path. A leading dot
 *  and every separator are excluded by construction, so `..`, `../x` and `a/b` cannot
 *  match — directory traversal dies at the name parse, before any handler runs. */
const ASSET_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/**
 * Where `cd spa && npm run build` puts the app: daemon/static/app/{index.html,assets/*}.
 * Resolved from THIS module's own url, so the daemon serves its build wherever the package
 * was installed — never from the process cwd. Injectable as `deps.staticDir` (tests read no
 * real tree; the one smoke that does is opt-in).
 */
const STATIC_APP_DIR = fileURLToPath(new URL('../../static/app/', import.meta.url))

/**
 * The content types a Vite build actually emits — a small frozen map next to the handler,
 * not a library: an unknown extension is served as an opaque stream rather than guessed at
 * (`nosniff` rides every response, so the browser never re-decides).
 */
const ASSET_TYPES = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
})
const ASSET_FALLBACK_TYPE = 'application/octet-stream'

/** Hashed file names are content-addressed — an immutable year is honest for them. */
const ASSET_CACHE = 'public, max-age=31536000, immutable'
/** index.html is NOT content-addressed: a stale one would strand the founder on an old
 *  app until a manual cache purge, so it is revalidated every load. */
const INDEX_CACHE = 'no-cache'

/**
 * The page GET / answers with when there is no build yet. An honest single line beats a
 * 500 and beats a blank screen: the reader learns the ONE command that fixes it.
 */
const BUILD_INSTRUCTION_HTML =
  '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>SMA</title></head><body>' +
  '<main><h1>SMA</h1><p>Соберите приложение: cd spa &amp;&amp; npm run build</p></main>' +
  '</body></html>'

/**
 * ROUTES — THE FINAL FROZEN TABLE (D-9.7-09, re-frozen 2026-08-01; the single freeze
 * revision of the V5.1 release, superseding the FOURTEEN of D-9.5-09). Exactly THIRTY
 * entries mapping `${METHOD} ${path-pattern}` → handler name. `:id` marks the two
 * dynamic id segments (/api/task/:id, /api/diff/:id), both bound to ID_RE; `:file` marks
 * the one dynamic asset segment (/assets/:file), bound to ASSET_RE. This object IS the
 * contract the guard invariant polices — its size is a test
 * (Object.keys(ROUTES).length === 30) and no route may be added without also touching
 * that guard invariant.
 *
 * The first fourteen are the D-9.5-09 surface; the sixteen below them are the declared-once
 * V5.1 growth. ALL THIRTY ARE LIVE: the table was written down once, at the start of the
 * release, and every slot was filled by its own plan without the table ever moving.
 */
export const ROUTES = Object.freeze({
  // ── the D-9.5-09 fourteen (live) ──
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
  // ── the D-9.7-09 sixteen (declared here, filled by their own plans) ──
  'GET /assets/:file': 'handleAsset',
  'GET /api/projects': 'handleProjects',
  'POST /api/project/add': 'handleProjectAdd',
  'POST /api/project/rename': 'handleProjectRename',
  'POST /api/project/select': 'handleProjectSelect',
  'GET /api/machines': 'handleMachines',
  'POST /api/machine/pair': 'handleMachinePair',
  'POST /api/machine/add': 'handleMachineAdd',
  'POST /api/machine/remove': 'handleMachineRemove',
  'POST /api/chat': 'handleChat',
  'GET /api/chat/history': 'handleChatHistory',
  'POST /api/import/scan': 'handleImportScan',
  'POST /api/import/enroll': 'handleImportEnroll',
  'GET /api/onboarding': 'handleOnboarding',
  'POST /api/onboarding/answer': 'handleOnboardingAnswer',
  'POST /api/onboarding/complete': 'handleOnboardingComplete',
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

/**
 * sendStatic — the ONE response path that is allowed a cache header other than no-store:
 * a build artefact is public, versioned content, not roster truth. `nosniff` still rides.
 */
function sendStatic(res, body, contentType, cacheControl) {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** The 401 body is a CONSTANT — no reason, no route, no oracle (T-9.5-24). */
const UNAUTHORIZED_BODY = 'unauthorized'
const send401 = (res) => sendText(res, 401, UNAUTHORIZED_BODY)
const send404 = (res) => sendText(res, 404, 'not found')
const send400 = (res, msg = 'bad request') => sendText(res, 400, msg)
const send409 = (res, msg = 'conflict') => sendText(res, 409, msg)
const send413 = (res) => sendText(res, 413, 'payload too large')
const send429 = (res) => sendText(res, 429, 'rate limited')
/** A machine that could not be reached is a GATEWAY failure, and says so honestly. */
const send502 = (res, msg = 'machine did not answer') => sendText(res, 502, msg)
const send503 = (res, msg = 'unavailable') => sendText(res, 503, msg)
const send501 = (res) => sendText(res, 501, 'not implemented') // a declared-but-unfilled route

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
 * Static routes hit the frozen table by key; the three dynamic routes match a prefix and
 * validate their segment against ID_RE (task/diff) or ASSET_RE (assets) — a failing
 * segment → badId → 400, never a 404 that would hint the route shape. Anything else →
 * null → 404.
 */
export function matchRoute(method, pathname) {
  const key = `${method} ${pathname}`
  if (ROUTES[key]) return { handler: ROUTES[key], params: {} }

  if (method === 'GET') {
    const diff = pathname.match(/^\/api\/diff\/(.+)$/)
    if (diff) return ID_RE.test(diff[1]) ? { handler: 'handleDiff', params: { id: diff[1] } } : { badId: true }
    const task = pathname.match(/^\/api\/task\/(.+)$/)
    if (task) return ID_RE.test(task[1]) ? { handler: 'handleTask', params: { id: task[1] } } : { badId: true }
    const asset = pathname.match(/^\/assets\/(.+)$/)
    if (asset) return ASSET_RE.test(asset[1]) ? { handler: 'handleAsset', params: { file: asset[1] } } : { badId: true }
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

/** The file reader for the two static routes — injected in tests, real fs in production. */
function staticReader(deps) {
  return (deps.fsImpl && deps.fsImpl.readFileSync) || fsReadFileSync
}

/**
 * GET / — THE APP RIDES WITH THE DAEMON (D-9.7-04). The built index.html is read off disk
 * and served behind the SAME token as every other route: no second web server, no second
 * port, no second auth story. A missing build is a normal state, not a fault — it answers
 * 200 with the one command that fixes it (a 500 would tell the founder nothing).
 */
function handleIndex({ res, deps }) {
  const dir = deps.staticDir || STATIC_APP_DIR
  let html
  try {
    html = String(staticReader(deps)(join(dir, 'index.html'), 'utf8'))
  } catch {
    html = BUILD_INSTRUCTION_HTML // no build yet — say so in one line
  }
  sendStatic(res, html, 'text/html; charset=utf-8', INDEX_CACHE)
}

/**
 * GET /assets/:file — the hashed bundles of that same build.
 *
 * TRAVERSAL IS IMPOSSIBLE BY CONSTRUCTION (T-9.7-21): the name was already matched against
 * ASSET_RE by matchRoute — a name carrying a separator, a `..`, a percent-escape or a
 * leading dot is a 400 BEFORE this function is entered, so the disk is never touched for a
 * hostile name. The re-test below is defence in depth for a direct handler call; the
 * name is then joined to the build's assets/ directory and to nothing else.
 */
function handleAsset({ res, params, deps }) {
  const file = String((params && params.file) || '')
  if (!ASSET_RE.test(file)) return send400(res, 'invalid asset name')
  const dir = deps.staticDir || STATIC_APP_DIR
  let body
  try {
    body = staticReader(deps)(join(dir, 'assets', file))
  } catch {
    return send404(res)
  }
  const type = ASSET_TYPES[extname(file).toLowerCase()] || ASSET_FALLBACK_TYPE
  return sendStatic(res, body, type, ASSET_CACHE)
}

/** The project id a read may be narrowed by: a bounded identifier from the query string,
 *  used for an in-memory equality compare and nothing else. Anything longer is DROPPED
 *  rather than carried (an unbounded filter is a body in disguise). */
function projectFilter(query) {
  const p = query && query.project
  return typeof p === 'string' && p.length > 0 && p.length <= 64 ? p : undefined
}

/** Assemble the full deriveState collaborator set from the injected front deps. */
function stateDeps(config, deps, project) {
  return {
    ...(project ? { project } : {}),
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
    // the corpus surfaces («Память» / «Мой стиль») read the repository this daemon serves.
    // Without the forward they would be structurally absent on every real install — the
    // derive already defaults them to {absent:true} when nothing is wired.
    repoDir: deps.repoDir,
    memoryDir: deps.memoryDir,
    fsImpl: deps.fsImpl,
    // the CONNECTED project's corpus («Память» shows it read-only): the readers live in
    // project-sync.mjs and arrive through deps like every other collaborator, so this file
    // carries no static edge onto them and a daemon that wires none simply answers absent.
    readProjectMemory: deps.readProjectMemory,
    previewProjectMigration: deps.previewProjectMigration,
    projectLiveness: deps.projectLiveness,
    migrationStagingDir: deps.migrationStagingDir,
    // hub-only: the federation merge that fills machines[] and pours in the peers' rows.
    // Absent on a standalone daemon, where the derive is byte-identical to before.
    aggregator: deps.aggregator,
  }
}

/**
 * GET /api/state — the one-poll roster payload (deriveState; Task 2 + costs in Task 4).
 * The optional `?project=` narrows the TASKS of the payload and nothing else — the project
 * switcher itself has to keep seeing every project (D-9.7-01).
 */
async function handleState({ res, query, config, deps }) {
  if (typeof deps.deriveState !== 'function') return send501(res)
  const payload = await deps.deriveState(stateDeps(config, deps, projectFilter(query)))
  sendJson(res, 200, payload)
}

/** GET /api/done — the «сделано за ночь» feed (the done[] slice of the state derive). */
async function handleDone({ res, query, config, deps }) {
  if (typeof deps.deriveState !== 'function') return send501(res)
  const payload = await deps.deriveState(stateDeps(config, deps, projectFilter(query)))
  sendJson(res, 200, { done: Array.isArray(payload.done) ? payload.done : [] })
}

/** How many journal rows one card may carry — a response is bounded like every other. */
const JOURNAL_ROW_CAP = 200

/**
 * readTaskJournal(id, deps) → the three layers of ONE task, shaped for the card:
 * `dispatcher[]` (code + its human подпись + when), `memoryTrace` (IDS only, de-duplicated)
 * and the per-attempt approach notes. The ledger is the SAME injected seam the attempts
 * use (fn-object / ledgerDir), and every failure path yields EMPTY layers — a card must
 * open for a task that predates the journal.
 */
function readTaskJournal(id, deps) {
  let rows = []
  try {
    if (deps.ledger && typeof deps.ledger.readJournalEntries === 'function') {
      rows = deps.ledger.readJournalEntries(id) || []
    } else if (deps.ledgerDir) {
      rows = readJournalEntries(deps.ledgerDir, id)
    }
  } catch {
    rows = [] // an unreadable journal is an EMPTY journal (fail-open)
  }

  const { entries } = readJournal({ taskId: id, entries: rows })
  const dispatcher = []
  const notes = new Set()
  const reflexes = new Set()
  const approachByAttempt = new Map()

  for (const row of entries.slice(0, JOURNAL_ROW_CAP)) {
    const payload = (row && row.payload) || {}
    if (row.layer === 'dispatcher') {
      dispatcher.push({
        code: payload.code ?? null,
        label: DISPATCH_REASONS[payload.code] ?? null, // the code is what is stored; this is its подпись
        ts: row.recordedAt ?? null,
      })
    } else if (row.layer === 'memory') {
      for (const n of Array.isArray(payload.notes) ? payload.notes : []) notes.add(n)
      for (const r of Array.isArray(payload.reflexes) ? payload.reflexes : []) reflexes.add(r)
    } else if (row.layer === 'approach' && payload.approach) {
      const attempt = Number.isFinite(Number(row.attempt)) ? Number(row.attempt) : 1
      approachByAttempt.set(attempt, String(payload.approach))
    }
  }

  return { dispatcher, memoryTrace: { notes: [...notes], reflexes: [...reflexes] }, approachByAttempt }
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
  // THE THREE LAYERS (D-9.7-14). The journal rides the SAME ledger seam as the attempts —
  // no second store — and a task created before the journal existed reads as empty layers,
  // never as an error: backward compatibility is a hard requirement, not a nicety.
  const journal = readTaskJournal(id, deps)

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
    // A row the reconciliation pass appended after the fact (D-11-DEFER-07) says so on the
    // card too. Without this a card would show an attempt with no worker and no provider as
    // though somebody had watched it produce nothing; the flag exists precisely so a reader
    // never has to guess which kind of row is in front of them. Absent (never false) on
    // every live-recorded row, exactly as it is in the ledger.
    ...(a.reconstructed === true ? { reconstructed: true } : {}),
    // (b) of the three layers: the worker's own note rides ITS attempt, not the task
    ...(journal.approachByAttempt.has(a.attempt) ? { approachNote: journal.approachByAttempt.get(a.attempt) } : {}),
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
    journal: { dispatcher: journal.dispatcher, memoryTrace: journal.memoryTrace },
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
 * relayPeerAnswer(res, answer) — the peer's own status and body, unmodified (D-9.7-07).
 * A JSON body is re-serialized as JSON, anything else as text; an implausible status
 * degrades to 502 rather than being echoed into a response line.
 */
function relayPeerAnswer(res, { status, body } = {}) {
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502
  if (body !== null && typeof body === 'object') return sendJson(res, code, body)
  return sendText(res, code, body === null || body === undefined ? '' : String(body))
}

/**
 * The OPTIONAL `machine` field of the three action bodies (D-9.7-07) — the whole of
 * «do it on another machine». It is an IDENTIFIER matched by ID_RE, never a url: the
 * hub resolves the address from its own peers registry, so a request can never point an
 * action at an arbitrary host (T-9.7-04). Absent/empty = this machine, and that path is
 * left exactly as it was — this function returns FALSE and the local handler continues.
 *
 * WHEN THE FIELD IS SET, THE HUB RE-ISSUES AND RELAYS. It runs none of the action's logic:
 * the peer's own DoR gate, its own CAS and its own merge run where the work actually lives,
 * so a gate can never be re-implemented (and quietly weakened) a second time on the hub.
 * Two details are load-bearing:
 *   - `machine` is STRIPPED from the forwarded body. The peer receives an ORDINARY local
 *     request, so it cannot re-proxy it onward: a proxy chain is structurally impossible.
 *   - a transport failure is reduced to a STATUS. The peer's (or the runtime's) message is
 *     discarded rather than wrapped — the same discipline federation.mjs keeps on the way
 *     out, because a message may quote the outgoing header (T-9.7-31).
 *
 * @returns {Promise<boolean>} true when a response was already sent (proxied or refused)
 */
async function proxyToMachine(res, body, deps, path) {
  const m = body.machine
  if (m === undefined || m === null || m === '') return false // local machine — untouched
  if (typeof m !== 'string' || !ID_RE.test(m)) {
    send400(res, 'invalid machine')
    return true
  }
  const fed = deps.federation
  if (!fed || typeof fed.proxyAction !== 'function') {
    send501(res) // no federation on this daemon — never a silent local run instead
    return true
  }
  const { machine: _addressee, ...forward } = body
  let answer
  try {
    answer = await fed.proxyAction({ machineId: m, method: 'POST', path, body: forward })
  } catch (err) {
    const name = (err && err.name) || ''
    if (name === 'UnknownPeerError') send404(res)
    else if (name === 'ProxyPathNotAllowedError') send400(res, 'action is not proxyable')
    else send502(res)
    return true
  }
  relayPeerAnswer(res, answer)
  return true
}

/**
 * POST /api/enqueue — a founder roster button. Body {title, lane, provider?, model?,
 * effort?, priority?, machine?}. Explicit-pick: an unknown key → 400 before anything
 * runs. validateTask gates it; the id is minted `R-<epochMs>` with source:'roster'
 * (founder-explicit → DoR-exempt). Founder text becomes a task TITLE, never a command
 * (T-9.5-25).
 */
async function handleEnqueue({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['title', 'lane', 'provider', 'model', 'effort', 'priority', 'machine']))) {
    return undefined
  }
  if (await proxyToMachine(res, b, deps, '/api/enqueue')) return undefined
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
 * founder holds; the daemon never calls it). Body {taskId, machine?}. CAS the row
 * awaiting_approval→approving (claim generation), run the EXISTING serialized merge verb
 * on wt/<taskId> LOCALLY (never a push), then CAS to approved on green / back to
 * awaiting_approval on red with the merge receipt. A lost CAS race → 409 (T-9.5-26).
 *
 * OR, when the id carries the reserved PROJECT_MIGRATION_TARGET_PREFIX, → the connected
 * project's per-file migration applier. Same door, same token, same «a human said yes to
 * exactly this one thing» meaning — and the route table did not move. Nothing about the task
 * path is reached on that branch: no CAS, no merge verb, no branch name.
 */
async function handleApprove({ req, res, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['taskId', 'machine']))) return undefined
  if (await proxyToMachine(res, b, deps, '/api/approve')) return undefined
  const taskId = b.taskId
  if (!taskId || typeof taskId !== 'string' || !ID_RE.test(taskId)) return send400(res, 'invalid taskId')

  if (taskId.startsWith(PROJECT_MIGRATION_TARGET_PREFIX)) {
    if (typeof deps.applyProjectMigration !== 'function') return send501(res)
    const file = `${taskId.slice(PROJECT_MIGRATION_TARGET_PREFIX.length)}.md`
    let result
    try {
      // The composition root already knows WHICH project is connected and WHERE the daemon
      // stages its proposals; this handler contributes only the file a person named.
      result = await deps.applyProjectMigration({ file })
    } catch (err) {
      return applierError(res, err)
    }
    const applied = !!(result && result.applied)
    if (applied) emitSafe(deps, { event: 'project.updated', projectId: result.projectId })
    return sendJson(res, 200, {
      ok: applied,
      migration: { file, applied, reasonCode: (result && result.reasonCode) || 'refused' },
    })
  }

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
 * POST /api/return — return-with-comment. Body {taskId, note, title?, lane?, machine?}
 * (note <= 2000). CAS awaiting_approval→returned, then re-enqueue with source:'return' +
 * the note + attempt+1. The note is DATA (T-9.5-25). A lost race → 409.
 */
async function handleReturn({ req, res, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const v = body.value || {}
  if (rejectUnknownKeys(res, v, new Set(['taskId', 'note', 'title', 'lane', 'machine']))) return undefined
  if (await proxyToMachine(res, v, deps, '/api/return')) return undefined
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

/**
 * refreshWorkers(config, next) — the roster half of the ONE-config rule (LP-2-02).
 *
 * WHY THIS EXISTS, in the words of the live proof: the founder pressed «Включить команду» in
 * the window and «ничего не произошло» — no effect, no error. The door was fine. The applier
 * wrote the roster to disk and returned a NEW config, and this process kept serving the OLD
 * one: `handleHarness` reads `config.workers` out of the single object the composition root
 * built at boot, so every card came back with exactly the `enabled` it had before the click,
 * and the request had succeeded, so there was nothing to show as a failure either. A write
 * that lands on disk and is invisible until a restart is indistinguishable from a no-op.
 *
 * The registry doors already obeyed this rule (refreshRegistry); the three harness appliers
 * did not. Only the roster field moves — nothing else of the applier's answer is trusted here.
 */
function refreshWorkers(config, next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.workers)) return
  config.workers = next.workers
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

/**
 * POST /api/agent/toggle — body {id, enabled:boolean} → applyAgentToggle (file-derived), OR,
 * when `id` is the reserved STOCK_TEAM_TARGET, → applyStockTeamToggle: the one act that
 * switches the whole shipped SMA team on (SB-031 part 1, phase 11 plan 06).
 *
 * The reserved target rides THIS door on purpose. The route table is frozen at thirty and its
 * size is the guard invariant; a «switch the team on» route would have had to move it. So the
 * whole team is addressed the way one agent is — same validation, same applier posture, same
 * refusal shape, same harness.updated hint — and the table did not move.
 */
async function handleAgentToggle({ req, res, config, deps }) {
  if (typeof deps.applyAgentToggle !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'enabled']))) return undefined
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return send400(res, 'invalid id')
  if (typeof b.enabled !== 'boolean') return send400(res, 'enabled must be a boolean')
  if (b.id === STOCK_TEAM_TARGET) {
    if (typeof deps.applyStockTeamToggle !== 'function') return send501(res)
    try {
      const next = deps.applyStockTeamToggle({ config, enabled: b.enabled, repoDir: deps.repoDir, fsImpl: deps.fsImpl })
      refreshWorkers(config, next)
      const touched = (next && next.workers ? next.workers : []).filter((w) => w && w.stockDigest !== undefined)
      emitSafe(deps, { event: 'harness.updated' })
      return sendJson(res, 200, { ok: true, stockTeam: { enabled: b.enabled, agents: touched.length } })
    } catch (err) {
      return applierError(res, err)
    }
  }
  try {
    const next = deps.applyAgentToggle({ config, id: b.id, enabled: b.enabled, repoDir: deps.repoDir, fsImpl: deps.fsImpl })
    refreshWorkers(config, next)
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
    refreshWorkers(
      config,
      deps.applySkillAssign({ config, skillId: b.skillId, workerIds: b.workerIds, repoDir: deps.repoDir, fsImpl: deps.fsImpl }),
    )
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

// ── the D-9.7-09 sixteen, all filled (the route table stayed FROZEN at 30 throughout) ──
//
// Declared once, filled by their own plans, in the order the release needed them. Not one
// of them is a stub any longer, and the table they live in never changed a single key —
// which was the point of writing it down in full on the first day. The dispatcher runs
// authed() BEFORE any handler, so an unauthenticated call to any route looks identical
// from outside and cannot map the surface by status code (T-9.7-01).

// ── the four project doors (D-9.7-01/08; the route table stays FROZEN at 30) ──
//
// A registry WRITE is a config write, so — exactly like the harness appliers — the three
// config.mjs doors (addProject / renameProject / selectProject) arrive through INJECTED
// deps and are never statically imported here: no request path reaches the config except
// through a wired door. The handlers re-implement NOTHING of the registry's rules. They
// reject unknown keys, hand the body over, map the named error (Unknown* → 404, invalid →
// 400) and emit the `project.updated` hint the app re-reads on. The id is minted by the
// door and NEVER moves on a rename — it is the key tasks and workers reference.

/** The write-seam options every config.mjs door takes (all four are DI). */
function configIo(deps) {
  return {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.homedir ? { homedir: deps.homedir } : {}),
    ...(deps.fsImpl ? { fsImpl: deps.fsImpl } : {}),
    // The launch directory the load-time derive used. The writer needs it to tell a value it
    // would derive again from one an operator typed, so a registry write persists neither
    // (D-11-DEFER-19).
    ...(deps.repoDir ? { repoDir: deps.repoDir } : {}),
  }
}

/**
 * The process holds ONE config object (the composition root hands the same reference to the
 * front and to the tick). A door returns a NEW config after its atomic write, so the two
 * registry fields are refreshed in place here — otherwise the very next read would serve
 * the state the founder just changed. Only these two fields move; nothing else is touched.
 */
function refreshRegistry(config, next) {
  if (!next || typeof next !== 'object') return
  config.projects = next.projects
  config.activeProject = next.activeProject
}

/** The name a folder suggests when the founder did not type one (never a path). */
function nameFromPath(path) {
  const parts = String(path).split(/[/\\]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** A registry entry as it leaves the process: the two fields a human sees, nothing else. */
function pickProject(entry) {
  return { id: entry.id, name: entry.name }
}

/**
 * GET /api/projects — the switcher's read model: every project with its per-project task
 * counts, plus the active one. It is a SLICE of the same derive /api/state serves (the
 * counts are derived, never stored), explicit-picked to two fields — so no token of the
 * config and no token of a peer can ride out of here by construction (T-9.7-23).
 */
async function handleProjects({ res, config, deps }) {
  if (typeof deps.deriveState !== 'function') return send501(res)
  const payload = await deps.deriveState(stateDeps(config, deps))
  sendJson(res, 200, {
    projects: Array.isArray(payload.projects) ? payload.projects : [],
    activeProject: payload.activeProject ?? null,
  })
}

/**
 * POST /api/project/add — take a folder into the register. Body {path, name?}: the folder
 * the founder picked, and optionally what to call it (absent → the folder's own name). The
 * id is minted BY THE DOOR from that name; the path is stored as opaque data.
 */
async function handleProjectAdd({ req, res, config, deps }) {
  if (typeof deps.addProject !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['path', 'name']))) return undefined
  const path = b.path === undefined || b.path === null ? '' : String(b.path)
  if (path.length > 4096 || path.includes('\0')) return send400(res, 'invalid path')
  const name = b.name === undefined || b.name === null || String(b.name).trim() === '' ? nameFromPath(path) : String(b.name).trim()
  if (!name) return send400(res, 'a project needs a name or a path')
  try {
    const next = deps.addProject(config, { name, ...(path ? { path } : {}) }, configIo(deps))
    refreshRegistry(config, next)
    const entry = next.projects[next.projects.length - 1]
    emitSafe(deps, { event: 'project.updated', projectId: entry.id })
    return sendJson(res, 200, { ok: true, project: pickProject(entry) })
  } catch (err) {
    return applierError(res, err)
  }
}

/**
 * POST /api/project/rename — body {id, name}. The NAME moves; the id does not, because the
 * id is what rows and worker profiles reference (D-9.7-08). Unknown id → 404.
 */
async function handleProjectRename({ req, res, config, deps }) {
  if (typeof deps.renameProject !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'name']))) return undefined
  if (typeof b.id !== 'string' || !b.id) return send400(res, 'invalid id')
  try {
    const next = deps.renameProject(config, { id: b.id, name: b.name }, configIo(deps))
    refreshRegistry(config, next)
    const entry = next.projects.find((p) => p && p.id === b.id)
    emitSafe(deps, { event: 'project.updated', projectId: b.id })
    return sendJson(res, 200, { ok: true, project: pickProject(entry) })
  } catch (err) {
    return applierError(res, err)
  }
}

/** POST /api/project/select — body {id}. Move the active project; unknown id → 404. */
async function handleProjectSelect({ req, res, config, deps }) {
  if (typeof deps.selectProject !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id']))) return undefined
  if (typeof b.id !== 'string' || !b.id) return send400(res, 'invalid id')
  try {
    const next = deps.selectProject(config, { id: b.id }, configIo(deps))
    refreshRegistry(config, next)
    emitSafe(deps, { event: 'project.updated', projectId: b.id })
    return sendJson(res, 200, { ok: true, activeProject: next.activeProject ?? null })
  } catch (err) {
    return applierError(res, err)
  }
}

// ── the four machine doors (D-9.7-06; the route table stays FROZEN at 30) ──
//
// INTRODUCTION IS THE ONE MOMENT A DAEMON TOKEN LEAVES ITS MACHINE, so these four are the
// most careful handlers in the file, and every one of them is a DELEGATE:
//   - the invitation is minted, judged and burned by the federation module's pairing book
//     (one shot, TTL, timing-safe) — this file never compares a secret itself;
//   - the registry WRITE goes through the injected config door (addPeer / removePeer),
//     exactly like the project doors: no request path reaches the config any other way;
//   - the SSRF guard runs on the joining url BEFORE the write, so a loopback or metadata
//     address never lands on disk (T-9.7-32);
//   - THE WIZARD PREPARES, IT DOES NOT EXECUTE: /api/machine/pair returns a SENTENCE for a
//     human to carry to the other machine. The daemon opens no socket to it and configures
//     no network — the private mesh stays the founder's own deliberate act.

/** A machine id is a SLUG — the same grammar config.mjs holds peers to (kept local on
 *  purpose: importing it would put a config WRITE module on server.mjs's import graph). */
const MACHINE_ID_RE = /^[a-z0-9-]{1,64}$/

/** A peer url is opaque data here; the federation module owns what makes one acceptable. */
const PEER_URL_CAP = 2048
/** A peer's daemon token is stored, never echoed; a bounded field all the same. */
const PEER_TOKEN_CAP = 512
/** What a machine may be CALLED. A name is read by a human, so it is short by contract. */
const MACHINE_NAME_CAP = 120

/** A Host header is a hint, not a credential: only a plausible authority is quoted back. */
const HOST_RE = /^[A-Za-z0-9._~[\]-]{1,253}(:\d{1,5})?$/

/**
 * hubUrlOf(req, config) — the address the SECOND machine should call back on, for the
 * instruction text alone. `federation.hubUrl` wins when the founder declared one; else the
 * authority the founder's own browser reached this hub by (a Host header is echoed only
 * after HOST_RE, and only into a sentence a human reads — it is never fetched); else the
 * configured bind:port. No request is ever made to any of them.
 */
function hubUrlOf(req, config) {
  const declared = config && config.federation && config.federation.hubUrl
  if (typeof declared === 'string' && declared.trim()) return declared.trim().replace(/\/+$/, '')
  const host = req && req.headers && req.headers.host
  if (typeof host === 'string' && HOST_RE.test(host)) return `http://${host}`
  return `http://${(config && config.bind) || '127.0.0.1'}:${(config && config.port) || 7777}`
}

/** The federation role this daemon declares. An absent block means standalone (D-9.7-04). */
function federationRole(config) {
  return (config && config.federation && config.federation.role) || 'standalone'
}

/** A machine as it leaves the process: presence only. No url, no token, by construction. */
function pickMachine(m) {
  return {
    id: m.id,
    title: m.title ?? m.name ?? m.id,
    role: m.role ?? 'peer',
    online: m.online === true,
    ...(m.lastSeenSec !== undefined ? { lastSeenSec: m.lastSeenSec } : {}),
  }
}

/**
 * GET /api/machines — the «Машины и проекты» read model: this machine, then every peer,
 * with presence and the age of what is being shown. It is the SAME shape `machines[]`
 * carries inside /api/state (the screen types it once), explicit-picked again here so
 * neither a peer url nor a peer token can ride out even if the registry grows a field
 * (T-9.7-05). A standalone daemon answers honestly with exactly one machine: its own.
 */
function handleMachines({ res, config, deps }) {
  const self = {
    id: (config && config.machineId) ?? 'self',
    title: (config && config.machineTitle) ?? 'Эта машина',
    role: 'self',
    online: true,
  }
  const fed = deps.federation
  const peers = fed && typeof fed.peerStatus === 'function' ? fed.peerStatus() : []
  sendJson(res, 200, {
    machines: [self, ...peers.map(pickMachine)],
    role: federationRole(config),
  })
}

/**
 * POST /api/machine/pair — mint ONE invitation and describe, in words, what to do with it.
 *
 * Hub-only: a standalone or peer daemon has nobody to introduce anybody to, and answering
 * anyway would mint live secrets on a machine that will never consume them. The response
 * carries the invitation (its whole purpose) and NOT the hub's own token — the instruction
 * NAMES that token as a placeholder so the reader knows what to paste (T-9.7-05).
 */
async function handleMachinePair({ req, res, config, deps }) {
  if (federationRole(config) !== 'hub') {
    return send400(res, 'pairing is a hub act; this daemon is not a hub')
  }
  const fed = deps.federation
  if (!fed || typeof fed.generatePairingToken !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  if (rejectUnknownKeys(res, body.value || {}, new Set())) return undefined

  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const { token, expiresAt } = fed.generatePairingToken()
  const expiresSec = Math.max(0, Math.round((expiresAt - clock()) / 1000))
  return sendJson(res, 200, {
    pairingToken: token,
    instruction: buildPairingInstruction({ hubUrl: hubUrlOf(req, config), pairingToken: token, expiresSec }),
    expiresSec,
  })
}

/**
 * POST /api/machine/add — the JOIN, called ON THE HUB from the second machine.
 *
 * Body {pairingToken, machine:{id, name, url, token}} — `token` is the SECOND machine's
 * own daemon token, the credential this hub will present when it calls that machine. The
 * order below is the whole security story and is deliberate:
 *   1. explicit-pick the body (a smuggled key dies before an invitation is even read);
 *   2. consume the invitation — one shot, timing-safe, TTL (the authorization step);
 *   3. run the SSRF guard on the url — BEFORE any write, so a refused address touches no disk;
 *   4. write the registry through the injected door (atomic), refresh the in-process config,
 *      and register the peer LIVE so the founder can address it without a restart.
 * A failed step 3 or 4 costs the founder a fresh invitation, which is the right price.
 */
async function handleMachineAdd({ req, res, config, deps }) {
  if (typeof deps.addPeer !== 'function') return send501(res)
  const fed = deps.federation
  if (!fed || typeof fed.consumePairingToken !== 'function') return send501(res)

  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['pairingToken', 'machine']))) return undefined
  const m = b.machine
  if (!m || typeof m !== 'object' || Array.isArray(m)) return send400(res, 'machine required')
  if (rejectUnknownKeys(res, m, new Set(['id', 'name', 'url', 'token']))) return undefined
  if (typeof m.id !== 'string' || !MACHINE_ID_RE.test(m.id)) return send400(res, 'invalid machine id')
  if (typeof m.url !== 'string' || m.url === '' || m.url.length > PEER_URL_CAP) return send400(res, 'invalid machine url')
  if (typeof m.token !== 'string' || m.token === '' || m.token.length > PEER_TOKEN_CAP) {
    return send400(res, 'invalid machine token')
  }
  const name = m.name === undefined || m.name === null || String(m.name).trim() === '' ? m.id : String(m.name).trim()
  if (name.length > MACHINE_NAME_CAP) return send400(res, 'invalid machine name')

  try {
    fed.consumePairingToken(b.pairingToken)
  } catch (err) {
    return applierError(res, err) // PairingTokenError → 400, one constant message
  }

  const entry = { id: m.id, name, url: m.url, token: m.token }
  try {
    fed.validatePeerUrl(entry) // the SSRF guard runs BEFORE the write (T-9.7-32)
    const next = deps.addPeer(config, entry, configIo(deps))
    config.federation = next.federation // the next read must not serve the old registry
    fed.registerPeer(entry) // live now, not after a restart
  } catch (err) {
    return applierError(res, err)
  }

  emitSafe(deps, { event: 'machine.presence', machineId: entry.id })
  return sendJson(res, 200, { ok: true, machine: { id: entry.id, title: name, role: 'peer', online: false } })
}

/**
 * POST /api/machine/remove — body {id}. The config registry and the LIVE registry move
 * together, so a machine the founder let go stops being addressable in the same breath.
 * Unknown id → 404 (the door's named error), never a silent success that hides a typo.
 */
async function handleMachineRemove({ req, res, config, deps }) {
  if (typeof deps.removePeer !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id']))) return undefined
  if (typeof b.id !== 'string' || !b.id) return send400(res, 'invalid id')
  try {
    const next = deps.removePeer(config, { id: b.id }, configIo(deps))
    config.federation = next.federation
    if (deps.federation && typeof deps.federation.removePeer === 'function') deps.federation.removePeer(b.id)
  } catch (err) {
    return applierError(res, err)
  }
  emitSafe(deps, { event: 'machine.presence', machineId: b.id })
  return sendJson(res, 200, { ok: true, id: b.id })
}

// ── the two conversation doors (D-9.7-13/15; the route table stays FROZEN at 30) ──
//
// The engine is INJECTED (deps.handleChatTurn / deps.readChatHistory), not imported: the
// free branch of a conversation spawns a child process, and a capability like that reaches
// a request path only through what the composition root deliberately wired. Everything
// these two handlers do is shape-checking on the way in and explicit-picking on the way
// out; the three laws of the lane (hybrid, hands tied, outside the queue) live in chat.mjs
// and are not restated — a second copy of a law is a second place for it to drift.

/**
 * A conversation turn is a SENTENCE, so its body gets its own cap well under the roster's
 * JSON_BODY_CAP: a chat door is the widest free-text surface the daemon has, and a blob
 * posted at it would be paid for twice — once in memory, once in a model's context window.
 */
export const CHAT_BODY_CAP = 8 * 1024

/** And the text inside that body is capped in its own right — a question, not a document. */
const CHAT_TEXT_CAP = 4000

/** A conversation id is minted by the engine (`conv-<epochMs>`); nothing wider is accepted. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** How many turns a history read returns by default, and the most it will ever return. */
const CHAT_HISTORY_LIMIT = 50
const CHAT_HISTORY_MAX = 200

/** The collaborator set the chat engine takes — the chat analogue of stateDeps. */
function chatDeps(config, deps) {
  return {
    adapter: deps.adapter,
    config,
    clock: deps.clock,
    fsImpl: deps.fsImpl,
    historyDir: deps.chatDir,
    dataDir: deps.dataDir,
    policyDir: deps.policyDir,
    repoDir: deps.repoDir,
    // the free branch's spawn seam: undefined in production (chat.mjs owns the default),
    // a spy in the suite that proves a factual answer never reaches for a session
    spawnWorker: deps.spawnWorker,
    ...(typeof deps.readUsageRows === 'function' ? { readUsageRows: deps.readUsageRows } : {}),
  }
}

/**
 * pickAnswer(answer) — what an answer is allowed to carry out of the process.
 *
 * The engine's `error` field is DELIBERATELY DROPPED: it holds a spawn message or a timeout
 * code — operational detail that would put a local binary path (or a runtime's own words)
 * on the wire in exchange for nothing the founder can act on. The honest sentence the
 * engine already produced is the answer; the code rides the `status` of the hint instead.
 */
function pickAnswer(answer) {
  const a = answer && typeof answer === 'object' ? answer : {}
  return {
    kind: a.kind ?? 'text',
    text: typeof a.text === 'string' ? a.text : '',
    ...(a.taskRef ? { taskRef: a.taskRef } : {}),
    ...(a.draft ? { draft: a.draft } : {}),
    ...(Array.isArray(a.spend) ? { spend: a.spend } : {}),
    ...(a.link ? { link: a.link } : {}),
  }
}

/** A stored turn as it leaves the process — the same picking, plus who said it and when. */
function pickTurn(t) {
  const r = t && typeof t === 'object' ? t : {}
  return {
    ts: r.ts ?? null,
    conversationId: r.conversationId ?? null,
    role: r.role ?? 'user',
    kind: r.kind ?? null,
    text: typeof r.text === 'string' ? r.text : '',
    ...(r.taskRef ? { taskRef: r.taskRef } : {}),
    ...(r.draft ? { draft: r.draft } : {}),
  }
}

/**
 * POST /api/chat — one conversation turn. Body {text, conversationId?}.
 *
 * The `chat.reply` hint fires AFTER the engine has returned, which is after both turns are
 * on the transcript — a screen that re-reads on the hint can never find the book behind the
 * event. The hint carries a turn id and a status and NOTHING ELSE: the founder's question
 * and the answer's words go to the caller that asked, not to every open screen (T-9.7-39).
 */
async function handleChat({ req, res, config, deps }) {
  if (typeof deps.handleChatTurn !== 'function') return send501(res)
  const body = await readJsonBody(req, { cap: CHAT_BODY_CAP })
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['text', 'conversationId']))) return undefined
  if (typeof b.text !== 'string' || b.text.trim() === '') return send400(res, 'text required')
  if (b.text.length > CHAT_TEXT_CAP) return send400(res, `text exceeds ${CHAT_TEXT_CAP} chars`)
  if (b.conversationId !== undefined && b.conversationId !== null) {
    if (typeof b.conversationId !== 'string' || !CONVERSATION_ID_RE.test(b.conversationId)) {
      return send400(res, 'invalid conversationId')
    }
  }

  const turn = await deps.handleChatTurn({
    text: b.text,
    ...(b.conversationId ? { conversationId: b.conversationId } : {}),
    deps: chatDeps(config, deps),
  })
  const answer = pickAnswer(turn && turn.answer)
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  emitSafe(deps, {
    event: 'chat.reply',
    turnId: `${turn.conversationId}-${clock()}`,
    status: turn && turn.answer && turn.answer.error ? 'failed' : 'ok',
  })
  return sendJson(res, 200, { conversationId: turn.conversationId, kind: turn.kind ?? null, answer })
}

/**
 * GET /api/chat/history — the tail of the transcript, oldest first. `?conversationId=`
 * narrows it; `?limit=` is clamped between one turn and CHAT_HISTORY_MAX, so no query can
 * ask for the whole book. The turns are DATA on the way out exactly as they were on the way
 * in: explicit-picked, never interpreted.
 */
function handleChatHistory({ res, query, deps }) {
  if (typeof deps.readChatHistory !== 'function') return send501(res)
  const asked = Number(query && query.limit)
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), CHAT_HISTORY_MAX) : CHAT_HISTORY_LIMIT
  const asObj = query && typeof query.conversationId === 'string' ? query.conversationId : ''
  const conversationId = CONVERSATION_ID_RE.test(asObj) ? asObj : undefined
  let turns = []
  try {
    turns =
      deps.readChatHistory({
        dir: deps.chatDir,
        ...(conversationId ? { conversationId } : {}),
        limit,
        fsImpl: deps.fsImpl,
      }) || []
  } catch {
    turns = [] // an unreadable transcript is an EMPTY conversation, never a 500
  }
  return sendJson(res, 200, { turns: turns.map(pickTurn) })
}

// ── the import door: a foreign estate becomes DRAFTS, never a running worker ──
//
// «Переезд за минуты, а не переписывание». The two routes below are a thin door in front
// of import-scanner.mjs and they re-implement NOTHING of it: the collision policy, the
// mapping and the forge's lint all live in the engine. What the door owns is the SHAPE of
// the request — and it owns it strictly, because a foreign definition is THIRD-PARTY TEXT:
//   - NO PATH EVER COMES FROM THE REQUEST. `scan` takes an EMPTY body and `enroll` takes
//     selections only; the estate that is read and the tree drafts land in are BOTH the
//     project this daemon serves. No caller can point the scanner at another directory
//     (T-9.7-50), so «прочитай мне /etc» is not a validation failure — it has no field.
//   - A BATCH IS BOUNDED AND ITEM-WISE. SELECTIONS_CAP bounds the party; a refusal (a taken
//     name with no rename) travels in the RESPONSE BODY as that item's status, so one bad
//     item can neither bury the batch in a 500 nor stop the rest from landing.
//   - THE HINT SAYS NOTHING. `import.updated` carries a batch id and a count — never a
//     name, never a slug: an open screen learns THAT the drafts moved, not what was in
//     them (T-9.7-51). What was found is read back through the authed route.
//   - NOTHING IS ENABLED. The engine writes drafts and a forge receipt and touches neither
//     the roster config nor the tool registry; activation stays two deliberate human steps.

/** How many definitions ONE enroll may carry — a party of choices, never a bulk channel. */
const SELECTIONS_CAP = 50

/** A selection names an existing candidate: two short identifiers and, at most, a rename. */
const IMPORT_NAME_CAP = 64
const IMPORT_KIND_CAP = 32

/** A body that is EMPTY by contract — the allowlist of a route that takes no input. */
const NO_FIELDS = new Set()

/**
 * Where an import reads from and where it writes to. Both are the project this daemon
 * serves, so a candidate whose name is already taken collides with the founder's OWN file
 * and is refused rather than silently rewritten — the reason `targetDir` exists at all.
 * The roster is handed over as the taken-name index; definitions already on disk are
 * covered by the engine's own path check, so no second registry read is needed.
 */
function importDirs(config, deps) {
  const repoDir = deps.repoDir ?? config.repoDir
  return {
    repoDir,
    targetDir: repoDir,
    fsImpl: deps.fsImpl,
    registries: { workers: Array.isArray(config.workers) ? config.workers : [] },
  }
}

/** A candidate as it leaves the process: meaning for the screen, no path to a foreign file. */
function pickCandidate(c) {
  return {
    kind: c.kind,
    slug: c.slug ?? null,
    name: c.name,
    summary: c.summary ?? '',
    source: c.source ?? '',
    ...(c.reason ? { reason: c.reason } : {}),
    ...(c.collision
      ? { collision: { existingKind: c.collision.existingKind, suggestion: c.collision.suggestion ?? null } }
      : {}),
  }
}

/** One enrolment result, explicit-picked: what happened to THIS item and why. */
function pickDraft(r) {
  return {
    kind: r.kind ?? null,
    slug: r.slug ?? null,
    status: r.status,
    ...(r.path ? { path: r.path } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.renamedFrom ? { renamedFrom: r.renamedFrom } : {}),
    ...(r.lint
      ? {
          lint: {
            ok: !!r.lint.ok,
            findings: (Array.isArray(r.lint.findings) ? r.lint.findings : []).map((f) => ({
              name: f.name,
              detail: f.detail,
            })),
          },
        }
      : {}),
    ...(r.receiptRef ? { receiptRef: String(r.receiptRef) } : {}),
  }
}

/**
 * POST /api/import/scan — what this project already has, and what it collides with.
 * The body is EMPTY by contract; the scan writes nothing at all, so calling it twice is
 * calling it once. A broken foreign file is a candidate with a reason, never a 500.
 */
async function handleImportScan({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  if (rejectUnknownKeys(res, body.value || {}, NO_FIELDS)) return undefined

  const found = scanEstate(importDirs(config, deps))
  return sendJson(res, 200, {
    format: found.format,
    candidates: (found.candidates || []).map(pickCandidate),
    notReady: (found.notReady || []).map((n) => ({ id: n.id, title: n.title, reason: n.reason })),
  })
}

/**
 * POST /api/import/enroll — the chosen definitions become drafts behind the forge's door.
 * Body {selections:[{slug, kind, overrideSlug?}]}, bounded by SELECTIONS_CAP. The shape is
 * checked to the last field BEFORE the engine runs (an unknown key inside one selection is
 * a 400 with zero writes); everything after that is the engine's verdict per item.
 */
async function handleImportEnroll({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['selections']))) return undefined
  if (!Array.isArray(b.selections)) return send400(res, 'selections must be an array')
  if (b.selections.length === 0) return send400(res, 'selections required')
  if (b.selections.length > SELECTIONS_CAP) return send400(res, `selections exceeds ${SELECTIONS_CAP} entries`)

  const selections = []
  for (const s of b.selections) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return send400(res, 'invalid selection')
    if (rejectUnknownKeys(res, s, new Set(['slug', 'kind', 'overrideSlug']))) return undefined
    if (typeof s.slug !== 'string' || s.slug === '' || s.slug.length > IMPORT_NAME_CAP) {
      return send400(res, 'invalid selection slug')
    }
    if (typeof s.kind !== 'string' || s.kind === '' || s.kind.length > IMPORT_KIND_CAP) {
      return send400(res, 'invalid selection kind')
    }
    if (s.overrideSlug !== undefined) {
      if (typeof s.overrideSlug !== 'string' || s.overrideSlug === '' || s.overrideSlug.length > IMPORT_NAME_CAP) {
        return send400(res, 'invalid overrideSlug')
      }
    }
    selections.push({ slug: s.slug, kind: s.kind, ...(s.overrideSlug ? { overrideSlug: s.overrideSlug } : {}) })
  }

  const { results } = enrollSelections({ selections, ...importDirs(config, deps), dataDir: deps.dataDir })
  const drafts = (results || []).map(pickDraft)
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  // AFTER the drafts are on disk: a screen that re-reads on the hint can never find the
  // door still empty. The frame is the batch id and the count — and nothing else.
  emitSafe(deps, {
    event: 'import.updated',
    batchId: `import-${clock()}`,
    count: drafts.filter((d) => d.status === 'awaiting_approval').length,
  })
  return sendJson(res, 200, { drafts })
}

// ── the first-run interview: three doors in front of ONE writer (D-9.7-16) ──
//
// The screen «Первый запуск» asks four steps of plain-language questions and ends with
// the SAME artifacts the terminal flow produces — because `complete()` hands the answers
// to scripts/sma/lib/profile-writer.mjs and this door adds no write path of its own. The
// screen's footer («Привычнее в терминале? sma start — всё сохранится») is true only while
// that holds, and the parity case compares the BYTES of the two paths.
//
// A FRESH ENGINE PER REQUEST, and that is the design: the interview's memory is the draft
// file the engine mirrors atomically after every accepted answer, so the truth survives a
// restart of this process (and of the browser) instead of living in it. Nothing here holds
// state between requests — the daemon's statelessness law, kept by construction.

/** An answer is a few sentences typed into a box, never a document pasted into one. */
const ONBOARDING_TEXT_CAP = 2000
/** A question key is an identifier of the interview's own map (which owns what exists). */
const ONBOARDING_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/
/** A bound on the step NUMBER — the shape only; which steps exist is the engine's truth. */
const ONBOARDING_STEP_MAX = 16

/**
 * The interview over the project this daemon serves; `.sma/` lives beside its files.
 *
 * `stateDir` is the daemon's OWN data directory and it is what makes the «позже» exit
 * possible: the one fact «this person asked to be left alone for now» is the daemon's, not
 * the project's, so it is remembered here and never written into somebody else's tree
 * (D-11-DEFER-17).
 */
function onboardingEngine(config, deps) {
  return createOnboarding({
    targetDir: deps.repoDir ?? config.repoDir ?? '.',
    stateDir: deps.dataDir ?? config.dataDir,
    fsImpl: deps.fsImpl,
  })
}

/**
 * The interview's named refusals → a status. A question that does not exist, a key from
 * another step and an answer that looks like a secret are all BAD REQUESTS: the route
 * exists, the body did not fit the interview. A profile already on disk is a CONFLICT —
 * the writer refuses to rewrite it, and so does this door.
 */
function onboardingError(res, err) {
  const name = (err && err.name) || ''
  if (name === 'ProfileExistsError') return send409(res, 'profile already exists')
  return send400(res, String((err && err.message) || 'bad request'))
}

/**
 * The reserved field on POST /api/onboarding/complete meaning «позже» — close the first run
 * WITHOUT writing a profile and WITHOUT seeding a single note into the project.
 *
 * It rides this door for the same reason the whole shipped team rides the agent toggle: the
 * route table is frozen at thirty and its size is a guard invariant, so a second way out of
 * the interview is a reserved ARGUMENT to the way out that already exists — same validation,
 * same refusal shape, same table. And it is one boolean: a caller still cannot name a target
 * directory or smuggle an overwrite, which is what the empty-body contract was protecting.
 */
export const ONBOARDING_DEFER_FIELD = 'later'

/** One question as the screen shows it — the interview's own words, explicit-picked. */
function pickQuestion(q) {
  return q
    ? { key: q.key, title: q.title, question: q.question, hint: q.hint, step: q.step, index: q.index, optional: !!q.optional }
    : null
}

/**
 * The progress read model. It carries the founder's own answers back, because resuming an
 * interview means showing what was already said — and they go to the authed caller who
 * typed them, exactly like a chat transcript. Nothing else of the engine leaks out.
 */
function pickOnboardingState(s) {
  return {
    needed: !!s.needed,
    done: !!s.done,
    /** Whether the interview is closed because a person asked for it later, not because it ran. */
    declined: !!s.declined,
    finished: !!s.finished,
    step: s.step,
    questionIndex: s.questionIndex,
    question: pickQuestion(s.question),
    answers: { ...s.answers },
    visited: { ...s.visited },
    totalAnswered: s.totalAnswered,
    totalQuestions: s.totalQuestions,
    steps: (s.steps || []).map((x) => ({ step: x.step, label: x.label, answered: x.answered, total: x.total, current: !!x.current })),
    extraTopics: (s.extraTopics || []).map((x) => ({ step: x.step, key: x.key, title: x.title, question: x.question, hint: x.hint, added: !!x.added })),
    ready: (s.ready || []).map((r) => ({ lead: r.lead, tail: r.tail, done: !!r.done })),
  }
}

/**
 * GET /api/onboarding — where the interview stands. `needed` is the whole first-run
 * decision: an install that already has a profile answers false, and the app never shows
 * the wizard again. The cursor is DERIVED here as everywhere — nothing is stored twice.
 */
function handleOnboarding({ res, config, deps }) {
  return sendJson(res, 200, pickOnboardingState(onboardingEngine(config, deps).getState()))
}

/**
 * POST /api/onboarding/answer — record ONE answer. Body {step, key, text}: the door bounds
 * the shape, the engine owns which question that is (and refuses one it does not ask, by
 * name). An EMPTY text is a legitimate skip — visited, unanswered, the cursor moves on —
 * so it is not rejected here. A secret-shaped answer never reaches the draft file: the
 * writer's own heuristic runs inside `answer()` BEFORE memory or disk is touched.
 */
async function handleOnboardingAnswer({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['step', 'key', 'text']))) return undefined
  if (!Number.isInteger(b.step) || b.step < 1 || b.step > ONBOARDING_STEP_MAX) return send400(res, 'invalid step')
  if (typeof b.key !== 'string' || !ONBOARDING_KEY_RE.test(b.key)) return send400(res, 'invalid key')
  if (typeof b.text !== 'string') return send400(res, 'text must be a string')
  if (b.text.length > ONBOARDING_TEXT_CAP) return send400(res, `text exceeds ${ONBOARDING_TEXT_CAP} chars`)

  try {
    const state = onboardingEngine(config, deps).answer({ step: b.step, key: b.key, text: b.text })
    return sendJson(res, 200, pickOnboardingState(state))
  } catch (err) {
    return onboardingError(res, err)
  }
}

/**
 * POST /api/onboarding/complete — hand the collected answers to the ONE writer. The body is
 * EMPTY by contract: the answers come from the draft this daemon has been keeping, never
 * from the request, so a caller can neither name a target directory nor smuggle an
 * `overwrite`. A finished install answers 409 — a profile is rewritten by a person who
 * asked for it in the terminal, never by a page reload.
 */
async function handleOnboardingComplete({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set([ONBOARDING_DEFER_FIELD]))) return undefined
  const later = b[ONBOARDING_DEFER_FIELD]
  if (later !== undefined && typeof later !== 'boolean') return send400(res, 'later must be a boolean')

  const engine = onboardingEngine(config, deps)
  if (!engine.getState().needed) return send409(res, 'profile already exists')
  try {
    if (later === true) {
      engine.declineForNow()
      return sendJson(res, 200, { done: true, deferred: true, notes: 0 })
    }
    const written = engine.complete()
    return sendJson(res, 200, { done: true, deferred: false, notes: Array.isArray(written.notes) ? written.notes.length : 0 })
  } catch (err) {
    return onboardingError(res, err)
  }
}

/** HANDLERS — the frozen name→function map. Exported for ONE reason: the shape test
 *  proves ROUTES↔HANDLERS is one-to-one, so neither a route without a handler nor a
 *  handler without a route can survive a commit. Importing it opens no request path. */
export const HANDLERS = Object.freeze({
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
  handleAsset,
  handleProjects,
  handleProjectAdd,
  handleProjectRename,
  handleProjectSelect,
  handleMachines,
  handleMachinePair,
  handleMachineAdd,
  handleMachineRemove,
  handleChat,
  handleChatHistory,
  handleImportScan,
  handleImportEnroll,
  handleOnboarding,
  handleOnboardingAnswer,
  handleOnboardingComplete,
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
 * dispatcher. Returns { server, handle, routes, listen, deps }. `handle(req, res)` is the
 * raw request listener (fail-closed: any throw → 500, never a leak); tests call it directly
 * with fake req/res. `server` is the node:http.Server for the real-listen smoke. `deps` is
 * the collaborator set EXACTLY as it was handed in — echoed back so the composition-root
 * test can name what a real boot wired (it grants nothing: the caller already owns it).
 *
 * @param {{config?:object, deps?:object}} [opts]
 * @returns {{server:object, handle:Function, routes:object, listen:Function, deps:object}}
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
    deps,
    listen(cb) {
      server.listen(config.port, config.bind, cb)
      return server
    },
  }
}
