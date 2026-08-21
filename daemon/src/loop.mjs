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
 *   - preflight  — verify-before-execute mechanized: asked with the PATH of each plan of the
 *                  task's phase, for a machine answer, in the connected project's tree; every
 *                  plan built → complete on the preflight receipt and skip the spawn entirely
 *                  (the work already exists). Work that carries no phase is not asked at all,
 *                  and every answer — including «no» and «could not tell» — is logged.
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

import { createHash } from 'node:crypto'
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, mkdirSync as fsMkdirSync } from 'node:fs'
import { join } from 'node:path'

import { pipelineEnabled } from './config.mjs'
import { resolveExpireMs, batchWorkerOf, waveAddressOf, FAIL_REASONS } from './queue/adapter.mjs'
import { livenessSweep } from './queue/liveness.mjs'
import { reconcileAttempts } from './queue/reconcile.mjs'
// ATTEMPT_FILES_CAP is IMPORTED, never re-declared: the ceiling on the changed-file list
// belongs to the module that owns the row's key list, and a second copy of the number here
// would be a second ceiling waiting to drift away from the first.
import { memorySnapshotHash, ATTEMPT_FILES_CAP } from './queue/attempt-ledger.mjs'
import { defaultEnvelope, validateEnvelope, envelopeAllows, envelopeHash, envelopeSpawnOptions } from './queue/capability-envelope.mjs'
import { runsDirOf, attemptRunDir, writeRunStart, writeRunReceipt, pruneRunDirs, secretValuesOf, createToolPairing, RUN_DIRS_KEEP } from './queue/run-dir.mjs'
import { applyTransition } from './queue/state-machine.mjs'
// THE FIVE RECEIPTS, FROM THE ONE MODULE THAT DEFINES THEM. The daemon does not keep a second
// opinion about whether the hooks fired or the memory came back: it imports the same evaluation
// the checking command imports, so «what the card shows» and «what the command prints» cannot
// come apart. A private copy here would agree on the day it was written and drift every day after.
import { evaluateParity, summarize, ARTIFACTS as PARITY_ARTIFACTS } from '../../scripts/sma/lib/parity-receipts.mjs'
import { buildForgePrompt, lintDraft, writeForgeReceipt, draftDirFor } from './forge/forge.mjs'
import {
  parseApproachNote,
  approachLinesFrom,
  markerLinesFrom,
  parseLessonMarker,
  attemptIdFor,
} from './front/journal.mjs'
// THE CORPUS READS ITS OWN NOTES. The lesson gate below asks whether a file is a note the
// memory pipeline produced, and it asks with the parser the corpus itself uses — a second,
// looser reader here would be a second definition of «a note», and the day they disagreed the
// gate would be certifying files no corpus would ever accept.
import { parseNote } from '../../scripts/sma/lib/frontmatter.mjs'
import { PIPELINE_DRAFT_KIND } from '../../scripts/sma/lib/write-pipeline.mjs'
import { tokenHash } from '../../scripts/sma/lib/registry.mjs'
import { closeWaitingTickets } from '../../scripts/sma/lib/tool-gate.mjs'
import { parseClaudeEvent, parseClaudeFrame, parseCodexEvent } from './runner/stream.mjs'
import { summarizeFrame, wholeFrameKind } from './runner/frame-summary.mjs'
import { markWindowObserved, markWindowClosed, readingSaysExhausted } from './policy/windows.mjs'
import { claudeUsageFromResult, codexUsageFromFinal, estimateUsage } from './runner/usage.mjs'
import {
  readPendingRedirects,
  markConsumed,
  appendRedirect,
  redirectFileOf,
  correctionsPreamble,
  REDIRECT_HOP_CAP,
} from './runner/redirects.mjs'
import { readWaveHolds, readWaveParked, markWaveParked } from './queue/wave-holds.mjs'
import { CLAUDE_BIN } from './runner/build-args.mjs'
import { buildMcpConfigFile } from './runner/args.mjs'
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
    readFileSync: io.readFileSync ?? fsReadFileSync,
  }
}

/**
 * gateSpawnOptions(deps, config, task) → `{gate:{runDir, redirectsFile}}` for the spawn,
 * and the attempt directory CREATED before the process that will write into it exists.
 *
 * WHY IT IS CREATED HERE AND NOT AT THE END. The record of an attempt is written when the
 * attempt is over, and until this line that was the only moment this directory ever came into
 * being. But the parking gate runs INSIDE the attempt: it has to put a ticket somewhere the
 * moment a worker asks for something dangerous, which is long before anything is recorded. A
 * gate handed a path to a directory that does not exist yet writes nothing, refuses nothing,
 * and looks exactly like a gate that decided the call was harmless.
 *
 * AND THE PATH IS THE SAME PATH. Both this line and the record at the end ask
 * `attemptRunDir` — one expression, so the tickets and the record can never end up in two
 * directories with almost the same name.
 *
 * ONE FUNCTION FOR BOTH SPAWN POINTS, for the reason written beside the envelope's own
 * options: the last time the code lane and the «Создатель» lane each carried their own copy
 * of a spawn decision, one was updated and the other spawned crippled for weeks.
 *
 * Never fatal. A directory that cannot be made costs the TICKET, not the attempt — and the
 * gate that then finds no directory answers ALLOW, which is the same posture it takes in
 * somebody else's session.
 */
