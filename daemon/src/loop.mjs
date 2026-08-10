/**
 * loop.mjs — THE STATELESS TICK: the core of the daemon, where the operator stops being
 * the runtime.
 *
 * ═══════════════════════ STATELESS CONSUMER ═══════════════════════════════════════
 * The daemon is a POLL over durable state. `tick(deps)` executes ONE pass and holds NO
 * task memory: every tick re-derives from the QueueAdapter (Postgres truth) + the
 * attempt ledger. The process is KILLABLE AT ANY LINE — restart = resume; a lost tick
 * self-heals on the next one. There is NO in-process registry of live tasks
 * here: this file constructs NO Map and NO Set anywhere (a literal grep gate). Any keyed
 * lookup belongs in the adapter/ledger or a helper module — never in the tick.
 *
 * ═══════════════════════ CONSUME-NEVER-REIMPLEMENT ════════════════════════════════
 * The tick COMPOSES existing verbs, it never reimplements them:
 *   - preflight  — verify-before-execute mechanized: 'built' → complete on the preflight
 *                  receipt, skip the spawn entirely (the work already exists).
 *   - worktree   — per-task branch `wt/<taskId>`; the worktree.mjs EXPECTED_BASE guard
 *                  (platform-neutral) stays ON inside the provision verb.
 *   - reverify   — the exit gate FOR CODE: done = a GREEN reverify receipt, whoever
 *                  the executor was. No receipt → fail('no_receipt'); never completed on
 *                  the daemon's word (the Multica «completed = слово демона» anti-lesson).
 *                  Work whose product is PROSE passes the SECOND gate instead (see
 *                  STAGE_ARTIFACTS below): the document its stage owes, on disk AND in the
 *                  history. Work whose product is an ANSWER passes the THIRD (see
 *                  answerOnlyGate below): the attempt changed nothing at all and said so.
 *                  Three gates, one law — the daemon decides from what it can see for
 *                  itself, never from what the worker said about itself.
 *   - merge      — stays a serialized verb invoked ONLY from the front's approve path.
 *                  The loop itself NEVER merges.
 * All four run through ONE injected `verbRunner(bin, argsArray, {cwd}) → {code, stdout}`
 * that spawns `node scripts/sma/cli.mjs <verb> …` with the shell disabled. Tests inject a
 * recorder; production injects the real child runner.
 *
 * ═══════════════════════ THE FOUNDER-PUSH LAW ═════════════════════════════════════
 * This process holds NO origin-push path. Approved work travels back by the FOUNDER
 * pulling the worker host as a git remote — the daemon
 * never talks to origin. COMMENT DISCIPLINE: the two-word push invocation literal
 * is never written in this file or any daemon source; where the concept is unavoidable it
 * is «the push verb». Workers never push; the loop's only git surface is worktree/merge
 * verbs, both local by construction.
 *
 * ═══════════════════════ AN ATTEMPT MUST EXPLAIN ITSELF ═══════════════════════════
 * The exit gate asks TWO questions, in the same place, under the same law:
 *   - is there a GREEN reverify receipt?         (the work is certified)
 *   - did the attempt leave an APPROACH NOTE?    (the work is explained)
 * A green receipt without a note fails 'no_journal' — down the identical path an attempt
 * without a receipt takes. The note is read off the stream the tick already collects (the
 * same soft-marker protocol as the failure markers) and appended to the decision journal,
 * alongside the memory trace derived from the worker-context load. Every journal write is
 * fail-open: an unwritable journal can never wedge a tick, and never lies a status.
 *
 * ═══════════════ THE CAPABILITY ENVELOPE IS RESOLVED WHERE WORK IS HANDED OVER ════
 * The envelope used to be a declaration with no consumer.
 * Now the lane's envelope is resolved the moment a task is claimed — it is a property of
 * the LANE, so it is known before the route is — validated once, and consulted through
 * `envelopeAllows` at the two points THIS PROCESS actually mediates:
 *   - before a worker process is started at all (the envelope must grant the shell tool a
 *     spawn IS; a lane whose envelope grants no execution surface never reaches a spawn);
 *   - before the forge lane's committed draft is accepted (its path must lie inside the
 *     lane's declared write scope, on a segment boundary, with no traversal).
 * A refusal is FAIL-CLOSED and NEVER SILENT: the task is failed with a named reason from
 * the existing taxonomy, the detail reaches the daemon's own log, and the attempt row
 * carries the digest of the envelope that refused. What this does NOT do is bound the
 * worker's own reach INSIDE its session — that surface is still the checkout's
 * `.claude/settings.json` (FLEET-INVARIANTS §5.1 states the half that remains open, and it
 * stays stated). The preflight-«built» door is deliberately upstream of the spawn gate: a
 * task whose work already exists completes without any worker, so refusing it for a tool
 * nothing was going to use would be a gate inventing work to refuse.
 *
 * ═══════════════ THE ATTEMPT ROW CARRIES THE WORLD IT RAN IN ══════════════════════
 * Both `recordAttempt` call sites below stamp what this file can TRUTHFULLY compute: the
 * digest of the lane envelope resolved above, the digest of the memory corpus the worker
 * stood in, and — from `applyTransition` — the idempotency key and state-machine version
 * of the transition the outcome stands for. `policyVersion`, `harnessVersion` and
 * `planHash` stay ABSENT; `attemptStamp` says once, in one place, why each of them has no
 * real value to carry.
 *
 * ═══════════════ THE LEDGER IS RECONCILED ONCE A TICK ═════════════════════════════
 * Step (1b) runs `reconcileAttempts` straight after the liveness sweep: the sweep writes
 * the rows it can observe, and the pass then appends the rows for attempts NOBODY observed
 * — the ones pg-boss's own lease expiry retried while this daemon was down. Those rows are
 * flagged `reconstructed` and never pretend to be live ones. Fail-open like the sweep: a
 * reconciliation that throws is journaled and the tick continues.
 *
 * ═══════════════════════ FAIL-OPEN HONESTY (merge-gate posture) ═══════════════════
 * The whole tick is wrapped fail-open: any thrown error is journaled and the affected
 * task is FAILED HONESTLY ('runtime_offline' on spawn infra errors) — a tick bug can
 * never wedge the daemon and never lie a status. An empty tick short-circuits with
 * {idle:true} and no spawn (skipTimerWhenNoActionableWork): a timer that fires on an
 * empty queue is the cheapest way to burn a machine for nothing.
 *
 * Node built-ins only; every collaborator injected. Zero deps; zero network in this file.
 */

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync } from 'node:fs'
import { join } from 'node:path'

import { pipelineEnabled } from './config.mjs'
import { resolveExpireMs } from './queue/adapter.mjs'
import { livenessSweep } from './queue/liveness.mjs'
import { reconcileAttempts } from './queue/reconcile.mjs'
import { memorySnapshotHash } from './queue/attempt-ledger.mjs'
import { defaultEnvelope, validateEnvelope, envelopeAllows } from './queue/capability-envelope.mjs'
import { applyTransition } from './queue/state-machine.mjs'
import { buildForgePrompt, lintDraft, writeForgeReceipt, draftDirFor } from './forge/forge.mjs'
import { parseApproachNote, attemptIdFor } from './front/journal.mjs'
import { parseClaudeEvent, parseCodexEvent } from './runner/stream.mjs'
import { markWindowObserved, markWindowClosed } from './policy/windows.mjs'
import { claudeUsageFromResult, codexUsageFromFinal } from './runner/usage.mjs'
import { memoryDirOf } from './front/project-sync.mjs'
import { createQuestions, findPhaseDir, STAGE_ARTIFACTS } from './front/questions.mjs'

/** The execution lanes, in the documented stable order (mirrors the adapter's lanes). */
const LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/**
 * The tool an envelope must grant before this process will start anything for a task. A
 * spawn IS an operating-system process, and `allowedTools`'s shell entry is the dimension
 * that grants one — §5.1 of FLEET-INVARIANTS already names it as the entry that
 * structurally permits everything below it, which is precisely why its ABSENCE has to mean
 * «do not start».
 */
const SPAWN_TOOL = 'Bash'

const TOUCH_THROTTLE_MS = 30000 // touch at most once per 30s while streaming
const HOUR_MS = 3600000

/**
 * The options EVERY worker spawn is assembled with, named once so the two spawn paths in this
 * file cannot come to disagree.
 *
 * `forwardSubagentText` puts the text and thinking of DELEGATED sessions on the same stream
 * as the main one. Without it a worker that delegates goes silent for minutes at a time and
 * the live log — the whole point of watching an attempt — has nothing to show but a spinner,
 * which reads as «it is stuck» rather than «it is busy». args.mjs made it opt-in and off by
 * default; this is the opt-in.
 */
