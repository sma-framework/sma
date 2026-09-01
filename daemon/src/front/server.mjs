/**
 * server.mjs — the roster front's node:http server + the CLOSED route table.
 *
 * ═══════════════════════ THE FIRST SANCTIONED INBOUND SURFACE ═════════════════════
 * The whole SMA product has, until now, had NO inbound socket (the guard's SMA-NOTIFY-1
 * invariant asserts scripts/sma/lib has no node:http server). This daemon front is the
 * FIRST sanctioned inbound surface — so it lives OUTSIDE scripts/sma/lib (this
 * daemon/ package) and carries a posture as total as notify.mjs's outbound one:
 *   - CLOSED ROUTE TABLE. `ROUTES` is a frozen object of EXACTLY SIXTY-EIGHT routes
 *     (re-frozen 2026-08-28 — the growth past the V5.4 fifty-three is EXPLICIT, ELEVEN doors,
 *     each declared by the release that opened it: the chat stop button in v5.4.3, the
 *     running-task steering wheel in v5.5.0, SIX doors in v5.6.0 — the batch request,
 *     the word its owner answers a stopped batch with, the composition a phrase could have,
 *     the two doors of a task's WORDS (the one that proposes them and the one that corrects
 *     them), and the order that stops ONE echelon of ONE phase and starts it again — and,
 *     NOT YET CARRYING A RELEASE OF THEIR OWN, the door that CANCELS a
 *     task, so a person can stop work with a finger and the stopping leaves no live process
 *     behind it, and the door that opens the FOLDER OF ONE PHASE for reading — its directory
 *     as a tree, and one file of it as text — so what a phase left behind can be read where
 *     the person already is instead of in a terminal. Those two name no version on purpose:
 *     every other door here records
 *     the release that actually shipped it, and writing a number before it is cut would make
 *     this header a promise instead of a record — the stamp goes in when the release does;
 *     the previous freezes were SIXTY-THREE, 2026-08-25, SIXTY-TWO, 2026-08-20, SIXTY-ONE,
 *     2026-08-13, FIFTY-FIVE, 2026-08-12, FIFTY-THREE, 2026-08-06, THIRTY, 2026-08-01, and
 *     FOURTEEN, 2026-07-17). The SIXTY-FOURTH is the SETTINGS DOOR OF ONE CONNECTION: the
 *     owner connects their own Telegram bot from the window — a token in, a short-lived
 *     pairing code out, and the same door disconnects. The SIXTY-FIFTH WRITES A SKILL: a
 *     person describes an ability in the window and it lands in this machine's skill store as
 *     a file, ready to be given to a worker. Until it existed the screen could only ASK the
 *     forge for a draft and wait for an approval, which is not what «создать навык из окна»
 *     means to the person doing it. The SIXTY-SIXTH NAMES THE SECOND ADDRESS OF A PROJECT: the
 *     folder that holds its `.planning`, when the house keeps code and planning in two
 *     repositories. Until it existed such a house had to be registered as TWO projects — tasks
 *     visible in one, phases and backlog in the other, and neither switchable off without
 *     losing what it held. The SIXTY-SEVENTH AND SIXTY-EIGHTH BREAK THE TRANSCRIPT INTO
 *     CONVERSATIONS: one lists them (freshest first, with a live mark on the one a turn is
 *     running in), the other lets a person NAME one by hand. Until they existed the window
 *     opened a NEW conversation almost every time — fifty replies had scattered across fifteen
 *     threads — showed every thread of a project as one unbroken feed, and offered no way back
 *     into any earlier one. A path outside the table is 404 BEFORE
 *     any auth-error detail (no route reflection). No command-exec endpoint exists or ever
 *     may — adding a route requires touching THIS table AND the guard
 *     invariant that polices it. Object.keys(ROUTES).length === 68 is a test.
 *   - ONE DOOR PER ACTION, EVEN ACROSS MACHINES. Sending an action to another machine
 *     adds NO route: /api/enqueue, /api/approve and /api/return take an OPTIONAL
 *     `machine` field in their explicit-pick allowlist — an IDENTIFIER, never a url, so
 *     the address is resolved server-side from the peers registry and a request can
 *     never name an arbitrary host. The entry point stays the same and only the
 *     addressee changes, so the DoR/approve gates can never be re-implemented a second
 *     time behind a parallel «peer» route.
 *   - TOKEN EVERYWHERE. Every route (including GET /api/state) is auth-gated before its
 *     handler runs (auth.mjs, timing-safe). Constant-body 401 (no oracle), 429 on a
 *     failure-window breach.
 *   - REQUEST TEXT IS NEVER EXECUTED. Handlers explicit-pick their inputs and route
 *     them through validateTask / the merge verb / CAS — founder free text becomes
 *     DATA (a task title, a return note), never a command.
 *   - EXPLICIT-PICK RESPONSES, SIZE CAPS. JSON bodies are explicit-pick objects; POST
 *     bodies are capped at 16 KB with a strict content-type check; diffs are capped and
 *     auth'd.
 *
 * The five harness routes (GET /api/harness + POST /api/forge, /api/agent/toggle,
 * /api/skill/assign, /api/mcp/toggle) shipped as NAMED 501 stubs so the table was
 * complete and frozen from the first commit; their handlers landed later.
 *
 * The SIXTEEN V5.1 routes (SPA asset serving, projects, machines/federation, chat,
 * import, onboarding) shipped the SAME way — named 501 stubs, present and auth-gated from
 * the first commit of the release, so every screen was built against the final contract
 * instead of an imagined one. Their handlers landed in plans 9.7-09 (static + projects),
 * 9.7-15 (machines + chat) and 9.7-20 (import + onboarding), and no plan of the release
 * added a route. EVERY ONE OF THOSE THIRTY ANSWERS FOR REAL — the precedent this file is
 * governed by: the table is written down in full on the first day and never moves again.
 *
 * The TWENTY-THREE V5.4 routes (phase stages and decisions, the memory workbench,
 * coordination and backlog, attempts and shipping, search, accounts and diagnostics) are
 * declared the SAME way — named 501 stubs, present and auth-gated from the first commit of
 * the release, so every screen is built against the final contract instead of an imagined
 * one. While that release was being filled, an exported Set named the slots that were still
 * stubs, and the shape test excused a bare 501 for exactly those keys. THAT SET IS GONE: the
 * release filled every slot, so the mechanism was removed with it rather than left behind as
 * an empty relic. An exception list that still exists is an exception list that can be used
 * again — and four test files imported this one, which is an invitation to re-wire it.
 *
 * The rule it enforced is now unconditional: **no handler of this table is a bare 501.** A
 * later growth wave that wants to declare a batch of routes ahead of their handlers will
 * re-introduce a mechanism deliberately, with its own argument, instead of inheriting one.
 *
 * A 501 from a route therefore means one thing only — a collaborator THIS daemon was not
 * wired with (no derive, no federation, no applier): «not available here», never «not
 * written yet».
 *
 * Node built-ins only (node:http). Every collaborator (deriveState, adapter, ledger,
 * the merge verbRunner, execGit, the event hub, clock) is dependency-injected via
 * `deps`, so tests drive the request handler directly with fake req/res — no real
 * socket needed — plus one real-listen smoke on an ephemeral port. Zero deps.
 */

import { createServer } from 'node:http'
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  statSync as fsStatSync,
  readdirSync as fsReaddirSync,
  lstatSync as fsLstatSync,
  realpathSync as fsRealpathSync,
} from 'node:fs'
import { join, extname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteRaw } from '../../../scripts/sma/lib/fs-atomics.mjs'

import { authed, tokenEquals, sessionCookie, createFailureLimiter } from './auth.mjs'
import { BATCH_PARENT, CAP_TITLE, isBatchParent, latestRowPerId, REASON_LABELS, TASK_LANES, TASK_STAGES, validateTask } from '../queue/adapter.mjs'
import { CHAT_STAGES, proposeBreakdown, proposeWords, SNAPSHOT_EVENT_CAP, STATUS_LABELS } from './chat.mjs'
import { createQuestions, findPhaseDir, ALL_CHECKPOINT_SUFFIXES } from './questions.mjs'
import { casTransition } from '../queue/cas.mjs'
import { STAGE_COMMANDS, PHASE_RE, stageCommand } from '../policy/phase-cycle.mjs'
import { readAttempts, readJournalEntries, foldAttemptRows } from '../queue/attempt-ledger.mjs'
import { readJournal, DISPATCH_REASONS, REDIRECT_MODE_LABELS, attemptIdFor } from './journal.mjs'
import {
  runsDirOf,
  attemptRunDir,
  readContinuation,
  readTaskContext,
  readRunTokens,
  sumRunTokens,
} from '../queue/run-dir.mjs'
import { approvalWall, defaultEnvelope } from '../queue/capability-envelope.mjs'
import { readWaitingTicket } from '../../../scripts/sma/lib/tool-gate.mjs'
// СКОЛЬКО ИМЁН КОНФЛИКТА ПОКАЗЫВАТЬ — потолок один на весь продукт и живёт там, где живёт сам
// словарь конфликта. Второе число здесь однажды разошлось бы с тем, от которого считается «ещё N».
import { CONFLICT_FILES_CAP as MERGE_CONFLICT_FILES_SHOWN } from '../../../scripts/sma/lib/branch-sync.mjs'
import { appendRedirect, REDIRECT_TEXT_CAP } from '../runner/redirects.mjs'
import { writeWaveHold, WAVE_ACTIONS } from '../queue/wave-holds.mjs'
import { BATCH_DECISIONS, parseReceiptProof, projectOf } from './state.mjs'
import { readTaskChanges } from './task-changes.mjs'
import { DRAFT_KINDS } from '../forge/forge.mjs'
import { buildPairingInstruction } from './federation.mjs'
import { mintPairing, telegramLinkView } from '../telegram/pairing.mjs'
import { scanEstate, enrollSelections } from './import-scanner.mjs'
import { createOnboarding } from './onboarding.mjs'
import { namedPaths, missingPaths } from './tree-probe.mjs'
import { collectDiagnostics } from './diagnostics.mjs'
import { projectEntry, codeTreeOf, planningHomeOf, pipelineMaxTurns } from '../config.mjs'
import { taskTurnCap, burnedTurnCapsOf, TURN_SIZE_LABELS } from '../policy/turn-budget.mjs'
// NOTE: только ПРЕДИКАТ формы идентификатора сессии импортируется из сборщика аргументов —
// чистая функция без состояния и без выхода наружу. Спавн этой дверью не заводится: она
// спрашивает то же правило, каким пользуется запуск, чтобы не завести второго мнения о том,
// какую сессию вообще можно продолжить.
import { isResumableSessionId } from '../runner/args.mjs'
// NOTE: diagnostics.mjs is STATICALLY imported for the same reason as the two below: it is
// pure over an injected os/process/fs, it writes nothing, it reaches no model and no spawn,
// and its whole job is to REFUSE to carry anything — there is no capability here to gate.
// NOTE: the questions engine is STATICALLY imported for the same reason: it is pure over an
// INJECTED fs, it reaches no model and no spawn, and the ONE field it writes it writes into an
// artifact the workflow already owns, through its own atomic write. There is no capability
// here to gate — and unlike a read model it has no second implementation to inject.
// NOTE: the import scanner and the onboarding interview are STATICALLY imported — unlike
// the appliers and the chat engine — because neither holds a capability worth gating: both
// are pure over an INJECTED fs, neither reaches a model or a spawn (their suites prove it
// by grep), and every byte either writes goes through a door that already exists — the
// forge's (draftPathFor → lintDraft → receipt → awaiting_approval) and the profile
// writer's. There is nothing here to switch off, because no enable path exists to switch.
// NOTE: only the pairing INSTRUCTION BUILDER is imported from federation.mjs — a pure text
// function with no fetch and no state. The federation ENGINE (poll/aggregate/proxy/pairing
// book) is injected via deps.federation, so no request path can open an outbound daemon→
// daemon call except through the instance the composition root wired.
// NOTE: readHarness + the appliers (harness.mjs) are INJECTED via deps — never statically
// imported here — so each per-task commit stays independently green and no request path can
// reach a config/registry write except through the wired applier. DRAFT_KINDS
// is a frozen leaf constant (forge.mjs), imported for the /api/forge body validation.
// NOTE: parseReceiptSummary (state.mjs, Task 2) is INJECTED via deps.parseReceiptSummary
// — never statically imported here — so server.mjs carries no build edge onto state.mjs
// and each per-task commit stays independently green.

