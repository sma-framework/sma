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
 * ═══════════════ И СРЫВ ПОПАДАЕТ В ЕДИНЫЙ ЖУРНАЛ САМ ═════════════════════════════
 * Шаг (1c) — `sweepBugJournal`, сразу за сверкой: строка на каждую сорвавшуюся задачу в один
 * файл на все проекты, со словом очереди и словом реестра РЯДОМ (экран показывает только
 * первое из них). Проход, а не поле у двери: причину `attempts_exhausted` не пишет ни одна
 * дверь — она выводится при чтении строки задания, — и журнал, собранный по дверям, молчал
 * бы именно о ней. Дописывает только то, чего в журнале ещё нет; fail-open, как соседи.
 * ОДНО ИСКЛЮЧЕНИЕ, И ОНО ЖЕ ГРАНИЦА: обрыв поставщика пишет ДВЕРЬ (`failTask`), потому что
 * конец этот перевыдаваемый — строка уходит обратно в очередь ожидающей и метле не видна
 * вовсе, пока не кончатся перевыдачи. Ключ и слово реестра у двери те же, что у метлы, так
 * что второй строки об одном срыве не бывает.
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
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync, rmSync as fsRmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { pipelineEnabled, pipelineMaxTurns, projectEntry, codeTreeOf, planningHomeOf } from './config.mjs'
import { taskTurnCap, burnedTurnCapsOf, turnKindOf, emptyTurnKinds } from './policy/turn-budget.mjs'
import { resolveExpireMs, batchWorkerOf, waveAddressOf, isBatchParent, batchItemsOf, batchDecisionsOf, brokenItemOf, batchLetGoOf, latestRowPerId, claimRefusal, FAIL_REASONS, endingAwaitsAPerson, awaitsAutoRetry, autoRetryDueAt, autoRetriesSpent, AUTO_RETRY_LIMIT, ATTEMPTS_EXHAUSTED, taskContextOf, UnknownTaskError } from './queue/adapter.mjs'
import { WORKER_SKILLS } from './queue/worker-skills.mjs'
import { livenessSweep } from './queue/liveness.mjs'
import { reconcileAttempts } from './queue/reconcile.mjs'
// «МОЖНО ЛИ МНЕ ТРОГАТЬ ЭТОТ КАТАЛОГ» — ОДИН ВОПРОС И ОДИН ОТВЕТ НА ВЕСЬ ДЕМОН. Тик отзывает
// копию, которую сам же только что отвёл (отказ по тумблеру), а обход уборки и сбор памяти
// спрашивают о копиях, отведённых кем-то месяц назад. Три места, решающих это порознь, разойдутся
// молча — и разойдутся ровно в ту сторону, где удаляется каталог, о котором никто не думал.
import { insideCopiesDir } from './queue/worktree-cleanup.mjs'
// Метла журнала срывов — и `causeOf` рядом с ней: дверь, пишущая об обрыве поставщика в момент
// события, берёт слово реестра ТОЙ ЖЕ функцией, что и метла, а не вторым его вычислением.
import { sweepBugJournal, causeOf } from './queue/bug-journal.mjs'
// Потолок мест читает ДОМ ИДУЩИХ ПОПЫТОК, а не тик: одно чтение настройки на весь демон —
// его же спрашивает дверь состояния, чтобы назвать человеку «занято X из N».
import { concurrencyCap, seatCeiling, seatWorkers, laneReservations, confirmProcessGone } from './queue/in-flight.mjs'
// ATTEMPT_FILES_CAP is IMPORTED, never re-declared: the ceiling on the changed-file list
// belongs to the module that owns the row's key list, and a second copy of the number here
// would be a second ceiling waiting to drift away from the first.
// …и `closureOf` — ОДИН вопрос к реестру: «эту карточку уже закрыли?». Его задаёт обход
// беклога перед тем, как поставить строку файла в работу, И ЗАХВАТ перед тем, как за строку
// начнут платить; своё чтение поля `closed` здесь было бы вторым мнением о том, что считается
// закрытием. `nextAttemptNumber` — оттуда же и по той же причине: реестр не забывает прожитых
// подходов, а очередь забывает, и второй арифметики номера в тике быть не должно.
import { memorySnapshotHash, safeName, ATTEMPT_FILES_CAP, closureOf, nextAttemptNumber } from './queue/attempt-ledger.mjs'
import { defaultEnvelope, validateEnvelope, envelopeAllows, envelopeHash, envelopeSpawnOptions } from './queue/capability-envelope.mjs'
import { runsDirOf, attemptRunDir, writeRunStart, writeRunReceipt, pruneRunDirs, secretValuesOf, sanitizeRun, createToolPairing, buildContinuationSummary, writeContinuation, readContinuation, writeTaskContext, fileWord, RUN_DIRS_KEEP, TASK_CONTEXT_FILE } from './queue/run-dir.mjs'
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
  parseMootMarker,
  attemptIdFor,
} from './front/journal.mjs'
// THE CORPUS READS ITS OWN NOTES. The lesson gate below asks whether a file is a note the
// memory pipeline produced, and it asks with the parser the corpus itself uses — a second,
// looser reader here would be a second definition of «a note», and the day they disagreed the
// gate would be certifying files no corpus would ever accept.
import { parseNote } from '../../scripts/sma/lib/frontmatter.mjs'
import { PIPELINE_DRAFT_KIND } from '../../scripts/sma/lib/write-pipeline.mjs'
import { smaRoot, tokenHash } from '../../scripts/sma/lib/registry.mjs'
import { WORKTREE_COPIES_DIR } from '../../scripts/sma/lib/constants.mjs'
// СВЕДЕНИЕ ВЕТКИ С ВЕРШИНОЙ ДО СДАЧИ — тот же ритуал и тот же словарь конфликта, которыми
// говорит приёмка (merge-gate.mjs зовёт их же). Два выражения в двух файлах разошлись бы молча.
import { syncWithTrunk, TRUNK_DEFAULT } from '../../scripts/sma/lib/branch-sync.mjs'
import { closeWaitingTickets } from '../../scripts/sma/lib/tool-gate.mjs'
import { checkEnvironmentFitness } from '../../scripts/sma/lib/deps-guard.mjs'
import { parseClaudeEvent, parseClaudeFrame } from './runner/stream.mjs'
import { summarizeFrame, wholeFrameKind } from './runner/frame-summary.mjs'
import { markWindowObserved, markWindowClosed, readingSaysExhausted, canonicalWindow, utilizationFraction } from './policy/windows.mjs'
// РОЛИ ПУЛА — ЧИТАЮТСЯ ТЕМ ЖЕ ВЫРАЖЕНИЕМ, КАКИМ ИХ ЧИТАЕТ МАРШРУТИЗАТОР. Проба пригодности
// полосы обязана спрашивать ровно то же, что спросят при захвате: разойдясь, они начнут
// объявлять полосу пригодной для того, кого маршрут потом не выберет.
import { EXECUTOR_ROLE, holdsRole, roleOf, roleWanted } from './policy/worker-role.mjs'
// ФОРМА РАБОТЫ — третий вопрос выходного гейта, рядом с «есть ли квитанция» и «объяснена ли
// попытка»: О ЧЁМ то, что легло на ветку. Живёт отдельным модулем, потому что это ЧИСТОЕ
// суждение о списке изменений, и его цена — прочитать его тестами без тика вокруг.
import { selfReferentialTests, newTopLevelDirs } from './policy/work-shape.mjs'
import { estimateUsage } from './runner/usage.mjs'
// КАКАЯ ЭТО ПОЛОСА — ОДНОЙ СТРОКОЙ ТАБЛИЦЫ. Тик спрашивает у неё четыре вещи, и ни одну из них
// больше не решает сравнением имени: чем кончается поток и как с него снимаются числа, есть ли
// у полосы дорога вернуться в идущую сессию, исполняется ли её граница подготовленной машиной,
// и сможет ли её сессия закоммитить себя сама.
import { laneAdapter } from './runner/provider-adapter.mjs'
import {
  readPendingRedirects,
  markConsumed,
  appendRedirect,
  redirectFileOf,
  correctionsPreamble,
  REDIRECT_HOP_CAP,
} from './runner/redirects.mjs'
import { readWaveHolds, readWaveParked, markWaveParked } from './queue/wave-holds.mjs'
import {
  buildMcpConfigFile,
  isResumableSessionId,
  codexHomeFor,
  codexGitObjectsRoot,
  discardCodexHome,
  readCodexSandboxJournal,
  codexWorkspaceWriteOutlook,
  codexSandboxRefusal,
  codexGitWritableRoot,
} from './runner/args.mjs'
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
    // ПИШУЩАЯ ПОЛОВИНА ТОГО ЖЕ ШВА. До материализации снимка и навыков тик в рабочую копию
    // ничего не писал вовсе, и шов был только читающим. Он остаётся ОДНИМ швом: два разных
    // способа добраться до диска — это два разных мира в делах и один на машине.
    mkdirSync: io.mkdirSync ?? fsMkdirSync,
    writeFileSync: io.writeFileSync ?? fsWriteFileSync,
    rmSync: io.rmSync ?? fsRmSync,
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
/**
 * taskTreeDir(deps, config, task) → the project tree THIS task's work happens in.
 *
 * THE TASK'S OWN STAMP WINS. A task is stamped with its project at the one moment it is
 * known — the enqueue door. The screen's selector is a live thing: between enqueue and
 * claim a person can switch projects, and every expression that read the screen at claim
 * time carried the attempt into whichever tree happened to be shown. Measured on a live
 * task: stamped for the workshop beside this repo, provisioned from this repo — the
 * worker proved the cut with git rev-parse and returned with a question instead of work.
 * A task with no stamp follows the screen exactly as before; a stamp naming no known
 * project falls back the same way and SAYS SO in the log rather than running somewhere
 * silently.
 */
function taskTreeDir(deps, config, task) {
  const fallback = (typeof deps.projectDir === 'function' && deps.projectDir()) || config.repoDir
  const id = task && typeof task.project === 'string' ? task.project.trim() : ''
  if (!id) return fallback
  const hit = codeTreeOf(projectEntry(config, id))
  if (hit) return hit
  writeLog(deps, { type: 'task.project_unresolved', taskId: task && task.id, project: id })
  return fallback
}

/**
 * taskPlanningDir(deps, config, task) → ДОМ ПЛАНИРОВАНИЯ проекта этой задачи: каталог, в
 * котором лежит её `.planning`.
 *
 * ВТОРОЙ АДРЕС ТОГО ЖЕ ПРОЕКТА, а не второй проект. Пока запись реестра знала один адрес,
 * дом планирования приходилось заводить отдельным проектом — и ступень фазы, поставленная у
 * продукта, получала копию ПРОДУКТА, где каталогов фаз нет. Замерено 31.08: ступень plan
 * фазы 21 ушла искать фазу по машине, нашла чужую фазу 21 соседнего проекта и честно
 * отказалась — восемнадцать ходов и около доллара за отказ. Второй адрес не задан — ответ
 * буква в букву тот же, что у taskTreeDir выше.
 */
function taskPlanningDir(deps, config, task) {
  const id = task && typeof task.project === 'string' ? task.project.trim() : ''
  const hit = id ? planningHomeOf(projectEntry(config, id)) : null
  if (hit) return hit
  return (typeof deps.planningDir === 'function' && deps.planningDir()) || taskTreeDir(deps, config, task)
}

/**
 * attemptTreeDir(deps, config, task) → дерево, ИЗ КОТОРОГО ЭТОЙ ЗАДАЧЕ РЕЖУТ КОПИЮ.
 *
 * Кодовая работа — из дерева кода. Документарная ступень фазы — из дома планирования: она
 * правит `.planning`, и копия дерева, в котором его нет, для неё пустая комната. Правило
 * названо ОДИН раз и здесь, потому что его же читает приёмка, когда ищет ветку (front/
 * server.mjs, taskBranchTree): разойдись эти двое — и приёмка не нашла бы ровно ту работу,
 * которую сама заказала.
 */
function attemptTreeDir(deps, config, task) {
  return stageDataOf(task).kind === DOCUMENT_KIND ? taskPlanningDir(deps, config, task) : taskTreeDir(deps, config, task)
}

function gateSpawnOptions(deps, config, task) {
  const projectDir = taskTreeDir(deps, config, task)
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

/**
 * copyWriteSpawnOptions(deps, workDir) → `{writableRoots}` — ЕДИНСТВЕННЫЙ КАТАЛОГ СНАРУЖИ
 * КОПИИ, БЕЗ КОТОРОГО РАБОТА В НЕЙ НЕ ЗАКАНЧИВАЕТСЯ КОММИТОМ.
 *
 * ЧТО СЛОМАНО БЕЗ ЭТОГО. Полоса codex ходит в песочнице `workspace-write`: она открывает на
 * запись РАБОЧИЙ КАТАЛОГ и ничего больше. А копия попытки — это РАБОЧЕЕ ДЕРЕВО git: её `.git`
 * не каталог, а файл-указатель, и индекс, ссылки, объекты лежат в основном репозитории,
 * СНАРУЖИ копии. Поэтому сессия честно правит файлы и упирается в запрет на `git add`, а гейт
 * закрывает попытку как «нет квитанции» — на карточке виноват работник, который сделал всё,
 * что мог. Замерено 01.09.2026; решение основателя 02.09.2026: кодекс — работник уровня
 * Опуса/Фейбла и делает всё идентично, а соседняя полоса ходит вообще без песочницы.
 *
 * ГРАНИЦА НЕ СНИМАЕТСЯ, В НЕЁ ВНОСИТСЯ ОДИН КАТАЛОГ. `danger-full-access` для этого не
 * годится и структурно отклонён сборщиком аргументов; здесь называется ровно git-каталог этой
 * копии, и больше ничего.
 *
 * СПРАШИВАЕТСЯ У GIT, А НЕ ВЫВОДИТСЯ ИЗ РАСКЛАДКИ КАТАЛОГОВ. Где лежит git-каталог копии,
 * знает только git: у обычного клона это `.git` внутри, у рабочего дерева — путь в основной
 * репозиторий. Ответ приводится к абсолютному одним выражением (codexGitWritableRoot), тем же
 * на обеих дверях спавна.
 *
 * СПРАШИВАЕТСЯ ДВАЖДЫ, И ЭТО НЕ ПОВТОР. `--git-common-dir` называет ОБЩИЙ каталог (`<главный>/
 * .git`), а `--git-dir` — СВОЙ каталог этой копии; у рабочего дерева это разные пути, и всё,
 * что трогает `git add`, — индекс и `HEAD` — лежит во втором (`<общий>/worktrees/<имя>`). Да,
 * второй вложен в первый; называется он всё равно, потому что «писаемый корень» — это договор
 * с чужим кодом, а не наше рассуждение о вложенности: песочница, раздающая права поштучно,
 * получила бы разрешение на родителя и ничего на ребёнка. У обычного клона оба ответа
 * совпадают, и второй вопрос ничего к списку не добавляет.
 *
 * И ТРЕТЬИМ — ХРАНИЛИЩЕ ОБЪЕКТОВ ОБЩЕГО КАТАЛОГА, по той же поштучной причине и по замеру
 * 03.09.2026: с двумя корнями индекс писался, а `git commit` трижды падал на ЧТЕНИИ уже лежащих
 * объектов («invalid object … for <файл>» на файлах, которых сессия не трогала). Про запрет
 * чтения речи нет вовсе — снимок запретов в доме пуст (см. readCodexSandboxJournal).
 *
 * FAIL-OPEN, НО ВСЛУХ. Git молчит или его нет — спавн идёт прежним (полоса Claude этот список
 * не читает вовсе, и отказ убил бы её ни за что), а промах ложится в журнал: молчание здесь
 * вернуло бы ровно ту попытку без квитанции, ради которой всё это и написано. Промах ОДНОГО
 * из двух вопросов не отменяет ответ второго: половина границы лучше, чем ничего.
 */
function copyWriteSpawnOptions(deps, workDir) {
  if (typeof deps.execGit !== 'function') return {}
  if (typeof workDir !== 'string' || workDir.trim() === '') return {}
  const roots = []
  const name = (root) => {
    if (root && !roots.includes(root)) roots.push(root)
  }
  for (const flag of ['--git-common-dir', '--git-dir']) {
    let answer = ''
    try {
      answer = String(deps.execGit(['rev-parse', flag], { cwd: workDir }) || '').trim()
    } catch (err) {
      writeLog(deps, { type: 'task.copy_git_dir_unknown', workDir, error: `${flag}: ${String((err && err.message) || err)}` })
      continue
    }
    const root = codexGitWritableRoot({ workDir, gitCommonDir: answer })
    if (!root) {
      writeLog(deps, { type: 'task.copy_git_dir_unknown', workDir, error: `git не назвал ${flag} копии` })
      continue
    }
    name(root)
    // И ХРАНИЛИЩЕ ОБЪЕКТОВ ОБЩЕГО КАТАЛОГА — ТРЕТЬЕЙ СТРОКОЙ, ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО И ВТОРАЯ.
    // Раздача прав идёт СПИСКОМ, а не деревом, и подкаталог, которого в списке нет, остаётся при
    // правах, доставшихся ему до раздачи. Замерено 03.09.2026: с двумя корнями запись индекса
    // пошла, а `git commit` трижды подряд ответил «invalid object … for <файл>» на объекты,
    // которых сессия не трогала, — то есть упёрся в ЧТЕНИЕ общего хранилища (см.
    // codexGitObjectsRoot).
    if (flag === '--git-common-dir') name(codexGitObjectsRoot(root))
  }
  return roots.length > 0 ? { writableRoots: roots } : {}
}

/**
 * wakeSpawnOptions(deps, task) → `{wakeKind}`, plus `{resumeId}` when THIS wake is allowed to
 * continue the session the previous attempt held.
 *
 * WHAT THE SPLIT IS FOR. Two very different events arrive at the tick looking identical — a
 * second attempt of a task whose ledger holds a session id. One is a PERSON handing work back
 * with a remark: he has already paid for everything the worker read and thought, and starting
 * from zero charges him for it twice, in a head that no longer remembers what he is objecting
 * to. The other is a TIMER: the lease expired, time passed, and the picture of the world that
 * session ended with is no longer the picture outside. Dragging it along drags a stale one.
 * Until this function they were one condition — «attempt > 1» — and both continued.
 *
 * THE ONE WORD THAT SEPARATES THEM is on the row itself: a queue row records who put it back,
 * and a return is the only origin a person's own hands produce.
 *
 * AND NO SECOND LOCK IS WRITTEN HERE. A wake that must start clean is refused a continuation
 * by the argument builder, which has said so, thrown for it and been tested on it since long
 * before this. All this does is NAME the wake and let the existing rule act — the road the
 * conversation lane has always taken.
 *
 * FAIL-FRESH: an unreadable ledger, a missing row and a session id of the wrong shape all mean
 * a fresh session, never a wedged attempt. The shape is asked of the builder's own predicate so
 * this side cannot offer something the other side is obliged to throw on.
 */
function wakeSpawnOptions(deps, task) {
  const repeat = Number(task && task.attempt) > 1
  if (!repeat) return { wakeKind: 'new-task' }
  if (String(task && task.source) !== 'return') return { wakeKind: 'timer' }
  try {
    const prior = (deps.ledger && typeof deps.ledger.readAttempts === 'function' && deps.ledger.readAttempts(task.id)) || []
    for (let i = prior.length - 1; i >= 0; i -= 1) {
      const sid = prior[i] && prior[i].sessionId
      if (isResumableSessionId(sid)) return { wakeKind: 'return', resumeId: sid }
    }
  } catch {
    /* an unreadable ledger means a fresh session — never a wedged attempt */
  }
  return { wakeKind: 'return' }
}

/**
 * turnBudgetFor(deps, config, task) → сколько ходов получит ЭТА попытка, и по каким признакам.
 *
 * ГДЕ ЛЕЖИТ ПАМЯТЬ О СГОРЕВШИХ ПОТОЛКАХ, ЗНАЕТ ТОЛЬКО ТИК. Реестр попыток — его шов; решение,
 * какое число из тех потолков что-то значит, принадлежит `policy/turn-budget.mjs`. Поэтому
 * здесь только чтение строк и передача их как есть: развилка живёт в одном месте, а не в
 * двух, где второе однажды тихо разойдётся с первым.
 *
 * FAIL-OPEN И В ПРАВИЛЬНУЮ СТОРОНУ: нечитаемый реестр означает «ничего не горело», то есть
 * потолок по размеру работы. Обратное — считать нечитаемый реестр пожаром — останавливало бы
 * работу из-за сбоя диска, а не из-за самой работы.
 *
 * @returns {{cap:number|null, size:string, signals:object, escalatedFrom:number|null, ceiling:number, burnedCaps:number[]}}
 */
function turnBudgetFor(deps, config, task) {
  let rows = []
  try {
    rows = (deps.ledger && typeof deps.ledger.readAttempts === 'function' && deps.ledger.readAttempts(task.id)) || []
  } catch {
    rows = []
  }
  const burnedCaps = burnedTurnCapsOf(rows)
  return { ...taskTurnCap({ base: pipelineMaxTurns(config), task, burnedCaps }), burnedCaps }
}

/**
 * ЧТО ЗАДАЧА ГОВОРИТ О СЕБЕ — поля, которые человек вправе дописать ПОСЛЕ постановки и
 * которые видны в строке очереди. Обещание (`acceptance`) решает объявленный размер работы, а
 * значит и её потолок ходов; описание едет с ним заодно, потому что правится тем же нажатием.
 *
 * СНИМКА КОНТЕКСТА ЗДЕСЬ НЕТ, И ЭТО НЕ ЗАБЫВЧИВОСТЬ. Строка очереди его НЕ НЕСЁТ нарочно
 * (`taskContextOf` над строкой списка отвечает пустотой — так очередь и написана): снимок
 * едет на ВЫДАЧЕ, а не в списке. Дописать его в поле, которого в источнике нет, значило бы
 * завести провод, по которому никогда ничего не приедет. Правка снимка действует со следующей
 * выдачи, как о том и сказано у гейта слов.
 */
const PROMISE_FIELDS = Object.freeze(['description', 'acceptance'])

/**
 * refreshPromise(deps, task) → какие из полей обещания ПРИЕХАЛИ ПОСЛЕ ЗАХВАТА. Мутирует `task`.
 *
 * ЗАЧЕМ. Строка становится захватываемой в тот миг, когда она записана, а слова к ней человек
 * (или окно) дописывает следующим запросом — секундой позже. Между этими двумя мигами тик
 * успевает её взять, и дальше вся попытка живёт по объекту, который очередь отдала при
 * захвате: работа с уже написанным обещанием уходит в процесс объявленной ПУСТОЙ, то есть
 * мелкой, и получает базовый потолок вместо тройного. Замерено 02.09.2026: соседние куски
 * одной сборки, взятые после прихода слов, получили втрое больше ходов на ту же работу, а
 * взятый раньше — сгорел на ритуале сдачи, перешагнув потолок на один ход.
 *
 * СЛОВА ДОГОНЯЮТ, ПОКА ПОПЫТКА НЕ СТАРТОВАЛА. Спрашивается перед самым счётом потолка: всё,
 * что дописано к этому мигу, попадает и в решение «есть ли что дать», и в число на командной
 * строке (сборщик аргументов считает его от ЭТОГО же объекта). Окно между этим чтением и
 * запуском процесса — провизия рабочей копии — остаётся неприкрытым, и это названо вслух: там
 * счёт уже сделан, а второе чтение стоило бы второго списка на каждом проходе.
 *
 * ЧЕГО ЗДЕСЬ НАРОЧНО НЕТ: проекта. Он тоже правится той же дверью, но им уже провизится копия
 * и по нему выбрано дерево — переставить его на полпути значило бы увести попытку в другое
 * дерево посреди захода. Перестановка проекта действует со СЛЕДУЮЩЕЙ выдачи, как и было. Про
 * снимок контекста — там же, у `PROMISE_FIELDS`: его в строке списка нет вовсе.
 *
 * FAIL-OPEN: нечитаемая очередь и пропавшая строка означают «ничего не приехало», а не срыв
 * попытки. Сторож, роняющий работу из-за сбоя чтения, стоил бы дороже опоздавшего обещания.
 *
 * @returns {string[]} имена полей, которые изменились (пусто — ничего не приехало)
 */
async function refreshPromise(deps, task) {
  const adapter = deps.adapter
  let rows = []
  try {
    rows = (adapter && typeof adapter.list === 'function' && (await adapter.list({}))) || []
  } catch {
    return []
  }
  const fresh = Array.isArray(rows) ? rows.find((r) => r && r.id === task.id) : null
  if (!fresh) return []
  const moved = []
  for (const field of PROMISE_FIELDS) {
    if (fresh[field] === undefined) continue
    // Сравнение по СЕРИАЛИЗАЦИИ, потому что обещание бывает и строкой, и списком строк:
    // сравнение ссылок объявляло бы движением всякий список, приехавший из хранилища заново.
    if (JSON.stringify(fresh[field] ?? null) === JSON.stringify(task[field] ?? null)) continue
    task[field] = fresh[field]
    moved.push(field)
  }
  return moved
}

/**
 * turnSpendOf(lines) → `{turns, kinds}` — СКОЛЬКО ХОДОВ УШЛО И НА ЧТО.
 *
 * ЗАЧЕМ РАЗБИВКА. «Сожжено сто ходов» не говорит человеку, поднимать потолок или дробить
 * работу, а это ровно тот выбор, который ему предлагается. Сто ходов правок — работа, которой
 * не хватило места. Сто ходов запусков оболочки — доказательство, которое не сходится, и оно
 * заслуживает своей задачи, а не большего потолка на ту же. Разница видна только по роду.
 *
 * ЧТО СЧИТАЕТСЯ. `turns` — число с финального кадра CLI (его собственная арифметика; наша
 * рядом была бы вторым счётом, расходящимся с первым). Роды считаются по ВЫЗОВАМ
 * инструментов в кадрах помощника: имя инструмента приходит полем, и разбор текста команды
 * здесь был бы догадкой о том, что она делает.
 *
 * ПОЧЕМУ СУММА РОДОВ НЕ РАВНА `turns`. Один ход может позвать несколько инструментов, а может
 * не позвать ни одного. Это две РАЗНЫЕ меры одного прогона, и подгонять одну под другую
 * значило бы соврать в обеих; карточка называет их порознь.
 *
 * @param {string[]} lines — поток попытки, как он собран
 * @returns {{turns:number|null, kinds:{edits:number, runs:number, reads:number, other:number}}}
 */
export function turnSpendOf(lines) {
  const kinds = emptyTurnKinds()
  let turns = null
  if (!Array.isArray(lines)) return { turns, kinds }
  for (const line of lines) {
    if (typeof line !== 'string') continue
    const { event, frame } = parseClaudeFrame(line)
    if (!event || !frame) continue
    if (event.type === 'result') {
      // Последний терминальный кадр говорит за прогон — как и у распознавателя потолка выше.
      if (Number.isFinite(event.numTurns)) turns = event.numTurns
      continue
    }
    if (event.type !== 'assistant') continue
    const content = frame.message && Array.isArray(frame.message.content) ? frame.message.content : []
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue
      kinds[turnKindOf(block.name)] += 1
    }
  }
  return { turns, kinds }
}

/**
 * continuationSpawnOptions(deps, config, task, wake) → `{continuationSummary}` when the PREVIOUS
 * attempt of this task left a handover summary and this wake is allowed to read it, and `{}`
 * in every other case.
 *
 * ONLY ON THE RETURN BRANCH, and for the same reason the session is only continued there. A
 * person handing work back is objecting to something the last attempt did: what it tried, how
 * it ended and what it touched is exactly the context that makes the objection answerable. A
 * TIMER wake is the opposite case — the lease expired, the world moved on, and the picture the
 * last session ended with is no longer the picture outside. Dragging its summary along would
 * hand a fresh session a stale one and call it memory.
 *
 * THE PATH IS THE SAME EXPRESSION, ASKED A FOURTH TIME. The writer at the end of an attempt,
 * the spawn at its beginning and the card door all ask `attemptRunDir`; a fourth spelling here
 * would be a summary read from a directory nobody writes into — which looks exactly like a task
 * that has never been tried before.
 *
 * THE PREDECESSOR IS THE PREVIOUS NUMBER, not «the last row with a directory». The queue mints
 * attempt numbers in order and the run directory is named by the number; asking the ledger for
 * a runDir instead would let a row written by an older, differently-numbered try answer for the
 * one the person actually looked at.
 *
 * ABSENCE IS ORDINARY. A first attempt, a task older than this file, an unreadable directory —
 * all yield no key at all, and the builder then assembles the prompt exactly as it always did.
 */