const SPAWN_OPTIONS = Object.freeze({ forwardSubagentText: true })

// ═══════════════════════ THE SECOND EXIT GATE — WORK MADE OF PROSE ════════════════
//
// Until now this process knew exactly one way to be done: a green reverify receipt. That is
// the right law for work whose product is code, and it is the WRONG law for a stage of the
// phase cycle — a discussion, a plan, an acceptance — whose product is a document. Those
// stages have no targeted tests to be green, so every one of them started from the screen
// would have failed «нет квитанции» while sitting next to the file it had just written.
//
// So there are two gates, and the SAME law governs both: THE DAEMON DECIDES, from facts it
// can see for itself. For code that fact is a receipt; for a document it is (1) the file the
// stage was supposed to produce, present in the phase's own directory, and (2) a git line
// saying it was committed. Neither gate reads a word the worker said about itself — a worker
// that announces «документ готов» without writing one is the first threat this gate exists
// for, and prose is trivially easy to announce.
//
// THE MAP `STAGE_ARTIFACTS` IS THE WHOLE «which document proves which stage» RULE, in one
// place, on purpose: a stage whose artifact is not declared there fails by name rather than
// picking whichever gate happens to be looser. It is IMPORTED from questions.mjs rather than
// written here, because the phase card on the screen has to call a stage done on exactly the
// criteria this gate closes it on — two copies would be two answers about one directory, and
// the half of the map that names the checkpoint files always lived in that module anyway.
//
// THE RECEIPT A DOCUMENTARY OUTCOME COMPLETES ON is `artifact:<checkout-relative path>@<short
// sha>` — written once, by artifactReceipt() below, and spelled out here so the format is
// findable by the word rather than only by the function that assembles it. It stands where a
// `reverify:` receipt stands for code, and it names both halves of the proof: which file, and
// which commit carries it.
//
// WHAT THIS GATE HONESTLY DOES NOT PROVE: that the document on disk is THIS attempt's work
// rather than a previous one's. It proves that the stage's product exists and is in the
// repository's history — which is what makes the outcome inspectable by a person. The
// attempt-scoped question is answered one layer up, by the approach note the gate still
// requires and by the commit the reviewer opens.
const DOCUMENT_KIND = 'document'

/** Where phases live under a checkout, in the forward-slashed form git pathspecs want. */
const PHASES_PATH = '.planning/phases'

/** Resolve the injectable fs surface; defaults are the real node:fs calls (forge.mjs posture). */
function resolveIo(fsImpl) {
  const io = fsImpl ?? {}
  return {
    existsSync: io.existsSync ?? fsExistsSync,
    readdirSync: io.readdirSync ?? fsReaddirSync,
  }
}