function gateSpawnOptions(deps, config, task) {
  const projectDir = (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir
  const runsDir = runsDirOf(projectDir)
  const runDir = attemptRunDir({ runsDir, attemptId: attemptIdFor(task.id, task.attempt) })
  const redirectsFile = redirectFileOf({ dataDir: deps.dataDir || config.dataDir, taskId: task.id })
  if (runDir) {
    try {
      const mkdir = (deps.fsImpl && deps.fsImpl.mkdirSync) || fsMkdirSync
      mkdir(runDir, { recursive: true })
    } catch (err) {
      writeLog(deps, { type: 'task.run_dir_precreate_failed', taskId: task.id, error: String((err && err.message) || err) })
      return {}
    }
  }
  return runDir || redirectsFile ? { gate: { runDir: runDir ?? undefined, redirectsFile: redirectsFile ?? undefined } } : {}
}

/** The `data` envelope a stage task carries, or an empty one for ordinary code work. */
function stageDataOf(task) {
  const data = task && task.data
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/**
 * findArtifacts(deps, cwd, phase, suffix) → EVERY checkout-relative path of a phase directory
 * whose name ends with `suffix`, in sorted order; an empty array when the tree, the phase
 * directory or the files are missing (the three are not distinguished — the caller gets one
 * honest «nothing found»). Sorted rather than mtime-ordered because every artifact this map
 * names carries its own sequence in the name (`12-03-PLAN.md`), which a modification time
 * does not.
 *
 * WHY THE PLURAL EXISTS. A phase produces MANY plans, and a reader that takes only the newest
 * one can answer «this phase is already built» after checking a fifth of it. For the gate that
 * SKIPS work that answer is unrecoverable and silent, so the door below asks about all of them.
 */
function findArtifacts(deps, cwd, phase, suffix) {
  const io = resolveIo(deps.fsImpl)
  const root = join(cwd ?? '.', PHASES_PATH)
  if (!io.existsSync(root)) return []
  let dirs
  try {
    dirs = io.readdirSync(root)
  } catch {
    return []
  }
  const dir = findPhaseDir(dirs, phase)
  if (!dir) return []
  let names
  try {
    names = io.readdirSync(join(root, dir))
  } catch {
    return []
  }
  return names
    .map(String)
    .sort()
    .filter((name) => name.endsWith(suffix))
    .map((name) => `${PHASES_PATH}/${dir}/${name}`)
}

/**
 * findArtifact(deps, cwd, phase, suffix) → the checkout-relative path of the newest file of a
 * phase directory whose name ends with `suffix`, or null. «Newest» is the LAST name in sorted
 * order. One traversal, stated once above: the singular is the plural's last entry, so the
 * documentary gate and the already-built door can never disagree about where phases live.
 */
function findArtifact(deps, cwd, phase, suffix) {
  const found = findArtifacts(deps, cwd, phase, suffix)
  return found.length ? found[found.length - 1] : null
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
 * answerOnlyGate(deps, task, branch, workDir, noteWritten, base) → {receiptRef} when this
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
 *   1. ZERO COMMITS on the task branch beyond the base the worktree was cut from — the same
 *      anchor `worktree provision` captured as EXPECTED_BASE, handed in by the caller that
 *      already wrote it into the attempt's own journal line. Not the tip of anything else:
 *      see below for what asking anything else cost.
 *   2. A CLEAN worktree. Files edited and left uncommitted are unfinished code work, not an
 *      answer; that attempt keeps failing exactly as it does today.
 *
 * Both questions fail SAFE: no git surface, no base, a throw, a count that is not a plain
 * zero, or a single dirty line, and the answer is null — the attempt falls through to the code
 * gate and the old outcome stands. The only way through this door is a repository that cannot
 * tell the attempt ever happened. A refusal for want of a base is SAID OUT LOUD in the
 * operator's log, because a door that closes without a word is how the miss below spent hours
 * looking like a worker who left no receipt.
 *
 * THE NOTE IS REQUIRED, exactly as everywhere else. An answer nobody wrote down is not an
 * answer, and the note IS the artefact here — the receipt names the attempt whose journal
 * holds it, so what the founder acknowledges on the card is the worker's own words.
 */
function answerOnlyGate(deps, task, branch, workDir, noteWritten, base) {
  if (!noteWritten) return null
  if (typeof deps.execGit !== 'function') return null

  // WHERE THE COUNT STARTS, and this line is the whole defect this gate once carried. The
  // question is «did this attempt put anything on the branch», and ONLY the point the copy was
  // cut from can answer it. The count used to be taken against the tip of whatever project was
  // connected instead — «commits this branch has that HEAD over there does not». On 19.08.2026
  // the copy had been cut from one branch while the project stood on another, TEN commits
  // apart: an attempt that touched nothing was told it had produced ten, the door shut, and a
  // finished answer went out as «нет квитанции» and was re-run for nothing. On the next run the
  // two points coincided and it «did not reproduce» — a hint about the cause, not a repair.
  // The header above always named the right anchor; it was the code that disagreed with it.
  //
  // THE OLDER LESSON IS KEPT, because it cost a live run too. Before that the count ran in the
  // daemon's LAUNCH directory, where `wt/<taskId>` is not a revision at all on an install that
  // serves one repository while the founder works in another: git exited non-zero, the fail-
  // safe answered null, and again a codeless task went red. Asking the COPY's own tree ends
  // both stories at once — the branch is checked out there, and the work happened there.
  if (!base) {
    // NEVER SILENT. This is the refusal that looked like an absent receipt for hours, so it now
    // says which of the two things happened: nobody could name the point to count from.
    writeLog(deps, {
      type: 'task.answer_gate_closed',
      taskId: task.id,
      reason: 'unknown_base',
      detail:
        `база копии неизвестна — считать не от чего, дверь ответа закрыта, попытку решает гейт кода ` +
        `(ветка=${branch || 'нет'} дерево=${workDir || 'нет'})`,
    })
    return null
  }
  // The counter that already exists in this file, told to answer «I cannot say» rather than
  // «zero» — for THIS door an unknown must never read as «the attempt is provably empty».
  if (countCommitsOnBranch(deps, base, workDir, { unknownAs: null }) !== 0) return null

  let dirty
  try {
    dirty = String(deps.execGit(['status', '--porcelain'], { cwd: workDir }) || '').trim()
  } catch {
    return null
  }
  if (dirty) return null

  return { receiptRef: answerReceipt(attemptIdFor(task.id, task.attempt)) }
}

/** Where a lesson is allowed to live inside the copy — the project's own memory corpus. */
const LESSON_CORPUS_PREFIX = '.claude/memory/'

/**
 * lessonCheck(deps, task, workDir, lesson) → {ok, written?, none?, reason?}
 *
 * THE THIRD CONDITION OF A FINISHED ATTEMPT, checked against the DISK and not against the
 * worker's word. The product promised a flywheel of memory turning in both directions while
 * the corpus took in nothing from any worker for dozens of attempts — because nobody asked,
 * and nothing checked.
 *
 * Two honest answers, and no third:
 *   - a LESSON: the path of the draft `memory write` staged in this copy. It must sit under
 *     the corpus, carry no `..`, exist on disk, parse as a schema-2 note and carry the
 *     pipeline's own stamp (`draft_kind: pipeline-write`, imported from the pipeline that
 *     mints it rather than re-typed here). That stamp is the whole point: a flat file dropped
 *     beside the corpus is exactly what «ни один факт не входит в память случайно» forbids, and a gate
 *     that accepted one would be certifying a bypass of the pipeline it exists to protect.
 *   - NO LESSON, with the reason said out loud. A machine cannot judge whether this task had
 *     anything to teach, and it does not try; it only refuses silence.
 *
 * FAIL-CLOSED but never throwing: an unreadable file, an unparseable note or a path outside
 * the corpus all answer «not ok» with words a person can act on. The reason travels back so
 * the transcript can say WHY, instead of leaving a red row that only the code explains.
 */
function lessonCheck(deps, task, workDir, lesson) {
  if (!lesson) return { ok: false, reason: 'ни заметки, ни причины' }

  if (lesson.none) {
    const reason = String(lesson.none).trim()
    // «Нет» без причины — не ответ: это слово, которым можно пройти гейт, и оно превратило бы
    // всё условие в формальность. Парсер уже отбрасывает пустое; здесь — вторая дверь.
    return reason ? { ok: true, none: reason } : { ok: false, reason: 'сказано «урока нет» без причины' }
  }

  const path = String(lesson.written ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path.startsWith(LESSON_CORPUS_PREFIX) || path.split('/').includes('..')) {
    return { ok: false, reason: `путь урока вне корпуса памяти копии: ${path || '(пусто)'}` }
  }
  if (!workDir) return { ok: false, reason: 'копия попытки неизвестна — урок проверить негде' }

  const io = resolveIo(deps.fsImpl)
  const file = join(workDir, path)
  if (!io.existsSync(file)) return { ok: false, reason: `файла урока нет в копии: ${path}` }

  let parsed
  try {
    parsed = parseNote(String(io.readFileSync(file, 'utf8')), { file: path })
  } catch (err) {
    return { ok: false, reason: `заметка урока не читается: ${String((err && err.message) || err)}` }
  }
  const fm = parsed && parsed.frontmatter
  if (!fm || parsed.schemaVersion !== 2) return { ok: false, reason: `заметка урока не в схеме корпуса: ${path}` }
  if (fm.draft_kind !== PIPELINE_DRAFT_KIND) {
    return { ok: false, reason: `заметка положена мимо конвейера памяти: ${path}` }
  }
  return { ok: true, written: path }
}

/** Worker final-output markers — a SOFT protocol the worker MAY emit. */
const MARKER_RE = /^\s*(NEEDS_DECISION|MISSING_ACCESS)\s*:/

/**
 * providerAbortOf(lines) → `{status, reason, said}` when the PROVIDER ended this run, else null.
 *
 * WHY IT IS READ AT ALL. A live attempt was killed by a 529 «Overloaded» on the vendor's side
 * and reached the window as «нет записки о подходе — попытка не объяснена». The note could not
 * exist: the worker was cut off in the middle of writing it. The window named a symptom and
 * blamed the worker for an outage he had no part in — and the two facts ask a person for
 * opposite things, «подождите и нажмите ещё раз» against «идите и чините».
 *
 * WHAT COUNTS AS THE PROVIDER'S WORD, and this boundary is the whole design: ONLY the CLI's
 * own TERMINAL frame — a `result` naming `terminal_reason: 'api_error'` or carrying an
 * `api_error_status`. NOT the worker's speech. A worker debugging somebody else's outage says
 * «API Error: 529 Overloaded» out loud, and an attempt declared broken for pronouncing those
 * words would be a diagnosis by eavesdropping — worse than the fault it replaces. Text
 * matching over the stream is deliberately absent for that reason.
 *
 * @param {string[]} lines — the attempt's stdout, as collected
 * @returns {{status:number|null, reason:string|null, said:string|null}|null}
 */
export function providerAbortOf(lines) {
  if (!Array.isArray(lines)) return null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (typeof line !== 'string' || !line.includes('result')) continue
    const { event, frame } = parseClaudeFrame(line)
    if (!event || event.type !== 'result') continue
    const status = Number.isFinite(event.apiErrorStatus) ? event.apiErrorStatus : null
    if (event.terminalReason !== 'api_error' && status === null) continue
    const said = frame && typeof frame.result === 'string' ? frame.result.slice(0, 200) : null
    return { status, reason: event.terminalReason ?? 'api_error', said }
  }
  return null
}

/**
 * classifyFailure({spawnError, providerAbort, exitCode, receipt, workerMarker}) → a
 * FAIL_REASONS code. Pure. Maps a non-completing outcome onto the failure taxonomy, sharpest
 * signal first:
 *   spawnError                     → 'runtime_offline'  (the process never ran)
 *   provider abort                 → 'provider_error'   (the run the worker did not end)
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
 * A PROVIDER ABORT SITS SECOND, above every judgement of what the run left behind, and that
 * position is the point: when the vendor ended the run mid-word, a missing note, a missing
 * receipt and a red re-run are all CONSEQUENCES of the cut. There is nothing to judge, so
 * nothing is judged. Only a run that never started outranks it — there was nothing to cut.
 *
 * @param {{spawnError?:any, providerAbort?:object|null, exitCode?:number|null, receipt?:{verdict?:string,ref?:any}|null, workerMarker?:string|null, journalComplete?:boolean}} [o]
 * @returns {string}
 */
export function classifyFailure({ spawnError, providerAbort, exitCode, receipt, workerMarker, journalComplete, lessonComplete } = {}) {
  if (spawnError) return 'runtime_offline'
  if (providerAbort) return 'provider_error'
  if (workerMarker === 'NEEDS_DECISION') return 'needs_decision'
  if (workerMarker === 'MISSING_ACCESS') return 'missing_access'
  if (receipt && receipt.verdict === 'red') return 'tests_red'
  if (!receipt) {
    return Number.isFinite(exitCode) && exitCode !== 0 ? 'agent_error' : 'no_receipt'
  }
  if (receipt.verdict === 'green' && journalComplete === false) return 'no_journal'
  // THE OLDER OMISSION IS THE SHARPER ONE. An attempt that left neither note nor lesson reads
  // 'no_journal': the note explains the work a person is about to accept, and the lesson is
  // for the attempt after this one. Naming the smaller gap first would send a person looking
  // for the wrong thing.
  if (receipt.verdict === 'green' && lessonComplete === false) return 'no_lesson'
  return 'agent_error'
}

/**
 * countCommitsOnBranch(deps, base, cwd, {unknownAs}) → how many commits the attempt put on top
 * of the base the worktree was cut from, or `unknownAs` when that cannot be established at all.
 * The measurable answer to «did anything actually happen», used by every door that has to
 * decide without a receipt of the repository's own.
 *
 * FAIL-CLOSED BY DEFAULT, deliberately: no base, no git seam, an unparseable count or a throw
 * all answer 0. This number is the only thing standing between «finished work with no proof»
 * and «nothing happened», so an unknown must read as nothing rather than as something.
 *
 * WHY THE UNKNOWN IS A PARAMETER AND NOT A CONSTANT. Two doors read this count and they fail in
 * OPPOSITE directions, so one hard-wired answer would have to be unsafe for one of them. The
 * receiptless door asks «is there work here to send to a person» — an unknown must read as 0,
 * or an attempt that produced nothing gets carried through as work. The ANSWER door asks the
 * mirror question, «is this attempt PROVABLY empty» — there a git that could not answer must
 * never be heard as «yes, empty», because that is the door to completed. Each caller states
 * its own reading, and neither has to keep a second counter of its own.
 */
function countCommitsOnBranch(deps, base, cwd, { unknownAs = 0 } = {}) {
  if (!base || typeof deps.execGit !== 'function' || !cwd) return unknownAs
  try {
    const out = String(deps.execGit(['rev-list', '--count', `${base}..HEAD`], { cwd }) || '').trim()
    const n = Number.parseInt(out, 10)
    if (!Number.isFinite(n)) return unknownAs
    return n > 0 ? n : 0
  } catch {
    return unknownAs
  }
}

/**
 * redRecordKeys(rv) → the identities of the reverify records that are NOT green, as a sorted
 * array of unique strings — or null when the verb's answer carried no record list at all
 * (nothing to compare with, which is a different sentence from «nothing is red»).
 *
 * WHY AN IDENTITY AND NOT A COUNT. Two pictures with the same NUMBER of divergences can be
 * two different sets: one recipe healed while another broke is «the worker broke something»,
 * and a count would read it as «nothing changed». The identity is the pair (summary, id) —
 * the two fields the verb itself uses to name a receipt, so a recipe that moves between
 * summaries is a different record here exactly as it is a different record there.
 *
 * WHAT COUNTS AS RED is the verb's own definition and not a second one: it exits non-zero on
 * `divergent` and `error`, and a receipt it declined to run (`skipped-unsafe`) is neither
 * green nor a failure — it is a receipt nobody measured, and it must not travel into a
 * verdict about someone's work.
 *
 * A PLAIN ARRAY, on purpose: this file may hold no keyed collection (the tick is stateless and
 * a grep gate keeps it that way). The lists are one entry per receipt in the tree — tens, not
 * millions — so the linear membership test below costs nothing worth a discipline.
 */
export function redRecordKeys(rv) {
  if (!rv || !Array.isArray(rv.records)) return null
  const out = []
  for (const r of rv.records) {
    if (!r || typeof r !== 'object') continue
    const verdict = String(r.verdict ?? '')
    if (verdict !== 'divergent' && verdict !== 'error') continue
    const key = `${r.summary ?? ''}::${r.id ?? ''}`
    if (!out.includes(key)) out.push(key)
  }
  return out.sort()
}

/** The byte git separates the records of a `-z` answer with. Never written as a literal in
 *  source: a NUL in a text file is a file half the tooling around it stops being able to read. */
const NUL = String.fromCharCode(0)

/** An answer with no name where a name must be — the shape of a read that was cut short. */
const NO_ANSWER = (reason) => ({
  files: [],
  deletions: [],
  filesOverflow: 0,
  deletionsOverflow: 0,
  answered: false,
  reason,
})

/**
 * parseNameStatus(out) → {entries, vanished} — the records of a `--name-status` answer, in
 * the shape git ACTUALLY produces. The form below was measured byte by byte on a real
 * repository before a line of this was written, because a parser built to a remembered format
 * is green against a fake and wrong against git.
 *
 * WHAT WAS MEASURED (git 2.53, `-z`): status and name are TWO separate NUL-terminated
 * records — `A\0added.txt\0` — and a rename is THREE: `R100\0oldname.txt\0newname.txt\0`.
 * Rename detection is on by DEFAULT, so the three-record form is not a rare case to handle
 * later; copy detection is off by default but is one line of config in the CONNECTED
 * project, and its record shape is the same three. So `R` and `C` are read by one branch —
 * miss that and one extra record shifts everything after it, and a file NAME is read as a
 * status.
 *
 * ANYTHING UNKNOWN IS KEPT AS IT CAME. A status letter this parser has never seen (`T`, `U`,
 * a future one) is stored verbatim with its name: a record we do not understand is still
 * evidence, and dropping it would make the row quietly incomplete.
 *
 * A TRUNCATED ANSWER STOPS THE PARSE AND THROWS NOTHING — a record with no name is what a
 * cut-off read looks like, and losing the rest of a list is not a reason to lose the attempt.
 */
function parseNameStatus(out) {
  const entries = []
  const vanished = []
  const push = (status, path, from) => {
    entries.push(from === undefined ? { status, path } : { status, path, from })
    // WHAT IS GONE, collected as we go. `D` is the plain case; the OLD side of a rename is
    // the subtle one — from where a person stands that path no longer exists, and a rollback
    // reader who is not told so goes looking for a file that is not there. A copy takes
    // nothing away, so `C` adds nothing here.
    if (status[0] === 'D') vanished.push(path)
    else if (status[0] === 'R' && from !== undefined) vanished.push(from)
  }

  // THE PRIMARY PATH: records separated by the NUL byte. Never newlines and never whitespace —
  // a path may legally contain a space, a quote and (on systems that allow it) a newline, and
  // every one of those splits a line-based parser into pieces that look like real filenames.
  if (out.includes(NUL)) {
    const parts = out.split(NUL)
    let i = 0
    while (i < parts.length) {
      const status = parts[i]
      if (!status) {
        i += 1 // the trailing empty record after the final NUL
        continue
      }
      if (status[0] === 'R' || status[0] === 'C') {
        const from = parts[i + 1]
        const to = parts[i + 2]
        if (!from || !to) break // truncated: stop reading, keep what was read
        push(status, to, from)
        i += 3
      } else {
        const path = parts[i + 1]
        if (!path) break // truncated
        push(status, path)
        i += 2
      }
    }
    return { entries, vanished }
  }

  // THE FALLBACK: an answer with no NUL in it at all. Some builds and some wrappers hand back
  // a newline-separated body despite the flag, and this is the ONLY reason `core.quotepath` is
  // switched off in the call as well — down here the names arrive raw and stay readable, where
  // git's default would have handed a person `\321\200\321\203…` instead of a filename.
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    const status = cols[0].trim()
    if (!status || cols.length < 2) continue
    if ((status[0] === 'R' || status[0] === 'C') && cols.length >= 3) push(status, cols[2], cols[1])
    else push(status, cols[1])
  }
  return { entries, vanished }
}

/**
 * changedFilesOnBranch(deps, base, branch, cwd) → what the attempt's branch changed against
 * the commit it was cut from: `files` (status + name per entry, plus the previous name of a
 * rename), `deletions` (the paths that are GONE), the two overflow counters, `answered`, and
 * a reason in words when there is nothing to show.
 *
 * «Откатить можно» и «видно, ЧТО откатывается» — разные вещи, and only the first was true:
 * the attempt row carried the base commit, so a person knew the point to return to and
 * nothing about what would come back. The list is derived here and carried on EVERY outcome,
 * because the attempt someone wants to undo is precisely the one that went wrong.
 *
 * THE SOURCE IS GIT, DELIBERATELY. Not a watch on which tools the worker used: a change made
 * with `rm`, with a stream editor or with `git rm` went through a shell, and a list built
 * from the names of editing tools cannot contain it — no editing tool was called. Git
 * compares two trees, so it answers correctly however the change was made.
 *
 * NAMES ONLY. No patch flag is ever passed: the row is durable and a diff body can carry a
 * secret. A ceiling — ONE constant, owned by the module that owns the row's key list — bounds
 * both lists, and what it cut is counted out loud rather than dropped in silence.
 *
 * FAIL-OPEN, exactly like the commit count beside it: no git seam, no base, no copy, or a git
 * that refuses all answer `answered:false` with the reason in words. An honest blank is a
 * record; a thrown error in a narration path would cost the attempt its outcome.
 */
export function changedFilesOnBranch(deps, base, branch, cwd) {
  if (!deps || typeof deps.execGit !== 'function') return NO_ANSWER('нет доступа к git')
  if (!cwd) return NO_ANSWER('рабочей копии нет')
  if (!base) return NO_ANSWER('базовый коммит неизвестен')
  let out = ''
  try {
    out = String(
      deps.execGit(
        // `-c core.quotepath=false` AND `-z`, and both on purpose. `-z` is what makes the
        // answer parseable at all — records separated by a byte that cannot occur in a path.
        // `core.quotepath=false` is the belt for the day the records arrive newline-separated
        // anyway: without it git renders every non-Latin byte as an octal escape inside
        // quotes, and a person opening the row sees `"\321\200\321\203…"` where a filename
        // should be. That line is not hypothetical — it is already in this daemon's own log.
        ['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', `${base}..${branch || 'HEAD'}`],
        { cwd },
      ) || '',
    )
  } catch (err) {
    return NO_ANSWER(`git не ответил: ${String((err && err.message) || err)}`)
  }
  const { entries, vanished } = parseNameStatus(out)
  const files = entries.slice(0, ATTEMPT_FILES_CAP)
  const deletions = vanished.slice(0, ATTEMPT_FILES_CAP)
  return {
    files,
    deletions,
    filesOverflow: Math.max(0, entries.length - files.length),
    deletionsOverflow: Math.max(0, vanished.length - deletions.length),
    answered: true,
    reason: entries.length ? null : 'изменённых файлов нет',
  }
}

/**
 * attachChangedFiles(deps, worktree) → the changed-file record of THIS attempt, computed once.
 *
 * IT SITS BESIDE THE PARITY VERDICT, AND FOR THE SAME REASON. Both doors that close an
 * attempt — the one to «готово» and the one to «провал» — ask for it as their first line,
 * before the ledger row is appended, because the ROW is what a card is built from and the row
 * is written before anything else about the ending exists. Twenty-three exits reach those two
 * doors; putting the question here rather than at each exit is why this is ONE edit and not
 * twenty-three, and why an exit added tomorrow gets the list for free.
 *
 * IT IS ASKED WHILE THE BRANCH IS STILL ALIVE. After approval the copy is swept, its branch
 * goes with it, and an unreachable commit is collected sooner or later; recomputing later from
 * a remembered tip is a FALLBACK, never the main road.
 *
 * THE CACHE LIVES ON THE COPY, NOT ON THE RUN DIRECTORY. Either door may ask first, and git
 * must be asked exactly once per attempt — but an exit that never made a run directory owes
 * the same record as one that did, so the answer is kept beside the copy itself. Hang it on
 * the run directory and every early refusal silently loses its list.
 *
 * FAIL-OPEN: no copy at all yields null, and the row then carries no such keys — «попытка
 * этого не знает», which is not the same claim as «ничего не менялось».
 */
function attachChangedFiles(deps, worktree) {
  if (!worktree || typeof worktree !== 'object') return null
  if (worktree.changed) return worktree.changed // one attempt, one question to git
  worktree.changed = changedFilesOnBranch(deps, worktree.base, worktree.branch, worktree.worktreePath)
  return worktree.changed
}

/** One entry of the list as a person reads it: `M имя` — and a rename naming both sides. */
function fileWord(f) {
  return f && f.from ? `${f.status} ${f.from} → ${f.path}` : `${(f && f.status) || '?'} ${(f && f.path) || ''}`
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
 * askAlreadyBuilt(deps, verbRunner, task, cwd) → true when EVERY plan of this task's phase
 * already stands built in the tree, false in every other case. THE DOOR THAT SKIPS WORK, and
 * the three rules that keep it honest:
 *
 *   1. WHAT THE VERB IS ASKED WITH. The preflight verb takes a PATH TO A PLAN as its first
 *      positional and answers a machine only when asked for machine output. It used to be
 *      called with a task identifier and no such flag, so it answered a sentence meant for a
 *      person, the reader of verb answers found no object in it, and the door read that
 *      emptiness as «not built» — every single time, for a year, with nothing in any log to
 *      say so. Both halves are asserted by a test that records the invocation itself.
 *   2. WHERE IT IS ASKED. Plan paths and the artifact paths inside a plan alike resolve
 *      against the working directory of the child, so the question must be put in the tree of
 *      the CONNECTED PROJECT — the same expression the worktree provision uses, never the
 *      directory this process happened to be launched from.
 *   3. HOW MANY PLANS. A phase produces many; «built» is returned only when EVERY one of them
 *      answers built. The two possible mistakes cost wildly different things: a false «not
 *      built» costs one extra run, a false «built» closes the task with no executor at all and
 *      the work is never done, quietly, with «completed» standing in the ledger. A door that
 *      exists to save work must err towards doing it.
 *
 * EVERY answer is written to the daemon's log — built, partial, absent and the verb's own
 * failure — and so is the decision NOT to ask. Silence about a door that was consulted is the
 * very thing that let the broken call live unnoticed: one line naming the plan and the verdict
 * turns that into a minute's reading.
 */
async function askAlreadyBuilt(deps, verbRunner, task, cwd) {
  const phase = stageDataOf(task).phase
  if (phase === undefined || phase === null || String(phase).trim() === '') {
    // Ordinary queue work carries no phase by construction — backlog intake skips the lines
    // that have one, because those become phase cards instead. Such a task has no plan and
    // therefore no deterministic thing to check, and its success criteria are PROSE, which a
    // verdict may never be made to judge. So the verb is not called at all — and the reason
    // is on the record, because a door that is quietly never opened looks exactly like a
    // door that is broken.
    writeLog(deps, {
      type: 'preflight.skipped',
      taskId: task.id,
      reason: 'задача не несёт номера фазы — плана нет, спрашивать нечего',
    })
    return false
  }
  const planPaths = findArtifacts(deps, cwd, phase, STAGE_ARTIFACTS.plan.produces)
  if (planPaths.length === 0) {
    writeLog(deps, {
      type: 'preflight.skipped',
      taskId: task.id,
      phase: String(phase),
      reason: 'планов фазы не нашлось в дереве проекта — спрашивать нечего',
    })
    return false
  }
  let allBuilt = true
  // No early exit on the first non-built answer: asking is cheap and deterministic, and a log
  // that names every plan of the phase is what makes the verdict explainable afterwards.
  for (const planPath of planPaths) {
    const pf = await invokeVerb(verbRunner, 'preflight', [planPath, '--json'], cwd)
    writeLog(deps, {
      type: 'preflight.verdict',
      taskId: task.id,
      planPath,
      verdict: pf.verdict ?? null,
      code: pf.code,
      ...(pf.error ? { error: String(pf.error) } : {}),
    })
    if (pf.verdict !== 'built') allBuilt = false
  }
  return allBuilt
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
    // A WINDOW THE VENDOR SAYS IS NO LONGER ALLOWING WORK IS A CLOSE, AND A CLOSE OUTLIVES
    // EVERY OTHER FACT ON THIS LINE. This used to fire on `utilization >= 1` — a fraction the
    // stream has never once carried, which arrives here as 0 — so the condition was false on
    // every real machine and the refusal this call exists to persist was never written down.
    // It now fires on what the stream really says: the reading's own status.
    if (readingSaysExhausted(event) && Number.isFinite(Number(event.resetsAt))) {
      markWindowClosed({ dataDir, accountName, resetAt: event.resetsAt, clock, fsImpl: deps.fsImpl })
    }
  } catch (err) {
    writeLog(deps, { type: 'window-reading-error', account: accountName, error: String((err && err.message) || err) })
  }
}

// ── WHAT THE ATTEMPT REALLY DID WITH MEMORY, read off its own stream ────────────────────
// The journal's memory layer used to be a DECLARATION: the name of the role file the worker
// was configured with, written before the session opened its mouth, and only for a worker that
// had one at all. On the machine that meant zero memory rows across dozens of attempts, while
// the product's own promise is a flywheel turning in both directions. What follows reads the
// OBSERVATION instead — the file the session opened, the pipeline call it made, the corpus it
// stood in — and nothing here can fail an attempt: an unrecognisable frame simply teaches us
// nothing about it.

/** The corpus of the copy the worker stands in: `<workDir>/.claude/memory/…`. */
const MEMORY_CORPUS_SEGMENT = '/.claude/memory/'

/**
 * The mark of a worker ACCOUNT's own directory. The account holds the vendor's per-project
 * auto-memory, which is a different thing from the project's corpus and is counted apart: a
 * session that read its own scratch memory has not read the memory a person curates, and one
 * list holding both would let the second claim be made on the first's evidence.
 */
const ACCOUNT_DIR_MARK = '/.sma-accounts/'

/** Asking the memory pipeline for notes by tag — the one call that means «loaded on purpose». */
const MEMORY_LOAD_RE = /cli\.mjs\S*\s+load\b/

/** Tools that run something on the machine; a memory load can arrive through either shell. */
const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell'])

/** Slashes one way, so a Windows path and a POSIX one are compared as one string. */
function slashed(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/**
 * Append an id ONCE. The tick file keeps no keyed collection in process — its own standing
 * discipline, guarded by a grep in the suite — so uniqueness is done in place on a list. The
 * lists here hold the notes of a single attempt: a handful of names, where the plain scan is
 * cheaper than the object that would replace it and does not smuggle in a store.
 */
function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value)
  return list
}

/** The same rule applied to two lists joined: first occurrence wins, order kept. */
function uniqueIds(list) {
  const out = []
  for (const v of list) pushUnique(out, v)
  return out
}

/** The note id a corpus file carries: its own name, without the extension. */
function noteIdOfPath(path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.md$/i, '')
}

/** The tool_use blocks of one assistant frame, or an empty list for anything else. */
function toolUsesOf(frame) {
  const message = frame && typeof frame.message === 'object' && frame.message !== null ? frame.message : null
  const content = message && Array.isArray(message.content) ? message.content : []
  return content.filter((b) => b && typeof b === 'object' && b.type === 'tool_use')
}

/**
 * WHICH memory file a path names — `{kind, id}` or null for anything that is not one.
 *
 * The account's auto-memory is decided FIRST and returns: its path also ends in `/memory/`,
 * and asking the corpus question first would file it as a note of the project.
 *
 * IT DECIDES NOTHING ABOUT THE TRACE. Classifying a path and counting a reading are two acts
 * on purpose: the first happens when the session ASKS for a file, the second only when the
 * file came back. See `commitMemoryRead` below for why that separation had to exist.
 */
function classifyMemoryRead(rawPath, scope) {
  const path = slashed(rawPath)
  if (!path) return null
  const low = path.toLowerCase()
  const accountDir = slashed(scope.accountDir).toLowerCase().replace(/\/+$/, '')
  const inAccount = (accountDir && low.startsWith(`${accountDir}/`)) || low.includes(ACCOUNT_DIR_MARK)
  if (inAccount && low.includes('/projects/') && low.includes('/memory/')) {
    return { kind: 'auto', id: noteIdOfPath(path) }
  }
  // The copy is NAMED when we know it, so a read of some other tree's corpus is not counted as
  // this attempt's. Without a copy — a documentary stage runs in none — the segment alone is
  // the best honest answer.
  const workDir = slashed(scope.workDir).toLowerCase().replace(/\/+$/, '')
  const inCorpus = workDir ? low.startsWith(`${workDir}${MEMORY_CORPUS_SEGMENT}`) : low.includes(MEMORY_CORPUS_SEGMENT)
  if (!inCorpus) return null
  const id = noteIdOfPath(path)
  // The index is the corpus's front door — «прочитал оглавление» and «прочитал заметку» are
  // two different facts about an attempt and are kept as two.
  return /^memory$/i.test(id) ? { kind: 'index', id } : { kind: 'note', id }
}

/**
 * Record ONE file the session REALLY got back into the running memory trace.
 *
 * WHY THIS IS SEPARATE FROM THE CLASSIFIER. The trace used to count a reading the moment the
 * session asked for the file, and the difference is not academic: a copy provisioned without
 * `.claude/` answers every such request with «File does not exist», and for a year those
 * attempts were recorded as having read the project's memory. The claim «работник читал
 * память» is about what CAME BACK, so it is made here — after the result frame said so.
 */
function commitMemoryRead(memory, hit) {
  if (!hit) return
  if (hit.kind === 'auto') pushUnique(memory.autoMemoryReads, hit.id)
  else if (hit.kind === 'index') memory.index = true
  else pushUnique(memory.reads, hit.id)
}

/** The tool_result blocks of one user frame, or an empty list for anything else. */
function toolResultsOf(frame) {
  const message = frame && typeof frame.message === 'object' && frame.message !== null ? frame.message : null
  const content = message && Array.isArray(message.content) ? message.content : []
  return content.filter((b) => b && typeof b === 'object' && b.type === 'tool_result')
}

/** The text a tool result came back with, whichever of its two shapes the CLI used. */
function resultTextOf(block) {
  const content = block && block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
  return ''
}

/**
 * A REFUSED CALL IS NAMED BY ITS COMMAND, NOT COUNTED.
 *
 * The vendor hands us, on the result frame, the FULL list of calls its permission boundary
 * turned down: the tool, the id of the call, and the arguments it was called with. This
 * daemon used to keep one number out of that — the length — and throw the rest away. So the
 * person at the window read «refusals: 1» and could not learn WHAT the worker was stopped
 * from doing, which is precisely the evidence the whole boundary exists to produce. A count
 * proves that something was refused; only the command proves WHICH something.
 *
 * THE COUNT STAYS BESIDE THE LIST, NOT UNDER IT. Our own tally (a guard refusing inside the
 * stream) and the vendor's tally are two different measurements of the same run, and the day
 * they disagree is a finding about the guards — so neither is allowed to overwrite the other.
 *
 * AND A FLOOD IS CAPPED OUT LOUD. A session that hammers a refused command would otherwise
 * bury the attempt's journal; the lines stop at a declared cap and ONE last line says how
 * many were not written. Silent loss is the one outcome forbidden here.
 */