/** A queue-minted task id shape (BL-…/R-…/F-…): strict, so a diff/task path can never
 *  smuggle a path traversal or a shell metacharacter into an injected git call. */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * An ATTEMPT's id shape: a task id, optionally followed by `#<n>` — the exact literal the
 * ledger mints (`attemptIdFor`), and the one identity in this product that cannot be spelled
 * inside ID_RE. It is NARROWER than ID_RE everywhere except that single character: the task
 * half is the same grammar, and the attempt half is digits and nothing else, so nothing that
 * reads as a separator, a traversal or a shell metacharacter can be expressed here either.
 * The optional half keeps the bare shape the route guard was declared with still matching.
 */
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,64}(#\d{1,4})?$/

/**
 * The reserved POST /api/agent/toggle target meaning «the whole shipped SMA team» rather than
 * one agent id. DECLARED HERE rather than imported, because harness.mjs is the
 * appliers module and this file must carry no static edge onto it — the same reason readHarness
 * and the appliers arrive through deps. It is the same literal as harness.mjs's
 * STOCK_TEAM_TARGET, and harness.test.ts asserts the two never drift apart.
 */
export const STOCK_TEAM_TARGET = '__stock-team__'

/**
 * The reserved POST /api/approve target PREFIX meaning «apply the migration proposal for one
 * note of the connected project» rather than «approve a task». It rides the approve door
 * for the same reason the stock team rides the toggle door:
 * the route table is FROZEN and a per-file yes is, structurally, exactly what
 * approve already is — a human's word, serialized, on one named unit of work.
 *
 * The suffix is the note's stem; `<prefix><stem>` stays inside ID_RE, so the id validation
 * that guards every other approve applies unchanged. The applier arrives through deps and
 * validates the reconstructed filename again on its own side.
 */
export const PROJECT_MIGRATION_TARGET_PREFIX = '__migrate__'

/** POST JSON body cap (V5) — a roster body is a handful of short fields, never a blob. */
const JSON_BODY_CAP = 16 * 1024

/** Diff response cap — a raw diff over LAN is auth'd AND size-bounded. */
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
 * ROUTES — THE FINAL FROZEN TABLE (re-frozen 2026-08-28; the FIFTY-THREE of the V5.4
 * freeze plus eleven doors, eight of them declared once by the release that shipped them —
 * the chat stop button in v5.4.3, the running-task steering wheel in v5.5.0, in v5.6.0 the
 * batch request, the word its owner answers a stopped batch with, the composition a phrase
 * could have, the two doors of a task's WORDS (the one that proposes them and the one that
 * corrects them), and the order that stops ONE echelon of ONE phase and starts it again —
 * and two carrying no release stamp until one is actually cut: the door that CANCELS
 * a task (a person stops the work, and the row is closed only after the live child under it
 * is dead), the door that READS THE FOLDER OF ONE PHASE — its directory as a tree, and
 * one file of it as text, both bounded, neither able to leave that directory — and the door
 * that WRITES A SKILL into this machine's skill store).
 * Exactly SIXTY-EIGHT entries mapping `${METHOD} ${path-pattern}` → handler name. `:id`
 * marks the five dynamic id segments (/api/task/:id, /api/diff/:id, /api/phase/:id,
 * /api/phase/:id/files, /api/attempt/:id), all bound to ID_RE; `:file` marks the one dynamic
 * asset segment (/assets/:file), bound to ASSET_RE. This object IS the contract the guard invariant
 * polices — its size is a test (Object.keys(ROUTES).length === 68) and no route may be
 * added without also touching that guard invariant.
 *
 * The first fourteen are the original surface; the sixteen after them were the declared-once
 * V5.1 growth; the twenty-three below THOSE were the declared-once V5.4 growth, filled one at
 * a time; the last twelve joined one release at a time, additively — nothing was
 * removed or renamed. ALL SIXTY-EIGHT ARE LIVE — the table carries no stub, and the shape
 * test says so without consulting any list of exceptions. The table itself does not move.
 *
 * THREE OF THE TEN PROPOSE AND DO NOT WRITE, and they are worth reading as one family: the
 * two word doors are a PAIR (the first returns a draft for a person to correct, the second
 * writes only onto a task whose work is not over), and the batch-composition door is the same
 * promise about a whole batch. Between them they are the whole of «система предлагает,
 * владелец подтверждает» — and each of the three is proved by an EMPTY QUEUE after the call,
 * not by its status code.
 */
export const ROUTES = Object.freeze({
  // ── the original fourteen (live) ──
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
  // ── the V5.1 sixteen (declared here, filled one at a time) ──
  'GET /assets/:file': 'handleAsset',
  'GET /api/projects': 'handleProjects',
  'POST /api/project/add': 'handleProjectAdd',
  'POST /api/project/rename': 'handleProjectRename',
  'POST /api/project/select': 'handleProjectSelect',
  'POST /api/project/planning': 'handleProjectPlanning',
  'GET /api/machines': 'handleMachines',
  'POST /api/machine/pair': 'handleMachinePair',
  'POST /api/machine/add': 'handleMachineAdd',
  'POST /api/machine/remove': 'handleMachineRemove',
  'POST /api/chat': 'handleChat',
  'POST /api/chat/stop': 'handleChatStop',
  'POST /api/redirect': 'handleRedirect',
  'GET /api/chat/history': 'handleChatHistory',
  // ── книга разложена по разговорам: список слева и имя, данное рукой ──
  'GET /api/chat/conversations': 'handleChatConversations',
  'POST /api/chat/rename': 'handleChatRename',
  'POST /api/import/scan': 'handleImportScan',
  'POST /api/import/enroll': 'handleImportEnroll',
  'GET /api/onboarding': 'handleOnboarding',
  'POST /api/onboarding/answer': 'handleOnboardingAnswer',
  'POST /api/onboarding/complete': 'handleOnboardingComplete',
  // ── the V5.4 growth (declared here, filled one at a time) ──
  'POST /api/phase/stage': 'handlePhaseStage',
  'GET /api/phase/:id': 'handlePhaseCard',
  'POST /api/phase/uat': 'handlePhaseUat',
  'POST /api/decision/answer': 'handleDecisionAnswer',
  'GET /api/artifact': 'handleArtifact',
  'GET /api/memory/drafts': 'handleMemoryDrafts',
  'POST /api/memory/apply': 'handleMemoryApply',
  'POST /api/memory/index': 'handleMemoryIndex',
  'GET /api/memory/lint': 'handleMemoryLint',
  'GET /api/coordination': 'handleCoordination',
  'POST /api/claim/clear': 'handleClaimClear',
  'GET /api/backlog': 'handleBacklog',
  'POST /api/backlog/promote': 'handleBacklogPromote',
  'GET /api/attempt/:id': 'handleAttempt',
  'POST /api/ship/gate': 'handleShipGate',
  'POST /api/ship/publish': 'handleShipPublish',
  'GET /api/search': 'handleSearch',
  'POST /api/account/add': 'handleAccountAdd',
  'POST /api/pipeline/toggle': 'handlePipelineToggle',
  'GET /api/diagnostics': 'handleDiagnostics',
  'POST /api/update/run': 'handleUpdateRun',
  'POST /api/budget/set': 'handleBudgetSet',
  'POST /api/agent/model': 'handleAgentModel',
  // ── the batch: one request of the owner, filled with its handler in the same commit ──
  'POST /api/batch': 'handleBatchCreate',
  // ── and the word he answers a stopped one with: skip / repeat / abandon ──
  'POST /api/batch/decide': 'handleBatchDecide',
  // ── the composition a phrase COULD have: proposed for confirmation, never put in ──
  'POST /api/batch/suggest': 'handleBatchSuggest',
  // ── the words of a task: the system PROPOSES them, and the owner CORRECTS them ──
  'POST /api/task/suggest': 'handleTaskSuggest',
  'POST /api/task/words': 'handleTaskWords',
  // ── «останови волну 2»: the one echelon of one phase stands, and starts again ──
  'POST /api/wave/hold': 'handleWaveHold',
  // ── остановка задачи человеком: сначала убить живого ребёнка, потом закрыть строку ──
  'POST /api/task/cancel': 'handleTaskCancel',
  // ── папка фазы: её каталог, как он лежит на диске, и один файл из него ТЕКСТОМ ──
  'GET /api/phase/:id/files': 'handlePhaseFiles',
  // ── НАСТРОЙКИ ОДНОГО ПОДКЛЮЧЕНИЯ: свой бот Telegram — подключить, выдать код пары, отключить ──
  'POST /api/connection/telegram': 'handleConnectionTelegram',
  // ── НАПИСАТЬ НАВЫК ИЗ ОКНА: текст человека ложится в машинное хранилище и становится тем,
  //    что можно выдать работнику. Раздача уже была дверью; написать навык было нечем, и
  //    поэтому «создать навык» существовало только как заказ кузнице и ожидание одобрения ──
  'POST /api/skill/create': 'handleSkillCreate',
})

/**
 * PENDING_ROUTES — EMPTY, and kept. The declared-but-unfilled slots of a growth wave, as a
 * frozen Set of route keys: the machine-readable answer to «is this 501 a promise or a defect»
 * while a batch of doors is being filled one at a time.
 *
 * It is a SEPARATE literal rather than a slice derived from the table, and that was the whole
 * mechanism: a plan that filled a slot deleted ITS key here in the same commit that landed the
 * live handler, so the Set shrank by one per fill and the frozen table never moved at all.
 *
 * THE GROWTH IS FINISHED AND THE SET IS EMPTY. Two decisions were taken at that moment, and
 * they pull in opposite directions on purpose:
 *
 *   1. The Set STAYS, empty. Deleting it would have destroyed something real: across the
 *      suite, each fill plan left an assertion that ITS key is gone from here — better than
 *      forty separate proofs that the work was actually done, and they only mean anything
 *      while this constant exists. An emptiable list of exceptions beats a list that
 *      disappears the moment it stops being convenient.
 *
 *   2. The shape test NO LONGER ASKS IT. It passes an empty Set literal instead, so the law it
 *      enforces — NO HANDLER OF THIS TABLE IS A BARE 501 — is unconditional and cannot be
 *      weakened by anybody adding a key here. The list survives as a record; it is no longer
 *      a licence.
 *
 * A later growth wave that wants to declare routes ahead of their handlers re-wires the shape
 * test to consult this Set again, deliberately and in the open, exactly as the first one did.
 *
 * ONE HONEST LIMIT: `Object.freeze` on a Set seals the OBJECT, not its entries — `.add()`
 * still works at runtime. The freeze says «this is a declaration, not a scratchpad» and keeps
 * the binding from being swapped. No request path reads this constant, so there is no attack
 * in that gap — only a reader who might otherwise believe the runtime enforces what the suite
 * does.
 */
export const PENDING_ROUTES = Object.freeze(
  new Set([]),
)

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

/** The 401 body is a CONSTANT — no reason, no route, no oracle. */
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
 * The one reserved segment of GET /api/phase/:id: «not one phase — the list of them».
 *
 * The index rides the card's own route rather than a route of its own, for the reason every
 * reserved target in this file exists: the table is frozen and a list is, structurally, what
 * you ask the same door when you do not name a card. It is spelled out as a constant so the
 * decision is greppable — ID_RE would accept the word anyway, and a rule nobody can find is
 * a rule that gets re-litigated. The handler owns what it MEANS; matchRoute only admits it.
 */
const PHASE_INDEX_SEGMENT = 'index'

/**
 * matchRoute(method, pathname) → { handler, params } | { badId:true } | null.
 * Static routes hit the frozen table by key; the six dynamic routes match a prefix and
 * validate their segment against ID_RE (task/diff/phase/phase-folder/attempt) or ASSET_RE
 * (assets) — a
 * failing segment → badId → 400, never a 404 that would hint the route shape. Anything else
 * → null → 404. Every branch below is the SAME shape on purpose: an error that varies with
 * the route is an error that maps the surface.
 */
export function matchRoute(method, pathname) {
  const key = `${method} ${pathname}`
  if (ROUTES[key]) return { handler: ROUTES[key], params: {} }

  if (method === 'GET') {
    const diff = pathname.match(/^\/api\/diff\/(.+)$/)
    if (diff) return ID_RE.test(diff[1]) ? { handler: 'handleDiff', params: { id: diff[1] } } : { badId: true }
    const task = pathname.match(/^\/api\/task\/(.+)$/)
    if (task) return ID_RE.test(task[1]) ? { handler: 'handleTask', params: { id: task[1] } } : { badId: true }
    // ПАПКА ФАЗЫ СТОИТ ПЕРЕД КАРТОЧКОЙ, и порядок здесь несущий: `12-front/files` попал бы под
    // выражение карточки целиком, а косая черта не проходит ID_RE — так что дверь папки, стоящая
    // ниже, отвечала бы 400 на собственный законный адрес и никогда бы не открывалась.
    const phaseFiles = pathname.match(/^\/api\/phase\/(.+)\/files$/)
    if (phaseFiles) {
      return ID_RE.test(phaseFiles[1])
        ? { handler: 'handlePhaseFiles', params: { id: phaseFiles[1] } }
        : { badId: true }
    }
    const phase = pathname.match(/^\/api\/phase\/(.+)$/)
    if (phase) {
      const seg = phase[1]
      // the reserved literal is admitted EXPLICITLY, not by accident of ID_RE being wide
      return seg === PHASE_INDEX_SEGMENT || ID_RE.test(seg)
        ? { handler: 'handlePhaseCard', params: { id: seg } }
        : { badId: true }
    }
    const attempt = pathname.match(/^\/api\/attempt\/(.+)$/)
    if (attempt) {
      // THE ONE SEGMENT THAT IS DECODED, and it is decoded because an attempt's real identity
      // carries a character no path segment may carry raw: `<taskId>#<n>`. A client that
      // spells it correctly sends `%23`, which is not `#` to any regex here — so an id shaped
      // like every attempt this daemon has ever minted would have answered 400, and only ids
      // that no attempt actually has would have got through. Decoding is safe HERE and only
      // here because what follows is an ALLOW-LIST rather than a deny-list: a separator, a
      // dot-dot or a metacharacter cannot survive ATTEMPT_ID_RE, encoded or not.
      let seg
      try {
        seg = decodeURIComponent(attempt[1])
      } catch {
        return { badId: true } // malformed percent-encoding is a bad id, never a throw
      }
      return ATTEMPT_ID_RE.test(seg) ? { handler: 'handleAttempt', params: { id: seg } } : { badId: true }
    }
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
 * GET / — THE APP RIDES WITH THE DAEMON. The built index.html is read off disk
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
 * TRAVERSAL IS IMPOSSIBLE BY CONSTRUCTION: the name was already matched against
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
    // the roster's period figures ride the SAME read model seam as everything else here —
    // no door of its own, so the frozen route table is untouched.
    workerStats: deps.workerStats,
    windows: deps.windows,
    // The reading the person's own terminal lays down for its subscription — a subject of its
    // own, not any account's bar, and forwarded like every other collaborator.
    terminalWindows: deps.terminalWindows,
    config,
    usageReader: deps.usageReader,
    usageSeries: deps.usageSeries,
    readReceipt: deps.readReceipt,
    execGit: deps.execGit,
    clock: deps.clock,
    // the corpus surfaces («Память» and the style read model) read the repository this daemon serves.
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
    // ДОМ ИДУЩИХ ПОПЫТОК — тот же самый объект, который тик спрашивает про место перед
    // захватом. Пересылается сюда, а не пересчитывается: «занято» на экране обязано быть тем
    // же числом, по которому машина отказывает в месте, иначе экран объясняет не ту машину.
    inFlight: deps.inFlight,
    // ФАЙЛ НАСТРОЕК С ДИСКА — не `config`, а то, что лежит в файле ПРЯМО СЕЙЧАС. `config`
    // выше — копия, прочитанная на запуске; настройки, применяющиеся только с нового
    // запуска, расходятся именно с ней, и без этого шва окно не может сказать «в файле
    // одно, работаю по другому». Не подключён — дверь просто ничего про файл не утверждает.
    configOnDisk: deps.configOnDisk,
  }
}

/**
 * GET /api/state — the one-poll roster payload (deriveState; Task 2 + costs in Task 4).
 * The optional `?project=` narrows the TASKS of the payload and nothing else — the project
 * switcher itself has to keep seeing every project.
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
 * readTaskJournal(id, deps) → the layers of ONE task, shaped for the card:
 * `dispatcher[]` (code + its human подпись + when), `memoryTrace` (IDS only, de-duplicated),
 * `redirects[]` (what a person said to the running work, and when) and the per-attempt
 * approach notes. The ledger is the SAME injected seam the attempts
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
  // ЧТО ЧЕЛОВЕК СКАЗАЛ ПО ХОДУ — в том порядке, в каком говорил. Слой не сводится и не
  // складывается: две поправки — это два разных слова, сказанные в разное время, и лента хода
  // показывает каждое своей строкой. Текст едет как ДАННЫЕ — экран рисует его текстовым узлом.
  const redirects = []
  const notes = new Set()
  const reflexes = new Set()
  const approachByAttempt = new Map()
  // ЧЕМ КОНЧИЛАСЬ ПАМЯТЬ ЗАДАЧИ — по ПОСЛЕДНЕЙ строке слоя, а не по объединению всех. Списки
  // прочитанного складываются по всем попыткам (их читали все), но «что загружено», «откуда
  // рефлексы», «чему научила» и «оставила ли записку» принадлежат последней попытке: иначе
  // провал первой навсегда закрыл бы урок второй.
  let lastMemory = null

  for (const row of entries.slice(0, JOURNAL_ROW_CAP)) {
    const payload = (row && row.payload) || {}
    if (row.layer === 'dispatcher') {
      dispatcher.push({
        code: payload.code ?? null,
        label: DISPATCH_REASONS[payload.code] ?? null, // the code is what is stored; this is its подпись
        ts: row.recordedAt ?? null,
      })
    } else if (row.layer === 'redirect') {
      redirects.push({
        id: payload.redirectId ?? null,
        mode: payload.mode ?? null,
        label: REDIRECT_MODE_LABELS[payload.mode] ?? null, // код хранится, подпись рисуется
        text: String(payload.text ?? ''),
        truncated: payload.truncated === true,
        ts: row.recordedAt ?? null,
        attempt: Number.isFinite(Number(row.attempt)) ? Number(row.attempt) : null,
      })
    } else if (row.layer === 'memory') {
      for (const n of Array.isArray(payload.notes) ? payload.notes : []) notes.add(n)
      for (const r of Array.isArray(payload.reflexes) ? payload.reflexes : []) reflexes.add(r)
      lastMemory = payload
    } else if (row.layer === 'approach' && payload.approach) {
      const attempt = Number.isFinite(Number(row.attempt)) ? Number(row.attempt) : 1
      approachByAttempt.set(attempt, String(payload.approach))
    }
  }

  return {
    dispatcher,
    redirects,
    memoryTrace: {
      notes: [...notes],
      reflexes: [...reflexes],
      // Слой вырос: что сессия открыла в корпусе, сколько раз позвала конвейер, откуда взяты
      // рефлексы, что она прочла из авто-памяти аккаунта, чему научила и оставила ли записку.
      // Всё это писалось в журнал и не отдавалось никому — вычислено и записано не значит
      // предъявлено. Каждое поле НАЗВАНО нулём при отсутствии: карточка читает одну форму для
      // любой задачи, и «этого ключа здесь нет» — то, с чего поверхность начинает гадать.
      loaded: (lastMemory && lastMemory.loaded) ?? null,
      autoMemoryReads: (lastMemory && lastMemory.autoMemoryReads) ?? null,
      reflexSource: (lastMemory && lastMemory.reflexSource) ?? null,
      lesson: (lastMemory && lastMemory.lesson) ?? null,
      approach: (lastMemory && lastMemory.approach) ?? null,
    },
    approachByAttempt,
  }
}

/**
 * GET /api/task/:id — the explicit-pick task-timeline read model (Task 4). Surfaces the
 * task's `acceptance` (the DoR contract wherever the task is judged),
 * the per-attempt chain (readAttempts) with failure_reason + reasonLabel, a parsed
 * receipt summary per attempt, the branch, a capped commit log, and returned notes. The
 * 9.6 Task-card renders from this alone. Unknown id → 404.
 */
/**
 * attemptSpawnArgs(deps, runDir) → аргументы запуска ЭТОЙ попытки, как они записаны в её
 * каталоге, или `null`.
 *
 * ПОЧЕМУ ЭТО И ЕСТЬ ПРАВДА О ЗАПРЕЩЁННОМ. Запись попытки хранит командную строку целиком —
 * то, что процесс получил, а не то, что мы о нём думаем. Всё остальное здесь — пересказ.
 *
 * FAIL-OPEN И ЧЕСТНО О МОЛЧАНИИ: каталога нет, файла нет, файл не читается или не разбирается
 * — `null`, то есть «эта попытка ничего об этом не говорит». Не пустой список: пустой список
 * означал бы «спросили и узнали, что не запрещено ничего», а это другое утверждение. И
 * никогда не ошибка двери: карточка не имеет права падать из-за нечитаемого артефакта.
 */
function attemptSpawnArgs(deps, runDir) {
  if (typeof runDir !== 'string' || runDir === '') return null
  try {
    const readFile = (deps.fsImpl && deps.fsImpl.readFileSync) || fsReadFileSync
    const record = JSON.parse(String(readFile(join(runDir, 'run.json'), 'utf8')))
    return Array.isArray(record && record.args) ? record.args : null
  } catch {
    return null
  }
}

/**
 * accountDirOf(config, workerId) → каталог аккаунта, под которым идёт работник этой строки,
 * или `null`.
 *
 * ПОЧЕМУ ОН ЕДЕТ РЯДОМ С СЕССИЕЙ. Сессия лежит НЕ «в системе», а внутри аккаунта, который
 * получил спавн (`CLAUDE_CONFIG_DIR`). Человек, набравший продолжение в своём терминале, ходит
 * под СВОИМ аккаунтом и не найдёт там ничего — команда отработает и честно скажет, что такой
 * сессии нет. Каталог аккаунта — то единственное, что превращает предложенную строку в
 * работающую.
 *
 * ЧИТАЕТСЯ ПРОФИЛЬ РАБОТНИКА, НАЗВАННОГО НА СТРОКЕ, тем же правилом, каким его находит сборщик
 * аргументов, — по идентификатору. Отсюда и граница честности: если профиль с тех пор
 * переписали, ответ говорит про СЕГОДНЯШНИЙ аккаунт этого работника, а не про вчерашний.
 * Строка попытки каталога не хранит, а выдумывать его по имени работника нельзя тем более.
 *
 * `null` — «в настройках такого работника нет»: экран об этом молчит вслух, а не подставляет
 * путь, которого никто не называл.
 */
function accountDirOf(config, workerId) {
  if (typeof workerId !== 'string' || workerId === '') return null
  const workers = Array.isArray(config && config.workers) ? config.workers : []
  const found = workers.find((w) => w && w.id === workerId)
  const dir = found && found.account && found.account.configDir
  return typeof dir === 'string' && dir !== '' ? dir : null
}

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
  // THE LAST WORD ABOUT THE TASK, not the first row that happens to carry its id. A durable
  // queue keeps the row a task broke on beside the row of the attempt its owner asked for, and
  // hands them back in no promised order — so «the first row with this id» is, for a repeated
  // piece, the failure. Measured live: a piece of a batch failed its gate, the owner pressed
  // «Повторить», the repeat came back green and stood for approval — `/api/state` said
  // `awaiting_approval` and this door said `failed, attempt 1` in the same second. The window
  // derives the «Одобрить» button from THIS answer, so finished work could not be accepted from
  // the window at all. The fold is the queue's own exported rule — the very one the waiting list
  // and the turn rule read by — applied to this task's rows before the row is picked, so the
  // three doors can never say different things about one task. Nothing below changes: the
  // survivor walks the same path (the claimed branch, the ledger, the journal) it always did.
  const row = latestRowPerId(rows.filter((r) => r && r.id === id))[0]
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
  // THE THREE LAYERS. The journal rides the SAME ledger seam as the attempts —
  // no second store — and a task created before the journal existed reads as empty layers,
  // never as an error: backward compatibility is a hard requirement, not a nicety.
  const journal = readTaskJournal(id, deps)

  // ONE ATTEMPT, ONE ROW. Two writers append for the same attempt — the state machine puts
  // down the transition, the tick puts down provider/session/usage — so the ledger holds two
  // rows per attempt and the card printed «Подход 1 · готово» twice in a row, as if the work
  // had been done twice. The merge rule lives with the ledger (`foldAttemptRows`) and is the
  // SAME one the state payload counts by: two places that fold rows their own way is how two
  // screens come to disagree about how many tries there were.
  rawAttempts = foldAttemptRows(rawAttempts)

  const parseReceipt = typeof deps.parseReceiptSummary === 'function' ? deps.parseReceiptSummary : () => null

  /**
   * КОНСПЕКТ ПЕРЕДАЧИ ОДНОЙ ПОПЫТКИ — прочитанный из ТОГО ЖЕ файла, который положила она сама.
   *
   * ПУТЬ СОБИРАЕТСЯ ТЕМ ЖЕ ВЫРАЖЕНИЕМ, что и у писателя, и у спавна, и у билета ниже. Второе
   * написание того же пути читало бы каталог, в который никто не пишет, — и молчало бы при этом
   * совершенно честно на вид: экран сказал бы «конспекта нет» о задаче, у которой он есть.
   *
   * АДРЕСУЕТСЯ ТОЛЬКО ЗАПРОШЕННАЯ ЗАДАЧА И ЕЁ СОБСТВЕННЫЙ ПОДХОД: идентификатор каталога
   * минтится из `id` этой двери и номера попытки её же строки, и никакого другого способа
   * назвать каталог здесь не заводится — иначе дверь стала бы читалкой чужих файлов.
   *
   * `null` СНИМАЕТ КЛЮЧ ЦЕЛИКОМ, а не подставляет пустую строку: «нечего показать» и «не
   * знаем» — разные предложения, и карточка обязана молчать только о первом.
   */
  const handoverOf = (attempt) => {
    const n = Number.isFinite(Number(attempt)) ? Number(attempt) : null
    if (n === null || n < 1) return null
    const dir = attemptRunDir({
      runsDir: runsDirOf(taskTreeDir({ config, deps, row }) ?? config.repoDir),
      attemptId: attemptIdFor(id, n),
    })
    return readContinuation({ dir, fsImpl: deps.fsImpl })
  }

  /**
   * СНИМОК КОНТЕКСТА, С КОТОРЫМ УШЛА ИМЕННО ЭТА ПОПЫТКА — прочитанный из файла-свидетеля,
   * который положила она сама, ТЕМ ЖЕ ВЫРАЖЕНИЕМ ПУТИ, что и конспект выше.
   *
   * ЧИТАЕТСЯ ФАЙЛ, А НЕ СТРОКА ОЧЕРЕДИ, и это не лишний крюк. Человек правит слова задачи
   * после сорванного подхода — строка становится другой, а попытка уже ушла с тем снимком,
   * который ей ДАЛИ. Карточка показывает историю подходов, значит и снимок ей нужен
   * исторический; прочитанный со строки выглядел бы точно так же и врал бы ровно в тот
   * момент, когда человек разбирается, почему подход сорвался.
   *
   * АДРЕСУЕТСЯ ТОЛЬКО ЗАПРОШЕННАЯ ЗАДАЧА И ЕЁ СОБСТВЕННЫЙ ПОДХОД — теми же двумя
   * составляющими, что у конспекта; другого способа назвать каталог здесь нет.
   */
  const snapshotOf = (attempt) => {
    const n = Number.isFinite(Number(attempt)) ? Number(attempt) : null
    if (n === null || n < 1) return null
    const dir = attemptRunDir({
      runsDir: runsDirOf(taskTreeDir({ config, deps, row }) ?? config.repoDir),
      attemptId: attemptIdFor(id, n),
    })
    return readTaskContext({ dir, fsImpl: deps.fsImpl })
  }

  /**
   * ЧЕМ ЭТА ПОПЫТКА ОБОШЛАСЬ — четыре числа поставщика из её собственной квитанции.
   *
   * ЧИТАЕТСЯ ТЕМ ЖЕ КОДОМ, КАКИМ ПИШЕТСЯ, и по тому же выражению пути, что конспект и снимок
   * выше: числа лежат в `receipt.json` каталога прогона, и второе написание их имён здесь
   * молча отдавало бы нули на квитанции, которая всё сказала.
   *
   * `null` — «попытка об этом молчит»: финального кадра не было, попытка старше этого поля,
   * каталог подмели. Нули означали бы «поставщик сказал ноль», а это другое предложение.
   */
  const tokensOf = (attempt) => {
    const n = Number.isFinite(Number(attempt)) ? Number(attempt) : null
    if (n === null || n < 1) return null
    const dir = attemptRunDir({
      runsDir: runsDirOf(taskTreeDir({ config, deps, row }) ?? config.repoDir),
      attemptId: attemptIdFor(id, n),
    })
    return readRunTokens({ dir, fsImpl: deps.fsImpl })
  }

  const attempts = rawAttempts.map((a) => {
    // Спрошено ОДИН раз на попытку и названо здесь, а не внутри тела: тело ниже — перечисление
    // явных выборов, и чтение диска посреди него читалось бы как ещё одно поле.
    const handover = handoverOf(a.attempt)
    const snapshot = snapshotOf(a.attempt)
    const tokens = tokensOf(a.attempt)
    return {
    attempt: a.attempt ?? null,
    workerId: a.workerId ?? null,
    provider: a.provider ?? null,
    startedAt: a.startedAt ?? null,
    endedAt: a.endedAt ?? null,
    outcome: a.outcome ?? null,
    failureReason: a.failureReason ?? null,
    reasonLabel: a.failureReason ? REASON_LABELS[a.failureReason] ?? null : null,
    // THE SEAM THIS READER ASKS FOR IS `readReceipt`, and it was being handed `execGit` — a
    // receipt reader given git. It changed nothing either way, which is why it survived: a
    // `receiptRef` written by the tick is a STRING, and with no resolver the summary is four
    // nulls whichever collaborator arrives. Named and corrected rather than left standing: a
    // wrong dependency in a call is a lie the next reader has to disprove.
    receipt: parseReceipt(a.receiptRef, { readReceipt: deps.readReceipt }),
    // The proof this attempt actually left. `receipt` above waits for four numbers no part
    // of this system produces; this one carries what the tick really wrote when the gate
    // opened, so a card says «перепроверено» instead of showing nothing at all.
    proof: parseReceiptProof(a.receiptRef),
    // A row the reconciliation pass appended after the fact says so on the
    // card too. Without this a card would show an attempt with no worker and no provider as
    // though somebody had watched it produce nothing; the flag exists precisely so a reader
    // never has to guess which kind of row is in front of them. Absent (never false) on
    // every live-recorded row, exactly as it is in the ledger.
    ...(a.reconstructed === true ? { reconstructed: true } : {}),
    // (b) of the three layers: the worker's own note rides ITS attempt, not the task
    ...(journal.approachByAttempt.has(a.attempt) ? { approachNote: journal.approachByAttempt.get(a.attempt) } : {}),
    // ═══ WHERE THE WORK HAPPENED, AND WHAT IS LEFT OF IT ═══════════════════════════
    //
    // The copy this attempt ran in — the commit it was cut from, its branch, its directory,
    // what was put into it before the worker's first move, how long that took, and the trace
    // of its removal. The tick has been writing all six into the attempt row and the removal
    // writes its own row of the same attempt; nothing handed them to anybody. Computed and
    // recorded is not the same as delivered: an attempt row that holds what no person can
    // see is a point of return nobody can reach. Explicitly picked, like every field above,
    // so a ledger row can never leak a key this door did not name.
    base: a.base ?? null,
    branch: a.branch ?? null,
    worktreePath: a.worktreePath ?? null,
    materialized: Array.isArray(a.materialized) ? a.materialized : null,
    provisionMs: Number.isFinite(a.provisionMs) ? a.provisionMs : null,
    cleanup: a.cleanup && typeof a.cleanup === 'object' ? a.cleanup : null,
    // ═══ ЧЕМ ВЕРНУТЬСЯ В СЕССИЮ ЭТОГО ПОДХОДА ════════════════════════════════════
    //
    // Машинная половина этой дороги закрыта давно: продолжение попытки поднимает ТУ ЖЕ
    // сессию, потому что демон хранит её идентификатор здесь же, на строке реестра. У
    // человека такой дороги не было вовсе — он читал на карточке, что подход сорвался, и не
    // мог войти туда, где это случилось. Знание было, доступа не было, и разница между ними
    // стоила отдельного разбора после каждой сорванной попытки.
    //
    // НАРУЖУ ЕДЕТ ТОЛЬКО ПРИГОДНОЕ К ПРОДОЛЖЕНИЮ. Форма спрашивается у того же предиката,
    // которым её спрашивает сборщик аргументов запуска: второе написание правила разошлось
    // бы с первым молча, и окно предлагало бы строку, которую командная строка отвергает.
    // Идентификатор другой формы уезжает нулём — «этой попыткой воспользоваться нельзя», а
    // не «идентификатора нет».
    sessionId: isResumableSessionId(a.sessionId) ? a.sessionId : null,
    accountDir: accountDirOf(config, a.workerId),
    // ═══ ПОД КАКИМ СЛОЕМ ЭТО РАБОТАЛО ════════════════════════════════════════════
    //
    // Что зеркало положило в аккаунт работника перед спавном (CLAUDE.md, хуки, сужающие
    // правила, плагины, выключенные подключения claude.ai) — и что сессия ДЕЙСТВИТЕЛЬНО
    // загрузила, дочитанное из её init-кадра: авто-память проекта, хуки старта, чужие
    // подключения. Рядом — файл MCP, с которым её запускали, и список серверов в нём.
    // Тик пишет оба объекта в строку попытки с самого начала фазы, и до этой строки их
    // не видел никто: вычислено и записано — не то же самое, что предъявлено. Человек,
    // который не может увидеть слой, не может и заметить, что слой не тот.
    //
    // Отданы КАК ЕСТЬ и явным выбором, как всё выше: строка леджера не имеет права
    // протащить в тело двери ключ, который дверь не назвала. Слова к причине провала
    // `personal_layer_error` живут в одном месте — REASON_LABELS очереди, откуда их
    // читает `reasonLabel` выше; второго словаря здесь заводить нельзя.
    personalLayer: a.personalLayer ?? null,
    mcpConfig: a.mcpConfig ?? null,
    // Что приёмка спасла из копии до того, как копия исчезла: перенесённые черновики,
    // применённые уроки, отложенная записка и отказы конвейера. Рядом с уборкой и НЕ внутри
    // неё — удаление копии и спасение урока разные события, и одно не имеет права объяснять
    // другое. Без этого поля судьба урока читалась бы по отсутствию файла, то есть никак.
    memoryHarvest: a.memoryHarvest ?? null,
    // ═══ ЧЕМ ЭТА ПОПЫТКА ДОКАЗЫВАЕТ, ЧТО РАБОТАЛА ПОД ТВОИМИ ПРАВИЛАМИ ═══════════
    //
    // Каталог прогона и вердикт шестёрки квитанций. Тик оставляет каталог на каждой попытке
    // и считает по нему тот же вердикт, что печатает команда проверки, — и до этой строки
    // ни то, ни другое не видел никто, кроме файла на диске. Обещание «та же сессия, что в
    // твоём терминале» без предъявленного доказательства — обещание, которое некому
    // проверить; путь нужен человеку, чтобы открыть каталог и посмотреть самому.
    //
    // Отданы КАК ЕСТЬ и явным выбором, как всё выше. `null` — «никто не проверял», и это не
    // то же самое, что «проверено и в порядке»: попытки, сделанные до того, как строка
    // научилась нести вердикт, обязаны молчать, а не показывать пустую шестёрку.
    runDir: a.runDir ?? null,
    parity: a.parity ?? null,
    // ═══ СВЕДЕНА ЛИ ВЕТКА С ВЕРШИНОЙ — И ЕСЛИ НЕТ, ЧТО ИМЕННО НЕ СОШЛОСЬ ═════════
    //
    // Дверь сдачи сводит ветку работника с вершиной в его собственной копии и кладёт ответ
    // на строку попытки: с какой вершиной сводили, на сколько она уехала, свелось ли, что
    // развелось без человека и — если не свелось — имена оставшихся файлов с их числом.
    //
    // ДО ЭТОЙ СТРОКИ ОТВЕТ НЕ ВИДЕЛ НИКТО. Он вычислялся, записывался в долговечную строку —
    // и упирался в дверь карточки, которая его не называла: приёмщик узнавал о споре только
    // ПОСЛЕ того, как нажал «принять» и слияние отказало. Ровно тот случай, ради которого
    // поле и клали на строку: копию после приёмки выметают, и к моменту вопроса ответа уже
    // нет. Вычислено и записано — не то же самое, что предъявлено.
    //
    // Отдано КАК ЕСТЬ и явным выбором, как всё выше. `null` — «попытка об этом молчит»
    // (сдача до появления поля, попытка, которой нечего было сводить), и это НЕ то же самое,
    // что «сведена»: молчание не имеет права читаться как чистая ветка.
    sync: a.sync ?? null,
    // ═══ ЧЕГО ЭТА ПОПЫТКА СТОИЛА ════════════════════════════════════════════════
    //
    // Четыре числа поставщика — вход, выход, чтение кэша и запись в кэш — как их записала
    // квитанция этой попытки. Их считал и клал на диск тик; ни одна дверь их до сих пор не
    // отдавала, а расход, который виден только тому, кто откроет файл, человек не видит.
    //
    // `null` — «эта попытка об этом молчит», и это НЕ ошибка: попытки, сделанные до того, как
    // квитанция научилась нести числа, обязаны молчать, а не показывать выдуманные нули.
    tokens,
    // ═══ ЧТО ЭТА ПОПЫТКА ИЗМЕНИЛА — И ЧТО ПОСЛЕ НЕЁ ИСЧЕЗЛО ══════════════════════
    //
    // Список берётся не из наблюдения за инструментами, а из ответа git на диапазон
    // «база..ветка»: правку, сделанную командой оболочки (`rm`, `sed -i`, `git rm`),
    // наблюдение за инструментами не видит по конструкции, и именно это делало прежний
    // список ложным. Тик пишет оба ключа в строку попытки на ОБОИХ исходах — и до этой
    // строки их не видел никто: вычислено и записано не то же самое, что предъявлено.
    //
    // ИСЧЕЗНУВШЕЕ — ОТДЕЛЬНЫЙ КЛЮЧ, а не статус внутри списка. Человек читает это, чтобы
    // откатить, и цена двух ошибок несимметрична: «изменён» вместо «удалён» отправляет его
    // искать файл, которого нет. Старая сторона переименования лежит здесь по той же
    // причине — с того места, где он стоит, этого пути больше нет.
    //
    // Оба счётчика перебора названы отдельно: молча урезанный список удалений — ровно та
    // несимметричная ошибка, ради которой удаления и отделили. `null` (не пустой массив) —
    // «попытка этого не знает»: пустой массив означает «спросили git, и ничего не менялось».
    files: Array.isArray(a.files) ? a.files : null,
    deletions: Array.isArray(a.deletions) ? a.deletions : null,
    filesOverflow: Number.isFinite(a.filesOverflow) ? a.filesOverflow : null,
    deletionsOverflow: Number.isFinite(a.deletionsOverflow) ? a.deletionsOverflow : null,
    // ═══ АНОМАЛИЯ ПРЕДЪЯВЛЯЕТСЯ КАК АНОМАЛИЯ ════════════════════════════════════
    //
    // Свёртка выше складывает строки одной попытки, и на ДВУХ РАЗНЫХ терминальных исходах у
    // неё нет ни правила, ни права выбирать победителя. `conflict` называет оба исхода в том
    // порядке, в каком они были записаны, и сколько строк сложилось в запись. Он считается по
    // самим строкам, а не по пометке писателя, — иначе запись, лежащая на диске с тех пор,
    // как пометки ещё не было, так и осталась бы молчаливым «готово».
    conflict: a.conflict && typeof a.conflict === 'object' ? a.conflict : null,
    // ЧТО СТОИТ И ЖДЁТ ЧЕЛОВЕКА. Билет бывает только у ИДУЩЕЙ попытки — законченная уже
    // ничего не ждёт. Назван нулём, а не опущен, по той же причине, что и поля выше:
    // карточка читает одну форму для каждой записи.
    ticket: null,
    // ═══ ЧТО ЭТА ПОПЫТКА ПЕРЕДАЛА СЛЕДУЮЩЕЙ ═════════════════════════════════════
    //
    // Тот же файл, слово в слово, который поедет в промпт следующего подхода. Двое читателей
    // одного файла — весь смысл того, что конспект лежит файлом, а не считается на каждой
    // стороне: человек видит РОВНО то, что получит работник, а не пересказ.
    //
    // Ключа нет вовсе, когда файла нет: первая попытка предшественника не имеет, и задача
    // старше этого файла — тоже. Пустая строка на этом месте была бы утверждением, что
    // передавать было нечего, а это совсем другой факт, и он пишется в сам конспект словами.
    ...(handover ? { continuationSummary: handover } : {}),
    // ═══ С КАКИМ КОНТЕКСТОМ ЭТА ПОПЫТКА УШЛА В РАБОТУ ═══════════════════════════
    //
    // Тот же файл, слово в слово, который получил работник этой попытки. Слова человека
    // едут работнику блоком данных в промпте и лежат файлом в его копии — а человеку до
    // этой строки не был виден НИ ОДИН из трёх экземпляров: строку он и так помнит, а вот
    // ответа «с чем ушёл ЭТОТ подход» у него не было.
    //
    // ЭТО ИСТОРИЧЕСКАЯ ПРАВДА ПОПЫТКИ, и она честно расходится со строкой очереди после
    // того, как человек допишет слова. Расхождение — не рассинхрон, а весь смысл поля:
    // подход сорвался с тем контекстом, который у него был, а не с сегодняшним.
    //
    // Ключа нет вовсе, когда файла нет: снимка не было, или попытка старше этого файла.
    // Пустая строка здесь утверждала бы, что человеку было что сказать и он промолчал.
    ...(snapshot ? { taskContext: snapshot } : {}),
    }
  })

  // THE ATTEMPT HAPPENING RIGHT NOW. The ledger holds only FINISHED attempts — a row is
  // appended when one ends — so a task with a worker inside it read as «подходов ещё не
  // было», and the card, the side panel and the timeline all said «Работа ещё не
  // начиналась» WHILE THE WORK WAS RUNNING. The founder opened his own running task on
  // 12.08.2026 and every one of those three surfaces denied it had started. A claimed row
  // IS an attempt in flight; it is named here once, so all three stop lying at the same
  // time. No `endedAt` and outcome `running` are what mark it unfinished — nothing
  // downstream has to guess which kind of row this is.
  if (row.status === 'claimed') {
    // Каталог ЭТОЙ попытки — собран ОДИН раз и назван, потому что спрашивают его теперь
    // двое: билет и то, что уехало в процесс вместе с ним. Выражение то же, каким каталог
    // собрал спавн; второго написания этого пути в продукте нет.
    const runDir = attemptRunDir({
      runsDir: runsDirOf(taskTreeDir({ config, deps, row }) ?? config.repoDir),
      attemptId: attemptIdFor(row.id, Number.isFinite(row.attempt) ? row.attempt : 1),
    })
    const ticket = readWaitingTicket({ runDir, fsImpl: deps.fsImpl })
    // ═══ УПРЁТСЯ ЛИ ОДОБРЕНИЕ В СТЕНУ ═══════════════════════════════════════════
    //
    // ПОЧЕМУ СШИВКА ЖИВЁТ ЗДЕСЬ, А НЕ В ХУКЕ. Класс вызова пишет хук внутри копии
    // работника, а про конверт разрешений знает демон. У хука конверта нет и права
    // зависеть от него — тоже: он обязан работать в процессе, которому ничего, кроме
    // своего каталога, не дано. Дверь карточки — единственное место, где уже есть ОБА
    // конца, и потому сшивать их можно только тут. Новой двери для этого не заводится:
    // ответ едет полем в том же ответе, который окно и так запрашивает.
    //
    // ПОЧЕМУ ИСТОЧНИКОМ СЧИТАЕТСЯ ТО, ЧТО УЕХАЛО В ПРОЦЕСС. Конверт полосы говорит,
    // что мы НАМЕРЕВАЛИСЬ запретить; аргументы запуска этой попытки — что процесс
    // ДЕЙСТВИТЕЛЬНО получил. Расходятся они не в теории: в этом дереве уже случалось,
    // что вычисленный конверт не доезжал до запуска вовсе. Правду говорит запись.
    //
    // ПОЧЕМУ НЕИЗВЕСТНОСТЬ УЕЗЖАЕТ КАК ОТСУТСТВИЕ ПОЛЯ. «Не знаем» и «безопасно» — не
    // одно и то же, и ложное успокоение хуже молчания. Наружу едет только ЗНАНИЕ; чего
    // мы не знаем, о том экран не говорит ничего.
    const wall = ticket
      ? approvalWall({
          ticketClass: ticket.class,
          spawnArgs: attemptSpawnArgs(deps, runDir),
          laneEnvelope: typeof row.lane === 'string' && row.lane !== '' ? defaultEnvelope(row.lane) : null,
        })
      : null
    attempts.push({
      attempt: Number.isFinite(row.attempt) ? row.attempt : attempts.length + 1,
      workerId: row.workerId ?? null,
      provider: null,
      startedAt: row.claimedAt ?? null,
      endedAt: null,
      outcome: 'running',
      failureReason: null,
      reasonLabel: null,
      receipt: null,
      proof: null,
      // The copy fields are written when an attempt ENDS, so a running one has none of them
      // yet. Named as nulls rather than omitted: the card reads one shape for every entry,
      // and «this key does not exist here» is how a surface starts guessing.
      base: null,
      branch: null,
      worktreePath: null,
      materialized: null,
      provisionMs: null,
      cleanup: null,
      // Идентификатор сессии тоже пишется в строку попытки, когда попытка ЗАКАНЧИВАЕТСЯ, —
      // у идущей его ещё нет, и каталог аккаунта без него не о чем сказать. Названы нулями,
      // а не опущены, по той же причине, что и поля выше: карточка читает одну форму.
      sessionId: null,
      accountDir: null,
      // Слой и файл MCP пишутся в строку попытки, когда попытка ЗАКАНЧИВАЕТСЯ, поэтому у
      // идущей их ещё нет. Названы нулями, а не опущены: карточка читает одну форму для
      // каждой записи, и «этого ключа здесь нет» — то, с чего поверхность начинает гадать.
      personalLayer: null,
      mcpConfig: null,
      memoryHarvest: null,
      // Каталог прогона дописывается квитанцией, когда попытка ЗАКАНЧИВАЕТСЯ, а вердикт
      // считается там же — у идущей попытки нет ни того, ни другого. Названы нулями, а не
      // опущены, по той же причине, что и шесть полей выше.
      runDir: null,
      parity: null,
      // Ветку сводят с вершиной у двери сдачи, то есть когда попытка ЗАКАНЧИВАЕТСЯ, — у идущей
      // ответа ещё нет. Назван нулём, а не опущен, по той же причине, что и поля выше.
      sync: null,
      // Четыре числа поставщика приезжают в квитанцию, когда попытка ЗАКАНЧИВАЕТСЯ: у идущей
      // финального кадра ещё не было, и назвать её расход можно было бы только выдумав его.
      tokens: null,
      // Список изменённого спрашивается у git, когда попытка ЗАКАНЧИВАЕТСЯ, — у идущей его
      // ещё нет, и противоречия у неё быть не может: терминальный исход только один и он
      // ещё не наступил. Названы нулями, а не опущены, по той же причине, что и поля выше.
      files: null,
      deletions: null,
      filesOverflow: null,
      deletionsOverflow: null,
      conflict: null,
      // ═══ ЧТО СТОИТ ПРЯМО СЕЙЧАС И ЖДЁТ ЧЕЛОВЕКА ═══════════════════════════════
      //
      // Опасный вызов внутри живой попытки физически стоит на месте, пока человек не
      // решит. Билет лежит в каталоге ЭТОЙ попытки, и читается он ТЕМ ЖЕ кодом, каким
      // его пишет хук, — иначе «ждут вас» на экране и файл, над которым стоит вызов,
      // были бы двумя разными мнениями об одном событии.
      //
      // Каталог собирается ТЕМ ЖЕ выражением, каким его собрал спавн: подключённый
      // проект плюс идентификатор попытки. Никакой новой двери для этого не заводится —
      // билет едет в ответе двери карточки, который окно и так запрашивает.
      ticket,
      // Стена ПЕРЕД одобрением, названная словами до нажатия. `null` — «не знаем»: ни
      // «упрётся», ни «не упрётся», и экран об этом молчит. Кнопку это поле не трогает —
      // человек вправе одобрить и увидеть отказ; наша работа предупредить, а не решить.
      approvalWall: wall && wall.state !== 'unknown' ? wall : null,
    })
  }

  const branch = `wt/${id}`
  let commits = []
  if (typeof deps.execGit === 'function') {
    try {
      // ONLY WHAT THIS TASK DID. `git log <branch>` walks the whole history, so the card
      // listed every commit the project ever had and the one commit the worker actually
      // made drowned on line one of forty. `HEAD..<branch>` is the work that exists on this
      // branch and nowhere else — which is precisely the question «что сделала эта задача».
      //
      // TWO THINGS THIS LINE USED TO GET WRONG, and both emptied the timeline of every task.
      // It read `config.repoDir`, the directory the daemon was LAUNCHED in, while the branch
      // lives in the connected project — git then exits non-zero and the catch below answers
      // an empty list. And it named `main` outright, so a project whose trunk is called
      // anything else threw on the range itself; `HEAD..` asks the tree where it stands.
      const out = deps.execGit(['log', '--oneline', `-${COMMIT_CAP}`, `HEAD..${branch}`], {
        cwd: taskBranchTree({ config, deps, row }) ?? config.repoDir,
      })
      commits = String(out || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, COMMIT_CAP)
    } catch {
      commits = []
    }
    // ═══ ЧТО БЫЛО СДЕЛАНО, КОГДА ВЕТКИ БОЛЬШЕ НЕТ ══════════════════════════════════
    //
    // Диапазон выше существует ровно до приёмки. Приёмка сливает ветку и СНОСИТ её вместе с
    // копией — и с этой секунды `HEAD..wt/<id>` не разрешается вовсе, а список коммитов у
    // ПРИНЯТОЙ работы приходил пустым. То есть пустым он был именно у той работы, историю
    // которой человек и хочет читать: у непринятой ветка на месте и вопрос отвечался сам.
    //
    // Оба конца сохранённого диапазона записаны строкой попытки заранее и переживают уборку:
    // `base` — коммит, с которого копию отрезали, `cleanup.branchTip` — вершина, которую
    // уборка записала перед удалением ветки. Тот же диапазон, теми же двумя именами, каким
    // дверь диффа показывает изменения убранной копии: два вычисления одного диапазона — это
    // ровно тот разрыв, из-за которого две поверхности рассказывают о работе разное.
    if (commits.length === 0) {
      const kept = keptCommitRange(rawAttempts)
      if (kept) {
        try {
          const out = deps.execGit(['log', '--oneline', `-${COMMIT_CAP}`, `${kept.base}..${kept.tip}`], {
            cwd: phaseCycleDir(deps) ?? config.repoDir,
          })
          commits = String(out || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, COMMIT_CAP)
        } catch {
          commits = []
        }
      }
    }
  }

  const returnedNotes = rawAttempts
    .filter((a) => a.outcome === 'returned' && typeof a.note === 'string')
    .map((a) => String(a.note).slice(0, 2000))

  // КТО ПРИНЯЛ ЭТУ РАБОТУ И КОГДА — спрошено у обеих книг приёмки, потому что приёмщиков два.
  // Читается ОДИН раз на дверь: обе книги отвечают с диска, и второе чтение ниже по телу
  // выглядело бы как ещё одно поле, а стоило бы как ещё один заход.
  const accepted = await acceptanceOf({ row, branch, attempts: rawAttempts, config, deps })
  const returns = returnRoundsOf(rawAttempts, row)

  sendJson(res, 200, {
    task: {
      id: row.id,
      title: row.title ?? null,
      lane: row.lane ?? null,
      status: row.status ?? null,
      attempt: row.attempt ?? null,
      // ═══ В КАКОМ ДЕРЕВЕ ЛЕЖИТ ЭТА РАБОТА — СКАЗАНО ЕЮ САМОЙ ═══════════════════
      //
      // На карточке это значение переключателя проекта: переставляя задачу, человек читает
      // отсюда, ОТКУДА он её переставляет. Пока дверь молчала, окно разыскивало строку по
      // спискам общей картины — «в очереди», «ждут вас», «сделано», — а ЗАНЯТОЙ строки нет ни
      // в одном из трёх: она лежит в составе, у работника, который её держит. Промах с
      // проектом замечают именно тогда, когда работа уже пошла и уткнулась в дерево без
      // нужного кода, — и ровно в этот момент карточка печатала «проект не назван» о задаче
      // со штампом, а выбор между двумя деревьями делался вслепую.
      //
      // ПРАВИЛО ТО ЖЕ САМОЕ, ЧТО У КАРТИНЫ (`projectOf`), и потому оно и импортировано, а не
      // написано здесь второй раз: строка называет свой проект или не называет ничьего, и
      // `null` — это измерение, а не приглашение подставить активный выбор окна.
      project: projectOf(row),
      // «Что обещано» and what the work IS — the two words of a task, carried to the card in
      // the shape the row holds them. The card normalizes the promise to a list, exactly as
      // the prompt builder does, so the person and the worker read the same sentences.
      description: row.description ?? null,
      acceptance: row.acceptance ?? null, // the DoR contract, «обещано»
      // ═══ СКОЛЬКО ХОДОВ ЭТОЙ РАБОТЕ ДАДУТ — СКАЗАНО ДО ЗАПУСКА, А НЕ ПОСЛЕ ══════
      //
      // Число считалось и раньше, но человеку его не показывали НИГДЕ: оно ехало на командную
      // строку работника и в строку реестра, и до карточки доезжало только задним числом,
      // сгоревшим потолком красной строки. Из-за этого целый класс ошибки был невидим —
      // обещание, написанное строкой вместо списка, читалось одним пунктом, работа выходила
      // «мелкой» и получала базовый потолок. Заметить это было нечем, пока попытка не сгорала.
      //
      // Спрашивается ТА ЖЕ функция и с теми же тремя входами, что и у тика перед запуском
      // (`turnBudgetFor` в loop.mjs): база человека, поля задачи, сгоревшие потолки из
      // реестра. Второе вычисление того же числа — это ровно тот разрыв, из-за которого
      // карточка обещала бы одно, а процесс уходил с другим.
      turnPlan: turnPlanOf(config, row, rawAttempts),
      // ═══ ВО ЧТО ОБОШЛАСЬ ЭТА ЗАДАЧА ЦЕЛИКОМ ══════════════════════════════════
      //
      // Сумма четырёх чисел по ВСЕМ её попыткам — потому что цену человек платит за задачу, а
      // не за подход: работа, доведённая с третьего раза, стоила трёх. Складывается по тем же
      // каталогам прогона, из которых каждая попытка выше берёт свои числа, так что строка
      // «итого» и строки подходов не могут разойтись — они читают одни файлы.
      //
      // ПОПЫТКА, ЧЬЯ КВИТАНЦИЯ МОЛЧИТ, ДАЁТ НОЛЬ И НЕ РОНЯЕТ СУММУ: остальные подходы от этого
      // не перестают быть измеренными. А `null` здесь — «мерить негде»: каталога прогонов нет
      // вовсе (проект не подключён, задача чужой машины), и это честное отсутствие, не ноль.
      tokens: sumRunTokens({
        runsDir: runsDirOf(taskTreeDir({ config, deps, row }) ?? config.repoDir),
        attemptIds: rawAttempts
          .map((a) => (Number.isFinite(Number(a.attempt)) ? attemptIdFor(id, Number(a.attempt)) : null))
          .filter(Boolean),
        fsImpl: deps.fsImpl,
      }),
      // ═══ ЧЕМ ОТМЕНЯЕТСЯ ПРИНЯТАЯ РАБОТА ══════════════════════════════════════
      //
      // Приёмка сливает ветку работника в основную и кладёт квитанцию слияния в колонку
      // рядом с решением. Отпечаток коммита слияния вычислялся, доезжал до колонки и там
      // умирал: читателя у него не было ни одного. Между тем это ЕДИНСТВЕННОЕ, чего человеку
      // не хватало, чтобы отменить приёмку одной командой.
      //
      // Оба значения проверены по форме ПЕРЕД тем, как попасть в ответ, из которого экран
      // соберёт команду для копирования: квитанция — данные, написанные другим процессом, а
      // данные, становящиеся командой, проверяются в тот момент, когда перестают быть
      // данными. Не прошло проверку — поля нет вовсе, и карточка о нём молчит.
      ...mergeRollbackFields(row.mergeReceipt),
    },
    attempts,
    branch,
    commits,
    returnedNotes,
    // ═══ ЧЕМ «ПРИНЯТО» ПЕРЕСТАЁТ БЫТЬ СЛОВОМ ═══════════════════════════════════════
    //
    // Приёмщик здесь — не всегда человек: терминал проводит ритуал слияния сам, по стоящему
    // добро. Пока раскрытия не было, основателю нечем было проверить приёмщика: «принято»
    // держалось на честном слове экрана. Эти два ключа — единственное, что превращает его
    // в доказательство: КТО принял, КОГДА, и что сказала квитанция слияния.
    //
    // `null` — «записи об этом нет», и окно обязано сказать это словами. Приёмщик по
    // умолчанию был бы худшим из возможных ответов: он выглядит как знание.
    accepted,
    returns,
    journal: { dispatcher: journal.dispatcher, memoryTrace: journal.memoryTrace, redirects: journal.redirects },
  })
}

/**
 * A commit NAME, and nothing that could be an option or a second argument. Both values the
 * removal record leaves behind travel into an argv, so both are checked here first: a ledger
 * row is data written by another process, and data that becomes a command is checked at the
 * moment it stops being data.
 *
 * SEVEN TO FORTY, on purpose. Forty is what the merge receipt stores from now on; seven is
 * what every receipt written before that stores, and those records are an audit log — they
 * are not rewritten to look tidier than they were. Both must stay readable, so the range
 * covers both and the screen says out loud when a name is the short, older kind.
 */
const OBJECT_NAME_RE = /^[0-9a-f]{7,40}$/i

/**
 * mergeRollbackFields(raw) → {mergeSha, mergeRepo} — the two values an acceptance can be
 * undone by, and NOTHING that could be read as an option.
 *
 * The receipt arrives as the column stores it (text) or as a reference backend hands it
 * (object). A merge is made with no fast-forward, always: the merge commit therefore has two
 * parents, the first is the trunk, and one commit name is enough to undo the whole acceptance.
 *
 * WHAT MAKES THIS A BOUNDARY. Whatever comes out of here is printed on a card for a person to
 * copy and RUN. A path or a name beginning with `-` is an option to git, not an argument, so
 * neither is allowed to leave this function; a name that is not a commit name does not leave
 * it either. File names never travel into the command at all — they are for reading with the
 * eyes, and a repository's file names are somebody else's data.
 *
 * Absent, malformed, unparseable — all answer the same way: null, and the card says nothing
 * about a merge. A dash where a fact belongs lies exactly as much as an invented one.
 */
function mergeRollbackFields(raw) {
  let receipt = raw
  if (typeof raw === 'string') {
    try {
      receipt = JSON.parse(raw)
    } catch {
      return { mergeSha: null, mergeRepo: null }
    }
  }
  if (!receipt || typeof receipt !== 'object') return { mergeSha: null, mergeRepo: null }
  const sha = typeof receipt.resultSha === 'string' ? receipt.resultSha.trim() : ''
  const repo = typeof receipt.repo === 'string' ? receipt.repo.trim() : ''
  return {
    mergeSha: sha && OBJECT_NAME_RE.test(sha) ? sha : null,
    mergeRepo: repo && !repo.startsWith('-') ? repo : null,
  }
}

/**
 * mergeReceiptWords(raw) → `{branch, sha, testsPassed, testsNote}`, или `null`.
 *
 * ТА ЖЕ КВИТАНЦИЯ, ДРУГОЙ ВОПРОС. `mergeRollbackFields` выше — граница КОМАНДЫ: из неё
 * выходит только то, что человек скопирует и запустит, и потому оттуда не выходит ничего,
 * кроме имени коммита и каталога. Здесь вопрос читательский: «что вообще сказала приёмка» —
 * ветка, итоговый коммит, гонялись ли тесты и с каким исходом. Разводить их по двум функциям
 * важнее, чем сэкономить разбор: стоит один раз пустить в командную выдачу поле, добавленное
 * ради глаз, и граница перестанет быть границей.
 *
 * ТЕСТЫ — ТРИ СОСТОЯНИЯ, А НЕ ДВА. `true` — прогон был и зелёный, `false` — был и красный,
 * `null` — прогонщика не нашлось вовсе, и тогда квитанция несёт словесную приписку почему.
 * «Не гонялись» и «не прошли» — разные предложения, и слить их в одно `false` значило бы
 * подписать зелёным то, чего никто не проверял.
 *
 * Отпечаток проверен той же формой, что и в командной границе: короткий, из семи знаков,
 * лежит в квитанциях, написанных до того, как их стали писать целиком, и эти записи —
 * журнал, а не витрина: их не переписывают, чтобы выглядели опрятнее.
 */
/**
 * turnPlanOf(config, row, attempts) → `{size, sizeLabel, cap, ceiling, escalatedFrom, signals}`.
 *
 * ОДНО ВЫЧИСЛЕНИЕ НА ДВЕ ПОВЕРХНОСТИ. Тик спрашивает `taskTurnCap` перед запуском, карточка
 * спрашивает её же — с той же базой человека, теми же полями задачи и теми же сгоревшими
 * потолками из реестра. Своя арифметика у двери была бы вторым мнением о числе, с которым
 * работник уйдёт в процесс, и разошлась бы с первым в первый же день.
 *
 * СЛОВО РАЗМЕРА ЕДЕТ ГОТОВЫМ (`sizeLabel`), по образцу `reasonLabel`: замкнутый список слов
 * живёт рядом с механизмом, который их порождает, и окно не заводит второй словарь.
 */
function turnPlanOf(config, row, attempts) {
  const plan = taskTurnCap({
    base: pipelineMaxTurns(config),
    task: row,
    burnedCaps: burnedTurnCapsOf(Array.isArray(attempts) ? attempts : []),
  })
  return { ...plan, sizeLabel: TURN_SIZE_LABELS[plan.size] ?? null }
}

function mergeReceiptWords(raw) {
  let receipt = raw
  if (typeof raw === 'string') {
    try {
      receipt = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!receipt || typeof receipt !== 'object') return null
  const sha = typeof receipt.resultSha === 'string' ? receipt.resultSha.trim() : ''
  const branchName = typeof receipt.branch === 'string' ? receipt.branch.trim() : ''
  const note = typeof receipt.testsNote === 'string' ? receipt.testsNote.trim() : ''
  const out = {
    branch: branchName || null,
    sha: sha && OBJECT_NAME_RE.test(sha) ? sha : null,
    testsPassed: typeof receipt.testsPassed === 'boolean' ? receipt.testsPassed : null,
    testsNote: note || null,
  }
  // Квитанция, не сказавшая НИЧЕГО из четырёх, — это не квитанция, а разобравшийся объект.
  return out.branch || out.sha || out.testsPassed !== null || out.testsNote ? out : null
}

/**
 * acceptanceOf({row, branch, attempts, config, deps}) → `{by, at, terminal, merge}`, или `null`.
 *
 * ДВЕ КНИГИ, ПОТОМУ ЧТО ПРИЁМЩИКОВ ДВА.
 *
 * Человек нажимает дверь окна — она человеческая по построению, единственная, и своей
 * квитанцией она заполняет колонку решения рядом со строкой задачи. Терминал проводит тот же
 * ритуал сам и кладёт квитанцию в СВОЙ журнал — тот, что скреплён хеш-цепочкой, — и в колонке
 * очереди после него не остаётся ничего.
 *
 * ПОРЯДОК ЗДЕСЬ — СОДЕРЖАНИЕ ОТВЕТА, А НЕ ВКУС. Дверь окна, проводя слияние, вызывает тот же
 * ритуал, поэтому её приёмка ТОЖЕ отмечается в журнале терминала. Спроси мы журнал первым —
 * всякое человеческое нажатие вернулось бы как «принял терминал», и поле, заведённое ради
 * проверки приёмщика, врало бы именно про того, кого проверяют. Колонка решения есть только
 * у нажатия — значит, она и отвечает первой.
 *
 * КОГДА. У человеческой приёмки минуту называет след уборки: копия сносится этой же дверью
 * сразу после слияния, `by:'approve'` отличает её от суточного обхода (`by:'sweep'`), который
 * приёмкой не является. Молчит след — берётся отметка журнала; молчат оба — `null`, и окно
 * скажет «когда — не записано» вместо правдоподобной даты.
 *
 * ЖУРНАЛ ТЕРМИНАЛА — НЕОБЯЗАТЕЛЬНЫЙ ШОВ и читается FAIL-OPEN, как всё в этой двери: демон,
 * поднятый без него, отвечает про человеческую приёмку ровно так же, а про терминальную —
 * молчанием. Отказ этого чтения не имеет права уронить карточку.
 */
async function acceptanceOf({ row, branch, attempts, config, deps }) {
  const door = mergeReceiptWords(row && row.mergeReceipt)
  if (door) {
    return { by: 'human', at: approvalCleanupAt(attempts), terminal: null, merge: door }
  }
  if (typeof deps.mergeJournal !== 'function') return null
  let hit = null
  try {
    hit = await deps.mergeJournal({ branch, projectDir: phaseCycleDir(deps) ?? config.repoDir })
  } catch {
    hit = null
  }
  if (!hit || typeof hit !== 'object') return null
  const merge = mergeReceiptWords(hit.receipt)
  if (!merge) return null
  return {
    by: 'terminal',
    at: typeof hit.at === 'string' && hit.at.trim() !== '' ? hit.at.trim() : approvalCleanupAt(attempts),
    terminal: typeof hit.terminal === 'string' && hit.terminal.trim() !== '' ? hit.terminal.trim() : null,
    merge,
  }
}

/**
 * Минута приёмки со следа уборки — и ТОЛЬКО со следа, который оставила приёмка. Суточный
 * обход закрытых копий пишет строку той же формы (`by:'sweep'`), и принять её за приёмку
 * значило бы датировать решение человека днём, когда до копии дошёл дворник.
 */
function approvalCleanupAt(attempts) {
  return lastValue(
    attempts,
    (a) => a && a.cleanup && typeof a.cleanup === 'object' && a.cleanup.by === 'approve' && a.cleanup.at,
  )
}

/**
 * returnRoundsOf(attempts, row) → `{rounds, notes}` — сколько раз работу отправляли обратно и
 * какими словами.
 *
 * КРУГ ВОЗВРАТА НИКТО НЕ ЗАПИСЫВАЕТ ОТДЕЛЬНОЙ СТРОКОЙ, и заводить её здесь поздно: у леджера
 * терминальных исхода два — «готово» и «не вышло», и «возвращено» среди них нет. Но след
 * решения человека есть, и он однозначен: попытка, закончившаяся ГОТОВО, после которой была
 * ещё одна попытка, — это работа, которую сдали и которую вернули. Своего решения очередь так
 * принять не может: сама она переставляет только упавшие. Это то же правило, по которому
 * `sma approvals suggest` отличает возврат от повтора, — второго правила для одного вопроса
 * здесь не заводится.
 *
 * СЛОВА. Колонка решения помнит ровно последнюю записку возврата: она перезаписывается на
 * каждом круге. Отдавать её как «все слова возвратов» было бы ложью о числе, поэтому число
 * приходит из леджера, а слова — те, что уцелели, и их может быть меньше, чем кругов.
 */
function returnRoundsOf(attempts, row) {
  const rows = Array.isArray(attempts) ? attempts : []
  let rounds = 0
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (rows[i] && rows[i].outcome === 'completed') rounds += 1
  }
  const note = row && typeof row.returnedNote === 'string' ? row.returnedNote.trim() : ''
  return { rounds, notes: note ? [note.slice(0, 2000)] : [] }
}