/** The `data` envelope a stage task carries, or an empty one for ordinary code work. */
function stageDataOf(task) {
  const data = task && task.data
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/**
 * findArtifact(deps, cwd, phase, suffix) → the checkout-relative path of the newest file of a
 * phase directory whose name ends with `suffix`, or null. «Newest» is the LAST name in sorted
 * order — for every artifact this map names, the name carries its own sequence
 * (`12-03-PLAN.md`), so sorting is deterministic where a modification time would not be.
 */
function findArtifact(deps, cwd, phase, suffix) {
  const io = resolveIo(deps.fsImpl)
  const root = join(cwd ?? '.', PHASES_PATH)
  if (!io.existsSync(root)) return null
  let dirs
  try {
    dirs = io.readdirSync(root)
  } catch {
    return null
  }
  const dir = findPhaseDir(dirs, phase)
  if (!dir) return null
  let names
  try {
    names = io.readdirSync(join(root, dir))
  } catch {
    return null
  }
  const file = names
    .map(String)
    .sort()
    .filter((name) => name.endsWith(suffix))
    .pop()
  return file ? `${PHASES_PATH}/${dir}/${file}` : null
}

/**
 * artifactSha(deps, cwd, relPath) → the short sha of the last commit that touched the file, or
 * null when git names none. THE «not just written, but recorded» HALF of the gate: a file that
 * exists only in a working tree is invisible to every reader but this machine's disk.
 */
function artifactSha(deps, cwd, relPath) {
  if (typeof deps.execGit !== 'function') return null
  try {
    const out = String(deps.execGit(['log', '-1', '--format=%h', '--', relPath], { cwd }) || '')
    return out.split(/\r?\n/)[0].trim() || null
  } catch {
    return null
  }
}

/** The receipt a documentary outcome is completed on: the file and the commit that carry it. */
function artifactReceipt(relPath, sha) {
  return `artifact:${relPath}@${sha}`
}

/**
 * parkedRound(deps, task, cwd) → what to do about a checkpoint this stage may have parked:
 *   null                 — nothing is parked; the caller's own gate decides
 *   {receiptRef}         — a question is parked AND committed: THE ROUND SUCCEEDED. The row
 *                          completes on the artifact receipt, which the contract turns into
 *                          `awaiting_approval` — a card that asks the founder something
 *   {reason, detail}     — a question is parked and NOT committed, which is a refusal: a
 *                          question nobody but this disk can see is not a question yet
 *
 * The check is a FILE check. The daemon opens the checkpoint the workflows write and asks the
 * questions engine — the one place that knows what «still open» means — whether anything in
 * it is unanswered. It never parses the worker's console output for a marker: a round is
 * parked because a file says so, not because a process said so.
 */
function parkedRound(deps, task, cwd) {
  const { stage, phase } = stageDataOf(task)
  const spec = STAGE_ARTIFACTS[stage]
  if (!spec || !spec.checkpoint || phase === undefined || phase === null) return null

  let path = null
  try {
    const engine = createQuestions({ projectDir: cwd, fsImpl: deps.fsImpl, checkpointSuffix: spec.checkpoint })
    path = engine.checkpointPath(phase)
    if (!path || engine.openQuestions(phase).length === 0) return null
  } catch (err) {
    // A torn or foreign checkpoint is NOT a parked round — but it is a fact somebody has to
    // see, so it is said out loud and the stage's own gate then decides the outcome.
    writeLog(deps, { type: 'checkpoint.unreadable', taskId: task.id, stage, error: String((err && err.message) || err) })
    return null
  }

  const relPath = String(path).replace(/\\/g, '/').replace(`${String(cwd).replace(/\\/g, '/')}/`, '')
  const sha = artifactSha(deps, cwd, relPath)
  if (!sha) {
    return { reason: 'no_artifact', detail: `чекпойнт ${relPath} не закоммичен — вопрос виден только этой машине` }
  }
  return { receiptRef: artifactReceipt(relPath, sha) }
}

/**
 * documentGate(deps, task, cwd) → {receiptRef} when a documentary stage really produced its
 * document, or {reason, detail} naming why not. Fail-closed on an undeclared stage.
 */
function documentGate(deps, task, cwd) {
  const { stage, phase } = stageDataOf(task)
  const spec = STAGE_ARTIFACTS[stage]
  if (!spec) {
    return { reason: 'no_artifact', detail: `стадия "${stage ?? '(нет)'}" не объявлена — гейту нечем доказать её результат` }
  }
  const relPath = findArtifact(deps, cwd, phase, spec.produces)
  if (!relPath) {
    return { reason: 'no_artifact', detail: `стадия "${stage}" не оставила файла ${spec.produces} в каталоге фазы ${phase}` }
  }
  const sha = artifactSha(deps, cwd, relPath)
  if (!sha) {
    return { reason: 'no_artifact', detail: `${relPath} есть на диске, но не закоммичен — истории он не достался` }
  }
  return { receiptRef: artifactReceipt(relPath, sha) }
}

/** The receipt an ANSWER completes on: the attempt whose journal carries the words. */
function answerReceipt(attemptId) {
  return `answer:${attemptId}`
}

/**
 * answerOnlyGate(deps, config, task, branch, workDir, noteWritten) → {receiptRef} when this
 * attempt is an ANSWER — it changed nothing whatsoever and explained itself — or null when
 * it is not, and the caller's own gate decides.
 *
 * WHY THIS GATE EXISTS. «Разберись и скажи» is real work, and it used to end in
 * fail('no_receipt'): the worker read, understood, answered — and the queue called it a
 * defect, because the only door to done demanded a receipt over code that was never
 * supposed to exist. Twice observed live. The founder's ruling: such a task ends with the
 * worker's answer, taken to approval to be acknowledged, not with a red row.
 *
 * WHY IT DOES NOT WEAKEN «RECEIPTS OR NOTHING». The law it must not touch is about work
 * that TOUCHED THE REPOSITORY. So this gate opens only when the attempt provably touched
 * nothing, and it asks git twice, never the worker:
 *
 *   1. ZERO COMMITS on the task branch beyond the base the worktree was cut from. The base
 *      is the main checkout's HEAD — the same anchor `worktree provision` captured as
 *      EXPECTED_BASE, and the daemon never commits there while a task runs.
 *   2. A CLEAN worktree. Files edited and left uncommitted are unfinished code work, not an
 *      answer; that attempt keeps failing exactly as it does today.
 *
 * Both questions fail SAFE: no git surface, a throw, a count that is not a plain zero, or a
 * single dirty line, and the answer is null — the attempt falls through to the code gate and
 * the old outcome stands. The only way through this door is a repository that cannot tell the
 * attempt ever happened.
 *
 * THE NOTE IS REQUIRED, exactly as everywhere else. An answer nobody wrote down is not an
 * answer, and the note IS the artefact here — the receipt names the attempt whose journal
 * holds it, so what the founder acknowledges on the card is the worker's own words.
 */
function answerOnlyGate(deps, config, task, branch, workDir, noteWritten) {
  if (!noteWritten) return null
  if (typeof deps.execGit !== 'function') return null

  let commits
  try {
    commits = String(deps.execGit(['rev-list', '--count', branch, '^HEAD'], { cwd: config.repoDir }) || '').trim()
  } catch {
    return null
  }
  if (commits !== '0') return null

  let dirty
  try {
    dirty = String(deps.execGit(['status', '--porcelain'], { cwd: workDir }) || '').trim()
  } catch {
    return null
  }
  if (dirty) return null

  return { receiptRef: answerReceipt(attemptIdFor(task.id, task.attempt)) }
}

/** Worker final-output markers — a SOFT protocol the worker MAY emit. */
const MARKER_RE = /^\s*(NEEDS_DECISION|MISSING_ACCESS)\s*:/

/**
 * classifyFailure({spawnError, exitCode, receipt, workerMarker}) → a FAIL_REASONS code.
 * Pure. Maps a non-completing outcome onto the failure taxonomy, sharpest signal first:
 *   spawnError                     → 'runtime_offline'  (the process never ran)
 *   worker marker NEEDS_DECISION   → 'needs_decision'   (a call only a human can make)
 *   worker marker MISSING_ACCESS   → 'missing_access'   (credentials/permissions absent)
 *   red reverify receipt           → 'tests_red'        (targeted tests failed)
 *   no receipt + nonzero exit      → 'agent_error'      (the worker crashed)
 *   no receipt + exit 0            → 'no_receipt'        (claimed done, never certified)
 *   green receipt + no note        → 'no_journal'       (certified, never explained)
 *   anything else                  → 'agent_error'
 * A marker (when present) BEATS the receipt — the worker gave the sharper reason. The
 * missing-RECEIPT law is never weakened by the missing-NOTE law: an attempt with neither
 * still reads 'no_receipt' (the older, sharper omission wins).
 *
 * @param {{spawnError?:any, exitCode?:number|null, receipt?:{verdict?:string,ref?:any}|null, workerMarker?:string|null, journalComplete?:boolean}} [o]
 * @returns {string}
 */
export function classifyFailure({ spawnError, exitCode, receipt, workerMarker, journalComplete } = {}) {
  if (spawnError) return 'runtime_offline'
  if (workerMarker === 'NEEDS_DECISION') return 'needs_decision'
  if (workerMarker === 'MISSING_ACCESS') return 'missing_access'
  if (receipt && receipt.verdict === 'red') return 'tests_red'
  if (!receipt) {
    return Number.isFinite(exitCode) && exitCode !== 0 ? 'agent_error' : 'no_receipt'
  }
  if (receipt.verdict === 'green' && journalComplete === false) return 'no_journal'
  return 'agent_error'
}

/**
 * writeLog(deps, entry) — one line into the daemon's OWN event log (deps.journal), the
 * sink an operator reads. Fail-open like every other narration path.
 */
function writeLog(deps, entry) {
  if (typeof deps.journal !== 'function') return
  try {
    deps.journal(entry)
  } catch {
    /* narration never wedges a tick */
  }
}

/**
 * attemptBlocker(deps, task, route) → {reason, detail} when this attempt CANNOT START, or
 * null when it can. Two questions, asked in the order a person would ask them:
 *
 *   1. is there an executor at all? Without `buildArgs` no spawn can ever be assembled —
 *      the composition root did not wire one, and pretending otherwise costs the task
 *      three retries and gives the card nothing to show;
 *   2. is the routed worker's account actually set up on this machine (deps.workerReady)?
 *
 * Both answers are DI-guarded, so a caller that wires neither seam keeps today's behaviour
 * byte for byte. The reason codes come from the EXISTING closed vocabulary, so every card
 * and label already knows how to render them.
 */
function attemptBlocker(deps, task, route) {
  if (typeof deps.workerReady === 'function' && route && route.workerId) {
    const worker = ((deps.config && deps.config.workers) || []).find((w) => w && w.id === route.workerId)
    let verdict
    try {
      verdict = deps.workerReady(worker)
    } catch (err) {
      verdict = { ready: false, reason: 'missing_access', detail: String((err && err.message) || err) }
    }
    if (verdict && verdict.ready === false) {
      return { reason: verdict.reason || 'missing_access', detail: verdict.detail || 'работник не настроен' }
    }
  }
  return null
}

/**
 * executorBlocker(deps) → {reason, detail} when the process holds no way to START a
 * worker. Checked AFTER the preflight door on purpose: a task whose work already exists
 * completes on the preflight receipt without any executor, and that legitimate path must
 * stay open (the pilot smoke rides it).
 */
function executorBlocker(deps) {
  if (typeof deps.buildArgs !== 'function' || typeof deps.spawnWorker !== 'function') {
    return {
      reason: 'runtime_offline',
      detail: 'этот демон не собран с исполнителем (buildArgs/spawnWorker не вшиты) — задачу некому запустить',
    }
  }
  return null
}

/**
 * envelopeBlocker(envelope) → {reason, detail} when THIS LANE'S ENVELOPE does not permit
 * starting a worker process, or null when it does.
 *
 * FAIL-CLOSED ON BOTH LEGS. An envelope the validator refuses grants nothing — a task whose
 * lane is not one of the four resolves to `defaultEnvelope`'s LOCKED envelope, whose
 * `allowedTools` is empty, and it is refused here rather than spawned on the assumption
 * that an unrecognised lane is a harmless one. `missing_access` is the reason because that
 * is what the existing taxonomy already means by «нужен человек: не хватает доступа», and
 * every card and label already renders it.
 *
 * WHAT THIS IS AND IS NOT WORTH, stated rather than implied: for all four shipped lanes
 * `LANE_TOOLS` grants the shell, so today this refuses only a lane the queue should never
 * have produced (`validateTask` rejects one at enqueue). Its value is that the CHECKPOINT
 * now exists at the place a process is started, so the day a lane's tool list is narrowed —
 * or a lane is added and its defaults forgotten — the narrowing takes effect in production
 * instead of only in the declaration.
 */
function envelopeBlocker(envelope) {
  const check = validateEnvelope(envelope)
  if (!check.valid) {
    return { reason: 'missing_access', detail: `capability envelope refused: ${check.refusal}` }
  }
  if (!envelopeAllows(envelope, { action: 'tool', tool: SPAWN_TOOL })) {
    return {
      reason: 'missing_access',
      detail: `capability envelope grants no "${SPAWN_TOOL}" — this lane may not start a worker process`,
    }
  }
  return null
}

/**
 * attemptStamp(deps, task, {from, to, actor, envelope}) → the stamp fields THIS FILE can
 * truthfully compute for one attempt row (fleet invariant six — the attempt stamp is
 * fixed at creation; see docs/FLEET-INVARIANTS.md).
 *
 * WHAT IT WRITES:
 *   - `capabilityEnvelope` — the lane envelope this attempt ran under. `recordAttempt`
 *     hashes it at the point of recording and keeps only the digest; the envelope itself is
 *     not an allowlist member and can never reach the durable row.
 *   - `memorySnapshotHash` — the digest of the corpus the worker stood in. The tick knows it
 *     because the tick is what hands the worker its checkout; nothing downstream does.
 *     Omitted entirely when there is no repo dir to derive one from, and written as the
 *     declared absent value when the corpus is empty — an absence that says so beats a
 *     digest of nothing.
 *   - `idempotencyKey` + `stateMachineVersion` — minted by `applyTransition` for the named
 *     transition. A refusal is LOGGED by name and leaves both fields absent; it never
 *     changes the outcome, because an audit layer that could strand a finished task by
 *     refusing to record it would be a worse fault than the one it detects.
 *
 * WHAT IT DELIBERATELY DOES NOT WRITE, AND WHY (never invent a value):
 *   - `policyVersion` — the daemon's routing policy carries no version. The one versioned
 *     policy artifact in the product is the distilled voice's `policyVersion` in the exam
 *     score ledger, which is a different thing; stamping it here would fabricate provenance.
 *   - `harnessVersion` — the harness is the agent CLI the worker is spawned under. This
 *     process assembles its argv and never asks it what version it is.
 *   - `planHash` — a task carries a title, an acceptance sentence and a lane. There is no
 *     plan document, so there is nothing to hash.
 *
 * `from` is the fine state the task was ACTUALLY in — CLAIMED before a worker process was
 * started, RUNNING after — so the minted key names the transition that really happened. A
 * caller that passes no `to` (the preflight-«built» completion, where no worker ever ran and
 * no fleet transition took place) gets no transition fields at all rather than an invented
 * pair.
 */
function attemptStamp(deps, task, { from, to, actor, envelope } = {}) {
  const stamp = {}
  if (envelope) stamp.capabilityEnvelope = envelope

  const corpusDir = memoryDirOf(deps.config && deps.config.repoDir)
  if (corpusDir) {
    try {
      stamp.memorySnapshotHash = memorySnapshotHash({ corpusDir })
    } catch {
      /* the digest is an AUDIT field: an unreadable corpus leaves no stamp, never a throw */
    }
  }

  if (!to) return stamp
  const transition = applyTransition({
    state: from,
    to,
    actor,
    taskId: task.id,
    attemptId: attemptIdFor(task.id, task.attempt),
    attempt: task.attempt,
  })
  if (transition.applied || transition.alreadyApplied) {
    stamp.idempotencyKey = transition.idempotencyKey
    stamp.stateMachineVersion = transition.stateMachineVersion
  } else {
    // Refusals carry state names, actor names and ids only (state-machine.mjs's own law),
    // so the text is safe in a log line.
    writeLog(deps, { type: 'transition.refused', taskId: task.id, from, to, detail: transition.refusal })
  }
  return stamp
}

/**
 * writeJournal(deps, entry) — append one decision-journal layer through the injected sink.
 * FAIL-OPEN by construction: an unwritable or absent journal never changes an outcome.
 */
function writeJournal(deps, entry) {
  if (typeof deps.decisionJournal !== 'function') return
  try {
    deps.decisionJournal(entry)
  } catch {
    /* the journal never wedges a tick */
  }
}

/**
 * openAttemptLog(deps, task) → a live-log writer for THIS attempt, or a working no-op.
 * The log rides the SAME ledger seam the attempt rows and the decision journal ride — one
 * object, one directory — so a test can drive it with fakes and a daemon assembled without a
 * ledger simply does not keep a transcript. FAIL-OPEN at every step: a seam that throws on
 * construction is reported to the daemon's log and then treated as absent.
 */
function openAttemptLog(deps, task) {
  const noop = { append: () => false }
  const { ledger } = deps
  if (!ledger || typeof ledger.attemptLog !== 'function') return noop
  try {
    const writer = ledger.attemptLog({ attemptId: attemptIdFor(task.id, task.attempt) })
    return writer && typeof writer.append === 'function' ? writer : noop
  } catch (err) {
    writeLog(deps, { type: 'attempt-log-error', taskId: task.id, error: String((err && err.message) || err) })
    return noop
  }
}

/**
 * Persist ONE window reading the vendor put on this attempt's stream.
 *
 * WHY IT IS WRITTEN HERE, IN THE MIDDLE OF A RUNNING ATTEMPT, and not at the end: the reading
 * is about the ACCOUNT, not about this task, and it is worth exactly as much whether the
 * attempt goes on to succeed, fail or be killed. A window learned from a session that then
 * crashed is still the truth about the subscription.
 *
 * FAIL-OPEN, like everything else on this line. A window reading that cannot be stored must
 * never cost the attempt: the bar keeps its old number, the work continues, and the miss is
 * logged rather than thrown.
 */
function recordWindowReading(deps, subscription, event) {
  const { accountName, dataDir } = subscription || {}
  if (!accountName || !dataDir) return
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  try {
    markWindowObserved({ dataDir, accountName, observation: event, clock, fsImpl: deps.fsImpl })
    // A WINDOW THE VENDOR SAYS IS FULL IS A CLOSE, AND A CLOSE OUTLIVES THE PERCENTAGE.
    // `markWindowClosed` has existed, tested, with no caller anywhere since it was written; the
    // header two modules over describes «the loop calls it» as though it did. This is that
    // call. It fires on a full window rather than on a refusal wording, because a fraction of
    // one is unambiguous while the vendor's word for «refused» is not something to guess at —
    // when a real refusal is observed on a live stream, its status belongs here beside this.
    if (Number(event.utilization) >= 1 && Number.isFinite(Number(event.resetsAt))) {
      markWindowClosed({ dataDir, accountName, resetAt: event.resetsAt, clock, fsImpl: deps.fsImpl })
    }
  } catch (err) {
    writeLog(deps, { type: 'window-reading-error', account: accountName, error: String((err && err.message) || err) })
  }
}

/**
 * attemptStream(deps, task, streamLines) → `{onLine, sessionId}` — the ONE stdout reader both
 * spawn paths use. It does three things per line, in this order and for these reasons:
 *
 *   (1) collects the line for the markers the gates read afterwards (unchanged);
 *   (2) APPENDS it to the attempt's live log — while the process is still alive, because a
 *       transcript that only exists after the exit is a post-mortem, not an observation.
 *       A delegated line is marked as such, so a screen can badge it instead of showing a
 *       jumble of two voices;
 *   (3) touches the lease, throttled, exactly as before.
 *
 * It also KEEPS THE SESSION ID off the result frame. That identifier is the one thing about a
 * finished attempt that cannot be recovered later, and holding it is what makes resuming a
 * session — instead of paying for its context again — possible at all.
 *
 * The log is read through `parseClaudeEvent`, which never throws on any input: a line that is
 * not JSON is still a line, and it is still logged. NOTHING here can fail the attempt.
 */
function attemptStream(deps, task, streamLines, now, subscription = {}) {
  const log = openAttemptLog(deps, task)
  const state = { sessionId: null }
  let lastTouchAt = 0
  const onLine = (line) => {
    streamLines.push(line)
    const event = parseClaudeEvent(line)
    if (!state.sessionId && event.sessionId) state.sessionId = event.sessionId
    if (event.type === 'rate_limit') recordWindowReading(deps, subscription, event)
    log.append({ line, subagent: event.subagent === true, parentId: event.parentId })
    const t = now()
    if (t - lastTouchAt >= TOUCH_THROTTLE_MS) {
      lastTouchAt = t
      Promise.resolve(deps.adapter.touch(task.id)).catch(() => {})
    }
  }
  return { onLine, sessionOf: () => state.sessionId }
}

/**
 * Parse the last JSON object on a verb's stdout; fail-open to {} (never throws).
 *
 * EXPORTED because the front runs verbs too (the memory workbench, the coordination doors) and
 * «where does a verb's answer end and its chatter begin» must have exactly ONE answer in this
 * daemon. A second parser would be a second contract with the same CLI, and the day one of them
 * learned about a new preamble line the other would still be reading it as the result.
 */
export function parseVerbResult(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim()
    if (!t || t[0] !== '{') continue
    try {
      return JSON.parse(t)
    } catch {
      /* keep scanning upward for a parseable line */
    }
  }
  return {}
}