/** How many refusal lines one attempt may write before the tail becomes a single summary line. */
export const DENIAL_LINES_CAP = 50
/** How much of a refused command is kept: enough to recognise it, short enough not to flood. */
export const DENIAL_COMMAND_MAX = 300
/** Says a command was cut — a truncation nobody can see is a quotation nobody can trust. */
export const DENIAL_TRUNCATION_MARK = '…[truncated]'

/**
 * refusedCommandOf(denial) → the command the refused call carried, on one line and bounded,
 * or null when the call carried none. `tool_input` comes from OUTSIDE this process, so every
 * shape but the expected one reads as an absence rather than a throw.
 * @param {object} denial
 * @returns {string|null}
 */
function refusedCommandOf(denial) {
  const input = denial && typeof denial.tool_input === 'object' && denial.tool_input ? denial.tool_input : {}
  const raw =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.url === 'string'
          ? input.url
          : ''
  const one = String(raw).replace(/\s+/g, ' ').trim()
  if (one === '') return null
  return one.length > DENIAL_COMMAND_MAX ? `${one.slice(0, DENIAL_COMMAND_MAX)}${DENIAL_TRUNCATION_MARK}` : one
}

/**
 * copyRow({wt, base, branch, worktreePath, materialized, provisionMs}) — THE COPY AS ONE
 * OBJECT, ASSEMBLED IN ONE PLACE.
 *
 * There are two doors that provision a copy — the code/document path and the Creator's — and
 * they used to build this row as two separate lists of fields that happened to say the same
 * thing. Two such lists diverge on the day somebody edits one of them, and these two already
 * have that history. So the row is built here, by one expression, and a test calls BOTH doors
 * with the same verb answer and compares what came out: «it reached one of the two» is not
 * «it reached».
 *
 * `pushLock` is a FACT THE RECORD CARRIES, never an assumption. An install whose CLI predates
 * the lock answers nothing about it, and that reads as `null` — never as «locked», which
 * would be the record telling a person their worker cannot push when it can.
 * @param {{wt?:object, base?:string|null, branch:string, worktreePath:string,
 *          materialized?:Array|undefined, provisionMs?:number}} opts
 * @returns {object}
 */
export function copyRow({ wt, base, branch, worktreePath, materialized, provisionMs } = {}) {
  const answered = wt && typeof wt === 'object' ? wt : {}
  return {
    base: base || answered.expectedBase || answered.actualBase || null,
    branch,
    worktreePath,
    materialized,
    provisionMs,
    pushLock: answered.pushLock && typeof answered.pushLock === 'object' ? answered.pushLock : null,
  }
}

/** What a guard's refusal reads like when it arrives as a failed tool result rather than a frame. */
const TOOL_REFUSAL_RE = /permission|denied|not allowed|blocked|запрещ|не разреш|отказ/i

/** Was this failed result a GUARD refusing, rather than the work itself going wrong? */
function refusedByGuard(block, text) {
  // The helper's name is a claim, so it checks the claim itself rather than trusting a caller:
  // a result that is not an error is work that went its own way, never a guard stopping it.
  if (!block || block.is_error !== true) return false
  const meta = Array.isArray(block.tool_result_meta) ? block.tool_result_meta : []
  if (meta.some((m) => m && typeof m.non_execution_kind === 'string' && m.non_execution_kind)) return true
  return TOOL_REFUSAL_RE.test(text)
}

/** A reason a person reads, not a wall: one line, bounded. */
function shortReason(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > 200 ? one.slice(0, 200) : one
}

/** A list of names off an init frame — anything else reads as an absence, never as a throw. */
function namesOf(value) {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : String((v && v.name) ?? v))) : []
}

/**
 * unregisteredMcpTools(runInit, mcpConfig) → the MCP tools the session ACTUALLY loaded that did
 * not come from the registry this product handed it: sorted, without repeats.
 *
 * WHY THIS FIELD EXISTS, said plainly, because the alternative was to keep a promise that is
 * not true. A worker session is given our own servers as one argument, and its account is a
 * fresh directory with the hosted connectors switched off — and that is still not enough. A
 * server declared in the ROOT OF THE CONNECTED PROJECT is loaded into the session anyway.
 * Measured: a session started in a project carrying such a declaration came up with that
 * server connected and its tool listed in the opening frame, with a clean account directory
 * and our own server list passed explicitly. The account settings that read as though they
 * would prevent it do not — switching off the blanket enable changed nothing, and naming a
 * server in the disabled list works only for a name known IN ADVANCE, which a worker facing an
 * unfamiliar project does not have. The one mechanism that would close the door is a flag the
 * argument guard refuses, and the guard is not weakened for convenience.
 *
 * So the product stops claiming the door is shut and starts SAYING WHAT CAME THROUGH IT: the
 * tools of the live session, minus the servers we sent, written into the attempt's own record.
 * A capability nobody noticed is worse than one that is named.
 *
 * PURE. Written over arrays rather than a keyed collection because this file holds none by
 * standing discipline — the list is a handful of names, and a grep gate that a reader can
 * trust is worth more here than a lookup nobody would measure.
 */
export function unregisteredMcpTools(runInit, mcpConfig) {
  const tools = Array.isArray(runInit && runInit.tools) ? runInit.tools.map(String) : []
  const ours = (Array.isArray(mcpConfig && mcpConfig.servers) ? mcpConfig.servers : []).map(String)
  const out = []
  for (const tool of tools) {
    if (!tool.startsWith('mcp__')) continue
    if (ours.includes(tool.split('__')[1] ?? '')) continue
    if (!out.includes(tool)) out.push(tool)
  }
  return out.sort()
}

/**
 * collectSmaTrace({projectDir, sessionId, fsImpl}) → what the WORKER'S OWN session wrote down
 * about memory while it ran: `{reads, reflexes, source}`.
 *
 * Where it looks and why THERE: the citation and reflex files live under the coordination root
 * — the project's `.sma`, shared by every linked copy — and they are named by the terminal
 * identity minted from the session id (`t-<tokenHash(sessionId)>`). That is the ONLY thread
 * that ties a worker's own hook writes back to the attempt that caused them, and it is why the
 * hash function is imported rather than re-typed here.
 *
 * FAIL-OPEN, and precise about its own ignorance: an absent file means «we did not see any»,
 * which is reported as `source:'none'` rather than as an empty list that pretends to be an
 * observation. The source names where the REFLEXES came from, so it says «sma-journal» only
 * when the reflex journal itself was readable.
 */
export function collectSmaTrace({ projectDir, sessionId, fsImpl } = {}) {
  const empty = { reads: [], reflexes: [], source: 'none' }
  if (!projectDir || !sessionId) return empty
  const io = resolveIo(fsImpl)
  const terminal = `t-${tokenHash(sessionId)}`
  const rowsOf = (file) => {
    try {
      if (!io.existsSync(file)) return null
      return String(io.readFileSync(file, 'utf8'))
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((row) => row && typeof row === 'object')
    } catch {
      return null // an unreadable trace is an ABSENT trace, never a failed attempt
    }
  }
  const reads = []
  const reflexes = []
  for (const row of rowsOf(join(projectDir, '.sma', 'usage', `${terminal}.jsonl`)) || []) {
    if (row.kind === 'load' && row.noteId) pushUnique(reads, String(row.noteId))
  }
  const journalRows = rowsOf(join(projectDir, '.sma', 'journal', `${terminal}.jsonl`))
  for (const row of journalRows || []) {
    const noteId = row.type === 'reflex' && row.detail && row.detail.noteId
    if (noteId) pushUnique(reflexes, String(noteId))
  }
  return { reads, reflexes, source: journalRows ? 'sma-journal' : 'none' }
}

/** The lesson as the journal stores it: a draft, a stated «nothing», or neither. */
function lessonLayerOf(lessonEval) {
  if (lessonEval && lessonEval.written) return { written: lessonEval.written }
  if (lessonEval && lessonEval.none) return { none: lessonEval.none }
  return { missing: true }
}

/**
 * writeMemoryLayer(deps, task, …) — the journal's memory layer for THIS attempt, written ONCE
 * and UNCONDITIONALLY.
 *
 * «Unconditionally» is the whole point and the difference from what stood here before: a failed
 * attempt's memory trace is worth exactly as much as a finished one's — more, usually, because
 * «he never opened the corpus» is the sentence that explains the failure. So there is no `if`
 * in front of this call: every attempt of every lane leaves the layer, even when it read
 * nothing, and an empty trace says so in its own fields instead of by being absent.
 *
 * The project's corpus and the account's own memory are joined nowhere: `loaded.reads` unites
 * the two PROJECT sources (what the stream saw opened and what the pipeline's citations
 * recorded), while `autoMemoryReads` stays a separate list.
 */
function writeMemoryLayer(deps, task, { memory, sma, lesson, approachJournaled, notes } = {}) {
  const m = memory || { index: false, reads: [], autoMemoryReads: [], loadCalls: 0 }
  const s = sma || { reads: [], reflexes: [], source: 'none' }
  writeJournal(deps, {
    taskId: task.id,
    attempt: task.attempt,
    layer: 'memory',
    payload: {
      notes: Array.isArray(notes) ? notes : [],
      reflexes: s.reflexes,
      reflexSource: s.source,
      loaded: {
        index: m.index === true,
        reads: uniqueIds([...(m.reads || []), ...(s.reads || [])]),
        loadCalls: m.loadCalls || 0,
      },
      autoMemoryReads: m.autoMemoryReads || [],
      lesson: lesson || { missing: true },
      approach: approachJournaled ? 'journaled' : 'absent',
    },
  })
}

/**
 * What the copy was given to obey — read WHILE the copy still exists, before any outcome.
 *
 * Exported for the suite: the difference between «carried into the copy» and «was already there»
 * is a word a person reads on a receipt, and a word on a receipt has to be tested directly rather
 * than inferred from a run that happened to come out right.
 */
export function rulesInCopy(io, workDir, worktree) {
  if (typeof workDir !== 'string' || workDir.trim() === '') return { claudeMd: 'absent' }
  try {
    const present = io.existsSync(join(workDir, 'CLAUDE.md')) || io.existsSync(join(workDir, '.claude', 'CLAUDE.md'))
    if (!present) return { claudeMd: 'absent' }
    // «Tracked» and «materialized» are different claims: the first says the project keeps its
    // rules in git, the second that the provisioning verb had to carry them into a copy that
    // would not have had them. A parity check that could not tell them apart would call a
    // furnished copy an unfurnished one.
    const materialized = Array.isArray(worktree && worktree.materialized) ? worktree.materialized : []
    // An entry counts as a CARRY only when it says something was actually carried. The same list
    // also holds entries whose mode is «absent» — «there was nothing here to take» — and matching
    // the stringified entry reads one of those as proof of the opposite: a copy that never got the
    // rules would be labelled as one that was handed them. So: match the entry's own path, and
    // only on a mode that means a real copy — a linked path is the project's own tree, not
    // something carried into a copy that would otherwise lack it.
    const carried = materialized.some((m) => {
      if (!m || typeof m !== 'object') return false
      if (String(m.mode ?? '') !== 'copy') return false
      const where = String(m.path ?? '')
      return /(^|[\\/])CLAUDE\.md$/i.test(where) || /(^|[\\/])\.claude[\\/]?$/i.test(where)
    })
    return { claudeMd: carried ? 'materialized' : 'tracked' }
  } catch {
    return { claudeMd: 'absent' } // an unreadable copy is an absence of evidence, never a throw
  }
}

/** How many skills and agents the copy actually held; null when it has no `.claude` at all. */
function skillsInCopyOf(io, workDir) {
  if (typeof workDir !== 'string' || workDir.trim() === '') return null
  try {
    if (!io.existsSync(join(workDir, '.claude'))) return null
    const count = (name) => {
      try {
        return (io.readdirSync(join(workDir, '.claude', name)) || []).length
      } catch {
        return 0
      }
    }
    return { skills: count('skills'), agents: count('agents') }
  } catch {
    return null
  }
}

/**
 * writeAttemptRunDir(deps, task, …) → `{dir, gate, memoryLayer, rules, skillsInCopy}` or null.
 *
 * WHY IT IS CALLED WHERE IT IS. The one point every outcome of a lane passes through — right
 * after the memory layer — is the only place from which «каждая попытка оставляет запись» can
 * be a property of the control flow instead of a rule somebody has to remember at four return
 * statements. The receipt is written later, by the door that knows how the try ended.
 *
 * NOTHING SECRET TRAVELS. The spawn's environment contributes its NAMES; the prompt
 * contributes a digest and a size. The values the environment holds are handed to the writer
 * only so it can assert they appear nowhere in what it wrote.
 */