/**
 * keptCommitRange(attempts) → `{base, tip, at}` — что осталось от убранной копии, или `null`.
 *
 * ОДИН ДИАПАЗОН НА ВСЕХ, КТО СПРАШИВАЕТ ПРО УБРАННУЮ КОПИЮ. Оба конца записаны заранее и
 * переживают уборку: `base` — коммит, с которого копию отрезали, `cleanup.branchTip` —
 * вершина, записанная перед удалением ветки. Пока это выражение стояло в двух местах, дверь
 * диффа и дверь карточки могли начать отвечать про разные диапазоны одной и той же работы,
 * и заметить это было бы некому.
 *
 * ОБА ИМЕНИ ПРОВЕРЕНЫ ПО ФОРМЕ ЗДЕСЬ, до того как уедут в argv: строка леджера — данные,
 * написанные другим процессом, а данные, становящиеся командой, проверяются в тот момент,
 * когда перестают быть данными.
 */
function keptCommitRange(attempts) {
  const rows = Array.isArray(attempts) ? attempts : []
  const base = lastValue(rows, (a) => a && a.base)
  const tip = lastValue(rows, (a) => a && a.cleanup && typeof a.cleanup === 'object' && a.cleanup.branchTip)
  const at = lastValue(rows, (a) => a && a.cleanup && typeof a.cleanup === 'object' && a.cleanup.at)
  if (!base || !tip || !OBJECT_NAME_RE.test(base) || !OBJECT_NAME_RE.test(tip)) return null
  return { base, tip, at: at ?? null }
}

/**
 * The last non-empty value of a field across an attempt's rows — the rows are folded the same
 * way the card folds them, so this reads what the card would show.
 */
function lastValue(rows, pick) {
  let found = null
  for (const row of rows) {
    const v = pick(row)
    if (typeof v === 'string' && v.trim() !== '') found = v.trim()
  }
  return found
}

/**
 * GET /api/diff/:id — the plain-text diff of what the task changed, auth'd and capped
 * at DIFF_CAP. The id already passed ID_RE, so it is safe to hand to the injected git.
 *
 * THE CARD ASKS THIS QUESTION TWICE, AND IT MUST GET ONE ANSWER. The window derives its
 * «Изменения» counts from the text this door returns, while the roster's own panel counts the
 * whole branch. This door showed `git show wt/<id>` — the LAST COMMIT and nothing else — so a
 * task with three commits listed all three beside the changes of one of them, and the two
 * surfaces disagreed by construction rather than by accident. Both now read the same range
 * through the same seam (front/task-changes.mjs): base..branch, the work that exists on this
 * branch and nowhere else. Where the number moved, it moved to the true one.
 *
 * AND AFTER THE COPY IS GONE, THE WORK IS STILL THERE. Accepting the work removes the copy
 * and its branch on purpose; the commits stay in the project's tree. Git then fails on an
 * unknown revision, and this door used to answer 404 — which the card asks for on every open,
 * so a correctly merged task greeted its owner with a red transport error. The removal record
 * kept the branch tip and the attempt row kept the base it was cut from: two commit names are
 * enough to show exactly what the worker changed, long after the branch is gone.
 *
 * A missing diff is not an error, it is a sentence. Whatever happens below, the answer is 200
 * and the first line is a note a person can read.
 */
async function handleDiff({ res, params, config, deps }) {
  const id = params.id
  if (typeof deps.execGit !== 'function') return send501(res)
  // В ДЕРЕВЕ ЭТОЙ ЗАДАЧИ, а не в том, что выбрано в окне: различия ищутся там же, где лежит
  // ветка, и по тому же правилу, что у приёмки. Строку не удалось прочесть — прежний ответ.
  const cwd = taskBranchTree({ config, deps, row: await rowById(deps, id) }) ?? config.repoDir
  let text = ''
  try {
    // IN THE TREE THAT HOLDS THE BRANCH — the connected project, not the daemon's launch
    // directory. Reading the wrong tree made git fail on an unknown revision, and this door
    // answered 404 for work that was sitting on a branch one directory away.
    text = readTaskChanges(id, deps.execGit, { cwd, shape: 'patch' })
  } catch {
    text = diffOfKeptCommits(id, cwd, deps)
  }
  if (text.length > DIFF_CAP) text = text.slice(0, DIFF_CAP) + '\n… (обрезано)'
  sendText(res, 200, text)
}

/**
 * What is left to show once the branch is gone: the diff between the commit the copy was cut
 * from and the tip the removal wrote down, under a note saying where it came from. The ledger
 * is read through the SAME seam and folded by the SAME rule as the task door, so the card and
 * this door can never tell different stories about one attempt.
 *
 * @returns {string} always text — the note alone when there is nothing else to say
 */
function diffOfKeptCommits(id, cwd, deps) {
  const gone = '# диф недоступен: копия убрана'
  let rows = []
  try {
    if (typeof deps.ledger === 'function') rows = deps.ledger(id) || []
    else if (deps.ledger && typeof deps.ledger.readAttempts === 'function') rows = deps.ledger.readAttempts(id) || []
    else if (deps.ledgerDir) rows = readAttempts(deps.ledgerDir, id)
  } catch {
    rows = []
  }
  const attempts = foldAttemptRows(Array.isArray(rows) ? rows : [])
  // ОДНО ВЫРАЖЕНИЕ ДИАПАЗОНА НА ОБЕ ДВЕРИ — см. `keptCommitRange`. Дверь карточки берёт по
  // нему список коммитов принятой работы, эта — их диф; посчитай они его каждая по-своему,
  // и человек увидел бы коммиты одного диапазона рядом с изменениями другого.
  const kept = keptCommitRange(attempts)
  if (!kept) return gone
  const { base, tip, at } = kept
  let body = ''
  try {
    body = String(deps.execGit(['diff', '--stat', '-p', `${base}..${tip}`], { cwd }) || '')
  } catch {
    return `${gone}, коммиты не найдены (${base.slice(0, 7)}..${tip.slice(0, 7)})`
  }
  const note = `# копия убрана ${at ?? '—'}; показаны сохранённые коммиты ${base.slice(0, 7)}..${tip.slice(0, 7)}`
  return body.trim() === '' ? note : `${note}\n\n${body}`
}

/**
 * GET /api/events — the SSE handshake. Auth already happened in the dispatcher (like
 * every route); a query-string token is rejected there because authed() never reads the
 * query. addClient returns the SSE stream, or false at capacity → 503.
 * The stream is left open — no res.end here.
 */
function handleEvents({ res, deps }) {
  const hub = deps.hub
  if (!hub || typeof hub.addClient !== 'function') return send501(res)
  const client = hub.addClient(res)
  if (!client) return send503(res, 'too many event clients')
  // A closed tab is how EVERY subscription ends in practice, and this is the only place
  // that can hear it. Without this handler the handle sat in the hub forever: the cap
  // filled at 16 window-opens and every later window got 503 until a daemon restart —
  // the first finding of the first live QA run (11.08.2026). Write-failure reaping does
  // NOT cover this: Node does not throw synchronously on a write into a dead socket.
  if (typeof res.on === 'function') res.on('close', () => hub.removeClient(client))
  return undefined // SSE stream stays open (hint transport; truth stays in /api/state)
}

/**
 * relayPeerAnswer(res, answer) — the peer's own status and body, unmodified.
 * A JSON body is re-serialized as JSON, anything else as text; an implausible status
 * degrades to 502 rather than being echoed into a response line.
 */
function relayPeerAnswer(res, { status, body } = {}) {
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502
  if (body !== null && typeof body === 'object') return sendJson(res, code, body)
  return sendText(res, code, body === null || body === undefined ? '' : String(body))
}

/**
 * The OPTIONAL `machine` field of the three action bodies — the whole of
 * «do it on another machine». It is an IDENTIFIER matched by ID_RE, never a url: the
 * hub resolves the address from its own peers registry, so a request can never point an
 * action at an arbitrary host. Absent/empty = this machine, and that path is
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
 *     out, because a message may quote the outgoing header.
 *
 * @returns {Promise<boolean>} true when a response was already sent (proxied or refused)
 */
async function proxyToMachine(res, body, deps, path, config) {
  const m = body.machine
  if (m === undefined || m === null || m === '') return false // local machine — untouched
  // THIS MACHINE'S OWN NAME IS NOT ANOTHER MACHINE. The reading the window works from stamps
  // every local task with this daemon's own id — «self» when none is configured — and the card
  // hands that value back with the decision, honestly, exactly as it was told. Read as «somebody
  // else's machine» it took the branch below, found no federation on this daemon and answered
  // 501: measured live, the accept button could not work on ANY task of ANY daemon without
  // federation, and a founder's finished work waited on it for four days. The id compared
  // against is the SAME one /api/machines publishes as its own, so the two can never drift.
  const selfId = (config && config.machineId) ?? 'self'
  if (m === selfId || m === 'self') return false // addressed to us — run it here, as before

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
 * effort?, priority?, description?, acceptance?, machine?}. Explicit-pick: an unknown key →
 * 400 before anything runs. validateTask gates it; the id is minted `R-<epochMs>` with
 * source:'roster' (founder-explicit → DoR-exempt). Founder text becomes a task TITLE, never a
 * command.
 *
 * THE WORDS ARE OPTIONAL AND THEY STAY OPTIONAL. A task put in by its sentence alone is a
 * legal task and always was; `description` and `acceptance` are what the owner accepted from
 * the system's proposal, or typed himself, or left out entirely. The queue bounds both.
 */
async function handleEnqueue({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (
    rejectUnknownKeys(
      res,
      b,
      // `taskContext` — СНИМОК КОНТЕКСТА, который человек пишет о задаче: где лежат данные,
      // к кому идти за доступом, чего трогать нельзя. Список разрешённых полей РАСШИРЕН, а не
      // снят: всё, чего в нём нет, по-прежнему получает 400 ДО того, как что-либо выполнится.
      // Текст поедет к работнику ДАННЫМИ за забором, как и прочие его слова, — командой он не
      // становится ни здесь, ни ниже по течению. Потолок — очереди, своего дверь не пишет.
      new Set([
        'title',
        'lane',
        'provider',
        'model',
        'effort',
        // КОГО ЧЕЛОВЕК ПРОСИТ НА ЭТУ РАБОТУ. Поле необязательное, и его отсутствие означает
        // «исполнителя», а не «кого угодно»: редкий случай, когда владельцу нужен на инлайн-
        // задаче исследователь, становится тут ЯВНЫМ выбором. Стоит рядом с провайдером,
        // моделью и усилием, потому что это переопределение маршрута того же рода.
        'role',
        'priority',
        'description',
        'acceptance',
        'taskContext',
        'machine',
      ]),
    )
  ) {
    return undefined
  }
  if (await proxyToMachine(res, b, deps, '/api/enqueue', config)) return undefined
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const task = {
    id: `R-${clock()}`,
    source: 'roster',
    // WHOSE WORK THIS IS, written down at the one moment it is known — see doorProject.
    ...doorProject(config),
    title: b.title,
    lane: b.lane,
    ...(b.provider !== undefined ? { provider: b.provider } : {}),
    ...(b.model !== undefined ? { model: b.model } : {}),
    ...(b.effort !== undefined ? { effort: b.effort } : {}),
    ...(b.role !== undefined ? { role: b.role } : {}),
    ...(b.priority !== undefined ? { priority: b.priority } : {}),
    ...(b.description !== undefined ? { description: b.description } : {}),
    ...(b.acceptance !== undefined ? { acceptance: b.acceptance } : {}),
    // ОДНО ИМЯ НА ВСЕХ ШВАХ — здесь поле не переименовывается и не расфасовывается по
    // соседним: разъехавшиеся имена — самый дешёвый способ потерять провод, а этот провод
    // единственный, по которому знание человека вообще доходит до работника.
    ...(b.taskContext !== undefined ? { taskContext: b.taskContext } : {}),
  }
  let norm
  try {
    norm = validateTask(task)
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid task'))
  }
  const enq = await enqueueOrExplain(res, adapter, norm)
  if (enq.answered) return undefined // the database refused the text; the reason is already sent
  const result = enq.result
  emitSafe(deps, { event: 'task.queued', taskId: norm.id, status: 'queued' })
  // КУДА ЗАДАЧА УЕХАЛА — В ОТВЕТЕ ДВЕРИ. Штамп ставится здесь и больше нигде, и до этой
  // строки его нельзя было прочесть иначе как перечитав очередь: нажавший «Поставить» узнавал
  // о промахе только когда работник возвращался с вопросом из чужого дерева. Отдаётся то, что
  // РЕАЛЬНО записано (`norm.project`), а не то, что дверь собиралась записать: у гейта есть
  // право на своё мнение, и ответ обязан говорить о строке, а не о намерении.
  sendJson(res, 200, { ok: true, id: result.id, coalesced: !!result.coalesced, project: norm.project ?? null })
}

/**
 * mergeRefusal(merge) → `{reasonCode, reason}` — WHY the acceptance did not go through, in
 * the words the person who pressed the button reads.
 *
 * IT EXISTS BECAUSE `ok:false` IS NOT AN ANSWER. This door used to hand back a bare false:
 * a merge conflict, a branch that is no longer in the tree, a red run on the merge result and
 * two terminals merging at the same second all arrived at the window identical — and they call
 * for four different actions from the person. A live acceptance session wrote it down in the
 * founder's own words: «нажалась и ничего не сделала».
 *
 * NOTHING IS INVENTED HERE. The merge ritual already distinguishes these cases — it returns a
 * soft-deny with the holder of the slot, a `testsPassed:false`, or git's own message — and this
 * function only carries what it said into the vocabulary a screen can show. When the class is
 * not recognised the unknown is NOT smoothed over into a polite phrase: the door says that the
 * merge did not go through AND repeats what git said, capped to one line, so an unclassified
 * failure is a lead rather than a dead end.
 *
 * The soft-deny branch hands back the ritual's OWN sentence rather than a retelling: that
 * sentence names the terminal holding the slot and the command that frees a hung one, and a
 * paraphrase would drop both.
 *
 * И ЕЩЁ ОДНО, ПОВЕРХ ЛЮБОГО КЛАССА: В КАКОМ СОСТОЯНИИ ОСТАЛОСЬ ОБЩЕЕ ДЕРЕВО. Ритуал слияния
 * откатывает незафиксированное слияние на КАЖДОМ отказе — конфликт, красный прогон, непригодная
 * среда, — и только когда сам откат не удался, возвращает `unfinishedMerge` вместе с командой
 * выхода. До этого хвоста ни то, ни другое до экрана не доезжало: человек читал «конфликт в двух
 * файлах», нажимал ещё раз, получал «в рабочем дереве есть несохранённые правки» — и шёл
 * выяснять руками, что общая копия стоит в незавершённом слиянии. Полусведённое общее дерево —
 * самая дорогая из всех неназванных вещей в этом файле, поэтому оно называется на любом отказе,
 * а не только на том, который его породил.
 *
 * @param {object|null|undefined} merge — whatever the merge verb returned
 * @returns {{reasonCode: string, reason: string}}
 */
export function mergeRefusal(merge) {
  const m = merge && typeof merge === 'object' ? merge : {}
  const said = refusalClass(m)
  if (!m.unfinishedMerge) return said
  const exit = typeof m.howToClear === 'string' && m.howToClear.trim() ? m.howToClear.trim() : null
  return {
    ...said,
    reason:
      `${said.reason}; ⚠ ОБЩЕЕ ДЕРЕВО ОСТАЛОСЬ В НЕЗАВЕРШЁННОМ СЛИЯНИИ` +
      (exit ? ` — ${exit}` : ' — откатить его не удалось, и команда выхода не названа'),
  }
}

/** Класс отказа — то, что решает, ЧТО человеку делать дальше. Хвост о дереве добавляет звонящий. */
function refusalClass(m) {
  if (m.softDenied) {
    const said = typeof m.override === 'string' && m.override.trim() ? m.override : null
    const holder = m.holder && m.holder.by ? m.holder.by : 'другой терминал'
    return {
      reasonCode: 'merge_busy',
      reason: said ?? `слияние уже идёт (${holder}) — дождитесь его конца и нажмите снова`,
    }
  }

  // A RED RUN, WHATEVER THE MERGE FLAG SAYS. Said apart from every failure below on purpose —
  // the person's next step here is the tests, not the branch and not the tree.
  //
  // The condition used to demand `merged === true` as well, because back then the ritual
  // committed the merge FIRST and ran the tests on it afterwards; a red run therefore always
  // arrived with the branch already in the tree. The ritual now decides before it records, so
  // an honest refusal arrives as {merged:false, testsPassed:false} — and against the old
  // condition it would have missed this branch entirely and reached the person as a nameless
  // failure. One condition covers both shapes: a red run IS the cause, and which of the two
  // shapes carried it does not change what the person has to do next.
  // СРЕДА, А НЕ ТЕСТЫ, И ЭТО ПЕРВЫЙ ВОПРОС, А НЕ ОТТЕНОК КРАСНОГО. Гейт слияния смотрит на
  // пригодность дерева ДО прогона; когда смотреть оказалось не на что — склад зависимостей
  // основного дерева пуст (31.08.2026, трижды за сутки) — прогона не было вовсе, и
  // `testsPassed` остаётся null. Сказать здесь «тесты красные» значило бы послать человека
  // искать регрессию в ветке работника, пока чинить надо среду, одну на всех.
  if (m.envBroken) {
    const said = typeof m.reason === 'string' && m.reason.trim() ? m.reason.trim() : ''
    return {
      reasonCode: 'env_broken',
      reason: said || 'слияние не выполнено: среда прогона сломана — тесты не запускались, чинится в основном дереве',
    }
  }

  // КАКОЙ ТЕСТ И ПОЧЕМУ — ЗДЕСЬ, А НЕ В ЧУЖОМ РАССЛЕДОВАНИИ. Замерено 31.08.2026: отказ
  // приехал одной фразой про красные тесты, приёмщик пошёл искать причину руками — и нашёл
  // вовсе не тесты. Ритуал теперь называет упавший тест и первые строки причины; дверь
  // доводит их до глаз, потому что квитанцию на карточке никто не разворачивает. Имя не
  // выдумывается: прогонятель, промолчавший о нём, назван промолчавшим — по правдоподобному
  // имени человек пошёл бы чинить не тот тест.
  if (m.testsPassed === false) {
    const named = typeof m.failedTest === 'string' && m.failedTest.trim() ? m.failedTest.trim() : null
    const detail =
      typeof m.failureDetail === 'string' && m.failureDetail.trim()
        ? m.failureDetail
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .join(' · ')
        : null
    return {
      reasonCode: 'tests_red',
      reason:
        'слияние не выполнено: тесты на сведённом результате красные — работа осталась ждать вас. ' +
        (named ? `Упал: ${named}` : 'Имя упавшего теста прогонятель не назвал — смотрите вывод прогона') +
        (detail ? `. Причина: ${detail}` : ''),
    }
  }

  const said = typeof m.message === 'string' ? m.message.trim() : ''
  const firstLine = said.split('\n')[0].slice(0, 200)

  // КОНФЛИКТ, НАЗВАННЫЙ САМИМ РИТУАЛОМ — по именам файлов и по их числу. Ритуал спрашивает
  // git, ЧТО осталось неразведённым, и кладёт список в ответ; до этой ветки человек получал
  // «конфликт с основным деревом» без единого имени и КАЖДЫЙ РАЗ выяснял состав сам (замерено
  // 31.08.2026 на пяти приёмках подряд). Если часть конфликта ритуал развёл механически —
  // сказано и это: иначе автоматический развод неотличим от слияния, где спора не было.
  if (m.conflict === true && Array.isArray(m.conflictFiles) && m.conflictFiles.length > 0) {
    const shown = m.conflictFiles.slice(0, MERGE_CONFLICT_FILES_SHOWN)
    const rest = Math.max(0, m.conflictFiles.length - shown.length)
    const n = Number.isFinite(m.conflictCount) ? m.conflictCount : m.conflictFiles.length
    // «УЖЕ РАЗВЕДЕНО» БЫЛО НЕПРАВДОЙ РОВНО ЗДЕСЬ. Ритуал разводит механическое в рабочем
    // дереве, а потом, не досчитавшись развода остального, ОТКАТЫВАЕТ слияние целиком — вместе
    // с этим разводом. Человек читал «механическое уже разведено» и понимал это как работу,
    // которая уже лежит в дереве и которую он унаследует; в дереве не лежало ничего. Тот же
    // верб сведения (`sync-branch`) называет судьбу разведённого двумя разными фразами именно
    // потому, что одна фраза на два исхода — враньё о состоянии дерева. Здесь говорится то, что
    // верно при любом исходе отката: эти файлы разводятся САМИ, и в работу человека не входят.
    const settled = Array.isArray(m.conflictResolved) && m.conflictResolved.length
      ? ` (механическое разводится САМО и рук не требует: ${m.conflictResolved.map((r) => r && r.file).filter(Boolean).join(' · ')})`
      : ''
    // …А ПОЧЕМУ ОСТАЛЬНОЕ НЕ РАЗВЕЛОСЬ — вопрос, с которого начинается КАЖДЫЙ разбор: файл,
    // похожий на механический (карта замера, README), в списке спора выглядит как поломка
    // развода, пока не сказано, что стороны пересобрались в РАЗНОЕ или что правили существующие
    // строки. Ритуал это уже выяснил и положил в `conflictNotes`; до этой строки оговорки
    // доезжали только до квитанции слияния, то есть не до того, кто нажимает «принять».
    const notes = (Array.isArray(m.conflictNotes) ? m.conflictNotes : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.trim().slice(0, 160))
    const why = notes.length
      ? `; почему не развелось: ${notes.slice(0, 2).join(' | ')}${notes.length > 2 ? ` … ещё ${notes.length - 2}` : ''}`
      : ''
    return {
      reasonCode: 'conflict',
      reason:
        `ветка работника не сливается: конфликт в ${n} файл(ах) — ` +
        `${shown.join(' · ')}${rest ? ` … ещё ${rest}` : ''}${settled}; ` +
        `остальное разводит человек${why}`,
    }
  }
  if (/CONFLICT|merge conflict|fix conflicts|Automatic merge failed/i.test(said)) {
    return {
      reasonCode: 'conflict',
      reason: 'ветка работника не сливается: конфликт с основным деревом — правки разводит человек',
    }
  }
  if (/not something we can merge|did not match any|unknown revision|no-branch|not a valid object|pathspec/i.test(said)) {
    return {
      reasonCode: 'branch_missing',
      reason: 'ветки задачи нет в этом дереве — её уже убрали, либо работа шла в другой рабочей копии',
    }
  }
  if (/local changes|would be overwritten|unstaged|uncommitted|cannot merge.*index|Please commit/i.test(said)) {
    return {
      reasonCode: 'tree_dirty',
      reason: 'в рабочем дереве есть несохранённые правки — слияние их бы затёрло, уберите их и нажмите снова',
    }
  }

  return {
    reasonCode: 'merge_failed',
    reason: firstLine ? `слияние не прошло: ${firstLine}` : 'слияние не прошло, и ритуал не сказал ни слова о причине',
  }
}

/**
 * POST /api/approve — the HUMAN-only approve path (it exists ONLY behind the token the
 * founder holds; the daemon never calls it). Body {taskId, machine?}. CAS the row
 * awaiting_approval→approving (claim generation), run the EXISTING serialized merge verb
 * on wt/<taskId> LOCALLY (never a push), then CAS to approved on green / back to
 * awaiting_approval on red with the merge receipt. A lost CAS race → 409.
 *
 * OR, when the id carries the reserved PROJECT_MIGRATION_TARGET_PREFIX, → the connected
 * project's per-file migration applier. Same door, same token, same «a human said yes to
 * exactly this one thing» meaning — and the route table did not move. Nothing about the task
 * path is reached on that branch: no CAS, no merge verb, no branch name.
 */
async function handleApprove({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['taskId', 'machine']))) return undefined
  if (await proxyToMachine(res, b, deps, '/api/approve', config)) return undefined
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
  // ГДЕ ЭТУ ВЕТКУ ИСКАТЬ — прочитано ОДИН раз, до слияния, из адресов ЗАДАЧИ и ЕЁ проекта.
  // Строка читается здесь, а не берётся из CAS выше: CAS двигает состояние и о проекте не
  // знает ничего.
  const approvedRow = await rowById(deps, taskId)
  const approvedTree = taskBranchTree({ config, deps, row: approvedRow })
  // ЕСТЬ ЛИ ВООБЩЕ ЧТО СЛИВАТЬ. Строка, ни одна попытка которой не назвала ветки, работала
  // без копии — слияние `wt/<id>` для неё не «не удалось», а бессмысленно: git отвечает «did
  // not match any», карточка возвращается в «ждут решения», и нажатие не может сработать НИ
  // ПРИ КАКИХ условиях.
  //
  // ЧЕЙ ЭТО ТЕПЕРЬ СЛУЧАЙ. Раньше — весь класс документарных стадий: они писали прямо в дерево
  // проекта, и приёмке нечего было сливать. С 31.08.2026 документарная ступень получает копию и
  // ветку наравне с кодовой, поэтому её артефакты входят в дерево ИМЕННО этим слиянием. Проверка
  // остаётся — под ней строки, поставленные ДО починки, и любая попытка, отказанная раньше
  // провизии: их принятие не должно упираться в ветку, которой никто не заводил.
  //
  // Признак берётся ПОЛОЖИТЕЛЬНЫЙ: должна быть хотя бы одна строка попытки, и ни одна из них
  // не назвала ветки. Пустой журнал ничего не доказывает — на нём поведение остаётся прежним,
  // иначе работа кодом при потерянном журнале уехала бы в «принято» без единого слияния.
  const attemptRows = (() => {
    try {
      if (deps.ledger && typeof deps.ledger.readAttempts === 'function') return deps.ledger.readAttempts(taskId) || []
      if (deps.ledgerDir) return readAttempts(deps.ledgerDir, taskId) || []
    } catch {
      /* журнал недоступен — доказательств нет, ведём себя как раньше */
    }
    return []
  })()
  const nothingToMerge =
    attemptRows.length > 0 && !attemptRows.some((r) => r && typeof r.branch === 'string' && r.branch.trim() !== '')
  let merge
  if (nothingToMerge) {
    merge = {
      merged: true,
      nothingToMerge: true,
      message: 'документарная стадия: ветки не было ни в одной попытке — сливать нечего',
    }
  } else {
    try {
      // IN THE TREE THAT HOLDS THE BRANCH — the connected project, and the served tree only when
    // nothing is connected. The same resolution the neighbouring doors of this very card (the
    // commit log, the diff) already use, so the card cannot read one tree and write another.
    //
    // This line used to hand over the directory the daemon was LAUNCHED in. A live press found
    // it: on a machine where the launch directory was not the served tree, «Одобрить» answered
    // ok:false with no merge at all — the worker's branch simply did not resolve there — while
    // the identical press on a checkout where the two happened to coincide merged fine. A person
    // saw a button that «нажалась и ничего не сделала».
    //
    // И ЭТО ТОЖЕ ОКАЗАЛОСЬ НЕ ТЕМ ДЕРЕВОМ. «Подключённый проект» — это то, на что человек
    // СМОТРИТ, а ветка лежит там, где работа ШЛА. Замерено 31.08: приёмка готовой работы
    // продукта при подключённой мастерской вернула `branch_missing` о ветке, которая была на
    // месте. Теперь дерево называют адреса задачи и её проекта; выбранное в окне остаётся
    // ответом только для строки, которая своего проекта не назвала.
      merge = await deps.verbRunner({ branch, by: 'roster', cwd: approvedTree ?? deps.repoDir })
    } catch (err) {
      merge = { merged: false, message: String((err && err.message) || 'merge failed') }
    }
  }
  const green = !!(merge && (merge.merged === true || merge.ok === true) && merge.testsPassed !== false)

  await casTransition(deps.casExec, {
    table,
    id: taskId,
    from: 'approving',
    to: green ? 'approved' : 'awaiting_approval',
    ...(merge && merge.receipt ? { extra: { merge_receipt: JSON.stringify(merge.receipt) } } : {}),
  })

  // ═══ THE COPY THE WORK WAS DONE IN GOES AWAY WITH THE APPROVAL, AND ONLY WITH IT ═══
  //
  // Merged work needs no copy: the branch is in the main tree, and every task that was ever
  // accepted used to leave its directory and its branch on disk forever. A RED merge leaves
  // both alone on purpose — the work may still be finished in that copy, and the row goes
  // back to awaiting_approval.
  //
  // A SEPARATE COLLABORATOR, not `deps.verbRunner` above: that one is the merge ritual and
  // this one removes a directory. A single generic runner here would be a request path that
  // can name a command; `worktreeCleanup({taskId, by})` has nothing to name. Same posture as
  // `updateRunner`, and for the same reason.
  //
  // THE APPROVAL IS THE TRUTH, THE CLEANUP IS ITS CONSEQUENCE. A failed removal never turns
  // `merged:true` into a lie — it travels in `cleanup.reason`, because a person has to LEARN
  // that something is still on disk rather than deduce it from a missing line.
  // ═══ ЧТО РАБОТНИК УЗНАЛ, ЕДЕТ В КОРПУС РАНЬШЕ, ЧЕМ КОПИЯ ИСЧЕЗНЕТ ═══════════════
  //
  // Урок работника лежит черновиком ВНУТРИ копии, а записка о подходе — только в журнале
  // попытки. На проекте, чей каталог правил вне git (так живёт и сам этот продукт), слияние
  // ветки не приносит корпусу НИЧЕГО, а уборка ниже сносит каталог копии вместе с уроком.
  // Приёмка — единственный момент, когда обе половины памяти ещё существуют и уже приняты.
  //
  // ПОРЯДОК ЗДЕСЬ — СОДЕРЖАНИЕ ГАРАНТИИ, А НЕ ВКУС: копия перестаёт быть ценностью только
  // после того, как урок спасён. Поэтому сбор стоит выше уборки, а при провале на
  // игнорируемом корпусе он ПРОСИТ уборку не начинаться (`skipCleanup`) и называет причину.
  //
  // ОТДЕЛЬНАЯ ЗАВИСИМОСТЬ, как `worktreeCleanup` и `updateRunner`: дверь называет задачу, а
  // не команду. И, как у них, неудача сбора не превращает `merged:true` в ложь — она едет
  // в ответ, потому что человек обязан УЗНАТЬ судьбу урока, а не вывести её из молчания.
  let harvest = null
  if (green && typeof deps.memoryHarvest === 'function') {
    try {
      const h = (await deps.memoryHarvest({ taskId })) || {}
      harvest = {
        ok: h.ok === true,
        mode: h.mode ?? null,
        copied: Array.isArray(h.copied) ? h.copied : [],
        applied: Array.isArray(h.applied) ? h.applied : [],
        drafted: Array.isArray(h.drafted) ? h.drafted : [],
        refused: Array.isArray(h.refused) ? h.refused : [],
        ...(h.reason ? { reason: h.reason } : {}),
        ...(h.skipCleanup === true ? { skipCleanup: true } : {}),
      }
    } catch (err) {
      // Исключение из сбора — тоже ответ, и ответ осторожный: копию в этом случае не трогаем,
      // потому что состояние урока неизвестно, а неизвестность не повод удалять его
      // единственный экземпляр.
      harvest = { ok: false, mode: null, copied: [], applied: [], drafted: [], refused: [], reason: String((err && err.message) || err), skipCleanup: true }
    }
  }
  const harvestBlocksCleanup = harvest !== null && harvest.skipCleanup === true

  let cleanup = null
  if (green && harvestBlocksCleanup) {
    cleanup = { removed: false, removedPath: null, removedBranch: null, reason: `сбор памяти не удался — копия сохранена: ${harvest.reason ?? 'причина не названа'}` }
  } else if (green && typeof deps.worktreeCleanup === 'function') {
    try {
      // В ТОМ ЖЕ ДЕРЕВЕ, где только что искали ветку: копия лежит рядом с ней, и уборка,
      // спросившая другой проект, честно не нашла бы её и оставила бы каталог на диске.
      const r = (await deps.worktreeCleanup({ taskId, by: 'approve', cwd: approvedTree })) || {}
      cleanup = {
        removed: r.removed === true,
        removedPath: r.removedPath ?? null,
        removedBranch: r.removedBranch ?? null,
        ...(r.reason ? { reason: r.reason } : {}),
      }
    } catch (err) {
      cleanup = { removed: false, reason: String((err && err.message) || err) }
    }
  }

  // The status is the QUEUE status the row now holds — the vocabulary the screen patches
  // with. «approved» and «returned» are names of DOORS, not of states: after this door the
  // row is completed or it is failed, and that is what travels.
  emitSafe(deps, { event: green ? 'task.approved' : 'task.failed', taskId, status: green ? 'completed' : 'failed' })
  emitSafe(deps, { event: 'worker.presence', taskId })
  // A REFUSAL CARRIES ITS CAUSE OR IT IS NOT A REFUSAL — the code for a screen to branch on
  // and the sentence for a person to read, both derived from what the ritual actually said.
  // A green outcome carries neither: success does not explain itself.
  const refusal = green ? null : mergeRefusal(merge)
  sendJson(res, 200, {
    ok: green,
    taskId,
    merged: green,
    ...(merge && merge.receipt ? { receipt: merge.receipt } : {}),
    ...(merge && merge.softDenied ? { softDenied: true } : {}),
    ...(refusal ? { reasonCode: refusal.reasonCode, reason: refusal.reason } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(harvest ? { memoryHarvest: { ok: harvest.ok, mode: harvest.mode, copied: harvest.copied, applied: harvest.applied, drafted: harvest.drafted, refused: harvest.refused, ...(harvest.reason ? { reason: harvest.reason } : {}) } } : {}),
  })
}

/**
 * POST /api/return — return-with-comment. Body {taskId, note, title?, lane?, machine?,
 * to_stage?} (note <= 2000). CAS awaiting_approval→returned — or failed→returned for a row
 * that is PARKED waiting for a person (see returnCas) — then re-enqueue with source:'return'
 * + the note + attempt+1, under the SAME task id. The note is DATA. A lost race → 409.
 *
 * `to_stage` — ЕДИНСТВЕННОЕ ОБРАТНОЕ РЕБРО ГРАФА ФАЗ, и оно ведёт из рисования в
 * планирование. Смотрящий на чертёж видит не «плохо нарисовано», а «в плане дыра»: экрана,
 * который надо нарисовать, в плане нет вовсе. Переделывать чертёж по дырявому плану — значит
 * получить второй такой же. Поэтому чертёж закрывается возвратом, а в очередь встаёт НОВАЯ
 * задача планирования этой фазы, и причина словами едет ей ДАННЫМИ (`note`), как всякий текст
 * человека в этом продукте. Никакого другого адресата у ребра нет и никакого другого истока:
 * «вернуть в разговор», «вернуть в исполнение» — это не возврат, а новая стадия, и её ставят
 * своей дверью.
 */