/** Invoke one CLI verb through the injected runner; returns {code, ...parsedStdout}. */
async function invokeVerb(verbRunner, verb, args, cwd) {
  try {
    const res = await verbRunner('node', ['scripts/sma/cli.mjs', verb, ...args], { cwd })
    const parsed = parseVerbResult(res && res.stdout)
    return { code: (res && Number.isFinite(res.code)) ? res.code : 0, ...parsed }
  } catch (err) {
    return { code: 1, error: String((err && err.message) || err) }
  }
}

/**
 * recordApproachNote(deps, task, note) → did THIS attempt leave a note?
 * Appends the approach layer when it did. The answer is about the NOTE, not about the
 * journal's disk: an unwritable journal must not fail a worker that did explain itself.
 * The note text is DATA — it is stored capped by the normalizer, and any later prompt that
 * shows it must fence it.
 */
function recordApproachNote(deps, task, note) {
  if (!note || !note.approach) return false
  writeJournal(deps, {
    taskId: task.id,
    attempt: task.attempt,
    layer: 'approach',
    payload: note,
  })
  return true
}

/** Detect a worker final-output marker among the collected stream lines (soft protocol). */
function detectMarker(lines) {
  for (const line of lines) {
    const m = typeof line === 'string' ? line.match(MARKER_RE) : null
    if (m) return m[1]
  }
  return null
}