function writeAttemptRunDir(deps, task, {
  route,
  envelope,
  spec,
  worktree,
  workDir,
  startedAt,
  endedAt,
  sessionId,
  runInit,
  memory,
  sma,
  guards,
  permissionDenials,
  ledgerPath,
  exit,
  gate,
  lesson,
} = {}) {
  const config = deps.config || {}
  // THE SAME TREE THE COPY WAS CUT FROM — one source for both, so a run directory can never
  // end up beside a project the attempt never touched.
  const projectDir = (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir
  const runsDir = runsDirOf(projectDir)
  if (!runsDir) return null
  const io = resolveIo(deps.fsImpl)
  const env = (spec && spec.env && typeof spec.env === 'object') ? spec.env : {}
  const prompt = typeof (spec && spec.prompt) === 'string' ? spec.prompt : ''
  const rules = rulesInCopy(io, workDir, worktree)
  const skillsInCopy = skillsInCopyOf(io, workDir)
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
  let envelopeRecord = null
  if (envelope && typeof envelope === 'object') {
    let hash = null
    try {
      hash = envelopeHash(envelope)
    } catch {
      /* an unhashable envelope leaves no digest — a wrong one would be worse than none */
    }
    envelopeRecord = { ...envelope, hash }
  }

  const { dir } = writeRunStart({
    runsDir,
    attemptId: attemptIdFor(task.id, task.attempt),
    ledgerPath,
    guards,
    secretValues: secretValuesOf(env),
    fsImpl: deps.fsImpl,
    log: (entry) => writeLog(deps, entry),
    run: {
      taskId: task.id,
      attempt: Number.isFinite(Number(task.attempt)) ? Number(task.attempt) : 1,
      workerId: (route && route.workerId) || null,
      provider: (route && route.provider) || null,
      lane: task.lane ?? null,
      startedAt: iso(startedAt),
      endedAt: iso(endedAt),
      sessionId: sessionId ?? null,
      bin: (spec && spec.bin) || null,
      args: Array.isArray(spec && spec.args) ? [...spec.args] : [],
      // NAMES ONLY, SORTED. The list answers «which variables did the spawn get» — the only
      // question about an environment that can be answered without holding its secrets.
      envNames: Object.keys(env).sort(),
      prompt: { sha256: createHash('sha256').update(prompt, 'utf8').digest('hex'), bytes: Buffer.byteLength(prompt, 'utf8') },
      task: { model: task.model ?? null, effort: task.effort ?? null },
      envelope: envelopeRecord,
      copy: worktree
        ? {
            worktreePath: worktree.worktreePath ?? null,
            base: worktree.base ?? null,
            branch: worktree.branch ?? null,
            materialized: worktree.materialized ?? null,
            // WHETHER THE COPY WAS HANDED OVER WITHOUT AN ADDRESS TO PUSH TO — and, when it
            // was not, why in words. `null` means the install answered nothing about it, which
            // is a different fact from «not locked» and is written as a different value.
            pushLock: worktree.pushLock ?? null,
          }
        : null,
      personalLayer: (worktree && worktree.personalLayer) || null,
      mcpConfig: (worktree && worktree.mcpConfig) || null,
      // WHAT THE SESSION LOADED, and beside it what it loaded that WE never sent. A server
      // declared in the root of the connected project reaches the session whatever the account
      // says; since the product cannot honestly promise the door is shut, it writes down what
      // came through — an unnamed capability is the one nobody checks.
      init: runInit
        ? { ...runInit, unregisteredMcpTools: unregisteredMcpTools(runInit, (worktree && worktree.mcpConfig) || null) }
        : null,
      memory: memory ?? null,
      rules,
      skillsInCopy,
      exit: {
        code: exit && Number.isFinite(exit.code) ? exit.code : null,
        spawnError: !!(exit && exit.spawnError),
        permissionDenials: permissionDenials ?? null,
      },
    },
  })
  if (!dir) return null
  pruneRunDirs({
    runsDir,
    keep: Number.isFinite(config.runsKeep) ? config.runsKeep : RUN_DIRS_KEEP,
    fsImpl: deps.fsImpl,
    log: (entry) => writeLog(deps, entry),
  })
  return {
    dir,
    gate: gate || 'reverify',
    // The word the attempt left about what it learned — carried to the receipt so the outcome
    // and the lesson are one record rather than two that have to be joined by an id.
    lesson: lesson ?? null,
    // The same observation the journal's layer carries, kept beside the outcome so a reader
    // of one directory never has to open a ledger to learn whether the memory was read.
    memoryLayer: {
      index: !!(memory && memory.index),
      reads: (memory && memory.reads) || [],
      loadCalls: (memory && memory.loadCalls) || 0,
      reflexes: (sma && sma.reflexes) || [],
      failed: (memory && memory.failed) || [],
    },
    rules,
    skillsInCopy,
  }
}

/**
 * The three facts of a receipt the parity check actually reads: the memory layer as the stream
 * observed it, the state of the project's rules in the copy, and what skills the copy held.
 * Named ONCE and used twice — by the verdict computed below and by the receipt written after
 * it. Two spellings of the same object is precisely how a precomputed verdict starts describing
 * a receipt that nobody ever wrote.
 */
function receiptFactsOf(run) {
  return {
    memoryLayer: run.memoryLayer ?? null,
    rules: run.rules ?? null,
    skillsInCopy: run.skillsInCopy ?? null,
  }
}

/** One JSON artifact of the run directory, or null for one that cannot be read or parsed. */
function readRunArtifact(io, path) {
  try {
    return JSON.parse(String(io.readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/**
 * The rows of a JSONL artifact: a MISSING file is null, a corrupt LINE is skipped. The same
 * reading rule the checking command applies, so one file can never become two different sets
 * of rows depending on who opened it.
 */
function readRunRows(io, path) {
  let raw
  try {
    raw = String(io.readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* an unparsable row is skipped and never thrown — the artifact's own fail-open posture */
    }
  }
  return rows
}

/**
 * attachAttemptParity(deps, worktree) → the parity summary of this attempt, or null.
 *
 * WHY THE DAEMON COMPUTES A VERDICT THE COMMAND CAN ALSO COMPUTE. A person looking at an
 * attempt on a card wants to know whether that session really ran under their rules, and they
 * want to know it BY LOOKING. Making them run a command first is making them audit their own
 * product before it will answer; the summary therefore rides the attempt row, and the command
 * stays what it always was — the long form, for the person who wants the five sentences.
 *
 * WHY THIS CANNOT DRIFT FROM THE COMMAND. It is not a second calculation. It is the SAME
 * exported evaluation, handed the SAME four artifacts, read back FROM THE DIRECTORY that was
 * just written rather than from the objects that produced it. Reading the files back is the
 * point: what the command will see is bytes on disk, after redaction and after a JSON round
 * trip, and a verdict computed over the in-memory originals could quietly describe something
 * else. The suite asserts the two verdicts equal receipt by receipt, so a divergence becomes a
 * red suite instead of a discovery somebody makes holding a green report over a red run.
 *
 * WHY IT IS ASKED FOR BEFORE THE ROW IS WRITTEN. The row is the durable record the card is
 * built from, and the closing doors append it BEFORE the receipt file is written. A verdict
 * computed at receipt time would land in the file and never on the row — computed, stored, and
 * delivered to nobody, which is the exact shape of the failure this wiring exists to end.
 *
 * FAIL-OPEN AND HONEST ABOUT SILENCE. A directory that was never made, or a `run.json` that
 * cannot be read back, yields null — «nobody has checked», which is what a null on the row has
 * always meant. It does NOT yield five failures: the command answers a person who asked, and
 * its «no data» is an answer to that question; a daemon that could not read its own file has no
 * question in front of it and must not hang a red verdict on an attempt on the strength of it.
 */
function attachAttemptParity(deps, worktree) {
  const run = worktree && typeof worktree.run === 'object' ? worktree.run : null
  if (!run || typeof run.dir !== 'string' || run.dir === '') return null
  if (run.parity) return run.parity // one attempt, one verdict — either door may ask first
  try {
    const io = resolveIo(deps.fsImpl)
    const record = readRunArtifact(io, join(run.dir, PARITY_ARTIFACTS.run))
    if (!record) {
      writeLog(deps, {
        type: 'run_dir.parity_skipped',
        dir: run.dir,
        detail: `${PARITY_ARTIFACTS.run} не читается — вердикт паритета не считался`,
      })
      return null
    }
    const guards = readRunRows(io, join(run.dir, PARITY_ARTIFACTS.guards))
    // The worker AS THE CONFIG DESCRIBES IT — the rights receipt names it, so a reader who
    // finds a mismatch knows which entry to open. The command reaches the same list through its
    // own `--config` flag; neither side invents one.
    const workerId = record.workerId
    const worker = workerId
      ? ((deps.config && deps.config.workers) || []).find((w) => w && w.id === workerId) ?? null
      : null
    const results = evaluateParity({ run: record, guards, receipt: receiptFactsOf(run), worker })
    run.parityResults = results
    run.parity = summarize(results)
    return run.parity
  } catch (err) {
    // A verdict is a record, never a reason to lose an attempt.
    writeLog(deps, { type: 'run_dir.parity_error', dir: run.dir, error: String((err && err.message) || err) })
    return null
  }
}

/**
 * writeAttemptOutcome(deps, worktree, receipt) — the fourth file, written by the door that
 * KNOWS how the attempt ended. Fail-open and silent about a directory that was never made:
 * an attempt refused before it ever spawned has nothing to write a receipt into.
 *
 * AND THE DOOR THAT CLOSES THE ATTEMPT CLOSES ITS TICKETS. A parking ticket is closed by one
 * of three paths — approved, refused, its own deadline — and all three are written by the
 * HOOK's process. When that process dies (a killed session, a fallen daemon, a cut provider)
 * the file stays `waiting` for ever, and the card goes on telling a person he is being waited
 * on for a call that no longer exists. This is the right place for the other half of the fix:
 * it is called on BOTH outcomes and it already knows the attempt's directory. The reader's own
 * deadline filter heals the files already lying on disk; this heals the ones written from now
 * on, at the moment the truth about them changes.
 */
function writeAttemptOutcome(deps, worktree, receipt) {
  const run = worktree && typeof worktree.run === 'object' ? worktree.run : null
  if (!run || typeof run.dir !== 'string' || run.dir === '') return false
  // Уборка за попыткой — не условие попытки: билет, который не пометился, не имеет права
  // стоить работы, которая уже сделана.
  try {
    const closed = closeWaitingTickets({
      runDir: run.dir,
      clock: typeof deps.clock === 'function' ? deps.clock : Date.now,
      fsImpl: deps.fsImpl,
    })
    if (closed > 0) writeLog(deps, { type: 'run_dir.tickets_closed', dir: run.dir, closed })
  } catch (err) {
    writeLog(deps, { type: 'run_dir.tickets_close_error', dir: run.dir, error: String((err && err.message) || err) })
  }
  // The verdict is already reached — the closing door asked for it before it wrote the ledger
  // row, which is the only order in which a row can carry one. Here it is written down WHOLE:
  // the five receipts with their details beside the summary, so one directory can answer «did
  // this session really run under my rules» without a second command and without a second
  // opinion. A verdict that could not be computed stays null: «nobody has checked», never
  // «checked and fine».
  const parity = attachAttemptParity(deps, worktree)
  return writeRunReceipt({
    dir: run.dir,
    fsImpl: deps.fsImpl,
    log: (entry) => writeLog(deps, entry),
    receipt: {
      ...receipt,
      gate: run.gate || 'reverify',
      ...receiptFactsOf(run),
      parity: parity ? { results: run.parityResults ?? [], summary: parity } : null,
    },
  })
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
 * It also READS THE INIT FRAME, which is the only evidence this daemon ever gets that the
 * personal layer actually reached the session: the CLI states there which memory directory it
 * will write to, which hooks it started, which mcp servers it attached and which tools those
 * servers brought. A layer mirrored into an account and a layer the session actually loaded are
 * two different claims, and only the second one is worth anything to a person asking «did the
 * worker run under my rules». The same two frames — init and result — are also MARKED for the
 * transcript writer, which gives a marked frame a size of its own: the init frame is the
 * biggest line of the run and the line cap made it useless exactly where it mattered.
 *
 * It also KEEPS THE SESSION ID off the result frame. That identifier is the one thing about a
 * finished attempt that cannot be recovered later, and holding it is what makes resuming a
 * session — instead of paying for its context again — possible at all.
 *
 * The log is read through `parseClaudeEvent`, which never throws on any input: a line that is
 * not JSON is still a line, and it is still logged. NOTHING here can fail the attempt.
 */
function attemptStream(deps, task, streamLines, now, subscription = {}, scope = {}) {
  const log = openAttemptLog(deps, task)
  const state = { sessionId: null, init: null, runInit: null, permissionDenials: null }
  /** What this session did with memory, accumulated live — see the trace helpers above. */
  const memory = { index: false, reads: [], autoMemoryReads: [], loadCalls: 0, failed: [] }
  /**
   * WHAT WAS WATCHING, line by line: every hook the CLI started and answered, and every tool a
   * guard refused. Collected here rather than derived later because the ledger caps a long line
   * and a refusal is exactly the kind of frame that arrives long.
   */
  const guards = []
  /**
   * WHICH REFUSALS THE VENDOR ALREADY NAMED — ids only, kept as a flat list because this file
   * holds no keyed collection of its own (see the disciplines at the top). A result frame that
   * arrives twice describes ONE refusal, and the record must not double it.
   */
  const denialIdsWritten = []
  /** How many refusal lines this attempt has written, and how many the cap left out. */
  let denialLinesWritten = 0
  let denialsNotRecorded = 0
  /** The ONE tail line that says what the cap left out — created once, kept current. */
  let denialOverflowLine = null
  /**
   * Tool calls the session ASKED for, waiting for the result that decides what they proved —
   * and the ones a guard already refused. The bookkeeping lives in a helper module because
   * this file holds no keyed collection of its own (see the disciplines at the top).
   */
  const pairing = createToolPairing()
  /** SessionStart hooks the CLI reported starting — the founder's hook is one of them. */
  let hookStarts = 0
  let lastTouchAt = 0
  /** One line per attempt, not per renewal: a broken lease says its piece once. */
  let touchBroken = false
  const onLine = (line) => {
    streamLines.push(line)
    const { event, frame } = parseClaudeFrame(line)
    if (!state.sessionId && event.sessionId) state.sessionId = event.sessionId
    // WHAT THE SESSION SAYS IT WAS GIVEN, taken from its own opening frame. Nothing here can
    // fail the attempt: an absent field is read as an absence, never as a reason to refuse.
    if (frame && frame.type === 'system') {
      if (frame.subtype === 'init') {
        state.init = {
          // The project memory the CLI will write to on its own — the founder's auto-memory,
          // reached WITHOUT building any junction: the path is simply reported and recorded.
          autoMemoryDir: (frame.memory_paths && frame.memory_paths.auto) || null,
          initMcpServers: (Array.isArray(frame.mcp_servers) ? frame.mcp_servers : []).map((m) => (m && m.name) || String(m)),
          // Tools whose names begin like a hosted claude.ai connector. The count is the whole
          // point of the connectors switch: zero is the receipt that nothing foreign attached.
          initClaudeAiTools: (Array.isArray(frame.tools) ? frame.tools : []).filter((t) => /^mcp__claude_ai/i.test(String(t))).length,
          initPlugins: Array.isArray(frame.plugins) ? frame.plugins : [],
          permissionMode: frame.permissionMode ?? null,
        }
        // THE SAME FRAME, KEPT WHOLE for the attempt's run directory. The row above is a
        // handful of counters a card renders; the record below is what a checking tool has to
        // compare against the envelope — the tool list the session really got, the skills and
        // agents it could reach, and the memory directory it was pointed at.
        state.runInit = {
          claudeCodeVersion: frame.claude_code_version ?? null,
          model: frame.model ?? null,
          permissionMode: frame.permissionMode ?? null,
          tools: namesOf(frame.tools),
          skills: namesOf(frame.skills),
          agents: namesOf(frame.agents),
          plugins: namesOf(frame.plugins),
          mcpServers: namesOf(frame.mcp_servers),
          memoryPathsAuto: (frame.memory_paths && frame.memory_paths.auto) || null,
        }
      } else if (frame.subtype === 'hook_started' || frame.subtype === 'hook_response') {
        if (frame.subtype === 'hook_started' && /SessionStart/.test(String(frame.hook_name || ''))) hookStarts += 1
        // ONE LINE PER HOOK EVENT. «Хук сработал» was until now a number nobody could open:
        // the count said two and named neither, and a hook that answered with an error looked
        // exactly like one that answered with a page of context.
        guards.push({
          ts: new Date(now()).toISOString(),
          kind: frame.subtype,
          hookName: frame.hook_name ?? null,
          hookEvent: frame.hook_event ?? null,
          ...(frame.exit_code === undefined ? {} : { exitCode: frame.exit_code }),
          ...(frame.outcome === undefined ? {} : { outcome: frame.outcome }),
          ...(typeof frame.output === 'string' ? { outputBytes: Buffer.byteLength(frame.output, 'utf8') } : {}),
        })
      } else if (frame.subtype === 'permission_denied') {
        // THE GUARD'S OWN WORDS, from the frame it says them in. The failed tool result that
        // follows carries the same sentence with none of the naming, so this is the source and
        // the result below is only the fallback.
        pairing.markRefused(frame.tool_use_id)
        guards.push({
          ts: new Date(now()).toISOString(),
          kind: 'denied',
          tool: frame.tool_name ?? null,
          reason: shortReason(frame.message ?? frame.decision_reason_type ?? 'permission denied'),
        })
      }
    }
    // WHAT IT OPENED AND WHAT IT LOADED — taken from the frame itself and BEFORE the line is
    // capped for storage. The summary a person reads is capped at two hundred characters,
    // which is fine for an eye and wrong for evidence: a compound shell line would lose the
    // `--tags` that makes it a memory load, and a long Windows path would lose its file name.
    if (frame && frame.type === 'assistant') {
      try {
        for (const block of toolUsesOf(frame)) {
          const name = typeof block.name === 'string' ? block.name : ''
          const input = block.input && typeof block.input === 'object' ? block.input : {}
          const entry = { tool: name }
          if (name === 'Read' && typeof input.file_path === 'string') {
            const hit = classifyMemoryRead(input.file_path, scope)
            if (hit) entry.memory = hit
          } else if (SHELL_TOOLS.includes(name) && typeof input.command === 'string') {
            if (MEMORY_LOAD_RE.test(input.command) && /--tags\b/.test(input.command)) entry.load = true
          }
          // ASKED, NOT YET PROVED. Nothing is counted here on purpose — the user frame below
          // is where a request becomes a fact.
          pairing.remember(block.id, entry)
        }
      } catch {
        /* the trace is an OBSERVATION: a frame it cannot read teaches nothing, breaks nothing */
      }
    }
    // WHAT CAME BACK — the half of the conversation the trace never used to read. A tool result
    // is matched to its request by `tool_use_id`, and only a result that is not an error and
    // not empty turns a request into something this attempt may claim it did.
    if (frame && frame.type === 'user') {
      try {
        for (const block of toolResultsOf(frame)) {
          const resultId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
          const pending = pairing.take(resultId)
          const text = resultTextOf(block)
          const errored = block.is_error === true
          const empty = text.trim() === ''
          if (pending && pending.memory) {
            if (!errored && !empty) commitMemoryRead(memory, pending.memory)
            else memory.failed.push({ kind: pending.memory.kind, id: pending.memory.id, reason: errored ? 'read failed' : 'read empty' })
          } else if (pending && pending.load) {
            if (!errored && !empty) memory.loadCalls += 1
            else memory.failed.push({ kind: 'load', reason: errored ? 'load failed' : 'load empty' })
          }
          if (errored && refusedByGuard(block, text) && !pairing.refused(resultId)) {
            pairing.markRefused(resultId)
            guards.push({ ts: new Date(now()).toISOString(), kind: 'denied', tool: (pending && pending.tool) || null, reason: shortReason(text) })
          }
        }
      } catch {
        /* an unreadable result frame teaches nothing and breaks nothing (fail-open) */
      }
    }
    // WHAT THE VENDOR ITSELF COUNTED AS REFUSED. Kept beside our own count rather than instead
    // of it: the two disagreeing is a finding about the guards, not a bug in this reader.
    if (frame && frame.type === 'result' && Array.isArray(frame.permission_denials)) {
      state.permissionDenials = frame.permission_denials.length
      // AND WHAT IT REFUSED, BY NAME. The number above answers «was anything stopped»; the
      // lines below answer «what», which is the only half a person can act on. Everything here
      // is fail-open by construction: a malformed entry becomes a line with nulls in it, never
      // a reason to fail an attempt over its own evidence.
      for (const item of frame.permission_denials) {
        const denialItem = item && typeof item === 'object' ? item : {}
        const toolUseId = typeof denialItem.tool_use_id === 'string' ? denialItem.tool_use_id : ''
        if (toolUseId && denialIdsWritten.includes(toolUseId)) continue
        if (toolUseId) denialIdsWritten.push(toolUseId)
        if (denialLinesWritten >= DENIAL_LINES_CAP) {
          denialsNotRecorded += 1
          continue
        }
        denialLinesWritten += 1
        guards.push({
          ts: new Date(now()).toISOString(),
          kind: 'denied',
          // WHOSE COUNT THIS IS. Our own refusals are written from the stream a few lines up
          // and carry no source; naming the vendor here is what lets a reader tell the two
          // measurements apart instead of silently adding them together.
          source: 'vendor',
          tool: typeof denialItem.tool_name === 'string' ? denialItem.tool_name : null,
          command: refusedCommandOf(denialItem),
          toolUseId: toolUseId || null,
          reason: 'refused by the permission boundary this run was started under',
        })
      }
      if (denialsNotRecorded > 0) {
        // ONE line, kept current rather than repeated: the cap is about the journal's size, and
        // a tail that grew a line per overflow would defeat its own purpose. What must never
        // happen is the loss going unsaid.
        if (!denialOverflowLine) {
          denialOverflowLine = { ts: new Date(now()).toISOString(), kind: 'denied_overflow', source: 'vendor' }
          guards.push(denialOverflowLine)
        }
        denialOverflowLine.notRecorded = denialsNotRecorded
        denialOverflowLine.reason =
          `${denialsNotRecorded} more refused calls were not written — this attempt reached the cap of ` +
          `${DENIAL_LINES_CAP} refusal lines`
      }
    }
    if (event.type === 'rate_limit') recordWindowReading(deps, subscription, event)
    // The sentence a person reads is built HERE, off the frame that was just parsed and
    // BEFORE the line is capped for storage: the biggest frames — a delegation brief, a file
    // read — are exactly the ones the cap would make unreadable. An unrecognisable frame
    // summarises to nothing, and nothing means the screen falls back to the raw line.
    const summary = frame ? summarizeFrame(frame) : []
    // WHICH FRAME THIS LINE IS — said HERE, where it was just parsed, and nowhere else. The
    // journal caps a row by this word: `init` (what the session was armed with) and `result`
    // (how it ended) are read whole, everything else keeps the ordinary line cap. Recognition
    // is asked of the module that knows frames; the journal is told, never guesses.
    const frameKind = frame ? wholeFrameKind(frame) : null
    log.append({
      line,
      ...(frameKind ? { frame: frameKind } : {}),
      subagent: event.subagent === true,
      parentId: event.parentId,
      ...(summary.length ? { summary } : {}),
    })
    const t = now()
    if (t - lastTouchAt >= TOUCH_THROTTLE_MS) {
      lastTouchAt = t
      // A RENEWAL THAT CANNOT RUN IS WHY A LIVE WORKER GETS BURIED. This catch used to be
      // empty, and that silence is what let the lease renewal fail on every tick unnoticed:
      // the attempt kept streaming, the lease kept expiring, and nothing anywhere said the
      // two facts disagreed. Still fail-open — a broken renewal must never fail an attempt
      // that is doing its work — but it now leaves ONE line in the attempt's own log, where
      // the transcript and any later post-mortem will both find it.
      Promise.resolve(deps.adapter.touch(task.id)).catch((err) => {
        if (touchBroken) return
        touchBroken = true
        log.append({
          line: `[sma] lease renewal failed — this attempt can be declared dead while it still runs: ${String((err && err.message) || err)}`,
        })
      })
    }
  }
  return {
    onLine,
    // THE TICK'S OWN VOICE IN THE TRANSCRIPT. Every verdict the gates reach after the process
    // is gone belongs in the SAME file the run's lines are in — a card, a post-mortem and the
    // person reading either one look in one place, not in the code that decided.
    appendLine: (line) => log.append({ line }),
    sessionOf: () => state.sessionId,
    // A SNAPSHOT, not the live sets: the layer is written after the process is gone, and a
    // reader must not be able to change what the stream observed.
    memoryOf: () => ({
      index: memory.index,
      reads: [...memory.reads],
      autoMemoryReads: [...memory.autoMemoryReads],
      loadCalls: memory.loadCalls,
      // WHAT WAS ASKED FOR AND DID NOT COME BACK. An absent list and a list of failures are
      // different answers to «did the worker read the memory», and the second one is the one
      // that explains an attempt that behaved as if the corpus were empty.
      failed: memory.failed.map((f) => ({ ...f })),
    }),
    // Null when the session never opened one: an absent init is «we did not see it», which is
    // not the same statement as «the layer was empty», and the row must not confuse the two.
    initOf: () => (state.init ? { ...state.init, initHooks: hookStarts } : null),
    // The whole opening frame, for the attempt's run directory (see the init branch above).
    runInitOf: () => (state.runInit ? { ...state.runInit } : null),
    // Hooks and refusals, in the order the stream produced them. A snapshot, like the memory
    // trace: a reader must not be able to change what was observed.
    guardsOf: () => guards.map((g) => ({ ...g })),
    // How many tool calls the vendor's own result frame counted as refused; null when it said
    // nothing, which is not the same claim as zero.
    permissionDenialsOf: () => state.permissionDenials,
    // WHERE THIS ATTEMPT'S TRANSCRIPT LIVES. The run directory references it instead of
    // copying it, and only the writer knows the path it chose.
    logFileOf: () => (log && typeof log.file === 'string' ? log.file : null),
  }
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
 * poolFor(deps, task) → the worker pool as the ROUTER should see it for THIS task.
 *
 * For ordinary work that is the configured pool, untouched. For a piece of a batch it is the
 * same pool with the assembly's OWN worker offered first: the owner's rule is «one worker, one
 * piece at a time», and the piece that follows belongs to whoever ran the piece before it —
 * otherwise every piece of one request would be a fresh session in a different account, and
 * what the previous piece learned would be paid for again.
 *
 * A PREFERENCE, NOT A LOCK, and the difference is stated rather than implied: the router still
 * decides, so a pinned worker whose window is spent, or one that was switched off since, is
 * simply not among the candidates and the assembly continues with whoever can run it. Holding
 * the batch for an unavailable account would be a stall nobody asked for — and the tick says so
 * in its own log rather than letting the change happen silently.
 *
 * Fail-open at every step: no adapter list, a throw, or nothing to prefer, and the pool comes
 * back exactly as configured.
 */
async function poolFor(deps, task) {
  const workers = (deps.config && deps.config.workers) || []
  if (!task || typeof task.batchId !== 'string' || task.batchId === '') return workers
  let pinned = null
  try {
    pinned = batchWorkerOf(await deps.adapter.list({}), task.batchId, task.id)
  } catch (err) {
    writeLog(deps, { type: 'batch.pin_unreadable', taskId: task.id, error: String((err && err.message) || err) })
    return workers
  }
  if (!pinned || !workers.some((w) => w && w.id === pinned)) return workers
  return [...workers.filter((w) => w && w.id === pinned), ...workers.filter((w) => !w || w.id !== pinned)]
}

/**
 * ЧТО СКАЗАНО ПРО ЖИВУЮ ЗАДАЧУ ОСТАНОВЛЕННОЙ ВОЛНЫ — one sentence, in one place, so the words
 * a worker reads do not depend on which tick told him.
 *
 * The tone is the founder's own: finish the step you are on and stand. Nothing is killed, the
 * session is not torn, and the note says so out loud — because a correction that reads like a
 * cancellation gets acted on like one.
 */
export function waveParkNote(phase, wave) {
  return (
    `Владелец остановил волну ${wave} фазы ${phase}. Доведите ТЕКУЩИЙ шаг до конца и остановитесь: ` +
    'не начинайте следующий, ничего не откатывайте, сессию не закрывайте. Незакрытые шаги ' +
    'останутся за вами — когда останов снимут, продолжите с того же места.'
  )
}

/**
 * parkStoppedWaves(deps, holds) — ask the LIVE tasks of a stopped echelon to finish their step
 * and stand. Returns the ids told this pass.
 *
 * WHY A CORRECTION AND NOT A KILL. The order is «доведут текущий шаг и встанут», and every word
 * of that is a refusal to touch the process: an interrupted session loses the step it was in the
 * middle of, and the founder would resume work that has to be redone. So the live half of a stop
 * travels down the channel he ALREADY has for steering running work — the same one his own «нет,
 * не так» takes — in its «после хода» mode. No second channel is opened, and `redirects.mjs` is
 * not edited by this plan at all.
 *
 * WHY THE TELLING IS WRITTEN DOWN. This runs every few seconds for as long as the stop stands.
 * Without a record of who has already been told, one order would arrive as a dozen identical
 * corrections a minute — noise the worker would learn to ignore, on the one channel that must
 * never be ignored.
 *
 * FAIL-OPEN throughout: a register that cannot be read or written costs this pass its parking,
 * never the tick.
 */
async function parkStoppedWaves(deps, holds) {
  const dataDir = deps.config && deps.config.dataDir
  if (!dataDir || !holds.length) return []
  let rows
  try {
    rows = await deps.adapter.list({})
  } catch (err) {
    writeLog(deps, { type: 'wave.rows_unreadable', error: String((err && err.message) || err) })
    return []
  }
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const told = []
  for (const hold of holds) {
    const live = rows.filter((r) => {
      if (!r || r.status !== 'claimed') return false
      const addr = waveAddressOf(r)
      return !!addr && addr.phase === hold.phase && addr.wave === hold.wave
    })
    if (live.length === 0) continue
    let parked
    try {
      parked = readWaveParked({ dataDir, phase: hold.phase, wave: hold.wave, fsImpl: deps.fsImpl })
    } catch (err) {
      writeLog(deps, { type: 'wave.register_unreadable', error: String((err && err.message) || err) })
      continue
    }
    const fresh = live.filter((r) => !parked.includes(r.id))
    if (fresh.length === 0) continue
    const delivered = []
    for (const r of fresh) {
      const wrote = appendRedirect({
        dataDir,
        taskId: r.id,
        text: waveParkNote(hold.phase, hold.wave),
        mode: 'queue', // «после хода»: the step in flight is finished, never interrupted
        clock,
        fsImpl: deps.fsImpl,
      })
      if (wrote && wrote.ok) delivered.push(r.id)
    }
    if (delivered.length === 0) continue
    try {
      markWaveParked({ dataDir, phase: hold.phase, wave: hold.wave, taskIds: delivered, clock, fsImpl: deps.fsImpl })
    } catch (err) {
      writeLog(deps, { type: 'wave.park_not_recorded', error: String((err && err.message) || err) })
    }
    for (const id of delivered) {
      writeLog(deps, { type: 'wave.parked', taskId: id, phase: hold.phase, wave: hold.wave })
      told.push(id)
    }
  }
  return told
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
 * steeredSpawn(deps, taskId, spawnWorker) → a spawnWorker that leaves a KILL-HANDLE behind.
 *
 * ── THE STEERING WHEEL, IN ONE PLACE ──
 * Every spawn of an attempt registers its handle under the TASK id, so the redirect door can
 * end the live child («Перебить сейчас») and the correction rides the continuation. It is one
 * function rather than one expression per lane because it was written inline for code work and
 * simply never reached the forge lane: a founder watching a «Создатель» burn a subscription had
 * no way to stop it, and the door answered as though it had. Hint plumbing by construction —
 * a daemon assembled without `attemptTurns`, or a child that cannot be killed, spawns exactly
 * as before.
 */
function steeredSpawn(deps, taskId, spawnWorker) {
  return (o) => {
    const h = spawnWorker(o)
    if (deps.attemptTurns && h && typeof h.kill === 'function') {
      deps.attemptTurns.register(taskId, () => {
        try {
          h.kill()
        } catch {
          /* a child that cannot be killed is still a turn the founder ended */
        }
      })
    }
    return h
  }
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
 * AND WHEN THAT LINE NEVER CAME. A killed process does not deliver a final frame; neither does
 * a provider that cut the connection mid-turn. This function used to walk the stream backwards,
 * find nothing, and RETURN SILENTLY — no row at all. That silence is not neutral: a person
 * reading the book finds no line for that attempt and reads it as «this one cost nothing», when
 * it is precisely the attempt that burned a window and produced nothing to show for it. The
 * live proof, taken off this machine: 89 usage rows in the whole history and every single one
 * of them read off a final frame — not one estimate ever written, because there was nothing to
 * write it with. So a stream with no final frame now books a TIME-BASED ESTIMATE, labelled
 * `source: 'estimate'` — a coarse figure called an estimate is a record; the same figure called
 * a measurement would be a lie, which is why the label is not optional.
 *
 * The estimate's own guard is untouched: without two believable ends the duration falls to its
 * floor rather than inventing a length (the fifty-six-years incident lives in usage.mjs).
 *
 * WHICH ATTEMPT: the row names it, so «every attempt of mine has a line» is a join and not a
 * belief. WHICH PROVIDER: taken from the route — the estimate no longer declares one of its own.
 *
 * Never fatal. The price of an attempt is bookkeeping; an attempt that did its work must not be
 * failed because the book could not be written.
 */
function bookAttemptUsage(deps, task, route, streamLines, now, startedAt) {
  if (typeof deps.bookUsage !== 'function') return
  try {
    const workers = Array.isArray(deps.config && deps.config.workers) ? deps.config.workers : []
    const worker = route && route.workerId ? workers.find((w) => w && w.id === route.workerId) : null
    // WHICH MONEY THIS IS travels from the routing verdict to the book. A paid-channel
    // attempt has NO workerId (that is what the fallback is), so without the explicit
    // account below its row landed under «unknown» — invisible to the budget reader that
    // sums the api account, so the cap could never fill. And without the channel field the
    // row's cost summed into «платный канал сегодня» even when the plan absorbed it
    // (QA D4, 11.08.2026).
    const paid = Boolean(route && route.useApiFallback)
    const apiAccountName = (deps.config && deps.config.budget && deps.config.budget.apiAccountName) || 'api'
    const ctx = {
      accountName: paid
        ? apiAccountName
        : (worker && worker.account && worker.account.name) || (route && route.workerId) || null,
      taskId: task.id,
      // WHICH ATTEMPT OF THAT TASK. Without it the book answers «this task spent something»,
      // and the question a person actually has — «did the attempt I am looking at leave a
      // line» — has no answer at all.
      attempt: task.attempt,
      // WHICH VENDOR, from the routing verdict rather than declared by the estimate itself: a
      // killed session of the other provider used to have been booked under a name that was
      // never its own.
      provider: (route && route.provider) || undefined,
      model: (route && route.model) || undefined,
      channel: paid ? 'api' : 'subscription',
    }
    const isCodex = String((route && route.provider) || '') === 'codex'
    for (let i = streamLines.length - 1; i >= 0; i -= 1) {
      const line = streamLines[i]
      if (isCodex) {
        const event = parseCodexEvent(line)
        if (!event || event.type !== 'turn.completed') continue
        deps.bookUsage(codexUsageFromFinal(event, { ...ctx, startedAt, endedAt: now }))
        return
      }
      const event = parseClaudeEvent(line)
      if (!event || event.type !== 'result') continue
      deps.bookUsage(claudeUsageFromResult(event, ctx))
      return
    }
    // NO FINAL FRAME IN THE STREAM — see the header. The attempt still ran and still spent; the
    // book gets a line that says so and says, honestly, that it is an estimate.
    deps.bookUsage(estimateUsage({ ...ctx, startedAt, endedAt: now }))
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

/** Fresh-derive the aging signal every tick — nothing stored except «уже сказали». */
async function deriveAging(deps, now) {
  const { adapter, config, report, journal, agingMemory } = deps
  const agingMs = (config.agingHours ?? 24) * HOUR_MS
  let queued = []
  try {
    queued = await adapter.list({ status: 'queued' })
  } catch {
    return // a list failure never wedges the tick (fail-open)
  }
  // Trim FIRST, over every waiting task — including the ones not old enough to speak about:
  // the memory must describe the queue as it is now, not as it was when something was said.
  const memory = agingMemory && typeof agingMemory.shouldSay === 'function' ? agingMemory : null
  if (memory && typeof memory.keepOnly === 'function') memory.keepOnly(queued.map((r) => r.id))
  for (const row of queued) {
    const enq = toEpochMs(row.enqueuedAt)
    if (!Number.isFinite(enq)) continue
    const ageMs = now - enq
    if (ageMs < agingMs) continue
    // NO MEMORY IN deps → THE OLD BEHAVIOUR, exactly. A daemon assembled without this
    // collaborator keeps saying it every tick rather than falling silent: a missing seam must
    // never be able to turn a signal off.
    if (memory && !memory.shouldSay(row.id, now)) continue
    const queuedForHours = Math.floor(ageMs / HOUR_MS)
    if (typeof journal === 'function') journal({ type: 'task.aging', taskId: row.id, queuedForHours })
    if (typeof report === 'function') {
      // BOTH exits are throttled by the same decision. Throttling only the journal would leave
      // the webhook screaming; and the screen does not depend on either — `agedForHours` is
      // computed from `enqueuedAt` at every read, so «застряла» stays true while the signal
      // stays quiet.
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
      // AND THE SAME LOG SEAM the line below already writes its own error into: the sweep
      // declares attempts dead and reissues their tasks, and did it in total silence — a
      // whole day of the operator log has nothing about it but the consequences. It is
      // handed the journal rather than reaching for one: a sweep whose work depended on a
      // log being available would be a sweep that stops when the log does.
      result.sweep = await livenessSweep({ adapter, ledger, clock, expireMs: resolveExpireMs(config), journal })
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

    // (1c) THE COPIES OF CLOSED TASKS. Beside the two sweeps above and for the same reason:
    // durable leftovers nobody else audits. The approval door removes the copy of work that
    // was ACCEPTED; everything else — failed, returned, abandoned — is left standing because
    // the queue, not this tick, decides whether a retry is coming, and a copy removed under a
    // retry costs the retry its ready environment. So this pass takes only what has been
    // closed for a day. Fail-open exactly like the two above: an unreadable list of worktrees
    // costs a directory, while a tick that dies on it costs every task it was about to hand
    // out. The sweeper keeps its own once-a-day clock — the tick may call it every five
    // seconds and it will answer «skipped» until the day is up.
    if (typeof deps.sweepWorktrees === 'function') {
      try {
        result.worktreeSweep = await deps.sweepWorktrees({ now: now() })
      } catch (err) {
        if (typeof journal === 'function') journal({ type: 'worktree-sweep-error', error: String((err && err.message) || err) })
      }
    }

    // (2) intake per cadence (secondary path; roster button is primary — Q2).
    await runIntake(deps, now(), result)

    // (2b) aging signal — derived fresh, nothing stored (runs whether or not we claim).
    await deriveAging(deps, now())

    // (2c) WHICH ECHELONS THEIR OWNER STOPPED — read from the register, never remembered by
    // this process: a stop is a word somebody said, and a restart must find it exactly where he
    // left it. Read once and used for BOTH halves of the order below: the waiting rows are not
    // handed out, and the live ones are asked to finish their step and stand. Fail-open — an
    // unreadable register means «nothing is stopped», which is the reading that keeps the
    // machine moving rather than the one that silently freezes it.
    let holds = []
    if (config.dataDir) {
      try {
        holds = readWaveHolds({ dataDir: config.dataDir, fsImpl: deps.fsImpl })
      } catch (err) {
        if (typeof journal === 'function') journal({ type: 'wave-holds-error', error: String((err && err.message) || err) })
      }
    }
    if (holds.length > 0) {
      const parked = await parkStoppedWaves(deps, holds)
      if (parked.length > 0) result.parked = parked
      result.waveHolds = holds.map((h) => `${h.phase}/${h.wave}`)
    }

    // (3) claim — eligible lanes FIRST, then a lane-restricted claim.
    const lanes = eligibleLanes(deps)
    if (lanes.length === 0) {
      result.idle = true
      return result
    }
    const workerId = 'daemon' // the claim is against durable state; identity is the ledger's job
    // THE STOP TRAVELS INTO THE CLAIM ITSELF, not around it. Filtering after the checkout would
    // be too late in the durable queue — there the fetch IS the claim, and a row recognised as
    // stopped afterwards has already been handed out (the same reason the batch turn is decided
    // inside the queue). So the orders go in with the lanes, and both backends keep the promise.
    const task = await adapter.claimNext(workerId, { lanes, holds })
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
    /**
     * THE COPY THIS ATTEMPT RAN IN, as one object: `{base, branch, worktreePath,
     * materialized, provisionMs}` — the point of return, and what was put into the copy to
     * make it usable. Declared OUT HERE, above the per-task try, for one reason: the row it
     * feeds must reach a failure recorded by the catch below just as surely as one recorded
     * on the happy path. Stays null for a documentary stage and for any refusal that came
     * before a copy existed, and a null one simply writes none of the keys.
     */
    let worktreeRow = null

    /**
     * ЧЕМ ЗАПЛАТИЛА ПОПЫТКА, ЕСЛИ ТИК УМРЁТ РАНЬШЕ, ЧЕМ УСПЕЕТ ЭТО ЗАПИСАТЬ.
     *
     * The per-task catch below turns any throw into an honest `runtime_offline` — and used to
     * walk straight past the book on the way there. A process had been spawned, a window had
     * been spent, and the ledger said nothing about it, because the one call that books the
     * cost sits AFTER the point most of those throws come from. So the debt is armed here, the
     * moment a child exists, and disarmed the moment it is paid: the catch pays it if it is
     * still outstanding, which is exactly once, never twice.
     */
    let unbookedSpend = null

    // From here a per-task failure is honest, never a wedge (fail-open).
    try {
      // The router writes its OWN dispatcher layer at the decision — the tick
      // only hands it the sink; it never narrates the routing reason on the router's behalf.
      const route = deps.routing.resolveRoute(task, {
        // The pool, with this assembly's own worker offered first (poolFor) — for a task with
        // no batch this IS config.workers.
        workers: await poolFor(deps, task),
        windows: deps.windows,
        clock,
        config,
        decisionJournal: deps.decisionJournal,
        // …and the counter that hears about a decision the journal could NOT sign. It travels
        // beside the sink for the same reason: the tick does not narrate on the router's
        // behalf, it only hands it the places to speak.
        unknownReasonSink: deps.unknownReasonSink,
        // The money rule travels with the route decision — the dispatcher is the only place
        // that knows both «no seat anywhere» and «this task asked for the paid channel».
        budget: deps.budget,
      })
      if (!route || (!route.workerId && !route.useApiFallback)) {
        // Claimed but no runnable target after the real route — degrade honestly, AND IN THE
        // ROUTER'S OWN WORD. This line used to write «window_exhausted» over every such
        // decision no matter what actually stopped the task, while `route.reasonCode` lay
        // right here carrying the truth: a person stopped by a spending ceiling he set was
        // sent to wait for a window that would never open for him.
        //
        // THE WORD IS CHECKED AGAINST THE CLOSED TAXONOMY BEFORE IT IS USED. `fail()` throws
        // on a reason it does not carry, so an unvetted code would turn a routing decision
        // into a dead tick — the exact fail-closed trade this work exists to refuse. The
        // fallback below is not defensive habit either: `!route` is the rare race that has NO
        // reasonCode at all, and it still has to be failed by some honest name.
        const routeReason =
          route && typeof route.reasonCode === 'string' && FAIL_REASONS.includes(route.reasonCode) ? route.reasonCode : 'window_exhausted'
        await failTask(deps, task, { reason: routeReason, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: routeReason }
        return result
      }

      // (3) WHO IS RUNNING THIS — written down the moment it is known. The checkout above
      // claims as the daemon, because WHICH worker runs the task is this line's decision,
      // not the queue's. Until it is recorded, every screen that answers «who is busy»
      // matches claimed rows against configured workers and finds nothing: on 12.08.2026
      // the board showed an empty queue and an idle worker THROUGHOUT a running attempt.
      // Fail-open and optional by design — an adapter without the seam (or a write that
      // fails) must never cost an attempt that is otherwise ready to run.
      if (route.workerId && typeof deps.adapter.assignWorker === 'function') {
        try {
          await deps.adapter.assignWorker(task.id, route.workerId)
        } catch (err) {
          writeLog(deps, { type: 'task.assign_failed', taskId: task.id, workerId: route.workerId, error: String((err && err.message) || err) })
        }
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
      // SKIPPED for a documentary stage: preflight answers «does the work this task describes
      // already exist in the tree», and a stage of the phase cycle is not that question —
      // asking would be a verb inventing an answer about something it was never given.
      // The door now asks about EVERY plan of the task's phase, with the plan's path, for a
      // machine answer, in the connected project's tree — see askAlreadyBuilt for why each of
      // those four words is load-bearing. Work carrying no phase never reaches the verb, and
      // the log says so.
      const doorDir = (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir
      const alreadyBuilt = isDocument ? false : await askAlreadyBuilt(deps, verbRunner, task, doorDir)
      if (alreadyBuilt) {
        // The receipt this completion stands on. Its shape is CONSTANT — the verb reports no
        // receipt of its own, and the screen already reads this exact form to show a task that
        // was finished by the door rather than by a worker.
        const receiptRef = `preflight:${task.id}`
        // NO transition is minted for this completion, on purpose. The work already existed;
        // no worker process was ever started, so the task never entered RUNNING and there is
        // no CLAIMED -> PRODUCED contract to name. Minting the two-step CLAIMED -> RUNNING ->
        // PRODUCED would assert `worker_process_started`, an external effect that did not
        // happen — the exact fabrication the stamp exists to prevent.
        await completeTask(deps, task, { receiptRef, branch: null, route, now: now(), envelope })
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
      /** The commit the worktree was cut from — the point any of this can be undone to. */
      let worktreeBase = null
      /**
       * The tree's own divergences BEFORE this attempt — a Set of record identities, or null
       * when no such picture could be taken. Null is not «none»: it is «unknown», and the gate
       * says so out loud instead of quietly treating an unknown as a clean slate.
       */
      let preexistingRed = null
      if (!isDocument) {
        branch = `wt/${task.id}`
        // `--json` is not decoration. Without it the verb prints prose for a person —
        // «SMA worktree: создано -> …» — and parseVerbResult, which looks for the last line
        // that is a JSON object, finds nothing at all. Asked properly, the verb answers
        // {ok, path, branch, reused}: `path` is the directory it actually made, and it is not
        // the directory this code used to guess.
        // WHICH REPOSITORY DOES THE WORK HAPPEN IN? The one the SCREEN says is connected —
        // not the directory the daemon happened to be launched from. `config.repoDir` is
        // literally the launch cwd, so provisioning against it meant every task ran in that
        // one tree no matter which project the founder had selected: on 12.08.2026 tasks
        // aimed at the product were carried out in the sibling workspace, where the product's
        // files do not exist and the exit gate is red for unrelated historical reasons. The
        // worker found nothing to do and the gate failed it — twice, on two different tasks,
        // for a reason no screen could show. Falls back to the launch dir only when no
        // project is connected at all. The already-built door above resolved this very
        // directory to put its question in; reusing the value rather than re-deriving it is
        // what keeps the pair from ever drifting apart.
        const provisionDir = doorDir
        // HOW LONG THE COPY TOOK TO PREPARE, measured HERE rather than read off the answer:
        // the verb reports its own inside time, and what a person asks about is the wait the
        // task actually paid — process start, argument parsing and all. It is also the only
        // number available when an older install answers without one at all.
        const provisionStartedAt = Date.now()
        const wt = await invokeVerb(verbRunner, 'worktree', ['provision', '--branch', branch, '--json'], provisionDir)
        const provisionMs = Date.now() - provisionStartedAt
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
        // THE POINT TO ROLL BACK TO, written down before a single line is spawned.
        // The isolation itself was always real — a worker only ever writes into its own
        // worktree on its own branch — but «can be rolled back» and «you can SEE what to
        // roll back to» are different things, and only the first was true until now: the
        // attempt row carried hashes and a session id, never the commit the work started
        // from. Journalled for every attempt, failed ones included, because the attempt a
        // person wants to undo is precisely the one that went wrong.
        // EXPECTED FIRST, and that order is the whole point: `expectedBase` is where the
        // project's own branch stood when this worktree was cut, while `actualBase` on a
        // REUSED worktree is the tip of the task branch — which already carries the previous
        // attempt's commit. Counting from the latter made a second attempt see zero new work
        // and discard a finished, committed fix (12.08.2026: attempt 1 committed without a
        // note, attempt 2 wrote the note and was told it had produced nothing).
        worktreeBase = wt.expectedBase || wt.actualBase || null
        // A REUSED WORKTREE ANSWERS NO BASE AT ALL — measured 12.08.2026, in the journal line
        // right below: `base=нет reused=true expected=нет actual=нет`. The first attempt of a
        // task therefore had a base and its work was accepted, while every RETRY lost the one
        // number the gate needs and threw away a commit that was sitting right there. When the
        // verb declines to say, ask the project's own tree where it stands — that is exactly
        // what `expectedBase` means on the first pass, so a retry reads the same point.
        if (!worktreeBase && typeof deps.execGit === 'function') {
          try {
            worktreeBase = String(deps.execGit(['rev-parse', 'HEAD'], { cwd: provisionDir }) || '').trim() || null
          } catch {
            /* fail-open: no base means the receiptless path simply cannot certify — never a crash */
          }
        }
        // The line a person reads only ever carries type/task/worker/reason/detail, so the
        // VALUES go into `detail` — a base recorded under a key the formatter drops is a
        // record nobody can read, which is how the 12.08 gate stayed unexplainable.
        writeLog(deps, {
          type: 'task.worktree_base',
          taskId: task.id,
          branch,
          base: worktreeBase,
          baseFixed: wt.baseFixed === true,
          path: wt.path,
          detail: `base=${worktreeBase || 'нет'} reused=${wt.reused === true} expected=${wt.expectedBase || 'нет'} actual=${wt.actualBase || 'нет'} провизия=${provisionMs}мс`,
        })
        // ── WHAT WAS PUT INTO THE COPY, straight from the verb that put it there ──
        // One entry per manifest item: copied, linked, already tracked, or skipped as a
        // secret. `Array.isArray` and nothing else — the answer comes from the PROJECT's own
        // CLI, so it is data to be checked, never a shape to be trusted; anything that is not
        // a list becomes an absence rather than a row nobody can read.
        const materialized = Array.isArray(wt.materialized) ? wt.materialized : undefined
        if (materialized === undefined) {
          // An install whose CLI predates the materializing verb answers no list at all. That
          // is not a failure — the copy still exists and the attempt still runs — but it must
          // be SAID, because an empty spot on a card otherwise reads as «nothing was put in».
          writeLog(deps, {
            type: 'task.worktree_materialized_missing',
            taskId: task.id,
            branch,
            detail: 'верб провизии не сообщил список материализованного — старая установка CLI проекта или ошибка манифеста',
          })
        }
        // The copy, as ONE object handed to whichever door closes this attempt. Assembled
        // once, here, so the finished and the failed paths can never come to disagree about
        // where the work was and what it can be rolled back to.
        worktreeRow = copyRow({ wt, base: worktreeBase, branch, worktreePath: workDir, materialized, provisionMs })
        // ── WHAT WAS ALREADY BROKEN BEFORE ANYONE TOUCHED ANYTHING ──
        // The exit gate below used to read the ABSOLUTE answer of the re-verification: any
        // divergence in the tree failed the attempt. In a repository with a history that is
        // the permanent state — recipes written for work finished long ago have drifted from
        // the tree, and that is nobody's fault today. So every attempt that produced COMMITS
        // was failed for those old divergences, while an attempt that only wrote an answer
        // passed the gate one door earlier: the machine buried code and let talk through.
        // Measured 13.08.2026 — three attempts, three reds, on work that was correct.
        //
        // This is the BEFORE picture, taken in the very worktree the worker is about to be
        // spawned into and before the spawn, so the gate can charge the attempt with the
        // DIFFERENCE instead of the total. It costs a second run of the verb per code
        // attempt; the alternative was a gate whose verdict said nothing about the work.
        //
        // AND THE PICTURE HAS TO BE OF THIS TREE. `cwd` alone was not enough and quietly
        // was not: the verb derives the root of its recipe walk from the shared `.git`,
        // which from inside a linked working copy leads back to the MAIN checkout. Both
        // snapshots therefore described a tree nobody was working in, their difference was
        // empty by construction, and «новых=0» meant «there was nothing to compare», not
        // «the worker broke nothing». Measured 14.08.2026: a copy carrying a knowingly
        // divergent receipt still walked through the gate green. So the tree is NAMED in
        // the arguments — the same lesson as the permission grant that was computed, hashed
        // into the row, and never handed to the process it was written for.
        preexistingRed = redRecordKeys(
          await invokeVerb(verbRunner, 'reverify', ['--branch', branch, '--tree', workDir, '--json'], workDir),
        )
      }

      // (5b) THE PERSONAL LAYER, PUT IN PLACE BEFORE THE PROCESS EXISTS.
      //
      // The account a worker runs under is not the founder’s: it has its own settings file, and
      // until that file is written the session starts without his instructions, without his hooks
      // and — the half nobody can see from outside — with whatever hosted connectors the vendor
      // decides to attach that minute. So the mirror runs HERE, BEFORE the arguments are
      // assembled: the builder reads that very file to check the profile, and a spec prepared
      // ahead of the mirror is refused by the parity guard. The order is the wire.
      //
      // AND A MIRROR THAT CANNOT BE WRITTEN IS A REFUSAL BY NAME. Spawning anyway is the one
      // option that must not exist: it spends the subscription on a session running under rules
      // nobody approved, and no card would ever be able to say so.
      let personalLayer = null
      if (typeof deps.mirrorPersonalLayer === 'function') {
        const routedWorker = (config.workers || []).find((w) => w && w.id === (route && route.workerId))
        try {
          personalLayer = await deps.mirrorPersonalLayer({
            accountDir: routedWorker && routedWorker.account && routedWorker.account.configDir,
            plugins: (routedWorker && routedWorker.plugins) || [],
            overrides: (routedWorker && routedWorker.settingsOverrides) || {},
          })
        } catch (err) {
          const layerDetail = String((err && err.message) || err)
          writeLog(deps, { type: 'task.refused', taskId: task.id, reason: 'personal_layer_error', detail: layerDetail })
          await failTask(deps, task, { reason: 'personal_layer_error', branch, route, now: now(), envelope, from: fleetState, worktree: worktreeRow })
          result.failed = { taskId: task.id, reason: 'personal_layer_error', detail: layerDetail }
          return result
        }
      }
      // (5c) OUR SERVERS, AND ONLY OURS. The file is written per attempt and its PATH is all
      // that travels: it names the servers a person enabled in the registry on this host and
      // nothing else. Written even when the registry is empty — a deterministic argument array
      // is what turns «the worker had exactly these servers» into a claim somebody can check a
      // week later, and an empty file says that plainly where a missing flag says nothing.
      const spawnDataDir = deps.dataDir || config.dataDir
      let mcpConfig = null
      if (spawnDataDir) {
        try {
          const registry = typeof deps.loadMcpRegistry === 'function' ? deps.loadMcpRegistry() : { servers: [] }
          const registered = Array.isArray(registry && registry.servers) ? registry.servers : []
          const mcpConfigPath = buildMcpConfigFile({
            servers: registered,
            taskDir: join(spawnDataDir, 'mcp', `${task.id}-${task.attempt}`),
            fsImpl: deps.fsImpl,
          })
          mcpConfig = { path: mcpConfigPath, servers: registered.filter((x) => x && x.enabled === true).map((x) => x.id) }
        } catch (err) {
          // FAIL-OPEN, AND OUT LOUD. A registry that cannot be read must not cost the attempt:
          // the session simply starts with none of our servers, and the miss is on the record
          // instead of being a silence somebody discovers inside a transcript.
          writeLog(deps, { type: 'task.mcp_config_error', taskId: task.id, error: String((err && err.message) || err) })
        }
      }
      if (personalLayer || mcpConfig) {
        // A DOCUMENTARY stage runs in no copy at all, so the row object may not exist yet.
        // These two facts are about the SESSION rather than about a worktree, and they are
        // owed by every lane that starts a process.
        worktreeRow = worktreeRow || {}
        if (personalLayer) worktreeRow.personalLayer = personalLayer
        if (mcpConfig) worktreeRow.mcpConfig = mcpConfig
      }

      // (6) spawn the routed worker; log + touch (throttled) on every stream line.
      // The envelope decides what this lane may touch; here is where that decision finally
      // reaches the process that has to obey it. Before this, the grant was hashed into the
      // attempt row and thrown away — every worker spawned read-only.
      //
      // BOTH HALVES OF THE ENVELOPE COME FROM ONE FUNCTION. What it granted and what it
      // REFUSED are assembled by `envelopeSpawnOptions` here and at the other spawn point
      // below, and by nothing else. Two field lists kept equal by discipline is exactly how
      // this codebase once handed the grant to one lane and withheld it from the other; one
      // function makes that divergence impossible instead of unlikely, and the suite calls
      // both points with one envelope and compares the argument arrays they produce.
      const spec = buildArgs(task, route, {
        ...SPAWN_OPTIONS,
        ...(mcpConfig ? { mcpConfigPath: mcpConfig.path } : {}),
        ...envelopeSpawnOptions(envelope),
        // The attempt directory and the correction file, created and named BEFORE the process
        // exists — the parking gate inside the child reads both out of its environment.
        ...gateSpawnOptions(deps, config, task),
      })
      // WHAT THE ATTEMPT WAS GIVEN BEFORE IT SPOKE — the role file and the skills of the
      // routed worker. It is REMEMBERED here and written into the memory layer at the end,
      // together with what the session actually did: the declaration and the observation
      // belong in one row, and until now the declaration was the only thing that layer held.
      // IDS ONLY — the loaded role BODY never travels into the journal; the normalizer drops
      // anything that does not read as an identifier.
      let roleNotes = []
      // prepend the enabled agent's role/skills preamble (resolveWorkerContext) so
      // «включён» is real in the session. Optional + DI-guarded — skipped when not injected.
      if (typeof deps.resolveWorkerContext === 'function' && route && route.workerId) {
        const worker = (config.workers || []).find((w) => w && w.id === route.workerId)
        if (worker && (worker.roleFile || (Array.isArray(worker.skills) && worker.skills.length))) {
          const ctx = deps.resolveWorkerContext({ worker, repoDir: config.repoDir, fsImpl: deps.fsImpl })
          if (ctx && ctx.rolePreamble) spec.prompt = `${ctx.rolePreamble}\n\n${spec.prompt ?? ''}`
          roleNotes = [
            ...(worker.roleFile ? [worker.roleFile] : []),
            ...((ctx && ctx.skillsList) || worker.skills || []),
          ]
        }
      }
      // ── A RETURN CONTINUES THE SAME SESSION (phase «Двигатель», wave 4) ──
      // A task sent back with a comment used to start attempt N+1 from zero: a fresh
      // session that re-read the world and re-did the thinking the founder had already
      // paid for. The prior attempt's session id is on its ledger row, so the new attempt
      // RESUMES it — the correction lands in a head that still holds the context. Guarded
      // to re-queues only (attempt > 1): a fresh task always gets a fresh session (PF-4),
      // and a fresh session is also the safe default whenever the ledger cannot answer.
      if (spec.bin === CLAUDE_BIN && Number(task.attempt) > 1 && deps.ledger && typeof deps.ledger.readAttempts === 'function') {
        try {
          const prior = deps.ledger.readAttempts(task.id) || []
          for (let i = prior.length - 1; i >= 0; i -= 1) {
            const sid = prior[i] && prior[i].sessionId
            if (typeof sid === 'string' && /^[0-9a-f-]{32,40}$/i.test(sid)) {
              spec.args = [...spec.args, '--resume', sid]
              writeLog(deps, { type: 'task.session_resumed', taskId: task.id, attempt: task.attempt })
              break
            }
          }
        } catch {
          /* an unreadable ledger means a fresh session — never a wedged attempt */
        }
      }

      const streamLines = []
      const { onLine, sessionOf, initOf, appendLine, memoryOf, guardsOf, runInitOf, permissionDenialsOf, logFileOf } = attemptStream(
        deps,
        task,
        streamLines,
        now,
        { accountName: spec.accountName, dataDir: config.dataDir },
        // WHICH TREE AND WHICH ACCOUNT this attempt's memory reads are measured against. Both
        // are named rather than guessed: a corpus path recognised by its shape alone would
        // count another tree's notes as this attempt's, and the account's own auto-memory
        // would be filed as the project's.
        { workDir, accountDir: spec.env && spec.env.CLAUDE_CONFIG_DIR },
      )
      // ── THE STEERING WHEEL (phase «Двигатель», recon 11.08) ──
      // Every spawn of this attempt registers its kill-handle under the TASK id, so the
      // redirect door can end the live child («Перебить сейчас») and the correction then
      // rides the continuation below. Hint plumbing: a restart loses only the ability to
      // kill children that died with it. The forge lane rides the SAME helper.
      const spawnSteered = steeredSpawn(deps, task.id, spawnWorker)
      // A worker process is about to exist: from this line the task is RUNNING, and every
      // transition minted afterwards says so — including the one the fail-open catch mints.
      fleetState = 'RUNNING'
      // WHEN THIS ATTEMPT STARTED. The fallback that keeps subscription work from booking $0
      // estimates from a DURATION, and nothing passed it a beginning: it received an epoch
      // timestamp as the end and zero as the start, so a session that ran two minutes booked
      // fifty-six years of tokens. One number, captured where the process really begins.
      const attemptStartedAt = now()
      // FROM HERE THE ATTEMPT OWES THE BOOK A LINE (see `unbookedSpend` above): a child is
      // about to exist, so everything after this point that throws must not take the cost of
      // it with them.
      unbookedSpend = () => bookAttemptUsage(deps, task, route, streamLines, now(), attemptStartedAt)

      // ── A WORKER WITH NO LIVE CHANNEL HEARS THE WORD IN THE TASK ITSELF ──
      // The third-party lane has neither of the two roads a correction normally takes. Our
      // gate does not run inside its child, so nothing can hand it a word mid-turn; and the
      // continuation below cannot resume it either — the stream parser DOES read that lane's
      // thread id off the wire, and the wire ENDS there: nothing carries it back into the
      // argument builder's resume option, so there is no session to return to. (Closing that
      // loop is a road recorded in the approach note, not this work.) Which leaves exactly one
      // truthful delivery for such a worker: the TEXT OF THE NEXT RUN. That is what makes
      // «убить и продолжить» a behaviour rather than a polite formula — the door kills now,
      // and the word rides the attempt that follows.
      //
      // ПОТРЕБЛЕНИЕ — В МОМЕНТ ДОСТАВКИ: задание прочитано СТАРТОВАВШИМ ПРОЦЕССОМ, а не в
      // момент сборки строки. Eating the lines while the text is being assembled and then
      // failing to start is the very defect the continuation loop below was rewritten to stop
      // committing, and making it here instead would be no better. `runSpawn` tells the two
      // fates apart BY CONSTRUCTION — `spawnError` is null for a child that ran and carries
      // the error for one that never existed — so the mark is set on the line right after it
      // returns and nowhere earlier. Whoever reads this next: do not move it up.
      //
      // The Claude lane is deliberately NOT fed this way: it already has a resume channel that
      // a live ledger proves works, and two channels on one lane deliver one word twice.
      let promptCarried = []
      if (config.dataDir && spec.bin !== CLAUDE_BIN) {
        promptCarried = readPendingRedirects({ dataDir: config.dataDir, taskId: task.id, fsImpl: deps.fsImpl })
        if (promptCarried.length) spec.prompt = `${spec.prompt ?? ''}\n\n${correctionsPreamble(promptCarried)}`
      }
      let exit = await runSpawn(spawnSteered, { bin: spec.bin, args: spec.args, cwd: workDir, env: spec.env, prompt: spec.prompt }, onLine)
      if (promptCarried.length && exit.spawnError === null) {
        markConsumed({ dataDir: config.dataDir, taskId: task.id, ids: promptCarried.map((p) => p.id), clock: now, fsImpl: deps.fsImpl })
        // WHICH ROAD THE WORD TOOK, said in the journal rather than inferred from silence.
        writeLog(deps, {
          type: 'task.redirected',
          taskId: task.id,
          mode: promptCarried[promptCarried.length - 1].mode,
          delivery: 'prompt',
        })
      }

      // ── THE CONTINUATION LOOP: a typed correction has a declared fate ──
      // «Перебить сейчас» killed the child (the door did); «После хода» let it finish; a word
      // meant for the LIVE turn that the turn never picked up (no tool call came after it) is
      // still pending and is collected here too — the three fates compose. Either way the
      // correction is HERE, durable, and the same session continues with it
      // (`--resume <sessionId>`) — what was done stays in context, nothing restarts from zero.
      //
      // ПОТРЕБЛЕНИЕ — В МОМЕНТ ДОСТАВКИ, И НИКОГДА РАНЬШЕ. This loop used to mark the lines
      // consumed and only then work out whether it had anything to deliver them WITH, so a
      // word for a lane with no resume channel, and a word that arrived past the hop cap, were
      // eaten in silence: written to disk first «чтобы перезапуск её не потерял», then
      // destroyed by the very code that promise was made about. The order is now: read →
      // is there a channel → deliver → and only after a delivery that happened, mark. An
      // undelivered line stays on disk, the skip is recorded WITH ITS REASON, and the word
      // rides the task's next run. Whoever reads this next: the mark cannot move back above
      // the check without restoring that defect.
      //
      // ENDABLE ALL THE SAME. Termination never rested on consumption — it rests on
      // REDIRECT_HOP_CAP, which counts every pass that spawned, delivered or not; the cap is
      // reached and the loop breaks even if a resume refuses to start five times running.
      //
      // ONE WORDING, THREE CARRIERS. The note is built by `correctionsPreamble` in the
      // corrections module, the same producer the gate inside the worker's child and the next
      // run's task text use. An agreement written down in three places is three agreements,
      // and the founder would be quoted differently depending on which road his sentence took.
      if (config.dataDir) {
        let hops = 0
        for (;;) {
          const pending = readPendingRedirects({ dataDir: config.dataDir, taskId: task.id, fsImpl: deps.fsImpl })
          if (!pending.length) break
          const sessionId = sessionOf()
          const resumable = spec.bin === CLAUDE_BIN && typeof sessionId === 'string' && /^[0-9a-f-]{32,40}$/i.test(sessionId)
          if (!resumable || hops >= REDIRECT_HOP_CAP) {
            writeLog(deps, {
              type: 'task.redirect_skipped',
              taskId: task.id,
              reason: hops >= REDIRECT_HOP_CAP ? 'hop_cap' : spec.bin !== CLAUDE_BIN ? 'provider' : 'no_session',
            })
            break
          }
          hops += 1
          writeLog(deps, { type: 'task.redirected', taskId: task.id, mode: pending[pending.length - 1].mode, hop: hops })
          exit = await runSpawn(
            spawnSteered,
            {
              bin: spec.bin,
              args: [...spec.args, '--resume', sessionId],
              cwd: workDir,
              env: spec.env,
              prompt: correctionsPreamble(pending),
            },
            onLine,
          )
          if (exit.spawnError === null) {
            markConsumed({ dataDir: config.dataDir, taskId: task.id, ids: pending.map((p) => p.id), clock: now, fsImpl: deps.fsImpl })
          }
        }
      }
      if (deps.attemptTurns) deps.attemptTurns.done(task.id)

      // WHAT THE SESSION ITSELF REPORTED joins what the mirror wrote, on ONE key. The mirror
      // says what was PUT INTO the account; the init frame says what the session actually
      // LOADED — and the gap between those two is precisely the class of defect this phase
      // exists to close. Merged rather than replaced: neither half alone answers the question.
      const sessionInit = initOf()
      if (sessionInit) {
        worktreeRow = worktreeRow || {}
        worktreeRow.personalLayer = { ...(worktreeRow.personalLayer || {}), ...sessionInit }
      }

      const marker = detectMarker(streamLines)
      // WHO ENDED THIS RUN — read off the CLI's own terminal frame, before anything judges
      // what the run left behind. A cut by the provider makes every such judgement a
      // statement about the outage rather than about the work.
      const providerAbort = providerAbortOf(streamLines)

      // (7a) WHAT IT COST — read off this attempt's own stream, before any gate decides its
      // fate. A refused attempt still spent the tokens, so the book is written for every
      // attempt and not only for the ones that end well.
      bookAttemptUsage(deps, task, route, streamLines, now(), attemptStartedAt)
      unbookedSpend = null // paid — the catch below must not pay it a second time

      // (7b) THE APPROACH NOTE — read off the same stream, appended as the journal's
      // approach layer, and then REQUIRED by the gate exactly as the receipt is required.
      // It is required of EVERY class of work: a parked round and a written document explain
      // themselves on the same terms a merged branch does.
      // ONE unwrapping for both marker families: the worker's closing words arrive inside a
      // frame, and a second pass over raw lines would find neither.
      const markerLines = markerLinesFrom(streamLines, ['APPROACH_', 'LESSON_'])
      const note = parseApproachNote(markerLines)
      const noteWritten = recordApproachNote(deps, task, note)

      // (7b-bis) THE LESSON — the third condition, checked against the copy's own corpus. A
      // parked round is exempt below (the session was cut short by a question to a person, so
      // there is nothing finished to draw a lesson from) and so is the forge lane, which has
      // its own markers and produces a draft rather than an attempt at work.
      const lessonEval = lessonCheck(deps, task, workDir, parseLessonMarker(markerLines))
      const lessonOk = lessonEval.ok === true
      // NEVER SILENT: the verdict rides the attempt's own transcript, so a red row can be
      // explained without opening this file.
      appendLine(
        lessonEval.written
          ? `[sma] lesson: written ${lessonEval.written}`
          : lessonEval.none
            ? `[sma] lesson: none ${lessonEval.none}`
            : `[sma] lesson: missing (${lessonEval.reason})`,
      )

      // (7b-ter) THE MEMORY LAYER OF THE JOURNAL — written HERE, for every attempt, before any
      // door below decides its fate. Placed at this one point on purpose: every exit of this
      // lane — parked, document, answer, code, green or red — passes through it exactly once,
      // so «слой памяти есть у каждой попытки» is a property of the control flow rather than a
      // rule somebody has to remember at four return statements. What it carries is what the
      // stream saw plus what the worker's own session wrote under its terminal identity in the
      // project's `.sma` — never what the configuration declared beforehand.
      writeMemoryLayer(deps, task, {
        memory: memoryOf(),
        sma: collectSmaTrace({
          projectDir: (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir,
          sessionId: sessionOf(),
          fsImpl: deps.fsImpl,
        }),
        lesson: lessonLayerOf(lessonEval),
        approachJournaled: noteWritten,
        notes: roleNotes,
      })

      // (7b-quater) THE ATTEMPT'S RUN DIRECTORY — written at the SAME single point, and for the
      // same reason. Everything in it existed already and nothing had ever been handed to the
      // thing that has to read it together: the command line, the envelope, the copy, the
      // hooks that answered, the memory that came back and the transcript in the ledger. The
      // receipt is added below by whichever door decides how this try ended.
      worktreeRow = worktreeRow || {}
      worktreeRow.run = writeAttemptRunDir(deps, task, {
        route,
        envelope,
        spec,
        worktree: worktreeRow,
        workDir,
        startedAt: attemptStartedAt,
        endedAt: now(),
        sessionId: sessionOf(),
        runInit: runInitOf(),
        memory: memoryOf(),
        sma: collectSmaTrace({
          projectDir: (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir,
          sessionId: sessionOf(),
          fsImpl: deps.fsImpl,
        }),
        guards: guardsOf(),
        permissionDenials: permissionDenialsOf(),
        ledgerPath: logFileOf(),
        exit,
        gate: isDocument ? 'document' : 'reverify',
        lesson: lessonLayerOf(lessonEval),
      })

      // An infra failure, a provider abort or a worker marker is the SHARPER signal and wins
      // over either gate below: a crashed attempt must not complete on a document that was
      // already there — and neither may an attempt the vendor cut off mid-word.
      const infraReason = exit.spawnError || providerAbort || marker
        ? classifyFailure({ spawnError: exit.spawnError, providerAbort, exitCode: exit.code, workerMarker: marker })
        : null
      // NEVER SILENT: an outage of the vendor's is a fact about the DAY, not about this task,
      // and the operator's log is where a person looks when three attempts died in a row.
      if (providerAbort) {
        writeLog(deps, {
          type: 'task.provider_abort',
          taskId: task.id,
          reason: 'provider_error',
          detail:
            `провайдер оборвал прогон (${providerAbort.reason}` +
            `${providerAbort.status ? ` ${providerAbort.status}` : ''})` +
            `${providerAbort.said ? `: ${providerAbort.said}` : ''}`,
        })
      }

      // (7a) A PARKED QUESTION IS A SUCCESSFUL ROUND — and it is asked BEFORE either gate.
      // A discussion round that stopped on a question, and an execute stage that reached a
      // blocking checkpoint, are the same event: the work went as far as it honestly could
      // and now owes a person a word. Failing it would throw away the position and start the
      // whole stage over on the next attempt; completing it on the checkpoint's own receipt
      // parks the row in `awaiting_approval`, where the screen renders it as a card.
      const parked = infraReason ? null : parkedRound(deps, task, workDir)

      if (parked || isDocument) {
        // WHICH DOOR DECIDED — recorded before it does, so the receipt of a parked round and
        // the receipt of a written document are not the same sentence with a different word.
        if (worktreeRow && worktreeRow.run) worktreeRow.run.gate = parked ? 'parked' : 'document'
        const gate = parked ?? (infraReason ? {} : documentGate(deps, task, workDir))
        // A WRITTEN DOCUMENT OWES A LESSON THE SAME WAY A MERGED BRANCH DOES — работа словами
        // учит ровно так же. A PARKED ROUND DOES NOT: it stopped mid-way on a question to a
        // person, and demanding a lesson from an unfinished round would throw away the whole
        // position over a step the worker never got to.
        const lessonReason = parked || lessonOk ? null : 'no_lesson'
        const reason =
          infraReason ?? (gate.receiptRef ? (noteWritten ? lessonReason : 'no_journal') : gate.reason)
        if (reason) {
          if (gate.detail) writeLog(deps, { type: 'task.refused', taskId: task.id, reason, detail: gate.detail })
          await failTask(deps, task, { reason, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
          result.failed = { taskId: task.id, reason, ...(gate.detail ? { detail: gate.detail } : {}) }
        } else {
          await completeTask(deps, task, { receiptRef: gate.receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
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
      // The base travels in: the SAME value already written into this attempt's journal line
      // and already read by the two gates below, so the three can never come to disagree about
      // the point this attempt started from.
      const answered = infraReason ? null : answerOnlyGate(deps, task, branch, workDir, noteWritten, worktreeBase)
      if (answered && worktreeRow && worktreeRow.run) worktreeRow.run.gate = 'answer'
      if (answered && !lessonOk) {
        // AN ANSWER OWES A LESSON TOO — and it is refused BY NAME here rather than left to
        // fall through to the code gate, which would call a finished answer «нет квитанции»
        // and send a person looking for a receipt nobody was ever going to write.
        writeLog(deps, { type: 'task.refused', taskId: task.id, reason: 'no_lesson', detail: lessonEval.reason })
        await failTask(deps, task, { reason: 'no_lesson', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
        result.failed = { taskId: task.id, reason: 'no_lesson' }
        return result
      }
      if (answered) {
        // NEVER SILENT: an outcome that skipped the code gate says so in the operator's log,
        // so «the worker answered» can never be mistaken for «the worker's code passed».
        writeLog(deps, { type: 'task.answered', taskId: task.id, receiptRef: answered.receiptRef })
        await completeTask(deps, task, { receiptRef: answered.receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
        result.completed = task.id
        return result
      }

      // (7) reverify GATE in the worktree — the ONLY door to completed for CODE work
      // (receipts or nothing). Unchanged: this is the original law, now one branch of two.
      // `--json` IS NOT DECORATION — the same lesson the worktree call above already carries,
      // learned twice in the same file. Without it the verb prints prose for a person and
      // parseVerbResult finds no object at all, so a clean reverify and a broken one arrive
      // identical: `{}`. Asked properly it answers {records, appended}, and «no recipes in
      // this tree» becomes a fact this code can read instead of a silence it must guess at.
      const rv = exit.spawnError
        ? { code: 1 }
        // `--tree` is the twin of the BEFORE picture's: a differential verdict is only worth
        // anything when both halves describe the SAME tree, and that tree is the copy.
        : await invokeVerb(verbRunner, 'reverify', ['--branch', branch, '--tree', workDir, '--json'], workDir)
      // ── THE AFTER PICTURE, AND THE ONLY QUESTION THAT MATTERS: WHAT IS NEW? ──
      // A differential verdict needs both pictures readable AND something to compare: a tree
      // with no recipes at all is the receiptless branch's territory below, untouched.
      const afterRed = exit.spawnError ? null : redRecordKeys(rv)
      const canDiff =
        preexistingRed !== null && afterRed !== null && !(Array.isArray(rv.records) && rv.records.length === 0)
      const newRed = canDiff ? afterRed.filter((k) => !preexistingRed.includes(k)) : []
      // NEVER SILENT — the same law the receiptless branch already obeys. Without this line
      // the only observable is «tests_red», identical for «the worker broke a recipe» and
      // «the tree was already red when he got there», and those are opposite facts.
      if (!exit.spawnError) {
        writeLog(deps, {
          type: 'task.gate_differential',
          taskId: task.id,
          detail: canDiff
            ? `красных до=${preexistingRed.length} красных после=${afterRed.length} новых=${newRed.length} → ${newRed.length > 0 ? 'красный (новое расхождение)' : 'зелёный (только исторические)'}`
            : `снимка ДО нет (${
                preexistingRed === null
                  ? 'перепроверка до попытки не назвала записей'
                  : afterRed === null
                    ? 'перепроверка после попытки не назвала записей'
                    : 'в дереве нет рецептов'
              }) — вердикт по абсолютному правилу`,
        })
      }

      let receipt = null
      if (rv.receiptRef) {
        receipt = { verdict: rv.verdict || (rv.code === 0 ? 'green' : 'red'), ref: rv.receiptRef }
      } else if (canDiff && rv.verdict !== 'red') {
        // THE DIFFERENTIAL VERDICT. Red is what appeared during the attempt — and only that.
        // The gate is not loosened by an inch: a divergence that was not there before is
        // still tests_red, and an attempt that produced no commits still certifies nothing.
        const commits = countCommitsOnBranch(deps, worktreeBase, workDir)
        if (newRed.length > 0) {
          receipt = { verdict: 'red', ref: null }
        } else if (commits > 0) {
          receipt = {
            verdict: 'green',
            ref: {
              // The same honesty the receiptless branch carries: nothing certified itself.
              // The recipes that were red stayed red, and the card says so in numbers.
              unverified: preexistingRed.length > 0,
              reason: preexistingRed.length > 0 ? 'preexisting_red_only' : 'no_new_red',
              branch,
              base: worktreeBase,
              commits,
              preexistingRed: preexistingRed.length,
              newRed: 0,
            },
          }
        }
      } else if (rv.verdict === 'red' || (Number.isFinite(rv.code) && rv.code !== 0)) {
        receipt = { verdict: 'red', ref: null }
      } else if (!exit.spawnError && Array.isArray(rv.records) && rv.records.length === 0) {
        // WORK EXISTS, PROOF DOES NOT — and those are different sentences.
        //
        // A repository with no structural recipes (the product itself is one) can never hand
        // back a green receipt: reverify has nothing to re-run and says so honestly. Until
        // now that honest emptiness was read as «no receipt» and the attempt FAILED — so a
        // worker could diagnose correctly, write the fix, commit it to its branch, and still
        // be told it had done nothing. Three attempts, three times, measured 12.08.2026.
        //
        // The resolution keeps the law intact rather than bending it: work that carries
        // commits but no proof does NOT become «done». It goes to the human column with the
        // absence stated on the card — `unverified: true` and the reason in words. Nothing
        // certifies itself; the daemon simply stops discarding finished work for the sin of
        // living in a tree that has no recipes to re-run.
        const commits = countCommitsOnBranch(deps, worktreeBase, workDir)
        // WHY THE GATE DECIDED WHAT IT DECIDED — in words, in the operator's log. Without
        // this line the only observable was «нет квитанции», identical for «the worker did
        // nothing» and «the worker committed and we counted from the wrong point». Those
        // are opposite facts and they cost hours apart.
        writeLog(deps, {
          type: 'task.gate_receiptless',
          taskId: task.id,
          detail: `base=${worktreeBase || 'нет'} commits=${commits} git=${typeof deps.execGit === 'function' ? 'есть' : 'НЕТ'} dir=${workDir}`,
        })
        if (commits > 0) {
          receipt = {
            verdict: 'green',
            ref: { unverified: true, reason: 'no_recipes_in_tree', branch, base: worktreeBase, commits },
          }
        }
      }

      // THE GATE'S OWN VERDICT, put where the outcome record can find it. A refusal carries no
      // receipt reference, and reading «ссылки нет» as «вердикта не было» would turn a red
      // re-verification into a silence in the one file a person opens to see what happened.
      if (worktreeRow && worktreeRow.run) worktreeRow.run.verdict = receipt ? receipt.verdict : 'none'

      // ── WHAT THIS ATTEMPT ACTUALLY TOUCHED, written down BEFORE the fork ──
      // «Откатить можно» и «видно, ЧТО откатывается» — разные вещи, and only the first was
      // true: the base commit named the point to return to and nothing named what would come
      // back with it. The list was worked out by hand and died with the branch.
      //
      // It is taken here, once, ahead of complete/fail on purpose: BOTH outcomes must carry
      // the same record, and the attempt a person wants to undo is precisely the one that was
      // refused.
      //
      // THE SAME VALUE, NOT A SECOND QUESTION. The line below and the DURABLE row written by
      // the two closing doors read one cached answer: git is asked once per attempt, whoever
      // asks first. The log line used to be the ONLY place this list ever reached — computed,
      // printed, and gone with the next log rotation — and that is the half this stopped being.
      const changed = attachChangedFiles(deps, worktreeRow) || changedFilesOnBranch(deps, worktreeBase, branch, workDir)
      writeLog(deps, {
        type: 'task.attempt_files',
        taskId: task.id,
        attempt: task.attempt,
        branch,
        base: worktreeBase,
        files: changed.files,
        deletions: changed.deletions,
        // The values go into `detail`: the operator's formatter prints type/task/worker/
        // reason/detail and drops everything else, so a list filed under any other key is a
        // record nobody can read. Bounded by the SAME constant the row is bounded by — the
        // line used to carry a second, smaller ceiling of its own, and two ceilings in two
        // places are two numbers waiting to disagree about what «ещё N» counts from.
        detail:
          `база=${worktreeBase || 'нет'} ветка=${branch || 'нет'} файлов=${changed.files.length}` +
          (changed.files.length
            ? `: ${changed.files.slice(0, ATTEMPT_FILES_CAP).map(fileWord).join(' · ')}` +
              (changed.filesOverflow ? ` … ещё ${changed.filesOverflow}` : '')
            : ` (${changed.reason})`) +
          // Исчезнувшее называется ОТДЕЛЬНО и числом: «удалён» и «изменён» — разные новости,
          // и человек, читающий откат, обязан увидеть разницу, не пересчитывая список.
          (changed.deletions.length
            ? ` | исчезло=${changed.deletions.length}${changed.deletionsOverflow ? ` (… ещё ${changed.deletionsOverflow})` : ''}`
            : ''),
      })

      if (!exit.spawnError && receipt && receipt.verdict === 'green' && receipt.ref && noteWritten && lessonOk) {
        await completeTask(deps, task, { receiptRef: receipt.ref, branch, diffStat: rv.diffStat, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
        result.completed = task.id
      } else {
        // WHO ENDED THE RUN rides with the rest. The door to «done» above is untouched: an
        // attempt whose branch really did re-verify green AND left its note is finished work
        // whoever ended the session, and refusing it would throw away work that certified
        // itself. What changes is the NAME of a refusal — the outage is called an outage.
        const reason = classifyFailure({
          spawnError: exit.spawnError,
          providerAbort,
          exitCode: exit.code,
          receipt,
          workerMarker: marker,
          journalComplete: noteWritten,
          lessonComplete: lessonOk,
        })
        await failTask(deps, task, { reason, receiptRef: receipt && receipt.ref, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
        result.failed = { taskId: task.id, reason }
      }
      return result
    } catch (err) {
      // Per-task fail-open: a thrown error becomes an honest runtime_offline, never a wedge.
      if (typeof journal === 'function') journal({ type: 'task-error', taskId: task.id, error: String((err && err.message) || err) })
      // WHAT IT COST, BEFORE THE FAILURE IS DECLARED. An attempt that died in an exception
      // spent exactly as much as one that died politely; the book is written first, for the
      // same reason it is written above any gate — money is not conditional on an outcome.
      try {
        if (unbookedSpend) unbookedSpend()
      } catch {
        /* the price of an attempt never fails the attempt — not even a failing one */
      }
      try {
        await failTask(deps, task, { reason: 'runtime_offline', now: now(), envelope, from: fleetState, worktree: worktreeRow })
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
  //
  // WHICH REPOSITORY THE DRAFT IS CUT IN — the one the SCREEN says is connected, not the
  // directory this daemon was launched from. The code path already asks the seam this way and
  // the forge lane was left reading the launch cwd, so a draft ordered for the connected
  // project was forged in whatever tree the daemon happened to start in. Falls back to the
  // launch dir only when no project is connected at all.
  const branch = `wt/${task.id}`
  const provisionDir = (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir
  // The wait actually paid for the copy — measured around the call, not read off the answer,
  // for the same reason the code path measures it: the verb only knows its own inside time,
  // and an install whose CLI is older answers with no number at all.
  const provisionStartedAt = Date.now()
  const wt = await invokeVerb(verbRunner, 'worktree', ['provision', '--branch', branch, '--json'], provisionDir)
  const provisionMs = Date.now() - provisionStartedAt
  if (!wt || wt.ok === false || typeof wt.path !== 'string' || wt.path.trim() === '') {
    // This refusal carries NO copy fields on purpose: no copy was made, and naming a path
    // that does not exist would point a rollback at an invented place.
    await failTask(deps, task, { reason: 'runtime_offline', branch, route, now: now(), envelope, from: fleetState })
    result.failed = {
      taskId: task.id,
      reason: 'runtime_offline',
      detail: `worktree provision answered no path for ${branch}${wt && wt.error ? ` (${wt.error})` : ''}`,
    }
    return result
  }
  const worktreePath = wt.path
  // The same list, checked the same way: it comes from the PROJECT's own CLI, so anything
  // that is not an array becomes an absence rather than a row nobody can read.
  const materialized = Array.isArray(wt.materialized) ? wt.materialized : undefined
  if (materialized === undefined) {
    writeLog(deps, {
      type: 'task.worktree_materialized_missing',
      taskId: task.id,
      branch,
      detail: 'верб провизии не сообщил список материализованного — старая установка CLI проекта или ошибка манифеста',
    })
  }
  // The copy, as one object for every door that can close this attempt. The forge lane has
  // no reverify gate of its own, so this is the ONLY record of where its draft was written.
  const worktreeRow = copyRow({ wt, branch, worktreePath, materialized, provisionMs })

  // (5b) THE PERSONAL LAYER, PUT IN PLACE BEFORE THE PROCESS EXISTS.
  //
  // The account a worker runs under is not the founder’s: it has its own settings file, and
  // until that file is written the session starts without his instructions, without his hooks
  // and — the half nobody can see from outside — with whatever hosted connectors the vendor
  // decides to attach that minute. So the mirror runs HERE, BEFORE the arguments are
  // assembled: the builder reads that very file to check the profile, and a spec prepared
  // ahead of the mirror is refused by the parity guard. The order is the wire.
  //
  // AND A MIRROR THAT CANNOT BE WRITTEN IS A REFUSAL BY NAME. Spawning anyway is the one
  // option that must not exist: it spends the subscription on a session running under rules
  // nobody approved, and no card would ever be able to say so.
  let personalLayer = null
  if (typeof deps.mirrorPersonalLayer === 'function') {
    const routedWorker = (config.workers || []).find((w) => w && w.id === (route && route.workerId))
    try {
      personalLayer = await deps.mirrorPersonalLayer({
        accountDir: routedWorker && routedWorker.account && routedWorker.account.configDir,
        plugins: (routedWorker && routedWorker.plugins) || [],
        overrides: (routedWorker && routedWorker.settingsOverrides) || {},
      })
    } catch (err) {
      const layerDetail = String((err && err.message) || err)
      writeLog(deps, { type: 'task.refused', taskId: task.id, reason: 'personal_layer_error', detail: layerDetail })
      await failTask(deps, task, { reason: 'personal_layer_error', branch, route, now: now(), envelope, from: fleetState, worktree: worktreeRow })
      result.failed = { taskId: task.id, reason: 'personal_layer_error', detail: layerDetail }
      return result
    }
  }
  // (5c) OUR SERVERS, AND ONLY OURS. The file is written per attempt and its PATH is all
  // that travels: it names the servers a person enabled in the registry on this host and
  // nothing else. Written even when the registry is empty — a deterministic argument array
  // is what turns «the worker had exactly these servers» into a claim somebody can check a
  // week later, and an empty file says that plainly where a missing flag says nothing.
  const spawnDataDir = deps.dataDir || config.dataDir
  let mcpConfig = null
  if (spawnDataDir) {
    try {
      const registry = typeof deps.loadMcpRegistry === 'function' ? deps.loadMcpRegistry() : { servers: [] }
      const registered = Array.isArray(registry && registry.servers) ? registry.servers : []
      const mcpConfigPath = buildMcpConfigFile({
        servers: registered,
        taskDir: join(spawnDataDir, 'mcp', `${task.id}-${task.attempt}`),
        fsImpl: deps.fsImpl,
      })
      mcpConfig = { path: mcpConfigPath, servers: registered.filter((x) => x && x.enabled === true).map((x) => x.id) }
    } catch (err) {
      // FAIL-OPEN, AND OUT LOUD. A registry that cannot be read must not cost the attempt:
      // the session simply starts with none of our servers, and the miss is on the record
      // instead of being a silence somebody discovers inside a transcript.
      writeLog(deps, { type: 'task.mcp_config_error', taskId: task.id, error: String((err && err.message) || err) })
    }
  }
  if (personalLayer) worktreeRow.personalLayer = personalLayer
  if (mcpConfig) worktreeRow.mcpConfig = mcpConfig

  // (6) spawn the «Создатель» with the FORGE prompt (not the code task prompt); touch on stream.
  //
  // THE ENVELOPE REACHES THE PROCESS THAT HAS TO OBEY IT — the same wire the code path
  // above was given and this lane was not. Without the grant the CLI refuses Edit/Write
  // inside the child, so the «Создатель» could not write the very draft file the exit gate
  // then failed it for not committing: «ошибка работника», with no way to see why.
  const kind = task.forge && task.forge.kind
  // THE SAME ONE FUNCTION the code path above calls — not a second list of fields that
  // happens to say the same thing today. The last time these two points each carried their
  // own copy of this decision, one of them was updated and this one was not, and the lane
  // spawned read-only for weeks while the screen blamed the worker.
  const spec = buildArgs(task, route, {
    ...SPAWN_OPTIONS,
    ...(mcpConfig ? { mcpConfigPath: mcpConfig.path } : {}),
    ...envelopeSpawnOptions(envelope),
    // The SAME one function the code path calls — see its own note about the last time these
    // two points each carried a private copy of a spawn decision.
    ...gateSpawnOptions(deps, config, task),
  })
  spec.prompt = buildForgePrompt({
    kind,
    description: task.forge && task.forge.description,
    note: task.note,
    // The tree the worker actually stands in. `config.repoDir` is the daemon's launch
    // directory, which on any install serving a project from beside the workshop is not
    // where this session is — a prompt naming a working copy the child cannot see.
    repoDir: worktreePath,
  })
  // The SAME stream reader the code/document path uses — a forge attempt is an attempt, it
  // gets a card, and a lane watched by nobody is exactly the lane that goes quiet at 3am.
  const streamLines = []
  const { onLine, sessionOf, initOf, memoryOf, guardsOf, runInitOf, permissionDenialsOf, logFileOf } = attemptStream(
    deps,
    task,
    streamLines,
    now,
    { accountName: spec.accountName, dataDir: config.dataDir },
    { workDir: worktreePath, accountDir: spec.env && spec.env.CLAUDE_CONFIG_DIR },
  )
  // The steering wheel, same as the code path: the founder's «Перебить сейчас» must be able
  // to end a forge turn too, and a spawn nobody registered is a door that answers and does
  // nothing.
  const spawnSteered = steeredSpawn(deps, task.id, spawnWorker)
  fleetState = 'RUNNING'
  // WHEN THIS ATTEMPT STARTED — captured where the process really begins, so a subscription
  // attempt books a duration instead of counting from epoch zero.
  const attemptStartedAt = now()
  const exit = await runSpawn(spawnSteered, { bin: spec.bin, args: spec.args, cwd: worktreePath, env: spec.env, prompt: spec.prompt }, onLine)
  if (deps.attemptTurns) deps.attemptTurns.done(task.id)

  // WHAT THE SESSION ITSELF REPORTED joins what the mirror wrote, on ONE key. The mirror
  // says what was PUT INTO the account; the init frame says what the session actually
  // LOADED — and the gap between those two is precisely the class of defect this phase
  // exists to close. Merged rather than replaced: neither half alone answers the question.
  const sessionInit = initOf()
  if (sessionInit) {
    worktreeRow.personalLayer = { ...(worktreeRow.personalLayer || {}), ...sessionInit }
  }

  // WHAT IT COST — off this attempt's own stream, before any gate decides its fate. A refused
  // forge attempt still spent the tokens; the forge lane booked nothing at all until now, so
  // «Расходы» answered zero to a night of real sessions.
  bookAttemptUsage(deps, task, route, streamLines, now(), attemptStartedAt)

  // The forge lane creates an attempt, so the forge lane owes a note like any other lane.
  // THE STREAM IS NOT TEXT: the markers live inside JSON frames, so the raw lines are
  // unwrapped first (`approachLinesFrom`) exactly as the code path does. Reading the frames
  // raw meant the note was never found and a green draft still failed «нет записки».
  const noteWritten = recordApproachNote(deps, task, parseApproachNote(approachLinesFrom(streamLines)))

  // The forge lane creates an attempt, so the forge lane owes a MEMORY layer like any other —
  // and it owes it here, above every exit below, for the same reason the code lane writes it
  // above its own four. The lesson is the one field that differs: this lane produces a draft
  // instead of finished work and its gate never asks for a lesson, so the layer says so in
  // words rather than reporting a missing one the worker was never asked for.
  writeMemoryLayer(deps, task, {
    memory: memoryOf(),
    sma: collectSmaTrace({
      projectDir: (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir,
      sessionId: sessionOf(),
      fsImpl: deps.fsImpl,
    }),
    lesson: { none: 'полоса-кузница: урок с этой попытки не требуется' },
    approachJournaled: noteWritten,
    notes: [],
  })

  // THE FORGE LANE IS A LANE — it creates an attempt, so it leaves the same directory the code
  // lane does. One writer, one format: a checking tool must not need to know which lane a try
  // came from before it can read what the try was given.
  worktreeRow.run = writeAttemptRunDir(deps, task, {
    route,
    envelope,
    spec,
    worktree: worktreeRow,
    workDir: worktreePath,
    startedAt: attemptStartedAt,
    endedAt: now(),
    sessionId: sessionOf(),
    runInit: runInitOf(),
    memory: memoryOf(),
    sma: collectSmaTrace({
      projectDir: (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir,
      sessionId: sessionOf(),
      fsImpl: deps.fsImpl,
    }),
    guards: guardsOf(),
    permissionDenials: permissionDenialsOf(),
    ledgerPath: logFileOf(),
    exit,
    gate: 'forge',
    lesson: { none: 'полоса-кузница: урок с этой попытки не требуется' },
  })

  if (exit.spawnError) {
    await failTask(deps, task, { reason: 'runtime_offline', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
    result.failed = { taskId: task.id, reason: 'runtime_offline' }
    return result
  }

  // WHO ENDED THE RUN — asked here for the same reason the code path asks it, and BEFORE the
  // draft gate below: a session the vendor cut off leaves no committed draft, and failing it
  // «ошибка работника» would blame this lane's worker for an outage exactly as the other lane
  // used to. A forge attempt is an attempt; it gets the same honest word.
  const forgeAbort = providerAbortOf(streamLines)
  if (forgeAbort) {
    writeLog(deps, {
      type: 'task.provider_abort',
      taskId: task.id,
      reason: 'provider_error',
      detail:
        `провайдер оборвал прогон (${forgeAbort.reason}${forgeAbort.status ? ` ${forgeAbort.status}` : ''})` +
        `${forgeAbort.said ? `: ${forgeAbort.said}` : ''}`,
    })
    await failTask(deps, task, { reason: 'provider_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
    result.failed = { taskId: task.id, reason: 'provider_error' }
    return result
  }

  // (7) EXIT GATE = deterministic draft lint + committed-on-branch assertion (NOT reverify).
  const drafts = listCommittedDrafts(deps.execGit, branch, worktreePath, kind)
  if (drafts.length !== 1) {
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
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
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
    result.failed = { taskId: task.id, reason: 'agent_error', detail }
    return result
  }

  const lint = lintDraft({ kind, filePath: join(worktreePath, draftPath), fsImpl: deps.fsImpl })
  if (!lint.passed) {
    const failed = lint.checks.filter((c) => !c.ok).map((c) => c.name).join(',')
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
    result.failed = { taskId: task.id, reason: 'agent_error', detail: `lint failed: ${failed}` }
    return result
  }

  if (!noteWritten) {
    // Certified draft, unexplained attempt — the same gate, the same named failure.
    await failTask(deps, task, { reason: 'no_journal', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
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
  await completeTask(deps, task, { receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow })
  result.completed = task.id
  return result
}

/**
 * complete a task through the adapter gate + write a rich (receipt-bearing) attempt row.
 * `from` names the fine state the task was really in; omitting it (the preflight-«built»
 * door) writes the row with no transition fields rather than an invented pair.
 */
async function completeTask(deps, task, { receiptRef, branch, diffStat, route, now, envelope, from, sessionId, startedAt, worktree }) {
  const { adapter, ledger, report } = deps
  // THE VERDICT FIRST, THE ROW SECOND. The five parity receipts are computed here rather than
  // where the receipt file is written, because the ledger row below is appended BEFORE that
  // file exists — and the row is what the card reads. Asked in the other order, the verdict
  // would be perfectly computed, perfectly stored, and delivered to nobody.
  attachAttemptParity(deps, worktree)
  // AND WHAT THE ATTEMPT CHANGED, asked in the same breath and for the same reason: the row
  // below is written before anything else about the ending exists, and the row is what a card
  // is built from. One question to git per attempt, cached on the copy — whichever door
  // arrives here first.
  attachChangedFiles(deps, worktree)
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
      // WHEN THE WORK BEGAN. The ledger has always had a place for this and nobody ever
      // filled it, so the card showed «начат —» and «сколько заняло: работа ещё не
      // начиналась» underneath a FINISHED attempt. Duration is not a decoration: it is the
      // first thing a person asks of work they did not watch.
      ...(Number.isFinite(startedAt) ? { startedAt: new Date(startedAt).toISOString() } : {}),
      receiptRef,
      // The session this attempt ran in. `undefined` when the stream never named one (a
      // preflight door completes with no worker at all) — the allowlist loop then omits the
      // key entirely, so a row without a session says so by ABSENCE, never by an empty string.
      sessionId: sessionId ?? undefined,
      endedAt: new Date(now).toISOString(),
      // THE COPY THIS ATTEMPT RAN IN — see the same block on failTask below: it is written
      // on BOTH outcomes or it is worth nothing.
      ...worktreeFields(worktree),
      ...attemptStamp(deps, task, { from, to: from ? 'PRODUCED' : undefined, actor: 'worker', envelope }),
    })
  }
  // HOW THE TRY ENDED, into the attempt's own directory. Written here rather than at the point
  // the rest of the record was written because THIS is where the outcome is first known.
  writeAttemptOutcome(deps, worktree, {
    outcome: 'completed',
    verdict: (worktree && worktree.run && worktree.run.verdict) || 'green',
    ref: receiptRef ?? null,
    lesson: (worktree && worktree.run && worktree.run.lesson) ?? null,
  })
  if (typeof report === 'function') {
    await report({ event: 'task.completed', taskId: task.id, title: task.title, lane: task.lane, receiptVerdict: 'green', branch, attempt: task.attempt })
  }
}

/**
 * fail a task through the adapter gate + write a rich (receipt-bearing) attempt row.
 * `from` is CLAIMED for an attempt refused before any worker started and RUNNING for one
 * that died after — both are legal edges into RETRYABLE, and the key names the real one.
 */
/**
 * The five fields that describe the copy an attempt ran in, ready to be spread into a
 * ledger row: where it was, what it was cut from, what was put into it and how long that
 * took. ONE expression, used by both doors, so a finished attempt and a refused one can
 * never carry different halves of the same fact — and the refused one is precisely the one
 * somebody will want to roll back. No copy (a documentary stage, or a refusal that came
 * before provisioning) writes NO keys at all: absence says «there was none», where a null
 * would say «there was one and we lost it».
 *
 * The same object also carries the two facts about the SESSION the attempt ran in — the
 * personal layer as the mirror reported it and the per-spawn mcp config — for the same
 * reason: both are overwritten by the next attempt and cannot be re-derived afterwards.
 *
 * @param {{base?:string, branch?:string, worktreePath?:string, materialized?:object[],
 *          provisionMs?:number, personalLayer?:object, mcpConfig?:object}|null} [worktree]
 * @returns {object} fields to spread into `recordAttempt`
 */
function worktreeFields(worktree) {
  if (!worktree) return {}
  return {
    base: worktree.base ?? undefined,
    branch: worktree.branch ?? undefined,
    worktreePath: worktree.worktreePath ?? undefined,
    materialized: worktree.materialized ?? undefined,
    provisionMs: worktree.provisionMs ?? undefined,
    personalLayer: worktree.personalLayer ?? undefined,
    mcpConfig: worktree.mcpConfig ?? undefined,
    // WHERE THE EVIDENCE OF THIS TRY LIVES. The row is the durable record, so it names the
    // directory rather than leaving it to be guessed from an id and a convention. `parity` is
    // the verdict of the checking tool, written back beside it; until it is computed the key
    // is present and null, which is «nobody has checked», not «checked and fine».
    runDir: (worktree.run && worktree.run.dir) || undefined,
    ...(worktree.run && worktree.run.dir ? { parity: worktree.run.parity ?? null } : {}),
    // WHAT THE ATTEMPT CHANGED, and what it made disappear — handed out by the SAME expression
    // that hands out the point of return, so the two halves of one answer can never travel
    // apart: a base commit with no list is «откатить можно, а к чему — неизвестно», which is
    // the half that was already true and the half that was not.
    //
    // WRITTEN ONLY WHEN GIT ACTUALLY ANSWERED. No copy, no base or a git that refused leaves
    // NO keys at all — «попытка этого не знает». An empty array would say «ничего не
    // менялось», a different and much more confident claim than the one we can make.
    // A branch that genuinely changed nothing DOES get empty arrays: that answer was asked for
    // and received, and it is a record.
    ...changedFields(worktree.changed),
  }
}

/** The changed-file half of a copy's row: present when git answered, absent when it did not,
 *  and carrying the two overflow counters only when the ceiling actually cut something. */
function changedFields(changed) {
  if (!changed || changed.answered !== true) return {}
  return {
    files: changed.files,
    deletions: changed.deletions,
    ...(changed.filesOverflow ? { filesOverflow: changed.filesOverflow } : {}),
    ...(changed.deletionsOverflow ? { deletionsOverflow: changed.deletionsOverflow } : {}),
  }
}

async function failTask(deps, task, { reason, receiptRef, branch, route, now, envelope, from, sessionId, startedAt, worktree }) {
  const { adapter, ledger, report } = deps
  // THE VERDICT FIRST, THE ROW SECOND. The five parity receipts are computed here rather than
  // where the receipt file is written, because the ledger row below is appended BEFORE that
  // file exists — and the row is what the card reads. Asked in the other order, the verdict
  // would be perfectly computed, perfectly stored, and delivered to nobody.
  attachAttemptParity(deps, worktree)
  // AND WHAT THE ATTEMPT CHANGED — here above all. This is the try somebody actually wants to
  // undo, and a list that exists only on the finished path is missing exactly when it is
  // needed. Asked even when this refusal came before a run directory was ever made: the answer
  // is cached on the COPY, so an early exit owes and pays the same record as a late one.
  attachChangedFiles(deps, worktree)
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
        // WHOSE APPROACH THIS WAS. The finished path has always written it and this one never
        // did, so every failed row in the ledger was nameless — and the roster's «не получилось»
        // was therefore a STRUCTURAL zero: it could not have shown anything else no matter how
        // much work had broken. A confident wrong zero is the worst answer of the three, because
        // by it a person cannot notice that the answer is missing.
        // Taken from the route, exactly as the provider beside it is, and OMITTED when there is
        // no route — an API fallback runs under no worker, and an attempt refused before any
        // routing had happened has nobody to name. Absent means absent; it is never guessed from
        // a neighbouring row, because that would pin a failure on somebody possibly innocent.
        workerId: (route && route.workerId) || undefined,
        provider: route && route.provider,
        outcome: 'failed',
        failureReason: reason,
        // A failed attempt owes the same answer a finished one does: when did it start, and
        // how long did it burn before it gave up.
        ...(Number.isFinite(startedAt) ? { startedAt: new Date(startedAt).toISOString() } : {}),
        receiptRef: receiptRef ?? undefined, // the red receipt ref is preserved on the row
        // A FAILED attempt keeps its session id too — that is the attempt a person is most
        // likely to want to open and look inside afterwards.
        sessionId: sessionId ?? undefined,
        endedAt: new Date(now).toISOString(),
        // THE COPY A FAILED ATTEMPT RAN IN. This is the whole point of the field: the base
        // commit, the branch, the path and the list of what was put into the copy are what
        // a person needs to undo a try that went wrong — and until now they lived only in
        // the operator's log, which does not survive a restart or a month.
        ...worktreeFields(worktree),
        ...attemptStamp(deps, task, { from, to: from ? 'RETRYABLE' : undefined, actor: 'supervisor', envelope }),
      })
    } catch (err) {
      writeLog(deps, { type: 'ledger-error', taskId: task.id, reason, error: String((err && err.message) || err) })
    }
  }
  // A REFUSED ATTEMPT OWES THE SAME RECORD A FINISHED ONE DOES — it is the try somebody will
  // actually want to open afterwards, and a directory with three files and no verdict says
  // «still running» about work that stopped hours ago.
  writeAttemptOutcome(deps, worktree, {
    outcome: 'failed',
    failureReason: reason,
    verdict: (worktree && worktree.run && worktree.run.verdict) || (receiptRef ? 'red' : 'none'),
    ref: receiptRef ?? null,
    lesson: (worktree && worktree.run && worktree.run.lesson) ?? null,
  })
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