async function handleReturn({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const v = body.value || {}
  if (rejectUnknownKeys(res, v, new Set(['taskId', 'note', 'title', 'lane', 'machine', 'to_stage']))) return undefined
  if (await proxyToMachine(res, v, deps, '/api/return', config)) return undefined
  const taskId = v.taskId
  if (!taskId || typeof taskId !== 'string' || !ID_RE.test(taskId)) return send400(res, 'invalid taskId')
  const note = v.note == null ? '' : String(v.note)
  if (note.length > 2000) return send400(res, 'note exceeds 2000 chars')
  if (typeof deps.casExec !== 'function' || !deps.adapter || typeof deps.adapter.enqueue !== 'function') {
    return send501(res)
  }
  // АДРЕСАТ ПРОВЕРЯЕТСЯ ДО ЛЮБОГО CAS. Отказ после закрытия строки оставил бы работу закрытой
  // и никуда не поставленной — потерянной ровно тем действием, которое должно было её спасти.
  const toStage = v.to_stage === undefined || v.to_stage === null ? null : v.to_stage
  if (toStage !== null && toStage !== BACK_EDGE_TO_STAGE) {
    return send400(res, `to_stage: единственное обратное ребро ведёт в "${BACK_EDGE_TO_STAGE}"`)
  }

  // ЧТО СТРОКА ГОВОРИЛА О СЕБЕ ДО ВОЗВРАТА. Читается ЗДЕСЬ, до CAS, по двум причинам: адресату
  // обратного ребра нужен конверт прежней строки, чтобы отказать ДО закрытия работы, — и
  // конверт этот всё равно нужен ниже, чтобы возвращённая задача осталась собой.
  //
  // A RETURN IS A STATE OF THE SAME TASK, so the row it puts back is called by the task's own
  // NAME. This door used to mint a heading out of the routing identifier whenever the body
  // carried none, and the screen then drew that identifier where a person expects a name —
  // beside the previous row, which a durable queue keeps. The name is already in the door's
  // hands: the very rows it reads for the attempt number carry it. The marker that this is a
  // return is `source`, and it is already set; a heading is a SHOWCASE field and owes the
  // person a name. The floor is the bare id (the queue refuses an empty title), never a
  // minted phrase claiming to be one.
  let prevAttempt = 1
  let nameFromRow = ''
  let ownProject = {}
  let prevRow = null
  let allRows = []
  try {
    allRows = await deps.adapter.list({})
    const mine = allRows.filter((r) => r && r.id === taskId)
    // THE NUMBER COMES FROM THE LAST WORD ABOUT THE TASK. The rows of a returned task pile up in
    // a durable queue, and the first one handed back can be the attempt BEFORE the one standing
    // for approval — a second return in a row then mints a number the task has already used, and
    // two rows claim to be the same attempt. Same exported queue rule as the card door above.
    // The name chain below stays as it is: it looks across ALL rows on purpose, because the row
    // holding the real name may well be an older one.
    prevRow = latestRowPerId(mine)[0] || null
    if (prevRow && Number.isFinite(prevRow.attempt)) prevAttempt = prevRow.attempt
    const named = mine.find((r) => realTitleOf(r, taskId))
    if (named) nameFromRow = realTitleOf(named, taskId)
    // WHOSE WORK IT IS DOES NOT CHANGE BECAUSE IT CAME BACK — see inheritedProject.
    ownProject = inheritedProject(mine)
  } catch {
    /* fail-open — default to attempt 1 → requeue as attempt 2, the name falls back to the id */
  }
  const prevData =
    prevRow && prevRow.data && typeof prevRow.data === 'object' && !Array.isArray(prevRow.data) ? prevRow.data : null

  if (toStage !== null) {
    // ИСТОК РЕБРА — ТОЛЬКО РИСОВАНИЕ, и спрашивается это у КОНВЕРТА строки, а не у её названия:
    // название человек может набрать руками, конверт ставит дверь.
    if (!prevData || prevData.stage !== DESIGN_STAGE) {
      return send400(res, `to_stage: назад в планирование возвращается только работа ступени "${DESIGN_STAGE}"`)
    }
    const phase = String(prevData.phase ?? '')
    if (!PHASE_RE.test(phase)) return send400(res, 'invalid phase')
    // ТЕМ ЖЕ ПРАВИЛОМ, ЧТО У ДВЕРИ ДИСПАТЧА: два работника, пишущих один и тот же план фазы из
    // двух каталогов, — это не «дважды поставили», а два расходящихся плана.
    if (liveStageRow(allRows, toStage, phase)) {
      return send409(res, `stage "${toStage}" of phase "${phase}" is already running`)
    }

    const table = deps.taskTable || 'sma_task_attempts'
    const cas = await returnCas(deps, { table, taskId, note })
    if (!cas.won) return send409(res, 'return race lost (already handled)')

    const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
    const task = {
      id: `S-${clock()}`,
      source: 'return',
      ...ownProject,
      title: stageCommand(toStage, phase),
      lane: STAGE_LANE,
      data: { kind: stageKind(toStage), stage: toStage, phase },
      note,
    }
    let norm
    try {
      norm = validateTask(task)
    } catch (err) {
      return send400(res, String((err && err.message) || 'invalid task'))
    }
    const enq = await enqueueOrExplain(res, deps.adapter, norm)
    if (enq.answered) return undefined
    // СОБЫТИЙ НЕ УБАВИЛОСЬ, и каждое сказано О СВОЕЙ строке: чертёж ЗАКРЫТ возвратом (он в
    // очередь не встал, и «queued» о нём было бы неправдой), а поставлена — другая задача.
    emitSafe(deps, { event: 'task.returned', taskId, status: 'returned' })
    emitSafe(deps, { event: 'phase.stage', taskId: norm.id, phase, stage: toStage })
    emitSafe(deps, { event: 'task.queued', taskId: norm.id, status: 'queued' })
    return sendJson(res, 200, { ok: true, taskId, attempt: prevAttempt, stageTaskId: norm.id, phase, stage: toStage })
  }

  const table = deps.taskTable || 'sma_task_attempts'
  const cas = await returnCas(deps, { table, taskId, note })
  if (!cas.won) return send409(res, 'return race lost (already handled)')

  // Re-queue the returned task for another attempt with the founder's comment.
  //
  // КОНВЕРТ И ПОЛОСА — ПРЕЖНЕЙ СТРОКИ, И ЭТО НЕ УКРАШЕНИЕ. Очередь при повторной постановке
  // под тем же номером не дополняет запись, а ПЕРЕЗАПИСЫВАЕТ её целиком (строка уже не
  // «queued»), поэтому всё, чего дверь не назвала, задача теряет молча. Дверь называла только
  // имя и заметку — и документарная работа возвращалась в очередь БЕЗ конверта стадии и в
  // полосе «prod»: тик больше не знал, каким гейтом её судить, а полосу ей выдавали чужую.
  // Конвертом владеет дверь; вызывающие его не трогают и трогать не могут — ключа тела у него
  // нет, потому что это не мнение человека, а факт о задаче.
  //
  // СЛОВА ЗАДАЧИ ЕДУТ ПО ТОЙ ЖЕ ПРИЧИНЕ, И ЭТО ТОТ ЖЕ ДЕФЕКТ, ТОЛЬКО ДОРОЖЕ. Обещание,
  // описание и оценка перезаписью стирались молча — и работа возвращалась в очередь БЕЗ
  // условий приёмки: работник второй попытки не знал, чем она закрывается, а карточка
  // показывала пустоту на месте того, что человек написал. Хуже того, ровно по этим полям
  // считается потолок ходов, так что нажатие «поднять потолок» стирало признаки размера —
  // единственный путь «повторить ТУ ЖЕ строку» повторял её огрызок.
  const requeue = await enqueueOrExplain(res, deps.adapter, {
    id: taskId,
    source: 'return',
    ...ownProject,
    title: (typeof v.title === 'string' && v.title.trim()) || nameFromRow || taskId,
    lane: v.lane || (prevRow && prevRow.lane) || 'prod',
    ...(prevData ? { data: prevData } : {}),
    // РОЛЬ — ТРЕТИЙ СЛУЧАЙ ТОГО ЖЕ ДЕФЕКТА, и он дороже обоих предыдущих. Конверт и слова
    // терялись перезаписью молча; роль терялась так же — но она ЕДИНСТВЕННОЕ слово, которым
    // человек называет исполнителя работы. Вторая попытка работы, названной поимённо,
    // приезжала без имени, `roleWanted` отвечал «исполнитель», и работа шла под чужим
    // описанием агента: та самая тихая подмена, на которую маршрут в открытую отвечает
    // `role_unavailable`, обойдённая не отказом, а забывчивостью. Ключа тела у роли здесь нет
    // по той же причине, что у конверта: возврат — это состояние ТОЙ ЖЕ работы, а сменить
    // исполнителя значит поставить другую, своей дверью.
    ...(prevRow && prevRow.role ? { role: prevRow.role } : {}),
    ...(prevRow && prevRow.acceptance != null ? { acceptance: prevRow.acceptance } : {}),
    ...(prevRow && prevRow.description != null ? { description: prevRow.description } : {}),
    ...(prevRow && Number.isFinite(prevRow.storyPoints) ? { storyPoints: prevRow.storyPoints } : {}),
    note,
    attempt: prevAttempt + 1,
  })
  if (requeue.answered) return undefined // the database refused the note; the reason is already sent

  emitSafe(deps, { event: 'task.returned', taskId, status: 'queued' })
  emitSafe(deps, { event: 'task.queued', taskId, status: 'queued' })
  sendJson(res, 200, { ok: true, taskId, attempt: prevAttempt + 1 })
}

/**
 * ═══════ ДВА СОСТОЯНИЯ, ИЗ КОТОРЫХ РАБОТА ВОЗВРАЩАЕТСЯ В ОЧЕРЕДЬ ═══════════════════════════
 *
 * `awaiting_approval` — работа СДЕЛАНА и человек говорит «переделай». Это исходный случай
 * двери, и он остаётся первым: гонку за уже принятую работу проигрывать надо здесь.
 *
 * `failed` — работа ВСТАЛА и ждёт человека. Такое бывает ровно у одного конца во всей
 * таксономии — упор в потолок ходов (см. AWAITS_A_PERSON): повтора за ним нет по устройству,
 * поэтому строка стоит, пока человек не решит. Его решение «поднять потолок» — это ровно
 * «поставь ту же работу снова»: потолок поднимает не эта дверь, а реестр попыток, где записан
 * сгоревший, и `taskTurnCap` у следующего запуска обязан выдать строго больший. Значит двери
 * нечего добавлять к тому, что она уже умеет, — ей нужно перестать отказывать строке, которая
 * стоит. До этого нажатие «Вернуть» на такой карточке отвечало 409 и не делало НИЧЕГО: кнопка
 * была, провода за ней не было.
 *
 * НОМЕР ЗАДАЧИ ТОТ ЖЕ, И ЭТО ВЕСЬ СМЫСЛ. Подъём потолка привязан к номеру: работа, поставленная
 * заново под новым номером, начинает со дна и упрётся в ту же стену. Поэтому «поднять потолок»
 * не может быть дверью постановки — только этой.
 *
 * ПОРЯДОК, А НЕ СПИСОК. CAS сравнивает ОДНО ожидаемое состояние, поэтому попыток две, и вторая
 * идёт только после проигрыша первой: строка не может быть в двух состояниях сразу, а проигрыш
 * обеих — это честный 409 «уже разобрались без вас».
 *
 * @returns {Promise<{won:boolean, rows:any[]}>}
 */
async function returnCas(deps, { table, taskId, note }) {
  const extra = { returned_note: note }
  const fromApproval = await casTransition(deps.casExec, {
    table,
    id: taskId,
    from: 'awaiting_approval',
    to: 'returned',
    extra,
  })
  if (fromApproval.won) return fromApproval
  return casTransition(deps.casExec, { table, id: taskId, from: 'failed', to: 'returned', extra })
}

/**
 * realTitleOf(row, taskId) → the row's heading if it is a NAME, else ''.
 *
 * A heading this door minted out of the routing identifier in an earlier return is not a name,
 * and inheriting one would put the identifier back where a person expects to read what the task
 * is about. Rows written in that shape still sit in a durable queue, so the shape is recognised
 * rather than assumed gone.
 */
function realTitleOf(row, taskId) {
  const t = row && typeof row.title === 'string' ? row.title.trim() : ''
  return t && t !== `return:${taskId}` ? t : ''
}

/** emitSafe — fire a hint event through the injected hub if present (never throws). */
function emitSafe(deps, event) {
  try {
    if (deps && deps.hub && typeof deps.hub.emit === 'function') deps.hub.emit(event)
  } catch {
    /* a hint is best-effort — never blocks the durable action */
  }
}

// ── the five harness handlers (the route table stayed FROZEN at 14 back then) ──
//
// All consume readHarness + the appliers via INJECTED deps (never a static import), so no
// request path reaches a config/registry write except through the wired applier. Every body
// is EXPLICIT-PICK: an unknown key → 400 BEFORE any applier runs (a smuggled `command` on
// /api/mcp/toggle is rejected at the parse layer, so RCE-through-the-toggle is structurally
// impossible). Applier named errors map to 404 (unknown id / missing definition
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
 * refreshWorkers(config, next) — the roster half of the ONE-config rule.
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

/**
 * doorProject(config) → `{project}` for work being put in RIGHT NOW, or `{}` when this daemon
 * has no project selected at all.
 *
 * THE PROJECT IS A PROPERTY OF THE TASK, AND THIS IS THE ONLY MOMENT IT CAN HONESTLY BE
 * WRITTEN DOWN: a person is standing at the door, looking at one project, and putting work in.
 * Nothing later can recover that. A measurement of the live queue is what put this here — not
 * one waiting row carried the fact, and the reading side filled the gap in with whatever
 * project happened to be on the screen, so the very same work claimed to belong to each
 * project in turn and the counters agreed with both. Ownership nobody measured is an invented
 * number like any other, only about whose work it is.
 *
 * THE STAMP LIVES AT THE DOOR AND NOT IN THE QUEUE, because the door is the half that owns the
 * config: the queue gate checks only that a project slug is SHAPED like one and never learns
 * which projects exist. And no request body names it — the project of a task is the one the
 * person was looking at, never a field a caller may set from outside.
 *
 * An empty answer is deliberate: a daemon with nothing selected writes NO project rather than
 * a word standing in for one, because an invented name is exactly what a reader would trust.
 */
function doorProject(config) {
  const chosen = config && config.activeProject
  return typeof chosen === 'string' && chosen !== '' ? { project: chosen } : {}
}

/**
 * doorProjectEntry(config) → the REGISTRY ENTRY the stamp above names, or null.
 *
 * THE SAME FACT, SAID SO A PERSON CAN READ IT. `doorProject` answers a slug, because a slug is
 * what a row stores; a window has to show a NAME, and the tree behind it is what a warning can
 * actually be checked against. Both come from the one lookup here rather than from two, so the
 * project a screen names and the project a task is stamped with can never be two projects.
 *
 * An entry the register does not have answers as a name equal to its own slug and NO path: an
 * install can carry a selected project that was renamed away, and inventing a pretty name for
 * it would be exactly the invented fact `doorProject` refuses to write. Nothing is checked
 * against a tree that was not named.
 */
function doorProjectEntry(config) {
  const { project } = doorProject(config)
  if (!project) return null
  const list = Array.isArray(config && config.projects) ? config.projects : []
  const hit = list.find((p) => p && p.id === project)
  if (!hit) return { id: project, name: project, path: null }
  const path = typeof hit.path === 'string' && hit.path.trim() !== '' ? hit.path : null
  return { id: hit.id, name: hit.name || hit.id, path }
}

/**
 * treeMisses(text, entry, deps) → what the text NAMES BY PATH and that tree does not have.
 *
 * ЛОВУШКА, РАДИ КОТОРОЙ ЭТО НАПИСАНО: штамп проекта ставится при создании задачи, а промах
 * виден только работнику — он получает копию дерева, не находит в ней исходников, о которых
 * его спросили, и возвращается с вопросом. Замерено: шесть работ, поставленных при не том
 * активном проекте, стоили полного круга «отменить и пересоздать».
 *
 * ЗДЕСЬ НЕ УГАДЫВАЕТСЯ ПРОЕКТ. Дверь отвечает про НАЗВАННОЕ дерево и только на тот вопрос,
 * который стоит одного `existsSync` на путь; правило, что считать путём, живёт в tree-probe
 * и проверяется без диска. Дерева нет (проект не подключён) — молчание, а не список: сказать
 * «в проекте этого нет» про папку, которой мы не видели, значит выдумать факт.
 */
function treeMisses(text, entry, deps) {
  if (!entry || !entry.path) return []
  const exists = (deps && deps.fsImpl && deps.fsImpl.existsSync) || fsExistsSync
  return missingPaths({ paths: namedPaths(text), projectDir: entry.path, existsImpl: exists })
}

/**
 * inheritedProject(rows) → `{project}` taken from the task's OWN earlier rows, or `{}`.
 *
 * A RETURN, A WAKE AND A RETRY ARE THE SAME TASK COMING BACK, not new work, so they carry the
 * project the task already had. Re-stamping them with whatever is selected right now would
 * move a task to another project every time somebody sent it back from a different screen —
 * the same «ownership follows the gaze» the stamp above exists to end. The rows are read
 * ACROSS ALL of the task's history on purpose: the row that names the project may well be an
 * older one, exactly as the row that names the task may be.
 */
function inheritedProject(rows) {
  const named = (Array.isArray(rows) ? rows : []).find(
    (r) => r && typeof r.project === 'string' && r.project !== '',
  )
  return named ? { project: named.project } : {}
}

/**
 * enqueueOrExplain(res, adapter, task) → the enqueue result, or NULL when the queue's own
 * database refused the text and the caller has already been answered.
 *
 * WHY IT IS NOT A 400, AND WHY IT IS NOT SWALLOWED. A queue database created in a Windows
 * ANSI code page cannot store a title that is not plain ASCII: someone writes a task in their
 * own language and the database says no. The request is not what is wrong — the SERVICE
 * cannot hold that text until an operator migrates it, which is what 503 means. And the
 * message matters more than the code: the backend turns the driver's byte-sequence error
 * into a sentence with the repairing command in it, and this is the seam that lets that
 * sentence reach the screen instead of dying as the dispatcher's «internal error».
 *
 * Any other failure is re-thrown untouched — this door explains ONE fault, not all of them.
 */
async function enqueueOrExplain(res, adapter, task) {
  try {
    // `answered` rather than a falsy result: whether the caller has been answered is not
    // the same question as what the adapter returned, and collapsing the two would make a
    // backend that answers nothing look like a refusal.
    return { answered: false, result: await adapter.enqueue(task) }
  } catch (err) {
    if (!err || err.name !== 'QueueEncodingError') throw err
    send503(res, String(err.message))
    return { answered: true, result: null }
  }
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
    // The MACHINE skill store is resolved out of the home directory when the environment
    // names none, so the injected homedir has to reach the read model — otherwise a suite
    // that fakes a home still reads the real one and the walk depends on the machine it runs on.
    homedir: deps.homedir,
    clock: deps.clock,
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
async function handleForge({ req, res, config, deps }) {
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
    // New work of the project the person was looking at — see doorProject.
    ...doorProject(config),
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
  const enq = await enqueueOrExplain(res, adapter, norm)
  if (enq.answered) return undefined // the database refused the text; the reason is already sent
  emitSafe(deps, { event: 'task.queued', taskId: norm.id })
  sendJson(res, 202, { ok: true, id: enq.result.id, kind: b.kind })
}

/**
 * POST /api/agent/toggle — body {id, enabled:boolean} → applyAgentToggle (file-derived), OR,
 * when `id` is the reserved STOCK_TEAM_TARGET, → applyStockTeamToggle: the one act that
 * switches the whole shipped SMA team on.
 *
 * The reserved target rides THIS door on purpose. The route table is FROZEN and its
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
      // BOTH directories: `repoDir` is the tree the applier READS the installed roster from,
      // and `configIo` carries the write seam — including the launchDir baseline, which is
      // never the served repoDir.
      const next = deps.applyStockTeamToggle({ config, enabled: b.enabled, repoDir: deps.repoDir, ...configIo(deps) })
      refreshWorkers(config, next)
      const touched = (next && next.workers ? next.workers : []).filter((w) => w && w.stockDigest !== undefined)
      emitSafe(deps, { event: 'harness.updated' })
      return sendJson(res, 200, { ok: true, stockTeam: { enabled: b.enabled, agents: touched.length } })
    } catch (err) {
      return applierError(res, err)
    }
  }
  try {
    const next = deps.applyAgentToggle({ config, id: b.id, enabled: b.enabled, repoDir: deps.repoDir, ...configIo(deps) })
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
      deps.applySkillAssign({ config, skillId: b.skillId, workerIds: b.workerIds, repoDir: deps.repoDir, ...configIo(deps) }),
    )
    emitSafe(deps, { event: 'harness.updated' })
    return sendJson(res, 200, { ok: true, skill: { id: b.skillId, assignedTo: b.workerIds } })
  } catch (err) {
    return applierError(res, err)
  }
}

/**
 * POST /api/skill/create — body {id, description, body} → createMachineSkill.
 *
 * THE ONE DOOR THAT WRITES A SKILL, and it writes into the MACHINE store only — the owner's
 * own instruction: a skill written here has to be usable under every project, and a file put
 * into the served tree would belong to that tree alone.
 *
 * IT IS NOT THE FORGE DOOR AND DOES NOT PRETEND TO BE. /api/forge asks a worker to draft
 * something and a person then approves it; that is a good road for «придумай мне навык» and a
 * useless one for «вот текст, положи его» — which is what a person writing a skill in the
 * window is doing. So this door takes the person's own text and answers with the PATH it was
 * written to: the proof of this act is a file on the disk, not a status code.
 *
 * Everything the request contributes is TEXT. The id is checked against the applier's strict
 * slug — no separator can appear in it, so no spelling of it leaves the store — and an id that
 * already exists in EITHER store is a 409, never an overwrite.
 */
async function handleSkillCreate({ req, res, deps }) {
  if (typeof deps.createMachineSkill !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'description', 'body']))) return undefined
  if (typeof b.id !== 'string' || !b.id) return send400(res, 'id required')
  if (typeof b.description !== 'string' || !b.description.trim()) return send400(res, 'description required')
  if (typeof b.body !== 'string' || !b.body.trim()) return send400(res, 'body required')
  try {
    const made = deps.createMachineSkill({ id: b.id, description: b.description, body: b.body, ...configIo(deps) })
    emitSafe(deps, { event: 'harness.updated' })
    return sendJson(res, 201, { ok: true, skill: made })
  } catch (err) {
    if (err && err.name === 'SkillExistsError') return send409(res, String(err.message))
    return applierError(res, err)
  }
}

/**
 * POST /api/mcp/toggle — body {serverId, enabled:boolean} → applyMcpToggle (boolean-only). A
 * smuggled `command` (or any other) key is rejected by rejectUnknownKeys BEFORE the registry
 * is even loaded, so zero applier calls occur — RCE-through-the-toggle is impossible by
 * construction.
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

// ── the V5.1 sixteen, all filled (the route table stayed FROZEN at 30 throughout) ──
//
// Declared once, filled by their own plans, in the order the release needed them. Not one
// of them is a stub any longer, and the table they live in never changed a single key —
// which was the point of writing it down in full on the first day. The dispatcher runs
// authed() BEFORE any handler, so an unauthenticated call to any route looks identical
// from outside and cannot map the surface by status code.

// ── the four project doors (the route table stays FROZEN) ──
//
// A registry WRITE is a config write, so — exactly like the harness appliers — the three
// config.mjs doors (addProject / renameProject / selectProject) arrive through INJECTED
// deps and are never statically imported here: no request path reaches the config except
// through a wired door. The handlers re-implement NOTHING of the registry's rules. They
// reject unknown keys, hand the body over, map the named error (Unknown* → 404, invalid →
// 400) and emit the `project.updated` hint the app re-reads on. The id is minted by the
// door and NEVER moves on a rename — it is the key tasks and workers reference.

/**
 * THE WRITE SEAM, in one place: the options every path that ends in a config write takes —
 * the registry doors of config.mjs AND the three harness appliers (all four are DI). One
 * builder, so a write-time fact cannot reach one family and miss the other; that asymmetry
 * is how `launchDir` would go missing again.
 */
function configIo(deps) {
  return {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.homedir ? { homedir: deps.homedir } : {}),
    ...(deps.fsImpl ? { fsImpl: deps.fsImpl } : {}),
    // The daemon's LAUNCH directory — the fallback the load-time derive used. The writer
    // needs it to tell a value it would derive again from one an operator typed, so a
    // registry write persists neither.
    //
    // NOT `deps.repoDir`. That one is the tree this daemon SERVES, which for a config
    // carrying a pin IS the pin, and handing it to the writer made the strip's test read
    // «pin === pin»: one press in the window deleted the founder's pin from the file
    // once already. The two facts travel together to the same doors and are told
    // apart only by their names.
    ...(deps.launchDir ? { launchDir: deps.launchDir } : {}),
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

/**
 * A registry entry as it leaves the process: the two fields a human sees, plus WHETHER the
 * project keeps its planning in a second folder. The path itself never travels — an absolute
 * path on the wire is a disclosure, and a boolean is the whole of what a screen needs to say
 * «этот проект двухрепный».
 */
function pickProject(entry) {
  return {
    id: entry.id,
    name: entry.name,
    ...(typeof entry.planningPath === 'string' && entry.planningPath.trim() !== '' ? { planningHome: true } : {}),
  }
}

/**
 * GET /api/projects — the switcher's read model: every project with its per-project task
 * counts, plus the active one. It is a SLICE of the same derive /api/state serves (the
 * counts are derived, never stored), explicit-picked to two fields — so no token of the
 * config and no token of a peer can ride out of here by construction.
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
 * POST /api/project/add — take a folder into the register. Body {path, name?, planningPath?}:
 * the folder the founder picked, optionally what to call it (absent → the folder's own name),
 * and optionally its SECOND address — the folder holding this product's `.planning`. The id is
 * minted BY THE DOOR from that name; both paths are stored as opaque data.
 *
 * ДВУХРЕПНЫЙ ДОМ ЗАВОДИТСЯ ОДНИМ ПРОЕКТОМ. Дерево кода — продукт, дом планирования — мастерская
 * рядом. Второй проект для планирования не нужен и в окне не появляется.
 */
async function handleProjectAdd({ req, res, config, deps }) {
  if (typeof deps.addProject !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['path', 'name', 'planningPath']))) return undefined
  const path = b.path === undefined || b.path === null ? '' : String(b.path)
  if (path.length > 4096 || path.includes('\0')) return send400(res, 'invalid path')
  const planningPath = b.planningPath === undefined || b.planningPath === null ? '' : String(b.planningPath)
  if (planningPath.length > 4096 || planningPath.includes('\0')) return send400(res, 'invalid planningPath')
  const name = b.name === undefined || b.name === null || String(b.name).trim() === '' ? nameFromPath(path) : String(b.name).trim()
  if (!name) return send400(res, 'a project needs a name or a path')
  try {
    const next = deps.addProject(
      config,
      { name, ...(path ? { path } : {}), ...(planningPath.trim() ? { planningPath } : {}) },
      configIo(deps),
    )
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
 * id is what rows and worker profiles reference. Unknown id → 404.
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

/**
 * POST /api/project/planning — body {id, planningPath}. ВТОРОЙ АДРЕС проекта: каталог, где
 * лежит его `.planning`. Пустая строка или `null` — снять второй адрес: проект возвращается к
 * одному, и фазы с беклогом снова читаются из дерева кода.
 *
 * ЭТО НЕ ПЕРЕЕЗД ПРОЕКТА. Дерево кода не трогается: продукт остаётся там, где стоял, — меняется
 * только то, откуда читается планирование. Ровно поэтому дом с двумя репозиториями настраивается
 * ОДНИМ проектом, а не двумя, из которых один нельзя выключить, не потеряв фазы и беклог.
 */
async function handleProjectPlanning({ req, res, config, deps }) {
  if (typeof deps.setProjectPlanning !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'planningPath']))) return undefined
  if (typeof b.id !== 'string' || !b.id) return send400(res, 'invalid id')
  const planningPath = b.planningPath === undefined || b.planningPath === null ? '' : String(b.planningPath)
  if (planningPath.length > 4096 || planningPath.includes('\0')) return send400(res, 'invalid planningPath')
  try {
    const next = deps.setProjectPlanning(config, { id: b.id, planningPath }, configIo(deps))
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
    // The watcher binds to ONE tree, and the tree just changed. The seam is a
    // callback rather than a watcher handle on purpose: a request handler that could stop and
    // start watchers would be a request handler holding a lifecycle, and the composition root
    // is where a lifecycle belongs. It is best-effort — a connection that cannot be re-watched
    // degrades to the polling the liveness seam already reports honestly, never a failed select.
    if (typeof deps.onProjectSelected === 'function') {
      try {
        deps.onProjectSelected({ projectId: b.id })
      } catch {
        /* re-targeting is an improvement on the answer, never a condition of it */
      }
    }
    emitSafe(deps, { event: 'project.updated', projectId: b.id })
    return sendJson(res, 200, { ok: true, activeProject: next.activeProject ?? null })
  } catch (err) {
    return applierError(res, err)
  }
}

// ── the four machine doors (the route table stays FROZEN) ──
//
// INTRODUCTION IS THE ONE MOMENT A DAEMON TOKEN LEAVES ITS MACHINE, so these four are the
// most careful handlers in the file, and every one of them is a DELEGATE:
//   - the invitation is minted, judged and burned by the federation module's pairing book
//     (one shot, TTL, timing-safe) — this file never compares a secret itself;
//   - the registry WRITE goes through the injected config door (addPeer / removePeer),
//     exactly like the project doors: no request path reaches the config any other way;
//   - the SSRF guard runs on the joining url BEFORE the write, so a loopback or metadata
//     address never lands on disk;
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

/** The federation role this daemon declares. An absent block means standalone. */
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
 * neither a peer url nor a peer token can ride out even if the registry grows a field.
 * A standalone daemon answers honestly with exactly one machine: its own.
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
 * NAMES that token as a placeholder so the reader knows what to paste.
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
    fed.validatePeerUrl(entry) // the SSRF guard runs BEFORE the write
    const next = deps.addPeer(config, entry, configIo(deps))
    config.federation = next.federation // the next read must not serve the old registry
    fed.registerPeer(entry) // live now, not after a restart
  } catch (err) {
    return applierError(res, err)
  }

  // `online` is what the screen patches with — a peer just registered IS online. Without it
  // the frame rang a doorbell nobody could answer: the client requires the boolean.
  emitSafe(deps, { event: 'machine.presence', machineId: entry.id, online: true })
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
  emitSafe(deps, { event: 'machine.presence', machineId: b.id, online: false })
  return sendJson(res, 200, { ok: true, id: b.id })
}

// ── the two conversation doors (the route table stays FROZEN) ──
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

/**
 * putDraftedTask({config, deps, draft}) → `{ok:true, id, title}` или `{ok:false, reason}`.
 *
 * ═══ ПОСТАНОВКА ПО СЛОВУ ИДЁТ ТОЙ ЖЕ ДВЕРЬЮ, ЧТО И ПО КНОПКЕ ═══
 *
 * Приказ владельца: разговор договаривается словами и сам ставит задачу, когда человек
 * согласился, — и одинаково в окне и в боте. Двери должны быть ОДНОЙ дверью, а не двумя
 * похожими: и правило проекта (`doorProject`), и чеканка идентификатора, и проверка формы
 * (`validateTask`), и колокол `task.queued` здесь ровно те же, что у `handleEnqueue`. Иначе
 * задача, поставленная словом, однажды окажется чуть-чуть другой задачей, чем поставленная
 * кнопкой, и разницу никто не заметит до разбора.
 *
 * ЛИНИЯ РАБОТЫ ВЫВОДИТСЯ ТАК ЖЕ, КАК ЕЁ ВЫВОДИТ ЭКРАН: из черновика, а если он её не назвал —
 * из полосы предложенного работника. Не вывелась — это ОТКАЗ СЛОВАМИ, а не догадка: очередь
 * маршрутизирует внутри полосы, и выдуманная полоса увезла бы работу не туда молча.
 *
 * `source:'roster'` — потому что это и есть явное слово владельца, как нажатие кнопки.
 * Отказ здесь никогда не бросается: согласие не должно ронять ход разговора, и человек читает
 * причину фразой, а не видит «не получилось ответить».
 */
async function putDraftedTask({ config, deps, draft }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return { ok: false, reason: 'очередь этому демону не подключена' }

  const d = draft && typeof draft === 'object' ? draft : {}
  const title = String(d.title ?? '').trim()
  if (!title) return { ok: false, reason: 'в черновике нет названия' }

  const roster = config && Array.isArray(config.workers) ? config.workers : []
  const worker = d.worker ? roster.find((w) => w && w.id === d.worker) : null
  const lane = d.lane ?? (worker && worker.lane) ?? null
  if (!lane) {
    return {
      ok: false,
      reason: d.worker
        ? `у исполнителя «${d.worker}» не назначена линия работы`
        : 'в черновике не названа линия работы',
    }
  }

  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const task = {
    id: `R-${clock()}`,
    source: 'roster',
    // WHOSE WORK THIS IS, written down at the one moment it is known — see doorProject.
    ...doorProject(config),
    title,
    lane,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.acceptance !== undefined ? { acceptance: d.acceptance } : {}),
  }

  let norm
  try {
    norm = validateTask(task)
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || 'черновик не прошёл проверку') }
  }
  let result
  try {
    result = await adapter.enqueue(norm)
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || 'очередь не приняла задачу') }
  }
  emitSafe(deps, { event: 'task.queued', taskId: norm.id, status: 'queued' })
  return { ok: true, id: (result && result.id) || norm.id, title: norm.title }
}

/**
 * The collaborator set the chat engine takes — the chat analogue of stateDeps.
 *
 * ПРОЕКТ ХОДА БЕРЁТСЯ ТАМ ЖЕ, ГДЕ ЕГО БЕРЁТ ДВЕРЬ ПОСТАНОВКИ ЗАДАЧ — `doorProject`, то есть
 * из конфига этого демона, а не из тела запроса. Причина та же, слово в слово: беседа
 * принадлежит проекту, на который смотрел человек, когда говорил, и ни один вызывающий не
 * вправе назвать его сам. Проекта не выбрано — поля нет, и ход честно записан «без проекта».
 * Мост телеграма зовёт эту же сборку, поэтому у бота и у окна проект хода один и тот же.
 */