/**
 * eligibleLanes(deps) — the lanes with at least one runnable worker RIGHT NOW, derived by
 * asking the routing policy (CONSUME-NEVER-REIMPLEMENT: the day-priority + window rules
 * live in routing.mjs, never re-encoded here). A lane is eligible when a lane-probe yields
 * a workerId or an explicit API fallback. Eligibility is derived BEFORE the claim on
 * purpose: the per-lane queues make a claimed task runnable by construction.
 */
function eligibleLanes(deps) {
  const { routing, config, windows, clock } = deps
  const out = []
  for (const lane of LANES) {
    const decision = routing.resolveRoute({ lane }, { workers: config.workers, windows, clock, config })
    if (decision && (decision.workerId || decision.useApiFallback)) out.push(lane)
  }
  return out
}

/**
 * runSpawn(spawnWorker, spec, onLine) — await a worker child to exit, collecting a spawn
 * failure as spawnError. Resolves {code, signal, spawnError}. The child is driven entirely
 * through the injected spawnWorker (spawn.mjs in production).
 *
 * BOTH SHAPES OF FAILURE, because they arrive by different roads. A refusal spawnWorker can
 * see for itself — a missing cwd — is thrown, and the catch below collects it. «The program
 * could not be started» is not a throw at all: Node emits it on the child, asynchronously,
 * after this function has already returned, so it arrives through onError. Only the first of
 * the two was ever collected, which is how a binary missing from the child's PATH took the
 * whole daemon down instead of failing one task.
 */
function runSpawn(spawnWorker, spec, onLine) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      spawnWorker({
        ...spec,
        onLine,
        onExit: ({ code, signal } = {}) => done({ code: code ?? null, signal: signal ?? null, spawnError: null }),
        onError: (err) => done({ code: null, signal: null, spawnError: err }),
      })
    } catch (err) {
      done({ code: null, signal: null, spawnError: err })
    }
  })
}

/**
 * bookAttemptUsage(deps, task, route, streamLines, now) — what this attempt cost, into the book.
 *
 * THE GAP THIS CLOSES, and it is the same shape as the executor's: both halves existed and
 * nothing joined them. `usage.mjs` has the parser for the CLI's own `result` event AND the
 * writer for the spend book, and the only caller was the chat door. So a task run by the tick
 * — a real session, real tokens, a transcript on disk — booked nothing at all, and the
 * «Расходы» screen answered ZERO to a question that had a real answer. A zero that is wrong is
 * worse than a blank: it reads as «this cost nothing».
 *
 * The row is read off the LAST `result` (or Codex `turn.completed`) line of the attempt's own
 * stream — the same lines the approach note and the failure marker are read from, so no second
 * source of truth about what happened.
 *
 * Never fatal. The price of an attempt is bookkeeping; an attempt that did its work must not be
 * failed because the book could not be written.
 */
function bookAttemptUsage(deps, task, route, streamLines, now) {
  if (typeof deps.bookUsage !== 'function') return
  try {
    const workers = Array.isArray(deps.config && deps.config.workers) ? deps.config.workers : []
    const worker = route && route.workerId ? workers.find((w) => w && w.id === route.workerId) : null
    const ctx = {
      accountName: (worker && worker.account && worker.account.name) || (route && route.workerId) || null,
      taskId: task.id,
      model: (route && route.model) || undefined,
    }
    const isCodex = String((route && route.provider) || '') === 'codex'
    for (let i = streamLines.length - 1; i >= 0; i -= 1) {
      const line = streamLines[i]
      if (isCodex) {
        const event = parseCodexEvent(line)
        if (!event || event.type !== 'turn.completed') continue
        deps.bookUsage(codexUsageFromFinal(event, { ...ctx, endedAt: now }))
        return
      }
      const event = parseClaudeEvent(line)
      if (!event || event.type !== 'result') continue
      deps.bookUsage(claudeUsageFromResult(event, ctx))
      return
    }
  } catch {
    /* the price of an attempt never fails the attempt */
  }
}

/** Coerce an enqueuedAt (number ms or ISO string) to epoch ms, or NaN. */
function toEpochMs(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : NaN
}

/** Fresh-derive the aging signal every tick — nothing stored. */
async function deriveAging(deps, now) {
  const { adapter, config, report, journal } = deps
  const agingMs = (config.agingHours ?? 24) * HOUR_MS
  let queued = []
  try {
    queued = await adapter.list({ status: 'queued' })
  } catch {
    return // a list failure never wedges the tick (fail-open)
  }
  for (const row of queued) {
    const enq = toEpochMs(row.enqueuedAt)
    if (!Number.isFinite(enq)) continue
    const ageMs = now - enq
    if (ageMs < agingMs) continue
    const queuedForHours = Math.floor(ageMs / HOUR_MS)
    if (typeof journal === 'function') journal({ type: 'task.aging', taskId: row.id, queuedForHours })
    if (typeof report === 'function') {
      // fire-and-forget; consumers dedup by taskId (the same signal reaches the read model)
      await report({ event: 'task.aging', taskId: row.id, title: row.title, lane: row.lane, queuedForHours })
    }
  }
}

/** Intake per cadence — enqueue NEW ready backlog items; last-scan is threaded THROUGH the
 *  tick (deps.intake.lastScanAt in, result.intake.scannedAt out) so the tick stays stateless. */
async function runIntake(deps, now, result) {
  const { adapter, config, journal } = deps
  const intake = deps.intake
  if (!intake || typeof intake.scan !== 'function') return
  const dueMs = (config.backlogScanMinutes ?? 60) * 60000
  const last = Number.isFinite(intake.lastScanAt) ? intake.lastScanAt : 0
  if (now - last < dueMs) return
  try {
    const scan = await intake.scan()
    let enqueued = 0
    for (const task of (scan && scan.items) || []) {
      try {
        await adapter.enqueue(task)
        enqueued += 1
      } catch (err) {
        // a NotReady / invalid item is journaled, never fatal (fail-open intake)
        if (typeof journal === 'function') journal({ type: 'intake-skip', taskId: task && task.id, error: String((err && err.message) || err) })
      }
    }
    result.intake = { scannedAt: now, enqueued, notReady: (scan && scan.notReady) || [] }
  } catch (err) {
    if (typeof journal === 'function') journal({ type: 'intake-error', error: String((err && err.message) || err) })
  }
}

/**
 * tick(deps) — ONE stateless pass. deps: {adapter, ledger, config, routing, windows,
 * buildArgs, spawnWorker, verbRunner, report, clock, journal, intake?, workerReady?}.
 * Returns a summary {idle, sweep?, claimed?, completed?, failed?, intake?}.
 */