function continuationSpawnOptions(deps, config, task, wake) {
  if (!wake || wake.wakeKind !== 'return') return {}
  const prior = Number(task && task.attempt) - 1
  if (!Number.isFinite(prior) || prior < 1) return {}
  const projectDir = taskTreeDir(deps, config, task)
  const dir = attemptRunDir({ runsDir: runsDirOf(projectDir), attemptId: attemptIdFor(task.id, prior) })
  const handover = readContinuation({ dir, fsImpl: deps.fsImpl })
  if (!handover) return {}
  // ОДНО ИМЯ НА ВСЕХ ШВАХ — `continuationSummary`. Швов пять: запись, тик, композитор,
  // строитель промпта и дверь карточки. Разъехавшиеся имена — самый дешёвый способ потерять
  // провод, и потерять его так, что ни одно дело этого не заметит.
  return { continuationSummary: handover.text }
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
export function documentGate(deps, task, cwd) {
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
 * WHAT THE DAEMON ITSELF PUT IN THE COPY. The personal layer (`.claude/`, `CLAUDE.md`), its own
 * state (`.sma/`), the linked dependencies and the task-context snapshot are the DAEMON's hand,
 * not the worker's — and the memory draft under `.claude/memory/` is REQUIRED of an answer by
 * lessonCheck, so counting it as dirt made «ответ обязан оставить урок» and «ответ обязан
 * оставить чистое дерево» mutually exclusive. Measured live 24.08.2026: «?? .claude/» closed
 * the answer door on a question round, the round went out «нет квитанции», and the queue burned
 * two more sessions re-asking.
 */
const FURNISHED_BY_DAEMON = Object.freeze(['.claude/', 'CLAUDE.md', '.sma/', 'node_modules/', TASK_CONTEXT_FILE])

/** The path out of one `git status --porcelain` line; a rename is named by where it landed. */
function porcelainPath(line) {
  let p = String(line).slice(3).trim()
  const arrow = p.lastIndexOf(' -> ')
  if (arrow !== -1) p = p.slice(arrow + 4)
  return p.replace(/^"|"$/g, '')
}

/**
 * workerDirt(porcelain) → `[{line, path}]` — то из грязного дерева копии, что оставил РАБОТНИК.
 *
 * ОДНО ВЫРАЖЕНИЕ, ДВА ЧИТАТЕЛЯ, И ЭТО НЕ УБОРКА. Одна и та же строка `git status` решает две
 * разные судьбы: дверь ответа закрывается по ней («дерево не чисто»), а хозяйский коммит по
 * ней же выбирает, ЧТО закоммитить за работника, которому песочница не дала это сделать самому.
 * Два прочтения одного правила означали бы дверь, считающую файл работой, и руку, считающую
 * тот же файл обстановкой, — то есть коммит мимо того, что судят, или суд над тем, чего в
 * коммите нет.
 *
 * ОТСЛЕЖИВАЕМЫЙ файл под теми же путями — по-прежнему работа работника: прощается только
 * НЕотслеживаемая обстановка, положенная сюда демоном.
 *
 * `include` — ИМЕНОВАННОЕ ИСКЛЮЧЕНИЕ ИЗ ИСКЛЮЧЕНИЯ, и оно есть ровно у одной полосы. Черновик
 * кузницы кладётся в `.claude/agents/` — под тот самый префикс, которым помечена обстановка
 * демона, — и её гейт требует, чтобы он был ЗАКОММИЧЕН. Без этой оговорки рука хозяина прошла
 * бы мимо единственного файла, ради которого полоса работала. Спрашивающий называет каталог
 * сам (`draftDirFor`), потому что знает вид черновика; общее правило остаётся общим.
 *
 * @param {string} porcelain
 * @param {{include?:string[]}} [opts]
 * @returns {{line:string, path:string}[]}
 */
function workerDirt(porcelain, { include = [] } = {}) {
  const kept = (Array.isArray(include) ? include : []).filter((p) => typeof p === 'string' && p.trim() !== '')
  return String(porcelain || '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => ({ line, path: porcelainPath(line) }))
    .filter(({ line, path }) => {
      if (line.slice(0, 2) !== '??') return true
      if (kept.some((f) => path === f.replace(/\/$/, '') || path.startsWith(f))) return true
      return !FURNISHED_BY_DAEMON.some((f) => path === f || path === f.replace(/\/$/, '') || path.startsWith(f))
    })
}

/** Слова коммита, который делает хозяин, — и причина, по которой его делает не работник. */
const HOST_COMMIT_SUBJECT = 'работа сессии, зафиксированная демоном за работника'
const HOST_COMMIT_BODY =
  'Песочница провайдера кладёт явный запрет записи на служебный каталог git копии — сколько бы ' +
  'каталогов ей ни назвали писаемыми, — поэтому сама сессия закоммитить не может. Коммит делает ' +
  'демон снаружи песочницы, на ветке работника и явными путями: берётся то, что оставил работник, ' +
  'и не берётся обстановка, поставленная в копию самим демоном.'

/** Сколько путей уходит в один `git add`: командная строка не бесконечна, а правок бывает много. */
const HOST_COMMIT_ADD_BATCH = 100

/**
 * hostCommitAfterSession(deps, {task, route, workDir}) → `{sha, files}`, если демон зафиксировал
 * за работника то, что тот оставил в копии, иначе `null`.
 *
 * ЧТО СЛОМАНО БЕЗ ЭТОГО, ЗАМЕРЕНО ЖИВОЙ ПРОБОЙ 03.09.2026. Сессия полосы codex дошла до конца
 * честно: файл написан, слова сказаны. А `git add` ответил `Permission denied` на `index.lock` —
 * потому что помощник песочницы, раздав право записи по названным корням, кладёт СЛЕДОМ явный
 * запрет на служебный каталог git (см. codexSandboxDeniesGitDir: тот же журнал показывает запрет
 * и на разрешённый корень, и на `.git` обычного клона). Работник запрет увидел, честно не полез
 * в обход индекса и закончил ход; попытка ушла `dirty_tree`, ноль коммитов, и на карточке был
 * виноват он. Право писать без каталога, в который сдают, — это половина права; вторая половина
 * не покупается никаким списком корней, потому что запрет сильнее разрешения.
 *
 * ПОЭТОМУ КОММИТ ДЕЛАЕТ ХОЗЯИН. Демон стоит СНАРУЖИ песочницы, его git не ограничен ничем — он
 * и фиксирует работу на ветке работника, ровно там, где её ждёт гейт. Это не поблажка гейту:
 * судить будет тот же reverify по тому же дереву, и красные тесты останутся красными.
 *
 * ГРАНИЦА УЗКАЯ, И ЭТО ГЛАВНОЕ. Рука срабатывает ТОЛЬКО там, где стена измерена
 * (`codexSandboxDeniesGitDir`), и ТОЛЬКО по тому, что оставил работник (`workerDirt`). Работник
 * полосы Claude ходит без песочницы и коммитит сам; забытый им коммит — его ошибка, и
 * замазывать её значило бы отнять у гейта единственный вопрос, который он задаёт про сдачу.
 * Пустое дерево, обстановка демона и чужая полоса — три отдельных `null`, и ни один из них не
 * создаёт коммита «чтобы был».
 *
 * FAIL-OPEN, НО ВСЛУХ: git не ответил или коммит не встал — попытка идёт дальше ровно как
 * прежде (её судьбу решит гейт), а промах ложится в журнал под своим именем. Молчание здесь
 * вернуло бы ту же карточку с виноватым работником, ради которой всё это и написано.
 *
 * @param {object} deps
 * @param {{task?:object, route?:object, workDir?:string, include?:string[]}} [args]
 * @returns {{sha:string, files:string[]}|null}
 */
function hostCommitAfterSession(deps, { task, route, workDir, include } = {}) {
  if (!deps || typeof deps.execGit !== 'function') return null
  if (typeof workDir !== 'string' || workDir.trim() === '') return null
  const taskId = (task && task.id) || null
  const config = (deps && deps.config) || {}
  // ПРОВАЙДЕР ЧИТАЕТСЯ ТЕМ ЖЕ ПРАВИЛОМ, ЧТО У СТРАЖА ПЕСОЧНИЦЫ: маршрут, потом профиль
  // работника, — иначе полоса, назвавшая исполнителя без слова о провайдере, прошла бы мимо.
  const worker = ((config.workers || []).find((w) => w && w.id === ((route && route.workerId) || null))) || null
  const provider = String((route && route.provider) || (worker && worker.provider) || 'claude')
  if (!laneAdapter(provider).deniesGitDir({ platform: deps.platform })) return null

  // `--untracked-files=all` — И ЭТО НЕ ПРИДИРКА К ФЛАГУ. По умолчанию `git status` СХЛОПЫВАЕТ
  // неотслеживаемый каталог в одну строку (`?? .claude/`), и рука, которая по этой строке
  // выбирает пути, видит либо всё дерево целиком, либо ничего: черновик кузницы, лежащий под
  // тем же каталогом, что и обстановка демона, стал бы неотличим от неё, а `git add` по
  // схлопнутой строке утащил бы в коммит и обстановку. Дверь ответа выше спрашивает то же
  // самое крупнее — ей достаточно знать, ЕСТЬ ли грязь; здесь нужно знать, ЧТО именно, и
  // правило «чьё это» обе читают одно (workerDirt).
  //
  // `core.quotePath=false` — ПО ТОЙ ЖЕ ПРИЧИНЕ: по умолчанию git отдаёт неанглийское имя
  // файла в восьмеричных escape-последовательностях внутри кавычек, и путь, снятый с такой
  // строки, не откроется ничем. Дверь ответа этого не замечает — она считает строки; рука,
  // которая по ним коммитит, потеряла бы ровно ту работу, чьё имя написано не по-английски.
  let dirty = ''
  try {
    dirty = String(
      deps.execGit(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'], { cwd: workDir }) || '',
    ).trim()
  } catch (err) {
    writeLog(deps, {
      type: 'task.host_commit_failed',
      taskId,
      detail: `git status в копии не ответил: ${String((err && err.message) || err)}`,
    })
    return null
  }
  if (!dirty) return null
  const mine = workerDirt(dirty, { include })
  if (mine.length === 0) return null

  // Сведение повтором по списку, а не набором: этот файл держит дисциплину «никаких ключевых
  // коллекций в памяти тика», и она проверяется чтением исходника, а не намерением.
  const paths = mine.map((d) => d.path).filter((p, i, all) => p !== '' && all.indexOf(p) === i)
  try {
    for (let i = 0; i < paths.length; i += HOST_COMMIT_ADD_BATCH) {
      deps.execGit(['add', '--', ...paths.slice(i, i + HOST_COMMIT_ADD_BATCH)], { cwd: workDir })
    }
    // `--no-verify`: хуки основного репозитория живут в общем каталоге git и написаны для
    // человека за клавиатурой; здесь их некому ни спросить, ни прочитать.
    deps.execGit(['commit', '--no-verify', '-m', HOST_COMMIT_SUBJECT, '-m', HOST_COMMIT_BODY], { cwd: workDir })
  } catch (err) {
    writeLog(deps, {
      type: 'task.host_commit_failed',
      taskId,
      detail:
        `демон не смог зафиксировать работу за работника в ${workDir}: ` +
        `${String((err && err.message) || err)} (путей: ${paths.length})`,
    })
    return null
  }

  let sha = ''
  try {
    sha = String(deps.execGit(['rev-parse', 'HEAD'], { cwd: workDir }) || '').trim()
  } catch {
    /* коммит уже встал; неназванный хеш — это плохая запись, а не отменённая работа */
  }
  // NEVER SILENT: человек, читающий историю ветки, обязан видеть, ЧЬЯ рука поставила коммит.
  writeLog(deps, {
    type: 'task.host_commit',
    taskId,
    sha: sha || null,
    files: paths.length,
    detail:
      `песочница работника запрещает запись в служебный каталог git копии — демон зафиксировал ` +
      `за него ${paths.length} путей${sha ? ` коммитом ${sha.slice(0, 12)}` : ''}: ${paths.slice(0, 6).join(' | ')}`,
  })
  return { sha, files: paths }
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
 * tell the attempt ever happened. EVERY refusal is SAID OUT LOUD in the operator's log —
 * except commits on the branch, which are not a refusal but ordinary code work — because a
 * door that closes without a word is how a missing base spent hours looking like a worker who
 * left no receipt, and how a live question round burned two extra sessions on 24.08.2026.
 *
 * THE NOTE IS REQUIRED, exactly as everywhere else. An answer nobody wrote down is not an
 * answer, and the note IS the artefact here — the receipt names the attempt whose journal
 * holds it, so what the founder acknowledges on the card is the worker's own words.
 */
function answerOnlyGate(deps, task, branch, workDir, noteWritten, base) {
  // NEVER SILENT — except for the one null that is not a refusal at all: commits on the branch
  // mean ordinary code work, and the code gate is its rightful judge. Every other null used to
  // close this door without a word, and on 24.08.2026 that silence cost a live circle: a worker
  // ended its round with a question, this door shut wordlessly, the round went out as «нет
  // квитанции», and the queue burned two more sessions re-asking the same question instead of
  // parking it for a person. The reason below names WHICH guard closed the door.
  const closed = (reason, detail) => {
    writeLog(deps, { type: 'task.answer_gate_closed', taskId: task.id, reason, detail })
    return null
  }
  if (typeof deps.execGit !== 'function') {
    return closed('no_git', 'нет git-поверхности — пустоту попытки доказать нечем, попытку решает гейт кода')
  }

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
    // This is the refusal that looked like an absent receipt for hours, so it says which of
    // the two things happened: nobody could name the point to count from.
    return closed(
      'unknown_base',
      `база копии неизвестна — считать не от чего, дверь ответа закрыта, попытку решает гейт кода ` +
        `(ветка=${branch || 'нет'} дерево=${workDir || 'нет'})`,
    )
  }
  // The counter that already exists in this file, told to answer «I cannot say» rather than
  // «zero» — for THIS door an unknown must never read as «the attempt is provably empty».
  const commits = countCommitsOnBranch(deps, base, workDir, { unknownAs: null })
  if (commits === null) {
    return closed('count_unknown', `git не смог посчитать коммиты от ${String(base).slice(0, 12)} в ${workDir} — пустота попытки не доказана`)
  }
  if (commits !== 0) return null // ordinary code work — the code gate judges it, nothing to say

  let dirty
  try {
    dirty = String(deps.execGit(['status', '--porcelain'], { cwd: workDir }) || '').trim()
  } catch (err) {
    return closed('status_failed', `git status в копии не ответил: ${String((err && err.message) || err)}`)
  }
  if (dirty) {
    const foreign = workerDirt(dirty)
    if (foreign.length) {
      // THE NAMES, not the fact: a person deciding whether this is unfinished code work or
      // some artefact standing in the copy needs to see WHAT git names.
      return closed(
        'dirty_tree',
        `дерево копии не чисто (строк: ${foreign.length}): ${foreign.slice(0, 6).map((d) => d.line).join(' | ')}`,
      )
    }
  }
  if (!noteWritten) {
    return closed('no_note', 'попытка доказуемо пуста, но записки о подходе нет — ответ, которого никто не записал, ответом не является')
  }

  return { receiptRef: answerReceipt(attemptIdFor(task.id, task.attempt)) }
}

// ═══════════════════════ ТРЕТИЙ ВЫХОД — РАБОТА БЕЗ ПРЕДМЕТА ═══════════════════════
//
// Дверей к завершённой работе было две: квитанция за код и документ за прозу; третья, «ответ
// без правки», открывалась под них. Ни одна не умела сказать ТО ЕДИНСТВЕННОЕ, чем кончается
// возвращённая карточка, чья жалоба уже закрыта: ПРЕДМЕТА НЕТ. Такой конец существовал только
// как отсутствие — «сделано, но коммитов нет», — а отсутствие на карточке читается как провал.
//
// ЦЕНА ЭТОЙ ДЫРЫ ИЗМЕРЕНА 31.08.2026. Работнику, не нашедшему предмета, дешевле было создать
// файл и тест, доказывающий существование этого файла, чем честно вернуться ни с чем: первое
// выглядит как работа, второе — как провал. Гейт при этом остался зелёным, потому что ни один
// его вопрос не касался того, О ЧЁМ работа.
//
// ЧТО ЗДЕСЬ СТРОИТСЯ: «предмета нет» становится ПЕРВОКЛАССНЫМ концом — со своим словом на
// карточке (`moot:`) и со своей квитанцией, называющей, ЧЕМ проверяли. Закон «демон решает по
// фактам, которые видит сам» не ослабевает ни на шаг: вывод объявляет работник, а улику
// ПРОВЕРЯЕТ демон — коммит должен существовать в копии, файл должен лежать на диске. Ни одна
// непроверенная улика квитанции не даёт.
/** Как выглядит короткий или полный хеш коммита — единственная форма улики, которую знает git. */
const SHA_RE = /^[0-9a-f]{7,40}$/i

/** The receipt a «предмета нет» outcome completes on: the attempt, and what was checked. */
function mootReceipt(attemptId, evidence) {
  return `moot:${attemptId}@${evidence}`
}

/**
 * mootEvidenceCheck(deps, workDir, evidence) → {verified, kind} | {reason}
 *
 * ЧЕМ ПРОВЕРЯЛИ, ПРОВЕРЕННОЕ ДЕМОНОМ. Две формы улики, и обе машинные:
 *   - ХЕШ КОММИТА — `git cat-file -t` в копии обязан ответить `commit`. Так проверяется самый
 *     частый вывод: «жалоба закрыта вот этим коммитом»;
 *   - ПУТЬ ФАЙЛА (можно с `:строкой`) — файл обязан лежать в копии. Так проверяется «смотрел
 *     вот сюда, требование там уже другое».
 * Всё остальное — команда, ссылка, фраза — записывается в журнал, но УЛИКОЙ НЕ СЧИТАЕТСЯ:
 * квитанция, которую нельзя перепроверить, ничем не отличается от слова.
 *
 * ПЕРВАЯ ПОДТВЕРДИВШАЯСЯ ПОБЕЖДАЕТ — квитанция называет одну, а не список: она нужна человеку,
 * чтобы открыть ровно одно место и увидеть то же, что видел работник.
 *
 * Никогда не бросает: git, отказавший на одной улике, не отменяет остальных.
 */
function mootEvidenceCheck(deps, workDir, evidence) {
  const io = resolveIo(deps.fsImpl)
  const seen = []
  for (const raw of Array.isArray(evidence) ? evidence : []) {
    const item = String(raw ?? '').trim()
    if (!item) continue
    seen.push(item)
    if (SHA_RE.test(item)) {
      if (typeof deps.execGit !== 'function' || !workDir) continue
      try {
        const kind = String(deps.execGit(['cat-file', '-t', item], { cwd: workDir }) || '').trim()
        if (kind === 'commit') return { verified: item, kind: 'commit' }
      } catch {
        continue // такого объекта в копии нет — улика не подтвердилась, ищем следующую
      }
      continue
    }
    // `путь:строка` — обычная форма ссылки на место в коде; проверяется сам путь.
    const rel = item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '')
    if (!rel || rel.split('/').includes('..') || !workDir) continue
    try {
      if (io.existsSync(join(workDir, rel))) return { verified: rel, kind: 'file' }
    } catch {
      /* нечитаемый путь — не улика, и не повод потерять остальные */
    }
  }
  return { reason: seen.length ? `ни одна улика не подтвердилась: ${seen.slice(0, 4).join(' | ')}` : 'улик не названо' }
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
    // ФАЙЛ ЕСТЬ, А ПРОЧЁЛ ЕГО НЕ РАЗБОР, А ИСКЛЮЧЕНИЕ — И ЭТО НЕ МОЛЧАНИЕ РАБОТНИКА. Работник
    // прошёл конвейер, черновик лежит в копии; упал НАШ разбор. Слово «нет урока» отправило бы
    // человека требовать от работника то, что он уже сделал, а чинить надо здесь — поэтому
    // отказ помечается как инструментальный и наверху получает своё слово исхода.
    return {
      ok: false,
      toolBroke: `разбор заметки урока упал на ${path}: ${String((err && err.message) || err)}`,
      reason: `заметка урока не читается: ${String((err && err.message) || err)}`,
    }
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
 * turnCapHitOf(lines, maxTurns) → `{turns}` when THIS attempt walked into the turn ceiling,
 * else null.
 *
 * WHY IT IS READ AT ALL. A worker given a ceiling stops at it in silence: no note, no receipt,
 * and an exit. That is the same shape a provider abort leaves behind, and for the same reason —
 * the run was ended from outside the work. Unread, such an attempt reached the window as «нет
 * квитанции» or «ошибка работника», which sends a person to fix something that was never wrong.
 * The ceiling is OURS: the honest answer is a bigger one or a smaller task, and neither can be
 * offered by a screen that does not know the ceiling was reached.
 *
 * THE LAST TERMINAL FRAME AND ONLY IT. A stream carries one `result` at its end; a run that
 * played on to a success after an earlier one is not a run stopped by a ceiling, so the scan
 * goes backwards, stops at the first terminal frame it meets, and judges that one.
 *
 * WHAT COUNTS AS THE SIGNAL, and this boundary is the whole design: the FIELD the CLI names the
 * outcome with, plus our OWN arithmetic — never the text of anything. A worker debugging
 * somebody else's ceiling says the sentence about exhausted turns out loud in his own output,
 * and an attempt declared capped for pronouncing it would be exactly the diagnosis by
 * eavesdropping the neighbouring recogniser refuses by name. Text matching is deliberately absent.
 *
 * THE FALLBACK IS NOT OPTIONAL. The word is the vendor's and can change with his next binary;
 * the turn count on the same frame and the ceiling we handed the process are both ours. So a
 * frame that errored after taking at least as many turns as the ceiling reads as a ceiling
 * reached whatever it calls itself. With no ceiling named there is nothing to compare against,
 * and the fallback stays silent rather than guessing.
 *
 * A FRAME THE VENDOR ENDED IS NOT THIS. It is answered by the recogniser above, and the two must
 * not both claim one run — a long attempt cut by an outage is an outage, not a ceiling.
 *
 * @param {string[]} lines — the attempt's stdout, as collected
 * @param {number|null} [maxTurns] — the ceiling this daemon itself put on the command line
 * @returns {{turns:number|null}|null}
 */
export function turnCapHitOf(lines, maxTurns = null) {
  if (!Array.isArray(lines)) return null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (typeof line !== 'string' || !line.includes('result')) continue
    const { event } = parseClaudeFrame(line)
    if (!event || event.type !== 'result') continue
    // the VENDOR ended this run, not us — the recogniser above owns it, and one run may not be
    // claimed by both
    if (event.terminalReason === 'api_error' || Number.isFinite(event.apiErrorStatus)) return null
    const turns = Number.isFinite(event.numTurns) ? event.numTurns : null
    if (event.subtype === 'error_max_turns') return { turns }
    const cap = Number(maxTurns)
    if (event.isError && Number.isFinite(cap) && cap > 0 && turns !== null && turns >= cap) return { turns }
    return null // the last terminal frame has spoken; an earlier one describes an earlier run
  }
  return null
}

/**
 * contextExhaustedOf(lines) → `{compactions, preTokens}` when THIS attempt ran out of context
 * window, else null.
 *
 * WHY IT IS READ AT ALL — the third way an attempt is stopped by something other than the work.
 * A run whose context window fills up is compacted by the CLI and carries on with a summary in
 * place of everything it had learned; do it two or three times and the session finishes with no
 * receipt and no note, having lost the plot rather than failed at it. The turn ceiling and the
 * provider's cut are already named; this one arrived at the exit gate INDISTINGUISHABLE FROM BAD
 * WORK, so a person was sent to look at code whose author had simply run out of room. The remedy
 * is a smaller task, and no screen can offer it without knowing the window filled.
 *
 * WHAT COUNTS AS THE SIGNAL, and the boundary is the same one the two recognisers above draw:
 * the CLI's own `compact_boundary` frame and the `trigger` field on it — never the text of
 * anything. A worker discussing compaction says the word out loud in its own output, and a
 * diagnosis made by eavesdropping is worse than the fault it replaces.
 *
 * ONLY `auto` COUNTS. An automatic compaction is the window filling up by itself — the fact this
 * function exists to report. A MANUAL one is a worker's own housekeeping, deliberate and often
 * cheap, and counting it would turn good practice into a failure reason. A frame whose trigger
 * the vendor did not state counts as neither: an unstated field is not evidence.
 *
 * AND ONLY THE MAIN SESSION'S. With subagent text forwarded onto this stream, a delegated
 * session's compaction rides here too — but a subagent's window filling is not the attempt's
 * window filling, and the subagent's own summary is handed back to a main session that never
 * saw its context. Provenance is already on every event, so the line is drawn by reading it.
 *
 * WHY A COUNT AND NOT A FLAG. Once is ordinary on a long piece of work and says «this was big»;
 * three times says the session has been living on summaries of summaries, which is the thing a
 * person is choosing to cut in half. The number goes to the operator's log rather than into the
 * verdict — the verdict is decided by what the attempt LEFT (see classifyFailure).
 *
 * @param {string[]} lines — the attempt's stdout, as collected
 * @returns {{compactions:number, preTokens:number|null}|null}
 */
export function contextExhaustedOf(lines) {
  if (!Array.isArray(lines)) return null
  let compactions = 0
  let preTokens = null
  for (const line of lines) {
    if (typeof line !== 'string' || !line.includes('compact_boundary')) continue
    const event = parseClaudeEvent(line)
    if (!event || event.type !== 'system' || !event.compaction) continue
    if (event.subagent === true) continue // a delegated window is not this attempt's window
    if (event.compaction.trigger !== 'auto') continue
    compactions += 1
    // THE BIGGEST THE WINDOW EVER GOT, not the last: what a person wants is the high-water mark
    // of the work, and the final compaction of a run is often the smallest of them.
    const pre = event.compaction.preTokens
    if (Number.isFinite(pre) && (preTokens === null || pre > preTokens)) preTokens = pre
  }
  return compactions > 0 ? { compactions, preTokens } : null
}

/**
 * КАДРЫ, КОТОРЫМИ CLI ГОВОРИТ О ФОНОВЫХ ЗАДАЧАХ СЕССИИ. Снято с живого потока 03.09.2026: за
 * кадром `result` шли `background_tasks_changed`, `task_updated`, `task_notification` — то есть
 * ход кончился, а работа продолжалась. Список закрыт и назван здесь один раз: кадр, о котором он
 * молчит, не читается вовсе — догадка о чужой схеме хуже, чем честное «не знаю».
 */
const BACKGROUND_FRAME_SUBTYPES = Object.freeze(['background_tasks_changed', 'task_updated', 'task_notification'])

/** Слова, которыми поставщик объявляет фоновую задачу ЗАКОНЧЕННОЙ. Всё прочее считается живым. */
const BACKGROUND_FINISHED = Object.freeze([
  'completed', 'complete', 'done', 'finished', 'failed', 'error', 'killed', 'cancelled', 'canceled', 'stopped', 'exited', 'timed_out',
])

/** Список фоновых задач кадра — под любым из трёх имён, которыми его пишут; иначе null. */
function backgroundListOf(frame) {
  for (const key of ['background_tasks', 'backgroundTasks', 'tasks']) {
    if (Array.isArray(frame[key])) return frame[key]
  }
  return null
}

/** Живой ли статус фоновой задачи: закончена только та, о которой это сказано словом. */
function backgroundLive(status) {
  return !BACKGROUND_FINISHED.includes(String(status ?? '').trim().toLowerCase())
}

/**
 * backgroundTurnEndOf(lines) → `{live, tasks, commands, source}`, когда ход КОНЧИЛСЯ ПРИ ЖИВОЙ
 * ФОНОВОЙ ЗАДАЧЕ, иначе null.
 *
 * ЧТО ЗДЕСЬ ЧИТАЕТСЯ И ПОЧЕМУ ЭТО ВООБЩЕ ЧИТАЮТ. `--print` разрешает закончить ход, не дожидаясь
 * фоновой задачи (`Bash run_in_background`), и работник этим пользуется, чтобы «не ждать» полный
 * набор: он пишет промежуточное слово («Tests are running in the background… Interim status»),
 * поток отдаёт `result success`, следом идут кадры о фоновых задачах — и ход кончен, а блок
 * журнала, который работник собирался написать ПОСЛЕ прогона, не написан никогда. Замерено в ночь
 * на 03.09.2026: 19 попыток закрыты как `no_journal`, каждая — час-два работы и повтор с нуля,
 * одна из них с одиннадцатью коммитами на ветке.
 *
 * ПОПЫТКУ ЗАКРЫВАЕТ ВЫХОД РЕБЁНКА, А НЕ ЭТОТ РАСПОЗНАВАТЕЛЬ, и порядок здесь важен. Тик ждёт
 * `onExit` (см. runSpawn) — то есть `result` никогда не был для него концом сессии сам по себе, и
 * поток продолжает собираться после него: кадры о фоне и ВТОРОЙ `result`, пришедшие следом, лежат
 * в тех же `streamLines`. Поэтому судить нужно не первый кадр, а КОНЕЦ потока — что осталось
 * живым, когда ребёнок ушёл. Ход, у которого фоновая задача успела закончиться и после неё пришёл
 * второй `result`, — обычный законченный ход, и эта функция о нём молчит.
 *
 * ДВА ИСТОЧНИКА, И ПЕРВЫЙ ГЛАВНЕЕ. Если поставщик вообще говорил о фоновых задачах — верим его
 * собственной бухгалтерии: `background_tasks_changed` приносит СНИМОК (список заменяется целиком),
 * `task_updated` / `task_notification` — одну строку (обновляется она одна). Если о фоне не
 * сказано ни кадра, читается НАШЕ собственное наблюдение запуска: вызов оболочки с
 * `run_in_background: true`, о конце которого поток не сказал ничего. Второе слабее первого и
 * названо в `source`, чтобы читатель отличал измерение от вывода.
 *
 * ЛОЖНАЯ ТРЕВОГА ЗДЕСЬ СТОИТ СЛОВА, А НЕ РАБОТЫ, и это граница намеренная: ответ спрашивают
 * ТОЛЬКО у попытки, которая и без него не проходит гейт из-за пропавшей записки или урока (см.
 * classifyFailure). Ни одна зелёная попытка не может быть отказана этой функцией — она лишь
 * называет своим именем отказ, который уже случился.
 *
 * ТОЛЬКО ГЛАВНАЯ СЕССИЯ. Ход подагента кончается внутри хода попытки, и его `result` — не конец
 * сессии; провенанс уже стоит на каждом событии, поэтому граница проводится чтением, а не догадкой.
 *
 * @param {string[]} lines — поток попытки, как он собран
 * @returns {{live:number, tasks:string[], commands:string[], source:string}|null}
 */
export function backgroundTurnEndOf(lines) {
  if (!Array.isArray(lines)) return null
  // Открытые фоновые задачи, как их назвал поставщик: плоский список — этот файл не заводит
  // ключевых коллекций (см. дисциплины наверху), а речь о горстке строк одной попытки.
  const open = []
  const commands = [] // что сессия отправила в фон СВОИМИ руками — словами её же вызова
  let vendorSpoke = false
  let sawResult = false
  for (const line of lines) {
    if (typeof line !== 'string') continue
    const { event, frame } = parseClaudeFrame(line)
    if (!frame || event.subagent === true) continue
    if (event.type === 'result') {
      sawResult = true
      continue
    }
    if (frame.type === 'assistant') {
      try {
        for (const block of toolUsesOf(frame)) {
          const input = block.input && typeof block.input === 'object' ? block.input : {}
          if (!SHELL_TOOLS.includes(String(block.name)) || input.run_in_background !== true) continue
          if (typeof input.command === 'string' && input.command.trim()) pushUnique(commands, input.command.trim().slice(0, 120))
        }
      } catch {
        /* нечитаемый кадр не учит ничему и не ломает ничего (fail-open) */
      }
      continue
    }
    if (frame.type !== 'system' || !BACKGROUND_FRAME_SUBTYPES.includes(String(frame.subtype))) continue
    vendorSpoke = true
    const list = backgroundListOf(frame)
    if (list) {
      // СНИМОК ЗАМЕНЯЕТ СОСТОЯНИЕ ЦЕЛИКОМ: кадр «список изменился» описывает весь набор, и
      // дописывание к прежнему оставило бы жить задачу, которую поставщик уже убрал.
      open.length = 0
      for (const item of list) {
        const t = item && typeof item === 'object' ? item : {}
        open.push({ id: String(t.id ?? t.task_id ?? t.taskId ?? open.length), status: t.status ?? null, name: String(t.description ?? t.command ?? t.name ?? t.id ?? 'фоновая задача').slice(0, 120) })
      }
      continue
    }
    const id = singleTaskIdOf(frame)
    if (!id) continue
    const known = open.find((t) => t.id === id)
    if (known) known.status = frame.status ?? frame.state ?? known.status
    else open.push({ id, status: frame.status ?? frame.state ?? null, name: String(frame.description ?? frame.command ?? id).slice(0, 120) })
  }
  if (!sawResult) return null // прогон, который не дошёл до своего конца, принадлежит другим распознавателям
  if (vendorSpoke) {
    const live = open.filter((t) => backgroundLive(t.status))
    return live.length ? { live: live.length, tasks: live.map((t) => t.name), commands, source: 'frames' } : null
  }
  // Поставщик о фоне не сказал ни слова — остаётся наше собственное наблюдение запуска.
  return commands.length ? { live: commands.length, tasks: [...commands], commands, source: 'tool_call' } : null
}

/** Имя фоновой задачи, о которой говорит одиночный кадр, — или null, если кадр её не назвал. */
function singleTaskIdOf(frame) {
  const id = frame.task_id ?? frame.taskId ?? frame.id ?? (frame.task && typeof frame.task === 'object' ? frame.task.id : null)
  return id === undefined || id === null || String(id).trim() === '' ? null : String(id)
}

/**
 * СЛОВА ЭТОГО КОНЦА, ОДНОЙ СТРОКОЙ И С ПОДСКАЗКОЙ. Причина без подсказки здесь бесполезна:
 * человек, читающий «журнал не дописан», не знает, что чинить, — а чинится это порядком хода.
 *
 * @param {{live:number, tasks:string[], source:string}} bg
 * @returns {string}
 */
export function backgroundTurnEndDetail(bg) {
  const named = Array.isArray(bg && bg.tasks) && bg.tasks.length ? `: ${bg.tasks.slice(0, 2).join(' · ')}` : ''
  return (
    `ход закончен при живой фоновой задаче (${(bg && bg.live) || 0}${named}) — журнал не дописан. ` +
    'Полный набор гоняйте в ПЕРЕДНЕМ плане (без run_in_background) и не заканчивайте ход, пока ' +
    'фоновая задача жива; блок журнала — записка о подходе и урок — последнее действие хода'
  )
}

/** Сколько букв последней ошибки едет на карточку: фраза, а не стена. */
export const TRANSCRIPT_ERROR_MAX = 200

/**
 * lastToolErrorOf(lines) → СЛОВА ПОСЛЕДНЕЙ ОШИБКИ ЭТОЙ ПОПЫТКИ, или null, если ошибок не было.
 *
 * ЗАЧЕМ ЭТО ЧИТАЕТСЯ. Карточка отказавшей ступени до сих пор несла имя гейта и только его —
 * «нет документа — стадия не оставила своего файла». Это правда о ПОСЛЕДСТВИИ и ничего о
 * причине: почему файла нет, знала одна стенограмма попытки, которую надо открыть, найти и
 * прочитать. Живой случай: пакетный вызов настроек упал на одном ключе, работник вежливо вышел
 * без файла, гейт честно отказал — и так три попытки подряд, каждая под одной и той же
 * подписью, пока причина лежала в потоке первой.
 *
 * ЧТО СЧИТАЕТСЯ ОШИБКОЙ, и граница здесь та же, что у соседних распознавателей: СОБСТВЕННОЕ
 * ПОЛЕ CLI на кадре результата инструмента — `is_error` — и текст, который этот же кадр
 * принёс. Не речь работника: сессия, обсуждающая чужую поломку, произносит слово «ошибка»
 * вслух, и диагноз по подслушанному был бы хуже той беды, которую он лечит.
 *
 * ПОСЛЕДНЯЯ, А НЕ ПЕРВАЯ. Работа идёт вперёд: ранняя ошибка чаще всего та, которую сессия
 * обошла и пошла дальше, а последняя — та, на которой всё кончилось. Поиск идёт с конца и
 * останавливается на первом же кадре с текстом; ошибка с пустым текстом сказать человеку
 * нечего, поэтому поиск продолжается дальше вглубь.
 *
 * ОШИБКА ПОДАГЕНТА — ТОЖЕ ОШИБКА ЭТОЙ ПОПЫТКИ, в отличие от переполненного окна по соседству:
 * окно подагента — не окно попытки, а вот делегированный вызов сделала именно эта попытка, и
 * упал он в её работе.
 *
 * @param {string[]} lines — поток попытки, как он собран
 * @returns {string|null}
 */
export function lastToolErrorOf(lines) {
  if (!Array.isArray(lines)) return null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (typeof line !== 'string' || !line.includes('tool_result')) continue
    const { event, frame } = parseClaudeFrame(line)
    if (!event || event.type !== 'user' || !frame) continue
    const blocks = toolResultsOf(frame)
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const block = blocks[b]
      if (!block || block.is_error !== true) continue
      const text = String(resultTextOf(block) ?? '').replace(/\s+/g, ' ').trim()
      if (text === '') continue // ошибка без слов человеку ничего не говорит
      return text.length > TRANSCRIPT_ERROR_MAX ? `${text.slice(0, TRANSCRIPT_ERROR_MAX)}…` : text
    }
  }
  return null
}

/**
 * stageRefusalDetail(gateDetail, transcriptError) → одна строка причины отказа ступени: чем
 * отказал гейт И на чём в последний раз споткнулась попытка.
 *
 * СОБИРАЕТСЯ В ОДНОМ МЕСТЕ, потому что читателей у неё двое — журнал оператора и карточка, — и
 * две сборки разошлись бы словами в первый же день. Пусто с обеих сторон — null: пустая строка
 * на карточке читается как «причина не записана», а это другое утверждение.
 *
 * @param {string|null|undefined} gateDetail
 * @param {string|null|undefined} transcriptError
 * @returns {string|null}
 */
export function stageRefusalDetail(gateDetail, transcriptError) {
  const parts = []
  if (gateDetail) parts.push(String(gateDetail))
  if (transcriptError) parts.push(`последняя ошибка в стенограмме: ${transcriptError}`)
  return parts.length ? parts.join(' · ') : null
}

/**
 * argMaxTurns(args) → the turn ceiling THIS spawn was actually given, read back off its own
 * argument array, or null.
 *
 * The number is taken from the command line rather than from config on purpose: the fallback
 * above compares against what the process really received, and a value read from anywhere else
 * would be a claim about the spawn instead of a reading of it. A spawn with no ceiling on it
 * answers null, and the fallback then stays quiet.
 */
function argMaxTurns(args) {
  if (!Array.isArray(args)) return null
  const at = args.indexOf('--max-turns')
  if (at < 0) return null
  const n = Number(args[at + 1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * argSandbox(args) → ПЕСОЧНИЦА, В КОТОРОЙ ЭТОТ СПАВН ПРАВДА СТОИТ, прочитанная с его же
 * командной строки, или null, когда её там нет.
 *
 * ЧИТАЕТСЯ, А НЕ ВЫЧИСЛЯЕТСЯ ЗАНОВО, по той же причине, что и потолок ходов рядом: конверт,
 * настройка и правило вывода — это утверждения о запуске, а массив аргументов — сам запуск.
 * 01.09.2026 разница между ними стоила окна подписки: по всем утверждениям работник получил
 * право писать, а сессия оказалась читающей, и назвать это было нечем — командная строка
 * никуда не записывалась.
 *
 * NULL — ЭТО УТВЕРЖДЕНИЕ, А НЕ ПРОБЕЛ: у полосы Claude флага песочницы нет вовсе (её границу
 * несёт `--allowedTools`), и ноль на этом месте читался бы как «песочницы не дали».
 */
function argSandbox(args) {
  if (!Array.isArray(args)) return null
  const at = args.indexOf('--sandbox')
  if (at < 0) return null
  const mode = args[at + 1]
  return typeof mode === 'string' && mode !== '' ? mode : null
}

/**
 * spawnRecordOf(spec) → ЧЕМ ЭТА ПОПЫТКА БЫЛА ЗАПУЩЕНА, в форме строки реестра:
 * `{bin, args, sandbox?}`.
 *
 * ПОЛНАЯ КОМАНДА, А НЕ ЕЁ ПЕРЕСКАЗ. Каталог прогона уже хранил её — но каталог живёт в копии
 * проекта и подметается, а строка реестра остаётся. Вопрос «под какой границей правда шёл этот
 * работник» задают ПОСЛЕ: когда копии нет, поток свёрнут, а на карточке стоит «ничего не
 * сделал». Пока ответа не было, отличить «работник ленился» от «ему не дали писать» было
 * нельзя ничем.
 *
 * СЕКРЕТОВ ЗДЕСЬ НЕТ ПО ПОСТРОЕНИЮ: массив аргументов собирают строители, которые сканируют
 * каждую произведённую строку, а всё, что похоже на учётные данные, едет ИМЕНАМИ переменных
 * окружения и в аргументы не попадает вовсе.
 */
function spawnRecordOf(spec) {
  if (!spec || typeof spec !== 'object') return undefined
  const sandbox = argSandbox(spec.args)
  return {
    bin: spec.bin ?? null,
    args: Array.isArray(spec.args) ? [...spec.args] : [],
    ...(sandbox ? { sandbox } : {}),
  }
}

/**
 * turnRecordOf(args, lines) → поля ходов для строки реестра: `{turnCap, turnsUsed, turnKinds}`.
 *
 * ОДНО ВЫРАЖЕНИЕ НА ОБА ПУТИ ЗАПУСКА. Потолок читается с ТОЙ ЖЕ командной строки, что и у
 * распознавателя упора выше (`argMaxTurns`), а не из настроек: настройка — это утверждение о
 * запуске, а массив аргументов — его чтение, и следующая попытка поднимает потолок именно от
 * прочитанного числа. Потолка на строке нет — ключ не пишется вовсе: отсутствие остаётся
 * отсутствием, а не превращается в ноль, который читался бы как «ходов не давали».
 *
 * @param {string[]} args — массив аргументов запуска, как он был собран
 * @param {string[]} lines — поток попытки
 * @returns {{turnCap?:number, turnsUsed?:number, turnKinds:object}}
 */
function turnRecordOf(args, lines) {
  const cap = argMaxTurns(args)
  const { turns, kinds } = turnSpendOf(lines)
  return {
    ...(cap === null ? {} : { turnCap: cap }),
    ...(turns === null ? {} : { turnsUsed: turns }),
    turnKinds: kinds,
  }
}

/**
 * classifyFailure({spawnError, providerAbort, exitCode, receipt, workerMarker}) → a
 * FAIL_REASONS code. Pure. Maps a non-completing outcome onto the failure taxonomy, sharpest
 * signal first:
 *   spawnError                     → 'runtime_offline'  (the process never ran)
 *   provider abort                 → 'provider_error'   (the run the worker did not end)
 *   turn ceiling reached           → 'turns_exhausted'  (the run WE ended, at our own ceiling)
 *   worker marker NEEDS_DECISION   → 'needs_decision'   (a call only a human can make)
 *   worker marker MISSING_ACCESS   → 'missing_access'   (credentials/permissions absent)
 *   red receipt + unusable tree    → 'env_broken'       (nothing could have run at all)
 *   red reverify receipt           → 'tests_red'        (targeted tests failed)
 *   nothing left + window filled   → 'context_exhausted' (the run that ran out of room)
 *   no receipt + nonzero exit      → 'agent_error'      (the worker crashed)
 *   no receipt + exit 0            → 'no_receipt'        (claimed done, never certified)
 *   green receipt + broken tool    → 'close_tool_broken' (OUR closing instrument crashed)
 *   green receipt + live background→ 'background_turn_end' (the turn ended before the journal did)
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
 * A TURN CEILING SITS DIRECTLY BELOW IT, for the same reason and with one difference. An
 * attempt cut at the ceiling left no note and no receipt because it was stopped, exactly like
 * one the vendor cut — so no judgement of what it left behind may stand. What differs is whose
 * decision ended it: this one was OURS, put on the command line by this daemon, and calling it
 * anything else would hide a number a person is entitled to change. The exit code the vendor's
 * binary happens to use for it is NOT part of the signal — it has never been measured, and an
 * unmeasured number must not quietly become half a diagnosis.
 *
 * A CONTEXT WINDOW THAT FILLED UP SITS MUCH LOWER, INSIDE THE RECEIPTLESS BRANCH, and the
 * distance between it and the two above is the whole judgement. A compaction is not a terminal
 * event: the run continues past it, so «the window filled» never proves the attempt was stopped —
 * only that it was working on summaries of its own context. It may therefore not overrule
 * anything the attempt actually LEFT. A worker's own closing marker is its own word and beats it;
 * a red re-verification is a measured fact about a branch and beats it; a green receipt with a
 * missing note names the omission a person still has to act on. Where the attempt left NOTHING —
 * no receipt at all — the filled window is the sharpest true thing anyone can say about it, and
 * it replaces «нет квитанции» / «ошибка работника», which sent a person to fix work that had
 * simply run out of room. The remedy is a smaller task, and only this word offers it.
 *
 * @param {{spawnError?:any, providerAbort?:object|null, turnCapHit?:object|null, contextExhausted?:object|null, exitCode?:number|null, receipt?:{verdict?:string,ref?:any}|null, workerMarker?:string|null, journalComplete?:boolean, closeToolError?:string|null}} [o]
 * @returns {string}
 */
export function classifyFailure({ spawnError, providerAbort, turnCapHit, contextExhausted, exitCode, receipt, workerMarker, journalComplete, lessonComplete, envUnfit, closeToolError, backgroundTurnEnd } = {}) {
  if (spawnError) return 'runtime_offline'
  if (providerAbort) return 'provider_error'
  if (turnCapHit) return 'turns_exhausted'
  if (workerMarker === 'NEEDS_DECISION') return 'needs_decision'
  if (workerMarker === 'MISSING_ACCESS') return 'missing_access'
  // КРАСНОЕ ОТ СРЕДЫ, А НЕ ОТ ВЕТКИ, И ЭТО РАЗНЫЕ ПОЧИНКИ. Красная перепроверка на дереве,
  // где зависимостей физически нет, ничего не говорит о работе: запуститься было не на чем.
  // Проверяется ТОЛЬКО поверх красного (зелёная перепроверка сама доказала, что среда цела),
  // и стоит выше tests_red — иначе человек уходит искать регрессию, а склад так и стоит пустой.
  if (receipt && receipt.verdict === 'red' && envUnfit) return 'env_broken'
  if (receipt && receipt.verdict === 'red') return 'tests_red'
  if (!receipt) {
    if (contextExhausted) return 'context_exhausted'
    return Number.isFinite(exitCode) && exitCode !== 0 ? 'agent_error' : 'no_receipt'
  }
  // ОТКАЗ НАШЕГО ИНСТРУМЕНТА СТОИТ ВЫШЕ ОБЕИХ ПРОПАЖ, И ЭТО ВЕСЬ СМЫСЛ СЛОВА. Записку и урок
  // закрывает инструмент; когда падает ОН, «нет записки» и «нет урока» — не наблюдения, а
  // обвинения работника, который всё сделал. Проверяется только поверх ЗЕЛЁНОЙ квитанции: без
  // неё судить нечего, и закон пропавшей квитанции остаётся сильнее (та же выправка, что у
  // пары no_journal / no_lesson ниже). Отдельно от provider_error и turns_exhausted выше:
  // те двое — про прогон, оборванный снаружи работы, а этот — про наш собственный код.
  if (receipt.verdict === 'green' && closeToolError) return 'close_tool_broken'
  // И ТРЕТЬЯ ПОДМЕНА СЛОВА НАД ТОЙ ЖЕ ПАРОЙ ПРОПАЖ — не «не объяснил», а «не успел». Записки и
  // урока нет потому, что ход кончился при живой фоновой задаче: работник отправил полный набор
  // в фон, сказал промежуточное слово, и блок журнала, который он собирался написать после
  // прогона, не получил своего хода. Спрашивается ТОЛЬКО поверх уже случившейся пропажи (см.
  // backgroundTurnEndOf: ложная тревога стоит слова, а не работы) и ниже отказа инструмента —
  // сломанный журнал сильнее, потому что там записку нечем было записать вовсе.
  if (receipt.verdict === 'green' && backgroundTurnEnd && (journalComplete === false || lessonComplete === false)) return 'background_turn_end'
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

/**
 * baseTopLevel(deps, base, cwd) → the names at the ROOT of the tree the copy was cut from,
 * or [] when git cannot say. One question, one call, and the answer is what «этого каталога
 * раньше не было» is measured against — never a hardcoded list of what the product contains,
 * which would go stale the first time the product grew a directory on purpose.
 */
function baseTopLevel(deps, base, cwd) {
  if (!base || !cwd || typeof deps.execGit !== 'function') return []
  try {
    return String(deps.execGit(['ls-tree', '--name-only', base], { cwd }) || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return [] // не смогли спросить — судить нечем, и распознаватель молчит
  }
}

/**
 * baseFileReader(deps, base, cwd) → чтение файла таким, каким он был В БАЗЕ ветки
 * (`git show <база>:<путь>`), или undefined, когда спрашивать не у кого.
 *
 * ЗАЧЕМ ОТДЕЛЬНОЕ ЧТЕНИЕ ВМЕСТО ТЕЛА DIFF'А. Список изменений берётся именами и БЕЗ патча —
 * строка реестра долговечна, а тело diff'а носит секреты. Вопрос «правка этого теста
 * содержательна или это один пробел» задаётся ровно одному файлу и ровно тогда, когда он уже
 * стал уликой, — поэтому база читается точечно, по имени, и только для него.
 *
 * FAIL-OPEN: нет базы, нет копии, нет шва к git — читателя нет вовсе, и распознаватель считает
 * правку содержательной, как и без этой пары рук.
 */
function baseFileReader(deps, base, cwd) {
  if (!base || !cwd || typeof deps.execGit !== 'function') return undefined
  return (rel) => String(deps.execGit(['show', `${base}:${String(rel).replace(/\\/g, '/')}`], { cwd }) || '')
}

/**
 * workShapeRefusal(deps, task, changed, base, workDir) → {reason, detail} | null — ТРЕТИЙ
 * вопрос выходного гейта: не «есть ли доказательство», а О ЧЁМ работа.
 *
 * ДВА ОТКАЗА, И ПОРЯДОК МЕЖДУ НИМИ — РЕШЕНИЕ, А НЕ СЛУЧАЙНОСТЬ:
 *   1. САМОЗАМКНУТЫЙ ТЕСТ — это ДЕФЕКТ, и он краснеет. Тест, все утверждения которого
 *      касаются файлов, добавленных этой же работой, не может покраснеть ни от одной поломки
 *      продукта: он говорит только о себе. Зелёный сьют с таким тестом — это зелёный,
 *      удостоверяющий ровно ничего, и именно им 31.08.2026 закрылась работа без предмета;
 *   2. НОВЫЙ КАТАЛОГ ВЕРХНЕГО УРОВНЯ — это ВОПРОС, и он ждёт человека. С работой может быть
 *      всё в порядке; чего у неё нет — так это мандата решить за человека, из чего состоит
 *      продукт. Перевыдача такой попытки дала бы тот же каталог во второй раз, поэтому слово
 *      стоит в AWAITS_A_PERSON, а не среди перевыдаваемых концов.
 * Дефект стоит первым: сломанное доказательство важнее вопроса об устройстве дерева, и
 * человек, которому показали вопрос вместо красного теста, чинит не то.
 *
 * FAIL-OPEN ЦЕЛИКОМ. Нет ответа git о списке изменений — нет и суждения: обвинить работу на
 * основании непрочитанного дерева было бы хуже той дыры, которую этот вопрос закрывает.
 */
function workShapeRefusal(deps, task, changed, base, workDir) {
  if (!changed || changed.answered !== true || !Array.isArray(changed.files) || !changed.files.length) return null
  if (!workDir) return null
  const io = resolveIo(deps.fsImpl)
  const inCopy = (rel) => join(workDir, String(rel).replace(/\\/g, '/'))

  const selfRef = selfReferentialTests({
    entries: changed.files,
    readFile: (rel) => String(io.readFileSync(inCopy(rel), 'utf8')),
    readBase: baseFileReader(deps, base, workDir),
    pathExists: (rel) => io.existsSync(inCopy(rel)) === true,
  })
  if (selfRef) {
    writeLog(deps, { type: 'task.self_referential_test', taskId: task.id, detail: selfRef.detail })
    return { reason: 'self_referential_test', detail: selfRef.detail }
  }

  const dirs = newTopLevelDirs({ entries: changed.files, baseTopLevel: baseTopLevel(deps, base, workDir) })
  if (dirs.length) {
    const detail =
      `работа завела каталог верхнего уровня, которого в дереве не было: ${dirs.join(', ')} — ` +
      `из чего состоит продукт, решает человек, а не побочный эффект задачи`
    writeLog(deps, { type: 'task.new_top_level_dir', taskId: task.id, detail })
    return { reason: 'new_top_level_dir', detail }
  }
  return null
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
 * ЗВОНОК В ЖИВОЙ ПОТОК. Рядом с журналом и по той же причине, что и он: тик рассказывает о
 * себе через переданный ему шов, а не тянется за хабом сам. Разница между двумя швами — в
 * адресате. Журнал читает тот, кто потом разбирает случившееся; живой поток смотрит человек,
 * который прямо сейчас ждёт, когда же поедет его задача.
 *
 * Кадр — ПОДСКАЗКА, а не истина: в нём имя события и числа, за точной картиной экран идёт в
 * опрос. Демон, которому шов не передали, звонит в никуда и работает как раньше.
 */
function ringLive(deps, frame) {
  if (typeof deps.emitEvent !== 'function') return
  try {
    deps.emitEvent(frame)
  } catch {
    /* a bell that fails to ring never wedges a tick */
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
 * codexSandboxBlocker(deps, task, route, envelope) → {reason, detail}, когда конверт даёт этой
 * задаче ПРАВО ПИСАТЬ, полоса ведёт в codex, а машина этого права не исполнит; иначе null.
 *
 * ЗАЧЕМ ОТКАЗ ЗДЕСЬ, А НЕ В СТЕНЕ. `codex exec --sandbox workspace-write` в непровизированном
 * доме не отказывается — сессия стартует читающей и молчит об этом. 01.09.2026 такая попытка
 * стоила окна подписки и кончилась «нет квитанции»: работник объяснял словами, что писать ему
 * не дают, а карточка показывала пустую работу. Отказ до спавна стоит ноль процессов и ноль
 * минут, а человек получает НАЗВАННУЮ причину и названный выход.
 *
 * ОДНО РЕШЕНИЕ, ДВА ЧИТАТЕЛЯ. Тот же ответ ловит и сборщик аргументов (build-args, шаг 5b) —
 * он последний пояс, мимо которого не проходит ни один путь спавна, включая кузницу. Здесь
 * решение спрашивается РАНЬШЕ только ради слова на карточке: брошенное из строителя, оно
 * приехало бы общим `runtime_offline`, под которым не видно ни песочницы, ни дома.
 *
 * И РАЗ РАНЬШЕ — ЗНАЧИТ ВОПРОС ПРОГНОЗА, А НЕ ФАКТА: ЭТО И БЫЛ НЕСШИТЫЙ ШОВ. Дома задачи в эту
 * секунду ещё нет на диске — его чеканит и засевает сборщик, — поэтому «лежит ли в нём след
 * установки» отвечало «нет» ВСЕГДА, и страж отказывал ДО ТОГО, как посев успевал лечь. Замерено
 * живой пробой записи 01.09.2026 после выпуска: в доме счёта лежал полный след, посев скопировал
 * бы его через полсекунды, а ни одна пишущая задача полосы codex не стартовала вовсе. Поэтому
 * спрашивается `codexWorkspaceWriteOutlook` — «провизирован дом задачи ИЛИ ляжет посев из дома
 * счёта», тем же правилом, каким сеет сам посев. Сборщик остаётся на факте: он смотрит уже
 * ПОСЛЕ посева, и там прогноз был бы догадкой о том, что уже случилось.
 *
 * `missing_access` — потому что это ровно оно и есть по словарю очереди: «нужен человек, не
 * хватает доступа». Установку песочницы проводит человек из элевированной оболочки; ни один
 * повтор попытки этого не изменит.
 *
 * DI-СТОРОЖА КАК У СОСЕДЕЙ: платформа и домашний каталог инжектируются, чтобы сьют гонял ветку
 * Windows на любой машине; невыясненный работник, отсутствующий аккаунт и не-codex маршрут
 * возвращают null — это чужие вопросы, и на них отвечают другие двери.
 */
function codexSandboxBlocker(deps, task, route, envelope) {
  const config = (deps && deps.config) || {}
  const worker = ((config.workers || []).find((w) => w && w.id === ((route && route.workerId) || null))) || null
  // ПРОВАЙДЕР ЧИТАЕТСЯ ТЕМ ЖЕ ПРАВИЛОМ, ЧТО У СБОРЩИКА АРГУМЕНТОВ: маршрут, потом профиль
  // работника. Иначе полоса, назвавшая исполнителя без слова о провайдере, прошла бы мимо.
  const provider = String((route && route.provider) || (worker && worker.provider) || 'claude')
  // СПРАШИВАЕТСЯ СВОЙСТВО ПОЛОСЫ, А НЕ ЕЁ ИМЯ: этот страж существует ровно для полос, чья
  // граница исполняется ЗАРАНЕЕ ПОДГОТОВЛЕННОЙ машиной, — у полосы, которая раздаёт гранты
  // флагами, отказывать не в чем.
  const lane = laneAdapter(provider)
  if (!lane.needsProvisionedSandbox) return null
  if (!worker || !worker.account || typeof worker.account !== 'object') return null
  // ЧТО КОНВЕРТ ДАЛ — ТЕМ ЖЕ ВЫРАЖЕНИЕМ, КАКИМ ЭТО ПРОЧТЁТ СПАВН. Второе прочтение грантов
  // здесь означало бы отказывать по одному конверту, а запускать по другому.
  const sandbox = lane.sandboxOf(envelopeSpawnOptions(envelope).allowedTools)
  if (sandbox !== 'workspace-write') return null

  let home
  try {
    home = codexHomeFor({ account: worker.account, taskId: task.id, homedir: deps.homedir })
  } catch {
    return null // дом не собрался — это скажет сборщик аргументов своими словами
  }
  const outlook = codexWorkspaceWriteOutlook({
    platform: deps.platform,
    home,
    // ИСТОЧНИК ПОСЕВА НАЗЫВАЕТСЯ НЕ ЗДЕСЬ: тот же счёт отдаётся сборщику аргументов, и путь
    // собирается одним выражением на обе двери (codexSandboxSourceFor).
    account: worker.account,
    homedir: deps.homedir,
    fsImpl: deps.fsImpl,
  })
  if (outlook.supported) return null
  return {
    reason: 'missing_access',
    // СЛОВА ОТКАЗА ЖИВУТ ОДНИМ ВЫРАЖЕНИЕМ РЯДОМ С ПРЕДИКАТОМ, А НЕ ЗДЕСЬ: тот же текст читает
    // сборщик аргументов (последний пояс), и две редакции одного отказа — это карточка и
    // журнал, говорящие разное про одну стену.
    detail: codexSandboxRefusal({
      sandbox,
      home,
      account: worker.account,
      homedir: deps.homedir,
      platform: deps.platform,
      fsImpl: deps.fsImpl,
    }),
  }
}

/**
 * workerSwitchedOffNow(deps, route) → `{reason, detail}`, если тумблер РОВНО СЕЙЧАС снят, иначе
 * `null`. Спрашивается в МОМЕНТ ЗАПУСКА, а не в момент маршрута, и в этом весь смысл.
 *
 * ЧТО СЛОМАНО БЕЗ ЭТОГО, замерено 02.09.2026. Тумблер работника читался там, где решался
 * маршрут, — и на этом чтение заканчивалось. А между маршрутом и первым процессом лежит
 * настоящая работа: копия отводится настоящим git, зеркало личного слоя пишет файлы на диск,
 * дом задачи засевается, каталог прогона создаётся. Это секунды, а на нагруженной машине —
 * десятки секунд. Человек, снявший тумблер в эту паузу, видел, как ВЫКЛЮЧЕННЫЙ работник всё
 * равно берёт задачу: две секунды после «выключить» — и чужая полоса уехала в сессию, которую
 * потом снимали рукой, а задачу переставляли заново. Со стороны это выглядит как «тумблер не
 * работает», и никакая запись нигде не говорила обратного.
 *
 * ПОЧЕМУ ЭТО НЕ ЛЕЧИТСЯ ВТОРЫМ ФИЛЬТРОМ В МАРШРУТИЗАТОРЕ. Маршрутизатор честно читает состав в
 * ту секунду, когда его спрашивают, и ошибки в нём нет вовсе: ошибка в том, что между ЕГО
 * секундой и секундой спавна проходит время, а решение живёт от первой до второй. Лечится это
 * только повторным вопросом — тем же самым, заданным там, где он наконец имеет цену.
 *
 * СОСТАВ ЧИТАЕТСЯ ИЗ `deps.config` В МОМЕНТ ВЫЗОВА и никуда не запоминается: дверь тумблера
 * подменяет `config.workers` целым новым списком, поэтому всякий, кто снял этот список раньше,
 * держит в руках прошлое. Ссылку на список эта функция не сохраняет ни на строку.
 *
 * ПЛАТНЫЙ КАНАЛ ТУМБЛЕРА НЕ ИМЕЕТ: маршрут без работника (`useApiFallback`) возвращает `null` —
 * выключать там нечего, и отказ был бы выдуманным.
 *
 * @param {object} deps
 * @param {{workerId?:(string|null)}} route
 * @returns {{reason:string, detail:string}|null}
 */
export function workerSwitchedOffNow(deps, route) {
  const workerId = route && typeof route.workerId === 'string' ? route.workerId : null
  if (!workerId) return null
  const workers = deps && deps.config && Array.isArray(deps.config.workers) ? deps.config.workers : []
  const held = workers.find((w) => w && w.id === workerId) ?? null
  if (held && held.enabled !== false) return null
  return {
    reason: 'worker_switched_off',
    // ДВА СЛУЧАЯ, РАЗЛИЧЁННЫЕ СЛОВАМИ, потому что человек делал два разных движения: снял
    // тумблер — или убрал работника из состава совсем.
    detail: held
      ? `работника «${workerId}» выключили, пока эта попытка готовилась, — процесс не запускается, работа возвращается в очередь`
      : `работника «${workerId}» убрали из состава, пока эта попытка готовилась, — процесс не запускается, работа возвращается в очередь`,
  }
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
 * writeJournal(deps, entry) → what the JOURNAL INSTRUMENT did with this layer.
 * FAIL-OPEN by construction: an unwritable or absent journal never wedges a tick.
 *
 * НО И НЕ МОЛЧА. Раньше исключение сюда входило и здесь же кончалось: слой не ложился на диск,
 * попытка шла дальше, и никто — ни тик, ни человек — не узнавал, что журнал сломан. Возврат
 * называет три РАЗНЫХ случая одним словом каждый: `'written'` — слой лёг; `'absent'` — шва
 * журнала у этого демона нет вовсе (сборка без реестра, это не поломка); `'broken'` — сток
 * БРОСИЛ, то есть инструмент закрытия попытки сломан здесь и сейчас. Судит эти слова
 * вызывающий; сама запись по-прежнему ничего не решает.
 *
 * @returns {'written'|'absent'|'broken'}
 */
function writeJournal(deps, entry) {
  if (typeof deps.decisionJournal !== 'function') return 'absent'
  try {
    deps.decisionJournal(entry)
    return 'written'
  } catch (err) {
    // NEVER SILENT: журнал не стоит попытки, но сломанный журнал стоит строки в логе — иначе
    // «записка есть» и «записки на диске нет» расходятся, и узнать об этом неоткуда.
    writeLog(deps, {
      type: 'journal-error',
      taskId: entry && entry.taskId,
      layer: entry && entry.layer,
      error: String((err && err.message) || err),
    })
    return 'broken'
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
    // ONE FRAME IS ONE READING OF THE WHOLE SUBSCRIPTION, AND BOTH WINDOWS ARE WRITTEN FROM IT.
    // Only the window the frame NAMED used to be filed, and the vendor names the weekly one
    // about once a day — so the board showed a week measured nineteen hours ago beside a
    // five-hour window measured a minute ago, and a person reading it asked why the two
    // disagreed with his own terminal. The parser now hands every window the frame spoke about
    // (`windows`); a frame that carried none falls back to the frame itself, which is exactly
    // what every frame from before this field existed looks like.
    const readings = Array.isArray(event.windows) && event.windows.length > 0 ? event.windows : [event]
    for (const observation of readings) {
      // A FRACTION WE HAD TO RE-INTERPRET IS SAID OUT LOUD. The window model reads the spent
      // share as a fraction of one, and no frame carrying a real one has ever been captured off
      // this machine — so if the vendor turns out to send PERCENTS, the guard in that model
      // silently rescales every reading, and silence is exactly what would keep a person from
      // ever learning the wire changed shape. The same line records a value it could place in
      // neither scale, because a dropped measurement is a fact about the subscription too.
      const { scale } = utilizationFraction(observation && observation.utilization)
      if (scale === 'percent' || scale === 'out-of-range') {
        writeLog(deps, {
          type: 'window-utilization-scale',
          account: accountName,
          limitType: (observation && observation.limitType) ?? null,
          raw: (observation && observation.utilization) ?? null,
          scale,
          reason:
            scale === 'percent'
              ? 'the vendor sent a spent share above one — read as PERCENT and divided by a hundred; ' +
                'capture this frame, the window model is documented for a fraction of one'
              : 'the vendor sent a spent share that is neither a fraction nor a percent — dropped, ' +
                'the window reads «нет данных» rather than a number nobody can place',
        })
      }
      markWindowObserved({ dataDir, accountName, observation, clock, fsImpl: deps.fsImpl })
    }
    // A WINDOW THE VENDOR SAYS IS NO LONGER ALLOWING WORK IS A CLOSE, AND A CLOSE OUTLIVES
    // EVERY OTHER FACT ON THIS LINE. This used to fire on `utilization >= 1` — a fraction the
    // stream has never once carried, which arrives here as 0 — so the condition was false on
    // every real machine and the refusal this call exists to persist was never written down.
    // It now fires on what the stream really says: the reading's own status.
    //
    // BUT ONLY FOR A WINDOW THAT CAN BE NAMED ON A SCREEN. This fired on ANY name, while the
    // read model draws only the two windows it knows — and on 31.08.2026 the two disagreed at
    // the worst possible place. The provider refused `seven_day_overage_included`, the weekly
    // window with the paid overage folded in, on an account whose paid channel is off and whose
    // ceiling is zero. Nothing about that name could reach a screen, and it shut the whole
    // account for five days: thirty tasks queued, no worker busy, while the window that really
    // governs answered `allowed_warning` at 74 % half an hour later. `canonicalWindow` is now
    // the single answer to «which windows exist», asked here and by the read model alike.
    if (readingSaysExhausted(event) && Number.isFinite(Number(event.resetsAt))) {
      if (canonicalWindow(event.limitType)) {
        markWindowClosed({ dataDir, accountName, resetAt: event.resetsAt, limitType: event.limitType, clock, fsImpl: deps.fsImpl })
      } else {
        // NOT SILENTLY. The reading is already filed above; what is withheld is the right to
        // stop the account, and an operator has to be able to see a refusal we declined to obey
        // — by name, so a window that turns out to matter can be added to the list on evidence.
        writeLog(deps, {
          type: 'window-refusal-unnamed',
          account: accountName,
          limitType: event.limitType ?? null,
          resetsAt: event.resetsAt ?? null,
          status: event.status ?? null,
        })
      }
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
  // this attempt's. Without a copy — a refusal that came before provisioning has none — the
  // segment alone is the best honest answer.
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

// Имя файла со снимком контекста В КОРНЕ РАБОЧЕЙ КОПИИ — `task_context.md`, рядом с правилами
// проекта, куда работник и придёт его читать. Имя НЕ пишется здесь второй раз: оно приходит
// от владельца — замороженного списка файлов каталога прогона, — потому что это ОДИН документ
// «что попытке дали» в двух экземплярах для двух читателей, и два написания одного имени
// разъехались бы в тот день, когда правят одно из них.

/** Пометка «этот навык положили МЫ» — сосед файла навыка внутри его же каталога. */
const BUILTIN_SKILL_MARK = '.sma-builtin-skill'

/**
 * materializeTaskContext(deps, task, workDir) — ЧТО ПОПЫТКА НАХОДИТ В СВОЕЙ КОПИИ.
 *
 * ОДНА ФУНКЦИЯ НА ОБЕ ДВЕРИ, и это не стилистика. Дверей провизии две — путь кода-работы и
 * путь Творца, — и правка одной из них оставляет мину во второй: этот класс уже дважды стоил
 * этому файлу отдельного разбора (флаг пути копии, объект строки копии). Второе написание
 * той же материализации разъехалось бы с первым в тот день, когда правят одно из них, и
 * работник одной из дорожек молча остался бы без контекста и без навыков.
 *
 * ПУТЬ КОПИИ НЕ СОБИРАЕТСЯ ЗДЕСЬ. Он приходит аргументом — тем самым, что ОТВЕТИЛ верб
 * провизии. Третье написание того же пути есть способ положить файл туда, куда уборке
 * смотреть не позволено: провизия и уборка уже согласованы по одному выражению, и вклиниться
 * между ними своей сборкой значит оставить после себя каталог, который никто не снимет.
 *
 * КАТАЛОГА КОПИИ МЫ НЕ СОЗДАЁМ. Его делает верб; если его на диске нет — писать в него
 * значит выдумать копию. Со снимком это ОТКАЗ (человек написал слова, и они обязаны доехать),
 * с навыками — громкая строка журнала: наши тексты полезны, но их отсутствие не делает
 * указание человека неверным.
 *
 * СЕКРЕТЫ РЕЖУТСЯ ПЕРВЫМИ, тем же поясом и по строкам, что у файлов каталога прогона. Иголки
 * берутся из среды САМОГО ДЕМОНА, а не из среды спавна: среда спавна на этом шаге ещё не
 * собрана, а собирается она ИЗ среды демона — значит здешний набор иголок шире, и это
 * ошибка в безопасную сторону.
 *
 * ВТОРОГО ПОТОЛКА НЕТ. Потолок применён у единственного входа — двери постановки, — и там он
 * ОТКАЗЫВАЕТ, а не режет. Вторая правда о длине разъехалась бы с первой молча.
 */
function materializeTaskContext(deps, task, workDir) {
  const io = resolveIo(deps.fsImpl)
  const snapshot = taskContextOf(task)
  const named = typeof workDir === 'string' && workDir.trim() !== ''
  let copyExists = false
  if (named) {
    try {
      copyExists = io.existsSync(workDir) === true
    } catch {
      copyExists = false // нечитаемый каталог — это отсутствие свидетельства, не бросок
    }
  }

  // ── СНИМОК ──────────────────────────────────────────────────────────────────────────────
  if (snapshot) {
    if (!copyExists) {
      throw new Error(
        `worktree ${workDir || 'без имени'} не существует — отказываюсь запускать попытку с копией без снимка контекста`,
      )
    }
    const safe = sanitizeRun(
      { lines: snapshot.split('\n') },
      { secretValues: secretValuesOf(deps.env || process.env) },
    ).lines.join('\n')
    try {
      // БЕЗУСЛОВНАЯ ПЕРЕЗАПИСЬ. Ретрай честно переиспользует копию, и файл прошлого захода
      // без перезаписи молча врал бы попытке о том, чего человек уже не просит.
      io.writeFileSync(join(workDir, TASK_CONTEXT_FILE), `${safe}\n`, 'utf8')
    } catch (err) {
      throw new Error(`снимок контекста не записан в копию: ${String((err && err.message) || err)}`)
    }
  } else if (copyExists) {
    // СНЯТЫЙ СНИМОК УБИРАЕТ ЗА СОБОЙ, И УБОРКА ОСТАВЛЯЕТ СЛЕД: удаление существующего файла
    // без строки в журнале — ровно то, чего дом не терпит.
    let stale = false
    try {
      stale = io.existsSync(join(workDir, TASK_CONTEXT_FILE)) === true
    } catch {
      stale = false
    }
    if (stale) {
      try {
        io.rmSync(join(workDir, TASK_CONTEXT_FILE), { force: true })
        writeLog(deps, {
          type: 'task.task_context_removed',
          taskId: task.id,
          detail: `снимок снят со строки — протухший ${TASK_CONTEXT_FILE} удалён из копии ${workDir}`,
        })
      } catch (err) {
        writeLog(deps, {
          type: 'task.task_context_remove_failed',
          taskId: task.id,
          detail: String((err && err.message) || err),
        })
      }
    }
  }

  // ── ВСТРОЕННЫЕ НАВЫКИ ───────────────────────────────────────────────────────────────────
  if (!copyExists) {
    writeLog(deps, {
      type: 'task.worker_skills_no_copy',
      taskId: task.id,
      detail: `каталога копии ${workDir || 'без имени'} нет на диске — встроенные навыки не положены`,
    })
    return
  }
  for (const skill of WORKER_SKILLS) {
    // ИМЯ КАТАЛОГА — ТОЛЬКО ИЗ ЗАМОРОЖЕННОГО СПИСКА ПРОДУКТА. Сырой строки человека в пути
    // нет ни на одном шаге, поэтому и санитизации здесь нечего делать: чистят вход, которого
    // не бывает, ровно там, где однажды заводят второй вход.
    const dir = join(workDir, '.claude', 'skills', skill.slug)
    const file = join(dir, 'SKILL.md')
    const mark = join(dir, BUILTIN_SKILL_MARK)
    try {
      let theirs = false
      try {
        // ЧЕЙ ЭТО ФАЙЛ — ВОПРОС ФАКТА, А НЕ ДОГАДКИ ПО ТЕКСТУ. Пометку ставим мы сами, когда
        // кладём свой экземпляр; догадка по содержимому объявила бы чужим наш собственный
        // файл в тот самый день, когда мы правим его текст, — и доводка перестала бы доезжать.
        theirs = io.existsSync(file) === true && io.existsSync(mark) !== true
      } catch {
        theirs = false
      }
      if (theirs) {
        // ПРАВИЛА ПОЛЬЗОВАТЕЛЯ ВЫШЕ НАШИХ. Одноимённый навык проекта выигрывает, и уступка
        // говорится вслух: молчаливая уступка неотличима от молчаливой перезаписи.
        writeLog(deps, {
          type: 'task.worker_skill_kept',
          taskId: task.id,
          detail: `навык ${skill.slug} есть у самого проекта — наш встроенный не кладётся поверх`,
        })
        continue
      }
      io.mkdirSync(dir, { recursive: true })
      // СВОЙ ЭКЗЕМПЛЯР ПЕРЕЗАПИСЫВАЕТСЯ БЕЗУСЛОВНО: доводка текста навыка обязана доезжать до
      // работника, иначе исправленный текст живёт у нас, а читают старый.
      io.writeFileSync(file, skill.body, 'utf8')
      io.writeFileSync(mark, `${skill.slug}\n`, 'utf8')
    } catch (err) {
      // ГРОМКО, НО НЕ СМЕРТЕЛЬНО. Отсутствие нашего текста не делает указание человека
      // неверным, а попытку — бессмысленной; молчания здесь нет, есть строка с причиной.
      writeLog(deps, {
        type: 'task.worker_skill_failed',
        taskId: task.id,
        detail: `${skill.slug}: ${String((err && err.message) || err)}`,
      })
    }
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
    // НАШИ ВСТРОЕННЫЕ НАВЫКИ ИЗ ЭТОГО СЧЁТА ВЫЧТЕНЫ, и это не косметика. Квитанция паритета
    // спрашивает «видна ли в копии поверхность САМОГО ПРОЕКТА»; с тех пор как копию обставляем
    // мы, в ней всегда лежат наши собственные навыки — и, посчитай мы их, квитанция стала бы
    // вечно зелёной, то есть мёртвой: она отвечала бы «да» и проекту без единого навыка.
    // Свои узнаём по пометке, которую сами и поставили при записи, а не по имени каталога.
    const ourSkills = (() => {
      try {
        return (io.readdirSync(join(workDir, '.claude', 'skills')) || []).filter((slug) => {
          try {
            return io.existsSync(join(workDir, '.claude', 'skills', String(slug), BUILTIN_SKILL_MARK)) === true
          } catch {
            return false
          }
        }).length
      } catch {
        return 0
      }
    })()
    return { skills: Math.max(0, count('skills') - ourSkills), agents: count('agents') }
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
  approach,
  tokens,
} = {}) {
  const config = deps.config || {}
  // THE SAME TREE THE COPY WAS CUT FROM — one source for both, so a run directory can never
  // end up beside a project the attempt never touched.
  const projectDir = taskTreeDir(deps, config, task)
  const runsDir = runsDirOf(projectDir)
  if (!runsDir) return null
  const io = resolveIo(deps.fsImpl)
  const env = (spec && spec.env && typeof spec.env === 'object') ? spec.env : {}
  const prompt = typeof (spec && spec.prompt) === 'string' ? spec.prompt : ''
  const rules = rulesInCopy(io, workDir, worktree)
  const skillsInCopy = skillsInCopyOf(io, workDir)
  // ЧТО ПРОФИЛЬ РАБОТНИКА ОБЕЩАЛ ЭТОМУ СПАВНУ — записывается ОТДЕЛЬНО от того, что спавн
  // получил. Обещание и исполнение это две записи; слив их в одну, квитанция профиля сверяла
  // бы аргументы с копией самих себя и была бы зелёной всегда. Работник ищется тем же
  // правилом, каким его нашёл сборщик аргументов, — по идентификатору маршрута.
  const profileWorker = (Array.isArray(config.workers) ? config.workers : []).find(
    (w) => w && w.id === ((route && route.workerId) || null),
  ) || null
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
      // `null` в поле — «профиль не назначил, значит по умолчанию CLI»; `null` вместо всего
      // объекта — «работника в конфиге нет», и это разные утверждения для читателя записи.
      profile: profileWorker ? { model: profileWorker.model ?? null, effort: profileWorker.effort ?? null } : null,
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
  // ШЕСТОЙ ФАЙЛ — СВИДЕТЕЛЬ СНИМКА, рядом с записью начала попытки и по ТОМУ ЖЕ пути: `dir`
  // сюда приходит от писателя, а не собирается здесь второй раз. Снимка на строке нет — не
  // зовём вовсе: отсутствие файла говорит «человек ничего не сказал», а пустой файл сказал бы,
  // что сказал и промолчал. Секреты — те же иголки, что у остальных пяти файлов.
  writeTaskContext({
    dir,
    text: taskContextOf(task),
    secretValues: secretValuesOf(env),
    fsImpl: deps.fsImpl,
    log: (entry) => writeLog(deps, entry),
  })
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
    // WHAT THE WORKER SAID IT WAS DOING, kept beside the outcome for the handover summary the
    // closing door writes. It is parsed once, off the stream, at the one point every lane
    // passes through; re-parsing it at the door would be a second reading of the same frames
    // and the two would drift the first time either changed.
    approach: approach ?? null,
    // ЧЕТЫРЕ ЧИСЛА ПОСТАВЩИКА — тем же путём и по той же причине, что и записка выше: кадр
    // разобран ОДИН раз, там, где книга трат его уже читает, и доезжает сюда, а не читается у
    // двери второй раз. `null` значит «финального кадра не было» — см. `bookAttemptUsage`.
    tokens: tokens ?? null,
    // THE NEEDLES THIS ATTEMPT'S SECOND BELT LOOKS FOR — taken from the spawn's own environment
    // HERE, where that environment is known, and carried to the closing door for the fifth
    // file. They live in memory for the length of one tick and are written into no record: the
    // row this object feeds names `runDir` and `parity` and nothing else of it.
    secretValues: secretValuesOf(env),
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
function writeAttemptOutcome(deps, worktree, receipt, task) {
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
  // the six receipts with their details beside the summary, so one directory can answer «did
  // this session really run under my rules» without a second command and without a second
  // opinion. A verdict that could not be computed stays null: «nobody has checked», never
  // «checked and fine».
  const parity = attachAttemptParity(deps, worktree)
  // ═══ И ПЯТЫЙ ФАЙЛ — КОНСПЕКТ ПЕРЕДАЧИ ═══════════════════════════════════════════════
  //
  // ПИШЕТСЯ ЗДЕСЬ, ПОТОМУ ЧТО ЗДЕСЬ ВПЕРВЫЕ ИЗВЕСТНО ВСЁ СРАЗУ. Подход попытка объявила
  // потоком, исход только что решила дверь, список тронутых файлов уже спрошен у git обеими
  // дверями, а замечание человека лежит на строке задачи. Собирать это где-то ещё значило бы
  // спрашивать те же вопросы второй раз и получать на них другие ответы.
  //
  // МОДЕЛЬ ДЛЯ ЭТОГО НЕ ЗОВЁТСЯ. Всё перечисленное уже записано; обращение к модели стоило бы
  // денег на КАЖДОЙ попытке и давало бы каждый раз другой текст об одних и тех же фактах.
  //
  // ПУТЬ НЕ СКЛЕИВАЕТСЯ ЗАНОВО: берётся каталог, который эта же попытка получила выражением
  // пути в начале, — иначе конспект лёг бы рядом с квитанцией, а не среди неё.
  const changed = (worktree && worktree.changed) || null
  writeContinuation({
    dir: run.dir,
    fsImpl: deps.fsImpl,
    log: (entry) => writeLog(deps, entry),
    // ТОТ ЖЕ ПОЯС, ЧТО У ОСТАЛЬНЫХ ФАЙЛОВ КАТАЛОГА: значения переменных, чьи ИМЕНА говорят
    // «секрет», вырезаются из текста. Записку о подходе пишет работник, и она может унести
    // в себе ключ ровно так же, как его уносила бы любая другая строка потока. Иглы сняты со
    // среды спавна ОДИН раз, там же, где она известна, — спрашивать её здесь второй раз было
    // бы вторым мнением о том, что в этой попытке считалось секретом.
    secretValues: run.secretValues || [],
    text: buildContinuationSummary({
      taskId: task && task.id,
      attempt: task && task.attempt,
      outcome: receipt && receipt.outcome,
      failureReason: receipt && receipt.failureReason,
      verdict: receipt && receipt.verdict,
      approach: run.approach && run.approach.approach,
      rejected: (run.approach && run.approach.rejected) || [],
      returnNote: task && task.note,
      files: (changed && changed.files) || [],
      deletions: (changed && changed.deletions) || [],
    }),
  })
  return writeRunReceipt({
    dir: run.dir,
    fsImpl: deps.fsImpl,
    log: (entry) => writeLog(deps, entry),
    receipt: {
      ...receipt,
      gate: run.gate || 'reverify',
      ...receiptFactsOf(run),
      // ЧЕМ ЭТА ПОПЫТКА ОБОШЛАСЬ, В ЧИСЛАХ ПОСТАВЩИКА. Они сняты с финального кадра потока в
      // одном месте — там же, где книга трат берёт свою строку, — и лежат ЗДЕСЬ, у попытки,
      // потому что книга отвечает про окно и про задачу, а спрашивают про попытку: строк на
      // задачу столько же, сколько попыток, и сложить их обратно в «вот эта» нечем.
      // `null` — «финального кадра не было», а не «ничего не потратили»: оценка, которую в
      // таком случае получает книга, честно названа оценкой и в измерение не переезжает.
      tokens: run.tokens ?? null,
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
    // A PARTIAL FRAME IS NOT PROOF OF LIFE. `stream_event` is a piece of a message that has
    // not finished — the vendor streams deltas for a generation that may never reach a whole
    // frame. Renewing the lease on one would let the watchdog be fed by a stream that has
    // delivered nothing, so only WHOLE frames renew. The daemon does not request partial
    // frames today; this guard is the decision standing even on the day somebody does.
    if (frame && frame.type === 'stream_event') return
    const t = now()
    if (t - lastTouchAt >= TOUCH_THROTTLE_MS) {
      lastTouchAt = t
      // A RENEWAL THAT CANNOT RUN IS WHY A LIVE WORKER GETS BURIED. This catch used to be
      // empty, and that silence is what let the lease renewal fail on every tick unnoticed:
      // the attempt kept streaming, the lease kept expiring, and nothing anywhere said the
      // two facts disagreed. Still fail-open — a broken renewal must never fail an attempt
      // that is doing its work — but it now leaves ONE line in the attempt's own log, where
      // the transcript and any later post-mortem will both find it.
      // WHOSE LEASE IS BEING RENEWED. Renewing by NAME alone means a worker whose own attempt
      // is long over keeps a STRANGER's lease alive — and the stranger, still working, looks
      // to every watcher like a task nobody is renewing. The token names the attempt that is
      // asking; the queue refuses a foreign one and answers false, which this fail-open catch
      // treats exactly as it treats any other unrenewed lease.
      Promise.resolve(deps.adapter.touch(task.id, { attemptToken: task.attemptToken })).catch((err) => {
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

/**
 * taskWorktreePath({taskId, projectDir, execGit}) → где стоит копия ИМЕННО ЭТОЙ задачи.
 *
 * ОДНО ВЫРАЖЕНИЕ НА ОБЕ ДВЕРИ ПРОВИЗИИ, и вот почему оно вообще понадобилось. Верб, если
 * ему не сказать пути, строит его сам — из identity того, кто зовёт. У человека за
 * терминалом identity своя на сессию, и всё сходится; у ДЕМОНА она одна на весь процесс и
 * на все задачи сразу, поэтому каталог копии выходил один, а ветки — по одной на задачу.
 * Пока копия жива и зарегистрирована, соседняя задача переиспользовала её молча; стоило
 * копии осиротеть (демон убит посреди попытки, регистрация потеряна) — каждая следующая
 * провизия отвечала «уже существует», попытка умирала ДО запуска, и в журнале это выглядело
 * как «среда исполнения недоступна». Замерено прошлой фазой: одна брошенная копия держала
 * конвейер мёртвым почти два часа, и сам он из этого не вышел.
 *
 * ОСНОВАНИЕ — ТО ЖЕ, ЧТО У ВЕРБА, и спрашивается тем же вопросом к git: каталог копий лежит
 * СОСЕДОМ основного дерева, а не внутри него (вложенная копия делает удаление способным
 * опустошить дерево, в котором она стоит). Меняется ровно последний сегмент: он теперь от
 * задачи. Git отвечает через переданный раннер — модуль не заводит собственной руки к git;
 * git молчит или его нет — остаётся каталог проекта, ровно как fail-open у верба.
 *
 * Имя задачи проходит через ту же санитизацию, которой названы каталог прогона попытки и
 * файл её леджера: строка из очереди становится именем на диске, и путь не собирается из
 * сырых знаков.
 *
 * @param {{taskId:string, projectDir:string, execGit?:Function}} opts
 * @returns {string|null} путь копии либо null — тогда вербу не говорят ничего и он решает сам
 */
function taskWorktreePath({ taskId, projectDir, execGit } = {}) {
  if (typeof taskId !== 'string' || taskId.trim() === '') return null
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  let mainRoot = projectDir
  if (typeof execGit === 'function') {
    try {
      mainRoot =
        smaRoot({
          cwd: projectDir,
          gitCommonDirFn: () => String(execGit(['rev-parse', '--git-common-dir'], { cwd: projectDir }) || '').trim(),
        }) || projectDir
    } catch {
      /* git отказал — основанием остаётся каталог проекта, как и у верба */
    }
  }
  return join(dirname(mainRoot), WORKTREE_COPIES_DIR, `wt-${safeName(taskId)}`)
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
 * discardFreshCopy — отозвать копию, которую ЭТА попытка только что отвела и НЕ ИСПОЛЬЗОВАЛА.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Копия отводится до того, как задаётся последний вопрос перед запуском, —
 * иначе этот вопрос нечего было бы задавать позже маршрута (см. workerSwitchedOffNow). Значит
 * между отведением и отказом лежит дорога, на которой копия уже есть, а процесса не будет
 * никогда. Каталог с рабочим деревом и ветка, отведённые ни для чего, — это не «немного мусора»:
 * следующая попытка получит ПЕРЕИСПОЛЬЗОВАННУЮ копию, а переиспользованная копия отвечает вербу
 * иначе, чем свежая (базы нет, вершина — сама ветка). Отзывается ровно то, что эта попытка
 * создала, и ровно тогда, когда стало ясно, что оно не понадобится.
 *
 * И ТОЛЬКО СВЕЖАЯ. `reused` — это чужая работа: копия, доставшаяся от прошлой попытки, несёт её
 * коммиты, а снятие ветки унесло бы их с диска. Такую копию не трогает никто, кроме суточного
 * обхода, и то через сутки после закрытия задачи.
 *
 * ГАРД ПУТИ — ТОТ ЖЕ, ЧТО У ОБХОДА (insideCopiesDir), и по той же причине: путь приходит из
 * ОТВЕТА внешнего верба, а уходит в команду удаления. Верб откажет и сам, но отказ на нашей
 * стороне означает, что для чужого пути он даже не запускался.
 *
 * Ничего не бросает: `invokeVerb` фейл-открыт, а неудачная уборка — это строка в журнале.
 */
async function discardFreshCopy(deps, verbRunner, { taskId, wt, path, branch, provisionDir } = {}) {
  if (!path || typeof verbRunner !== 'function') return
  if (wt && wt.reused === true) {
    writeLog(deps, {
      type: 'task.worktree_kept',
      taskId,
      branch,
      detail: 'копия досталась от прошлой попытки и несёт её работу — отзыву не подлежит, её уберёт суточный обход',
    })
    return
  }
  if (!insideCopiesDir(path)) {
    writeLog(deps, { type: 'task.worktree_discard_refused', taskId, branch, detail: `путь вне каталога копий: ${path}` })
    return
  }
  const res = await invokeVerb(verbRunner, 'worktree', ['remove', path, '--force', '--delete-branch', '--json'], provisionDir)
  const ok = res && res.ok === true
  writeLog(deps, {
    type: ok ? 'task.worktree_discarded' : 'task.worktree_discard_error',
    taskId,
    branch,
    detail: ok
      ? `копия отведена и не понадобилась — отозвана вместе с веткой (${path})`
      : `копию отозвать не удалось, на диске осталось: ${String((res && (res.error || res.message)) || 'верб не ответил')}`,
  })
}

/**
 * keepCodexSandboxJournal — снять с дома задачи строки песочницы О ПРАВАХ, ПОКА дом ещё есть.
 *
 * ЧТО БЫЛО СЛОМАНО. Помощник песочницы пишет единственную запись о том, какие права он раздал и
 * какие запреты положил, — и пишет её В ДОМ ЗАДАЧИ, который закрытие попытки выметает целиком.
 * То есть улику, по которой разбирают «почему у работника не получилось», уничтожал тот же
 * `finally`, что и мусор: разбор живой пробы 03.09.2026 пришлось вести по дому СОСЕДНЕЙ задачи,
 * случайно пережившей свою, — а дома самой пробы не осталось ни строки.
 *
 * ПОРЯДОК ЗДЕСЬ — ЭТО ВСЁ: сначала снять, потом убирать. Обратный порядок читал бы пустоту.
 *
 * Молчит, когда снимать нечего: дом без песочницы (не-Windows, непровизированная машина) не
 * ведёт журнала вовсе, и строка «журнала нет» была бы шумом на каждой второй попытке.
 */
function keepCodexSandboxJournal(deps, { home, taskId } = {}) {
  const seen = readCodexSandboxJournal({ home, fsImpl: deps.fsImpl })
  if (seen.lines.length === 0 && seen.denyReadPaths === null) return
  writeLog(deps, {
    type: 'task.codex_sandbox_journal',
    taskId,
    denyReadPaths: seen.denyReadPaths,
    detail: `права песочницы этой попытки, снятые до уборки дома (${home}); запретов чтения: ${
      seen.denyReadPaths === null ? 'снимок не прочитан' : seen.denyReadPaths
    }`,
    lines: seen.lines,
  })
}

/**
 * discardCodexTaskHome — убрать дом задачи полосы codex, когда попытка закрылась.
 *
 * ЗАЧЕМ ЗДЕСЬ, А НЕ У ТОГО, КТО ДОМ СОЗДАЁТ. Создаёт его сборщик аргументов, а знает, что попытка
 * КОНЧИЛАСЬ, только тик — и знает это на всех трёх исходах сразу: успех, провал и снятая рука
 * человека выходят через один и тот же `finally`. Уборка, повешенная на счастливую дорогу,
 * пропустила бы ровно те попытки, после которых мусора больше всего.
 *
 * ФЕЙЛ-ОПЕН И ВСЛУХ: неубранный каталог не меняет исхода попытки, но и не остаётся молчанием —
 * иначе о накоплении узнают так же, как узнали в этот раз: по месту на диске.
 */
function dropCodexTaskHome(deps, { home, taskId } = {}) {
  if (!home || !taskId) return
  keepCodexSandboxJournal(deps, { home, taskId })
  const res = discardCodexHome({ home, taskId, fsImpl: deps.fsImpl })
  if (res.removed) {
    writeLog(deps, { type: 'task.codex_home_discarded', taskId, detail: `дом задачи убран вместе с её временным каталогом (${home})` })
    return
  }
  writeLog(deps, {
    type: 'task.codex_home_discard_error',
    taskId,
    detail: `дом задачи остался на диске (${home}): ${res.reason}`,
  })
}

/**
 * recordApproachNote(deps, task, note) → `{noted, toolBroke}` — did THIS attempt leave a note,
 * and did the instrument that files it survive?
 *
 * Appends the approach layer when there is one. `noted` is about the NOTE, not about the
 * journal's disk: an unwritable journal must not fail a worker that did explain itself — that
 * law is unchanged and is why the two answers are separate. `toolBroke` carries the second
 * fact, which used to be thrown away here: the note existed, the instrument REFUSED it, and
 * the journal a person opens afterwards is empty through no fault of the worker's.
 * The note text is DATA — it is stored capped by the normalizer, and any later prompt that
 * shows it must fence it.
 *
 * @returns {{noted:boolean, toolBroke:string|null}}
 */
function recordApproachNote(deps, task, note) {
  if (!note || !note.approach) return { noted: false, toolBroke: null }
  const wrote = writeJournal(deps, {
    taskId: task.id,
    attempt: task.attempt,
    layer: 'approach',
    payload: note,
  })
  return {
    noted: true,
    toolBroke: wrote === 'broken' ? 'журнал попытки отказал на слое записки о подходе' : null,
  }
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
 *
 * ПРОБА ЗАДАЁТСЯ ПО КАЖДОЙ РОЛИ, КОТОРАЯ В ПУЛЕ ЕСТЬ, А НЕ ОДНА БЕЗРОЛЕВАЯ. Задача без слова о
 * роли просит исполнителя, поэтому одна такая проба спрашивала бы ровно «свободен ли
 * исполнитель» — и полоса, на которой ждёт работа, названная специалистом поимённо, оказалась
 * бы непригодной в тот момент, когда исполнители заняты, а названный специалист свободен.
 * Задача осталась бы в очереди, и сказать о ней было бы нечего: пригодность решается ДО
 * захвата, то есть до того, как хоть кто-то посмотрел на строку. Проб столько, сколько в пуле
 * РАЗНЫХ ролей (обычно одна-две), и полоса пригодна, если хоть одна из них нашла бегущего.
 *
 * ПУСТОЙ ПУЛ ПРОБУЕТСЯ ВСЁ РАВНО — ролью исполнителя: ответ на такой пробе даёт не работник, а
 * денежное правило (платный канал), и потерять эту пробу значило бы потерять сам переход на
 * платный канал на машине без работников.
 */
function eligibleLanes(deps) {
  const { routing, config, windows, clock } = deps
  const workers = Array.isArray(config.workers) ? config.workers : []
  // РАЗНЫЕ РОЛИ СОБИРАЮТСЯ СПИСКОМ И `includes`, А НЕ МНОЖЕСТВОМ. Дисциплина этого файла —
  // никаких ключевых коллекций в памяти процесса (журнал стережёт её grep-ом): состояние тика
  // живёт в очереди и на диске, а не в структуре, которая переживает перезапуск только в
  // головах. Ролей в пуле обычно одна-две, и цена линейного поиска здесь — ничто.
  const roles = []
  for (const w of workers) {
    if (!w || w.enabled === false) continue
    const role = roleOf(w)
    if (!roles.includes(role)) roles.push(role)
  }
  if (roles.length === 0) roles.push(EXECUTOR_ROLE)
  const out = []
  for (const lane of LANES) {
    const runnable = roles.some((role) => {
      const decision = routing.resolveRoute({ lane, role }, { workers, windows, clock, config })
      return decision && (decision.workerId || decision.useApiFallback)
    })
    if (runnable) out.push(lane)
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
 * ЭТА ПОСЛЕДНЯЯ ПОЛОВИНА ФРАЗЫ БЫЛА ОБЕЩАНИЕМ, А НЕ КОДОМ, и это вскрылось замером: строка
 * `batch.pin_unreadable` пишется только когда очередь БРОСИЛА, а закрепление, отпущенное по
 * любой другой причине, уходило молча. Два случая, и оба теперь названы вслух:
 *
 *   • `not_in_pool` — работник, за которым держалась сборка, из конфига исчез. Куски поедут
 *     другому, и человек, открывший журнал, узнает почему, а не будет гадать по строкам.
 *   • `no_worked_neighbour` — ЗАКРЕПЛЕНИЕ СТАЛО НЕЧИТАЕМЫМ, а не отпущено. Кусок, который уже
 *     вели, ставится заново (повтор сорвавшегося, возврат «переделай»), сам себя о работнике
 *     спрашивать нельзя (`exceptId`), а соседи по сборке ещё не отработали и работника не
 *     называют. Пустое закрепление тут выглядит РОВНО ТАК ЖЕ, как у первого куска свежей
 *     сборки, — но там сказать нечего, а здесь работник у сборки БЫЛ, и она меняет счёт молча.
 *     Различает их номер подхода самого куска: второй и дальше означает, что этот кусок вели.
 *   • `role_mismatch` — РОЛЬ ГЛАВНЕЕ ЗАКРЕПЛЕНИЯ, и здесь это сказано словами. Кусок без слова
 *     о роли просит ИСПОЛНИТЕЛЯ (policy/worker-role.mjs); сборка, закреплённая за СПЕЦИАЛИСТОМ,
 *     этому куску закрепление не отдаёт — иначе работа, названная исполнительской, поехала бы
 *     под чужим описанием агента, ровно та подмена, ради запрета которой роль и стоит первой
 *     строкой фильтра маршрута. Так что сборка честно расклеивается — и ГОВОРИТ об этом.
 *
 * ОБЕ ПРОВЕРКИ — НАРРАТИВНЫЕ, а не решающие: маршрутизатор отбросил бы такого закреплённого
 * сам, тем же фильтром роли, и порядок оставшихся от этого не менялся. Поэтому пул возвращается
 * ровно тот же, что и раньше, — прибавились только слова.
 *
 * ЧЕГО ЭТА ФУНКЦИЯ НЕ ЗНАЕТ И НЕ ПРИТВОРЯЕТСЯ, ЧТО ЗНАЕТ: окна, занятость и деньги — дело
 * маршрутизатора. Закрепление, отпущенное закрытым окном, называет своим словом ОН
 * (`window_exhausted`, `worker_busy`), и второй голос об этом же был бы вторым источником
 * правды о том, почему сборка сменила работника.
 *
 * Fail-open at every step: no adapter list, a throw, or nothing to prefer, and the pool comes
 * back exactly as configured.
 *
 * ЭКСПОРТИРОВАНА РАДИ ПРОБЫ. Правило «одна сборка — один работник» жило здесь и не было закрыто
 * ни одной проверкой: провод через тик доказывает, что куски достаются одному работнику, а
 * прямые случаи — что закрепление отпускается по названным причинам и со словами.
 */
export async function poolFor(deps, task) {
  const workers = (deps.config && deps.config.workers) || []
  if (!task || typeof task.batchId !== 'string' || task.batchId === '') return workers
  let pinned = null
  try {
    pinned = batchWorkerOf(await deps.adapter.list({}), task.batchId, task.id)
  } catch (err) {
    writeLog(deps, { type: 'batch.pin_unreadable', taskId: task.id, error: String((err && err.message) || err) })
    return workers
  }
  if (!pinned) {
    // ЗАКРЕПЛЕНИЕ, КОТОРОГО БОЛЬШЕ НЕ ПРОЧИТАТЬ, — ТОЖЕ СОБЫТИЕ, и до этой строки оно им не
    // было: обе названные причины говорят о закреплении, которое ЕСТЬ и которое отпускают, а
    // нечитаемое уходило молча. Молчание правдиво ровно про один из двух случаев, дающих здесь
    // пустоту, — про первый кусок свежей сборки, где работника ещё не было. Про второй —
    // кусок, который уже вели, — оно неправда: сборка меняет счёт, и никто об этом не говорит.
    //
    // СТРОКА НАРРАТИВНАЯ, А НЕ РЕШАЮЩАЯ: пул возвращается ровно тот же. Кому доставаться
    // повтору — тому, кто на куске сломался (у него копия и контекст), или свежему счёту (тот
    // уже исчерпал автоповторы) — решение владельца, и угадывать его тик не станет. Он говорит
    // лишь, что выбор БЫЛ сделан.
    if (Number(task.attempt) > 1) {
      writeLog(deps, {
        type: 'batch.pin_unreadable',
        taskId: task.id,
        batchId: task.batchId,
        attempt: Number(task.attempt),
        reason: 'no_worked_neighbour',
        detail:
          'кусок ставится заново, а работника сборки прочитать не с чего — ни один другой её ' +
          'кусок ещё не отработал; кого назовёт маршрут, тот сборку дальше и поведёт',
      })
    }
    return workers
  }
  const held = workers.find((w) => w && w.id === pinned) ?? null
  if (!held) {
    writeLog(deps, {
      type: 'batch.pin_let_go',
      taskId: task.id,
      batchId: task.batchId,
      workerId: pinned,
      reason: 'not_in_pool',
      detail: 'работника, за которым держалась сборка, в пуле больше нет — кусок поедет другому',
    })
    return workers
  }
  const wanted = roleWanted(task)
  if (!holdsRole(held, wanted)) {
    writeLog(deps, {
      type: 'batch.pin_let_go',
      taskId: task.id,
      batchId: task.batchId,
      workerId: pinned,
      reason: 'role_mismatch',
      role: wanted,
      pinnedRole: roleOf(held),
      detail:
        `кусок просит роль «${wanted}», а сборка закреплена за работником с ролью «${roleOf(held)}» — ` +
        'роль главнее закрепления, и сборка расклеивается по работникам',
    })
    return workers
  }
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
 * sessionStartRecord({spawnedAt, firstLineAt}) → `{ms, words}` — СКОЛЬКО СЕССИЯ СОБИРАЛАСЬ,
 * ПРЕЖДЕ ЧЕМ СКАЗАТЬ ПЕРВОЕ СЛОВО, сказанное так, чтобы это читал человек.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ПИШЕТСЯ. Снаружи у идущей попытки есть ровно один признак жизни — её вывод,
 * и до первого кадра любая пауза выглядит одинаково: «работник молчит N минут». Но эти паузы
 * разной природы. Полоса codex перед первым словом раздаёт песочнице право записи по каждому
 * писаемому корню, и на общем Temp машины это занимало минуты — процесс при этом совершенно
 * здоров и делает ровно то, что должен (замерено 02.09.2026: четыре минуты в одном запуске,
 * семнадцать в другом). Человек у окна в эти минуты решает, снимать попытку или ждать, и до сих
 * пор решал вслепую: «ещё готовит песочницу» и «повис» были для него одним и тем же молчанием.
 *
 * ЧИСЛО И СЛОВА ВМЕСТЕ, А НЕ ВМЕСТО. `ms` — измерение, по которому две попытки можно сравнить
 * («до правки — минуты, после — секунды»); `words` — то, что читается на карточке без пересчёта
 * в голове. Одно без другого здесь бесполезно: голое число нужно уметь прочитать, голая фраза
 * не складывается в замер.
 *
 * КАДРА НЕ БЫЛО — ЭТО ТОЖЕ ОТВЕТ, и он говорится вслух. `ms: null` плюс фраза о том, что голоса
 * не было: ноль прочитался бы как «заговорила мгновенно» — ровно наоборот к правде.
 *
 * @param {{spawnedAt?:number, firstLineAt?:(number|null)}} [args]
 * @returns {{ms:(number|null), words:string}}
 */
export function sessionStartRecord({ spawnedAt, firstLineAt } = {}) {
  if (!Number.isFinite(spawnedAt) || !Number.isFinite(firstLineAt) || firstLineAt < spawnedAt) {
    return { ms: null, words: 'первого кадра не было — сессия так и не подала голоса' }
  }
  const ms = firstLineAt - spawnedAt
  const sec = Math.round(ms / 1000)
  const said = sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин ${sec % 60} с`
  return { ms, words: `от запуска до первого слова сессии — ${said}` }
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
 *
 * ── И ЧЕТВЁРТОЕ ЧИСЛО: КОГДА СЕССИЯ ЗАГОВОРИЛА ────────────────────────────────────────────
 *
 * `firstLineAt` — минута ПЕРВОЙ строки, пришедшей из ребёнка, и ничего больше. Между спавном и
 * ней лежит подготовка, о которой снаружи не знает никто: полоса codex перед первым словом
 * раздаёт право записи по каждому писаемому корню, и на общем Temp машины это занимало минуты
 * (замерено 02.09.2026 — четыре в одном запуске, семнадцать в другом). Для человека у окна
 * такая пауза неотличима от повисшего работника, и разница между «ещё готовит песочницу» и
 * «молчит вторую минуту» до сих пор не была записана НИГДЕ.
 *
 * ЗАМЕРЯЕТСЯ ЗДЕСЬ, А НЕ В ЧИТАТЕЛЕ ПОТОКА, потому что это вопрос о ПРОЦЕССЕ, а не о смысле
 * его строк: разбор кадров начинается позже и умеет пропускать то, что не понял, — а «ребёнок
 * подал голос» верно для любой строки, включая ту, которую разборщик выбросит.
 *
 * КАДРА НЕ БЫЛО — `null`, а не ноль: ноль прочитался бы как «заговорила мгновенно», и это была
 * бы ровно та ложь, ради устранения которой поле заводится.
 */
function runSpawn(spawnWorker, spec, onLine, now = () => Date.now()) {
  return new Promise((resolve) => {
    let settled = false
    let firstLineAt = null
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve({ ...v, firstLineAt })
      }
    }
    const watchedLine = (line) => {
      if (firstLineAt === null) firstLineAt = now()
      if (onLine) onLine(line)
    }
    try {
      spawnWorker({
        ...spec,
        onLine: watchedLine,
        onExit: ({ code, signal } = {}) => done({ code: code ?? null, signal: signal ?? null, spawnError: null }),
        onError: (err) => done({ code: null, signal: null, spawnError: err }),
      })
    } catch (err) {
      done({ code: null, signal: null, spawnError: err })
    }
  })
}

/**
 * closeCoordinationSession(deps, {sessionId, cwd, taskId}) — END the coordination window this
 * attempt opened. Awaited, fail-open, and worth exactly one CLI call per attempt.
 *
 * ── ЧТО ЗДЕСЬ ЗАКРЫВАЕТСЯ, И ПОЧЕМУ ЭТО ДЕЛАЕТ ТИК ──────────────────────────────────────
 * Всякая сессия работника при старте регистрируется в координации: хук начала заводит окну
 * читаемое имя и лизу в общем каталоге проекта. Закрывает эту запись ПАРНЫЙ хук конца сессии —
 * и он живёт ВНУТРИ того самого процесса, который умирает. Процесс, убитый сторожем, оборванный
 * провайдером или ушедший по любой из дюжины дорог этого файла, парного хука не исполняет
 * вовсе. За вечер шести сгоревших попыток в реестре осталось шесть окон подряд, за которыми не
 * стоит ни одного процесса; их читает статус, по ним расходятся заявки на файлы, и живой
 * человек получает шторм ложных соседей.
 *
 * Поручать уборку тому, кого убирают, нельзя — поэтому закрытие стоит в тике, единственном
 * месте, которое ПЕРЕЖИВАЕТ попытку при любом её исходе, и вызывается из его последнего
 * `finally`, а не со счастливой дороги.
 *
 * АДРЕС ОКНА — ТОКЕН СЕССИИ, И БОЛЬШЕ НИЧЕГО. Имя файла лизы выводится из идентичности окна, а
 * идентичность — из токена; выводить её здесь значило бы завести второе мнение о вопросе, у
 * которого есть один ответ и одна библиотека. Тик называет вербу токен, который прочитал из
 * потока (то же число, которым он продолжает сессию после поправки), и разрешение имени
 * остаётся там, где выдавалось. НЕТ ТОКЕНА — НЕТ И ЗАКРЫТИЯ: демон не закрывает окна, о
 * котором ничего не знает, и молчание здесь честнее догадки.
 *
 * ГДЕ ОН ЕЁ ЗОВЁТ. В дереве ПРОЕКТА, а не в копии попытки: координационный корень у них общий
 * (он разрешается через основной чекаут), а дерево проекта переживает уборку копии.
 *
 * FAIL-OPEN И ВСЛУХ: отказ верба не стоит попытке ничего, но и молчанием не остаётся — иначе
 * закрытие могло бы перестать работать ровно так же незаметно, как незаметно не работал хук.
 */
async function closeCoordinationSession(deps, { sessionId, cwd, taskId } = {}) {
  const token = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!token || !cwd) return false
  const res = await invokeVerb(deps.verbRunner, 'session-end', ['--window-token', token], cwd)
  if (res && res.code === 0 && !res.error) {
    writeLog(deps, { type: 'task.session_closed', taskId, sessionId: token })
    return true
  }
  writeLog(deps, {
    type: 'task.session_close_failed',
    taskId,
    sessionId: token,
    detail: String((res && res.error) || `session-end вернул ${res && res.code}`),
  })
  return false
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
 *
 * И ТА ЖЕ РУЧКА ОТВЕЧАЕТ, ЖИВ ЛИ РЕБЁНОК. Аренда продлевалась ТОЛЬКО из потока вывода (см.
 * TOUCH_THROTTLE_MS), поэтому работник, думавший молча дольше срока аренды, для сторожа
 * выглядел ровно как повисший процесс — и трижды подряд честное молчание сгорало в failed.
 * Пробник живости регистрируется ВМЕСТЕ с остановкой, одной строкой и в одном месте: сторож
 * спрашивает у ручки, а не гадает по тишине. Запускатель без `alive` (или подделка в сьюте)
 * регистрируется как прежде — тогда ответ будет «не знаю», а не «мёртв».
 */
export function steeredSpawn(deps, taskId, spawnWorker, attemptId = null) {
  return (o) => {
    const h = spawnWorker(o)
    if (deps.attemptTurns && h && typeof h.kill === 'function') {
      deps.attemptTurns.register(
        taskId,
        () => {
          try {
            h.kill()
          } catch {
            /* a child that cannot be killed is still a turn the founder ended */
          }
        },
        typeof h.alive === 'function' ? () => h.alive() === true : undefined,
        // И ИМЯ ЗАХОДА — ВМЕСТЕ С РУЧКОЙ. Дверь отмены убивает по имени СТРОКИ, а место в доме
        // идущих попыток принадлежит заходу: без этого имени дверь освобождала бы места скопом
        // по строке и снимала бы место второго, живого захода той же работы.
        attemptId,
      )
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
 *
 * И ЧТО ОНО ВОЗВРАЩАЕТ. Четыре числа телеметрии поставщика — вход, выход, чтение кэша, запись
 * кэша, — снятые с того же самого финального кадра, что и строка книги. Дальше они едут в
 * квитанцию попытки: книга отвечает «сколько потрачено за окно», квитанция — «из чего сложился
 * счёт ИМЕННО ЭТОЙ попытки», и второй ответ нельзя получить из первого, потому что строк на
 * задачу много, а спросить человек хочет про одну.
 *
 * ЧИТАТЬ КАДР И ВЕСТИ КНИГУ — РАЗНЫЕ ОБЯЗАННОСТИ. Демон, собранный без книги, всё равно
 * оставляет квитанцию, и числа в ней не должны зависеть от того, подключён ли писатель книги:
 * иначе «у попытки нет чисел» означало бы то одно, то другое.
 *
 * NULL — ЭТО УТВЕРЖДЕНИЕ, А НЕ НУЛИ. Кадра не было вовсе (процесс убили, связь оборвали) —
 * значит, поставщик не сказал ничего, и в книгу идёт ОЦЕНКА, честно названная оценкой. Она не
 * имеет права попасть в поле, которое читается как «столько сообщил поставщик»: догадка в
 * измерении — это ложь, а не приближение.
 */
function bookAttemptUsage(deps, task, route, streamLines, now, startedAt) {
  // Книга — необязательный сосед: её отсутствие не отменяет чтения кадра (см. заголовок).
  const book = (row) => {
    if (typeof deps.bookUsage === 'function') deps.bookUsage(row)
  }
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
    // ЧЕЙ ЭТО ПОТОК — СПРАШИВАЕТСЯ У ТАБЛИЦЫ ПОЛОС. Читателей финального кадра ровно столько,
    // сколько поставщиков, и раньше выбор между ними стоял развилкой прямо здесь: третий
    // поставщик добавлялся бы в неё третьей веткой, а забытая ветка не падает — она молча
    // читает чужой кадр чужим читателем и книгует ноль. Полоса, о которой таблица молчит,
    // читается полосой по умолчанию — ровно так же, как читалась веткой `else` до неё.
    const lane = laneAdapter((route && route.provider) || undefined)
    for (let i = streamLines.length - 1; i >= 0; i -= 1) {
      const event = lane.finalEventOf(streamLines[i])
      if (!event) continue
      book(lane.usageFromFinal(event, { ...ctx, startedAt, endedAt: now }))
      return lane.tokensFromFinal(event)
    }
    // NO FINAL FRAME IN THE STREAM — see the header. The attempt still ran and still spent; the
    // book gets a line that says so and says, honestly, that it is an estimate.
    book(estimateUsage({ ...ctx, startedAt, endedAt: now }))
    return null
  } catch {
    /* the price of an attempt never fails the attempt */
    return null
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

/**
 * callWaiting(deps, now) — ЗОВ ЧЕЛОВЕКА К РАБОТЕ, КОТОРУЮ БЕЗ НЕГО НИКТО НЕ ДВИНЕТ.
 *
 * Читается свежим на каждом проходе, ровно как сигнал старения рядом, и по той же причине:
 * состояние ожидания принадлежит очереди, а не этому процессу. Здесь — только приёмка: строка
 * стоит завершённой и ждёт, чтобы её приняли или вернули, и вывести её оттуда может ТОЛЬКО
 * человек. Два других повода (работник упёрся; очередь исчерпала перевыдачи) — события, а не
 * состояния, и зовут о себе там, где случаются, — в `failTask`.
 *
 * ВЕСЬ ЗАПРЕТ НА ШУМ ЖИВЁТ В `summon`, а не здесь: этот проход честно отдаёт зову ВЕСЬ список
 * стоящих работ на каждом тике, и что из него станет словом — решение зова. Так дедуп нельзя
 * обойти вторым проводом.
 *
 * ОДНО СООБЩЕНИЕ НА ПРОХОД, А НЕ ПО СООБЩЕНИЮ НА РАБОТУ. Раньше проход звал по каждой строке
 * отдельно, тремя за тик, и десять стоящих работ превращались в десять сообщений подряд —
 * то есть в залп, который человек читает как аварию. Список уходит целиком, а зов говорит о
 * нём один раз: одна работа — своим текстом, много — сводкой.
 *
 * Fail-open целиком: нечитаемый список стоит одного несказанного слова, а тик, умерший на нём,
 * стоит всей раздачи работы.
 */
async function callWaiting(deps, now) {
  const { adapter, summon, journal } = deps
  if (!summon || typeof summon.raiseDigest !== 'function') return
  let rows = []
  try {
    rows = await adapter.list({ status: 'awaiting_approval' })
  } catch {
    return
  }
  if (typeof summon.keepOnly === 'function') summon.keepOnly('approval', rows.map((r) => r && r.id))
  const calls = []
  for (const row of rows) {
    if (!row || !row.id) continue
    // КОГДА ОЖИДАНИЕ НАЧАЛОСЬ — с момента, когда работа ОСТАНОВИЛАСЬ и стала должна человеку
    // слово, а не с постановки в очередь: это разные факты, и «сколько стоит» считают от
    // первого. Метку пишут оба хранилища очереди; там, где её нет, остаётся мерка постановки.
    calls.push({ taskId: row.id, title: row.title, since: toEpochMs(row.completedAt ?? row.enqueuedAt) })
  }
  if (calls.length === 0) return
  try {
    const out = await summon.raiseDigest({ kind: 'approval', calls })
    if (out && out.sent && typeof journal === 'function') {
      journal({ type: 'summon', kind: 'approval', taskIds: out.taskIds, count: out.taskIds.length })
    }
  } catch (err) {
    if (typeof journal === 'function') journal({ type: 'summon-error', error: String((err && err.message) || err) })
  }
}

/**
 * СКОЛЬКО ПОВТОРОВ ЗА ОДИН ПРОХОД — та же граница и по той же причине, что у зова рядом: проход
 * обязан вернуться к раздаче работы, а не разгребать вчерашний завал целиком. Остальные
 * повторятся следующим проходом, через пять секунд.
 */
const REPEATS_PER_TICK = 3

/**
 * repeatBroken(deps, now) — ПОВТОР ТОГО, ЧТО ДВИЖОК САМ НАЗЫВАЕТ ПОВТОРЯЕМЫМ.
 *
 * ЗАЧЕМ ЭТОТ ПРОХОД СУЩЕСТВУЕТ. Таксономия отказов давно делит концы надвое: за одним стоит
 * человек (`AWAITS_A_PERSON` — ровно потолок ходов), за всеми прочими стоит следующая попытка.
 * Вторая половина этого предложения не была ничьей работой. Измерено 31.08: три сборки простояли
 * сорвавшимися со вчерашнего дня и держали за собой десять невыданных работ; причина у всех трёх
 * — `provider_error`, чья подпись прямо говорит «попробуйте ещё раз». Повторили рукой — все три
 * пошли с первой попытки. Система написала «попробуйте ещё раз» и стала ждать человека.
 *
 * ПОЧЕМУ ЭТО ПРОХОД, А НЕ ВЕТКА В `failTask`. Повтор — не мгновенное следствие срыва, а
 * ОТЛОЖЕННОЕ: между ними стоит растущая пауза, и решение «пора» принимается по часам, а не по
 * событию. Дверь, повторяющая на месте, не умела бы ждать; а строка, сорвавшаяся при мёртвом
 * демоне, не дождалась бы своего повтора вовсе — проход же видит её на первом же тике после
 * подъёма. Ровно тем же соображением рядом живут подметания и единый журнал срывов.
 *
 * ЧТО ПОВТОРЯЕТСЯ И КОГДА — НЕ РЕШАЕТСЯ ЗДЕСЬ. Оба вопроса заданы словарю очереди
 * (`awaitsAutoRetry`, `autoRetryDueAt`), где живут и потолок, и пауза, и объяснение того и
 * другого человеку. Второе написание правила в тике разошлось бы с карточкой, которая по нему же
 * решает, спрашивать ли о куске владельца.
 *
 * И КАЖДЫЙ ПОВТОР НАЗВАН ВСЛУХ. Молчаливое повторение — это ровно то, что однажды стоило дня:
 * очередь тихо крутила работу, и в журнале не было ни строки об этом. Слова здесь — не украшение
 * отладки, а условие, при котором автоповтор вообще допустим.
 *
 * Fail-open целиком: нечитаемый список стоит одного несделанного повтора, а тик, умерший на нём,
 * стоит всей раздачи работы.
 */
async function repeatBroken(deps, now) {
  const { adapter } = deps
  if (!adapter || typeof adapter.reissue !== 'function') return 0
  let all = []
  try {
    all = await adapter.list({})
  } catch {
    return 0
  }
  // ПОСЛЕДНЕЕ СЛОВО О КАЖДОЙ ЗАДАЧЕ, А НЕ ВСЯКАЯ СТРОКА О НЕЙ. Долговременная очередь держит
  // закрытую строку рядом с перевыданной, и «сорвалась» на старой строке — это прошлое, а не
  // состояние: без свёртки проход повторил бы задачу, которую человек уже вернул и которая с тех
  // пор сделана. Свёртка — правило самой очереди, то же, которым читает экран.
  const rows = latestRowPerId(all)
  // СЛОВО ВЛАДЕЛЬЦА ГЛАВНЕЕ АВТОМАТА. Кусок, который он пропустил, и сборка, которую он бросил, —
  // это решения, принятые ЧЕЛОВЕКОМ о конкретной работе, и повтор, не знающий о них, воскресил бы
  // ровно то, что он отпустил. Правило спрашивается у очереди (`batchLetGoOf`), где живут и
  // остальные правила сборки: написанное здесь второй раз, оно разошлось бы с первым молча.
  const letGo = batchLetGoOf(rows)
  let repeated = 0
  for (const row of rows) {
    if (repeated >= REPEATS_PER_TICK) break
    if (!row || !row.id || !awaitsAutoRetry(row)) continue
    if (letGo.includes(row.id)) continue
    // ПАУЗА ЕЩЁ ИДЁТ — строка ждёт своей секунды, и это не повод её трогать. Сломанный канал,
    // в который бьются каждые пять секунд, — та самая петля, ради запрета которой пауза и есть.
    const due = autoRetryDueAt(row)
    if (Number.isFinite(due) && now < due) continue
    // КОТОРЫЙ ЭТО ПО СЧЁТУ ПОВТОР — считается ДО перевыдачи, по строке, которая ещё несёт свой
    // счёт попыток: после неё счёт уже другой, и «попытка N» назвала бы следующую.
    const attempt = autoRetriesSpent(row) + 1
    const reason = row.failure_reason ?? null
    try {
      const ok = await adapter.reissue(row.id)
      if (!ok) continue
    } catch (err) {
      writeLog(deps, { type: 'auto-retry-error', taskId: row.id, error: String((err && err.message) || err) })
      continue
    }
    repeated += 1
    writeLog(deps, {
      type: 'auto-retry',
      taskId: row.id,
      attempt,
      of: AUTO_RETRY_LIMIT,
      reason,
      said: `повторено само, попытка ${attempt} из ${AUTO_RETRY_LIMIT}`,
    })
  }
  return repeated
}

/**
 * ЧЕРЕЗ СКОЛЬКО СТОЯЩАЯ СБОРКА КРИЧИТ НАРУЖУ — пять минут, и это МИНУТЫ, а не часы.
 *
 * Порог вообще есть по одной причине: кусок сборки срывается и в ту же секунду закрывается
 * своей дверью, а следующий проход тика — через пять секунд. Звать человека мгновенно значило
 * бы звать его о состоянии, которое иногда живёт один тик.
 *
 * И порог МАЛЕНЬКИЙ по причине посерьёзнее: сюда доходит только та сборка, за куском которой не
 * стоит больше ни одной автоматической попытки (автоповторы к этому моменту исчерпаны — см.
 * `repeatBroken`), а очередь не выдаёт ни одного её оставшегося куска по устройству. Поэтому
 * каждая минута молчания здесь равна минуте простоя всего, что у этой сборки осталось.
 * Измеренная цена прежнего «порога в бесконечность» — 15 часов 12 минут на шести карточках.
 */
export const BATCH_STALL_MS = 5 * 60 * 1000

/**
 * СКОЛЬКО ЗОВОВ О ВСТАВШИХ СБОРКАХ ЗА ОДИН ПРОХОД. Зов уходит по сети, а тик обязан вернуться к
 * раздаче работы. Остальные позовутся следующим проходом — через пять секунд, а не через смену.
 *
 * У приёмки такой границы больше нет и она ей не нужна: там весь список уходит зову разом и
 * становится ОДНИМ сообщением. Здесь сообщение остаётся отдельным по сути повода — вопрос
 * задаётся о конкретном сорвавшемся элементе и без его имени не отвечается.
 */
const SUMMONS_PER_TICK = 3

/**
 * callStalledBatches(deps, now) — ЗОВ ЧЕЛОВЕКА К СБОРКЕ, КОТОРАЯ ВСТАЛА И ЖДЁТ ЕГО ВЫБОРА.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОХОД, А НЕ СТРОКА В `callWaiting`. Тот проход спрашивает очередь об одном
 * СТАТУСЕ (`awaiting_approval`), а вставшая сборка ни одним статусом не описана: её элемент
 * лежит просто `failed`, как всякий срыв, и ждущей её делает то, что над этим элементом стоит
 * ПОСТАНОВКА владельца, которой очередь подчиняется. Спросить об этом можно только всеми
 * строками разом — что этот проход и делает.
 *
 * ЧЕЙ ЭЛЕМЕНТ ДЕРЖИТ СБОРКУ — считается ПРАВИЛОМ ОЧЕРЕДИ (`brokenItemOf`), тем же самым, каким
 * очередь придерживает остальные куски и каким карточка рисует свой вопрос. Второе написание
 * этого правила здесь означало бы зов о куске, о котором карточка не спрашивает.
 *
 * ОБЫЧНЫЙ СРЫВ ЗДЕСЬ НЕ ПОВОД — и это не противоречие с соседом. Одиночная сорвавшаяся задача
 * либо повторится сама, либо позовёт из `failTask` своим поводом; а кусок сборки доходит до
 * этого прохода лишь тогда, когда его автоповторы кончились (`brokenItemOf` спрашивает ровно об
 * этом) — и тогда за ним стоит не следующая попытка, а человек.
 *
 * Fail-open целиком, как и у соседа: нечитаемый список стоит одного несказанного слова.
 */
async function callStalledBatches(deps, now) {
  const { adapter, summon, journal } = deps
  if (!summon || typeof summon.raise !== 'function') return
  let rows = []
  try {
    rows = await adapter.list({})
  } catch {
    return
  }
  const work = rows.filter((r) => !isBatchParent(r))
  // ЖИВЫЕ ОЖИДАНИЯ И ТЕ, О КОТОРЫХ ПОРА ГОВОРИТЬ, СОБИРАЮТСЯ РАЗДЕЛЬНО. Память подрезается по
  // ПЕРВОМУ списку: сборка, вставшая минуту назад, — ожидание уже живое, просто ещё не громкое,
  // и вычеркнуть её из памяти значило бы забыть, что о ней уже говорили час назад.
  const live = []
  const loud = []
  for (const req of rows.filter(isBatchParent)) {
    if (!req || !req.id) continue
    const { skipped, cancelled } = batchDecisionsOf(req)
    if (cancelled) continue
    const broken = brokenItemOf(batchItemsOf(work, req.batchId || req.id), skipped)
    if (!broken) continue
    live.push(`${req.id}:${broken.id}`)
    // КОГДА СБОРКА ВСТАЛА — отметка закрытия сорвавшейся строки. Её нет (строка старше отметки)
    // — зова нет: выдуманное «стоит с сейчас» позвало бы о простое, длины которого никто не
    // знает, и первое же такое сообщение научило бы человека не верить сроку в остальных.
    const since = toEpochMs(broken.completedAt)
    if (!Number.isFinite(since) || now - since < BATCH_STALL_MS) continue
    loud.push({ req, broken, since })
  }
  if (typeof summon.keepOnly === 'function') summon.keepOnly('batch', live)
  let called = 0
  for (const { req, broken, since } of loud) {
    if (called >= SUMMONS_PER_TICK) break
    try {
      const out = await summon.raise({
        kind: 'batch',
        taskId: req.id,
        title: req.title,
        itemId: broken.id,
        itemTitle: broken.title,
        since,
      })
      if (out && out.sent) {
        called += 1
        if (typeof journal === 'function') journal({ type: 'summon', kind: 'batch', taskId: req.id, itemId: broken.id })
      }
    } catch (err) {
      if (typeof journal === 'function') {
        journal({ type: 'summon-error', taskId: req.id, error: String((err && err.message) || err) })
      }
    }
  }
}

/**
 * cardIsClosed(ledger, taskId) → уже ли эта карточка закрыта человеком, по РЕЕСТРУ.
 *
 * Реестр попыток — единственная запись, которая переживает и уборку копии, и срок хранения
 * очереди: строку принятой работы pg-boss уносит в архив, и после этого спросить очередь о
 * закрытии карточки нельзя. FAIL-OPEN: нечитаемый реестр отвечает «не знаю» (false), и решение
 * остаётся за проверкой очереди — молчание файла не имеет права ЗАКРЫТЬ работу навсегда.
 */
function cardIsClosed(ledger, taskId) {
  if (!ledger || typeof ledger.readAttempts !== 'function' || !taskId) return false
  try {
    return closureOf(ledger.readAttempts(taskId) || []) !== null
  } catch {
    return false
  }
}

/** Intake per cadence — enqueue NEW ready backlog items; last-scan is threaded THROUGH the
 *  tick (deps.intake.lastScanAt in, result.intake.scannedAt out) so the tick stays stateless.
 *
 *  «NEW» — ЭТО ТЕПЕРЬ ПРОВЕРЯЕМОЕ СЛОВО, А НЕ ОБЕЩАНИЕ. Обход ставил в очередь КАЖДУЮ готовую
 *  строку файла на каждом заходе, а файл беклога ведёт человек: эта дверь его не правит и
 *  вычеркнутой строку не увидит, пока он сам её не вычеркнет. Слипание очереди спасало только
 *  то, что ещё ждёт или идёт (singletonKey держит `created`/`active`); работа ЗАКОНЧЕННАЯ —
 *  ждущая решения, принятая и слитая — заводилась заново, подходом номер два. Замерено
 *  31.08.2026: работа, принятая человеком в 11:12, вернулась в очередь ближайшим обходом.
 *
 *  ДВА ИСТОЧНИКА, ПОТОМУ ЧТО ОНИ МОЛЧАТ В РАЗНОЕ ВРЕМЯ. Очередь знает всё, что у неё ЕСТЬ —
 *  включая то, что ещё никто не запускал, — но забывает законченное по сроку хранения. Реестр
 *  не забывает ничего, но знает только о том, что уже закрыли. Ни один из них по отдельности
 *  не отвечает «эту строку уже брали в работу».
 *
 *  А ОЧЕРЕДЬ, КОТОРАЯ НЕ ОТВЕТИЛА, ОСТАНАВЛИВАЕТ ПОСТАНОВКУ ЦЕЛИКОМ. Цена ошибки здесь
 *  несимметрична: пропущенный заход стоит новой строке одного периода ожидания, а лишняя
 *  постановка — оплаченного прогона по уже принятой работе. Заход при этом ЗАСЧИТЫВАЕТСЯ
 *  (отметка едет наружу), иначе тик спрашивал бы сломанную очередь каждые несколько секунд. */
async function runIntake(deps, now, result) {
  const { adapter, config, journal } = deps
  const intake = deps.intake
  if (!intake || typeof intake.scan !== 'function') return
  const dueMs = (config.backlogScanMinutes ?? 60) * 60000
  const last = Number.isFinite(intake.lastScanAt) ? intake.lastScanAt : 0
  if (now - last < dueMs) return
  try {
    const scan = await intake.scan()
    const items = (scan && scan.items) || []
    const notReady = (scan && scan.notReady) || []
    // СПИСОК, А НЕ КЛЮЧЕВАЯ КОЛЛЕКЦИЯ: тик не держит ни одной — и это правило проверяется по
    // тексту файла, а не по области видимости (журнальный grep-гейт).
    let queued
    try {
      queued = (await adapter.list({})).map((r) => (r && r.id) || '').filter(Boolean)
    } catch (err) {
      if (typeof journal === 'function') journal({ type: 'intake-blind', error: String((err && err.message) || err) })
      result.intake = { scannedAt: now, enqueued: 0, known: [], notReady }
      return
    }
    let enqueued = 0
    const known = []
    for (const task of items) {
      const id = task && task.id
      if (id && (queued.includes(id) || cardIsClosed(deps.ledger, id))) {
        // НЕ ОШИБКА И НЕ ПРОПАЖА: строка файла жива, работа по ней уже есть. Названа в журнале
        // и в сводке захода, чтобы «обход ничего не поставил» читалось как ответ, а не как сбой.
        known.push(id)
        continue
      }
      try {
        await adapter.enqueue(task)
        enqueued += 1
      } catch (err) {
        // a NotReady / invalid item is journaled, never fatal (fail-open intake)
        if (typeof journal === 'function') journal({ type: 'intake-skip', taskId: id, error: String((err && err.message) || err) })
      }
    }
    if (known.length > 0 && typeof journal === 'function') journal({ type: 'intake-known', ids: known })
    // ОТКАЗ СКАНА НАЗЫВАЕТСЯ ВСЛУХ — рядом с «эту уже брали» и по той же причине. Строку,
    // отвергнутую воротами, журнал получал сам (enqueue бросает, и это поймано выше), а строка,
    // не дошедшая до ворот, не попадала никуда: обход молчал о ней и в журнале, и на экране.
    // Доска читает те же слова через deriveBacklog — это вторая половина одной правды, для
    // человека, который в журнал не смотрит.
    if (typeof journal === 'function') {
      for (const line of notReady) {
        journal({ type: 'intake-not-ready', taskId: line && line.id, reason: line && line.reason })
      }
    }
    result.intake = { scannedAt: now, enqueued, known, notReady }
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
  /**
   * МЕСТО В ДОМЕ ИДУЩИХ ПОПЫТОК, взятое этим проходом. Объявлено ЗДЕСЬ, выше общего try, по
   * единственной причине: отдать его обязан ЛЮБОЙ выход из тика — и ранний возврат, и провал,
   * и исключение. Забытое место дороже отсутствия потолка: конвейер встал бы навсегда и молча.
   */
  let seat = null
  /**
   * ОКНО КООРДИНАЦИИ, КОТОРОЕ ОТКРЫЛА ЭТА ПОПЫТКА — и которое обязано закрыться вместе с ней.
   *
   * Объявлено ЗДЕСЬ, выше общего try, по той же причине, что и место в доме: закрыть его
   * обязан ЛЮБОЙ выход из тика, а не счастливая дорога. Заполняется в момент, когда процесс
   * появляется (обе точки запуска — код и кузница), и читается ровно один раз, в `finally`.
   * Пустое поле `sessionOf` — «процесса не было или он не назвал сессии»: тогда закрывать
   * нечего, и молчание здесь честнее догадки.
   *
   * ТУТ ЖЕ ЕДЕТ И ДОМ ЗАДАЧИ полосы codex — по той же логике и в тот же `finally`. Он тоже
   * появляется в момент сборки команды на обеих дверях, тоже обязан исчезнуть на ЛЮБОМ исходе
   * (успех, провал, снятая рука человека), и тоже читается ровно один раз. Пустое поле —
   * «дома не чеканили»: полоса не codex, либо до сборки команды дело не дошло.
   */
  const attemptWindow = { sessionOf: null, cwd: null, taskId: null, codexHome: null }

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
      // AND THE KILL-HANDLE REGISTRY, which is what turns the sweep from a narrator into a
      // sweep: it declares an attempt dead and now stops that attempt's child BEFORE the task
      // is reissued. The registry is the SAME one the redirect and cancel doors use — handed
      // in here rather than reached for, so a daemon assembled without it sweeps as before.
      result.sweep = await livenessSweep({ adapter, ledger, clock, expireMs: resolveExpireMs(config), journal, attemptTurns: deps.attemptTurns })
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

    // (1c) ЕДИНЫЙ ЖУРНАЛ СРЫВОВ — строка на каждую сорвавшуюся задачу, один файл на все
    // проекты. ПОСЛЕ сверки намеренно: сверка дописывает в реестр попытки, которых никто не
    // видел, и слово о причине у них появляется именно там — проход, шедший первым, записал
    // бы «причина неизвестна» о срыве, объяснённом секундой позже.
    //
    // ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ПРОХОД, А НЕ ПОЛЕ У ДВЕРИ. Дверей, закрывающих работу срывом,
    // несколько, и одна из причин (`attempts_exhausted`) не пишется ни одной из них — она
    // выводится при ЧТЕНИИ строки задания. Журнал, собранный по дверям, молчал бы ровно о том
    // конце, который человек чаще всего и разбирает. Проход спрашивает очередь о том, что она
    // САМА называет сорвавшимся, и потому видит все концы разом.
    try {
      result.bugJournal = await sweepBugJournal({ adapter, ledger, clock })
    } catch (err) {
      if (typeof journal === 'function') journal({ type: 'bug-journal-error', error: String((err && err.message) || err) })
    }

    // (1d) THE COPIES OF CLOSED TASKS. Beside the sweeps above and for the same reason:
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

    // (2b-2) ПОВТОР ТОГО, ЧТО ПОВТОРЯЕТСЯ САМО — ПЕРЕД ЗОВАМИ, и порядок здесь смысловой, а не
    // технический: сначала машина делает всё, что решено за неё, и только то, что осталось после
    // этого, отнимает у человека внимание. Проход, стоящий после зовов, звал бы о работе, которую
    // сам же собирался перевыдать секундой позже, — и приучил бы не читать канал.
    try {
      result.repeated = await repeatBroken(deps, now())
    } catch (err) {
      if (typeof journal === 'function') journal({ type: 'auto-retry-error', error: String((err && err.message) || err) })
    }

    // (2c) ЗОВ ЧЕЛОВЕКА к работе, которая стоит на приёмке. Рядом со старением и по тому же
    // праву: оба сигнала — про работу, которая ЖДЁТ, и оба ходят на каждом проходе независимо
    // от того, взял ли этот проход хоть одну задачу. Разница между ними в адресате: старение
    // говорит очереди «эта строка залежалась», а зов говорит человеку «без вас не поедет».
    await callWaiting(deps, now())

    // (2c-2) …И К СБОРКЕ, КОТОРАЯ ВСТАЛА НА СОРВАВШЕМСЯ ЭЛЕМЕНТЕ. Тем же правом и тем же
    // проводом, что и приёмка выше: разница только в том, что ждущее состояние сборки не
    // описано ни одним статусом очереди и до этого прохода было видно ровно одному наблюдателю
    // — тому, кто открыл именно её карточку.
    await callStalledBatches(deps, now())

    // (2d) WHICH ECHELONS THEIR OWNER STOPPED — read from the register, never remembered by
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
    // (3a) ДВА ОГРАНИЧИТЕЛЯ ЗАХВАТА, И ПОТОЛОК — ТОЛЬКО ОДИН ИЗ НИХ. Спросить очередь и потом
    // отказаться от строки означало бы выдать задачу и тут же уронить её обратно: в
    // долговременной очереди выборка И ЕСТЬ захват. Поэтому проход при полном доме — простой,
    // и он назван вслух: пустая доска при работающих процессах ровно так и выглядела 12.08, и
    // понять это было нечем.
    //
    // ВТОРОЙ ОГРАНИЧИТЕЛЬ — СВОБОДНОЕ МЕСТО У РАБОТНИКА, и он появился здесь потому, что одного
    // потолка не хватало по устройству. Работников трое, потолок четыре — четвёртая строка
    // бралась при всех занятых и уезжала ЗАНЯТОМУ: маршрут отвечал «работник занят», а тик
    // отступал и перерешал маршрут без фильтра занятости. Замерено 02.09.2026: один работник
    // держал две живые сессии, доска показывала одну. Теперь мест не больше, чем работников
    // (`seatCeiling`), и число это читается ТАМ ЖЕ, где живёт потолок, — второе написание
    // разошлось бы с первым молча.
    const inFlight = deps.inFlight
    const cap = concurrencyCap(config)
    const seats = seatCeiling(config)
    // ТРЕТИЙ ОГРАНИЧИТЕЛЬ — И ОН ЖЕ ЕДИНСТВЕННЫЙ, КОТОРЫЙ ОТКРЫВАЕТ, А НЕ ЗАКРЫВАЕТ. Мест было
    // одно число на машину, общее для всех полос: четыре занятых полосой продукта означали, что
    // свободный работник канцелярской полосы не начнёт НИЧЕГО — в том числе ступень фазы, ради
    // которой он и включён. Полосы были разведены по работникам и не разведены по местам.
    // Закрепление читается там же, где живёт потолок, и по нему же тик спрашивает место дважды:
    // сперва из общего пула, а если общий кончился — ИМЕНЕМ ПОЛОСЫ, чьё место свободно.
    // Закрепляется место ТОЛЬКО за полосой, на которой есть кому работать: придержать место для
    // полосы, где ни один работник взять работу не может, значит просто потерять единицу потолка
    // (замерено делом: машина с одними исполнителями продукта переставала брать работу вовсе).
    // Список рабочих полос уже выведен выше маршрутом — второго его вычисления не заводится.
    const reserved = laneReservations(config, lanes)
    let claimLanes = lanes
    if (inFlight && typeof inFlight.reserve === 'function') {
      // Место берётся ОДНИМ синхронным шагом и ДО захвата. Иначе два проходящих внахлёст тика
      // оба увидели бы пустой дом (захват — это await), оба прошли бы потолок и оба взяли бы
      // по задаче — ровно то, ради чего потолок и заводится.
      //
      // НУЛЬ МЕСТ — ЭТО ОТКАЗ, А НЕ УМОЛЧАНИЕ. Дом при нуле выдал бы место по своему полу в
      // единицу, поэтому случай назван здесь и до него: работников не осталось ни одного, брать
      // работу некому, и это простой, а не работа.
      seat = seats >= 1 ? inFlight.reserve(seats, { reserved }) : null
      // ОБЩИЙ ПУЛ КОНЧИЛСЯ — НО У ПОЛОСЫ ЕСТЬ СВОЁ МЕСТО. Спрашивается только у полос, которые
      // МОГУТ работать прямо сейчас (у них свободен работник), и захват после этого сужается до
      // одной этой полосы: закреплённое место, отданное чужой работе, — это отсутствие
      // закрепления, написанное длиннее.
      if (!seat && seats >= 1) {
        for (const lane of lanes) {
          if (!reserved.has(lane)) continue
          const own = inFlight.reserve(seats, { reserved, lane })
          if (own) {
            seat = own
            claimLanes = [lane]
            writeLog(deps, {
              type: 'tick.lane_seat',
              detail: `общих мест нет, полоса "${lane}" берёт своё закреплённое место — захват сужен до неё`,
            })
            break
          }
        }
      }
      if (!seat) {
        writeLog(deps, {
          type: 'tick.concurrency_cap',
          detail:
            `идущих попыток ${inFlight.size()} при потолке ${cap} и ${seats} местах работников — ` +
            'задача в этом проходе не берётся',
        })
        // …И ТО ЖЕ САМОЕ — ЧЕЛОВЕКУ, В ЖИВОЙ ПОТОК. Отказ в месте жил только в журнале демона,
        // то есть был виден лишь тому, кто уже пошёл его искать. Снаружи это выглядело как
        // «доска пустая, работники свободны, а ничего не едет» — ровно та немота, из-за которой
        // ошибку с потолком не могли уличить весь день. Кадр несёт объявленный потолок и число
        // мест, которое из него вышло после второго ограничителя.
        ringLive(deps, { event: 'seats.full', inFlight: inFlight.size(), cap, seats })
        result.idle = true
        result.concurrencyCap = { inFlight: inFlight.size(), cap, seats }
        return result
      }
    }
    // …И ТОТ ЖЕ ВОПРОС ПОИМЁННО. Счёт мест выше держит границу числом; этот рубеж спрашивает
    // ИМЕНА — тот же источник, из которого маршрутизатор берёт свой фильтр занятости. Он остаётся
    // на случай, когда дом мест не раздаёт вовсе (шов собран без него), и говорит человеку своим
    // словом: не «мест нет», а «все работники уже ведут попытку».
    if (inFlight && typeof inFlight.workers === 'function') {
      const busyNow = inFlight.workers()
      // КТО ЗДЕСЬ РАБОТНИК — СПРАШИВАЕТСЯ ТЕМ ЖЕ СЛОВОМ, ЧТО И У СЧЁТА МЕСТ. Своё выражение
      // стояло тут и считало верхушку обычным работником: проверка ждала, пока попытку возьмёт
      // тот, кто задач не берёт ни при каком порядке строк конфига, — и потому не срабатывала
      // никогда, а рубеж, написанный ради человеческого слова «все работники заняты», молчал.
      const enabled = seatWorkers(config) ?? []
      if (enabled.length > 0 && enabled.every((w) => busyNow.has(w.id))) {
        writeLog(deps, {
          type: 'tick.all_workers_busy',
          detail: `все работники (${enabled.length}) уже ведут попытку — задача в этом проходе не берётся`,
        })
        result.idle = true
        result.allWorkersBusy = enabled.length
        return result
      }
    }
    const workerId = 'daemon' // the claim is against durable state; identity is the ledger's job
    // THE STOP TRAVELS INTO THE CLAIM ITSELF, not around it. Filtering after the checkout would
    // be too late in the durable queue — there the fetch IS the claim, and a row recognised as
    // stopped afterwards has already been handed out (the same reason the batch turn is decided
    // inside the queue). So the orders go in with the lanes, and both backends keep the promise.
    const task = await adapter.claimNext(workerId, { lanes: claimLanes, holds })
    if (!task) {
      result.idle = true // skipTimerWhenNoActionableWork
      return result
    }
    result.claimed = task.id
    // Место уже взято до захвата — теперь у него появляются имена: строки и ЗАХОДА. Имя работника
    // впишется ниже, когда маршрут его назовёт. Отдаётся место на подтверждённой смерти ребёнка
    // (`confirmProcessGone` по имени захода), а `finally` всего тика отдаёт его вторым разом —
    // вместе с занятостью работника, которая живёт до конца ворот.
    const seatAttemptId = attemptIdFor(task.id, task.attempt)
    // …и ПОЛОСА — тем же одним вызовом: место, взятое из общего пула, узнаёт свою полосу только
    // здесь, а без неё закрепление считало бы занятую полосу свободной (см. `name` в доме мест).
    if (inFlight && typeof inFlight.name === 'function') inFlight.name(seat, task.id, null, seatAttemptId, task.lane)

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
      // ═══ (3a1) ПОСЛЕДНЕЕ СЛОВО О ЗАДАЧЕ — ДО ТОГО, КАК ЗА СТРОКУ НАЧНУТ ПЛАТИТЬ ═══════
      //
      // Правило свёртки (`latestRowPerId`) спрашивал один автоповтор; у ЗАХВАТА того же вопроса
      // не было ни одного, и это стоило трёх оплаченных прогонов за день (31.08.2026), каждый из
      // которых кончился словами «уже сделано». Острее того: строка в состоянии
      // `awaiting_approval` получала ВТОРОГО живого писателя в ту же рабочую копию — исходники
      // двигались под ногами у посадки, а уборка копии при приёмке убила бы его незакоммиченное.
      //
      // ВОПРОС ЗАДАН ЗДЕСЬ, А НЕ В ОЧЕРЕДИ, ПО ОДНОЙ ПРИЧИНЕ: у долговечной очереди выборка И
      // ЕСТЬ захват, вернуть строку назад нечем — а сюда, к единственному шву, через который
      // проходят ОБА хранилища, строка приходит ещё до маршрута, до копии и до процесса. Дороже
      // всего стоит не выданная строка, а ЗАПУЩЕННЫЙ по ней работник.
      //
      // ДВА ИСТОЧНИКА, ПОТОМУ ЧТО МОЛЧАТ ОНИ В РАЗНОЕ ВРЕМЯ — тот же ответ, что у обхода беклога
      // выше: реестр помнит закрытие карточки вечно, но знает только о закрытых; очередь знает
      // всё, что у неё есть сейчас, включая строку, ждущую слова человека. Правило, по которому
      // из этих двух ответов получается «нельзя», живёт в словаре очереди (`claimRefusal`).
      //
      // FAIL-OPEN НА ЧТЕНИИ И ТОГО И ДРУГОГО: непрочитанный источник стоит одной проверки, а
      // сторож, останавливающий конвейер из-за сбоя диска, стоил бы всей раздачи работы.
      //
      // ЦЕНА, НАЗВАННАЯ ВСЛУХ: один список очереди и одно чтение файла реестра — и только на тех
      // проходах, которые ДЕЙСТВИТЕЛЬНО что-то взяли. Пустой проход не платит ничего.
      let ledgerRows = []
      try {
        ledgerRows = (ledger && typeof ledger.readAttempts === 'function' && ledger.readAttempts(task.id)) || []
      } catch {
        ledgerRows = []
      }
      let queueRows = []
      try {
        queueRows = await adapter.list({})
      } catch {
        queueRows = []
      }
      const refusal = claimRefusal({ id: task.id, rows: queueRows, closed: closureOf(ledgerRows) })
      if (refusal) {
        writeLog(deps, { type: 'claim.refused', taskId: task.id, code: refusal.code, detail: refusal.said })
        // ЗАКРЫВАЕТСЯ ОБЫЧНОЙ ДВЕРЬЮ СРЫВА, а не своей: `already_decided` ждёт человека по
        // таксономии, поэтому та же дверь сама уводит строку в парковку вместо перевыдачи, и
        // строка реестра о призраке пишется тем же путём, что о всякой другой попытке.
        await failTask(deps, task, { reason: 'already_decided', failureDetail: refusal.said, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: 'already_decided' }
        result.refusedClaim = { taskId: task.id, code: refusal.code }
        return result
      }

      // ═══ (3a2) СЧЁТ ПОДХОДОВ МОНОТОНЕН — ВТОРОЙ ЕДИНИЦЫ НЕ БЫВАЕТ ══════════════════════
      //
      // Номер называет очередь, и она его забывает вместе со строкой; реестр не забывает. Где
      // они расходятся, побеждает реестр — иначе каталог прогона `<taskId>#<attempt>` достаётся
      // второй попытке под именем первой, и запись первой уходит под запись второй молча.
      // Арифметика — в реестре (`nextAttemptNumber`), здесь только шов и слово в журнале.
      const numbered = nextAttemptNumber(ledgerRows, task.attempt)
      if (numbered !== task.attempt) {
        writeLog(deps, {
          type: 'attempt.number_lifted',
          taskId: task.id,
          detail: `очередь назвала подход ${task.attempt ?? '?'}, реестр уже помнит законченные — попытка идёт под номером ${numbered}`,
        })
        task.attempt = numbered
      }

      // The router writes its OWN dispatcher layer at the decision — the tick
      // only hands it the sink; it never narrates the routing reason on the router's behalf.
      const routeDeps = {
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
        // WHO IS ALREADY WORKING — so the router can skip an account that has a live attempt
        // instead of stacking a second one on it. Computed, until now, by nobody.
        busyWorkers: inFlight && typeof inFlight.workers === 'function' ? inFlight.workers() : null,
      }
      const route = deps.routing.resolveRoute(task, routeDeps)
      // ═══ ГОНКА МЕЖДУ ПРОВЕРКОЙ И МАРШРУТОМ — СТРОКА ВОЗВРАЩАЕТСЯ, А НЕ ЕДЕТ ЗАНЯТОМУ ═══════
      //
      // Свободное место спрашивается до захвата, но пул маршрута у́же общего: кусок сборки
      // закреплён за ОДНИМ работником, и он может оказаться занят при трёх свободных соседях.
      // Здесь стояло «фильтр занятости отступает» — маршрут перерешался без него, и работа
      // уезжала занятому. Так один работник получал вторую живую сессию в той же копии.
      //
      // ТРЕТЬЕГО ВАРИАНТА У ЭТОЙ РАЗВИЛКИ НЕТ. Провалить строку значило бы сжечь попытку за то,
      // что работа просто идёт; отдать занятому — сломать «один работник = одна живая сессия».
      // Остаётся вернуть её в очередь: СЧЁТ ПОДХОДА НЕ ДВИГАЕТСЯ, парковки нет, строка снова
      // ждёт своей очереди и уедет тем же проходом, как только место освободится.
      //
      // ЗАПИСЬ О ГОНКЕ ОСТАЁТСЯ. Она — единственный след того, что проверка и маршрут разошлись,
      // и по ней это разойдение считают; молчаливый возврат выглядел бы как задача, которая
      // «почему-то стоит».
      //
      // …И ВОЗВРАЩАЕТСЯ ОНА С ОТСРОЧКОЙ, А НЕ В ГОЛОВУ ОЧЕРЕДИ. Срок ставит сама очередь (см.
      // RELEASE_DEFER_MS): порядок выдачи — приоритет и время постановки, а возврат ни того ни
      // другого не двигает, поэтому без отсрочки следующий проход брал бы ТУ ЖЕ строку, получал
      // тот же ответ и возвращал её снова — пока занят закреплённый за ней работник, а это
      // минуты. Строки за ней не поехали бы вовсе, и каждый оборот стоил бы захвата, записи в
      // хранилище и двух кадров живого потока. Тик срока не называет: «на сколько откладывать»
      // — правило хранилища, и второе его написание здесь разошлось бы с первым.
      if (route && route.reasonCode === 'worker_busy') {
        writeLog(deps, {
          type: 'task.route_busy_race',
          taskId: task.id,
          detail: 'место занято между проверкой и маршрутом — строка возвращается в очередь без счёта попытки',
        })
        let released = false
        if (typeof adapter.releaseClaim === 'function') {
          try {
            released = (await adapter.releaseClaim(task.id, { attemptToken: task.attemptToken })) === true
          } catch (err) {
            writeLog(deps, { type: 'task.release_failed', taskId: task.id, error: String((err && err.message) || err) })
          }
        }
        if (!released) {
          // ВОЗВРАТ НЕ СОСТОЯЛСЯ — и это сказано вслух, а не спрятано. Строка остаётся
          // захваченной, её подберёт сторож живости следующим проходом; это дороже (подход
          // сгорит), но честнее выдуманного успеха.
          writeLog(deps, {
            type: 'task.release_failed',
            taskId: task.id,
            detail: 'очередь не приняла возврат — строку подберёт сторож живости',
          })
        }
        // ВОЗВРАЩЁННАЯ СТРОКА НЕ СЧИТАЕТСЯ ВЗЯТОЙ ЭТИМ ПРОХОДОМ. `claimed` отвечает на вопрос
        // «что этот проход взял в работу» — по нему считают, что тик делал (loop.test.ts:
        // `if (res.claimed) ran.push(res.claimed)`), — а строка, отданная обратно, к концу
        // прохода снова ждёт работника. Оставленная здесь, она бы удваивала счёт работы: та же
        // задача была бы «взята» и этим проходом, и тем, который её действительно поведёт.
        // Сам факт возврата не теряется — он назван своим ключом, и таск в нём поимённо.
        delete result.claimed
        result.releasedToQueue = { taskId: task.id, reason: 'worker_busy', ok: released }
        return result
      }
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
      // Имя работника в занятое место — теперь маршрут его назвал. Этой же строкой работник
      // становится ЗАНЯТ, и занятость его держится до конца ворот попытки: место отдаётся на
      // смерти ребёнка, а коммиты, свод и сдача идут после неё, в его же копии и его же ветке.
      if (inFlight && typeof inFlight.name === 'function' && route.workerId) {
        inFlight.name(seat, task.id, route.workerId, seatAttemptId)
      }
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
        // ОКНО ЭТОЙ ПОЛОСЫ ЗАКРЫВАЕТ ТОТ ЖЕ `finally` — поэтому держатель едет внутрь: у кузницы
        // свой запуск и свой поток, а «конец попытки закрывает сессию» — закон обеих дорог.
        return await runForgeTask(deps, task, route, result, now, envelope, attemptWindow)
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
      //
      // ЭТО ЖЕ ДЕРЕВО ОТВЕДЁТ КОПИЮ НИЖЕ, и оно называется ОДИН раз: для кодовой работы это
      // дерево кода проекта, для документарной ступени — его дом планирования (attemptTreeDir).
      // Дверь «уже построено» документарной ступени не задаётся вовсе, так что для неё это
      // выражение — только адрес копии.
      const doorDir = attemptTreeDir(deps, config, task)
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

      // (4c-bis) И ИСПОЛНИТ ЛИ ЭТА МАШИНА ТО ПРАВО, КОТОРОЕ КОНВЕРТ УЖЕ ДАЛ. Спрашивается
      // рядом с конвертом и по той же причине: полоса codex переводит грант в ПЕСОЧНИЦУ, а
      // песочница, которую платформа не исполнит, — это обещание, о котором узнают только из
      // стенограммы работника, упёршегося в стену. Отказ здесь стоит ноль процессов.
      const noSandbox = codexSandboxBlocker(deps, task, route, envelope)
      if (noSandbox) {
        writeLog(deps, { type: 'task.refused', taskId: task.id, lane: task.lane, reason: noSandbox.reason, detail: noSandbox.detail })
        await failTask(deps, task, { reason: noSandbox.reason, failureDetail: noSandbox.detail, route, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: noSandbox.reason, detail: noSandbox.detail }
        return result
      }

      // (4d) СКОЛЬКО ХОДОВ ПОЛУЧИТ ЭТА ПОПЫТКА — И ЕСТЬ ЛИ ЧТО ЕЙ ДАТЬ.
      //
      // Спрашивается ЗДЕСЬ, до провизии копии и до всякого процесса, потому что единственный
      // отрицательный ответ этой функции означает «запускать нельзя»: всякий потолок, который
      // мы готовы оплатить, эта работа уже сожгла. Запуск с числом, которое уже проиграло, —
      // оплаченный повтор известного исхода; отказ здесь стоит ноль процессов и ноль минут
      // подписки, а человеку на карточку едут его три выхода и число сожжённых ходов.
      //
      // …И СЧИТАЕТСЯ ПО ТОМУ, ЧТО ЗАДАЧА ГОВОРИТ О СЕБЕ СЕЙЧАС, а не по тому, что она говорила
      // в миг захвата: слова, дописанные между этими двумя мигами, догоняют попытку здесь
      // (`refreshPromise` — там же и цена этого чтения, и то, чего оно не закрывает).
      const promiseMoved = await refreshPromise(deps, task)
      if (promiseMoved.length > 0) {
        writeLog(deps, {
          type: 'task.promise_arrived',
          taskId: task.id,
          detail: `слова задачи приехали после захвата и до старта (${promiseMoved.join(', ')}) — потолок ходов считается по ним`,
        })
      }
      const turnBudget = turnBudgetFor(deps, config, task)
      if (turnBudget.cap === null) {
        const detail =
          `работа уже сожгла потолок в ${turnBudget.escalatedFrom} ходов, а предел всех подъёмов ` +
          `(${turnBudget.ceiling}) не оставляет большего — нужен человек: разбить задачу или отменить`
        writeLog(deps, { type: 'task.refused', taskId: task.id, reason: 'turns_exhausted', detail })
        await failTask(deps, task, { reason: 'turns_exhausted', route, now: now(), envelope, from: fleetState })
        result.failed = { taskId: task.id, reason: 'turns_exhausted', detail }
        return result
      }

      // (5) WHERE THE WORKER STANDS — IN ITS OWN COPY, ON ITS OWN BRANCH, WHATEVER IT WRITES.
      // Every attempt gets a per-task worktree on `wt/<taskId>` (EXPECTED_BASE guard on), so two
      // tasks can never edit one tree and nothing an attempt produces reaches the main tree until
      // a person accepts it.
      //
      // THIS USED TO EXEMPT DOCUMENTARY WORK, and the exemption is what this line now refuses.
      // The old reason was convenience, stated plainly: a stage's whole product is the phase
      // directory, the next stage reads it there, and a copy «would put every document one merge
      // away from the person who asked for it». That merge IS the acceptance, and without it the
      // stage was writing into the founder's own checkout: измерено 31.08.2026 — ступень plan
      // фазы 21 положила семь планов ДВУМЯ КОММИТАМИ ПРЯМО В main, авторством основателя, без
      // ветки, и та же попытка срывалась дважды — оставляя правки в дереве и после срыва.
      // Три вещи ломались разом: работа шла в дереве, где в этот момент работает человек;
      // коммит был неотличим в истории от собственной работы основателя; откатывать приходилось
      // руками по хэшам, найденным задним числом. Копия чинит все три одним правилом, общим для
      // кода и для прозы — «работник пишет только в свою копию, дерево меняет приёмка».
      const branch = `wt/${task.id}`
      // A DOCUMENTARY stage stands in the project THE TASK IS STAMPED WITH (the window's
      // selection only when the stamp is absent), not in the tree this daemon serves. The two
      // are the same directory on a single-project install and are NOT the same when the
      // product is served from beside the workshop the phases live in — and then a card
      // reading one root while the stage writes into the other shows work as never started
      // while it is being completed.
      //
      // И ИМЕННО В ЕГО ДОМЕ ПЛАНИРОВАНИЯ — во ВТОРОМ адресе того же проекта, а не в дереве
      // кода. Ступень правит `.planning`; копия дерева, в котором его нет, для неё пустая
      // комната, и цену этого уже заплатили (31.08, фаза 21: восемнадцать ходов и около
      // доллара за честный отказ). Второй адрес не задан — это тот же каталог.
      let workDir = attemptTreeDir(deps, config, task)
      /** The commit the worktree was cut from — the point any of this can be undone to. */
      let worktreeBase = null
      /**
       * The tree's own divergences BEFORE this attempt — a Set of record identities, or null
       * when no such picture could be taken. Null is not «none»: it is «unknown», and the gate
       * says so out loud instead of quietly treating an unknown as a clean slate.
       */
      let preexistingRed = null
      // `--json` is not decoration. Without it the verb prints prose for a person —
      // «SMA worktree: создано -> …» — and parseVerbResult, which looks for the last line
      // that is a JSON object, finds nothing at all. Asked properly, the verb answers
      // {ok, path, branch, reused}: `path` is the directory it actually made, and it is not
      // the directory this code used to guess.
      // WHICH REPOSITORY DOES THE WORK HAPPEN IN? The one the TASK'S OWN STAMP names —
      // taskTreeDir, with the screen's selection only for an unstamped task, and the
      // launch cwd only when no project is connected at all. Both older readings cost a
      // day each: `config.repoDir` is literally the launch cwd, so provisioning against
      // it meant every task ran in one tree no matter what the founder selected
      // (12.08.2026 — two tasks died in a sibling workspace where the product's files do
      // not exist); reading the SCREEN at claim time meant a project switch between
      // enqueue and claim carried the attempt into whichever tree happened to be shown
      // (25.08.2026 — a stamped task provisioned from the wrong repo, proved by the
      // worker itself with git rev-parse). The already-built door above resolved this
      // very directory to put its question in; reusing the value rather than re-deriving
      // it is what keeps the pair from ever drifting apart.
      const provisionDir = doorDir
      // HOW LONG THE COPY TOOK TO PREPARE, measured HERE rather than read off the answer:
      // the verb reports its own inside time, and what a person asks about is the wait the
      // task actually paid — process start, argument parsing and all. It is also the only
      // number available when an older install answers without one at all.
      const provisionStartedAt = Date.now()
      // WHERE THE COPY GOES — SAID OUT LOUD, and by the one expression the other door uses
      // too. Left unsaid, the verb names the directory after the CALLER, and this caller is
      // one daemon for every task it will ever run: N branches claiming one directory.
      // Null (a task with no name, which cannot happen through the queue's own gate) simply
      // says nothing and lets the verb decide, exactly as before.
      const copyPath = taskWorktreePath({ taskId: task.id, projectDir: provisionDir, execGit: deps.execGit })
      const wt = await invokeVerb(
        verbRunner,
        'worktree',
        ['provision', '--branch', branch, ...(copyPath ? ['--path', copyPath] : []), '--json'],
        provisionDir,
      )
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
      // ЧТО РАБОТНИК НАЙДЁТ В КОПИИ — кладётся СРАЗУ, из пути, который ответил верб, и до
      // спавна: снимок контекста задачи и встроенные навыки. Одна функция на обе двери;
      // падение записи снимка — падение провизии, а не тихий пропуск.
      materializeTaskContext(deps, task, workDir)
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
      // ASK WHERE THE BRANCH WAS CUT, NOT WHERE THE PROJECT STANDS NOW. The tip is the right
      // answer only on a FIRST attempt, when the copy was just cut from it. On a RETRY the
      // project has usually moved on, and then the tip names a point the task branch never
      // sat on: the count walks somebody else's history and certifies work this attempt did
      // not do. Measured 12.08.2026 — an attempt that touched no file at all came back with
      // a receipt for three commits and one deleted file.
      //
      // The merge point answers both cases with one question: on a first attempt it IS the
      // tip (nothing has diverged yet), and on a retry it is still the place the branch was
      // cut. The tip stays as the last resort, because a missing base cannot certify at all
      // and an unanswerable git must never crash the tick.
      if (!worktreeBase && typeof deps.execGit === 'function' && branch) {
        try {
          worktreeBase = String(deps.execGit(['merge-base', 'HEAD', branch], { cwd: provisionDir }) || '').trim() || null
        } catch {
          /* the branch may be unknown to this tree — fall through to the tip */
        }
      }
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
      // THE SNAPSHOT IS THE CODE GATE'S, AND ONLY ITS. A documentary stage is judged by
      // `documentGate` — a file and its commit — and never reaches the differential verdict
      // below, so taking the picture for it would spend a verb run per stage to answer a
      // question nobody asks. The COPY above is unconditional; this measurement is not.
      if (!isDocument) {
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
        // A refusal that came before the copy existed leaves the row object unmade, so it is
        // created here rather than assumed. These two facts are about the SESSION rather than
        // about a worktree, and they are owed by every lane that starts a process.
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
      // WHAT WOKE THIS ATTEMPT, decided before the array is built rather than patched onto it
      // afterwards — see wakeSpawnOptions: a person's return continues the session it is a
      // remark about, a timer never does, and the refusal is the builder's own long-standing one.
      // ── ТУМБЛЕР — В МОМЕНТ ЗАПУСКА, А НЕ В МОМЕНТ МАРШРУТА ──────────────────────
      // Всё, что стоит выше этой строки, заняло время: копия, зеркало, реестр серверов. Тумблер
      // читался до всего этого — и выключенный работник всё равно доходил до процесса (см.
      // workerSwitchedOffNow). Здесь вопрос задаётся последний раз, ПЕРЕД сборкой команды: она
      // уже чеканит дом задачи на диске, и отказ после неё стоил бы каталога ни за что.
      const switchedOff = workerSwitchedOffNow(deps, route)
      if (switchedOff) {
        writeLog(deps, {
          type: 'task.refused',
          taskId: task.id,
          workerId: route.workerId,
          reason: switchedOff.reason,
          detail: switchedOff.detail,
        })
        // И КОПИЯ, ОТВЕДЁННАЯ ПОД ЭТУ ПОПЫТКУ, ОТЗЫВАЕТСЯ ВМЕСТЕ С ОТКАЗОМ. Рука человека попала
        // внутрь подготовки — значит копия уже есть, а процесса не будет: оставленная, она
        // достанется следующей попытке ПЕРЕИСПОЛЬЗОВАННОЙ и утащит с собой всё, чем
        // переиспользованная копия отличается от свежей. Отзывается только то, что отвела эта
        // попытка (см. discardFreshCopy).
        await discardFreshCopy(deps, verbRunner, { taskId: task.id, wt, path: workDir, branch, provisionDir })
        await failTask(deps, task, {
          reason: switchedOff.reason,
          branch,
          route,
          now: now(),
          envelope,
          from: fleetState,
          worktree: worktreeRow,
        })
        result.failed = { taskId: task.id, reason: switchedOff.reason, detail: switchedOff.detail }
        return result
      }
      const wake = wakeSpawnOptions(deps, task)
      const spec = buildArgs(task, route, {
        ...SPAWN_OPTIONS,
        ...wake,
        // ПОТОЛКИ, КОТОРЫЕ ЭТА РАБОТА УЖЕ СОЖГЛА. Прочитаны выше, из реестра попыток — шва,
        // о котором сборщик аргументов не знает и знать не должен. Он берёт числа и решает
        // ими одну вещь: следующий потолок обязан быть строго больше всякого сгоревшего.
        burnedTurnCaps: turnBudget.burnedCaps,
        // ЧТО ПРОШЛАЯ ПОПЫТКА ОСТАВИЛА СЛЕДУЮЩЕЙ. Читается здесь, потому что только тик знает,
        // где лежит каталог прогона прошлой попытки; заворачивается в забор строителем, потому
        // что забор живёт там. Дописать забор здесь было бы нечем: его в этом файле нет вовсе.
        ...continuationSpawnOptions(deps, config, task, wake),
        ...(mcpConfig ? { mcpConfigPath: mcpConfig.path } : {}),
        ...envelopeSpawnOptions(envelope),
        // КУДА ЭТА ПОПЫТКА СДАЁТСЯ — в границу запуска, а не только в промпт. Копия попытки
        // это рабочее дерево git, её git-каталог лежит СНАРУЖИ; см. copyWriteSpawnOptions.
        ...copyWriteSpawnOptions(deps, workDir),
        // The attempt directory and the correction file, created and named BEFORE the process
        // exists — the parking gate inside the child reads both out of its environment.
        ...gateSpawnOptions(deps, config, task),
      })
      // ДОМ ЗАДАЧИ ЧЕКАНИТСЯ СБОРКОЙ КОМАНДЫ — и с этой строки за ним есть кому прийти. Путь
      // берётся из ОКРУЖЕНИЯ, с которым правда спавнят: второе вычисление того же пути отвечало
      // бы на вопрос «где дом ДОЛЖЕН быть», а убирать надо тот, который сделан. Держатель
      // заполняется ДО спавна, потому что между сборкой и запуском лежат дороги, уносящие
      // попытку в исключение мимо всякой уборки; читателем остаётся один `finally` тика.
      attemptWindow.taskId = task.id
      attemptWindow.codexHome = (spec.env && spec.env.CODEX_HOME) || null
      // ЧЕМ ЭТА ПОПЫТКА ЗАПУЩЕНА — НА ДОЛГОВЕЧНУЮ СТРОКУ, И ПРЯМО ЗДЕСЬ, ГДЕ КОМАНДА ТОЛЬКО
      // ЧТО СОБРАНА. Ниже лежит дюжина дорог, и та, что уносит попытку в отказ, обязана унести
      // с собой и командную строку: именно у отказавшей попытки спрашивают, под какой границей
      // она шла. Пишется на ОБЕИХ дверях одним выражением (см. worktreeFields).
      worktreeRow = worktreeRow || {}
      worktreeRow.spawn = spawnRecordOf(spec)
      // THE LINE IS WRITTEN ONLY WHERE IT IS TRUE. A timer wake takes no session with it, so
      // saying it resumed one would make the operator's log claim something that never happened.
      if (wake.resumeId) writeLog(deps, { type: 'task.session_resumed', taskId: task.id, attempt: task.attempt })
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
        // ГДЕ ЛЕЖИТ ОПРЕДЕЛЕНИЕ, РЕШАЕТ НЕ ЭТОТ ФАЙЛ. Ворота стояли на `worker.roleFile` — на
        // поле, которое есть ТОЛЬКО у работника, чьё определение нашлось в дереве проекта.
        // Работник из хранилища машины такого поля не имеет и не может иметь (путь роли
        // раскрывается относительно репозитория), и роль ему не выдавалась вовсе: карточка
        // говорила «включён», а сессия не получала ни строки. Спрашиваем разрешатель всегда —
        // он сам ищет по обоим хранилищам и отвечает пустым, когда находить нечего.
        if (worker) {
          const ctx = deps.resolveWorkerContext({ worker, repoDir: config.repoDir, fsImpl: deps.fsImpl, env: deps.env })
          // ТЕКСТ ВЫДАННЫХ НАВЫКОВ ЕДЕТ ТЕМ ЖЕ ПУТЁМ, ЧТО И РОЛЬ. Раздача навыка была записью
          // в конфиге и строкой в журнале: сессия, которой навык выдали, о нём не узнавала.
          // Кладётся ПЕРВЫМ, чтобы после обеих вставок порядок читался как роль → навыки →
          // работа: кто работник, что он умеет, и лишь потом что делать.
          if (ctx && ctx.skillsPreamble) spec.prompt = `${ctx.skillsPreamble}\n\n${spec.prompt ?? ''}`
          if (ctx && ctx.rolePreamble) spec.prompt = `${ctx.rolePreamble}\n\n${spec.prompt ?? ''}`
          // ФАЙЛ РОЛИ НАЗЫВАЕТСЯ ТОТ, ЧТО ПРОЧИТАН. У работника из дерева это его пин; у
          // работника из хранилища машины пина нет, и без второго слагаемого слой памяти
          // сказал бы «роли не было» о попытке, которой роль выдали.
          const roleRef = worker.roleFile || (ctx && ctx.roleRef) || null
          roleNotes = [...(roleRef ? [roleRef] : []), ...((ctx && ctx.skillsList) || worker.skills || [])]
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
      // С ЭТОЙ СТРОКИ У ПОПЫТКИ ЕСТЬ ОКНО КООРДИНАЦИИ, КОТОРОЕ ПРИДЁТСЯ ЗАКРЫТЬ. Держатель
      // заполняется РАНЬШЕ запуска, а не после него: между спавном и любым `return` ниже лежит
      // дюжина дорог, и та, что уносит попытку в исключение, обязана унести её мимо открытого
      // окна ровно так же, как счастливая. Читателем остаётся один `finally` тика.
      attemptWindow.sessionOf = sessionOf
      attemptWindow.cwd = taskTreeDir(deps, config, task)
      attemptWindow.taskId = task.id
      // ── THE STEERING WHEEL (phase «Двигатель», recon 11.08) ──
      // Every spawn of this attempt registers its kill-handle under the TASK id, so the
      // redirect door can end the live child («Перебить сейчас») and the correction then
      // rides the continuation below. Hint plumbing: a restart loses only the ability to
      // kill children that died with it. The forge lane rides the SAME helper.
      const spawnSteered = steeredSpawn(deps, task.id, spawnWorker, seatAttemptId)
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
      //
      // И СПРАШИВАЕТСЯ ЭТО У ПОЛОСЫ, А НЕ У ИМЕНИ ДВОИЧНОГО ФАЙЛА. Развилка стояла на сравнении
      // `spec.bin` с именем `claude` — а имя это в спавне НЕ ГАРАНТИРОВАНО: на машине, где CLI
      // поставлен через npm, запуск идёт интерпретатором (`node <скрипт>`, см. resolve-bin), и
      // наша собственная полоса переставала узнавать себя. Слово тогда уезжало дорогой чужой
      // полосы — в задание, — а живая сессия не возобновлялась вовсе, при том что дорога у неё
      // есть. «Умеет ли эта полоса вернуться в идущую сессию» — свойство полосы, и спрашивается
      // оно у таблицы.
      const lane = laneAdapter(spec.provider)
      let promptCarried = []
      if (config.dataDir && !lane.resumesSession) {
        promptCarried = readPendingRedirects({ dataDir: config.dataDir, taskId: task.id, fsImpl: deps.fsImpl })
        if (promptCarried.length) spec.prompt = `${spec.prompt ?? ''}\n\n${correctionsPreamble(promptCarried)}`
      }
      let exit = await runSpawn(spawnSteered, { bin: spec.bin, args: spec.args, cwd: workDir, env: spec.env, prompt: spec.prompt }, onLine, now)
      // СКОЛЬКО ЭТА СЕССИЯ СОБИРАЛАСЬ — на строку попытки, словами (см. sessionStartRecord).
      // Пишется СРАЗУ после первого запуска, а не после цикла продолжений: замеряется старт, а
      // продолжение стартует в уже готовой песочнице и ответило бы на другой вопрос.
      worktreeRow = worktreeRow || {}
      worktreeRow.sessionStart = sessionStartRecord({ spawnedAt: attemptStartedAt, firstLineAt: exit.firstLineAt })
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
      //
      // И ЕСЛИ ХОД ОБОРВАЛИ РАДИ ЭТОГО СЛОВА — ЗАДАЧА ВОЗВРАЩАЕТСЯ ЗА НИМ, А НЕ УМИРАЕТ ПУСТОЙ.
      // Дверь поправки отвечает «принято» и убивает живого ребёнка ОДИНАКОВО на обеих полосах:
      // у нашей полосы за этим стоит возобновление сессии прямо здесь, у чужой — не стоит
      // ничего. Замерено 01.09: «перебить сейчас» по задаче стороннего вендора ответило
      // {accepted:true, live:true}, ход был убит, в журнале осталось `redirect_skipped ·
      // provider`, и на этом всё кончилось — снаружи неотличимо от доставки. Слово при этом
      // лежало на диске целым (его никто не съел), но ехать ему было НЕ НА ЧЕМ: следующего
      // захода задачи не случилось.
      // Дорога у такого слова ровно одна и она уже построена выше — ЗАДАНИЕ СЛЕДУЮЩЕГО
      // ЗАХОДА. Значит попытка, которую оборвали ради поправки, обязана кончиться так, чтобы
      // этот заход состоялся: она объявляется перевыдаваемым отказом со своим словом
      // (`redirect_restart`), очередь возвращает строку, и записка уезжает в промпте.
      // ТОЛЬКО ПО ОБОРВАННОМУ ХОДУ, и это граница намеренная: попытка, доработавшая сама,
      // — законченная работа, и валить её ради слова, сказанного «после хода», значило бы
      // выбрасывать сделанное. Такое слово по-прежнему ждёт на диске и записывается пропуском.
      let redirectRestart = null
      if (config.dataDir) {
        let hops = 0
        for (;;) {
          const pending = readPendingRedirects({ dataDir: config.dataDir, taskId: task.id, fsImpl: deps.fsImpl })
          if (!pending.length) break
          const sessionId = sessionOf()
          const resumable = lane.resumesSession && typeof sessionId === 'string' && /^[0-9a-f-]{32,40}$/i.test(sessionId)
          if (!resumable || hops >= REDIRECT_HOP_CAP) {
            const reason = hops >= REDIRECT_HOP_CAP ? 'hop_cap' : !lane.resumesSession ? 'provider' : 'no_session'
            // УБИЛА ЛИ ЭТОТ ХОД ИМЕННО ДВЕРЬ — спрашивается у той же ручки, которой дверь его и
            // убивала, и ДО `done` ниже, пока ручка ещё зарегистрирована. Демон, собранный без
            // реестра ручек, отвечает «нет» и ведёт себя ровно как прежде.
            const shot =
              reason === 'provider' &&
              Boolean(deps.attemptTurns && typeof deps.attemptTurns.wasStopped === 'function' && deps.attemptTurns.wasStopped(task.id))
            if (shot) {
              redirectRestart =
                `поправка не доезжает до живого хода этого работника (${spec.bin}): ход оборван дверью, ` +
                'задача возвращается в очередь — записка едет в задании следующего захода'
              writeLog(deps, {
                type: 'task.redirect_deferred',
                taskId: task.id,
                mode: pending[pending.length - 1].mode,
                delivery: 'next_run',
                detail: redirectRestart,
              })
            } else {
              writeLog(deps, { type: 'task.redirect_skipped', taskId: task.id, reason })
            }
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
      // И МЕСТО ОТДАЁТСЯ ЗДЕСЬ — В МОМЕНТ ПОДТВЕРЖДЁННОЙ СМЕРТИ РЕБЁНКА, а не в последнем
      // `finally` прохода. Ниже этой строки идут ворота: маркер, квитанция, переповерка,
      // коммиты, свод — минуты, за которые процесса уже нет, а место всё ещё занято. Место
      // считает ЖИВЫХ детей (см. `in-flight.mjs`), и держать его за мёртвым значит голодить
      // очередь при свободном работнике — замерено: 282 отказа по потолку подряд при двух
      // живых попытках из четырёх мест. Тем же выражением, каким дверь отмены отвечает
      // человеку «попытка закрылась»; `finally` отдаст место вторым разом и это не ошибка.
      // По имени ЗАХОДА, а не строки: на одной строке живут два захода, и снятое скопом место
      // второго, живого, вернуло бы ту же аварию с другой стороны.
      confirmProcessGone(deps, task.id, seatAttemptId)

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
      // AND WHETHER WE ENDED IT OURSELVES — asked in the same breath and measured against the
      // ceiling this very spawn was handed, so the reading is of the command line that ran and
      // not of a setting somebody believes it carried.
      const turnCapHit = turnCapHitOf(streamLines, argMaxTurns(spec.args))
      // И ЧЕМ ЭТА ПОПЫТКА ЗАНЯЛА СВОИ ХОДЫ. Считается для КАЖДОЙ попытки, а не только для той,
      // что упёрлась: человек, решающий «поднять потолок или разрезать работу», сравнивает
      // сгоревшую попытку с теми, что уложились, — а сравнивать не с чем, если мерили только
      // упавшую. Потолок берётся с командной строки, которая правда была: число из настроек
      // было бы утверждением о запуске вместо его чтения.
      const turnSpend = turnRecordOf(spec.args, streamLines)

      // (7a) WHAT IT COST — read off this attempt's own stream, before any gate decides its
      // fate. A refused attempt still spent the tokens, so the book is written for every
      // attempt and not only for the ones that end well. Четыре числа того же кадра едут
      // отсюда в каталог прогона и дальше в квитанцию — один разбор на двух читателей.
      const attemptTokens = bookAttemptUsage(deps, task, route, streamLines, now(), attemptStartedAt)
      unbookedSpend = null // paid — the catch below must not pay it a second time
      // И СКОЛЬКО МЕСТА ЕЙ НЕ ХВАТИЛО — второй расход той же попытки, прочитанный в том же
      // месте и из того же потока, что и первый. Окно контекста тратится ровно как деньги и
      // ходы, и до этого чтения оно было единственным из трёх, о котором демон не знал ничего:
      // переполнившаяся попытка приходила на выходной гейт неотличимой от плохой работы.
      const contextExhausted = contextExhaustedOf(streamLines)
      // И ЧЕМ ЭТОТ ХОД КОНЧИЛСЯ — не «когда», а ПРИ ЧЁМ. Читается по всему потоку, уже после
      // выхода ребёнка: попытку закрывает его exit, а не первый `result`, поэтому кадры о
      // фоновых задачах и второй `result`, пришедшие следом, лежат здесь же и судятся вместе.
      const backgroundTurnEnd = backgroundTurnEndOf(streamLines)

      // (7b) THE APPROACH NOTE — read off the same stream, appended as the journal's
      // approach layer, and then REQUIRED by the gate exactly as the receipt is required.
      // It is required of EVERY class of work: a parked round and a written document explain
      // themselves on the same terms a merged branch does.
      // ONE unwrapping for both marker families: the worker's closing words arrive inside a
      // frame, and a second pass over raw lines would find neither.
      const markerLines = markerLinesFrom(streamLines, ['APPROACH_', 'LESSON_', 'MOOT'])
      const note = parseApproachNote(markerLines)
      const noteRecord = recordApproachNote(deps, task, note)
      const noteWritten = noteRecord.noted
      // «ПРЕДМЕТА НЕТ» — читается ЗДЕСЬ, из того же развёрнутого потока и тем же протоколом
      // мягких маркеров, что записка и урок. Судит его не парсер: ниже дверь ответа сперва
      // доказывает, что попытка ничего не тронула, а потом демон проверяет улику у git.
      const moot = parseMootMarker(markerLines)

      // (7b-bis) THE LESSON — the third condition, checked against the copy's own corpus. A
      // parked round is exempt below (the session was cut short by a question to a person, so
      // there is nothing finished to draw a lesson from) and so is the forge lane, which has
      // its own markers and produces a draft rather than an attempt at work.
      const lessonEval = lessonCheck(deps, task, workDir, parseLessonMarker(markerLines))
      const lessonOk = lessonEval.ok === true
      // ЧЕЙ ЭТО ОТКАЗ — СВЕДЁН В ОДНО МЕСТО, ОДИН РАЗ. Закрытие попытки держат два инструмента:
      // журнал подхода и разбор заметки урока. Падение ЛЮБОГО из них — про наш код, а не про
      // работника, и ниже оно обязано звучать одним словом исхода, а не двумя обвинениями.
      const closeToolError = noteRecord.toolBroke ?? (lessonEval.toolBroke || null)
      if (closeToolError) {
        appendLine(`[sma] инструмент закрытия отказал: ${closeToolError}`)
        writeLog(deps, { type: 'close-tool-broken', taskId: task.id, attempt: task.attempt ?? null, detail: closeToolError })
      }
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
          projectDir: taskTreeDir(deps, config, task),
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
          projectDir: taskTreeDir(deps, config, task),
          sessionId: sessionOf(),
          fsImpl: deps.fsImpl,
        }),
        guards: guardsOf(),
        permissionDenials: permissionDenialsOf(),
        ledgerPath: logFileOf(),
        exit,
        gate: isDocument ? 'document' : 'reverify',
        lesson: lessonLayerOf(lessonEval),
        approach: note,
        tokens: attemptTokens,
      })

      // ═══ ХОД, ОБОРВАННЫЙ РАДИ ПОПРАВКИ, — НЕ ПЛОХАЯ РАБОТА, А НЕДОДЕЛАННАЯ ═══════════════
      //
      // Развилка стоит ВЫШЕ всех гейтов и раньше всякого суждения о качестве: попытку убил
      // человек своей поправкой, и судить её тем же гейтом, что и работу, дошедшую до конца, —
      // значит назвать чужим именем («нет квитанции», «тесты красные») то, чего никто не делал.
      // Конец перевыдаваемый по устройству (слова нет в `AWAITS_A_PERSON`), поэтому строка
      // возвращается в очередь, следующий заход собирается с запиской в задании — тем самым
      // кодом, что стоит перед первым запуском выше, — и поправка доезжает.
      if (redirectRestart) {
        writeLog(deps, { type: 'task.refused', taskId: task.id, reason: 'redirect_restart', detail: redirectRestart })
        await failTask(deps, task, { reason: 'redirect_restart', failureDetail: redirectRestart, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
        result.failed = { taskId: task.id, reason: 'redirect_restart', detail: redirectRestart }
        return result
      }

      // An infra failure, a provider abort or a worker marker is the SHARPER signal and wins
      // over either gate below: a crashed attempt must not complete on a document that was
      // already there — and neither may an attempt the vendor cut off mid-word.
      const infraReason = exit.spawnError || providerAbort || turnCapHit || marker
        ? classifyFailure({ spawnError: exit.spawnError, providerAbort, turnCapHit, exitCode: exit.code, workerMarker: marker })
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
      // AND A WINDOW THAT FILLED UP IS A FACT ABOUT THE SIZE OF THIS TASK — worth saying even
      // when the attempt squeaked through, because the next one may not. It deliberately does
      // NOT join the infra short-circuit above: a compaction is not a terminal event, and a
      // round that went on to park on a question or to write its document really did produce
      // that outcome. What it decides is only the NAME of a refusal that left nothing behind.
      if (contextExhausted) {
        writeLog(deps, {
          type: 'task.context_exhausted',
          taskId: task.id,
          reason: 'context_exhausted',
          detail:
            `окно контекста переполнилось: сжатий=${contextExhausted.compactions}` +
            (contextExhausted.preTokens !== null ? ` (перед самым большим — ${contextExhausted.preTokens} токенов)` : ''),
        })
      }
      // И ХОД, КОНЧИВШИЙСЯ ПРИ ЖИВОЙ ФОНОВОЙ ЗАДАЧЕ, — тоже факт о ПОРЯДКЕ работы, а не о её
      // качестве, и он говорится вслух даже там, где попытка всё равно прошла: следующей может
      // не повезти. Приговором он не становится — что он решает, решает гейт ниже.
      if (backgroundTurnEnd) {
        writeLog(deps, {
          type: 'task.background_turn_end',
          taskId: task.id,
          reason: 'background_turn_end',
          detail: `${backgroundTurnEndDetail(backgroundTurnEnd)} (признак: ${backgroundTurnEnd.source === 'frames' ? 'кадры поставщика' : 'вызов run_in_background'})`,
        })
      }

      // (7a-pre) КОММИТ ЗА РАБОТНИКА, КОТОРОМУ ПЕСОЧНИЦА НЕ ДАЛА СДЕЛАТЬ ЕГО САМОМУ.
      //
      // Стоит ПЕРЕД всеми тремя гейтами и ни одному из них не льстит: дверь запаркованного
      // вопроса ищет закоммиченный чекпойнт, дверь ответа доказывает пустоту по коммитам и
      // чистоте дерева, дверь кода зовёт reverify по ветке — и все трое читают дерево, в
      // котором работа уже лежит незакоммиченной. Без этой строки они читают одно и то же
      // «работник ничего не сдал» о сессии, которой запретили запись в индекс.
      //
      // Только когда сессия ДОШЛА ДО КОНЦА. Оборванный процесс оставляет полуправку, и
      // фиксировать её значит строить следующий заход на том, чего никто не доводил.
      if (!infraReason) hostCommitAfterSession(deps, { task, route, workDir })

      // (7a) A PARKED QUESTION IS A SUCCESSFUL ROUND — and it is asked BEFORE either gate.
      // A discussion round that stopped on a question, and an execute stage that reached a
      // blocking checkpoint, are the same event: the work went as far as it honestly could
      // and now owes a person a word. Failing it would throw away the position and start the
      // whole stage over on the next attempt; completing it on the checkpoint's own receipt
      // parks the row in `awaiting_approval`, where the screen renders it as a card.
      const parked = infraReason ? null : parkedRound(deps, task, workDir)
      // ГДЕ ЛЕЖИТ ЗАПАРКОВАННЫЙ ВОПРОС — СКАЗАНО ВСЛУХ, а не выведено человеком из молчания.
      // Чекпойнт коммитится в КОПИИ, на ветке попытки, а двери вопросов (карточка фазы и запись
      // ответа) читают дерево планирования — так было и до этой починки для ступени исполнения,
      // и так стало для разговорной. Значит вопрос доезжает до экрана ПОСЛЕ приёмки ветки, и
      // единственное, что тут по-честному можно сделать сегодня, — назвать ветку и файл в
      // журнале оператора, чтобы «вопрос есть, но его не видно» не выглядело потерей.
      if (parked && parked.receiptRef) {
        writeLog(deps, {
          type: 'checkpoint.parked_in_copy',
          taskId: task.id,
          branch,
          detail: `вопрос запаркован в копии (${parked.receiptRef}) — на карточку фазы он выходит после приёмки ветки ${branch}`,
        })
      }

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
        // ОТКАЗ ИНСТРУМЕНТА ПОДМЕНЯЕТ СЛОВО, НО НИКОГДА НЕ СОЗДАЁТ ОТКАЗА. Он отвечает на
        // вопрос «чей это провал» тогда, когда провал УЖЕ есть; работу, прошедшую гейт,
        // сломанный журнал не съедает — этим починка и отличается от поломки, ради которой
        // она сделана.
        const missing = noteWritten ? lessonReason : 'no_journal'
        // ПРОПАЖА, У КОТОРОЙ ЕСТЬ ОБЪЯСНЕНИЕ, НАЗЫВАЕТСЯ ИМ — тот же порядок, что и в
        // classifyFailure на полосе кода: отказ инструмента сильнее (записку нечем было
        // записать), живая фоновая задача идёт следом (ход кончился раньше записки), и только
        // потом остаётся голая пропажа. Ни одна из подмен не СОЗДАЁТ отказа — она переименовывает
        // тот, что уже есть.
        const omission = missing && backgroundTurnEnd && !closeToolError ? 'background_turn_end' : missing
        const reason =
          infraReason ??
          (gate.receiptRef ? (omission && closeToolError ? 'close_tool_broken' : omission) : gate.reason)
        if (reason) {
          // ЧЕМ ОТКАЗАЛ ГЕЙТ И НА ЧЁМ В ПОСЛЕДНИЙ РАЗ СПОТКНУЛАСЬ ПОПЫТКА — одной строкой, и
          // едет она ДАЛЬШЕ журнала оператора: на строку реестра, а оттуда на карточку. Имя
          // гейта называет последствие; слова из стенограммы называют причину, и без них
          // человек открывает поток вручную — или, как случалось, не открывает вовсе и платит
          // за три одинаковых попытки.
          // СЛОВА ЭТОГО КОНЦА ЕДУТ ВПЕРЁД ЧУЖИХ. У отказа по живой фоновой задаче есть своя
          // подсказка, и она отвечает на вопрос человека «что делать»; последняя ошибка
          // инструмента в этом случае — про другое.
          const detail =
            reason === 'background_turn_end'
              ? backgroundTurnEndDetail(backgroundTurnEnd)
              : stageRefusalDetail(gate.detail, lastToolErrorOf(streamLines))
          if (detail) writeLog(deps, { type: 'task.refused', taskId: task.id, reason, detail })
          await failTask(deps, task, { reason, failureDetail: detail, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
          result.failed = { taskId: task.id, reason, ...(detail ? { detail } : {}) }
        } else {
          await completeTask(deps, task, { receiptRef: gate.receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
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
        await failTask(deps, task, { reason: 'no_lesson', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
        result.failed = { taskId: task.id, reason: 'no_lesson' }
        return result
      }
      if (answered) {
        // «ПРЕДМЕТА НЕТ» — ТО ЖЕ ДОКАЗАННОЕ ПУСТОЕ ДЕЙСТВИЕ, НО С ДРУГИМ СЛОВОМ. Дверь ответа
        // выше уже доказала git'ом, что попытка не тронула ничего; здесь решается лишь, КАК
        // назвать этот конец человеку. Работник объявил вывод и назвал улику — демон проверяет
        // улику сам и, если она подтвердилась, выдаёт квитанцию, которая её называет. Иначе
        // исход остаётся обычным ответом, и причина СКАЗАНА ВСЛУХ: молчаливое понижение
        // выглядело бы для человека как «работник ничего не заявлял», а он заявлял.
        let receiptRef = answered.receiptRef
        if (moot) {
          const proof = mootEvidenceCheck(deps, workDir, moot.evidence)
          if (proof.verified) {
            receiptRef = mootReceipt(attemptIdFor(task.id, task.attempt), proof.verified)
            writeLog(deps, {
              type: 'task.moot',
              taskId: task.id,
              receiptRef,
              detail: `предмета нет: ${moot.reason} — проверено (${proof.kind}) ${proof.verified}`,
            })
          } else {
            writeLog(deps, {
              type: 'task.moot_unproven',
              taskId: task.id,
              detail: `заявлено «предмета нет» (${moot.reason}), но ${proof.reason} — засчитано как обычный ответ`,
            })
          }
        }
        // NEVER SILENT: an outcome that skipped the code gate says so in the operator's log,
        // so «the worker answered» can never be mistaken for «the worker's code passed».
        writeLog(deps, { type: 'task.answered', taskId: task.id, receiptRef })
        await completeTask(deps, task, { receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
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

      // ═══ ЧТО ОБОРВАЛ ПОСТАВЩИК, ТО НЕ «СДЕЛАНО», ЕСЛИ НИЧЕГО НЕ ЗАВЕРЕНО ═══════════════
      //
      // Дверь ниже осталась открытой для оборванного прогона намеренно: ветка, которую
      // перепроверка ДЕЙСТВИТЕЛЬНО прогнала зелёной и выдала на неё свою квитанцию, —
      // законченная работа, кто бы ни закрыл сессию следом, и отказать ей значило бы выбросить
      // подтверждённое и оплатить его заново. Но у ВЫВЕДЕННОЙ квитанции (`unverified`)
      // подтверждения нет вовсе: она посчитана из числа коммитов на ветке — там, где в дереве
      // нет рецептов или все расхождения исторические. У прогона, оборванного на лимите
      // сессии, это число легко оказывается чужим (база отсчёта устарела, и в счёт попадают
      // коммиты вершины), и тогда «сделано» удостоверяет ровно ничего.
      //
      // ЗАМЕР 30.08.2026: две задачи подряд, обе оборваны поставщиком (`429: You've hit your
      // session limit`), обе ушли в `done` с выведенной квитанцией — и с доски исчезли совсем,
      // потому что «сделано» не ждёт приёмки так, как ждёт её красная строка. Ложное «сделано»
      // без квитанции запрещено хребтом доверия: такая попытка теперь называется обрывом и
      // возвращается в очередь (`provider_error` — конец перевыдаваемый).
      const unprovenAbort = Boolean(providerAbort) && Boolean(receipt && receipt.ref && receipt.ref.unverified === true)
      // ═══ И ТРЕТИЙ ВОПРОС ГЕЙТА: О ЧЁМ ЭТА РАБОТА ═══════════════════════════════════════
      // Стоит ЗДЕСЬ, у самой развилки, и читает список, который строка выше уже взяла у git:
      // судить форму работы можно только по тому, что действительно легло на ветку, и второй
      // вопрос к git был бы вторым ответом об одной попытке. Прогон, который вообще не
      // запустился, не спрашивается вовсе — ветки нет; кого именно это слово НЕ перебивает,
      // решает условие ветки ниже.
      const shapeRefusal = exit.spawnError ? null : workShapeRefusal(deps, task, changed, worktreeBase, workDir)
      if (!exit.spawnError && !unprovenAbort && !shapeRefusal && receipt && receipt.verdict === 'green' && receipt.ref && noteWritten && lessonOk) {
        await completeTask(deps, task, { receiptRef: receipt.ref, branch, diffStat: rv.diffStat, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
        result.completed = task.id
      } else if (shapeRefusal && !providerAbort && !turnCapHit && !marker && !(receipt && receipt.verdict === 'red')) {
        // ФОРМА РАБОТЫ ПОБЕЖДАЕТ СЛОВА О КАЧЕСТВЕ ДОКАЗАТЕЛЬСТВА, НО НЕ ПОБЕЖДАЕТ НИ ОБРЫВ, НИ
        // ИЗМЕРЕННЫЙ КРАСНЫЙ. Прогон, который оборвал поставщик, наш потолок ходов или сам
        // работник своим маркером, не «сдал самозамкнутый тест» — его прервали, и назвать это
        // дефектом работы значило бы послать человека чинить не то. Красная перепроверка — факт
        // о ветке, измеренный, и он тоже сильнее: человеку, у которого действительно красные
        // тесты, «тест говорит о себе» ничего не чинит. Во всех остальных случаях слово формы —
        // САМОЕ ТОЧНОЕ, что можно сказать: оно называет ровно то, чего не увидел бы зелёный сьют.
        await failTask(deps, task, { reason: shapeRefusal.reason, failureDetail: shapeRefusal.detail, receiptRef: receipt && receipt.ref, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
        result.failed = { taskId: task.id, reason: shapeRefusal.reason, detail: shapeRefusal.detail }
      } else {
        // WHO ENDED THE RUN rides with the rest. The door to «done» above is untouched: an
        // attempt whose branch really did re-verify green AND left its note is finished work
        // whoever ended the session, and refusing it would throw away work that certified
        // itself. What changes is the NAME of a refusal — the outage is called an outage.
        // ГОДИЛОСЬ ЛИ ДЕРЕВО ВООБЩЕ — спрашивается ТОЛЬКО поверх красной перепроверки и
        // только у копии, в которой она шла. Полдюжины stat'ов, и они окупаются одним
        // случаем: 31.08.2026 склад зависимостей пустел трижды за сутки, и каждый раз
        // попытка закрывалась как «тесты красные». Своя поломка проверки читается как
        // «годилось» — страж, обвиняющий среду из-за собственной ошибки, хуже отсутствующего.
        let envUnfit = null
        if (receipt && receipt.verdict === 'red') {
          try {
            const fitness = checkEnvironmentFitness({ root: workDir })
            if (fitness && fitness.fit === false) envUnfit = fitness.reason
          } catch {
            envUnfit = null
          }
        }
        const reason = classifyFailure({
          spawnError: exit.spawnError,
          providerAbort,
          turnCapHit,
          contextExhausted,
          exitCode: exit.code,
          receipt,
          workerMarker: marker,
          journalComplete: noteWritten,
          lessonComplete: lessonOk,
          // ЧЕЙ ЭТО ПРОВАЛ. Передаётся ВСЕГДА, а судит его классификатор: он подставляет своё
          // слово только там, где иначе прозвучало бы обвинение работника в пропаже, и не
          // трогает ни один конец, названный до записки (обрыв, потолок, маркер, красное).
          closeToolError,
          // И ЧЕМ КОНЧИЛСЯ ХОД — тем же порядком: слово подставляется только там, где пропажа
          // записки или урока УЖЕ решила исход, и не трогает ни один конец, названный раньше.
          backgroundTurnEnd,
          envUnfit,
        })
        if (envUnfit) {
          writeLog(deps, { type: 'task.env_broken', taskId: task.id, detail: envUnfit })
        }
        // ЧТО НАПИСАНО НА КАРТОЧКЕ. Причина без подсказки здесь не работает: человек, читающий
        // «журнал не дописан», должен увидеть рядом ту самую поправку — передний план и журнал
        // последним действием, — иначе следующая попытка повторит ровно этот ход.
        const failureDetail = envUnfit ?? (reason === 'background_turn_end' ? backgroundTurnEndDetail(backgroundTurnEnd) : null)
        await failTask(deps, task, { reason, ...(failureDetail ? { failureDetail } : {}), receiptRef: receipt && receipt.ref, branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
        result.failed = { taskId: task.id, reason, ...(failureDetail ? { detail: failureDetail } : {}) }
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
  } finally {
    // МЕСТО И ЗАНЯТОСТЬ РАБОТНИКА ОТДАЮТСЯ ВСЕГДА — на успехе, на провале, на исключении и на
    // КАЖДОМ раннем возврате выше. Стоит на самом внешнем уровне именно поэтому: выходов из тика
    // много, и пропущенный хотя бы один означал бы дом, который никогда не пустеет, и конвейер,
    // вставший молча.
    //
    // И ЭТО ЕДИНСТВЕННАЯ ДОРОГА К СВОБОДНОМУ РАБОТНИКУ. Место здесь чаще всего отдаётся вторым
    // разом (первый — на смерти ребёнка, по имени захода), а вот занятость работника до этой
    // строки не снимал никто: ворота попытки идут ПОСЛЕ смерти ребёнка, и работник, отпущенный
    // на той границе, получал от ближайшего тика вторую задачу поверх ещё не закрытой первой.
    if (seat && deps.inFlight && typeof deps.inFlight.release === 'function') deps.inFlight.release(seat)
    // И ОКНО КООРДИНАЦИИ ЗАКРЫВАЕТСЯ ВСЕГДА — по той же причине и в том же месте. Мёртвая
    // попытка не исполняет своего прощального хука (он внутри убитого процесса), и до этой
    // строки каждая такая попытка оставляла в реестре окно, за которым никто не стоит.
    try {
      if (attemptWindow.sessionOf) {
        await closeCoordinationSession(deps, {
          sessionId: attemptWindow.sessionOf(),
          cwd: attemptWindow.cwd,
          taskId: attemptWindow.taskId,
        })
      }
    } catch {
      /* уборка никогда не решает судьбу попытки — верб уже фейл-открыт, это второй пояс */
    }
    // И ДОМ ЗАДАЧИ УБИРАЕТСЯ ВСЕГДА — по той же причине и в том же месте. Он чеканится на каждую
    // задачу и держит внутри временный каталог песочницы; общий каталог машины чистит система, а
    // этот не чистил никто, и после переезда Temp внутрь дома мусор стал копиться на задачу
    // навсегда. Оба README обещали, что дом «уходит вместе с задачей», — вот дверь, на которой
    // это происходит.
    try {
      dropCodexTaskHome(deps, { home: attemptWindow.codexHome, taskId: attemptWindow.taskId })
    } catch {
      /* фейл-опен второго пояса: неубранный каталог не переписывает исход попытки */
    }
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
async function runForgeTask(deps, task, route, result, now, envelope, attemptWindow = {}) {
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

  // …И ИСПОЛНИТ ЛИ МАШИНА ТО ПРАВО, КОТОРОЕ КОНВЕРТ ТОЛЬКО ЧТО ДАЛ — ТЕМ ЖЕ ВЫРАЖЕНИЕМ, ЧТО И
  // НА ПУТИ КОДА. Забытая вторая дверь — мина, которую этот файл уже дважды разминировал задним
  // числом (копия, материализация), и здесь она была бы той же самой: полоса кузницы ПИШЕТ
  // файл — черновик — и без права писать её сессия упирается ровно в ту стену, что стоила окна
  // подписки 01.09.2026. Отказ до спавна стоит ноль процессов; спавн в стену стоит окно и
  // кончается «черновик не закоммичен», то есть виноватым работником.
  const noSandbox = codexSandboxBlocker(deps, task, route, envelope)
  if (noSandbox) {
    writeLog(deps, { type: 'task.refused', taskId: task.id, lane: task.lane, reason: noSandbox.reason, detail: noSandbox.detail })
    await failTask(deps, task, { reason: noSandbox.reason, failureDetail: noSandbox.detail, route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: noSandbox.reason, detail: noSandbox.detail }
    return result
  }

  // …И СЧИТАЕТСЯ ПО ТОМУ, ЧТО ЗАДАЧА ГОВОРИТ О СЕБЕ СЕЙЧАС — тем же чтением, что и на пути кода.
  // Строка становится захватываемой в миг записи, а слова к ней дописываются следующим запросом:
  // без этого чтения обещание, приехавшее между захватом и стартом, не доезжало ни до потолка
  // ходов, ни до командной строки, и кузнечная работа с уже написанным обещанием уходила в
  // процесс объявленной пустой. Ровно та мина, которую путь кода уже разминировал, оставленная
  // здесь — как копия, материализация и провизия до неё.
  const promiseMoved = await refreshPromise(deps, task)
  if (promiseMoved.length > 0) {
    writeLog(deps, {
      type: 'task.promise_arrived',
      taskId: task.id,
      detail: `слова задачи приехали после захвата и до старта (${promiseMoved.join(', ')}) — потолок ходов считается по ним`,
    })
  }

  // И СКОЛЬКО ХОДОВ ЕЙ ПОЛОЖЕНО — тот же вопрос, тем же выражением, что и на пути кода. Полоса
  // кузницы тоже платится подпиской, и повтор известного исхода стоит здесь ровно столько же.
  const turnBudget = turnBudgetFor(deps, config, task)
  if (turnBudget.cap === null) {
    const detail =
      `работа уже сожгла потолок в ${turnBudget.escalatedFrom} ходов, а предел всех подъёмов ` +
      `(${turnBudget.ceiling}) не оставляет большего — нужен человек: разбить задачу или отменить`
    writeLog(deps, { type: 'task.refused', taskId: task.id, reason: 'turns_exhausted', detail })
    await failTask(deps, task, { reason: 'turns_exhausted', route, now: now(), envelope, from: fleetState })
    result.failed = { taskId: task.id, reason: 'turns_exhausted', detail }
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
  // WHICH REPOSITORY THE DRAFT IS CUT IN — the one the TASK'S OWN STAMP names (taskTreeDir;
  // the screen's selection for an unstamped task, the launch dir only when no project is
  // connected at all). The code path already asks the seam this way and the forge lane was
  // once left reading the launch cwd, so a draft ordered for the connected project was
  // forged in whatever tree the daemon happened to start in.
  const branch = `wt/${task.id}`
  const provisionDir = taskTreeDir(deps, config, task)
  // The wait actually paid for the copy — measured around the call, not read off the answer,
  // for the same reason the code path measures it: the verb only knows its own inside time,
  // and an install whose CLI is older answers with no number at all.
  const provisionStartedAt = Date.now()
  // THE THIRD MISTAKE THIS DOOR WOULD OTHERWISE HAVE MADE TWICE. Where the copy goes is said
  // here by the SAME expression the code path uses — the two doors have already been fixed
  // separately once, and the one left behind is the one that keeps costing. Unsaid, the verb
  // names the directory after the daemon, identical for every task.
  const copyPath = taskWorktreePath({ taskId: task.id, projectDir: provisionDir, execGit: deps.execGit })
  const wt = await invokeVerb(
    verbRunner,
    'worktree',
    ['provision', '--branch', branch, ...(copyPath ? ['--path', copyPath] : []), '--json'],
    provisionDir,
  )
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
  // ТА ЖЕ МАТЕРИАЛИЗАЦИЯ, ТОЙ ЖЕ ФУНКЦИЕЙ. Забытая вторая дверь — мина, которую этот файл
  // уже дважды разминировал задним числом; здесь она закрыта тем же вызовом, что и наверху.
  materializeTaskContext(deps, task, worktreePath)
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
  // ТУМБЛЕР — В МОМЕНТ ЗАПУСКА, ТЕМ ЖЕ ВЫРАЖЕНИЕМ, ЧТО И НА ПУТИ КОДА. У кузницы та же пауза
  // между маршрутом и процессом (копия, зеркало, реестр серверов) и тот же человек, снимающий
  // тумблер внутри неё; полоса, где этот вопрос не задан, — это ровно та полоса, на которой
  // выключенный работник продолжит брать работу.
  const switchedOff = workerSwitchedOffNow(deps, route)
  if (switchedOff) {
    writeLog(deps, {
      type: 'task.refused',
      taskId: task.id,
      workerId: route.workerId,
      reason: switchedOff.reason,
      detail: switchedOff.detail,
    })
    // И КОПИЯ ОТЗЫВАЕТСЯ ТЕМ ЖЕ ВЫРАЖЕНИЕМ, ЧТО И НА ПУТИ КОДА: у кузницы та же пауза, та же рука
    // человека внутри неё и та же оставленная копия, которая достанется повтору переиспользованной.
    await discardFreshCopy(deps, verbRunner, { taskId: task.id, wt, path: worktreePath, branch, provisionDir })
    await failTask(deps, task, {
      reason: switchedOff.reason,
      branch,
      route,
      now: now(),
      envelope,
      from: fleetState,
      worktree: worktreeRow,
    })
    result.failed = { taskId: task.id, reason: switchedOff.reason, detail: switchedOff.detail }
    return result
  }
  // THE SAME ONE FUNCTION the code path above calls — not a second list of fields that
  // happens to say the same thing today. The last time these two points each carried their
  // own copy of this decision, one of them was updated and this one was not, and the lane
  // spawned read-only for weeks while the screen blamed the worker.
  const spec = buildArgs(task, route, {
    ...SPAWN_OPTIONS,
    ...(mcpConfig ? { mcpConfigPath: mcpConfig.path } : {}),
    ...envelopeSpawnOptions(envelope),
    // Тот же список сгоревших потолков, что и на пути кода: два места, где живёт одно правило,
    // однажды разойдутся, а одно выражение — нет.
    burnedTurnCaps: turnBudget.burnedCaps,
    // И ТА ЖЕ ГРАНИЦА ЗАПИСИ. У кузницы своей квитанции нет, но черновик она КОММИТИТ — а
    // git-каталог копии лежит снаружи рабочего каталога ровно так же. Одно выражение на обе
    // двери: вторая дверь спавна уже дважды оставалась без того, что получила первая.
    ...copyWriteSpawnOptions(deps, worktreePath),
    // The SAME one function the code path calls — see its own note about the last time these
    // two points each carried a private copy of a spawn decision.
    ...gateSpawnOptions(deps, config, task),
  })
  // И ЧЕМ ЗАПУЩЕНА ЭТА ПОПЫТКА — тем же выражением, что и на пути кода, прямо там, где команда
  // собрана. У кузницы своей квитанции нет: строка попытки — единственная запись о прогоне, и
  // без командной строки на ней вопрос «работник не мог или не стал» остаётся без ответа ровно
  // так же, как он остался 01.09.2026.
  worktreeRow.spawn = spawnRecordOf(spec)
  // И ДОМ ЗАДАЧИ — ТЕМ ЖЕ ВЫРАЖЕНИЕМ, ЧТО НА ПУТИ КОДА, И В ТОТ ЖЕ ДЕРЖАТЕЛЬ. Забытая вторая
  // дверь спавна — мина, которую этот файл уже разминировал дважды задним числом; дом, убранный
  // на одной полосе и копящийся на другой, был бы третьим разом.
  attemptWindow.taskId = task.id
  attemptWindow.codexHome = (spec.env && spec.env.CODEX_HOME) || null
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
  // И У ЭТОЙ ПОЛОСЫ ЕСТЬ ОКНО КООРДИНАЦИИ — закрывает его `finally` тика, тем же ходом и по
  // той же причине: закон «конец попытки закрывает сессию» не знает полос.
  attemptWindow.sessionOf = sessionOf
  attemptWindow.cwd = taskTreeDir(deps, config, task)
  attemptWindow.taskId = task.id
  // The steering wheel, same as the code path: the founder's «Перебить сейчас» must be able
  // to end a forge turn too, and a spawn nobody registered is a door that answers and does
  // nothing.
  // ТО ЖЕ ИМЯ ЗАХОДА, ЧТО У МЕСТА. Одно выражение на обеих полосах: имя, посчитанное здесь
  // вторым способом, однажды разошлось бы с тем, под которым место было названо, и дверь
  // отмены освобождала бы место, которого нет.
  const forgeAttemptId = attemptIdFor(task.id, task.attempt)
  const spawnSteered = steeredSpawn(deps, task.id, spawnWorker, forgeAttemptId)
  fleetState = 'RUNNING'
  // WHEN THIS ATTEMPT STARTED — captured where the process really begins, so a subscription
  // attempt books a duration instead of counting from epoch zero.
  const attemptStartedAt = now()
  const exit = await runSpawn(spawnSteered, { bin: spec.bin, args: spec.args, cwd: worktreePath, env: spec.env, prompt: spec.prompt }, onLine, now)
  if (deps.attemptTurns) deps.attemptTurns.done(task.id)
  // Место отдаётся на смерти ребёнка и у этой полосы — правило «место держит живой процесс» не
  // знает полос ровно так же, как его не знает закрытие координационного окна. И отдаётся оно
  // по имени ЗАХОДА, а не строки: полос это правило тоже не знает.
  confirmProcessGone(deps, task.id, forgeAttemptId)
  // СКОЛЬКО СОБИРАЛАСЬ СЕССИЯ — на строку попытки и здесь: у кузницы тот же спавн, то же
  // молчание до первого кадра и тот же человек у окна.
  worktreeRow.sessionStart = sessionStartRecord({ spawnedAt: attemptStartedAt, firstLineAt: exit.firstLineAt })

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
  const attemptTokens = bookAttemptUsage(deps, task, route, streamLines, now(), attemptStartedAt)

  // И СКОЛЬКО ХОДОВ УШЛО И НА ЧТО — тем же выражением, что и на пути кода: полоса кузницы
  // создаёт попытку, значит попытка кузницы обязана тот же счёт, что и всякая другая.
  const turnSpend = turnRecordOf(spec.args, streamLines)

  // The forge lane creates an attempt, so the forge lane owes a note like any other lane.
  // THE STREAM IS NOT TEXT: the markers live inside JSON frames, so the raw lines are
  // unwrapped first (`approachLinesFrom`) exactly as the code path does. Reading the frames
  // raw meant the note was never found and a green draft still failed «нет записки».
  const forgeNote = parseApproachNote(approachLinesFrom(streamLines))
  const { noted: noteWritten } = recordApproachNote(deps, task, forgeNote)

  // The forge lane creates an attempt, so the forge lane owes a MEMORY layer like any other —
  // and it owes it here, above every exit below, for the same reason the code lane writes it
  // above its own four. The lesson is the one field that differs: this lane produces a draft
  // instead of finished work and its gate never asks for a lesson, so the layer says so in
  // words rather than reporting a missing one the worker was never asked for.
  writeMemoryLayer(deps, task, {
    memory: memoryOf(),
    sma: collectSmaTrace({
      projectDir: taskTreeDir(deps, config, task),
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
      projectDir: taskTreeDir(deps, config, task),
      sessionId: sessionOf(),
      fsImpl: deps.fsImpl,
    }),
    guards: guardsOf(),
    permissionDenials: permissionDenialsOf(),
    ledgerPath: logFileOf(),
    exit,
    gate: 'forge',
    lesson: { none: 'полоса-кузница: урок с этой попытки не требуется' },
    approach: forgeNote,
    tokens: attemptTokens,
  })

  if (exit.spawnError) {
    await failTask(deps, task, { reason: 'runtime_offline', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
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
    await failTask(deps, task, { reason: 'provider_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
    result.failed = { taskId: task.id, reason: 'provider_error' }
    return result
  }

  // ВТОРАЯ ДВЕРЬ СПАВНА — ТА ЖЕ РУКА ХОЗЯИНА. Гейт ниже спрашивает у git ЗАКОММИЧЕННЫЙ черновик,
  // а песочница этой полосы запрещает запись в служебный каталог git копии ровно так же, как на
  // полосе кода: без этой строки написанный черновик читался бы как «draft not committed», то
  // есть как ошибка работника, который сделал всё, что мог. Каталог черновика назван явно —
  // он лежит под тем же префиксом, каким помечена обстановка демона, и общее правило прошло бы
  // мимо единственного файла, ради которого эта попытка работала.
  hostCommitAfterSession(deps, { task, route, workDir: worktreePath, include: [draftDirFor(kind)] })

  // (7) EXIT GATE = deterministic draft lint + committed-on-branch assertion (NOT reverify).
  const drafts = listCommittedDrafts(deps.execGit, branch, worktreePath, kind)
  if (drafts.length !== 1) {
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
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
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
    result.failed = { taskId: task.id, reason: 'agent_error', detail }
    return result
  }

  const lint = lintDraft({ kind, filePath: join(worktreePath, draftPath), fsImpl: deps.fsImpl })
  if (!lint.passed) {
    const failed = lint.checks.filter((c) => !c.ok).map((c) => c.name).join(',')
    await failTask(deps, task, { reason: 'agent_error', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
    result.failed = { taskId: task.id, reason: 'agent_error', detail: `lint failed: ${failed}` }
    return result
  }

  if (!noteWritten) {
    // Certified draft, unexplained attempt — the same gate, the same named failure.
    await failTask(deps, task, { reason: 'no_journal', branch, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
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
  await completeTask(deps, task, { receiptRef, branch, diffStat: null, route, now: now(), envelope, from: fleetState, sessionId: sessionOf(), startedAt: attemptStartedAt, worktree: worktreeRow, turns: turnSpend })
  result.completed = task.id
  return result
}

/**
 * complete a task through the adapter gate + write a rich (receipt-bearing) attempt row.
 * `from` names the fine state the task was really in; omitting it (the preflight-«built»
 * door) writes the row with no transition fields rather than an invented pair.
 */
/**
 * syncBeforeHandoff(deps, task, worktree) — СВЕСТИ ВЕТКУ С ВЕРШИНОЙ ДО СДАЧИ, в копии
 * работника, и записать результат туда, где его прочтёт и человек, и строка реестра.
 *
 * ЗАЧЕМ. Очередь отводит все работы от ОДНОЙ вершины, а вершина живёт минут двадцать. Замерено
 * 31.08.2026: за один вечер пять готовых работ из шести не слились с первого раза, и причина
 * всякий раз была одна — ветка отведена от того, чего к моменту приёмки уже нет. Цена такой
 * приёмки — либо возврат работнику (полная стоимость подхода заново), либо ручной развод
 * конфликта приёмщиком, а ручной развод и есть тот способ тихо откатить чужую свежую починку,
 * от которого дом уже пострадал. Свести — работа СДАЮЩЕГО, и она делается здесь, в его
 * собственной копии, где не задевает ни общее дерево, ни соседей.
 *
 * ПОЧЕМУ У ЭТОЙ ДВЕРИ, А НЕ У КАЖДОГО ГЕЙТА. `completeTask` — единственный вход в «сдано»:
 * двадцать три выхода тика ведут в него, и правило, поставленное здесь, действует на все, в том
 * числе на тот, который допишут завтра.
 *
 * ТОЛЬКО ТАМ, ГДЕ ЕСТЬ ЧТО СВОДИТЬ, И ЭТО ЧИТАЕТСЯ ИЗ УЖЕ ЗАДАННОГО ВОПРОСА. Попытка, ничего
 * не тронувшая (ответ словами, отказ до всякой правки), сводилась бы в пустой коммит слияния —
 * а по коммитам поверх базы гейты и считают, была ли работа вообще. Пустота узнаётся из
 * `worktree.changed`, снятого строкой выше: git спрашивают ОДИН раз за попытку, и это тоже
 * закон, а не бережливость — на нём стоят три запертых случая в сьюте тика. Неизвестность
 * («git не ответил») читается как «не сводим»: слияние в дереве, о котором git молчит, — не то
 * место, где стоит выяснять, почему он молчит.
 *
 * НИКОГДА НЕ ЦЕНОЙ ГОТОВОЙ РАБОТЫ. Конфликт, который не развёлся сам, НЕ проваливает попытку:
 * работа сделана, квитанция есть, и выбрасывать её за то, что вершина уехала, — ровно тот
 * возврат работнику, который здесь и оплачивается. Он записывается словами — в журнал
 * оператора и на строку реестра, — и приёмщик впервые видит состав конфликта до того, как
 * нажмёт «принять», а не после.
 */
async function syncBeforeHandoff(deps, task, worktree) {
  const cwd = worktree && worktree.worktreePath
  if (!cwd || typeof deps.execGit !== 'function') return null
  const trunk = (deps.config && deps.config.trunkBranch) || TRUNK_DEFAULT
  const branch = (worktree && worktree.branch) || null
  const changed = worktree.changed
  if (!changed || changed.answered !== true || changed.files.length === 0) return null

  const res = await syncWithTrunk({
    cwd,
    trunk,
    execGit: deps.execGit,
    message: `свести ${branch || 'ветку задачи'} с ${trunk} перед сдачей`,
  })

  // СУДЬБА РАЗВЕДЁННОГО ЗАВИСИТ ОТ ИСХОДА, И ДВУМ ИСХОДАМ НУЖНЫ ДВЕ ФРАЗЫ. Свелось — развод
  // лежит в коммите сведения и его наследует всякий, кто возьмёт ветку. НЕ свелось — сведение
  // откатано целиком, вместе с разводом, и «механически разведено: README.md» на этой строке
  // читалось как работа, которой в дереве нет. Верб сведения различает эти два случая с самого
  // начала («уже в индексе» / «слияние всё равно отменено целиком»); журнал двери сдачи —
  // не различал, и это ровно то враньё о состоянии дерева, от которого лечит вся эта дверь.
  const names = Array.isArray(res.resolved) && res.resolved.length
    ? res.resolved.map((r) => `${r.file} (${r.how})`).join(' · ')
    : ''
  const settled = names ? ` механически разведено: ${names};` : ''
  // На отказе НЕ утверждаем о дереве ничего: сказано лишь, что эти файлы разводятся сами и в
  // работу человека не входят, — это верно и когда откат прошёл, и когда он сам не удался.
  const settledOnRefusal = names ? ` механическое разводится САМО и рук не требует: ${names};` : ''
  // ОГОВОРКИ РАЗВОДА ЕДУТ ВМЕСТЕ С НИМ. Развод, прошедший с оговоркой («команда пересборки
  // вернула отказ, но обе стороны сошлись»), и развод, прошедший гладко, — разные события;
  // журнал, называющий их одинаково, врёт оператору ровно в том месте, ради которого он ведётся.
  const caveats = Array.isArray(res.notes) && res.notes.length ? ` оговорки: ${res.notes.join(' | ')};` : ''
  if (res.ok && res.synced) {
    writeLog(deps, {
      type: 'task.branch_synced',
      taskId: task.id,
      branch,
      detail: `ветка сведена с ${trunk} до сдачи: отставала на ${res.behind} коммит(ов);${settled}${caveats} слияние ${(res.mergeSha || '').slice(0, 7) || 'без имени'}`,
    })
  } else if (!res.ok) {
    writeLog(deps, {
      type: 'task.branch_unmerged',
      taskId: task.id,
      branch,
      detail:
        `свести с ${trunk} не удалось: ${res.detail || 'причина не названа'};${settledOnRefusal}` +
        ` работа уезжает человеку НЕСВЕДЁННОЙ — разводить придётся при приёмке` +
        (res.unfinishedMerge ? ` | ${res.howToClear}` : ''),
    })
  }

  // На копии — чтобы строка реестра, которую пишут обе двери, несла один и тот же ответ.
  worktree.sync = {
    trunk,
    behind: res.behind ?? null,
    synced: !!(res.ok && res.synced),
    ...(res.resolved && res.resolved.length ? { resolved: res.resolved } : {}),
    ...(res.ok
      ? {}
      : { unmerged: { count: res.count ?? 0, files: res.remaining ?? res.files ?? [], detail: res.detail ?? null } }),
  }
  return res
}

async function completeTask(deps, task, { receiptRef, branch, diffStat, route, now, envelope, from, sessionId, startedAt, worktree, turns }) {
  const { adapter, ledger, report, journal } = deps
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
  // …И ТОЛЬКО ПОТОМ ВЕТКА СВОДИТСЯ С ВЕРШИНОЙ. Порядок здесь — часть договора: список
  // изменённого выше снимается ДО сведения, иначе в «что тронула эта попытка» въехали бы
  // файлы, которых работник не касался, — всё, что вершина успела нажить, пока он работал.
  await syncBeforeHandoff(deps, task, worktree)
  const closing = {
    receiptRef,
    branch,
    diffStat,
    workerId: route && route.workerId,
    provider: route && route.provider,
    // WHOSE ATTEMPT IS BEING CLOSED — the fencing token this attempt was handed AT THE CLAIM,
    // travelling on the task object from there to here. Closing by NAME alone is the hole
    // measured on the live pilot: between the claim and this line the lease can expire, the
    // queue hands the row to a second worker, and the first — still alive, still finishing —
    // certifies work that is no longer his. The queue has been able to refuse a foreign token
    // since the previous wave; until this line it was never shown one, and a refusal nobody
    // can trigger is a comment, not a guard.
    // Absent (a row claimed before this product knew about tokens) stays absent: the contract
    // reads absence as absence and never as a licence to invent one.
    attemptToken: task.attemptToken,
  }
  try {
    await adapter.complete(task.id, closing)
  } catch (err) {
    // ═══ ПОЗДНЯЯ ПРАВДА ПЕРЕЗАПИСЫВАЕТ ПРИГОВОР СТОРОЖА ══════════════════════════════════
    //
    // Строки этой задачи в очереди больше нет ни одной активной — значит между началом
    // попытки и этой секундой её забрал сторож живости: он объявил замолчавшего мёртвым и
    // вернул задачу в очередь (liveness.mjs). А работа при этом ДОБЕЖАЛА и предъявила
    // квитанцию. До сих пор такое завершение проваливалось наружу, попадало в общий улов
    // тика и заканчивалось ещё одним `runtime_offline`: зелёная работа оставалась
    // похороненной под исходом, который сторож РЕКОНСТРУИРОВАЛ по молчанию. Квитанция
    // сильнее реконструкции — исход строки переписывается правдой завершения.
    if (!(err instanceof UnknownTaskError)) throw err
    // СНАЧАЛА СТРОКА, ПОТОМ ДЕЙСТВИЕ — та же выправка, что у сторожа: написанная после,
    // она пропала бы ровно в том случае, где стоит дороже всего. И это ВТОРАЯ запись, а не
    // замена первой: приговор сторожа остаётся в журнале выше своей строкой, поздняя правда
    // ложится рядом — читающий видит оба события, а не молчаливую подмену одного другим.
    if (typeof journal === 'function') {
      try {
        journal({
          type: 'attempt.late_complete',
          taskId: task.id,
          attempt: task.attempt ?? null,
          receiptRef,
          detail:
            `завершение попытки ${task.attempt ?? '?'} задачи ${task.id} пришло ПОСЛЕ того, как ` +
            'сторож живости закрыл строку и вернул задачу в очередь; работа предъявила квитанцию ' +
            `${receiptRef || 'без ссылки'} — исход строки перезаписывается правдой завершения.`,
        })
      } catch {
        /* повествование никогда не стоит работы, которая уже сделана */
      }
    }
    // Тот же вызов, тем же жетоном, но названный вслух: это завершение для строки, которую
    // уже забрал сторож. Жетон здесь по-прежнему решает: если задачу успел ЗАХВАТИТЬ второй
    // работник, очередь откажет чужим жетоном — и правильно, поздняя правда смеет перебить
    // реконструкцию сторожа, но не живую попытку соседа. Такой отказ уходит наверх и
    // становится обычным провалом тика.
    await adapter.complete(task.id, { ...closing, afterSweep: true })
  }
  if (ledger && typeof ledger.recordAttempt === 'function') {
    // ═══ РАБОТА УЖЕ ЗАВЕРШЕНА — ЗАПИСЬ О НЕЙ БОЛЬШЕ НЕ СМЕЕТ ЕЁ ОТМЕНИТЬ ═════════════════
    //
    // Строка очереди закрыта строчкой выше: `adapter.complete` уже прошёл, работа принята,
    // ветка на месте. Реестр здесь — НАБЛЮДЕНИЕ за этой работой, и до сих пор он звался
    // голым: брошенное им исключение уходило наружу, мимо `writeAttemptOutcome` и отчёта, в
    // общий улов тика — а тот честно объявлял ЗАВЕРШЁННУЮ попытку `runtime_offline` и
    // отправлял задачу на перевыдачу. Зелёная работа с квитанцией превращалась в «среда
    // недоступна», следующая попытка делала её заново и умирала на той же строке.
    // Дверь срыва по соседству обёрнута ровно от этого с прошлой фазы; здесь обёртки не было,
    // и потому она стоила дороже — там терялась ПРИЧИНА, здесь терялась РАБОТА.
    try {
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
        // И СКОЛЬКО ХОДОВ ЭТО СТОИЛО — на обоих исходах по той же причине. Попытка, которая
        // уложилась, — единственная мерка, с которой человек может сравнить ту, что не влезла.
        ...turnFields(turns),
        ...attemptStamp(deps, task, { from, to: from ? 'PRODUCED' : undefined, actor: 'worker', envelope }),
      })
    } catch (err) {
      // NEVER SILENT, И НИКОГДА НЕ ЦЕНОЙ РАБОТЫ: строка реестра потеряна, работа — нет.
      writeLog(deps, {
        type: 'ledger-error',
        taskId: task.id,
        reason: 'close_tool_broken',
        error: String((err && err.message) || err),
      })
    }
  }
  // HOW THE TRY ENDED, into the attempt's own directory. Written here rather than at the point
  // the rest of the record was written because THIS is where the outcome is first known.
  writeAttemptOutcome(deps, worktree, {
    outcome: 'completed',
    verdict: (worktree && worktree.run && worktree.run.verdict) || 'green',
    ref: receiptRef ?? null,
    lesson: (worktree && worktree.run && worktree.run.lesson) ?? null,
  }, task)
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
 * somebody will want to roll back. No copy (a refusal that came before provisioning — every
 * lane that reaches a spawn now has one) writes NO keys at all: absence says «there was none», where a null
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
    // ЧЕМ ПОПЫТКУ ЗАПУСТИЛИ — по той же причине, по какой здесь лежат две строки выше:
    // ответ нужен ПОСЛЕ, когда копия выметена, а восстановить его неоткуда. Отсутствие
    // ключа означает «процесса не было вовсе» (отказ до спавна), и это не то же самое,
    // что запуск, о котором мы не записали команду.
    spawn: worktree.spawn ?? undefined,
    // И СКОЛЬКО ПОПЫТКА СОБИРАЛАСЬ, ПРЕЖДЕ ЧЕМ ЗАГОВОРИТЬ — по той же причине, что и строка
    // выше: вопрос «работник повис или ещё готовит песочницу» задают ПОСЛЕ, когда поток
    // свёрнут, а копия выметена. Отсутствие ключа означает «процесса не было вовсе».
    sessionStart: worktree.sessionStart ?? undefined,
    // WHERE THE EVIDENCE OF THIS TRY LIVES. The row is the durable record, so it names the
    // directory rather than leaving it to be guessed from an id and a convention. `parity` is
    // the verdict of the checking tool, written back beside it; until it is computed the key
    // is present and null, which is «nobody has checked», not «checked and fine».
    runDir: (worktree.run && worktree.run.dir) || undefined,
    ...(worktree.run && worktree.run.dir ? { parity: worktree.run.parity ?? null } : {}),
    // СВЕДЕНА ЛИ ВЕТКА С ВЕРШИНОЙ — на обеих дверях, по той же причине, что и всё остальное в
    // этом объекте: приёмка выметает копию, и после неё ответить на этот вопрос неоткуда.
    // Отсутствие ключа означает «не сводили» (попытка без собственных коммитов, копии нет,
    // git недоступен), а не «свелось».
    sync: worktree.sync ?? undefined,
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

/**
 * ПОЛЯ ХОДОВ, готовые к раскрытию в строку реестра — ОДНО выражение на обе двери.
 *
 * Отсутствие остаётся отсутствием. Попытка, отказанная до всякого процесса (нет исполнителя,
 * конверт не пускает, потолок исчерпан), ходов не тратила вовсе, и нули на её строке читались
 * бы как измерение: «прогон был, и он ничего не сделал». Ключей у неё нет — это правда.
 *
 * @param {{turnCap?:number, turnsUsed?:number, turnKinds?:object}|null|undefined} turns
 * @returns {object} fields to spread into `recordAttempt`
 */
function turnFields(turns) {
  if (!turns || typeof turns !== 'object') return {}
  return {
    ...(Number.isFinite(turns.turnCap) ? { turnCap: turns.turnCap } : {}),
    ...(Number.isFinite(turns.turnsUsed) ? { turnsUsed: turns.turnsUsed } : {}),
    ...(turns.turnKinds && typeof turns.turnKinds === 'object' ? { turnKinds: turns.turnKinds } : {}),
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

async function failTask(deps, task, { reason, failureDetail, receiptRef, branch, route, now, envelope, from, sessionId, startedAt, worktree, turns }) {
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
  // ═══ ДВА КОНЦА У НЕУДАВШЕЙСЯ ПОПЫТКИ, И ВЫБОР МЕЖДУ НИМИ СДЕЛАН ЗДЕСЬ, ВСЛУХ ═══════════
  //
  // Until now there was one: every reason went through `fail`, the RETRYABLE door, and the
  // durable queue handed the row back twice more. For `turns_exhausted` those two re-issues are
  // decided before they run — the ceiling that stopped the attempt is the daemon's own and
  // travels onto the next command line unchanged, so attempt two and attempt three walk into
  // the same wall at the same step. Two paid attempts, one known outcome, on a subscription
  // somebody is paying for. What that ending needs is not another worker but a PERSON: raise
  // the ceiling, cut the task in pieces, or drop it — and the card now says exactly that.
  //
  // WHICH REASONS TAKE WHICH DOOR IS NOT DECIDED HERE. The question is asked of the queue's own
  // vocabulary (`failureAwaitsAPerson`, beside the reason dictionary), so the policy lives in
  // one place with the words that explain it to a person, and this line only obeys it. Every
  // other reason — a provider that cut the run, a lease the watchdog took back, an environment
  // that was down — keeps the retryable door and its re-issues exactly as before: those are
  // the causes a second attempt can outlive.
  //
  // THE TOKEN TRAVELS THROUGH BOTH, AND THIS HALF MATTERS AS MUCH AS THE OTHER ONE. A failure
  // is the retryable outcome, so a stale worker failing by name alone would hand a RUNNING
  // attempt's work to yet a third worker while the second is still doing it — and on the
  // parking door a stranger's word would CLOSE that running attempt with nothing behind it.
  // The token names the attempt that is really ending; the queue refuses a foreign one out loud.
  // …И ОДИН ИЗ КОНЦОВ ТЕПЕРЬ СПРАШИВАЕТСЯ О СТРОКЕ, А НЕ ТОЛЬКО О СЛОВЕ. Отказ нашего
  // инструмента закрытия имеет право на ОДИН повтор: первое падение бывает случайным. Второе
  // с тем же словом — стена, и `endingAwaitsAPerson` (тот же файл словаря, то же правило)
  // отправляет строку на паркующую дверь вместо третьей оплаченной попытки.
  const awaitsPerson = endingAwaitsAPerson(reason, task)
  if (awaitsPerson && typeof adapter.parkForPerson !== 'function') {
    // AN ADAPTER WITHOUT THE PARKING DOOR SAYS SO OUT LOUD. It then keeps the old behaviour —
    // the retryable door and its two re-issues — because a tick that threw here would lose the
    // failure itself, which is worse. But it is never silent: the whole point of the fork is
    // that a subscription is not spent on a known outcome, and a seam quietly falling back to
    // spending it is exactly the kind of silence this product refuses.
    writeLog(deps, { type: 'park-door-missing', taskId: task.id, reason })
  }
  if (awaitsPerson && typeof adapter.parkForPerson === 'function') {
    await adapter.parkForPerson(task.id, reason, { attemptToken: task.attemptToken })
  } else {
    await adapter.fail(task.id, reason, { attemptToken: task.attemptToken })
  }
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
        // И ТО ЖЕ САМОЕ СЛОВАМИ. Код причины — это имя двери, в которую попытка не прошла; он
        // одинаков у трёх подряд отказов с тремя разными причинами. Слова пишутся на строку
        // рядом с кодом, потому что читатель у них один и тот же и приходит он ПОСЛЕ: поток
        // попытки к тому времени свёрнут, а карточка — единственное, что осталось.
        // Отсутствие остаётся отсутствием: сказать нечего — ключа нет.
        failureDetail: failureDetail || undefined,
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
        // ПОТОЛОК, ПОД КОТОРЫМ ШЛА ЭТА ПОПЫТКА, И ЧЕМ ОНА ЗАНЯЛА СВОИ ХОДЫ. На этой строке
        // они несут двойную службу. Человеку они говорят, поднимать потолок или резать
        // работу: сто ходов правок и сто ходов запусков оболочки — разные диагнозы. Демону
        // потолок говорит, от какого числа поднимать следующий, — без записанного числа
        // «следующая попытка идёт с бóльшим запасом» было бы обещанием без арифметики.
        ...turnFields(turns),
        ...attemptStamp(deps, task, { from, to: from ? 'RETRYABLE' : undefined, actor: 'supervisor', envelope }),
      })
    } catch (err) {
      writeLog(deps, { type: 'ledger-error', taskId: task.id, reason, error: String((err && err.message) || err) })
    }
  }
  // ═══ СРЫВ ПОСТАВЩИКА ПОПАДАЕТ В ЖУРНАЛ В МОМЕНТ СОБЫТИЯ, А НЕ КОГДА ДОЙДЁТ МЕТЛА ═══════
  //
  // Метла (шаг 1c тика) спрашивает очередь, какие строки она САМА называет сорвавшимися, и
  // видит все концы разом — но только те, что уже закрыты. Обрыв поставщика закрытым концом не
  // является: он перевыдаваемый, строка возвращается в очередь ожидающей (`retry` → `queued` в
  // словаре очереди), и метле она не видна ВООБЩЕ, пока не кончатся перевыдачи. Замерено
  // 30.08.2026: строки о двух обрывах не было в журнале и через сорок минут после события, а
  // наблюдающий всё это время не знал, что работа умерла.
  //
  // ПОЧЕМУ ТОЛЬКО ЭТА ПРИЧИНА, А НЕ ВСЯКИЙ ПРОВАЛ. Дверь пишет о том, чего метла не увидит
  // вовремя, и ни о чём больше: журнал, собираемый и дверью, и метлой по одному и тому же
  // поводу, — это две строки об одном срыве. Ключ у обеих один (`bugKey`: задача, подход,
  // причина), так что метла, дошедшая до той же строки позже, узнаёт её и пропускает.
  //
  // FAIL-OPEN ЦЕЛИКОМ, как весь журнал: наблюдение за работой не бывает условием работы, и
  // реестр без этой двери (или отказавший на записи) стоит человеку строки, а не задачи.
  if (reason === 'provider_error' && ledger && typeof ledger.appendBug === 'function') {
    try {
      // СЛОВО МАШИНЫ БЕРЁТСЯ ОТТУДА ЖЕ, ОТКУДА ЕГО БЕРЁТ МЕТЛА — из реестра попыток, уже
      // дописанного строкой выше. Так строка двери и строка метлы об одном срыве совпадают
      // до поля, а не оказываются двумя правдами с разными числами.
      const led = typeof ledger.readAttempts === 'function' ? causeOf(ledger.readAttempts(task.id) || []) : {}
      ledger.appendBug({
        taskId: task.id,
        project: task.project,
        title: task.title,
        attempt: task.attempt,
        // Слово ОЧЕРЕДИ и слово РЕЕСТРА, как и требует строка журнала: у обрыва они совпадают,
        // потому что закрывает строку та же дверь, что записала попытку.
        reason,
        cause: led.cause ?? reason,
        causeAttempt: led.causeAttempt ?? task.attempt,
        attemptsRecorded: led.attemptsRecorded,
        workerId: (route && route.workerId) || undefined,
        endedAt: new Date(now).toISOString(),
        // КТО ДОПИСАЛ СТРОКУ — сказано полем, а не выводится из её формы: `sweep` — проход по
        // очереди, `live` — эта дверь, в момент события.
        source: 'live',
      })
    } catch (err) {
      writeLog(deps, { type: 'bug-journal-error', taskId: task.id, error: String((err && err.message) || err) })
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
  }, task)
  if (typeof report === 'function') {
    await report({ event: 'task.failed', taskId: task.id, title: task.title, lane: task.lane, receiptVerdict: receiptRef ? 'red' : undefined, branch, attempt: task.attempt })
  }
  // ═══ И ЗОВ ЧЕЛОВЕКА — НО НЕ НА КАЖДЫЙ ПРОВАЛ ═══════════════════════════════════════════
  //
  // Ровно два конца из всех отсюда упираются в человека, и оба уже названы выше по этой же
  // функции. Попытка, за которой повтора нет по устройству (`failureAwaitsAPerson`), стоит до
  // решения: поднять ограничение, разрезать работу или отменить. И строка, у которой очередь
  // исчерпала перевыдачи, — сама она больше не поедет. Всякий ДРУГОЙ провал молчит намеренно:
  // за ним стоит следующая попытка, которую заведёт демон, и звать человека к работе, которая
  // и без него продолжится, — это ровно тот шум, из-за которого канал перестают читать.
  //
  // Зов не ждёт своего успеха и никогда не роняет попытку: провал уже записан выше — и в
  // очередь, и в реестр, и в исход попытки, — а сообщение о нём вторично по отношению ко всем
  // трём. Молчание зова стоит одного несказанного слова; исключение отсюда стоило бы попытке
  // её собственного конца.
  const summonKind = awaitsPerson ? 'parked' : reason === ATTEMPTS_EXHAUSTED ? 'stopped' : null
  if (summonKind && deps.summon && typeof deps.summon.raise === 'function') {
    try {
      await deps.summon.raise({ kind: summonKind, taskId: task.id, title: task.title, reason, since: now })
    } catch (err) {
      writeLog(deps, { type: 'summon-error', taskId: task.id, error: String((err && err.message) || err) })
    }
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