function chatDeps(config, deps, extra = {}) {
  return {
    ...extra,
    ...doorProject(config),
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
    // the Stop button's other half — the live-turn registry the stop door also holds
    chatTurns: deps.chatTurns,
    // ПОСТАНОВКА ПО СЛОВУ. Способность выдаётся ЗДЕСЬ — в одном месте на обе двери: и окно, и
    // мост телеграма зовут runChatTurn, который собирает сотрудников этой функцией. Поэтому
    // «да», сказанное с телефона, и «да», сказанное в окне, идут в одну и ту же дверь
    // постановки с одним и тем же правилом проекта — не по договорённости, а по устройству.
    putTask: (draft) => putDraftedTask({ config, deps, draft }),
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
 *
 * `attachments` DOES ride out, and it is picked field by field rather than passed through:
 * the engine offers `{rel}` and that is the whole of what a screen may turn into a button.
 * The paths are not re-checked here — a screen hands them to the artefact door, which
 * resolves and contains every path it is given and refuses the rest in one voice. Checking
 * them twice in two places is how two spellings of one rule are born.
 */
function pickAnswer(answer) {
  const a = answer && typeof answer === 'object' ? answer : {}
  return {
    kind: a.kind ?? 'text',
    text: typeof a.text === 'string' ? a.text : '',
    ...(a.taskRef ? { taskRef: a.taskRef } : {}),
    ...(a.draft ? { draft: a.draft } : {}),
    ...(a.decision ? { decision: pickDecision(a.decision) } : {}),
    ...(Array.isArray(a.spend) ? { spend: a.spend } : {}),
    ...(a.link ? { link: a.link } : {}),
    ...pickAttachments(a),
  }
}

/**
 * A decision proposal as it leaves the process: the task the daemon knows and the optional
 * подсказка, field by field. The buttons the screen builds out of this press the ORDINARY
 * approve/return doors — the proposal itself can do nothing.
 */
function pickDecision(d) {
  const r = d && typeof d === 'object' ? d : {}
  return {
    taskId: r.taskId ?? null,
    title: r.title ?? null,
    ...(typeof r.note === 'string' && r.note !== '' ? { note: r.note } : {}),
  }
}

/** The documents a reply offers, as `{rel}` and nothing else — a shape, never a fragment. */
function pickAttachments(r) {
  if (!Array.isArray(r.attachments) || r.attachments.length === 0) return {}
  const list = r.attachments
    .filter((a) => a && typeof a.rel === 'string' && a.rel !== '')
    .map((a) => ({ rel: a.rel }))
  return list.length ? { attachments: list } : {}
}

/**
 * A stored turn as it leaves the process — the same picking, plus who said it and when.
 *
 * `project` уезжает НАЗВАННЫМ, включая `null`: ход без проекта — это ход «без проекта», а не
 * ход неизвестно чей, и читателю на той стороне это должно быть видно так же, как здесь.
 */
function pickTurn(t) {
  const r = t && typeof t === 'object' ? t : {}
  return {
    ts: r.ts ?? null,
    conversationId: r.conversationId ?? null,
    project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
    role: r.role ?? 'user',
    kind: r.kind ?? null,
    text: typeof r.text === 'string' ? r.text : '',
    ...(r.taskRef ? { taskRef: r.taskRef } : {}),
    ...(r.draft ? { draft: r.draft } : {}),
    ...(r.decision ? { decision: pickDecision(r.decision) } : {}),
    ...pickAttachments(r),
  }
}

/**
 * СНИМОК КАРТОЧКИ, С КОТОРОЙ ОТКРЫТ РАЗГОВОР — собранный ДЕМОНОМ из своего же реестра.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В ОКНЕ. Окно знает, какая карточка у человека на глазу, и не знает
 * ничего больше: строка очереди, счёт попыток и их исход живут за этой дверью. Снимок,
 * присланный клиентом, был бы недоверенным текстом — его пришлось бы проверять поле за полем
 * и всё равно везти за забором, — и вдобавок второй правдой о задаче рядом с карточкой.
 * Поэтому окно называет ИДЕНТИФИКАТОР, а читает реестр тот, кто им владеет.
 *
 * ЧИТАЕТСЯ ТЕМИ ЖЕ ШВАМИ, ЧТО И КАРТОЧКА: строка — из `adapter.list`, свёрнутая тем же
 * правилом (`latestRowPerId`), попытки — тем же швом реестра и той же свёрткой
 * (`foldAttemptRows`). Два способа прочитать одну задачу — это два экрана, которые однажды
 * скажут человеку разное.
 *
 * `null` — «сказать нечего»: нет двери к очереди, нет такой строки, нечитаемый реестр. В
 * промпт тогда не едет ничего, и разговор честно не видит карточки, вместо того чтобы видеть
 * пустую.
 *
 * @returns {object|null}
 */
async function chatTaskSnapshot(taskId, deps) {
  const adapter = deps.adapter
  if (!taskId || !adapter || typeof adapter.list !== 'function') return null
  let rows = []
  try {
    rows = (await adapter.list({})) || []
  } catch {
    return null
  }
  const row = latestRowPerId(rows.filter((r) => r && r.id === taskId))[0]
  if (!row) return null

  let raw = []
  try {
    if (typeof deps.ledger === 'function') raw = deps.ledger(taskId) || []
    else if (deps.ledger && typeof deps.ledger.readAttempts === 'function') raw = deps.ledger.readAttempts(taskId) || []
    else if (deps.ledgerDir) raw = readAttempts(deps.ledgerDir, taskId)
  } catch {
    raw = []
  }
  const attempts = foldAttemptRows(Array.isArray(raw) ? raw : [])

  return {
    id: row.id ?? null,
    title: row.title ?? null,
    status: row.status ?? null,
    statusLabel: STATUS_LABELS[row.status] ?? null,
    // НАЗВАНО ОТДЕЛЬНЫМ ПОЛЕМ, а не оставлено выводом из статуса: именно об этом разговор и
    // соврал 25.08 в 14:11 («одобрять нечего» задаче, которая стояла и ждала решения).
    awaitingDecision: row.status === 'awaiting_approval',
    lane: row.lane ?? null,
    attempts: attempts.length,
    events: attempts.slice(-SNAPSHOT_EVENT_CAP).map((a) => ({
      attempt: a.attempt ?? null,
      outcome: a.outcome ?? null,
      reason: a.failureReason ? REASON_LABELS[a.failureReason] ?? a.failureReason : null,
      at: a.endedAt ?? a.startedAt ?? null,
    })),
  }
}

/**
 * СНИМОК ДОСКИ ДЛЯ РАЗГОВОРА — та же правда, что отдаёт дверь состояния.
 *
 * Собирается ТЕМ ЖЕ derive и теми же deps, что GET /api/state, и из выдачи берётся явный
 * короткий срез: активный проект, счётчики, очередь и ожидающие одобрения (списки
 * ограничены). Отдельная свёртка тех же строк была бы ВТОРОЙ правдой о доске — а два
 * способа прочитать одну доску однажды скажут человеку разное.
 *
 * `null` — «сказать нечего»: derive не подключён или упал. В промпт тогда не едет ничего,
 * и разговор честно не видит доску, вместо того чтобы видеть пустую.
 *
 * @returns {Promise<object|null>}
 */
async function chatBoardSnapshot(config, deps) {
  if (typeof deps.deriveState !== 'function') return null
  let payload
  try {
    payload = await deps.deriveState(stateDeps(config, deps))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const brief = (t) => ({
    id: t?.id ?? null,
    title: t?.title ?? null,
    project: t?.project ?? null,
    status: t?.status ?? null,
    statusLabel: STATUS_LABELS[t?.status] ?? null,
  })
  const k = payload.kpis && typeof payload.kpis === 'object' ? payload.kpis : {}
  return {
    activeProject: payload.activeProject ?? null,
    projects: (Array.isArray(payload.projects) ? payload.projects : []).slice(0, BOARD_LIST_CAP).map((p) => ({
      id: p?.id ?? null,
      name: p?.name ?? null,
      taskCounts: p?.taskCounts ?? null,
    })),
    kpis: {
      queued: k.queued ?? null,
      awaitingApproval: k.awaitingApproval ?? null,
      workersBusy: k.workersBusy ?? null,
      workersTotal: k.workersTotal ?? null,
    },
    awaiting: (Array.isArray(payload.awaiting) ? payload.awaiting : []).slice(0, BOARD_LIST_CAP).map(brief),
    queue: (Array.isArray(payload.queue) ? payload.queue : []).slice(0, BOARD_LIST_CAP).map(brief),
  }
}

/** Сколько строк каждого списка доски едет в снимок разговора. Сводка, а не выгрузка. */
export const BOARD_LIST_CAP = 10

/**
 * stageTeller(turnId, deps) → функция, которой движок сообщает, где сейчас ход.
 *
 * Номер кадра растёт на этой стороне: окно отбрасывает всё, что пришло не по порядку, а
 * порядок знает только тот, кто пишет. Хода без имени (`turnId` не прислан) не бывает и в
 * потоке: кадр, который некому отнести к своему пузырю, — это кадр, который окно всё равно
 * выбросит, поэтому он не пишется вовсе.
 */
function stageTeller(turnId, deps) {
  if (!turnId) return null
  let seq = 0
  return (stage) => {
    if (!CHAT_STAGES.includes(stage)) return // имени вне закрытого списка на проводе не бывает
    seq += 1
    emitSafe(deps, { event: 'chat.stage', turnId, stage, seq })
  }
}

/**
 * runChatTurn({config, deps, text, …}) — ОДИН ход разговора со ВСЕМ, что дверь чата собирает.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНОЕ ИМЯ, А НЕ ТЕЛО ОБРАБОТЧИКА. Разговор идёт теперь из двух мест: из окна
 * (через дверь ниже) и из телеграма (через мост, которому дверей не добавляли). Слово владельца
 * о втором — «мозг должен быть идентичным, один в один как бы я писал в фронте», а идентичность
 * мозга — это не одинаковый вызов `handleChatTurn`, а ОДИН И ТОТ ЖЕ набор сотрудников: снимок
 * доски, снимок карточки, стенограмма, полоса свободной ветки. Собранный дважды, он однажды
 * разойдётся — и бот ответит «одобрять нечего» задаче, которая стоит и ждёт решения, ровно как
 * это уже случилось у окна 25.08. Поэтому сборка живёт здесь, в одном экземпляре, и обе стороны
 * зовут её, а не повторяют.
 *
 * Новой двери при этом не появляется: `ROUTES` не изменилась ни на строку — мост зовёт функцию
 * в этом же процессе, тем же способом, каким её зовёт обработчик ниже.
 *
 * @param {{config:object, deps:object, text:string, conversationId?:string, turnId?:string, taskId?:string, tellStage?:Function}} o
 * @returns {Promise<{conversationId:string, kind:string, answer:object}>}
 */
export async function runChatTurn({ config, deps, text, conversationId, turnId, taskId, tellStage } = {}) {
  const snapshot = taskId ? await chatTaskSnapshot(taskId, deps) : null
  // Доска едет с КАЖДЫМ ходом, не только с открытым с карточки: вопрос «что у нас
  // происходит?» — это вопрос свободной ветки, и отвечать на него она должна по данным.
  const board = await chatBoardSnapshot(config, deps)

  // ЖИВАЯ ТОЧКА ЗАЖИГАЕТСЯ ЗДЕСЬ — в сборке, общей для окна и для моста телеграма, а не в
  // одной из двух дверей. Иначе беседа, которую ведут с телефона, выглядела бы в списке
  // законченной ровно тогда, когда в ней идёт работа. Гаснет точка в `finally`: ход, упавший
  // с ошибкой, — это закончившийся ход, а не вечно активный разговор.
  const live = deps.chatLive
  let marked = null
  const onConversation = live && typeof live.begin === 'function'
    ? (id) => {
        marked = id
        live.begin(id)
      }
    : undefined

  try {
    return await deps.handleChatTurn({
      text,
      ...(conversationId ? { conversationId } : {}),
      ...(turnId ? { turnId } : {}),
      deps: chatDeps(config, deps, {
        ...(snapshot ? { snapshot } : {}),
        ...(board ? { board } : {}),
        ...(tellStage ? { onStage: tellStage } : {}),
        ...(onConversation ? { onConversation } : {}),
      }),
    })
  } finally {
    if (marked) live.end(marked)
  }
}

/**
 * POST /api/chat — one conversation turn. Body {text, conversationId?, turnId?, taskId?}.
 *
 * The `chat.reply` hint fires AFTER the engine has returned, which is after both turns are
 * on the transcript — a screen that re-reads on the hint can never find the book behind the
 * event. The hint carries a turn id and a status and NOTHING ELSE: the founder's question
 * and the answer's words go to the caller that asked, not to every open screen.
 *
 * ХОД ВИДЕН, ПОКА ОН ИДЁТ. Кроме итогового колокола эта дверь пишет в тот же поток этапы
 * (`chat.stage`): «принято» — до того, как движок тронулся, потом то, что скажет о себе сам
 * движок, и «готово» — когда ответ собран. Куском по проводу едет ИМЯ ЭТАПА: слова разговора
 * в кадр не входят никогда, и новая дверь для этого не открывается — решение владельца.
 *
 * И ЕЩЁ ОДНО ПОЛЕ, БЕЗ НОВОЙ ДВЕРИ: `taskId` — идентификатор карточки, с которой открыт
 * разговор. Тем же способом, каким сюда попал `machine` у соседних дверей: список разрешённых
 * ключей, а не новая строка в таблице маршрутов.
 */
async function handleChat({ req, res, config, deps }) {
  if (typeof deps.handleChatTurn !== 'function') return send501(res)
  const body = await readJsonBody(req, { cap: CHAT_BODY_CAP })
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['text', 'conversationId', 'turnId', 'taskId']))) return undefined
  if (typeof b.text !== 'string' || b.text.trim() === '') return send400(res, 'text required')
  if (b.text.length > CHAT_TEXT_CAP) return send400(res, `text exceeds ${CHAT_TEXT_CAP} chars`)
  if (b.conversationId !== undefined && b.conversationId !== null) {
    if (typeof b.conversationId !== 'string' || !CONVERSATION_ID_RE.test(b.conversationId)) {
      return send400(res, 'invalid conversationId')
    }
  }
  // The turn id is CLIENT-minted: the stop door needs a name for the turn BEFORE this
  // request answers, and the client is the only party that has one that early.
  if (b.turnId !== undefined && b.turnId !== null) {
    if (typeof b.turnId !== 'string' || !TURN_ID_RE.test(b.turnId)) return send400(res, 'invalid turnId')
  }
  if (b.taskId !== undefined && b.taskId !== null) {
    if (typeof b.taskId !== 'string' || !ID_RE.test(b.taskId)) return send400(res, 'invalid taskId')
  }

  const tellStage = stageTeller(b.turnId, deps)
  // «Принято» уходит ДО движка: человек, который смотрит на своё сообщение, узнаёт, что оно
  // дошло, а не что оно когда-нибудь получит ответ.
  if (tellStage) tellStage('accepted')

  const turn = await runChatTurn({
    config,
    deps,
    text: b.text,
    conversationId: b.conversationId,
    turnId: b.turnId,
    taskId: b.taskId,
    tellStage,
  })
  const answer = pickAnswer(turn && turn.answer)
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  if (tellStage) tellStage('done')
  emitSafe(deps, {
    event: 'chat.reply',
    turnId: `${turn.conversationId}-${clock()}`,
    status: turn && turn.answer && turn.answer.error ? 'failed' : 'ok',
  })
  return sendJson(res, 200, { conversationId: turn.conversationId, kind: turn.kind ?? null, answer })
}

/** A client-minted chat turn id: short, filename-safe, and useless to guess. */
const TURN_ID_RE = /^ct-[A-Za-z0-9][A-Za-z0-9-]{3,47}$/

/**
 * Providers whose spawn runs behind the parking gate — the hook boundary that can hand a word
 * to a turn ALREADY IN FLIGHT. The api fallback belongs on this list deliberately: it is the
 * same CLI with a different way of paying, so it carries the same gate. The other vendor's CLI
 * has no such boundary at all, and that is a fact about the vendor rather than a gap to paper
 * over. An allow-list, not a deny-list: a provider nobody has taught this door about must be
 * treated as channel-less until someone proves otherwise, never assumed to be reachable.
 */
const LIVE_CHANNEL_PROVIDERS = Object.freeze(['claude', 'api'])

/**
 * Did this task's LAST attempt run on an executor that has a live channel? Read through the
 * SAME ledger seam as the task card (fn / {readAttempts} / ledgerDir) and folded by the same
 * rule, so the card and this door can never come to disagree about who ran last.
 *
 * SILENCE MEANS YES, deliberately. No attempts yet, an unreadable ledger, a row carrying no
 * provider — none of those is EVIDENCE of a missing channel, and the store is durable: the
 * line simply waits for the first turn that has a gate. An unreadable ledger has no right to
 * fail this door, which is the posture every other reader in this file already takes.
 */
function hasLiveChannel(taskId, deps) {
  const provider = lastValue(foldAttemptRows(attemptRowsOf(taskId, deps)), (a) => a && a.provider)
  return provider === null || LIVE_CHANNEL_PROVIDERS.includes(provider)
}

/** This task's attempt rows through whichever ledger seam was injected; unreadable → []. */
function attemptRowsOf(taskId, deps) {
  let rows = []
  try {
    if (typeof deps.ledger === 'function') rows = deps.ledger(taskId) || []
    else if (deps.ledger && typeof deps.ledger.readAttempts === 'function') rows = deps.ledger.readAttempts(taskId) || []
    else if (deps.ledgerDir) rows = readAttempts(deps.ledgerDir, taskId)
  } catch {
    rows = []
  }
  return Array.isArray(rows) ? rows : []
}

/**
 * journalRedirect(body, redirectId, deps) — the correction, written into the HISTORY of the
 * attempt it was said to.
 *
 * ═══════ WHY THE DOOR WRITES TWICE, AND WHY THAT IS NOT A SECOND STORE ═══════
 * `data/redirects/<task>.ndjson` is a DELIVERY QUEUE: lines are consumed and marked done, and
 * the file answers «what has not been handed over yet». That is a different question from «what
 * did this person say to this attempt, and when» — and the card asks the second one. For as long
 * as only the queue existed, the card could not show that anybody had steered the work at all:
 * the founder's word reached the worker and vanished from the story of the task. So the same
 * door that accepts the word records it as one journal row, in the layer the vocabulary now
 * carries, beside the dispatcher's reason and the worker's note.
 *
 * ═══════ WHICH ATTEMPT IT IS FILED UNDER ═══════
 * The one that was running when the word was said — the last one the ledger knows. A task with
 * no attempts yet files under 1: the line is durable, it waits, and the first turn collects it.
 * That is «when it was said», which is what a card shows; it is not a claim about which turn
 * eventually received it — the delivery file owns that fact and is not touched here.
 *
 * FAIL-OPEN, LOUDLY. The correction is already DURABLE by the time this runs. A journal that
 * cannot be written costs the story a line; it must never cost the founder his steering, so the
 * failure is logged and the door answers 200 exactly as it did before.
 */
function journalRedirect(body, redirectId, deps) {
  const append = deps.ledger && typeof deps.ledger.appendJournal === 'function' ? deps.ledger.appendJournal : null
  if (!append) return
  // ПОСЛЕДНИЙ ПОДХОД — по НОМЕРУ, а не по месту в файле: строки реестра дописываются с двух
  // сторон, и «последняя прочитанная» не значит «самая новая».
  let attempt = 0
  for (const row of foldAttemptRows(attemptRowsOf(body.taskId, deps))) {
    const n = Number(row && row.attempt)
    if (Number.isFinite(n) && n > attempt) attempt = n
  }
  try {
    append({
      taskId: body.taskId,
      attempt: attempt || 1,
      layer: 'redirect',
      payload: { mode: body.mode, text: body.text, redirectId },
    })
  } catch (err) {
    console.error(`[SmaFront] redirect not journaled for ${body.taskId}: ${String((err && err.message) || err)}`)
  }
}

/**
 * POST /api/redirect — body {taskId, text, mode: 'interrupt'|'queue'|'steer'}. The steering
 * wheel for a RUNNING task: the correction is written DURABLY first (a restart must not lose
 * a founder's «нет, не так»), and only then, for 'interrupt', the live child is told to die —
 * the runner's continuation loop picks the note up and resumes the SAME session with it.
 * `live` in the answer says whether anything was actually killed; a task between attempts
 * still gets its correction on the next exit, which is what 'queue' means.
 *
 * THE THIRD FATE is 'steer': a word for the turn that is running right now. Nothing is killed —
 * the gate inside the worker's own child process hands the word over at the next tool-call
 * boundary, so what the model was holding in its head mid-turn survives. `live` is honestly
 * `false` for it: no one was shot, and the field keeps meaning exactly what it always meant.
 *
 * AND WHERE THERE IS NO SUCH CHANNEL, THIS DOOR SAYS SO. Not every executor runs behind that
 * gate. Taking a mid-turn word for one that does not, and quietly delivering a kill instead,
 * would be a forgery — the same door does honest work as «kill and continue», and it is
 * LABELLED that way. So when the last attempt of this task ran on an executor with no live
 * channel, 'steer' is refused in words naming the two shapes that DO reach it. The refusal
 * comes before the write: a line nobody will ever deliver should not be lying in the store
 * looking delivered-any-moment. A task with no attempts yet is accepted — the line is durable
 * and waits for the first gated turn.
 */
async function handleRedirect({ req, res, config, deps }) {
  if (!config.dataDir) return send501(res)
  const body = await readJsonBody(req, { cap: CHAT_BODY_CAP })
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['taskId', 'text', 'mode']))) return undefined
  if (typeof b.taskId !== 'string' || !ID_RE.test(b.taskId)) return send400(res, 'invalid taskId')
  if (b.mode !== 'interrupt' && b.mode !== 'queue' && b.mode !== 'steer') {
    return send400(res, 'mode must be interrupt, queue or steer')
  }
  if (b.mode === 'steer' && !hasLiveChannel(b.taskId, deps)) {
    return send400(
      res,
      'у этого исполнителя нет живого впрыска: слово доедет как «перебить сейчас» (убить и продолжить) или «после хода» — обе формы доставят его со следующим заходом задачи',
    )
  }
  const wrote = appendRedirect({
    dataDir: config.dataDir,
    taskId: b.taskId,
    text: b.text,
    mode: b.mode,
    clock: deps.clock,
    fsImpl: deps.fsImpl,
  })
  if (!wrote.ok) return send400(res, wrote.error === 'text too long' ? `text exceeds ${REDIRECT_TEXT_CAP} chars` : 'text required')
  journalRedirect(b, wrote.id, deps)
  let live = false
  if (b.mode === 'interrupt' && deps.attemptTurns && typeof deps.attemptTurns.stop === 'function') {
    live = deps.attemptTurns.stop(b.taskId)
  }
  emitSafe(deps, { event: 'task.running', taskId: b.taskId, status: 'claimed' })
  return sendJson(res, 200, { accepted: true, id: wrote.id, mode: b.mode, live })
}

/**
 * POST /api/chat/stop — body {turnId}. The Стоп button's door: tell a LIVE chat turn to
 * die. The send request itself then answers `kind: 'stopped'` through its own exit path —
 * this door only pulls the trigger and reports whether there was anything to shoot.
 * `stopped: false` is an honest «that turn is not running» (already finished, or a
 * daemon restart dropped the registry), never an error.
 */
async function handleChatStop({ req, res, deps }) {
  const registry = deps.chatTurns
  if (!registry || typeof registry.stop !== 'function') return send501(res)
  const body = await readJsonBody(req, { cap: CHAT_BODY_CAP })
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['turnId']))) return undefined
  if (typeof b.turnId !== 'string' || !TURN_ID_RE.test(b.turnId)) return send400(res, 'invalid turnId')
  return sendJson(res, 200, { stopped: registry.stop(b.turnId) })
}

/**
 * How long the cancel door waits for the child it has just killed to CLOSE its attempt
 * before it writes the terminal into the queue. NAMED, because an unnamed wait is a wait
 * nobody can argue with: three seconds is long enough for a killed process to be reaped and
 * short enough that a person pressing a button does not think the window has frozen. When it
 * runs out the row is closed ANYWAY and the answer says the wait ran out — see the handler.
 */
export const CANCEL_ATTEMPT_CLOSE_WAIT_MS = 3_000

/** How often the door looks while it waits. Small enough that the usual case costs one look. */
export const CANCEL_ATTEMPT_POLL_MS = 50

/** The default nap. Injectable, so the suite can exhaust the wait without spending the time. */
const defaultNap = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * waitForAttemptClose({registry, taskId, deps}) → true when the attempt closed inside the
 * named cap, false when the cap ran out first.
 *
 * HOW «CLOSED» IS OBSERVED, AND WHY THIS WAY. The registry marks a handle stopped BEFORE it
 * kills, and the dying child's own exit path is what removes the handle. So a handle that is
 * still marked stopped is an attempt still unwinding, and a handle that is gone is an attempt
 * that finished. Nothing new is registered to learn this — a second bookkeeping of the same
 * fact is a second truth, and the two would drift.
 */
async function waitForAttemptClose({ registry, taskId, deps }) {
  if (!registry || typeof registry.wasStopped !== 'function') return false
  const nap = typeof deps.sleep === 'function' ? deps.sleep : defaultNap
  const looks = Math.max(1, Math.ceil(CANCEL_ATTEMPT_CLOSE_WAIT_MS / CANCEL_ATTEMPT_POLL_MS))
  for (let i = 0; i < looks; i += 1) {
    if (registry.wasStopped(taskId) !== true) return true
    await nap(CANCEL_ATTEMPT_POLL_MS)
  }
  return registry.wasStopped(taskId) !== true
}

/**
 * POST /api/task/cancel — body {taskId}. «Остановите это», сказанное пальцем.
 *
 * KILL FIRST, CLOSE SECOND, AND THE ORDER IS THE WHOLE POINT. Marking the row closed while
 * the child is still alive is the loop that burns a subscription: the process keeps working
 * for a task nobody is waiting for, the liveness sweep sees a claim it cannot explain, and a
 * fresh attempt is started beside the one still running. So this door (a) takes the live
 * child's handle out of the attempt registry and tells it to die, (b) waits a NAMED, short
 * while for that attempt to close, and only then (c) asks the queue to close the row
 * terminally. The reverse order was measured to produce parallel processes against one row.
 *
 * THE ANSWER IS HONEST ABOUT ALL THREE THINGS, because the window turns them into different
 * sentences and a person deserves to know which one happened:
 *   killed        — there WAS a live child under this task, and it was told to die.
 *   attemptClosed — true when the attempt finished unwinding inside the cap, false when the
 *                   cap ran out (the row is still closed — the terminal is not negotiable),
 *                   and null when there was nothing to kill, because «did not close» and
 *                   «there was nothing to close» are not the same statement.
 *   cancelled     — the queue closed the row. False is an honest «there was nothing to stop»:
 *                   the queue cannot tell an unknown task from one that is already finished,
 *                   and inventing that distinction here would be a distinction the storage
 *                   does not have.
 *
 * The registry is OPTIONAL exactly as it is at the steering door: a daemon assembled without
 * it still stops rows, it just never claims a kill.
 */
async function handleTaskCancel({ req, res, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.cancelTask !== 'function') return send501(res)
  const body = await readJsonBody(req, { cap: CHAT_BODY_CAP })
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['taskId']))) return undefined
  if (typeof b.taskId !== 'string' || !ID_RE.test(b.taskId)) return send400(res, 'invalid taskId')

  const registry = deps.attemptTurns
  const killed =
    registry && typeof registry.stop === 'function' ? registry.stop(b.taskId) === true : false
  const attemptClosed = killed ? await waitForAttemptClose({ registry, taskId: b.taskId, deps }) : null
  const cancelled = (await adapter.cancelTask(b.taskId)) === true
  return sendJson(res, 200, { cancelled, killed, attemptClosed })
}

/**
 * GET /api/chat/history — the tail of the transcript, oldest first. `?conversationId=`
 * narrows it; `?limit=` is clamped between one turn and CHAT_HISTORY_MAX, so no query can
 * ask for the whole book. The turns are DATA on the way out exactly as they were on the way
 * in: explicit-picked, never interpreted.
 *
 * `?project=` СУЖАЕТ книгу до бесед одного проекта — тем же параметром и тем же разбором
 * (`projectFilter`), которым сужается чтение картины, и по той же причине: экран, открытый на
 * проекте, должен видеть его разговоры и только их. Новой двери для этого не появилось — эта
 * принимала параметры с рождения. Не назвали проект — книга не сужается вовсе: ходы, у которых
 * проекта нет (сказанные до появления поля или при невыбранном проекте), так и остаются
 * читаемыми, не подмешиваясь при этом ни в одну проектную нить.
 */
function handleChatHistory({ res, query, deps }) {
  if (typeof deps.readChatHistory !== 'function') return send501(res)
  const asked = Number(query && query.limit)
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), CHAT_HISTORY_MAX) : CHAT_HISTORY_LIMIT
  const asObj = query && typeof query.conversationId === 'string' ? query.conversationId : ''
  const conversationId = CONVERSATION_ID_RE.test(asObj) ? asObj : undefined
  const project = projectFilter(query)
  let turns = []
  try {
    turns =
      deps.readChatHistory({
        dir: deps.chatDir,
        ...(conversationId ? { conversationId } : {}),
        ...(project ? { project } : {}),
        limit,
        fsImpl: deps.fsImpl,
      }) || []
  } catch {
    turns = [] // an unreadable transcript is an EMPTY conversation, never a 500
  }
  return sendJson(res, 200, { turns: turns.map(pickTurn) })
}

/** Что строка списка бесед вывозит наружу — и ничего сверх того. */
function pickConversation(c) {
  const r = c && typeof c === 'object' ? c : {}
  return {
    id: typeof r.id === 'string' ? r.id : '',
    title: typeof r.title === 'string' && r.title !== '' ? r.title : null,
    lastTs: r.lastTs ?? null,
    turns: Number.isFinite(r.turns) ? r.turns : 0,
    project: typeof r.project === 'string' && r.project !== '' ? r.project : null,
    active: r.active === true,
  }
}

/**
 * GET /api/chat/conversations — БЕСЕДЫ этой книги, свежая первой.
 *
 * Слово владельца 31.08: «может нам разбить разговор на разные чаты? И те которые в процессе
 * условно выполняют что-то, тогда они активные». До этой двери у окна не было способа узнать,
 * какие разговоры вообще были: оно читало ленту и продолжало последнюю нить, а всё остальное
 * сказанное было не выбрать ничем. Дверь считает список ПО КНИГЕ при каждом чтении — второй
 * правды о том, что было сказано, здесь не заводится.
 *
 * `active` — единственное поле не из книги: его приносит реестр живых бесед, общий для окна и
 * для моста телеграма. Реестра нет — поле честно `false` у всех, а не выдуманная точка.
 *
 * `?project=` сужает список тем же разбором (`projectFilter`), что и чтение книги; `?limit=`
 * зажат тем же потолком, так что ни один запрос не просит всю книгу разом.
 */
function handleChatConversations({ res, query, deps }) {
  if (typeof deps.listChatConversations !== 'function') return send501(res)
  const asked = Number(query && query.limit)
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), CHAT_HISTORY_MAX) : CHAT_HISTORY_LIMIT
  const project = projectFilter(query)
  let rows = []
  try {
    rows =
      deps.listChatConversations({
        dir: deps.chatDir,
        ...(project ? { project } : {}),
        limit,
        live: deps.chatLive,
        fsImpl: deps.fsImpl,
      }) || []
  } catch {
    rows = [] // нечитаемая книга — это «бесед нет», никогда не 500
  }
  return sendJson(res, 200, { conversations: rows.map(pickConversation) })
}

/**
 * POST /api/chat/rename — body {conversationId, title}. Имя беседы, данное РУКОЙ.
 *
 * Имя, выведенное из первых слов, — догадка, и она бывает неудачной: разговор часто начинают
 * с «привет» и только потом переходят к делу. Поэтому имя правится рукой, ровно как у проекта
 * (`/api/project/rename`), и хранится отдельно от стенограммы — переименование не является
 * репликой и в промпт свободной ветки не попадает никогда.
 *
 * Пустое имя — это СНЯТЬ своё имя: список возвращается к первым словам разговора. Это не
 * ошибка ввода, а обычное действие, поэтому оно и принимается дверью, а не отвергается.
 */
async function handleChatRename({ req, res, deps }) {
  if (typeof deps.renameChatConversation !== 'function') return send501(res)
  const body = await readJsonBody(req, { cap: CHAT_BODY_CAP })
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['conversationId', 'title']))) return undefined
  if (typeof b.conversationId !== 'string' || !CONVERSATION_ID_RE.test(b.conversationId)) {
    return send400(res, 'invalid conversationId')
  }
  if (b.title !== undefined && b.title !== null && typeof b.title !== 'string') return send400(res, 'invalid title')
  if (typeof b.title === 'string' && b.title.length > CHAT_TEXT_CAP) return send400(res, `title exceeds ${CHAT_TEXT_CAP} chars`)
  let named
  try {
    named = deps.renameChatConversation({
      dir: deps.chatDir,
      conversationId: b.conversationId,
      title: b.title ?? '',
      fsImpl: deps.fsImpl,
    })
  } catch (err) {
    return send400(res, String((err && err.message) || 'rename refused'))
  }
  return sendJson(res, 200, { id: named.id, title: named.title ?? null })
}

// ── the import door: a foreign estate becomes DRAFTS, never a running worker ──
//
// «Переезд за минуты, а не переписывание». The two routes below are a thin door in front
// of import-scanner.mjs and they re-implement NOTHING of it: the collision policy, the
// mapping and the forge's lint all live in the engine. What the door owns is the SHAPE of
// the request — and it owns it strictly, because a foreign definition is THIRD-PARTY TEXT:
//   - NO PATH EVER COMES FROM THE REQUEST. `scan` takes an EMPTY body and `enroll` takes
//     selections only; the estate that is read and the tree drafts land in are BOTH the
//     project this daemon serves. No caller can point the scanner at another
//     directory, so «прочитай мне /etc» is not a validation failure — it has no field.
//   - A BATCH IS BOUNDED AND ITEM-WISE. SELECTIONS_CAP bounds the party; a refusal (a taken
//     name with no rename) travels in the RESPONSE BODY as that item's status, so one bad
//     item can neither bury the batch in a 500 nor stop the rest from landing.
//   - THE HINT SAYS NOTHING. `import.updated` carries a batch id and a count — never a
//     name, never a slug: an open screen learns THAT the drafts moved, not what was in
//     them. What was found is read back through the authed route.
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

// ── the first-run interview: three doors in front of ONE writer ──
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
 * the project's, so it is remembered here and never written into somebody else's tree.
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
 * route table is FROZEN and its size is a guard invariant, so a second way out of
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

// ── the V5.4 growth: declared once, filled one at a time — AND NOW ALL FILLED ──
//
// This is where the still-unfilled slots used to sit: named functions whose whole body was
// `send501(res)`, each one present and auth-gated from the first commit of the release so
// that no screen was ever built against an imagined path, and each one honest about being
// empty rather than carrying a placeholder body a screen could start believing.
//
// There are none left. Every door of the release has its handler, living with its own family
// further down, and the exception list that used to license the stubs has been removed along
// with them (see the note where it was declared). The marker is kept as the record of how the
// batch was grown — declared whole, filled one at a time, never moving the frozen table.

// ══════════════ the release: a gate anybody may run, a publication only a person may ══════════════
//
// THIS IS THE MOST DANGEROUS PAIR OF DOORS IN THE PRODUCT, and everything below is written
// against one sentence: NOTHING LEAVES THIS MACHINE WITHOUT A PERSON, AND A PERSON'S WORD IS
// NOT A CHECKBOX.
//
//   - THE GATE IS RUN BY THE DAEMON, NOT BY A WORKER. Its steps are deterministic verbs with
//     exit codes and machine-readable verdicts, and its receipt is what later unlocks the
//     publication. Putting that run in the task queue would have made a MODEL the author of
//     the verdict that opens the most expensive door here — and «the worker said it was
//     green» is precisely the elevation the queue's own capability rules exist to refuse. So
//     the run happens where the exit codes are read, and the door answers with the report.
//   - THE PUBLICATION HAS TWO LOCKS AND THEY ARE DIFFERENT IN KIND. One is a MACHINE fact —
//     the receipt of a gate run this daemon itself watched go green. The other is a HUMAN
//     fact — the version string, typed out in full, compared against what the machine says it
//     is about to publish. A replayed body has the first and cannot have the second; a person
//     who mistyped the version has the second and learns it before anything moves. Neither
//     lock can be satisfied by merely REACHING this door, which is the property a checkbox
//     never has.
//   - A WORKER HAS NO PATH HERE, STRUCTURALLY. The collaborators are wired into the FRONT's
//     dependency set and nowhere else; the tick is assembled from a different object and
//     names neither of them. This is the same containment the conversation door has, and it
//     is checked by a case rather than promised by this comment.
//   - THE LOCK LIVES WITH WHOEVER RUNS THE THING. A second gate run while one is in flight,
//     and a second publication while one is in flight, are both refused by the collaborator
//     that owns the run — a lock held by anyone else is not a lock.

/**
 * The receipt formats, as WORDS rather than only as assembled strings — the same device the
 * workbench receipts use, so a reader can grep the format instead of an example of it.
 */
export const SHIP_GATE_RECEIPT_FORMAT = 'ship-gate:<run>'
export const SHIP_PUBLISH_RECEIPT_FORMAT = 'ship-publish:<version>@<run>'

/** A gate receipt as it may arrive back on the wire. Narrow by construction: it is a string
 *  THIS daemon issued, and nothing about it needs to be wide. */
const GATE_RECEIPT_RE = /^ship-gate:[A-Za-z0-9._-]{1,64}$/

/** The longest version string this door will compare — a stamp, never a paragraph. */
const VERSION_CAP = 64

/**
 * POST /api/ship/gate — body EMPTY by contract. Run the release gate and report every step.
 *
 * The steps are named by the COLLABORATOR, not here: which checks make up a gate is a
 * property of the project's own runtime, and a door that listed them would be a second
 * opinion about what «green» means. What this door owns is that every step is reported as it
 * finishes — a gate that only spoke at the end would be a spinner with extra steps — and that
 * the report is explicit-picked on the way out.
 */
async function handleShipGate({ req, res, deps }) {
  if (typeof deps.runShipGate !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  if (rejectUnknownKeys(res, body.value || {}, NO_FIELDS)) return undefined

  let run
  try {
    run = await deps.runShipGate({
      // The progress hint. It carries the run and the step and nothing else: an open screen
      // learns WHERE the gate is, and reads the verdict back through this same answer.
      onStep: (s) =>
        emitSafe(deps, {
          event: 'ship.gate',
          taskId: String((s && s.taskId) || ''),
          step: String((s && s.step) || ''),
        }),
    })
  } catch (err) {
    return send409(res, String((err && err.message) || 'the gate did not run'))
  }
  if (run && run.busy === true) {
    return send409(res, `a gate run is already in flight${run.taskId ? ` (${run.taskId})` : ''}`)
  }
  if (!run || typeof run.taskId !== 'string') return send409(res, 'the gate did not run')

  const checks = (Array.isArray(run.checks) ? run.checks : []).map((c) => ({
    step: String((c && c.step) || ''),
    ok: !!(c && c.ok),
    detail: c && typeof c.detail === 'string' && c.detail !== '' ? c.detail : null,
  }))
  const green = run.ok === true
  return sendJson(res, 200, {
    ok: green,
    taskId: run.taskId,
    checks,
    // A RECEIPT ONLY FOR A GREEN RUN. A red run has nothing to hand the publication door, and
    // issuing a receipt «for the record» would put a string in a person's hands whose only
    // possible use is to be pasted into the one field that must not accept it.
    ...(green && run.receipt ? { receipt: String(run.receipt) } : {}),
  })
}

/**
 * POST /api/ship/publish — body {gateReceipt, confirm}. THE DOOR WITH TWO LOCKS.
 *
 * The gate receipt is checked FIRST and against the daemon's own record of what it watched
 * run — never against the string's shape, which anybody can imitate. Only then is the version
 * read and compared, character for character, with what was typed.
 *
 * BOTH REFUSALS ARE 400 AND SAY WHICH LOCK HELD. That is deliberate: this is not a place to
 * be coy. A person who pasted a stale receipt or mistyped a version needs to know which of
 * the two happened, and neither fact tells an attacker anything they could not learn by
 * looking at the release they are trying to publish.
 */
async function handleShipPublish({ req, res, deps }) {
  if (typeof deps.publishRelease !== 'function' || typeof deps.verifyGateReceipt !== 'function') {
    return send501(res)
  }
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['confirm', 'gateReceipt']))) return undefined

  const gateReceipt = b.gateReceipt
  if (typeof gateReceipt !== 'string' || !GATE_RECEIPT_RE.test(gateReceipt)) {
    return send400(res, 'gateReceipt must be the receipt of a green gate run')
  }
  const confirm = b.confirm
  if (typeof confirm !== 'string' || confirm.length > VERSION_CAP) {
    return send400(res, 'confirm must be the exact version string')
  }

  // ── LOCK ONE: a green run of the gate, as THIS daemon watched it ──
  let verdict
  try {
    verdict = deps.verifyGateReceipt(gateReceipt)
  } catch {
    verdict = null
  }
  if (!verdict || verdict.green !== true) {
    return send400(res, String((verdict && verdict.reason) || 'that receipt does not name a green gate run'))
  }

  // ── LOCK TWO: the version, typed out, matching what this machine states ──
  let version = null
  try {
    version = typeof deps.releaseVersion === 'function' ? deps.releaseVersion() : null
  } catch {
    version = null
  }
  if (typeof version !== 'string' || version === '') {
    return send409(res, 'this machine does not state a version — there is nothing to publish')
  }
  if (confirm !== version) return send400(res, 'confirm must be the exact version string being published')

  let result
  try {
    result = await deps.publishRelease({ version, gateReceipt })
  } catch (err) {
    return send409(res, String((err && err.message) || 'the release was not published'))
  }
  if (result && result.busy === true) return send409(res, 'a publication is already in flight')
  if (!result || result.ok !== true) {
    return send409(res, String((result && result.reason) || 'the release was not published'))
  }

  emitSafe(deps, { event: 'ship.published', version })
  return sendJson(res, 200, {
    ok: true,
    version,
    receipt: String(result.receipt || `ship-publish:${version}@${gateReceipt.slice('ship-gate:'.length)}`),
  })
}

// ══════════ watching one attempt, and asking one question of every corpus ══════════
//
// TWO DOORS THAT SHARE A POSTURE: both answer with things a WORKER produced or a CORPUS
// holds, and neither of them interprets what it carries.
//
//   - THE LOG LINE IS WORKER OUTPUT AND IS NEVER TREATED AS ANYTHING ELSE. It is stored
//     verbatim, returned verbatim, and rendered as TEXT by whatever shows it. This door does
//     not strip markup out of it and makes no claim that it is safe — three places in the
//     code already say so, and this is the fourth, because this is where it leaves the
//     process.
//   - THE SESSION IDENTIFIER DOES NOT TRAVEL. It sits on the attempt's LEDGER row for audit
//     and has no business on a screen; the payload here is an explicit pick, and a case
//     checks the BYTES of the answer rather than the shape of an object.
//   - THE QUESTION IS DATA. `q` crosses this boundary toward five corpora at once, so it is
//     bounded before it goes anywhere and it is a PARAMETER on every path beneath (the
//     lexical layer binds it, never concatenates it). A question longer than the cap is a
//     400 rather than a silent truncation: a box that quietly searched for half of what was
//     typed would report «ничего не найдено» about a question nobody asked.

/** The longest question this door will carry — the same number the projection layer caps at. */
const SEARCH_Q_CAP = 256

/**
 * GET /api/attempt/:id — the tail of one attempt's live log, the worker's own note, who was in
 * the session, and the roll-up of everything the attempt did (both counted over the whole log,
 * not over the tail).
 *
 * `?tail=` asks for a length and the LEDGER owns the ceiling: the reader clamps into
 * [1, 1000] itself, so this door hands the asked-for number over as it is rather than
 * growing a second, quietly different limit beside the real one.
 *
 * An attempt with no log yet answers an EMPTY log — a worker that has not printed anything is
 * a normal state of a running attempt, not a 404. What IS a 404 is nothing here: this door
 * cannot tell an attempt that never existed from one that has been silent, and inventing the
 * difference would make the answer an existence oracle over the queue.
 */