export async function tick(deps = {}) {
  const { adapter, ledger, config, verbRunner, spawnWorker, buildArgs, report, journal } = deps
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const now = () => clock()
  const result = { idle: false }

  // (0) IS THE CONVEYOR SWITCHED ON? Asked FIRST, before the sweep and before the intake,
  // because «off» here means the machine does nothing at all — not «claims nothing». The
  // intake would otherwise keep pulling backlog items into the queue and the sweep would keep
  // writing to durable state, both on behalf of a founder who said stop; and the ONE meaning
  // that is easy to reason about at three in the morning is «off = nothing moves».
  //
  // What is stranded by a mid-flight stop is not lost: the sweep runs on the first tick after
  // the switch goes back on and requeues whatever lost its live path, which is the job it
  // already had. The default is OFF and lives in exactly one place — pipelineEnabled().
  if (!pipelineEnabled(config)) return { idle: true, paused: true }

  try {
    // (1) liveness sweep — audit durable state; requeue any task that lost its live path.
    try {
      // The SAME resolved value the durable queue's lease was built with (adapter.mjs):
      // the sweep and the lease are two answers to one question and may not disagree.
      result.sweep = await livenessSweep({ adapter, ledger, clock, expireMs: resolveExpireMs(config) })
    } catch (err) {
      if (typeof journal === 'function') journal({ type: 'sweep-error', error: String((err && err.message) || err) })
    }

    // (1b) reconcile the ledger against the queue's own retry count. AFTER
    // the sweep on purpose: the sweep writes the rows it can observe, and this pass then
    // appends only the attempts NOBODY observed — the ones the queue's own lease expiry
    // retried while this daemon was down. Fail-open exactly like the sweep.
    try {
      result.reconciled = await reconcileAttempts({ adapter, ledger, clock })
    } catch (err) {
      if (typeof journal === 'function') journal({ type: 'reconcile-error', error: String((err && err.message) || err) })
    }

    // (2) intake per cadence (secondary path; roster button is primary — Q2).
    await runIntake(deps, now(), result)

    // (2b) aging signal — derived fresh, nothing stored (runs whether or not we claim).
    await deriveAging(deps, now())

    // (3) claim — eligible lanes FIRST, then a lane-restricted claim.
    const lanes = eligibleLanes(deps)
    if (lanes.length === 0) {
      result.idle = true
      return result
    }
    const workerId = 'daemon' // the claim is against durable state; identity is the ledger's job
    const task = await adapter.claimNext(workerId, { lanes })
    if (!task) {
      result.idle = true // skipTimerWhenNoActionableWork
      return result
    }
    result.claimed = task.id

    // (3a0) THE LANE'S CAPABILITY ENVELOPE. Resolved here because it is a
    // property of the LANE the task was claimed into — known before the route is, and
    // therefore available to stamp on EVERY attempt row this tick can write, including the
    // rows of attempts that never reach a spawn.
    const envelope = defaultEnvelope(task.lane)
    // The fine state the task is actually in. It becomes RUNNING at the spawn, and every
    // transition minted below names the state the task was really in rather than the one
    // the happy path would have had it in.
    let fleetState = 'CLAIMED'

    // From here a per-task failure is honest, never a wedge (fail-open).
    try {
      // The router writes its OWN dispatcher layer at the decision — the tick
      // only hands it the sink; it never narrates the routing reason on the router's behalf.
      const route = deps.routing.resolveRoute(task, {
        workers: config.workers,
        windows: deps.windows,
        clock,
        config,
        decisionJournal: deps.decisionJournal,
      })
      if (!route || (!route.workerId && !route.useApiFallback)) {
        // Claimed but no runnable target after the real route (rare race) — degrade honestly.
        await failTask(deps, task, { reason: 'window_exhausted', now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: 'window_exhausted' }
        return result
      }

      // (3a) CAN THIS ATTEMPT START AT ALL? A routed worker whose account was never set up
      // on this machine (the shipped pool is placeholders) can never reach a spawn. Asking
      // BEFORE the attempt turns three silently burnt retries into one named refusal that
      // the card carries: «нужен человек: не хватает доступа» (readiness.mjs). DI-guarded —
      // a caller that injects no `workerReady` keeps the previous behaviour exactly.
      const blocker = attemptBlocker(deps, task, route)
      if (blocker) {
        writeLog(deps, { type: 'task.refused', taskId: task.id, workerId: route.workerId, reason: blocker.reason, detail: blocker.detail })
        await failTask(deps, task, { reason: blocker.reason, route, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: blocker.reason, detail: blocker.detail }
        return result
      }

      // (3b) FORGE LANE — a described-in-words draft. Same claim/route/worktree/
      // spawn as code work, but preflight is SKIPPED (nothing to already-build) and the exit
      // gate is a DETERMINISTIC draft lint, not reverify (a draft is a definition file). The
      // «Создатель» never activates anything — it commits a draft on the branch, full stop.
      if (task.lane === 'forge') {
        return await runForgeTask(deps, task, route, result, now, envelope)
      }

      // IS THIS WORK MADE OF CODE OR OF PROSE? The answer decides two
      // things below — where the worker stands, and which exit gate it must pass. It rides
      // on the task rather than in a fifth lane because routing treats the two identically.
      const isDocument = stageDataOf(task).kind === DOCUMENT_KIND

      // (4) preflight — verify-before-execute. 'built' → complete on the preflight receipt.
      // SKIPPED for a documentary stage: preflight answers «does this backlog item's work
      // already exist in the tree», and a stage of the phase cycle is not a backlog item —
      // asking would be a verb inventing an answer about something it was never given.
      const pf = isDocument ? {} : await invokeVerb(verbRunner, 'preflight', [task.id], config.repoDir)
      if (pf.verdict === 'built') {
        const receiptRef = pf.receiptRef || `preflight:${task.id}`
        // NO transition is minted for this completion, on purpose. The work already existed;
        // no worker process was ever started, so the task never entered RUNNING and there is
        // no CLAIMED -> PRODUCED contract to name. Minting the two-step CLAIMED -> RUNNING ->
        // PRODUCED would assert `worker_process_started`, an external effect that did not
        // happen — the exact fabrication the stamp exists to prevent.
        await completeTask(deps, task, { receiptRef, branch: null, diffStat: pf.diffStat, route, now: now(), envelope })
        result.completed = task.id
        return result
      }

      // (4b) the work does not already exist, so from here an EXECUTOR is required. Say so
      // now — before a worktree is provisioned — instead of dying on the way to the spawn.
      const noExecutor = executorBlocker(deps)
      if (noExecutor) {
        writeLog(deps, { type: 'task.refused', taskId: task.id, reason: noExecutor.reason, detail: noExecutor.detail })
        await failTask(deps, task, { reason: noExecutor.reason, route, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: noExecutor.reason, detail: noExecutor.detail }
        return result
      }

      // (4c) MAY THIS LANE START A PROCESS AT ALL? The envelope is
      // consulted here — after the preflight door, which completes without any worker, and
      // before the worktree, which is the first thing provisioned FOR one. Fail-closed: a
      // lane whose envelope grants no execution surface is refused by name, on the record.
      const noPermit = envelopeBlocker(envelope)
      if (noPermit) {
        writeLog(deps, { type: 'task.refused', taskId: task.id, lane: task.lane, reason: noPermit.reason, detail: noPermit.detail })
        await failTask(deps, task, { reason: noPermit.reason, route, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: noPermit.reason, detail: noPermit.detail }
        return result
      }

      // (5) WHERE THE WORKER STANDS. Code work gets a per-task worktree on its own
      // branch (`wt/<taskId>`, EXPECTED_BASE guard on) so two tasks can never edit one tree.
      // A DOCUMENTARY stage stands in the project checkout itself — its whole product is the
      // phase directory, the next stage reads it there, and a worktree would put every
      // document one merge away from the person who asked for it. The isolation a worktree
      // buys is worth its price for parallel code and is a pure cost for a document.
      let branch = null
      // A DOCUMENTARY stage stands in the project the window is showing, not in the tree this
      // daemon serves. The two are the same directory on a single-project install and are NOT
      // the same when the product is served from beside the workshop the phases live in — and
      // then a card reading one root while the stage writes into the other shows work as never
      // started while it is being completed. The front's phaseCycleDir is the same expression,
      // supplied by the same composition root, so the pair cannot drift.
      let workDir = (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir
      if (!isDocument) {
        branch = `wt/${task.id}`
        // `--json` is not decoration. Without it the verb prints prose for a person —
        // «SMA worktree: создано -> …» — and parseVerbResult, which looks for the last line
        // that is a JSON object, finds nothing at all. Asked properly, the verb answers
        // {ok, path, branch, reused}: `path` is the directory it actually made, and it is not
        // the directory this code used to guess.
        const wt = await invokeVerb(verbRunner, 'worktree', ['provision', '--branch', branch, '--json'], config.repoDir)
        // A GUESS IS WORSE THAN A REFUSAL, and this is the line that proved it: the old
        // fallback pointed at a sibling of repoDir that no verb has ever created, so a task
        // whose worktree was sitting on disk under a different name died on a missing cwd and
        // reported «среда исполнения недоступна» — a true sentence about an invented place.
        if (!wt || wt.ok === false || typeof wt.path !== 'string' || wt.path.trim() === '') {
          throw new Error(
            `worktree provision answered no path for ${branch}` +
              `${wt && wt.error ? ` (${wt.error})` : ''} — refusing to spawn a session into a directory nobody made`,
          )
        }
        workDir = wt.path
      }

      // (6) spawn the routed worker; log + touch (throttled) on every stream line.
      const spec = buildArgs(task, route, SPAWN_OPTIONS)
      // prepend the enabled agent's role/skills preamble (resolveWorkerContext) so
      // «включён» is real in the session. Optional + DI-guarded — skipped when not injected.
      if (typeof deps.resolveWorkerContext === 'function' && route && route.workerId) {
        const worker = (config.workers || []).find((w) => w && w.id === route.workerId)
        if (worker && (worker.roleFile || (Array.isArray(worker.skills) && worker.skills.length))) {
          const ctx = deps.resolveWorkerContext({ worker, repoDir: config.repoDir, fsImpl: deps.fsImpl })
          if (ctx && ctx.rolePreamble) spec.prompt = `${ctx.rolePreamble}\n\n${spec.prompt ?? ''}`
          // The MEMORY layer of the journal: which notes were loaded, which reflexes fired.
          // IDS ONLY — the loaded role BODY never travels into the journal; the
          // normalizer drops anything that does not read as an identifier.
          writeJournal(deps, {
            taskId: task.id,
            attempt: task.attempt,
            layer: 'memory',
            payload: {
              notes: worker.roleFile ? [worker.roleFile] : [],
              reflexes: (ctx && ctx.skillsList) || worker.skills || [],
            },
          })
        }
      }
      const streamLines = []
      const { onLine, sessionOf } = attemptStream(deps, task, streamLines, now, {
        accountName: spec.accountName,
        dataDir: config.dataDir,
      })
      // A worker process is about to exist: from this line the task is RUNNING, and every
      // transition minted afterwards says so — including the one the fail-open catch mints.
      fleetState = 'RUNNING'
      const exit = await runSpawn(spawnWorker, { bin: spec.bin, args: spec.args, cwd: workDir, env: spec.env, prompt: spec.prompt }, onLine)

      const marker = detectMarker(streamLines)

      // (7a) WHAT IT COST — read off this attempt's own stream, before any gate decides its
      // fate. A refused attempt still spent the tokens, so the book is written for every
      // attempt and not only for the ones that end well.
      bookAttemptUsage(deps, task, route, streamLines, now())

      // (7b) THE APPROACH NOTE — read off the same stream, appended as the journal's
      // approach layer, and then REQUIRED by the gate exactly as the receipt is required.
      // It is required of EVERY class of work: a parked round and a written document explain
      // themselves on the same terms a merged branch does.
      const note = parseApproachNote(streamLines)
      const noteWritten = recordApproachNote(deps, task, note)

      // An infra failure or a worker marker is the SHARPER signal and wins over either gate
      // below: a crashed attempt must not complete on a document that was already there.
      const infraReason = exit.spawnError || marker
        ? classifyFailure({ spawnError: exit.spawnError, exitCode: exit.code, workerMarker: marker })
        : null

      // (7a) A PARKED QUESTION IS A SUCCESSFUL ROUND — and it is asked BEFORE either gate.
      // A discussion round that stopped on a question, and an execute stage that reached a
      // blocking checkpoint, are the same event: the work went as far as it honestly could
      // and now owes a person a word. Failing it would throw away the position and start the
      // whole stage over on the next attempt; completing it on the checkpoint's own receipt
      // parks the row in `awaiting_approval`, where the screen renders it as a card.
      const parked = infraReason ? null : parkedRound(deps, task, workDir)

      if (parked || isDocument) {
        const gate = parked ?? (infraReason ? {} : documentGate(deps, task, workDir))
        const reason = infraReason ?? (gate.receiptRef ? (noteWritten ? null : 'no_journal') : gate.reason)
        if (reason) {
          if (gate.detail) writeLog(deps, { type: 'task.refused', taskId: task.id, reason, detail: gate.detail })
          await failTask(deps, task, { reason, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf() })
          result.failed = { taskId: task.id, reason, ...(gate.detail ? { detail: gate.detail } : {}) }
        } else {
          await completeTask(deps, task, { receiptRef: gate.receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf() })
          result.completed = task.id
        }
        return result
      }

      // (7c) AN ANSWER IS ALSO WORK — and it is asked BEFORE reverify, because an attempt
      // that touched nothing has nothing for reverify to certify: running it would spend a
      // verb to learn what git already said. Founder's ruling, in his words: «задача без
      // кода завершается ответом моим что принято к сведению, в аппрувале». Completing on
      // the answer receipt parks the row in `awaiting_approval`, where the screen renders
      // the worker's note as a card to acknowledge — instead of the red row this used to be.
      const answered = infraReason ? null : answerOnlyGate(deps, config, task, branch, workDir, noteWritten)
      if (answered) {
        // NEVER SILENT: an outcome that skipped the code gate says so in the operator's log,
        // so «the worker answered» can never be mistaken for «the worker's code passed».
        writeLog(deps, { type: 'task.answered', taskId: task.id, receiptRef: answered.receiptRef })
        await completeTask(deps, task, { receiptRef: answered.receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf() })
        result.completed = task.id
        return result
      }

      // (7) reverify GATE in the worktree — the ONLY door to completed for CODE work
      // (receipts or nothing). Unchanged: this is the original law, now one branch of two.
      const rv = exit.spawnError ? { code: 1 } : await invokeVerb(verbRunner, 'reverify', ['--branch', branch], workDir)
      let receipt = null
      if (rv.receiptRef) {
        receipt = { verdict: rv.verdict || (rv.code === 0 ? 'green' : 'red'), ref: rv.receiptRef }
      } else if (rv.verdict === 'red' || (Number.isFinite(rv.code) && rv.code !== 0)) {
        receipt = { verdict: 'red', ref: null }
      }

      if (!exit.spawnError && receipt && receipt.verdict === 'green' && receipt.ref && noteWritten) {
        await completeTask(deps, task, { receiptRef: receipt.ref, branch, diffStat: rv.diffStat, route, now: now(), envelope, from: fleetState, sessionId: sessionOf() })
        result.completed = task.id
      } else {
        const reason = classifyFailure({
          spawnError: exit.spawnError,
          exitCode: exit.code,
          receipt,
          workerMarker: marker,
          journalComplete: noteWritten,
        })
        await failTask(deps, task, { reason, receiptRef: receipt && receipt.ref, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf() })
        result.failed = { taskId: task.id, reason }
      }
      return result
    } catch (err) {
      // Per-task fail-open: a thrown error becomes an honest runtime_offline, never a wedge.
      if (typeof journal === 'function') journal({ type: 'task-error', taskId: task.id, error: String((err && err.message) || err) })
      try {
        await failTask(deps, task, { reason: 'runtime_offline', now: now(), envelope, from: fleetState })
      } catch {
        /* even the fail is fail-open — the next tick's liveness sweep will recover it */
      }
      result.failed = { taskId: task.id, reason: 'runtime_offline' }
      return result
    }
  } catch (err) {
    // Tick-level fail-open (merge-gate posture): journal + return an honest error marker.
    if (typeof journal === 'function') journal({ type: 'tick-error', error: String((err && err.message) || err) })
    result.error = true
    return result
  }
}

/**
 * listCommittedDrafts(execGit, branch, cwd, kind) → the draft files of `kind` committed on
 * the branch tip. The injected execGit runs with the shell disabled (spawn.mjs posture); a
 * missing execGit or a git error yields [] (the caller then fails 'agent_error' honestly).
 * The worker commits EXACTLY ONE draft — this is how the loop asserts it landed on the branch.
 */
function listCommittedDrafts(execGit, branch, cwd, kind) {
  if (typeof execGit !== 'function') return []
  const dir = draftDirFor(kind)
  if (!dir) return []
  let out = ''
  try {
    out = String(execGit(['show', '--name-only', '--pretty=format:', branch], { cwd }) || '')
  } catch {
    return []
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((p) => p.startsWith(dir))
}

/**
 * runForgeTask(deps, task, route, result, now) — the forge-lane branch. Reuses claim (already
 * done) / worktree / spawn / touch VERBATIM; SKIPS preflight; swaps the reverify exit gate for
 * `lintDraft`. Green + committed → complete on the FORGE receipt (receipts or nothing,
 * in the forge lane); red lint or an uncommitted draft → fail('agent_error') with the lint
 * detail on the attempt row. A return-with-note re-forges: the note flows into buildForgePrompt.
 *
 * THE ENVELOPE IS CONSULTED TWICE HERE: once before the spawn, exactly as
 * the code path does, and once over the committed draft's PATH before the draft is
 * accepted. The second one is the check with teeth — `listCommittedDrafts` filters by a
 * string prefix, and `envelopeAllows` answers on a SEGMENT boundary with traversal refused,
 * so `.claude/agents-elsewhere/x.md` passes the first and is refused by the second.
 */
async function runForgeTask(deps, task, route, result, now, envelope) {
  // `adapter` is NOT destructured here any more: its only use in this lane was the throttled
  // touch, which now lives inside the shared stream reader with the log it belongs next to.
  const { verbRunner, spawnWorker, buildArgs, config } = deps
  let fleetState = 'CLAIMED'

  // The forge lane has no preflight door, so the executor question is asked first thing.
  const noExecutor = executorBlocker(deps)
  if (noExecutor) {
    writeLog(deps, { type: 'task.refused', taskId: task.id, reason: noExecutor.reason, detail: noExecutor.detail })
    await failTask(deps, task, { reason: noExecutor.reason, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: noExecutor.reason, detail: noExecutor.detail }
    return result
  }

  // May this lane start a process at all? Same fail-closed gate the code path applies.
  const noPermit = envelopeBlocker(envelope)
  if (noPermit) {
    writeLog(deps, { type: 'task.refused', taskId: task.id, lane: task.lane, reason: noPermit.reason, detail: noPermit.detail })
    await failTask(deps, task, { reason: noPermit.reason, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: noPermit.reason, detail: noPermit.detail }
    return result
  }

  // (5) worktree provision — per-task branch `wt/<taskId>` (EXPECTED_BASE guard on).
  //
  // THE SAME TWO MISTAKES THE CODE PATH ABOVE ALREADY PAID FOR, made once more here and left
  // behind when that one was fixed. `--json` is not decoration: without it the verb prints
  // prose for a person and parseVerbResult, which looks for the last line that is a JSON
  // object, finds nothing — so `wt` was always empty. And the field it then read,
  // `worktreePath`, is not one the verb answers under any flag; the answer is `{ok, path,
  // branch, reused}`. Both together meant the fallback ALWAYS won: a sibling of repoDir that
  // no verb has ever created, into which the forge session was then spawned. Every forge task
  // died `runtime_offline` on a missing directory, and the suite could not see it because its
  // fake spawn ignores cwd.
  const branch = `wt/${task.id}`
  const wt = await invokeVerb(verbRunner, 'worktree', ['provision', '--branch', branch, '--json'], config.repoDir)
  if (!wt || wt.ok === false || typeof wt.path !== 'string' || wt.path.trim() === '') {
    await failTask(deps, task, { reason: 'runtime_offline', branch, route, now: now(), envelope, from: fleetState })
    result.failed = {
      taskId: task.id,
      reason: 'runtime_offline',
      detail: `worktree provision answered no path for ${branch}${wt && wt.error ? ` (${wt.error})` : ''}`,
    }
    return result
  }
  const worktreePath = wt.path

  // (6) spawn the «Создатель» with the FORGE prompt (not the code task prompt); touch on stream.
  const kind = task.forge && task.forge.kind
  const spec = buildArgs(task, route, SPAWN_OPTIONS)
  spec.prompt = buildForgePrompt({
    kind,
    description: task.forge && task.forge.description,
    note: task.note,
    repoDir: config.repoDir,
  })
  // The SAME stream reader the code/document path uses — a forge attempt is an attempt, it
  // gets a card, and a lane watched by nobody is exactly the lane that goes quiet at 3am.
  const streamLines = []
  const { onLine } = attemptStream(deps, task, streamLines, now, {
    accountName: spec.accountName,
    dataDir: config.dataDir,
  })
  fleetState = 'RUNNING'
  const exit = await runSpawn(spawnWorker, { bin: spec.bin, args: spec.args, cwd: worktreePath, env: spec.env, prompt: spec.prompt }, onLine)

  // The forge lane creates an attempt, so the forge lane owes a note like any other lane.
  const noteWritten = recordApproachNote(deps, task, parseApproachNote(streamLines))

  if (exit.spawnError) {
    await failTask(deps, task, { reason: 'runtime_offline', branch, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: 'runtime_offline' }
    return result
  }

  // (7) EXIT GATE = deterministic draft lint + committed-on-branch assertion (NOT reverify).
  const drafts = listCommittedDrafts(deps.execGit, branch, worktreePath, kind)
  if (drafts.length !== 1) {
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: 'agent_error', detail: 'draft not committed (expected exactly one)' }
    return result
  }
  const draftPath = drafts[0]

  // (7a) THE DRAFT'S PATH AGAINST THE LANE'S DECLARED WRITE SCOPE. The
  // draft is a file a spawned agent chose the name of, and this is the moment the daemon
  // decides to accept it. `envelopeAllows` refuses anything outside the forge lane's three
  // draft directories, refuses a traversal instead of resolving it, and matches on a
  // segment boundary rather than a prefix.
  if (!envelopeAllows(envelope, { action: 'write', path: draftPath })) {
    const detail = `draft path is outside the lane's declared write scope: ${draftPath}`
    writeLog(deps, { type: 'task.refused', taskId: task.id, lane: task.lane, reason: 'agent_error', detail })
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: 'agent_error', detail }
    return result
  }

  const lint = lintDraft({ kind, filePath: join(worktreePath, draftPath), fsImpl: deps.fsImpl })
  if (!lint.passed) {
    const failed = lint.checks.filter((c) => !c.ok).map((c) => c.name).join(',')
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: 'agent_error', detail: `lint failed: ${failed}` }
    return result
  }

  if (!noteWritten) {
    // Certified draft, unexplained attempt — the same gate, the same named failure.
    await failTask(deps, task, { reason: 'no_journal', branch, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: 'no_journal' }
    return result
  }

  const receiptRef = writeForgeReceipt({
    dataDir: config.dataDir,
    taskId: task.id,
    kind,
    filePath: draftPath,
    lint,
    sha256: lint.sha256,
    fsImpl: deps.fsImpl,
  })
  await completeTask(deps, task, { receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState })
  result.completed = task.id
  return result
}

/**
 * complete a task through the adapter gate + write a rich (receipt-bearing) attempt row.
 * `from` names the fine state the task was really in; omitting it (the preflight-«built»
 * door) writes the row with no transition fields rather than an invented pair.
 */
async function completeTask(deps, task, { receiptRef, branch, diffStat, route, now, envelope, from, sessionId }) {
  const { adapter, ledger, report } = deps
  await adapter.complete(task.id, {
    receiptRef,
    branch,
    diffStat,
    workerId: route && route.workerId,
    provider: route && route.provider,
  })
  if (ledger && typeof ledger.recordAttempt === 'function') {
    ledger.recordAttempt({
      taskId: task.id,
      attempt: task.attempt,
      provider: route && route.provider,
      outcome: 'completed',
      receiptRef,
      // The session this attempt ran in. `undefined` when the stream never named one (a
      // preflight door completes with no worker at all) — the allowlist loop then omits the
      // key entirely, so a row without a session says so by ABSENCE, never by an empty string.
      sessionId: sessionId ?? undefined,
      endedAt: new Date(now).toISOString(),
      ...attemptStamp(deps, task, { from, to: from ? 'PRODUCED' : undefined, actor: 'worker', envelope }),
    })
  }
  if (typeof report === 'function') {
    await report({ event: 'task.completed', taskId: task.id, title: task.title, lane: task.lane, receiptVerdict: 'green', branch, attempt: task.attempt })
  }
}

/**
 * fail a task through the adapter gate + write a rich (receipt-bearing) attempt row.
 * `from` is CLAIMED for an attempt refused before any worker started and RUNNING for one
 * that died after — both are legal edges into RETRYABLE, and the key names the real one.
 */
async function failTask(deps, task, { reason, receiptRef, branch, route, now, envelope, from, sessionId }) {
  const { adapter, ledger, report } = deps
  await adapter.fail(task.id, reason)
  if (ledger && typeof ledger.recordAttempt === 'function') {
    // THE «ПОЧЕМУ» IS THE POINT. A ledger that cannot be written must not take the reason
    // down with it: the row is attempted, and a refusing ledger says so out loud instead
    // of leaving the card blank (an unconfigured ledgerDir used to throw right here, and
    // the caller's fail-open catch turned the whole failure into a silence).
    try {
      ledger.recordAttempt({
        taskId: task.id,
        attempt: task.attempt,
        provider: route && route.provider,
        outcome: 'failed',
        failureReason: reason,
        receiptRef: receiptRef ?? undefined, // the red receipt ref is preserved on the row
        // A FAILED attempt keeps its session id too — that is the attempt a person is most
        // likely to want to open and look inside afterwards.
        sessionId: sessionId ?? undefined,
        endedAt: new Date(now).toISOString(),
        ...attemptStamp(deps, task, { from, to: from ? 'RETRYABLE' : undefined, actor: 'supervisor', envelope }),
      })
    } catch (err) {
      writeLog(deps, { type: 'ledger-error', taskId: task.id, reason, error: String((err && err.message) || err) })
    }
  }
  if (typeof report === 'function') {
    await report({ event: 'task.failed', taskId: task.id, title: task.title, lane: task.lane, receiptVerdict: receiptRef ? 'red' : undefined, branch, attempt: task.attempt })
  }
}

/**
 * runDaemon({tickMs, onTick}) — a thin setInterval wrapper. The ONLY state is the interval
 * handle (no task state lives in the process). start/stop are idempotent; a
 * thrown tick is swallowed so one bad tick never stops the schedule.
 *
 * @param {{tickMs?:number, onTick?:()=>any}} [opts]
 * @returns {{start:()=>boolean, stop:()=>boolean}}
 */
export function runDaemon({ tickMs = 5000, onTick } = {}) {
  let handle = null
  return {
    start() {
      if (handle) return true // idempotent — one interval only
      handle = setInterval(() => {
        try {
          Promise.resolve(typeof onTick === 'function' ? onTick() : undefined).catch(() => {})
        } catch {
          /* a synchronous tick throw never stops the schedule (fail-open) */
        }
      }, tickMs)
      if (handle && typeof handle.unref === 'function') handle.unref()
      return true
    },
    stop() {
      if (handle) {
        clearInterval(handle)
        handle = null
      }
      return true
    },
  }
}