function handleAttempt({ res, params, query, config, deps }) {
  const ledger = deps.ledger
  if (!ledger || typeof ledger.readAttemptLog !== 'function') return send501(res)
  const attemptId = String((params && params.id) || '')

  let log
  try {
    log = ledger.readAttemptLog({ attemptId, tail: query && query.tail })
  } catch {
    log = null // an unreadable transcript is an EMPTY one, never a 500
  }
  const rows = Array.isArray(log && log.entries) ? log.entries : []
  const note = log && log.note && typeof log.note.approach === 'string' ? log.note.approach : null

  // WHICH DELEGATION A LINE BELONGS TO, without letting the identifier out.
  //
  // The stored row carries the opaque parent id the vendor put on the frame. A person does
  // not need that string and should never be shown it — but they DO need to know that these
  // eleven lines came from ONE subagent and the next four from another, or a delegated burst
  // reads as the parent talking to itself. So the id is turned into a small ordinal, counted
  // in the order the groups first appear in this window, and only the ordinal travels.
  const groupOf = new Map()
  for (const r of rows) {
    const pid = r && typeof r.parentId === 'string' ? r.parentId : ''
    if (!pid || groupOf.has(pid)) continue
    groupOf.set(pid, groupOf.size + 1)
  }

  return sendJson(res, 200, {
    // explicit pick: the stored row also carries an opaque parent id, and a screen that
    // shows «делегировано» needs the FACT, not the identifier behind it. `summary` — the
    // sentence a person reads instead of a machine frame — travels when the row has one; it
    // was bounded at the storage door and is passed on as the data it is.
    lines: rows.map((r) => {
      const pid = r && typeof r.parentId === 'string' ? r.parentId : ''
      const group = pid ? groupOf.get(pid) : undefined
      return {
        ts: String((r && r.ts) || ''),
        line: String((r && r.line) || ''),
        subagent: r && r.subagent === true,
        ...(group ? { group } : {}),
        // THE CUT TRAVELS WITH THE ROW. An explicit pick is a filter, and a fact computed at
        // the storage door that this pick does not name reaches nobody: the row would arrive
        // looking exactly like a line that simply ended there. Two fields, both numbers or
        // booleans, and only on a row that really was cut.

        ...(r && r.truncated === true ? { truncated: true } : {}),
        ...(r && Number.isFinite(r.originalLength) ? { originalLength: r.originalLength } : {}),
        ...(Array.isArray(r && r.summary) && r.summary.length ? { summary: r.summary } : {}),
      }
    }),
    truncated: !!(log && log.truncated),
    note,
    // WHO WAS IN THE SESSION — the executor first, then each delegation, with the model, the
    // length and the one line about what it was doing. Counted by the ledger over the WHOLE
    // attempt (like the roll-up below, and for the same reason), and forwarded here as the data
    // it is. Every field of it was already being computed off the stored frame summaries and
    // reached nobody: the card had no tree to draw and the log stayed a flat wall of lines.
    roles: Array.isArray(log && log.roles) ? log.roles : [],
    rolesMore: Number.isFinite(log && log.rolesMore) ? log.rolesMore : 0,
    // The roll-up of the WHOLE attempt, not of the window above it: the ledger counts it over
    // every row before the tail is taken, so «инструментов 40 · изменено 6 файлов» stays true
    // on a transcript whose beginning did not fit. Bounded where it is built; passed on here
    // as the data it is, like every other thing on this payload.
    digest: (log && log.digest) || null,
    // ЧЕГО СТОИЛА ИМЕННО ЭТА ПОПЫТКА — четыре числа поставщика из её квитанции, прочитанные
    // ТЕМ ЖЕ кодом и по тому же выражению пути, каким их читает карточка задачи. Экран лога
    // показывает попытку в подробностях, и расход — такая же её подробность, как инструменты
    // и роли рядом; без него человек читает, ЧТО было сделано, и не видит, во что это встало.
    //
    // `null` — «попытка об этом молчит» (кадра не было, каталог подмели, попытка старше поля);
    // выдуманные нули на этом месте назвали бы бесплатной работу, которую никто не измерял.
    tokens: readRunTokens({
      // ИЗ ДЕРЕВА КОДА: каталоги прогонов лежат там, а не в доме планирования — см. taskTreeDir.
      dir: attemptRunDir({ runsDir: runsDirOf(codeTreeDir(deps) ?? (config || {}).repoDir), attemptId }),
      fsImpl: deps.fsImpl,
    }),
  })
}

/**
 * GET /api/search?q= — one question, every corpus.
 *
 * An empty question is an empty answer and costs nothing: no reader is touched. An
 * over-long one is a 400 — see the section note above on why it is not silently cut.
 */
async function handleSearch({ res, query, deps }) {
  if (!deps.search || typeof deps.search.search !== 'function') return send501(res)
  const q = typeof (query && query.q) === 'string' ? query.q : ''
  if (q.length > SEARCH_Q_CAP) return send400(res, `q must be at most ${SEARCH_Q_CAP} characters`)
  if (!q.trim()) return sendJson(res, 200, { hits: [] })

  let answer
  try {
    answer = await deps.search.search(q)
  } catch {
    answer = null // one bad corpus is not an error page; the projection is fail-open itself
  }
  const hits = Array.isArray(answer && answer.hits) ? answer.hits : []
  return sendJson(res, 200, {
    hits: hits.map((h) => ({
      kind: String((h && h.kind) || ''),
      title: String((h && h.title) || ''),
      hint: String((h && h.hint) || ''),
      ref: h && h.ref && typeof h.ref === 'object' ? h.ref : {},
    })),
  })
}

// ══════════════ the conveyor of phases: start a stage, read a card ══════════════
//
// A STAGE IS WORK IN THE QUEUE, NOT A REQUEST HANDLER. Pressing «начать обсуждение» puts a
// task in the paperwork lane and returns; the tick claims it, a worker runs the stage, and the
// daemon's own exit gate decides whether it finished. Nothing about a phase happens inside an
// HTTP request — which is what makes a stage started from this window and a stage started in a
// terminal the same event, resumable, inspectable and interruptible in exactly the same way.
//
// THE COMMAND IS DATA, AND THE DICTIONARY IS FROZEN — AND IT NO LONGER LIVES HERE. The door
// does not compose an instruction out of anything a person typed: it LOOKS UP one of four
// constants and substitutes the phase, whose grammar is bounded and cannot begin with a dash.
// That is the whole of the assembly, and it now happens in `policy/phase-cycle.mjs`.
//
// WHY THE DICTIONARY MOVED OUT. The runner needs the same four strings, to turn a stage into
// the session's prompt without reading the command off a task's TITLE — a field that can be
// edited, restored or written by some other path, and therefore cannot be trusted to become a
// bare instruction. Importing this web server into the worker path to reach the table would
// have been the wrong direction; a shared frozen module is the right one. Both callers now go
// through the same `stageCommand`, and the suite pins their outputs equal byte for byte.
//
// NO PATH TO AUTO-MODE EXISTS, BY CONSTRUCTION — the guard moved with the dictionary and is
// applied inside `stageCommand`, so neither caller can assemble a command around it.

/** Re-exported for the tests and readers that have always asked this module for the table. */
export { STAGE_COMMANDS }

/**
 * Which exit gate a stage's work is judged by: `execute` produces CODE and rides the reverify
 * receipt; the other three produce a DOCUMENT and ride the artefact gate. The word is the
 * queue's own frozen vocabulary, and the tick reads it off the task's `data` envelope.
 */
const EXECUTE_STAGE = 'execute'
const stageKind = (stage) => (stage === EXECUTE_STAGE ? 'code' : 'document')

/** The lane every stage of the phase cycle rides. There is no second lane and no new one. */
const STAGE_LANE = 'paperwork'

// `stageCommand`, `PHASE_RE` and the automation guard are imported from policy/phase-cycle.mjs
// — see the note above the route section. The door validates the request; the module owns the
// command, so the runner cannot end up with a different one.

/** A row that is still in play: nobody may start the same stage of the same phase twice. */
const LIVE_STATUSES = Object.freeze(['queued', 'claimed', 'awaiting_approval'])

/** Ступень, чей чертёж обязан быть подтверждён до того, как кто-то начнёт писать код. */
const DESIGN_STAGE = 'design'

/**
 * КУДА ВЕДЁТ ЕДИНСТВЕННОЕ ОБРАТНОЕ РЕБРО ГРАФА ФАЗ — и почему оно одно.
 *
 * Дорога фазы идёт вперёд, и каждая ступень закрывается своим документом. Ровно одна беда не
 * чинится вперёд: чертёж нельзя нарисовать по плану, в котором нужного экрана нет. Это дыра
 * ПЛАНА, и починить её может только планирование. Все прочие «назад» — не возвраты, а новые
 * стадии, и у них есть своя дверь; ребро, умеющее вести куда угодно, было бы произвольным
 * перенаправлением стадий с ключом тела вместо решения.
 */
const BACK_EDGE_TO_STAGE = 'plan'

/**
 * СЛОВА, КОТОРЫМИ ПРАВДА НАЗЫВАЕТ ОДИН ФАКТ: «человек сказал да этой работе».
 *
 * Их два, и это не небрежность, а форма продукта. Закрытый словарь статуса СТРОКИ ОЧЕРЕДИ
 * своими словами говорит `completed` — «a person said yes»; долговечная очередь переводит
 * принятую строку приёмки ровно туда и собственное слово таблицы попыток наружу НЕ выпускает
 * (её `statusOf` держит закрытый словарь из пяти). Слово `approved` живёт в таблице попыток,
 * куда CAS-ит дверь приёмки, и приходит сюда только в чтениях, которые её видят.
 *
 * Ворота, знающие лишь слово таблицы, отказывали бы КАЖДОМУ честно подтверждённому чертежу в
 * бою — очередь этого слова не произносит. Ворота, знающие лишь слово очереди, ослепли бы на
 * чтении, которое несёт слово таблицы. Поэтому принимаются оба, и БОЛЬШЕ НИКАКИЕ: «сделана,
 * ждёт решения» — не «принята», и это ровно та разница, ради которой ступень существует.
 */
const APPROVED_STATUSES = Object.freeze(['completed', 'approved'])

/** Когда строка встала в очередь — в миллисекундах, чем бы бэкенд ни записал этот момент. */
function enqueuedMsOf(row) {
  const v = row && row.enqueuedAt
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const parsed = Date.parse(String(v ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Живая строка ступени фазы, или `undefined`. ОДНО правило «эта стадия уже идёт» на обе двери,
 * которые его задают: дверь диспатча (второй работник писал бы те же документы из другого
 * каталога) и обратное ребро возврата, которое ставит стадию тем же способом.
 */
function liveStageRow(rows, stage, phase) {
  return (Array.isArray(rows) ? rows : []).find((r) => {
    const d = r && r.data
    return d && d.stage === stage && String(d.phase ?? '') === phase && LIVE_STATUSES.includes(r.status)
  })
}

/** Строки одной ступени одной фазы — по КОНВЕРТУ, никогда по названию, которое можно набрать. */
function stageRowsOf(rows, stage, phase) {
  const all = Array.isArray(rows) ? rows : []
  return latestRowPerId(
    all.filter((r) => {
      const d = r && r.data
      return d && d.stage === stage && String(d.phase ?? '') === phase
    }),
  )
}

/**
 * Свежейшая строка ступени, или `null`, если таких строк нет.
 *
 * ПРИ РАВНОМ ШТАМПЕ ПОБЕЖДАЕТ НЕПОДТВЕРЖДЁННАЯ. Две строки одной миллисекунды — случай
 * редкий, но ворота обязаны ошибаться в сторону отказа: «не смогли различить» и «подтверждено»
 * — разные новости, и вторая открывает исполнение.
 */
function freshestStageRow(rows) {
  return rows.reduce((best, r) => {
    if (best === null) return r
    const d = enqueuedMsOf(r) - enqueuedMsOf(best)
    if (d > 0) return r
    if (d < 0) return best
    return APPROVED_STATUSES.includes(best.status) ? r : best
  }, null)
}

/**
 * ВОРОТА ИСПОЛНЕНИЯ: «подтверждаем чертёж и только потом пишем код» — сказанное дверью.
 *
 * Возвращает строку причины отказа или `null`, если открыто. Спрашиваются ДВА уже
 * существующих источника, и ни у одного не заводится второй копии:
 *
 *   · ОЧЕРЕДЬ — свежейшая строка ступени рисования этой фазы. Есть и подтверждена → открыто;
 *     есть и не подтверждена → закрыто, и отказ называет её фактический статус. Отсюда же
 *     сама собой берётся новая версия чертежа: свежая строка поверх старой принятой снова
 *     закрывает исполнение, потому что свежейшая теперь она.
 *   · ПРОЕКЦИЯ СТУПЕНЕЙ — только когда строк нет вовсе. Читается тем же деривом, которым
 *     живёт карточка фазы, поэтому правило «какой каталог у фазы N» остаётся одно на продукт.
 *     Слово `skipped` значит «фаза шла ещё до того, как ступень появилась» — её задним числом
 *     не запирают. Любое другое слово — отказ.
 *
 * FAIL-CLOSED ВЕЗДЕ: нет дерева, нет дерива, фаза не найдена, чтение бросило — закрыто.
 * Конфиг-ключа, открывающего обход, не существует: единственный способ открыть ворота — это
 * подтверждённый чертёж или честный признак, что фаза старше самой ступени.
 */
function designGateRefusal({ rows, phase, deps }) {
  const designRows = stageRowsOf(rows, DESIGN_STAGE, phase)
  if (designRows.length > 0) {
    const freshest = freshestStageRow(designRows)
    if (APPROVED_STATUSES.includes(freshest.status)) return null
    return (
      `дизайн фазы "${phase}" не подтверждён — исполнение не стартует ` +
      `(свежайшая строка рисования: ${freshest.status})`
    )
  }

  const closed = `дизайн фазы "${phase}" не подтверждён — исполнение не стартует (чертежа фазы нет)`
  if (typeof deps.derivePhaseCard !== 'function') return closed
  const projectDir = phaseCycleDir(deps)
  if (!projectDir) return closed
  let card = null
  try {
    card = deps.derivePhaseCard({ projectDir, phaseId: phase, fsImpl: deps.fsImpl })
  } catch {
    return closed
  }
  const design = card && card.stages ? card.stages[DESIGN_STAGE] : null
  if (design === 'skipped') return null
  return closed
}

/**
 * WHERE THE PHASE CYCLE LIVES — decided by the composition root, read here.
 *
 * This used to answer `deps.repoDir`, the tree the daemon SERVES, with a reason that still
 * holds: the tick stands a documentary stage in one root and its exit gate looks for the
 * stage's document under that same root, so a card reading a DIFFERENT directory would show a
 * stage as never started while the daemon was completing it. One root, one truth. It also said
 * that moving the cycle to the CONNECTED project would be «one change in the tick and this
 * function, not a disagreement to live with». That change is now made — for the reason the
 * abstract argument could not see: on a real installation the served tree is the product and
 * the phases live in the workshop beside it, so the screen honestly listed ZERO phases while
 * twelve sat one directory away.
 *
 * The root supplies `phaseCycleDir` and hands the tick the SAME expression, so the pair cannot
 * drift. `repoDir` stays the fallback for a daemon wired without it — an older composition, or
 * a test that injects only the served tree.
 */
function phaseCycleDir(deps) {
  if (typeof deps.phaseCycleDir === 'function') {
    const chosen = deps.phaseCycleDir()
    if (typeof chosen === 'string' && chosen.trim() !== '') return chosen
  }
  return typeof deps.repoDir === 'string' && deps.repoDir.trim() !== '' ? deps.repoDir : null
}

/**
 * ДЕРЕВО КОДА ПОДКЛЮЧЁННОГО ПРОЕКТА — второй половине окна.
 *
 * `phaseCycleDir` выше отвечает домом планирования: там лежат фазы, беклог и дорожная карта.
 * Но ветки задач, их коммиты, различия и каталоги прогонов живут ТАМ, ГДЕ РАБОТАЕТ РАБОТНИК —
 * в дереве кода, и в двухрепном доме это другой каталог. Одно выражение на оба вопроса было бы
 * ровно тем дефектом, который этот файл уже дважды чинил: «карточка читает одно дерево, а
 * работа идёт в другом».
 *
 * Композиция без второго выражения (старый корень, тест, впрыснувший только фазовый каталог)
 * получает ПРЕЖНИЙ ответ: один адрес на всё. Поэтому запасной путь — `phaseCycleDir`, а не
 * `repoDir`: он уже несёт всю прежнюю логику падения к обслуживаемому дереву.
 */
function codeTreeDir(deps) {
  if (typeof deps.codeTreeDir === 'function') {
    const chosen = deps.codeTreeDir()
    if (typeof chosen === 'string' && chosen.trim() !== '') return chosen
  }
  return phaseCycleDir(deps)
}

/**
 * taskTreeDir({config, deps, row}) → ДЕРЕВО КОДА проекта этой строки.
 *
 * АДРЕС БЕРЁТСЯ У ЗАДАЧИ И ЕЁ ПРОЕКТА, А НЕ У ВЫБРАННОГО В ОКНЕ. Строка знает свой проект
 * (штамп ставит дверь постановки), проект знает свои адреса — и этого достаточно, чтобы
 * карточка перестала зависеть от того, на что человек в этот момент смотрит. Здесь живут
 * каталоги прогонов задачи: у проекта ОДИН журнал прогонов, а не по одному на адрес.
 *
 * Строки нет, штампа нет, проект неизвестен — прежний ответ: подключённое дерево кода.
 */
function taskTreeDir({ config, deps, row }) {
  return codeTreeOf(projectEntry(config || {}, row && row.project)) ?? codeTreeDir(deps)
}

/**
 * taskBranchTree({config, deps, row}) → дерево, в котором лежит ВЕТКА этой строки.
 *
 * Замерено 31.08: приёмка готовой работы продукта при подключённой мастерской вернула
 * `branch_missing` — ветка была на месте, но git спрашивали не в том дереве. «Подключённый
 * проект» это то, на что человек СМОТРИТ; ветка лежит там, где работа ШЛА.
 *
 * КАКОЙ ИЗ ДВУХ АДРЕСОВ — по роду работы, и правило это то же самое, каким копию отводил тик
 * (loop.mjs, attemptTreeDir). Кодовая работа режется из дерева кода; документарная ступень
 * фазы — из дома планирования, потому что там лежит `.planning`, который она правит. Два
 * разных правила на «где завели» и «где искать» означали бы, что приёмка не находит ровно ту
 * работу, которую сама же и заказала.
 */
function taskBranchTree({ config, deps, row }) {
  const entry = projectEntry(config || {}, row && row.project)
  if (entry) {
    const dir = isDocumentaryRow(row) ? planningHomeOf(entry) : codeTreeOf(entry)
    if (dir) return dir
  }
  return codeTreeDir(deps)
}

/** Строка ДОКУМЕНТАРНОЙ ступени фазы: её работа — документ в `.planning`, а не код. */
function isDocumentaryRow(row) {
  const data = row && row.data
  const stage = data && typeof data === 'object' ? data.stage : null
  return typeof stage === 'string' && stage !== '' && stageKind(stage) === 'document'
}

/** Одна строка очереди по идентификатору, свёрнутая тем же правилом, что и карточка. */
async function rowById(deps, taskId) {
  const adapter = deps && deps.adapter
  if (!taskId || !adapter || typeof adapter.list !== 'function') return null
  try {
    const rows = (await adapter.list({})) || []
    return latestRowPerId(rows.filter((r) => r && r.id === taskId))[0] || null
  } catch {
    return null
  }
}

/**
 * stageHomeRefusal({config, deps, phase}) → предложение, которым дверь ОТКАЗЫВАЕТ поставить
 * ступень, или null, если ставить есть куда.
 *
 * ОТКАЗ ДО РАСХОДА, А НЕ ПОСЛЕ. Ступень фазы работает в ДОМЕ ПЛАНИРОВАНИЯ своего проекта —
 * во втором его адресе. Когда адреса нет или названной фазы в нём нет, работник узнавал об
 * этом изнутри копии: замерено 31.08 — ступень plan фазы 21 получила копию продукта, где
 * каталогов фаз нет, ушла искать фазу по машине, нашла ЧУЖУЮ фазу 21 соседнего проекта и
 * честно отказалась. Восемнадцать ходов и около доллара за предложение, которое можно
 * составить здесь бесплатно.
 *
 * ОТКАЗ НАЗЫВАЕТ, КАКОГО АДРЕСА НЕ ХВАТАЕТ, — иначе он не отличается от поломки.
 *
 * НИЧЕГО НЕ ВЫДУМЫВАЕТСЯ. Проверять нечем (нет проекции фаз) или негде (проект не назвал ни
 * одного каталога, а демон обслуживает дерево) — молчание и прежнее поведение: «я не смотрел»
 * и «этого нет» разные предложения, и отказывать по первому значило бы закрыть дверь на
 * установке, где фазы просто лежат в обслуживаемом дереве.
 */
function stageHomeRefusal({ config, deps, phase }) {
  const stamped = doorProjectEntry(config)
  const entry = stamped ? projectEntry(config, stamped.id) : null
  const dir = (entry ? planningHomeOf(entry) : null) ?? phaseCycleDir(deps)
  // НАЗВАН ЛИ ВТОРОЙ АДРЕС — читается с записи, а не выводится из `dir`: дом планирования без
  // второго адреса ОТВЕЧАЕТ деревом кода, и отказ, спутавший эти два случая, послал бы человека
  // искать фазу не там, где её нет.
  const named = !!(entry && typeof entry.planningPath === 'string' && entry.planningPath.trim() !== '')
  const who = stamped ? `«${stamped.name}»` : 'проекта'
  // СМОТРЕТЬ НЕГДЕ ИЛИ НЕЧЕМ — значит НЕ СМОТРЕЛИ, и отказывать не на что: «я не заглядывал» и
  // «этого там нет» разные предложения, а отказ по первому закрыл бы дверь на всякой установке,
  // где проекции фаз просто не подключено.
  if (!dir || typeof deps.derivePhaseCard !== 'function') return null
  let card = null
  try {
    card = deps.derivePhaseCard({ projectDir: dir, phaseId: phase, fsImpl: deps.fsImpl })
  } catch {
    return null // проекция не ответила — это не доказательство отсутствия фазы
  }
  if (card) return null
  if (named) return `фазы "${phase}" нет в доме планирования ${who}: каталога .planning/phases с этой фазой там нет`
  const looked = codeTreeOf(entry) ? 'дерево кода' : 'обслуживаемое демоном дерево'
  return (
    `фазы "${phase}" нет у ${who}, а ВТОРОЙ АДРЕС — дом планирования — не задан: смотрели в ${looked}. ` +
    `Назовите каталог, в котором лежит .planning этого продукта`
  )
}

/**
 * POST /api/phase/stage — body {phase, stage}. Start one stage of one phase.
 *
 * The row is minted like any other: `S-<epochMs>`, source `roster` (a person pressed it, so it
 * is founder-explicit and DoR-exempt), lane `paperwork`, and the `data` envelope {kind, stage,
 * phase} the tick reads to pick which gate judges the work. A stage already in play answers
 * 409 rather than queueing a second one — two workers running the same stage of the same phase
 * would write the same documents from two directories.
 */
async function handlePhaseStage({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['phase', 'stage']))) return undefined

  const stage = b.stage
  if (typeof stage !== 'string' || !TASK_STAGES.includes(stage)) {
    return send400(res, `stage must be one of ${TASK_STAGES.join('|')}`)
  }
  const phase = b.phase === undefined || b.phase === null ? '' : String(b.phase)
  if (!PHASE_RE.test(phase)) return send400(res, 'invalid phase')

  // ALREADY RUNNING? The envelope is what identifies a stage row, so this asks the queue the
  // same question the tick answers from — never a name or a title, which a person can retype.
  const rows = typeof adapter.list === 'function' ? await adapter.list({}) : []
  if (liveStageRow(rows, stage, phase)) {
    return send409(res, `stage "${stage}" of phase "${phase}" is already running`)
  }

  // ЕСТЬ ЛИ У ЭТОЙ ФАЗЫ ДОМ — спрошено ДО постановки, потому что цена ошибки платится ПОСЛЕ.
  const homeless = stageHomeRefusal({ config, deps, phase })
  if (homeless) return send409(res, homeless)

  // И ТОЛЬКО ПОТОМ — ВОРОТА ЧЕРТЕЖА. Ровно одна ступень их проходит, и ровно поэтому они
  // стоят здесь, в двери диспатча: другого пути поставить исполнение фазы у продукта нет,
  // так что обойти их нельзя, не написав второй такой двери.
  if (stage === EXECUTE_STAGE) {
    const refusal = designGateRefusal({ rows, phase, deps })
    if (refusal) return send409(res, refusal)
  }

  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const task = {
    id: `S-${clock()}`,
    source: 'roster',
    // A stage is work OF a project, and which one is known only here — see doorProject.
    ...doorProject(config),
    // THE COMMAND RIDES AS THE TASK'S OWN TEXT. It is a constant of this file with one bounded
    // substitution — never anything a person composed — and it is the whole instruction: what
    // the stage should do about the phase is written down in the workflow, not in this door.
    title: stageCommand(stage, phase),
    lane: STAGE_LANE,
    data: { kind: stageKind(stage), stage, phase },
  }
  let norm
  try {
    norm = validateTask(task)
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid task'))
  }
  const enq = await enqueueOrExplain(res, adapter, norm)
  if (enq.answered) return undefined
  emitSafe(deps, { event: 'phase.stage', taskId: norm.id, phase, stage })
  return sendJson(res, 200, { ok: true, taskId: norm.id, phase, stage })
}

/**
 * GET /api/phase/:id — one phase card, or the whole index under the reserved segment.
 *
 * Both are DERIVES over the phase directory (derive-never-store), injected like every other
 * read model so this file carries no build edge onto state.mjs. A phase the project does not
 * have is a 404: the index is how a screen learns which ids exist.
 */
async function handlePhaseCard({ res, params, deps }) {
  const id = String((params && params.id) || '')
  const projectDir = phaseCycleDir(deps)

  if (id === PHASE_INDEX_SEGMENT) {
    if (typeof deps.derivePhaseIndex !== 'function') return send501(res)
    return sendJson(res, 200, deps.derivePhaseIndex({ projectDir, fsImpl: deps.fsImpl }))
  }
  if (typeof deps.derivePhaseCard !== 'function') return send501(res)
  const card = deps.derivePhaseCard({
    projectDir,
    phaseId: id,
    fsImpl: deps.fsImpl,
    // The rows a question's answer might have to WAKE. Read here because this is the half of
    // the program that holds the queue; matched to the phase inside the derive, which owns the
    // one rule for «which directory is phase N». A queue that cannot be read costs the card its
    // task ids and nothing else — the questions still render and the answers still record.
    parkedRows: await parkedRowsOf(deps),
    // ЧЬЯ РАБОТА ЭТА ФАЗА — все строки очереди, из которых карточка сложит её расход. Читаются
    // здесь по той же причине, что и припаркованные: очередь есть у двери, а не у проекции.
    // Очередь, которая не читается, стоит карточке суммы и ничего больше.
    taskRows: await allRowsOf(deps),
  })
  if (!card) return send404(res)
  return sendJson(res, 200, card)
}

// ══════════ ПАПКА ФАЗЫ: её каталог на диске, читаемый из окна и только читаемый ══════════
//
// ЗАЧЕМ ЭТА ДВЕРЬ, КОГДА РЯДОМ ЕСТЬ ДВЕРЬ ДОКУМЕНТА. Дверь документа открывает файл, ИМЯ
// которого уже назвала карточка: планы, итоги, приёмка — то, что проекция умеет узнавать. Всё
// остальное, что фаза оставила в своём каталоге, для окна не существовало вовсе, и человек шёл
// смотреть это в терминал. Эта дверь отвечает на другой вопрос — «что вообще лежит в папке
// фазы» — и отвечает списком, а не догадкой проекции о том, какой файл важен.
//
// ОДИН КОРЕНЬ, И ЭТО КАТАЛОГ ОДНОЙ ФАЗЫ. Не проект, не `.planning/` целиком — ровно
// `.planning/phases/<каталог этой фазы>`. Какой каталог за номером фазы — знает `findPhaseDir`,
// тот же, которым это знает карточка и выходные ворота демона; второго ответа здесь не заводится.
//
// ТОЛЬКО ЧТЕНИЕ. Здесь нет записи, нет удаления и нет ветки, которая могла бы их получить: дверь
// умеет отдать дерево и отдать один файл текстом, и ничего третьего в ней не написано.
//
// ЗАМОК СТОИТ ТРИЖДЫ, И КАЖДАЯ ПРОВЕРКА ЛОВИТ СВОЁ. По ТЕКСТУ (нет сегмента `..`, нет ведущей
// косой, нет буквы диска, нет нулевого байта), по РАЗРЕШЁННОМУ пути (он обязан остаться внутри
// корня — сравнение по границе разделителя, чтобы сосед с похожим началом имени не прошёл) и по
// НАСТОЯЩЕМУ пути (`realpath` обоих концов: ссылка наружу разрешается наружу и на этом ловится —
// текстовая проверка о ней не знает в принципе). Отказ всегда ОДИН И ТОТ ЖЕ 400: вызывающий
// узнаёт, что путь не принят, и ничего о том, как устроен диск за дверью.

/** Где живут каталоги фаз под проектом — в той же прямой косой, что и у соседних дверей. */
const PHASE_FOLDER_ROOT = '.planning/phases'

/** Файл, который человек читает глазами, — не груз: после этого потолка это уже не документ. */
const PHASE_FILE_MAX_BYTES = 512 * 1024
const PHASE_FILE_PATH_CAP = 512

/**
 * Сколько записей несёт одно дерево и как глубоко оно ходит.
 *
 * Каталог фазы — это десятки файлов, а не тысячи; потолки стоят не потому, что кто-то ждёт
 * тысячу, а потому что ответ, размер которого задаёт содержимое диска, — это не ответ. Дерево,
 * упёршееся в потолок, говорит об этом полем `truncated`, а не молча обрывается: «показано не
 * всё» и «больше ничего нет» — разные факты, и окно обязано различать их словами.
 */
const PHASE_TREE_MAX_ENTRIES = 400
const PHASE_TREE_MAX_DEPTH = 6

/**
 * Файловая поверхность папки фазы: настоящая fs в бою, подставная в тестах.
 *
 * ЧЕСТНО ПРО ПОДСТАВНОЙ ШОВ. Шов, который не умеет отличить ссылку от файла, отвечает обычным
 * `stat`, а шов, который не умеет разрешить ссылку, отвечает самим путём. Это не дыра: ссылка
 * существует только на НАСТОЯЩЕМ диске, и там оба вопроса всегда заданы настоящей fs, — а
 * текстовая проверка и проверка разрешённого пути стоят при любом шве.
 */
function phaseFolderIo(deps) {
  const io = (deps && deps.fsImpl) || null
  return {
    readdirSync: (io && io.readdirSync) || fsReaddirSync,
    statSync: (io && io.statSync) || fsStatSync,
    readFileSync: (io && io.readFileSync) || fsReadFileSync,
    lstatSync: (io && (io.lstatSync || io.statSync)) || fsLstatSync,
    realpathSync: (io && io.realpathSync) || (io ? (p) => p : fsRealpathSync),
  }
}

/** Путь `p` лежит в корне `root` или сам им является — сравнение по границе разделителя. */
function insideRoot(root, p) {
  return p === root || p.startsWith(`${root}/`) || p.startsWith(`${root}\\`)
}

/**
 * safePhaseFilePath(io, root, rel) → путь, который можно открыть, или null.
 *
 * `null` — ЕДИНСТВЕННОЕ значение отказа: какое именно правило нарушено, остаётся делом этой
 * функции и никогда не становится ответом вызывающему.
 *
 * Ненайденный путь отказом ЗДЕСЬ не считается: `realpath` не может сказать о несуществующем
 * файле, снаружи он или внутри, и превращать «нет такого файла» в «путь не принят» значило бы
 * отвечать 400 на честную опечатку. Такой путь идёт дальше и умирает на `stat` как 404.
 */
function safePhaseFilePath(io, root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > PHASE_FILE_PATH_CAP) return null

  const path = rel.replace(/\\/g, '/')
  if (path.split('/').includes('..')) return null // сегмент обхода, в любом написании
  if (path.startsWith('/') || isAbsolute(rel) || /^[A-Za-z]:/.test(path)) return null
  if (path.includes('\0')) return null

  const rootResolved = resolvePath(root)
  const full = resolvePath(root, path)
  if (!insideRoot(rootResolved, full)) return null

  // третья проверка — по НАСТОЯЩИМ путям обоих концов. Корень разрешается тоже: временный
  // каталог сам бывает ссылкой, и сравнение настоящего пути с ненастоящим корнем отказывало бы
  // всему подряд там, где ничего плохого не происходит.
  let realRoot = null
  let realFull = null
  try {
    realRoot = io.realpathSync(rootResolved)
    realFull = io.realpathSync(full)
  } catch {
    realRoot = null
    realFull = null
  }
  if (realRoot !== null && realFull !== null && !insideRoot(realRoot, realFull)) return null

  return join(root, path)
}

/** Каталоги раньше файлов, внутри — по имени: так папку читает глаз, привыкший к редактору. */
function folderOrder(a, b) {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * phaseTree(io, root) → {entries, truncated} — папка фазы как дерево имён и размеров.
 *
 * СОДЕРЖИМОГО ФАЙЛОВ ЗДЕСЬ НЕТ. Дерево — это оглавление; сам файл читается ОТДЕЛЬНЫМ вопросом к
 * той же двери, и это единственное место, где чтение файла ограничено потолком и замком.
 *
 * ССЫЛКА — НЕ СОДЕРЖИМОЕ ПАПКИ ФАЗЫ, и её здесь нет вовсе. Пройти по ней значило бы показать в
 * дереве фазы чужой каталог, а показать её как файл — пообещать чтение, которое замок всё равно
 * не даст. Каталог, который не читается, — это пустой узел, а не отказ всего дерева: одна
 * недоступная папка не должна стоить человеку вида на остальные.
 */
function phaseTree(io, root) {
  const budget = { left: PHASE_TREE_MAX_ENTRIES }

  const walk = (dir, prefix, depth) => {
    let names
    try {
      names = io.readdirSync(dir).map(String)
    } catch {
      return []
    }
    const rows = []
    for (const name of names) {
      if (budget.left <= 0) break
      const full = join(dir, name)
      let st
      try {
        st = io.lstatSync(full)
      } catch {
        continue
      }
      if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) continue
      budget.left -= 1
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        rows.push({
          name,
          path: rel,
          kind: 'dir',
          children: depth + 1 < PHASE_TREE_MAX_DEPTH ? walk(full, rel, depth + 1) : [],
        })
      } else {
        rows.push({ name, path: rel, kind: 'file', size: Number.isFinite(st && st.size) ? st.size : null })
      }
    }
    return rows.sort(folderOrder)
  }

  const entries = walk(root, '', 0)
  return { entries, truncated: budget.left <= 0 }
}

/**
 * GET /api/phase/:id/files — дерево папки фазы, а с `?file=<путь внутри неё>` — ОДИН файл ТЕКСТОМ.
 *
 * ТЕКСТ, А НЕ РАЗМЕТКА. Возвращается `text/plain` с `nosniff` и `no-store`: что делать с
 * содержимым — дело экрана, а демон, отдавший HTML за файл, которым он не управляет, вручил бы
 * браузеру всё, что в этом файле оказалось.
 *
 * ДВОИЧНЫЙ ФАЙЛ ОТКАЗЫВАЕТСЯ СЛОВАМИ. Нулевой байт — то же правило, по которому двоичный файл
 * узнаёт git: показывать «текст», собранный из картинки, значит показывать мусор и называть его
 * документом. Превышение потолка — отдельный отказ по размеру, а не обрезанная полуправда.
 */
function handlePhaseFiles({ res, params, query, deps }) {
  const projectDir = phaseCycleDir(deps)
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return send404(res)

  const io = phaseFolderIo(deps)
  const phasesRoot = join(projectDir, ...PHASE_FOLDER_ROOT.split('/'))
  let dirs
  try {
    dirs = io.readdirSync(phasesRoot).map(String)
  } catch {
    return send404(res) // у проекта нет каталога фаз — значит, нет и папки этой фазы
  }
  const dir = findPhaseDir(dirs, String((params && params.id) || ''))
  if (!dir) return send404(res)
  const root = join(phasesRoot, dir)

  const asked = query && typeof query.file === 'string' ? query.file : ''
  if (asked === '') {
    const tree = phaseTree(io, root)
    return sendJson(res, 200, {
      phase: dir,
      // ПУТЬ ФАЗЫ, А НЕ ПУТЬ НА ДИСКЕ ВЛАДЕЛЬЦА: наружу едет только то, что отсюда и началось.
      root: `${PHASE_FOLDER_ROOT}/${dir}`,
      entries: tree.entries,
      truncated: tree.truncated,
    })
  }

  const full = safePhaseFilePath(io, root, asked)
  if (!full) return send400(res, 'invalid path')

  let stat
  try {
    stat = io.statSync(full)
  } catch {
    return send404(res)
  }
  if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) return send400(res, 'invalid path')
  if (Number.isFinite(stat.size) && stat.size > PHASE_FILE_MAX_BYTES) return send413(res)

  let raw
  try {
    raw = io.readFileSync(full)
  } catch {
    return send404(res)
  }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')
  // шов, у которого нечего было спросить о размере, всё равно ограничен: потолок — свойство двери
  if (bytes.byteLength > PHASE_FILE_MAX_BYTES) return send413(res)
  if (bytes.includes(0)) return send400(res, 'not a text file')
  return sendText(res, 200, bytes.toString('utf8'))
}

/** Every row the queue holds, or an empty list when it cannot say. */
async function allRowsOf(deps) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.list !== 'function') return []
  try {
    const rows = await adapter.list({})
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** Every row that has stopped to ask, or an empty list when the queue cannot say. */
async function parkedRowsOf(deps) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.list !== 'function') return []
  try {
    const rows = await adapter.list({ status: 'awaiting_approval' })
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * How the questions engine's five named errors answer at the door.
 *
 * A TORN CHECKPOINT IS NOT THE CALLER'S FAULT and must not read as one: it is a file on this
 * machine that somebody has to look at, so it answers 409 with the engine's own message (which
 * names the offending field), never a 400 that would send a person looking at their own typing.
 * A SECRET-SHAPED ANSWER answers 400 with the engine's explanation and NOTHING is logged: the
 * text that tripped the heuristic is the one text that must not be written down anywhere.
 */
function questionsError(res, err) {
  const name = (err && err.name) || ''
  const message = String((err && err.message) || 'bad request')
  if (name === 'CheckpointFormatError') return send409(res, message)
  if (name === 'UnknownQuestionError') return send404(res)
  return send400(res, message)
}

/** The questions engine over the phase cycle's own tree, reading BOTH parking files. */
function questionsFor(deps) {
  return createQuestions({
    projectDir: phaseCycleDir(deps) ?? '.',
    fsImpl: deps.fsImpl,
    checkpointSuffix: ALL_CHECKPOINT_SUFFIXES,
  })
}

/**
 * POST /api/decision/answer — body {phase, questionId, taskId?, optionId?, freeText?}.
 * Answer ONE parked question, and wake the round it was blocking if it was the last one.
 *
 * TWO ACTS, IN THIS ORDER, AND THE ORDER IS THE CONTRACT. The answer is recorded FIRST, into
 * the workflow's own artifact, by the engine that owns the validation, the secret heuristic and
 * the atomic write. Only then — and only when nothing is still open, and only when the caller
 * named the parked row — does the round wake. So answering is always safe: nothing starts
 * because a person typed, only because a person FINISHED.
 *
 * THE ANSWER TRAVELS AS THE ARTIFACT, NEVER AS THE PROMPT. The re-queued task carries the SAME
 * command the stage was started with, byte for byte, out of the same frozen dictionary; the
 * worker reads what was decided from the checkpoint, which is where the terminal reads it from
 * too. Nothing a person typed is ever concatenated into an instruction here.
 *
 * AND THE DOOR KNOWS NOTHING ABOUT POSITION. An execute stage that parked at a checkpoint
 * resumes from the position written INSIDE that artifact — the workflow's business, carried by
 * the file, invisible to this function. That is why the woken command is identical to the
 * original: «where it stopped» is not a parameter, it is a fact already on disk.
 *
 * The wake is the two-phase CAS the approve door uses — awaiting_approval → approving → the
 * re-queue → approved — so two people answering the last question at the same time produce one
 * 200 and one 409 rather than two workers on one stage.
 */
async function handleDecisionAnswer({ req, res, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['taskId', 'phase', 'questionId', 'optionId', 'freeText']))) {
    return undefined
  }

  const phase = b.phase === undefined || b.phase === null ? '' : String(b.phase)
  if (!PHASE_RE.test(phase)) return send400(res, 'invalid phase')
  const questionId = b.questionId
  if (typeof questionId !== 'string' || questionId.trim() === '') return send400(res, 'invalid questionId')
  const taskId = b.taskId
  if (taskId !== undefined && (typeof taskId !== 'string' || !ID_RE.test(taskId))) {
    return send400(res, 'invalid taskId')
  }

  // ── (1) record it. Every refusal below belongs to the engine and is reported in its words:
  // the caps, the one-of-two rule and the secret screen live in exactly one place.
  const engine = questionsFor(deps)
  let progress
  try {
    engine.recordAnswer(phase, questionId, {
      ...(b.optionId !== undefined ? { optionId: b.optionId } : {}),
      ...(b.freeText !== undefined ? { freeText: b.freeText } : {}),
    })
    progress = engine.progress(phase)
  } catch (err) {
    return questionsError(res, err)
  }

  emitSafe(deps, { event: 'discussion.updated', phase })

  // ── (2) the round wakes only on the LAST answer, and only when the row was named.
  if (progress.open > 0 || taskId === undefined) {
    return sendJson(res, 200, { ok: true, open: progress.open, answered: progress.answered })
  }
  const woken = await wakeParkedRound(res, deps, { taskId, phase })
  if (woken.answered) return undefined
  return sendJson(res, 200, {
    ok: true,
    open: progress.open,
    answered: progress.answered,
    ...(woken.taskId ? { taskId: woken.taskId } : {}),
  })
}

/**
 * Re-queue the round a parked row was holding, under the two-phase CAS.
 *
 * The stage and the phase are read off the ROW's own `data` envelope, not off the request: the
 * caller says which row it is answering for, and the row says what it was doing. A row that
 * carries no envelope is not a stage and is left exactly where it is — silently, with the
 * answer still recorded, because the answer was the point and the wake is the courtesy.
 *
 * @returns {Promise<{answered:boolean, taskId?:string}>} answered:true when a response was sent
 */
async function wakeParkedRound(res, deps, { taskId, phase }) {
  const adapter = deps.adapter
  if (typeof deps.casExec !== 'function' || !adapter || typeof adapter.enqueue !== 'function') {
    return { answered: false } // the answer stands; this daemon simply has no queue to wake
  }

  let row = null
  if (typeof adapter.list === 'function') {
    const rows = await adapter.list({})
    row = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === taskId) || null
  }
  const envelope = (row && row.data) || null
  const stage = envelope && envelope.stage
  if (!stage || !TASK_STAGES.includes(stage)) return { answered: false }

  const table = deps.taskTable || 'sma_task_attempts'
  const claim = await casTransition(deps.casExec, {
    table,
    id: taskId,
    from: 'awaiting_approval',
    to: 'approving',
    ...(deps.dispatchedAt !== undefined ? { dispatchedAt: deps.dispatchedAt } : {}),
  })
  if (!claim.won) {
    send409(res, 'answer race lost (the round is already awake)')
    return { answered: true }
  }

  // The phase the round was working on is the ROW's, not the request's — the two agree in
  // every ordinary case, and where they could not, the row is the one that ran.
  const rowPhase = envelope.phase === undefined || envelope.phase === null ? phase : String(envelope.phase)
  const attempt = Number.isFinite(row && row.attempt) ? row.attempt : 1
  const requeue = await enqueueOrExplain(res, adapter, {
    id: taskId,
    source: 'roster',
    // The round that was parked is the SAME work; it comes back owned by whoever owned it —
    // see inheritedProject. The row this door already read is where that is written.
    ...inheritedProject(row ? [row] : []),
    title: stageCommand(stage, rowPhase),
    lane: STAGE_LANE,
    data: { kind: stageKind(stage), stage, phase: rowPhase },
    attempt: attempt + 1,
  })
  if (requeue.answered) return { answered: true }

  await casTransition(deps.casExec, { table, id: taskId, from: 'approving', to: 'approved' })
  emitSafe(deps, { event: 'task.queued', taskId })
  return { answered: false, taskId }
}

// ═══════════ reading a document of the phase, and writing one line of its acceptance ═════
//
// THE ARTEFACT DOOR HAS EXACTLY ONE ROOT AND IT IS `.planning/`. Everything a phase leaves
// behind — its context, its plans, its summaries, its acceptance — lives under that one
// directory, so the door does not need to open anything else, and «does not need to» is the
// only argument for a reading surface that ever holds. What it refuses, it refuses with the
// SAME 400 every time: a caller learns that the path was not acceptable and nothing about the
// shape of the disk behind it.
//
// THE CHECK IS MADE TWICE, ON PURPOSE. Once on the TEXT (no `..` segment, no leading
// separator, no drive letter, and it must begin with the one permitted prefix) and once on the
// RESOLVED result (it must still sit inside the resolved root). Either alone has been enough
// to lose this argument before: a textual check misses what a symlink or an odd separator
// resolves to, and a resolve-only check accepts a path that never should have been spelled.

/** The only root this door opens, and the only prefix a path may carry. */
const ARTIFACT_ROOT = '.planning'
const ARTIFACT_PREFIX = `${ARTIFACT_ROOT}/`

/** A document a person reads on a screen is not a payload: past this it is not a document. */
const ARTIFACT_MAX_BYTES = 1024 * 1024
const ARTIFACT_PATH_CAP = 512

/** The fs surface the two document doors use — injected in tests, real fs in production. */
function documentIo(deps) {
  const io = (deps && deps.fsImpl) || {}
  return {
    readFileSync: io.readFileSync ?? fsReadFileSync,
    statSync: io.statSync ?? fsStatSync,
    ...(io.mkdirSync ? { mkdirSync: io.mkdirSync } : {}),
    ...(io.writeFileSync ? { writeFileSync: io.writeFileSync } : {}),
    ...(io.renameSync ? { renameSync: io.renameSync } : {}),
  }
}

/**
 * safeArtifactPath(projectDir, rel) → the path to open, or null.
 *
 * `null` is the ONLY failure value: which rule was broken is this function's business and
 * never the caller's answer.
 *
 * The RESOLVED form is what the containment check is made against, and the JOINED form is what
 * is handed to the filesystem — the same relative string, checked the strict way and used the
 * ordinary way, so nothing about resolving against a process's own drive or working directory
 * can turn an accepted path into a different file.
 */
function safeArtifactPath(projectDir, rel) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  if (typeof rel !== 'string' || rel === '' || rel.length > ARTIFACT_PATH_CAP) return null

  const path = rel.replace(/\\/g, '/')
  if (path.split('/').includes('..')) return null // a traversal segment, in either spelling
  if (path.startsWith('/') || isAbsolute(rel) || /^[A-Za-z]:/.test(path)) return null
  if (path.includes('\0')) return null
  if (path !== ARTIFACT_ROOT && !path.startsWith(ARTIFACT_PREFIX)) return null

  const root = resolvePath(projectDir, ARTIFACT_ROOT)
  const full = resolvePath(projectDir, path)
  // the resolved answer must still be the root itself or something beneath it — compared on a
  // separator boundary, so a sibling directory whose name merely starts the same cannot pass
  if (full !== root && !full.startsWith(`${root}/`) && !full.startsWith(`${root}\\`)) return null
  return join(projectDir, path)
}

/**
 * GET /api/artifact?path=<relative> — one document of the phase cycle, as plain text.
 *
 * TEXT, NEVER MARKUP. What comes back is `text/plain` with `nosniff` and `no-store`: rendering
 * a plan is the screen's business, and a daemon that returned HTML for a file it does not
 * control would be handing a browser whatever a document happened to contain.
 */
function handleArtifact({ res, query, deps }) {
  const full = safeArtifactPath(phaseCycleDir(deps), (query && query.path) || '')
  if (!full) return send400(res, 'invalid path')

  const io = documentIo(deps)
  let stat
  try {
    stat = io.statSync(full)
  } catch {
    return send404(res)
  }
  if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) return send400(res, 'invalid path')
  if (Number.isFinite(stat.size) && stat.size > ARTIFACT_MAX_BYTES) return send413(res)

  let text
  try {
    text = String(io.readFileSync(full, 'utf8'))
  } catch {
    return send404(res)
  }
  // a fs seam with no size to report is still bounded — the cap is a property of the door
  if (Buffer.byteLength(text, 'utf8') > ARTIFACT_MAX_BYTES) return send413(res)
  return sendText(res, 200, text)
}

// ── the acceptance record: one line, one verdict, written in the file's own words ──
//
// The document belongs to `/sma-verify-work` and to the verb that audits it, and this door is
// a SECOND WRITER of it, not its owner. So it writes the vocabulary that file already uses:
// `pass` is `pass`, and `fail` on the wire is `issue` in the document, with the person's words
// on the `reported:` line the audit verb reads. Inventing `result: fail` would have been one
// word cheaper here and invisible to every reader of that file.

/** The verdicts a person may give, and the word each one is written as. */
const UAT_RESULT_OF = Object.freeze({ pass: 'pass', fail: 'issue' })

/** The severity a reported issue carries when nobody said otherwise — the template's own default. */
const UAT_DEFAULT_SEVERITY = 'major'

/** The lines that belong to a verdict and are rewritten with it. */
const UAT_VERDICT_LINE = /^(result|reported|severity|reason|blocked_by):/

/** One test heading: `### 7. Название`. */
const uatHeading = (item) => new RegExp(`^###\\s*${item}\\.\\s`)

/**
 * A note as ONE line of the document.
 *
 * The format this file is parsed by is line-oriented, so a pasted paragraph would not be a
 * long value — it would be a value followed by lines the parser reads as something else. The
 * whitespace is collapsed and the quotes that delimit the value are dropped from inside it.
 */
function uatNoteLine(note) {
  return String(note).replace(/\s+/g, ' ').replace(/"/g, '”').trim()
}

/**
 * Rewrite ONE test block of a UAT document, and bring the counters after it back in step.
 *
 * Returns null when the document has no such test — a door does not invent a line of somebody's
 * acceptance, it records what a person said about a line that already exists.
 */
function writeUatVerdict(text, { item, verdict, note, now }) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const head = lines.findIndex((line) => uatHeading(item).test(line))
  if (head < 0) return null

  let end = head + 1
  while (end < lines.length && !/^#{2,3}\s/.test(lines[end])) end += 1

  const block = lines.slice(head + 1, end)
  const kept = block.filter((line) => !UAT_VERDICT_LINE.test(line))
  // `expected:` and everything else the block carries stays exactly where it was; only the
  // verdict lines are ours to replace, and they are replaced as a set so a `pass` cannot be
  // left sitting next to the `reported:` line of the issue it used to be.
  const verdictLines = [`result: ${UAT_RESULT_OF[verdict]}`]
  if (verdict === 'fail' && note) {
    verdictLines.push(`reported: "${uatNoteLine(note)}"`, `severity: ${UAT_DEFAULT_SEVERITY}`)
  }
  const expectedAt = kept.findIndex((line) => /^expected:/.test(line))
  const rebuilt = expectedAt < 0
    ? [...verdictLines, ...kept]
    : [...kept.slice(0, expectedAt + 1), ...verdictLines, ...kept.slice(expectedAt + 1)]

  const next = [...lines.slice(0, head + 1), ...rebuilt, ...lines.slice(end)]
  return refreshUatBookkeeping(next, now).join('\n')
}

/**
 * The counters and the timestamp the document keeps about itself.
 *
 * They are DERIVED from the blocks above them and rewritten only where they already exist:
 * a number left stale by a write is a second truth inside one file, and this door would be the
 * one that put it there. A document that keeps no counters is left without any.
 */
function refreshUatBookkeeping(lines, now) {
  const counts = { total: 0, passed: 0, issues: 0, pending: 0, skipped: 0, blocked: 0 }
  for (const line of lines) {
    const m = line.match(/^result:\s*\[?([A-Za-z_]+)\]?\s*$/)
    if (!m) continue
    counts.total += 1
    if (m[1] === 'pass') counts.passed += 1
    else if (m[1] === 'issue' || m[1] === 'fail') counts.issues += 1
    else if (m[1] === 'skipped') counts.skipped += 1
    else if (m[1] === 'blocked') counts.blocked += 1
    else counts.pending += 1
  }

  // the frontmatter's own «last touched», when the document declares one
  const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  return lines.map((line, i) => {
    if (fmEnd > 0 && i > 0 && i < fmEnd && /^updated:/.test(line)) return `updated: ${now}`
    if (fmEnd > 0 && i < fmEnd) return line
    const m = line.match(/^(total|passed|issues|pending|skipped|blocked):\s*\d+\s*$/)
    return m ? `${m[1]}: ${counts[m[1]]}` : line
  })
}

/**
 * POST /api/phase/uat — body {phase, item, verdict, note?}. One line of a phase's acceptance.
 *
 * `item` is the test's NUMBER, which is how that document and the verb that audits it already
 * address a line: a title can be reworded and a number cannot, and an answer that landed on the
 * wrong line because somebody fixed a typo would be worse than no answer.
 */
async function handlePhaseUat({ req, res, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['phase', 'item', 'verdict', 'note']))) return undefined

  const phase = b.phase === undefined || b.phase === null ? '' : String(b.phase)
  if (!PHASE_RE.test(phase)) return send400(res, 'invalid phase')
  const item = b.item === undefined || b.item === null ? '' : String(b.item)
  if (!/^\d{1,4}$/.test(item)) return send400(res, 'item must be the number of a test')
  const verdict = b.verdict
  if (verdict !== 'pass' && verdict !== 'fail') return send400(res, 'verdict must be pass or fail')
  const note = b.note == null ? '' : String(b.note)
  if (note.length > 2000) return send400(res, 'note exceeds 2000 chars')

  const projectDir = phaseCycleDir(deps)
  if (!projectDir) return send501(res)
  const io = documentIo(deps)

  // the acceptance document of the phase, found through the ONE rule for «which directory is
  // phase N» — the same one the daemon's gate and the phase card resolve a phase with
  const relative = uatDocumentOf(deps, projectDir, phase)
  if (!relative) return send404(res)
  const full = safeArtifactPath(projectDir, relative)
  if (!full) return send400(res, 'invalid path')

  let text
  try {
    text = String(io.readFileSync(full, 'utf8'))
  } catch {
    return send404(res)
  }
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const next = writeUatVerdict(text, { item, verdict, note, now: new Date(clock()).toISOString() })
  if (next === null) return send404(res)

  atomicWriteRaw(full, next, {
    ...(io.mkdirSync ? { mkdirFn: io.mkdirSync } : {}),
    ...(io.writeFileSync ? { writeFn: io.writeFileSync } : {}),
    ...(io.renameSync ? { renameFn: io.renameSync } : {}),
  })
  // NO HINT IS EMITTED, and that is a decision rather than an omission: the frozen vocabulary
  // has nineteen names and none of them means «one line of an acceptance was answered».
  // `phase.stage` would have been the nearest, and it would have been a lie — a frame saying
  // the phase moved when it did not. The screen re-reads the card after its own POST, which is
  // the same contract every hint on this daemon has: the frame is never the truth.
  return sendJson(res, 200, { ok: true, phase, item, verdict })
}

/**
 * The door-relative path of a phase's acceptance document, or null when it keeps none.
 *
 * ASKED OF THE CARD, NEVER LOOKED UP AGAIN. The card already answers both questions this door
 * needs — which directory is phase N (through the same `findPhaseDir` the daemon's exit gate
 * uses) and which file in it is the acceptance — so a phase number, a directory name and a
 * `phase-`-prefixed name all reach the same document from every door. A second lookup here
 * would be a second answer, and the day they disagreed the screen would be showing one file
 * while this write landed in another.
 */
function uatDocumentOf(deps, projectDir, phase) {
  if (typeof deps.derivePhaseCard !== 'function') return null
  const card = deps.derivePhaseCard({ projectDir, phaseId: phase, fsImpl: deps.fsImpl })
  const document = card && card.uatDocument
  return document && typeof document.path === 'string' ? document.path : null
}

// ══════════ the memory workbench: four doors in front of a conveyor that exists ══════════
//
// NOTHING HERE IS A NEW MECHANISM, AND THAT IS THE WHOLE POINT. The write pipeline already
// refuses to put a lesson into the corpus without a person's word: it STAGES the record in
// `drafts/` and stops. What it never had was a way for that person to say the word from
// anywhere but a terminal. These four doors are that way, and they add no second path — the
// apply runs the pipeline's OWN per-file confirmation, the index runs the generator's own
// rebuild, the lint runs the corpus linter, and the list is a read off the disk.
//
// ONE DOOR IS ONE DRAFT, BY CONSTRUCTION AND NOT BY POLICY. There is no bulk apply in this
// file, there is no field that could ask for one, and the collaborator behind the door takes a
// single draft's name. «Принять всё» is not a button somebody decided not to draw — it is a
// request this surface cannot express. The pipeline's own confirmation is per file for exactly
// this reason, and a door that batched it would have been the one place the rule dissolved.
//
// THE REFUSAL IS THE PRODUCT'S, AND IT ARRIVES INTACT. A staged record that trips the
// pipeline's secret screen, a draft of a kind this path does not apply, a record whose identity
// is already taken — none of those is re-decided here. The collaborator returns what the
// pipeline said and the reason travels to the caller in the pipeline's own words: a door that
// re-worded a refusal would be a door that could, one day, soften one.
//
// THE PROJECT IS NEVER NAMED BY A REQUEST. Which corpus is worked on is the CONNECTED project,
// resolved by the read models and by the composition root's closures — never a field. There is
// no body on any of these four that could point at a directory.

/** How many lint findings one report carries — a panel is bounded like every other answer. */
const LINT_FINDINGS_CAP = 200

/**
 * The receipt formats, as WORDS rather than only as assembled strings.
 *
 * Exported so a reader (and a test) can grep for the format itself instead of for an example
 * of it — the lesson the update door's receipt paid for.
 */
export const MEMORY_APPLY_RECEIPT_FORMAT = 'memory-apply:<draft>-><target>'
export const MEMORY_INDEX_RECEIPT_FORMAT = 'memory-index:<bytes>b+<area-files>'
export const CLAIM_CLEAR_RECEIPT_FORMAT = 'claim-clear:<claim>@<by>'

/**
 * A draft's name as it may arrive on the wire: the stem of a file inside the drafts directory.
 * No separator and no leading dot, so the collaborator's `join` can only ever land inside that
 * directory — the same grammar the read model shows a row under, kept here rather than imported
 * because this file carries no build edge onto the read models.
 */
const DRAFT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * How a collaborator's refusal answers.
 *
 * A REFUSAL IS NOT A BAD REQUEST. The body was well formed, the door did its job and the
 * mechanism behind it said no — that is a CONFLICT with the state of this machine, and 400
 * would send a person to re-read their own typing. The reason travels as the mechanism wrote
 * it; a missing draft is the one case that is genuinely a 404.
 */
function workbenchRefusal(res, result) {
  if (result && result.missing) return send404(res)
  return send409(res, String((result && result.reason) || 'refused'))
}

/**
 * GET /api/memory/drafts — the lessons waiting for a yes, read off the disk on every call.
 *
 * Derived like every other read model and injected the same way, so this file carries no build
 * edge onto state.mjs. A project with no drafts, and a daemon with no project connected, both
 * answer an empty list: the panel is empty because there is nothing in it, which is a fact and
 * not a failure.
 */
function handleMemoryDrafts({ res, config, deps }) {
  if (typeof deps.deriveMemoryDrafts !== 'function') return send501(res)
  return sendJson(res, 200, deps.deriveMemoryDrafts({ config, fsImpl: deps.fsImpl, clock: deps.clock }))
}

/**
 * POST /api/memory/apply — body {draftId, accept}. ONE draft into the corpus.
 *
 * `accept` must be the literal `true`. It is not a formality and it is not a default: the field
 * exists so that a request which merely REACHED this door — a swept route table, a replayed
 * body, a page that posted early — cannot be read as a person agreeing to a lesson. The same
 * reasoning the update door's `confirm` carries, applied to the one act in this product that
 * changes what the machine believes.
 *
 * There is no `all`, no array and no glob. `draftId` is one name.
 */
async function handleMemoryApply({ req, res, deps }) {
  if (typeof deps.applyMemoryDraft !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['draftId', 'accept']))) return undefined
  if (b.accept !== true) return send400(res, 'accept must be true — a draft is accepted one at a time, by hand')
  const draftId = b.draftId
  if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) return send400(res, 'invalid draftId')

  let result
  try {
    result = await deps.applyMemoryDraft({ draftId })
  } catch (err) {
    return send409(res, String((err && err.message) || 'the draft could not be applied'))
  }
  if (!result || result.applied !== true) return workbenchRefusal(res, result)

  // AFTER the record is in the corpus: a screen that re-reads on the doorbell can never find
  // the draft it just accepted still sitting in the list. The frame carries nothing.
  emitSafe(deps, { event: 'memory.drafts' })
  return sendJson(res, 200, {
    ok: true,
    draftId,
    receipt: `memory-apply:${draftId}->${result.targetFile ?? '(corpus)'}`,
  })
}

/**
 * POST /api/memory/index — body EMPTY by contract. Rebuild the corpus index.
 *
 * The index is GENERATED and never hand-edited; the corpus linter has a check that says so out
 * loud. This door is the button behind that rule — it runs the same regeneration the terminal
 * runs, in the connected project, and answers with a receipt of what was written.
 */
async function handleMemoryIndex({ req, res, deps }) {
  if (typeof deps.rebuildMemoryIndex !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  if (rejectUnknownKeys(res, body.value || {}, NO_FIELDS)) return undefined

  let result
  try {
    result = await deps.rebuildMemoryIndex()
  } catch (err) {
    return send409(res, String((err && err.message) || 'the index could not be rebuilt'))
  }
  if (!result || result.ok !== true) return workbenchRefusal(res, result)
  const areas = Array.isArray(result.areaFiles) ? result.areaFiles.length : 0
  emitSafe(deps, { event: 'memory.drafts' })
  return sendJson(res, 200, { ok: true, receipt: `memory-index:${result.bytes ?? 0}b+${areas}` })
}

/**
 * GET /api/memory/lint — the corpus linter's report, explicit-picked.
 *
 * WHAT DOES NOT TRAVEL IS THE POINT: the linter names files by PATH and this answer names them
 * by NAME, because a note's name is what a person acts on and the directory it sits in is this
 * machine's business. The linter's third tier (`info`) has no field in the contract and is not
 * folded into `warnings` — a count that quietly included advisories would be a number nobody
 * could reconcile with the list beside it.
 */
async function handleMemoryLint({ res, deps }) {
  if (typeof deps.readMemoryLint !== 'function') return send501(res)
  let answer
  try {
    answer = await deps.readMemoryLint()
  } catch (err) {
    return send503(res, String((err && err.message) || 'the corpus could not be linted'))
  }
  if (!answer || answer.ok !== true) return send503(res, String((answer && answer.reason) || 'unavailable'))
  const report = answer.report || {}

  const all = (Array.isArray(report.findings) ? report.findings : []).filter(
    (f) => f && (f.tier === 'critical' || f.tier === 'warn'),
  )
  const findings = all.slice(0, LINT_FINDINGS_CAP).map((f) => ({
    rule: String(f.checkId ?? ''),
    severity: f.tier === 'critical' ? 'critical' : 'warning',
    note: String(f.message ?? ''),
    file: nameOnly(f.file),
  }))
  return sendJson(res, 200, {
    ok: Number(report.critical ?? 0) === 0,
    critical: Number(report.critical ?? 0),
    warnings: Number(report.warn ?? 0),
    findings,
    ...(all.length > findings.length ? { truncated: true } : {}),
  })
}

/** The last segment of a path — a note is named, never located, on the way out of here. */
function nameOnly(p) {
  const parts = String(p ?? '').split(/[/\\]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

// ══════════ coordination: who else has this open, and what they reserved ══════════
//
// A CHECKOUT IS SHARED, AND THE PRODUCT HAS ALWAYS KNOWN IT. Terminals take leases, reserve
// scopes before they change them, and journal it when two of those scopes meet. All of that is
// already on disk in `.sma/`; what it never had was a reader that is not a status line. This
// panel is that reader, and it reads through the runtime's OWN readers — a second parser of
// somebody else's coordination ledger is the thing this daemon must never become.
//
// AND ONE ACT: TAKING SOMEBODY ELSE'S RESERVATION AWAY. That act exists in the runtime too, and
// it has always cost more than a confirmation — a foreign clear is a RISKY OPERATION and the
// verb refuses it without a written reason and a stated check. This door does not soften that
// by one field: the reason is REQUIRED, it is passed straight through, and the check the door
// attaches is one the door actually made — never a sentence invented to satisfy a gate.
//
// A CLEARED RESERVATION LEAVES A TRAIL BY CONSTRUCTION. The verb writes the evidence record and
// journals the steal with the former holder's name. Nothing about that is re-implemented here,
// which is exactly why it cannot be skipped here.

/**
 * A reservation's name as it may arrive on the wire.
 *
 * It becomes a DIRECTORY NAME on this machine and an ARGUMENT of a child process, so it is held
 * to a grammar with no separator and no leading dash: a name that could read as the next flag
 * of the command it rides on is refused before the command is assembled, not after.
 */
const CLAIM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A reason is a person's sentence, and this is the cap the return door already uses for one. */
const CLAIM_REASON_CAP = 2000

/**
 * GET /api/coordination — sessions, reservations and today's collisions of the connected
 * project, derived on every call.
 *
 * A checkout with nobody in it and a daemon with no project connected are the same three empty
 * lists: an empty panel is a fact about a quiet machine, not a fault of this door.
 */
async function handleCoordination({ res, config, deps }) {
  if (typeof deps.deriveCoordination !== 'function') return send501(res)
  const snap = await deps.deriveCoordination({ config, clock: deps.clock })
  // An unreadable ledger used to answer 200 with empty lists — indistinguishable from a
  // quiet checkout, so the screen said «никого нет» about a journal it could not read
  // (QA D3). A failure to read is a failure to answer.
  if (snap && snap.unreadable) return send503(res, 'the coordination ledger could not be read')
  return sendJson(res, 200, snap)
}

/**
 * POST /api/claim/clear — body {claim, reason}. Take somebody else's reservation away.
 *
 * THE REASON IS NOT A COURTESY FIELD, IT IS THE EVIDENCE. The runtime treats a foreign clear as
 * a risky operation and will not perform one without a written record of why and of what was
 * checked; this door therefore refuses an empty reason itself, before the verb is reached, so
 * the person gets the refusal from the screen they are on rather than from a child process.
 *
 * WHAT THE DOOR ATTACHES AS THE CHECK IS SOMETHING THE DOOR DID. It read the ledger and put the
 * holder and the age of that reservation in front of a person before this call — that is a
 * true statement about this system, and it is the only one available here. Inventing a check
 * nobody made would be worse than having no evidence at all, because the record would read as
 * though somebody had looked.
 */
async function handleClaimClear({ req, res, deps }) {
  if (typeof deps.clearClaim !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['claim', 'reason']))) return undefined

  const claim = b.claim
  if (typeof claim !== 'string' || !CLAIM_NAME_RE.test(claim)) return send400(res, 'invalid claim')
  const reason = b.reason == null ? '' : String(b.reason).trim()
  if (reason === '') return send400(res, 'reason is required — a foreign reservation is never cleared without one')
  if (reason.length > CLAIM_REASON_CAP) return send400(res, `reason exceeds ${CLAIM_REASON_CAP} chars`)

  let result
  try {
    result = await deps.clearClaim({ claim, reason })
  } catch (err) {
    return send409(res, String((err && err.message) || 'the reservation was not cleared'))
  }
  if (!result || result.cleared !== true) return workbenchRefusal(res, result)

  emitSafe(deps, { event: 'coordination.updated' })
  return sendJson(res, 200, { ok: true, claim, receipt: `claim-clear:${claim}@${result.by ?? '(unknown)'}` })
}

// ══════════ the backlog: a board over a file that belongs to a person ══════════
//
// THE FILE IS A HAND, NOT A STORE. `.planning/BACKLOG.md` is written by whoever keeps it —
// sorted, annotated, argued with in prose — and this door reads it and NOTHING ELSE. Putting a
// line into the queue does not strike it out, does not move it and does not rewrite a byte:
// deciding a line is done is that person's edit, and a window that quietly kept the file for
// them would be a window they could no longer trust to be showing what they wrote.
//
// THE IDENTIFIER IS DATA, AND THE PARSER KNOWS ONE SHAPE. A bulleted entry whose bold lead is
// «some letters, a dash, a number» is a row; anything else on the line is prose. WHICH letters
// is the project's own business, and this daemon carries no list of them — the moment it did,
// it would be a board that works for one backlog and silently shows nothing for every other.
//
// AND NOTHING HERE MINTS A NUMBER. The row already has one, out of the file. This door allocates
// no identifier and reads no «last one», so the rule that a shared counter is allocated by its
// own allocator has nothing to break here — there is no allocation to do.

/** The lane a promoted line rides, when the person did not choose one: ordinary work. */
const BACKLOG_DEFAULT_LANE = 'prod'

/** A backlog identifier as it may arrive on the wire — the SAME shape the board parses by. */
const BACKLOG_WIRE_ID_RE = /^[A-Z][A-Z0-9]{1,7}-\d{1,6}$/

/**
 * queueTitleFor(id, words) → «идентификатор · слова файла», укороченные до того, что заголовок
 * строки очереди вмещает.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ, и это находка живого прогона, а не осторожность. Доска бэклога держит
 * строку файла целиком (у неё есть место), а заголовок строки очереди — это СТРОКА, не документ,
 * и он вдвое короче. На настоящем бэклоге, где записи бывают в четыреста символов, обе двери,
 * собиравшие заголовок склейкой, отдавали в ворота очереди заведомо длинный текст: ворота
 * отказывали, и владелец видел отказ вместо работы. Батч при этом не заводился ЦЕЛИКОМ — из-за
 * одной длинной строки в составе.
 *
 * Обрезается ХВОСТ СЛОВ, а идентификатор остаётся всегда: по нему строка очереди читается назад
 * к строке файла, и это единственная её часть, терять которую нельзя. Многоточие говорит вслух,
 * что слова укорочены, — иначе обрезанная фраза читалась бы как полная.
 *
 * Кап берётся у самих ворот (`CAP_TITLE`), а не пишется здесь своим числом: две копии капа —
 * это два капа, и работает более слабый.
 */
function queueTitleFor(id, words) {
  const whole = `${id} · ${String(words ?? '').trim()}`
  if (whole.length <= CAP_TITLE) return whole
  return `${whole.slice(0, CAP_TITLE - 1).replace(/\s+\S*$/, '')}…`
}

/** A title a person retyped is a line, not a document — validateTask bounds it again. */
const BACKLOG_TITLE_CAP = 400

/**
 * GET /api/backlog — the project's own backlog file, as rows.
 *
 * No file is an empty board and not a 404: a project that keeps no backlog is not a broken one,
 * and a fault code here would send somebody looking for a bug in the door.
 */
function handleBacklog({ res, config, deps }) {
  if (typeof deps.deriveBacklog !== 'function') return send501(res)
  return sendJson(res, 200, deps.deriveBacklog({ config, fsImpl: deps.fsImpl }))
}

/**
 * POST /api/backlog/promote — body {id, lane?, title?}. One line becomes work in the queue.
 *
 * THE LINE MUST BE IN THE FILE. The board and this door read it the same way, through the same
 * derive, so an identifier that is not an open row is a 404 rather than a phantom task nobody
 * can trace back to anything. That is also where the title comes from when the person did not
 * retype one — the file's own words, never composed here.
 *
 * The row is minted like every other roster task (`R-<epochMs>`, source `roster`, DoR-exempt
 * because a person pressed it) and goes through the SAME `validateTask` gate: this door adds no
 * second way into the queue.
 */
async function handleBacklogPromote({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function' || typeof deps.deriveBacklog !== 'function') {
    return send501(res)
  }
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'lane', 'title']))) return undefined

  const id = b.id
  if (typeof id !== 'string' || !BACKLOG_WIRE_ID_RE.test(id)) return send400(res, 'invalid id')
  const lane = b.lane === undefined || b.lane === null ? BACKLOG_DEFAULT_LANE : String(b.lane)
  if (!TASK_LANES.includes(lane)) return send400(res, `lane must be one of ${TASK_LANES.join('|')}`)
  if (b.title !== undefined && (typeof b.title !== 'string' || b.title.length > BACKLOG_TITLE_CAP)) {
    return send400(res, 'invalid title')
  }

  const { rows } = deps.deriveBacklog({ config, fsImpl: deps.fsImpl }) || { rows: [] }
  const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.id === id)
  if (!row) return send404(res)

  const typed = typeof b.title === 'string' && b.title.trim() !== '' ? b.title.trim() : row.title
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  // The identifier rides in front of the text so a queue row can be read back to the line it
  // came from. Both halves are the project's own words — nothing is composed by this file.
  // The stamp rides here for the same reason it rides on the roster button: a line becoming
  // work belongs to the project whose backlog it was read out of — see doorProject.
  const task = { id: `R-${clock()}`, source: 'roster', ...doorProject(config), title: queueTitleFor(id, typed), lane }
  let norm
  try {
    norm = validateTask(task)
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid task'))
  }
  const enq = await enqueueOrExplain(res, adapter, norm)
  if (enq.answered) return undefined

  emitSafe(deps, { event: 'task.queued', taskId: norm.id })
  return sendJson(res, 200, { ok: true, id, taskId: norm.id })
}

// ── the batch: one request of the owner, fanned out into the work it names ──

/** How many pieces one request may be broken into. A ceiling, not a target. */
const BATCH_ITEMS_CAP = 20

/** One item is a LINE — a subtask title or a backlog identifier. validateTask bounds it again. */
const BATCH_ITEM_CAP = 200

/** The request's own sentence («разгреби мелочь перед демо»), bounded like any task title. */
const BATCH_TITLE_CAP = 200

/**
 * POST /api/batch — body {title, items[], lane?}. One sentence becomes a request row plus the
 * N pieces of work it names, all wearing one batch id.
 *
 * AN ITEM IS EITHER A BACKLOG LINE OR A SENTENCE, and both are legal in one list: the owner
 * ticks what already exists and types what does not, and the backlog is not a compulsory
 * springboard. They are told apart by SHAPE — a string in the backlog's own identifier grammar
 * is a reference, anything else is a subtask. A referenced line MUST be in the file, resolved
 * through the same derive the backlog board and the promote door read, so a batch can never
 * contain an item nobody can trace back to anything; its words come from the file, never from
 * here. Everything the owner types is DATA: it becomes a task TITLE and reaches a worker only
 * by the existing dispatch path, never as an instruction of its own.
 *
 * THE REQUEST ROW IS WRITTEN LAST, and that is the failure plan rather than a detail. Every
 * piece is validated before anything at all is written, so a bad body costs nothing; if the
 * database then gives out halfway, what survives is loose work a person can see and run, and
 * no request row claiming to be a batch whose items do not exist. The reverse order would
 * leave exactly that phantom on the screen.
 */
async function handleBatchCreate({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.enqueue !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['title', 'items', 'lane']))) return undefined

  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (title === '' || title.length > BATCH_TITLE_CAP) return send400(res, 'invalid title')
  const lane = b.lane === undefined || b.lane === null ? BACKLOG_DEFAULT_LANE : String(b.lane)
  if (!TASK_LANES.includes(lane)) return send400(res, `lane must be one of ${TASK_LANES.join('|')}`)

  // A BATCH OF NOTHING IS NOT A BATCH: an empty list is refused rather than accepted into a
  // request that would then sit there, assembled and closed, having done nothing.
  if (!Array.isArray(b.items) || b.items.length === 0) return send400(res, 'a batch needs at least one item')
  if (b.items.length > BATCH_ITEMS_CAP) return send400(res, `a batch carries at most ${BATCH_ITEMS_CAP} items`)
  const lines = []
  for (const raw of b.items) {
    const line = typeof raw === 'string' ? raw.trim() : ''
    if (line === '' || line.length > BATCH_ITEM_CAP) return send400(res, 'invalid item')
    lines.push(line)
  }

  // The referenced lines, resolved ONCE against the file — the same read the board does.
  const referenced = lines.filter((l) => BACKLOG_WIRE_ID_RE.test(l))
  let backlogRows = []
  if (referenced.length > 0) {
    if (typeof deps.deriveBacklog !== 'function') return send501(res)
    const answer = deps.deriveBacklog({ config, fsImpl: deps.fsImpl }) || { rows: [] }
    backlogRows = Array.isArray(answer.rows) ? answer.rows : []
    for (const id of referenced) {
      if (!backlogRows.some((r) => r && r.id === id)) return send404(res)
    }
  }

  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  // ONE identifier, not two: the request's own id IS the batch id, so nothing anywhere has to
  // hold a pair that could disagree. Each item's id reads back to the batch it belongs to.
  // МОМЕНТ СПРОШЕН ОДИН РАЗ и назван: из него минтуется идентификатор сборки, и он же едет на
  // строку запроса как момент просьбы. Два вызова часов дали бы имя и отметку, расходящиеся на
  // миллисекунду, — то есть две правды о том, когда человек нажал.
  const requestedAt = clock()
  const batchId = `B-${requestedAt}`
  const tasks = lines.map((line, i) => {
    const row = BACKLOG_WIRE_ID_RE.test(line) ? backlogRows.find((r) => r && r.id === line) : null
    // A referenced line rides identifier-first, the way the promote door already writes it, so a
    // queue row can be read back to the line it came from. Both halves are the project's words.
    return {
      id: `${batchId}-${i + 1}`,
      source: 'roster', // a person pressed it — DoR-exempt, exactly like the roster button
      // ONE request, ONE project: the assembly and every piece of it are work of the project
      // the person was looking at when he wrote the sentence — see doorProject.
      ...doorProject(config),
      title: row ? queueTitleFor(row.id, row.title) : line,
      lane,
      batchId,
    }
  })
  const request = {
    id: batchId,
    source: 'roster',
    ...doorProject(config),
    title,
    lane,
    batchId,
    // КОГДА ВЛАДЕЛЕЦ ЭТО ПОПРОСИЛ — тот же момент, из которого сминтован идентификатор сборки,
    // и он записывается ЗДЕСЬ, потому что больше его знать неоткуда. Очередь ставит куски и
    // запрос поштучно, запрос — последним: её собственная отметка на строке говорит, когда
    // строку записали, а не когда человек нажал, и на длинном батче это разные секунды.
    data: { batch: BATCH_PARENT, requestedAt },
  }

  let normalized
  try {
    normalized = [...tasks, request].map((t) => validateTask(t))
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid task'))
  }

  const ids = []
  for (const norm of normalized) {
    const enq = await enqueueOrExplain(res, adapter, norm)
    if (enq.answered) return undefined // the database refused the text; the reason is already sent
    ids.push(norm.id)
  }

  // ONE hint for one action: the screen re-reads the whole state either way, and a hint per
  // item would say «work appeared» twenty times about a single press.
  emitSafe(deps, { event: 'task.queued', taskId: batchId, status: 'queued' })
  return sendJson(res, 200, { ok: true, id: batchId, items: ids.filter((id) => id !== batchId) })
}

/**
 * POST /api/batch/suggest — body `{phrase}`. Формулировка владельца входит; ЧЕРНОВИК состава
 * выходит. НИЧЕГО НЕ ПИШЕТСЯ — ни этим обработчиком, ни тем, что он зовёт.
 *
 * ЗАЧЕМ ДВЕРЬ, КОТОРАЯ НИЧЕГО НЕ СТАВИТ — это и есть всё решение основателя по батчу: он
 * пишет фразу, система предлагает состав, ставит по-прежнему ОН и ставит другой дверью
 * (`POST /api/batch`). Машина, которая и разобрала бы фразу, и запустила бы работу, ответила
 * бы на вопрос, которого ей не задавали. Сьют утверждает это единственным стоящим способом:
 * очередь после вызова ПУСТА.
 *
 * ЧТЕНИЕ БЭКЛОГА ОБЯЗАТЕЛЬНО, а не «если получится». Половина предложения (куски фразы без
 * подбора) выглядит на экране ровно как «в бэклоге ничего похожего нет», и владелец не может
 * отличить одно от другого. Поэтому неподключённое чтение — 501, а не тихая половина.
 *
 * Фраза бьётся о ТОТ ЖЕ потолок, что и заголовок постановки: она им и станет, и предложить
 * заголовок, который дверь постановки потом откажется принять, значит соврать заранее.
 *
 * Разбор — словарь (`chat.mjs proposeBreakdown` говорит это своими словами), и он может
 * ответить ВОПРОСОМ вместо состава: постановка у нас — дискуссия, и «из чего это состоит?»
 * законный её ход, в отличие от выдуманного состава.
 */
async function handleBatchSuggest({ req, res, config, deps }) {
  if (typeof deps.deriveBacklog !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['phrase']))) return undefined

  const phrase = typeof b.phrase === 'string' ? b.phrase.trim() : ''
  if (phrase === '' || phrase.length > BATCH_TITLE_CAP) return send400(res, 'invalid phrase')

  const answer = deps.deriveBacklog({ config, fsImpl: deps.fsImpl }) || { rows: [] }
  const proposal = proposeBreakdown(phrase, Array.isArray(answer.rows) ? answer.rows : [])
  if (!proposal) return send400(res, 'invalid phrase')

  // ОДИН потолок числа элементов на весь батч, и он живёт у двери постановки: предложить
  // больше, чем она примет, значит показать состав, который откажутся принять целиком.
  return sendJson(res, 200, {
    ok: true,
    text: proposal.text,
    question: proposal.question,
    draft: { title: phrase, items: proposal.items.slice(0, BATCH_ITEMS_CAP) },
  })
}

/**
 * POST /api/batch/decide — the word that gets a STOPPED assembly moving again.
 * Body `{batchId, decision:'skip'|'retry'|'cancel', itemId?}`.
 *
 * WHY THIS DOOR EXISTS AT ALL, in the owner's own rule: a broken piece stops the batch and
 * asks him what to do — skip it, run it again, or abandon the whole thing — and NOTHING
 * happens until he answers. The queue enforces the silence (a batch with a broken piece hands
 * out nothing); this is the only way out of it, and there is deliberately no fourth way.
 *
 * WHAT EACH ANSWER REALLY DOES, and each is a durable fact rather than a screen state:
 *   skip   — the piece is remembered as let go on the REQUEST row; it stops holding the
 *            assembly and is still shown, by name, as «пропущен»
 *   retry  — the SAME piece goes back into the queue under its own id, one attempt higher,
 *            keeping its kinship. The same shape the return-with-comment door has always used
 *   cancel — the assembly is remembered as abandoned and the pieces nobody started are taken
 *            out of the queue. What already produced is never touched
 *
 * A DECISION IS ONLY OFFERED ABOUT A BROKEN PIECE, and this door refuses anything else by
 * name: skipping a piece that is merely waiting would be a way to silently drop work through
 * a door that exists to answer a question nobody asked about it.
 */
async function handleBatchDecide({ req, res, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.list !== 'function' || typeof adapter.resolveBatch !== 'function') {
    return send501(res)
  }
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['batchId', 'decision', 'itemId']))) return undefined

  const batchId = b.batchId
  if (typeof batchId !== 'string' || !ID_RE.test(batchId)) return send400(res, 'invalid batchId')
  const decision = typeof b.decision === 'string' ? b.decision : ''
  if (!BATCH_DECISIONS.some((o) => o.id === decision)) {
    return send400(res, `decision must be one of ${BATCH_DECISIONS.map((o) => o.id).join('|')}`)
  }
  const itemId = b.itemId
  if (decision !== 'cancel' && (typeof itemId !== 'string' || !ID_RE.test(itemId))) {
    return send400(res, 'invalid itemId')
  }

  const rows = await adapter.list({})
  const request = rows.find((r) => isBatchParent(r) && (r.batchId || r.id) === batchId)
  if (!request) return send404(res)

  if (decision === 'cancel') {
    await adapter.resolveBatch(batchId, { cancel: true })
    emitSafe(deps, { event: 'task.failed', taskId: batchId, status: 'failed' })
    return sendJson(res, 200, { ok: true, batchId, decision })
  }

  const item = rows.find((r) => r && r.id === itemId && r.batchId === batchId && !isBatchParent(r))
  if (!item) return send404(res)
  // The question is asked ABOUT A BROKEN PIECE. A row that is running, waiting or already
  // produced is not what stopped the assembly, and answering about it would be an answer to a
  // question the daemon never asked.
  if (item.status !== 'failed') return send409(res, 'this piece is not what stopped the batch')

  if (decision === 'skip') {
    await adapter.resolveBatch(batchId, { skip: itemId })
    emitSafe(deps, { event: 'worker.presence', taskId: itemId })
    return sendJson(res, 200, { ok: true, batchId, decision, itemId })
  }

  // retry: the same piece, its own id, one attempt higher, still of its batch. Nothing here
  // decides WHEN it runs — the queue does, when the assembly's turn comes round to it.
  const attempt = Number.isFinite(item.attempt) ? item.attempt + 1 : 2
  const requeue = await enqueueOrExplain(res, adapter, {
    id: itemId,
    source: 'return',
    // The same piece of the same assembly — it keeps the project it was put in with, exactly
    // as it keeps its id and its kinship. See inheritedProject.
    ...inheritedProject([item]),
    title: item.title || itemId,
    lane: item.lane || BACKLOG_DEFAULT_LANE,
    batchId,
    // КОГО ЭТОТ КУСОК ПРОСИЛ — тем же правилом, что у двери возврата выше, и с ценой, которую
    // платит именно сборка: правило «одна сборка — один работник» держится тем, что все куски
    // просят одно и то же. Кусок, повторённый без роли, попросил бы исполнителя, `poolFor`
    // назвал бы это `role_mismatch` — и сборка, честно закреплённая за специалистом,
    // расклеилась бы на первом же повторе.
    ...(item.role ? { role: item.role } : {}),
    attempt,
  })
  if (requeue.answered) return undefined // the database refused the text; the reason is sent
  emitSafe(deps, { event: 'task.queued', taskId: itemId, status: 'queued' })
  return sendJson(res, 200, { ok: true, batchId, decision, itemId, attempt })
}

/**
 * POST /api/wave/hold — «Останови волну 2». Body `{phase, wave, action:'hold'|'release'}`.
 *
 * THE ORDER IS NARROW BY CONSTRUCTION, and that is the whole design. It names a PHASE and a
 * WAVE, and only the work that says it belongs to that echelon is affected: another wave of the
 * same phase, another phase, and every task that never said which echelon it is part of go on
 * exactly as before. A stop that widened to a lane would be the founder's machine going quiet for
 * a reason he cannot see — the fault this door exists to make impossible.
 *
 * WHAT IT ACTUALLY DOES, and neither half is a screen state:
 *   hold    — the order is APPENDED to the register on disk. From the next tick the waiting rows
 *             of that echelon are not handed to anybody, and the ones already under way are asked
 *             (through the founder's existing steering channel, in its «после хода» mode) to
 *             finish the step they are on and stand. Nothing is killed and no session is torn.
 *   release — the lifting is appended too. The waiting rows are handed out again, and the tasks
 *             that stood carry on from where they stood: their unfinished steps stayed in their
 *             sessions the whole time.
 *
 * IT IS WRITTEN DOWN RATHER THAN REMEMBERED because a stop is a word somebody said — nothing in
 * the queue derives it — and a stop that a restart forgets is a stop that lifts itself in the
 * night and finishes the work its owner had stopped.
 *
 * `already` in the answer is honest rather than polite: it says the register did not change,
 * which is what a second press on the same button means.
 */
async function handleWaveHold({ req, res, config, deps }) {
  if (!config.dataDir) return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['phase', 'wave', 'action']))) return undefined

  if (!WAVE_ACTIONS.includes(b.action)) return send400(res, `action must be one of ${WAVE_ACTIONS.join('|')}`)
  const phase = b.phase === undefined || b.phase === null ? '' : String(b.phase)
  if (!PHASE_RE.test(phase)) return send400(res, 'invalid phase')
  // The echelon as a person writes it: a plain number. Bounded here rather than trusted, because
  // it ends up beside task ids in a log line and inside a `data->>` comparison.
  const wave = b.wave === undefined || b.wave === null ? '' : String(b.wave)
  if (!/^\d{1,4}$/.test(wave)) return send400(res, 'invalid wave')

  const wrote = writeWaveHold({
    dataDir: config.dataDir,
    phase,
    wave,
    action: b.action,
    clock: deps.clock,
    fsImpl: deps.fsImpl,
  })
  if (!wrote.ok) return send400(res, wrote.error)
  emitSafe(deps, { event: 'phase.stage', phase, stage: b.action === 'hold' ? 'wave-hold' : 'wave-release' })
  return sendJson(res, 200, { ok: true, phase, wave, action: b.action, already: wrote.already === true })
}

// ── the words of a task: proposed by the system, corrected by its owner ──

/**
 * POST /api/task/suggest — body `{title}`. The formulation goes in; a DRAFT of the words the
 * task could carry comes out. NOTHING IS WRITTEN, by this handler or by anything it calls.
 *
 * WHY A DOOR THAT WRITES NOTHING IS THE WHOLE POINT. The founder's rule for this is one
 * sentence: he writes the formulation, the system writes the rest, and he confirms. A system
 * that derived the words AND put the task in would have answered a question nobody asked it —
 * so the derivation and the writing are two presses, and this is the one that only reads. The
 * suite asserts it the only way worth asserting: the queue is EMPTY after the call.
 *
 * The derivation is a dictionary (chat.mjs `proposeWords` says so in its own words) — the same
 * one the conversation offers, so the words of a task do not depend on which of the two places
 * it was asked from.
 */
async function handleTaskSuggest({ req, res, config, deps }) {
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['title']))) return undefined

  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (title === '' || title.length > CHAT_TEXT_CAP) return send400(res, 'invalid title')

  const words = proposeWords(title)
  if (!words) return send400(res, 'invalid title')
  // КУДА ЭТА ЗАДАЧА УЕДЕТ — И ЧЕГО В ТОМ ДЕРЕВЕ НЕТ. Это единственная дверь, которую окно
  // спрашивает ДО постановки и с текстом человека на руках, поэтому предупреждение живёт
  // здесь: после нажатия оно уже не предупреждение, а объяснение убытка. Дверь по-прежнему
  // НИЧЕГО НЕ СТАВИТ — она и читает-то одним `existsSync` на путь.
  const entry = doorProjectEntry(config)
  return sendJson(res, 200, {
    ok: true,
    kind: words.kind,
    text: words.text,
    draft: { description: words.description, acceptance: words.acceptance },
    project: entry ? { id: entry.id, name: entry.name } : null,
    missing: treeMisses(title, entry, deps),
  })
}

/**
 * POST /api/task/words — body `{taskId, description?, acceptance?, taskContext?, project?}`.
 * The owner's correction of what a task says about itself, on a task whose work is NOT over.
 *
 * ═════════════ И ПРОЕКТ — ТО ЖЕ САМОЕ, В ТО ЖЕ САМОЕ ОКНО ═══════════════════════
 * Задача говорит о себе не только словами: она говорит, ЧЬЯ она — и до сих пор это было
 * единственное, чего исправить было нельзя. Штамп ставится при создании (`doorProject`) и
 * переключением активного проекта задним числом не чинится, поэтому промах стоил полного
 * круга: замерено — шесть работ, поставленных при не том активном проекте, пришлось отменять
 * и пересоздавать по одной. Здесь у той же ошибки цена одного нажатия.
 *
 * НОВОЙ ДВЕРИ ПРИ ЭТОМ НЕ ПОЯВЛЯЕТСЯ: `ROUTES` не изменилась ни на строку. Перестановка —
 * это правка того, что задача говорит о себе, с тем же окном («пока работа не кончилась»),
 * тем же ответом на закрытую строку (409) и тем же гейтом очереди; отдельная дверь была бы
 * вторым экземпляром всех трёх решений.
 *
 * СУЩЕСТВУЕТ ЛИ ТАКОЙ ПРОЕКТ, СПРАШИВАЕТ ДВЕРЬ, А НЕ ОЧЕРЕДЬ — ровно там же, где живёт
 * `doorProject`: конфигом владеет эта половина, а очередь никогда не знала, какие проекты
 * заведены, и учить её этому ради одной правки значило бы сделать её второй половиной
 * реестра. Незнакомый слаг — 400 со СВОИМИ словами, а не 404: 404 у этой двери уже занят
 * и означает «нет такой задачи».
 *
 * A PROMISE IS EDITED BEFORE IT IS JUDGED. On a task that already produced, failed or is
 * waiting for a person, this answers 409 and changes nothing: rewriting what «done» meant
 * after the measuring would leave a row reading as though it had always promised that, and
 * nothing in the product could say otherwise. The queue itself refuses it — this door only
 * turns that refusal into an answer a screen can show.
 *
 * Only the fields PRESENT in the body move, so a screen editing one does not erase the other.
 * Both are bounded by the queue's own caps, not by a second set written here.
 */
async function handleTaskWords({ req, res, config, deps }) {
  const adapter = deps.adapter
  if (!adapter || typeof adapter.setWords !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return body.error === 'body too large' ? send413(res) : send400(res, body.error)
  const b = body.value || {}
  // `taskContext` — снимок контекста, тем же именем, что у двери постановки. Замок не снят:
  // список расширен, а всё, чего в нём нет, по-прежнему 400 ДО всего.
  if (rejectUnknownKeys(res, b, new Set(['taskId', 'description', 'acceptance', 'taskContext', 'project']))) {
    return undefined
  }

  const taskId = b.taskId
  if (typeof taskId !== 'string' || !ID_RE.test(taskId)) return send400(res, 'invalid taskId')
  if (b.description === undefined && b.acceptance === undefined && b.taskContext === undefined && b.project === undefined) {
    return send400(res, 'nothing to change')
  }

  const patch = {}
  if (b.description !== undefined) {
    if (typeof b.description !== 'string') return send400(res, 'description must be a string')
    patch.description = b.description
  }
  if (b.acceptance !== undefined) {
    // ONE FIELD, TWO SHAPES — the door takes either, and the queue's gate bounds both.
    if (typeof b.acceptance !== 'string' && !Array.isArray(b.acceptance)) {
      return send400(res, 'acceptance must be a string or a list of strings')
    }
    patch.acceptance = b.acceptance
  }
  if (b.taskContext !== undefined) {
    // ПОЧЕМУ СНИМОК ПРАВИТСЯ ЭТОЙ ЖЕ ДВЕРЬЮ. Попытка сорвалась потому, что работник чего-то не
    // знал, — человек дописывает недостающее, и следующая выдача уходит с исправленным
    // снимком. Пустая строка здесь — законное СТИРАНИЕ, а не «нечего менять»: человек вправе
    // забрать свои слова назад, и стёртый снимок читается ровно как никогда не написанный
    // (одна тропа чтения — taskContextOf). Потолок применяет очередь, второго здесь не пишем.
    if (typeof b.taskContext !== 'string') return send400(res, 'taskContext must be a string')
    patch.taskContext = b.taskContext
  }
  if (b.project !== undefined) {
    // ПЕРЕСТАВИТЬ МОЖНО ТОЛЬКО В ТО, ЧТО ЭТА МАШИНА ЗНАЕТ. Слаг, которого нет в реестре,
    // прошёл бы структурный гейт очереди и лёг бы на строку — а `taskTreeDir`, не найдя такой
    // записи, тихо увёл бы работу в дерево запуска. Иначе говоря: перестановка «куда-нибудь»
    // выглядела бы как удавшаяся и делала бы ровно ту беду, ради которой всё это написано.
    if (typeof b.project !== 'string' || b.project === '') return send400(res, 'invalid project')
    const known = (Array.isArray(config && config.projects) ? config.projects : []).some((p) => p && p.id === b.project)
    if (!known) return send400(res, 'this machine has no such project')
    patch.project = b.project
  }

  let changed
  try {
    changed = await adapter.setWords(taskId, patch)
  } catch (err) {
    return send400(res, String((err && err.message) || 'invalid words'))
  }
  // The row is either finished or was never there. The two are told apart by asking, so a
  // screen can say «уже поздно» rather than «такой задачи нет» about a task in plain sight.
  if (!changed) {
    let exists = false
    try {
      const rows = await adapter.list({})
      exists = rows.some((r) => r && r.id === taskId)
    } catch {
      /* fail-open: an unreadable queue answers «not found», never a 500 */
    }
    return exists ? send409(res, 'the work of this task is over — its words are not rewritten now') : send404(res)
  }

  emitSafe(deps, { event: 'worker.presence', taskId })
  // Куда задача теперь поставлена — тем же ключом и теми же словами, что у двери постановки.
  // Правка, не трогавшая проект, о нём и не заявляет: `null` здесь читался бы как «переставили
  // в никуда» ровно тем читателем, который и должен показать человеку, где работа лежит.
  return sendJson(res, 200, { ok: true, taskId, ...(patch.project !== undefined ? { project: patch.project } : {}) })
}

// ── the three switches a person holds: the conveyor, the money, the model ──
//
// They share one shape and one law. The shape: explicit-pick the body, hand it to an
// INJECTED applier, refresh the in-process config from what the applier returned, hint. The
// law is the refresh — the process holds ONE config object, and a write that lands on disk
// while this process keeps serving the old one is indistinguishable from a button that did
// nothing (refreshWorkers above carries the live proof of that lesson in its own words).

/**
 * The reserved `lane` of POST /api/budget/set meaning «the whole machine».
 *
 * THE ONLY BUDGET STOP THIS PRODUCT HAS IS MACHINE-WIDE — `budget.monthlyApiCapUsd`, the
 * number policy/budget.mjs actually reads before it allows the sub→API fallback. The field
 * is accepted because the screen sends it, and its ONLY legal value is this literal: writing
 * a per-lane cap that nothing on earth reads would be worse than having no field, because a
 * person would then believe a limit was in force. A named lane is a 400 with that reason.
 */
export const BUDGET_SCOPE_ALL = 'all'

/** The in-process half of the one-config rule for the conveyor switch (see refreshWorkers). */
function refreshPipeline(config, next) {
  if (!next || typeof next !== 'object' || typeof next.pipeline !== 'object') return
  config.pipeline = next.pipeline
}

/** The in-process half of the one-config rule for the budget stop (see refreshWorkers). */
function refreshBudget(config, next) {
  if (!next || typeof next !== 'object' || typeof next.budget !== 'object') return
  config.budget = next.budget
}

/**
 * POST /api/pipeline/toggle — body {enabled:boolean}. The conveyor's own switch.
 *
 * `enabled` is STRICTLY a boolean: `"true"`, `1` and `"on"` are 400s, because the tick reads
 * `=== true` and a truthy string would show as on while the machine stayed off. There is no
 * default here at all — the door has one job, and it takes a word to do it.
 */
async function handlePipelineToggle({ req, res, config, deps }) {
  if (typeof deps.applyPipelineToggle !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['enabled']))) return undefined
  if (typeof b.enabled !== 'boolean') return send400(res, 'enabled must be a boolean')
  let next
  try {
    next = deps.applyPipelineToggle(config, { enabled: b.enabled }, configIo(deps))
  } catch (err) {
    return applierError(res, err)
  }
  refreshPipeline(config, next)
  emitSafe(deps, { event: 'harness.updated' })
  return sendJson(res, 200, { ok: true, pipeline: { enabled: b.enabled } })
}

/**
 * POST /api/budget/set — body {limit:number, lane?}. How much of the founder's money the
 * machine may spend on the API lane in a month, IN DOLLARS.
 *
 * The currency is the provider's own: usage rows book `total_cost_usd` and this product
 * converts nothing, so the cap is compared against dollars and is therefore stated in them.
 * The screen that presses this door says so beside the field — a limit a person believed was
 * in euros is a limit standing somewhere other than where they put it.
 *
 * A HUMAN-ONLY BOUNDARY, and the door is where that is enforced structurally: it exists only
 * behind the founder's token, it is called by nothing inside this daemon, and no verb path
 * reaches it. `0` is legitimate and is the shipped value — it means the API lane has no money
 * and the fallback cannot be taken. A string is a 400 BEFORE the applier: `"50"` compared
 * against a number is how a cap silently stops being one.
 */
async function handleBudgetSet({ req, res, config, deps }) {
  if (typeof deps.applyBudgetStop !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['lane', 'limit']))) return undefined
  if (b.lane !== undefined && b.lane !== BUDGET_SCOPE_ALL) {
    return send400(res, `the only budget stop is machine-wide — lane must be "${BUDGET_SCOPE_ALL}" or absent`)
  }
  if (typeof b.limit !== 'number' || !Number.isFinite(b.limit) || b.limit < 0) {
    return send400(res, 'limit must be a non-negative number of dollars')
  }
  let next
  try {
    next = deps.applyBudgetStop(config, { limit: b.limit }, configIo(deps))
  } catch (err) {
    return applierError(res, err)
  }
  refreshBudget(config, next)
  emitSafe(deps, { event: 'harness.updated' })
  return sendJson(res, 200, { ok: true, budget: { lane: BUDGET_SCOPE_ALL, limit: b.limit } })
}

/**
 * The three words POST /api/connection/telegram answers to, and the whole of its vocabulary.
 *
 * `connect` carries the token. `code` re-issues a pairing code for the bot that is already
 * stored — the press for «десять минут прошло», which must not require a person to fetch
 * their credential from BotFather again, because this product deliberately cannot show it
 * back to them. `disconnect` removes the bot, the pair and any live code together.
 */
export const TELEGRAM_ACTIONS = Object.freeze(['connect', 'code', 'disconnect'])

/** The in-process half of the one-config rule for the link (see refreshWorkers). */
function refreshTelegram(config, next) {
  if (!next || typeof next !== 'object') return
  if (next.telegram === undefined) delete config.telegram
  else config.telegram = next.telegram
}

/**
 * POST /api/connection/telegram — body {action ∈ TELEGRAM_ACTIONS, botToken?}. THE ONE DOOR
 * OF THE TELEGRAM CONNECTION, and the reason a person never opens the daemon's config file to
 * connect their own bot.
 *
 * ═════════════ THE TOKEN GOES IN AND NEVER COMES BACK OUT ═══════════════════════════
 * This is the only route in the table whose request body carries a credential, and the whole
 * shape of the handler follows from that one fact:
 *   - THE ANSWER IS THE VIEW, NEVER THE BODY. What comes back is `telegramLinkView`, whose
 *     token field is four characters long by construction — the response is not «the stored
 *     config minus a field», so there is no field to forget to remove.
 *   - NOTHING IS ECHOED ON REFUSAL EITHER. A malformed token is a 400 whose message names the
 *     SHAPE (the applier's own error, which never quotes a value); it is not «"…" is not a
 *     token», which is how a credential lands in a browser console and a support screenshot.
 *   - THE CODE IS MINTED HERE AND WRITTEN BY THE APPLIER. The door owns the clock (deps.clock,
 *     so the suite drives expiry without waiting); the file is owned by config.mjs, exactly as
 *     it is for the conveyor, the money and the roster.
 *
 * ═════════════ AND THE LOOP IS REBUILT IN THE SAME BREATH ═══════════════════════════
 * `deps.telegramRestart` is what makes the connection real on a RUNNING daemon: without it the
 * token would be written and no loop would be listening for the pairing code until somebody
 * restarted the process. It is best-effort — a link that refuses to come up must not turn a
 * successful write into a 500, so the state the window then shows is the truth on disk.
 */
async function handleConnectionTelegram({ req, res, config, deps }) {
  if (typeof deps.applyTelegramConnect !== 'function' || typeof deps.applyTelegramDisconnect !== 'function') {
    return send501(res)
  }
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['action', 'botToken']))) return undefined
  if (typeof b.action !== 'string' || !TELEGRAM_ACTIONS.includes(b.action)) {
    return send400(res, `action must be one of ${TELEGRAM_ACTIONS.join('|')}`)
  }
  if (b.action === 'connect' && (typeof b.botToken !== 'string' || b.botToken.trim() === '')) {
    return send400(res, 'connect requires the bot token BotFather gave you')
  }
  if (b.action !== 'connect' && b.botToken !== undefined) {
    return send400(res, 'botToken belongs to the connect action only')
  }

  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  let next
  try {
    if (b.action === 'disconnect') {
      next = deps.applyTelegramDisconnect(config, configIo(deps))
    } else {
      const pairing = mintPairing({ now: clock() })
      next = deps.applyTelegramConnect(
        config,
        { ...(b.action === 'connect' ? { botToken: b.botToken.trim() } : {}), pairing },
        configIo(deps),
      )
    }
  } catch (err) {
    return applierError(res, err)
  }
  refreshTelegram(config, next)
  if (typeof deps.telegramRestart === 'function') {
    try {
      deps.telegramRestart()
    } catch {
      /* the write landed; a link that will not come up is visible in the state, not as a 500 */
    }
  }
  emitSafe(deps, { event: 'harness.updated' })
  return sendJson(res, 200, { ok: true, telegram: telegramLinkView(config, { now: clock() }) })
}

/**
 * POST /api/agent/model — body {agent, model?, effort?}, at least one of the two.
 *
 * The model and the effort are the ONE part of a worker's session that does not come from the
 * project checkout, so this is where the founder's assignment is written down — and
 * `assertProfileParity` (runner/args.mjs) is what screams if a spawn ever runs a different
 * one. The applier owns the grammar and the unknown-agent refusal; the door owns the shape.
 *
 * The value grammar is a LOCAL copy of the applier's, for the reason MACHINE_ID_RE and
 * ENV_NAME_RE are: importing it would put an appliers module on this file's import graph.
 * It is deliberately NOT `ID_RE` — a shipped model name carries characters an id may not
 * (`claude-opus-5[1m]`), and a door stricter than its applier refuses the founder's newest
 * model for no reason. What both sides really forbid is a leading dash: these values become
 * one element of a spawn's argument array, so the only harmful shape is «looks like a flag».
 */
const PROFILE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/
async function handleAgentModel({ req, res, config, deps }) {
  if (typeof deps.applyAgentModel !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['agent', 'model', 'effort']))) return undefined
  if (typeof b.agent !== 'string' || !ID_RE.test(b.agent)) return send400(res, 'invalid agent')
  if (b.model === undefined && b.effort === undefined) return send400(res, 'model or effort required')
  for (const field of ['model', 'effort']) {
    if (b[field] !== undefined && (typeof b[field] !== 'string' || !PROFILE_VALUE_RE.test(b[field]))) {
      return send400(res, `invalid ${field}`)
    }
  }
  let next
  try {
    next = deps.applyAgentModel({
      config,
      id: b.agent,
      ...(b.model !== undefined ? { model: b.model } : {}),
      ...(b.effort !== undefined ? { effort: b.effort } : {}),
      ...configIo(deps),
    })
  } catch (err) {
    return applierError(res, err)
  }
  refreshWorkers(config, next)
  const worker = (next && next.workers ? next.workers : []).find((w) => w && w.id === b.agent)
  emitSafe(deps, { event: 'harness.updated' })
  return sendJson(res, 200, {
    ok: true,
    agent: { id: b.agent, model: (worker && worker.model) ?? null, effort: (worker && worker.effort) ?? null },
  })
}

// ── the account door: a subscription joins the pool, its secret does not ──
//
// THE PRIVACY BOUNDARY OF THIS WHOLE PRODUCT RUNS THROUGH THIS HANDLER, so it is stated
// here in one sentence: an account's token exists in the environment of the machine the
// founder set it on, and NOWHERE ELSE — not in the config file, not in this response, not
// in a browser, not in a log, and above all not in the public package. What crosses this
// door is the NAME of the environment variable that holds it, and a name is not a secret.
//
// The door writes through the config module's own applier (INJECTED, like every other
// config write), so the grammar, the duplicate check and the atomic write have exactly one
// owner. Two facts are the door's own: the path must be ABSOLUTE (nothing in this product
// expands a `~`, so a tilde would be created as a literal directory named «~»), and the
// answer carries the login SCENARIO — the environment and the command a human runs in his
// own terminal. The daemon does not run it: an interactive login is the one step of taking
// on an account that has no headless form, and pretending otherwise would mean a daemon
// holding a browser session on the founder's behalf.

/** An env-var NAME, kept LOCAL for the same reason MACHINE_ID_RE is: importing the config
 *  module's copy would put a config WRITE module on this file's import graph. The applier
 *  re-checks the same shape on its own side, which is where the grammar actually lives. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** A directory typed by a human is a path, not a document. */
const ACCOUNT_PATH_CAP = 4096

/** What an account id may be — the same bounded identifier every other id of this file is. */
function invalidAccountPath(v) {
  return typeof v !== 'string' || v === '' || v.length > ACCOUNT_PATH_CAP || v.includes('\0') || !isAbsolute(v)
}

/**
 * POST /api/account/add — body {id, lane, configDir, oauthTokenEnv, spendLogsDir?}.
 *
 * The profile is written DISABLED and the response says so: `enabled:false` is not a default
 * the caller may override, because between «this account exists» and «this account may be
 * spent» stands a human logging it in. The enabling act is the agent toggle that already
 * exists — one door per action, pressed on purpose, afterwards.
 */
async function handleAccountAdd({ req, res, config, deps }) {
  if (typeof deps.addAccount !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['id', 'lane', 'configDir', 'oauthTokenEnv', 'spendLogsDir']))) return undefined
  if (typeof b.id !== 'string' || !ID_RE.test(b.id)) return send400(res, 'invalid id')
  if (typeof b.lane !== 'string' || !TASK_LANES.includes(b.lane)) return send400(res, 'invalid lane')
  // The directory may be EMPTY on disk and that is normal: it is created by the login the
  // response is about, so its existence is deliberately NOT a condition of adding the account.
  if (invalidAccountPath(b.configDir)) return send400(res, 'configDir must be an absolute path')
  if (typeof b.oauthTokenEnv !== 'string' || !ENV_NAME_RE.test(b.oauthTokenEnv)) {
    // The refusal names the SHAPE and never echoes the field: what was sent may be the token.
    return send400(res, 'oauthTokenEnv must be the NAME of an environment variable (UPPER_SNAKE)')
  }
  if (b.spendLogsDir !== undefined && invalidAccountPath(b.spendLogsDir)) {
    return send400(res, 'spendLogsDir must be an absolute path')
  }

  let next
  try {
    next = deps.addAccount(
      config,
      {
        id: b.id,
        lane: b.lane,
        configDir: b.configDir,
        oauthTokenEnv: b.oauthTokenEnv,
        ...(b.spendLogsDir !== undefined ? { spendLogsDir: b.spendLogsDir } : {}),
      },
      configIo(deps),
    )
  } catch (err) {
    return applierError(res, err)
  }
  // The written file is re-read INTO THIS PROCESS, or the very next roster read would serve
  // a pool without the account somebody just added — the «ничего не произошло» lesson.
  refreshWorkers(config, next)
  emitSafe(deps, { event: 'harness.updated' })
  return sendJson(res, 200, {
    ok: true,
    id: b.id,
    // Stated, not implied: the screen must be able to say «добавлен, но выключен» without
    // knowing this file's laws.
    enabled: false,
    // The scenario, in two separate fields rather than one shell line: the founder's machine
    // may be Windows, macOS or Linux and each spells «set this variable» differently, so the
    // screen composes the line and the daemon states the facts. `configDir` is echoed back
    // because the caller just typed it — it never came from this process's own knowledge.
    login: { env: { CLAUDE_CONFIG_DIR: b.configDir }, cmd: 'claude setup-token', tokenEnv: b.oauthTokenEnv },
  })
}

// ── «Дом системы»: the two doors that describe and renew the install itself ──
//
// They are neighbours because they answer the same person in the same minute: something is
// wrong → what am I even running → is there a newer one. Both are READS by default, and
// the one that is not a read cannot happen without a word from a human in its body.

/**
 * GET /api/diagnostics — the five facts the feedback window is allowed to quote.
 *
 * The window's channel is a PUBLIC GitHub issue (the founder's decision; e-mail was
 * refused), so this is the one response of this file whose reader is the open internet.
 * The picking is therefore done TWICE — once inside collectDiagnostics, which assembles the
 * five keys by name, and once here, which names them again on the way out. That is not
 * belt-and-braces for its own sake: the two lists are in different modules, so a field added
 * to one of them cannot ride out through the other, and the equality test on the key set
 * turns red the moment they disagree.
 *
 * Every source is DI-able through deps (a suite reads no real tree), and there is no
 * dependency check: this route can always answer, because a person who cannot open the
 * feedback window cannot report the bug that broke it.
 */
function handleDiagnostics({ res, deps }) {
  const d = collectDiagnostics({
    ...(deps.capabilityPath ? { capabilityPath: deps.capabilityPath } : {}),
    ...(deps.osImpl ? { osImpl: deps.osImpl } : {}),
    ...(deps.processImpl ? { processImpl: deps.processImpl } : {}),
    ...(deps.fsImpl ? { fsImpl: deps.fsImpl } : {}),
    // THE REGISTER IS READ, NEVER HELD. The door gets a function that returns the names the
    // dispatcher could not sign; it owns none of that state and cannot add to it.
    ...(deps.unknownDispatchCodes ? { unknownDispatchCodesImpl: deps.unknownDispatchCodes } : {}),
  })
  sendJson(res, 200, {
    version: d.version,
    platform: d.platform,
    release: d.release,
    node: d.node,
    unknownDispatchCodes: d.unknownDispatchCodes,
  })
}

/**
 * The receipt an APPLIED update leaves, spelled out where a reader will look for it rather
 * than only inside the function that builds it: `update:<from>-><to>@<source>`. It is the
 * update door's analogue of `reverify:<ref>` and `artifact:<path>@<sha>` — one greppable
 * word saying which version replaced which, from where.
 */
export const UPDATE_RECEIPT_FORMAT = 'update:<from>-><to>@<source>'

/** At most this many version sources ride a response (npm + a local checkout is two). */
const UPDATE_SOURCE_CAP = 4

/**
 * POST /api/update/run — the version report, and, on an explicit word, the update itself.
 *
 * Body {confirm:boolean}, and `confirm` is REQUIRED. `false` is the dry run: versions are
 * compared (installed vs the registry vs a local checkout) and NOTHING is written. `true`
 * runs the ordinary updater — which is the ONE standard installer, so every preservation
 * guarantee (the memory corpus, .sma state, foreign settings keys, the человеческие bytes of
 * CLAUDE.md) is the installer's own and this door invents no second write path.
 *
 * AN UPDATE NEVER STARTS BY ITSELF. There is no timer, no «check on boot», no auto-apply:
 * the only way the applying path runs is a human's POST carrying `confirm:true`. Requiring
 * the field even for the dry run is deliberate — an empty body reaching this door means
 * somebody swept the route table, not that somebody asked a question, and the answer to a
 * sweep is 400.
 *
 * THE RUNNER IS INJECTED and takes one flag: `{apply:boolean}`. It is NOT `deps.verbRunner`
 * — that name already belongs to the merge verb of the approve path, and a door that could
 * name the command it runs is exactly the command-exec endpoint this file promises never to
 * grow. The composition root decides WHICH updater this is; the request decides only whether
 * to apply. Paths (`plan.args`, a source's `detail`, the local checkout's directory) are
 * DROPPED here: the report names versions and verdicts, never places on the founder's disk.
 */
async function handleUpdateRun({ req, res, deps }) {
  if (typeof deps.updateRunner !== 'function') return send501(res)
  const body = await readJsonBody(req)
  if (!body.ok) return send400(res, body.error)
  const b = body.value || {}
  if (rejectUnknownKeys(res, b, new Set(['confirm']))) return undefined
  if (typeof b.confirm !== 'boolean') return send400(res, 'confirm must be a boolean')

  let report
  try {
    report = await deps.updateRunner({ apply: b.confirm })
  } catch {
    // The updater's own message is discarded rather than wrapped: it quotes a command line
    // and a directory. The status says what happened; the daemon log keeps the detail.
    return send503(res, 'the updater did not answer')
  }
  const r = report && typeof report === 'object' ? report : {}
  const sources = (Array.isArray(r.sources) ? r.sources : []).slice(0, UPDATE_SOURCE_CAP).map((s) => ({
    id: String((s && s.id) ?? ''),
    version: s && typeof s.version === 'string' ? s.version : null,
    verdict: String((s && s.verdict) ?? 'unknown'),
  }))
  const installed = typeof r.installed === 'string' ? r.installed : null
  const to = typeof r.to === 'string' ? r.to : null
  const source = typeof r.source === 'string' ? r.source : null

  if (!b.confirm) {
    return sendJson(res, 200, { ok: r.ok !== false, dryRun: true, installed, sources })
  }
  const applied = { ran: !!(r.applied && r.applied.ran), exitCode: Number.isInteger(r.applied && r.applied.exitCode) ? r.applied.exitCode : null }
  const ok = r.ok === true && applied.ran && applied.exitCode === 0
  if (ok) emitSafe(deps, { event: 'harness.updated' })
  return sendJson(res, 200, {
    ok,
    dryRun: false,
    installed,
    sources,
    applied,
    ...(ok ? { receipt: `update:${installed ?? '(none)'}->${to ?? '(none)'}@${source ?? '(none)'}` } : {}),
  })
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
  handleSkillCreate,
  handleMcpToggle,
  handleAsset,
  handleProjects,
  handleProjectAdd,
  handleProjectRename,
  handleProjectSelect,
  handleProjectPlanning,
  handleMachines,
  handleMachinePair,
  handleMachineAdd,
  handleMachineRemove,
  handleChat,
  handleChatStop,
  handleRedirect,
  handleChatHistory,
  handleChatConversations,
  handleChatRename,
  handleImportScan,
  handleImportEnroll,
  handleOnboarding,
  handleOnboardingAnswer,
  handleOnboardingComplete,
  // the V5.4 twenty-three (see PENDING_ROUTES)
  handlePhaseStage,
  handlePhaseCard,
  handlePhaseUat,
  handleDecisionAnswer,
  handleArtifact,
  handleMemoryDrafts,
  handleMemoryApply,
  handleMemoryIndex,
  handleMemoryLint,
  handleCoordination,
  handleClaimClear,
  handleBacklog,
  handleBacklogPromote,
  handleAttempt,
  handleShipGate,
  handleShipPublish,
  handleSearch,
  handleAccountAdd,
  handlePipelineToggle,
  handleDiagnostics,
  handleUpdateRun,
  handleBudgetSet,
  handleAgentModel,
  // the batch request, and the word its owner answers a stopped one with
  handleBatchCreate,
  handleBatchDecide,
  handleBatchSuggest,
  handleTaskSuggest,
  handleTaskWords,
  // «останови волну 2» — одна волна одной фазы встаёт, и она же снова идёт
  handleWaveHold,
  // остановка задачи человеком: сначала умирает живой ребёнок, потом закрывается строка
  handleTaskCancel,
  // папка фазы: дерево её каталога и один файл из него текстом, только чтение
  handlePhaseFiles,
  // настройки одного подключения: свой бот Telegram — токен внутрь, код пары наружу
  handleConnectionTelegram,
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
  if (!match) return send404(res) // closed table — no route reflection
  if (match.badId) return send400(res, 'invalid id')

  const addr = remoteAddr(req)
  if (limiter.isLimited(addr)) return send429(res)

  // Bootstrap: GET / with ?token= exchanges a CORRECT token (once) for the HttpOnly
  // cookie. A query token is honoured ONLY here — never by authed().
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
