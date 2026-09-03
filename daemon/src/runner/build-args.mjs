/**
 * build-args.mjs — THE EXECUTOR THE TICK ASKS FOR.
 *
 * `loop.mjs` spawns a worker in two moves: `buildArgs(task, route, options)` assembles the
 * process spec, and `spawnWorker(spec)` starts it. The second half has been wired into the
 * composition root since the fleet shipped; the FIRST HALF WAS NOT WRITTEN. The loop guards
 * against exactly that — `executorBlocker` refuses every task with «этот демон не собран с
 * исполнителем … задачу некому запустить» — so the daemon has been honest about it on every
 * tick, and the refusal is what a person saw when a task never moved. This file is that
 * missing half.
 *
 * NOTHING HERE IS NEW MACHINERY. Every part it needs already exists in args.mjs, tested:
 * the argument arrays (buildClaudeArgs / buildCodexArgs), the prompt (buildTaskPrompt), the
 * per-account environment (buildAccountEnv), and the guard that refuses a silent model or
 * effort substitution (assertProfileParity). What was missing was the composition — which
 * worker the route named, which account is that worker's, which of the two CLIs to run, and
 * the assembly of the four into one spec. That composition is the whole of this file, and it
 * is deliberately small enough to read in one sitting.
 *
 * WHY A FACTORY. The tick calls `buildArgs` with THREE arguments — task, route, options — and
 * a route names a worker by id, not by profile. The account, the token env name and the spend
 * directory all live in config. So the composition root closes over config once and hands the
 * loop the three-argument function it expects. Config never travels through the tick.
 *
 * WHAT IT REFUSES, BY NAME, RATHER THAN GUESSING:
 *   - a route with no worker (the API-fallback and window-exhausted branches): there is no
 *     account to run under, and inventing one would spend money from a profile nobody chose;
 *   - a worker id that is not in config, or a worker with no account block;
 *   - a model/effort that does not match the profile — that guard is imported, not rewritten;
 *   - a task carrying a stage envelope this daemon has no command for (see stagePromptOf);
 *   - a Codex spawn whose fresh home carries no login and whose environment names no API key:
 *     it would answer 401 inside the child, where no screen out here can name the cause.
 * Each throw is caught by the tick's own catch and becomes a NAMED task failure, which is the
 * behaviour the rest of the loop is built around: a refusal on the record beats a crash.
 *
 * TWO SHAPES OF PROMPT, AND THE ENVELOPE PICKS ONE. An ordinary task travels as fenced DATA,
 * because its text was written by a person. A stage of the phase cycle travels as the BARE
 * command, because a command inside a fence is inert text — and it is REBUILT from the frozen
 * dictionary in policy/phase-cycle.mjs rather than read off the task's title, so the one string
 * that reaches a worker unfenced can only ever be one of four constants.
 *
 * WHAT IS DELIBERATELY NOT HERE, so it is a known gap and not a silent one:
 *   - MCP servers. This file now ACCEPTS a written config path as an option and puts it on the
 *     command line, but it does not write the file: the per-task directory belongs to the tick,
 *     which is the only caller that knows where this attempt's copy lives. A tick that names
 *     no path spawns without MCP servers, exactly as before — an absent flag is a better
 *     answer than a directory invented here.
 *   - Codex session resume. `resumeThreadId` is supported by that lane's builder and nothing
 *     here offers it yet. The Claude lane's `resumeId` IS wired (see the spawn options below):
 *     the tick decides whether this wake may continue the previous session, and this file
 *     carries the decision into the builder, where the fresh-session lock already lives.
 */

import {
  buildAccountEnv,
  buildTaskPrompt,
  assertProfileParity,
  expectedModelEffort,
  codexWorkspaceWriteSupport,
  codexSandboxSourceFor,
  codexSandboxRefusal,
  seedCodexHome,
  CodexHomeError,
  CodexSandboxUnsupportedError,
  CODEX_AUTH_FILE,
} from './args.mjs'
import { readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import { expandHome } from './readiness.mjs'
// КАКАЯ ЭТО ПОЛОСА — ОДНОЙ СТРОКОЙ ТАБЛИЦЫ, а не сравнением имени в четырёх местах этого
// файла. Двоичный файл, раскладка решений по флагам и перевод гранта в границу запуска
// спрашиваются у неё; всё, что таблица о полосе не говорит, по-прежнему решается здесь.
import { laneAdapter } from './provider-adapter.mjs'
// HOW a named program is started on this operating system — the last step of the composition,
// and the only one that is about the machine rather than about the task. See step (7).
import { resolveWorkerBin } from './resolve-bin.mjs'

import { pipelineMaxTurns } from '../config.mjs'
import { stageCommand } from '../policy/phase-cycle.mjs'
import { taskTurnCap } from '../policy/turn-budget.mjs'

/** The route named no worker this spawn could run as. */
export class NoWorkerForRouteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoWorkerForRouteError'
  }
}

/**
 * КАЖДЫЙ ЧЕСТНЫЙ ПОТОЛОК ЭТОЙ РАБОТЫ УЖЕ СГОРЕЛ — запускать нечего.
 *
 * Бросается вместо того, чтобы поставить на командную строку число, которое уже проиграло.
 * Это оборона в глубину, а не основная тропа: тик отказывает раньше, ДО провизии копии, и
 * ставит работу человеку с названными вариантами. Но сборщик — последний отрезок дороги до
 * процесса, и он не имеет права молча выдать повтор известного исхода, если проверку выше
 * когда-нибудь обойдут.
 */
export class TurnCapExhaustedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TurnCapExhaustedError'
  }
}

/** The task carries a stage envelope this daemon has no command for. */
export class UnknownStageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownStageError'
  }
}

/**
 * The default binaries. Which one runs is the route's provider; WHERE it lives is PATH's job.
 *
 * ОБЪЯВЛЕНЫ ТЕПЕРЬ В ТАБЛИЦЕ ПОЛОС и отдаются отсюда наружу прежними именами: имя двоичного
 * файла — свойство полосы, и этот сборщик его спрашивает, а не выбирает.
 */
export { CLAUDE_BIN, CODEX_BIN } from './provider-adapter.mjs'

/** Names that carry an account secret and are set for the child DELIBERATELY, never inherited. */
const ALWAYS_STRIPPED = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'])

/**
 * workerBaseEnv(env, config) → the environment a child process needs from the operating
 * system, with every account secret removed.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT, measured on the first live spawn: passing only the
 * account's own three variables as the child's env REPLACES the environment rather than
 * extending it — so the child had no PATH, could not find its own binary, and the spawn died
 * with ENOENT. A worker session is an ordinary program: it needs PATH, the system root, a
 * temp directory, a home. Those come from the daemon's own environment.
 *
 * What must NOT come from there is anyone else's key. The daemon holds the token variables of
 * EVERY configured account; inheriting them wholesale would put account B's credential inside
 * account A's session — the exact opposite of the per-spawn isolation buildAccountEnv exists
 * for. So every name any account declares is stripped, and the ONE credential this spawn is
 * entitled to is put back by buildAccountEnv, under the standard name, from the account it
 * was routed to.
 *
 * @param {object} env
 * @param {object} config
 * @returns {object}
 */
function workerBaseEnv(env, config) {
  const secretNames = new Set(ALWAYS_STRIPPED)
  for (const w of Array.isArray(config.workers) ? config.workers : []) {
    const account = w && w.account
    if (!account) continue
    if (account.oauthTokenEnv) secretNames.add(String(account.oauthTokenEnv))
    if (account.apiKeyEnv) secretNames.add(String(account.apiKeyEnv))
  }
  const out = {}
  for (const [key, value] of Object.entries(env || {})) {
    if (secretNames.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * stagePromptOf(task) → the bare stage command for a task of the phase cycle, or null for an
 * ordinary task, which is every task without a stage envelope.
 *
 * A STAGE NOBODY DECLARED IS A REFUSAL, NOT A FALLBACK. Returning the fenced prompt for a row
 * whose `data.stage` is unknown — or whose phase fails the grammar the command is substituted
 * into — would start a session that does nothing useful and then be judged by the DOCUMENTARY
 * exit gate, which is waiting for a document that no one is writing. A named throw becomes a
 * named task failure at the tick's catch, and the row says why.
 *
 * @param {object} task
 * @returns {string|null}
 */
function stagePromptOf(task) {
  const data = task && typeof task.data === 'object' && task.data !== null ? task.data : null
  const stage = data ? data.stage : undefined
  if (stage === undefined || stage === null || stage === '') return null

  const command = stageCommand(stage, data.phase)
  if (command === null) {
    throw new UnknownStageError(
      `buildArgs: task ${String(task.id ?? '?')} carries stage "${String(stage)}" for phase ` +
        `"${String(data.phase ?? '')}", which this daemon has no command for — refusing rather ` +
        'than running it as an ordinary task the documentary gate would then judge as unfinished',
    )
  }
  return command
}

/**
 * readAccountSettings(configDir, readFile) → the account's own settings file as an object, or
 * `{}` when there is nothing readable there.
 *
 * FAIL-OPEN ON THE READ, FAIL-CLOSED ON THE GUARD, and the pair is deliberate. A missing or
 * broken file must not throw here, because a filesystem error at this point would be reported
 * as «could not build the arguments», which says nothing about what is actually wrong. It
 * becomes an empty object instead — and an empty object states that hosted connectors were
 * never switched off, so the parity guard downstream refuses the spawn by name. That refusal
 * is the correct outcome: an account nobody mirrored is not the founder's session, and a
 * worker that starts in one is the failure this whole layer exists to prevent.
 *
 * @param {string} configDir
 * @param {(p:string, enc:string)=>string} readFile
 * @returns {object}
 */
function readAccountSettings(configDir, readFile) {
  if (!configDir) return {}
  try {
    const parsed = JSON.parse(readFile(join(String(configDir), 'settings.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The name of the environment variable that authenticates a Codex session WITHOUT a login
 * file. It is the one honest reason a home with no `auth.json` may still be spawned into.
 */
const CODEX_API_KEY_ENV = 'OPENAI_API_KEY'

/**
 * codexAuthSources(account, env) → where this account's Codex login might be, best first.
 *
 * A FRESH HOME REPLACES `~/.codex`, IT DOES NOT EXTEND IT, so the login has to be carried in
 * or the run answers 401 and never learns it is on a subscription. The order is the order of
 * how specific the claim is:
 *   1. `account.codexAuthFile` — the operator said it outright; nothing overrides that.
 *   2. `<configDir>/auth.json` — the account's OWN login, mirrored into its own directory,
 *      exactly where the Claude lane keeps that account's `settings.json`.
 *   3. `$CODEX_HOME/auth.json` — the home the DAEMON itself was started with, if any.
 *   4. `~/.codex/auth.json` — where `codex login` puts it. Last, and deliberately present:
 *      the fleet runs as the person who logged in, and a fleet that refuses to start because
 *      nobody hand-copied a file into a mirror directory is a fleet nobody can switch on.
 * The tilde is resolved on the way, for the same reason the home path is.
 */
function codexAuthSources(account, env, homedir) {
  const out = []
  if (account && account.codexAuthFile) out.push(expandHome(String(account.codexAuthFile), homedir))
  if (account && account.configDir) out.push(join(expandHome(String(account.configDir), homedir), CODEX_AUTH_FILE))
  if (env && env.CODEX_HOME) out.push(join(expandHome(String(env.CODEX_HOME), homedir), CODEX_AUTH_FILE))
  const personal = (env && (env.HOME || env.USERPROFILE)) || homedir()
  if (personal) out.push(join(String(personal), '.codex', CODEX_AUTH_FILE))
  return out
}

/**
 * createBuildArgs({config, env, fsImpl}) → the `buildArgs(task, route, options)` the tick wants.
 *
 * `fsImpl` exists so the settings read above can be exercised without a real home directory:
 * the suite injects a reader, production passes nothing and gets `node:fs`.
 *
 * `nodePath` is the interpreter a Windows npm shim is translated into (step 7). It defaults to
 * the binary this daemon is already running under — the one node we know exists on this
 * machine — and is injectable so the suite can assert the translation without one.
 *
 * `platform` is the machine this spawn would run on. It exists for ONE question — whether a
 * Codex home can really enforce `workspace-write` here (see step 5b) — and is injectable for
 * the same reason `fsImpl` is: the suite must be able to drive the Windows branch from a Mac.
 *
 * @param {{config?:object, env?:object, fsImpl?:object, homedir?:Function, nodePath?:string, platform?:string}} [deps]
 * @returns {(task:object, route:object, options?:object) => {bin:string, args:string[], env:object, prompt:string, workerId:string, provider:string}}
 */
export function createBuildArgs({ config = {}, env = process.env, fsImpl, homedir = osHomedir, nodePath = process.execPath, platform = process.platform } = {}) {
  const readFile = (fsImpl && fsImpl.readFileSync) || readFileSync
  return function buildArgs(task, route, options = {}) {
    if (!task || typeof task !== 'object') {
      throw new NoWorkerForRouteError('buildArgs: a task is required')
    }
    if (!route || typeof route !== 'object') {
      throw new NoWorkerForRouteError('buildArgs: a route is required')
    }

    // ── (1) WHICH WORKER, AND IS IT REALLY THERE ────────────────────────────────
    // A route without a worker id is a real routing outcome, not a bug: the API-fallback
    // branch and the window-exhausted branch both produce one. Neither can be spawned —
    // there is no account, and running under someone else's would spend from a profile the
    // founder did not choose for this task. Refused by name; the tick records the reason.
    if (!route.workerId) {
      throw new NoWorkerForRouteError(
        `buildArgs: the route named no worker (${route.reason ?? 'no reason given'}) — ` +
          'this daemon spawns only under a worker profile with its own account, so there is nothing to run as',
      )
    }
    const workers = Array.isArray(config.workers) ? config.workers : []
    const worker = workers.find((w) => w && w.id === route.workerId)
    if (!worker) {
      throw new NoWorkerForRouteError(
        `buildArgs: the route names worker "${route.workerId}", which is not in this daemon's config`,
      )
    }
    if (!worker.account || typeof worker.account !== 'object') {
      throw new NoWorkerForRouteError(
        `buildArgs: worker "${worker.id}" has no account block — a session needs a config dir and a token name to run under`,
      )
    }

    // ── (2) WHICH CLI ───────────────────────────────────────────────────────────
    // ПОЛОСА БЕРЁТСЯ ИЗ ТАБЛИЦЫ, А НЕ УГАДЫВАЕТСЯ ИМЕНЕМ. Маршрут, не назвавший поставщика,
    // читается полосой по умолчанию — ровно как читался веткой `else` до таблицы, только
    // теперь это объявлено там, где о полосах говорят, а не подразумевается здесь.
    const provider = String(route.provider ?? worker.provider ?? 'claude')
    const lane = laneAdapter(provider)

    // ── (3) MODEL AND EFFORT ────────────────────────────────────────────────────
    // Taken from the SAME function the parity guard measures against, so the assertion below
    // can never be satisfied by accident: whatever precedence expectedModelEffort declares is
    // the precedence the spawn gets. null means «the CLI's own default» and emits no flag —
    // naming a model nobody asked for would itself be the substitution the guard exists to catch.
    const { model, effort } = expectedModelEffort({ worker, task })

    // ── (3b) HOW FAR THIS ATTEMPT MAY WALK ──────────────────────────────────────
    // Не одно число на всю работу. База — настройка человека; во сколько раз больше неё
    // получит ЭТА работа, решает `taskTurnCap` по объявленным полям задачи, и он же
    // отказывается выдать потолок, который для этой задачи уже сгорел. Считается ДО сборки
    // массива, чтобы отказ стоил ноль процессов.
    const turnBudget = taskTurnCap({
      base: pipelineMaxTurns(config),
      task,
      // Потолки, которые эта задача уже сожгла. Их приносит тик из реестра попыток — только
      // он знает, где реестр лежит; здесь они просто число за числом.
      burnedCaps: Array.isArray(options.burnedTurnCaps) ? options.burnedTurnCaps : [],
    })
    if (turnBudget.cap === null) {
      throw new TurnCapExhaustedError(
        `buildArgs: task "${task.id}" already burned a ceiling of ${turnBudget.escalatedFrom} turns and the ` +
          `limit of all raises (${turnBudget.ceiling}) leaves nothing bigger to hand it — this work needs a ` +
          'person to cut it up, not another attempt under a ceiling that has already failed',
      )
    }

    // ── (4) THE ARGUMENT ARRAY ──────────────────────────────────────────────────
    const argOpts = {}
    if (model !== null) argOpts.model = model
    if (effort !== null) argOpts.effort = effort

    // ОДНО ЧТЕНИЕ КОНВЕРТА НА ДВА ВОПРОСА: какую песочницу поставить на командную строку и
    // сможет ли эта машина её исполнить (шаг 5b). Второе решение, посчитанное из второго
    // выражения, — это ровно тот способ отказать в одной песочнице, а запустить в другой.
    //
    // THE ENVELOPE REACHES EVERY LANE — each in the shape its CLI has for the question. One
    // lane hands the grant over as `--allowedTools`, and its sandbox is therefore null; the
    // other has no tool flags at all, so a grant that includes an editor and a shell becomes
    // `workspace-write` and a grant that includes neither becomes `read-only`. ОДНО
    // ВЫРАЖЕНИЕ НА ОБЕ ДВЕРИ (таблица полос): страж и работник не могут оказаться ограничены
    // двумя разными прочтениями одного конверта.
    const codexSandbox = lane.sandboxOf(options.allowedTools)
    let bin = lane.bin
    // ЧТО РЕШЕНО О ЗАПУСКЕ — ОДНИМ НАБОРОМ, А РАСКЛАДКА ПО ФЛАГАМ — ЗА ПОЛОСОЙ. Раньше здесь
    // стояли две ветки, и каждая знала про свой CLI; теперь набор один, а КАКИЕ из этих решений
    // командная строка правда унесёт, объявлено в строке полосы — включая то, чего она унести
    // не может (у `codex exec` нет флага ни для потолка ходов, ни для списка инструментов).
    //
    // The live attempt log is the reason the tool grant is in this bag at all: policy that is
    // computed and never reaches the process is not policy but bookkeeping — and for this
    // fleet's whole life it left every worker read-only: the child refused Edit on sight, the
    // attempt died as «no receipt», and no screen could name the cause (12.08.2026).
    let args = lane.argsOf({
      ...argOpts,
      sandbox: codexSandbox,
      // HOW FAR THIS ATTEMPT MAY WALK, carried to the process rather than kept as a setting.
      //
      // A headless worker has nobody to stop it: handed work it cannot finish, it re-reads,
      // re-tries and re-reasons until the money runs out, and every one of those turns is a
      // subscription minute burnt in a circle at three in the morning. The ceiling is the one
      // number that turns that into a stop — and a stop only exists if the number is HERE, in
      // the argument array of the spawn, rather than in a field somebody means to read later.
      //
      // ЧИСЛО ТЕПЕРЬ НЕ ОДНО НА ВСЁ. Настройка человека осталась базой; сколько получит эта
      // работа — посчитано выше по её объявленному размеру и по потолкам, которые она уже
      // сожгла. Эта строка по-прежнему остаётся последним отрезком дороги между решением и
      // процессом, который обязан ему подчиниться.
      maxTurns: turnBudget.cap,
      // WHAT WOKE THIS ATTEMPT, AND WHETHER IT MAY CONTINUE THE PREVIOUS SESSION — decided by
      // the tick, which is the only place that knows, and DELIVERED HERE so the builder's own
      // fresh-session lock finally stands on the path a task takes.
      //
      // It did not, until this line. The lock refuses a continuation to every wake that must
      // start clean, and the tick used to append the continuation onto an ALREADY ASSEMBLED
      // array — past the builder and therefore past the lock. Written, covered, green, and
      // guarding nothing on this road. Nothing new is invented here: the wake kind travels,
      // and the rule that was always there does the refusing.
      ...(options.wakeKind ? { wakeKind: String(options.wakeKind) } : {}),
      ...(options.resumeId ? { resumeId: String(options.resumeId) } : {}),
      // The per-spawn MCP config, when the tick wrote one. The path is all that travels: the
      // file itself is built by the arg module from the ENABLED registry entries only.
      ...(options.mcpConfigPath ? { mcpConfigPath: String(options.mcpConfigPath) } : {}),
      forwardSubagentText: options.forwardSubagentText === true,
      allowedTools: options.allowedTools,
      // AND THE REFUSAL TRAVELS BESIDE THE GRANT. The envelope's human-only actions —
      // the ones a person keeps for himself — arrive here already translated into tool
      // patterns, and this line is the last stretch of road between that decision and the
      // process that has to obey it. An empty list changes the argument array by not one
      // byte, so every spawn that names no refusal is assembled exactly as before.
      disallowedTools: options.disallowedTools,
    })

    // THE GUARD THAT SCREAMS — imported, never re-implemented here. It throws
    // ProfileParityError naming the field that diverged. It is handed the account's OWN
    // settings as they stand on disk, so the two halves of the session no flag can show —
    // the enabled plugins and the hosted-connectors switch — are checked against the profile
    // in the same breath as model and effort. Read here rather than inside the guard: the
    // guard stays a pure function over data, and the disk stays with the composer.
    const accountSettings = readAccountSettings(worker.account.configDir, readFile)
    assertProfileParity({ args, worker, task, accountSettings })

    // ── (5) THE ENVIRONMENT, ASSEMBLED PER SPAWN ────────────────────────────────
    // Never process-global, never shared between two workers: the account's config dir, its
    // token BY NAME, its spend directory, and the headless marker.
    const spawnEnv = buildAccountEnv({
      account: worker.account,
      // The OS environment the child cannot run without, minus every account's secrets — see
      // workerBaseEnv. Without it the child inherits nothing at all, not even PATH.
      baseEnv: workerBaseEnv(env, config),
      provider,
      env,
      useApiFallback: route.useApiFallback === true,
      taskId: task.id,
      // The two paths the parking gate inside the child needs. Passed straight through: this
      // composer does not know where an attempt directory lives and must not start guessing —
      // the tick computes both with the modules that own those layouts and hands them here.
      gate: options.gate,
      homedir,
    })

    // ── (5a) AND FOR CODEX, THE HOME IS ACTUALLY MADE ───────────────────────────
    //
    // THE GAP THIS CLOSES. `buildAccountEnv` above names a fresh per-task CODEX_HOME in the
    // child's environment, and until this block nothing anywhere created or seeded it —
    // `codexConfigSeed` had not one caller in the product. So the sentence «native memories
    // are off for every Codex task» was true of a source comment and of nothing on any disk,
    // and, far more expensively, the fresh home carried NO LOGIN: a fresh CODEX_HOME replaces
    // the operator's own rather than extending it, and a live run against an empty one
    // answers 401 and walks off to the public API endpoint without ever knowing it was on a
    // subscription. Both are wire failures, not logic failures, which is why the fix is a
    // call at the seam and not a cleverer function.
    //
    // IT HAPPENS HERE, in the composer, for the reason `readAccountSettings` lives here: the
    // guard and the builders stay pure over data, and the disk stays with the one function
    // that already touches it.
    //
    // NO LOGIN AND NO KEY → A NAMED REFUSAL, not a spawn. The tick turns a throw here into a
    // recorded task failure with a reason on the card. The alternative is a session that
    // starts, burns a window and dies inside the child process on an authentication error no
    // screen out here can name — which is precisely the failure class this file was written
    // to end.
    // КОМУ ЧЕКАНИТСЯ ДОМ ЗАДАЧИ — СПРАШИВАЕТСЯ У ПОЛОСЫ, а не у её имени. Сам посев остался
    // здесь: он трогает диск и бросает именованные отказы, и переносить его в таблицу вместе с
    // объявлением полосы значило бы менять две вещи одним движением.
    if (lane.seedsTaskHome) {
      const seeded = seedCodexHome({
        home: spawnEnv.CODEX_HOME,
        authSources: codexAuthSources(worker.account, env, homedir),
        // ── И СЛЕД ПЕСОЧНИЦЫ ЕДЕТ ИЗ ТОГО ЖЕ КАТАЛОГА, ЧТО И ЛОГИН ──────────────
        //
        // Элевированная установка на Windows проводится РУКОЙ и для ОДНОГО дома — счёта
        // (`codex sandbox setup --elevated --current-user --codex-home <configDir>`), потому
        // что она заводит машинных пользователей и требует прав, которых у демона нет и не
        // должно быть. Дом ЗАДАЧИ свежий и лежит внутри этого же каталога — унаследовать он
        // ничего не может, а без следа установки его `--sandbox workspace-write` не будет
        // исполнен: сессия стартует читающей и молча. Поэтому источник — сам каталог счёта,
        // ровно тот, в котором лежит и его `auth.json`: один провизированный шаблон на счёт,
        // копия на задачу, ничего общего между задачами.
        //
        // `account.configDir` без счёта — это `null`, то есть «источника нет»: посев ничего
        // не сеет, конфиг выходит прежним, и дом честно выглядит непровизированным. Путь
        // собирается ТЕМ ЖЕ выражением, каким тик заранее считает, ляжет ли посев
        // (codexSandboxSourceFor): две сборки одного пути — это страж и посев про разные дома.
        sandboxSource: codexSandboxSourceFor({ account: worker.account, homedir }) ?? undefined,
        // ── И КАТАЛОГ, В КОТОРЫЙ ЭТА РАБОТА СДАЁТСЯ ─────────────────────────────
        //
        // `workspace-write` открывает на запись РАБОЧИЙ КАТАЛОГ и ничего больше, а копия
        // задачи — рабочее дерево git: её `.git` это файл-указатель, а индекс, ссылки и
        // объекты лежат в основном репозитории, СНАРУЖИ копии. Сессия поэтому честно правила
        // файлы и не могла их закоммитить, а гейт закрывал попытку как «нет квитанции» —
        // на карточке виноват работник (замерено 01.09.2026). Список приносит ТИК: только он
        // знает, где стоит копия этой попытки; этот файл не имеет своей руки к git и не
        // должен её заводить. Тик не назвал ничего — секции в конфиге не будет, и дом выйдет
        // ровно прежним.
        writableRoots: Array.isArray(options.writableRoots) ? options.writableRoots : undefined,
        fsImpl,
      })
      // ASKED OF THE ENVIRONMENT THE CHILD WILL ACTUALLY HAVE, not of the daemon's own: those
      // two differ by exactly the secret-stripping above, and a key present here and stripped
      // there would be a refusal we chose not to make about a 401 we would then get anyway.
      if (!seeded.authPath && !spawnEnv[CODEX_API_KEY_ENV]) {
        throw new CodexHomeError(
          `buildArgs: the fresh Codex home ${seeded.home} has no ${CODEX_AUTH_FILE} and the environment names no ` +
            `${CODEX_API_KEY_ENV} — a session started in it would answer 401 and spend a window saying so. ` +
            'Point account.codexAuthFile at this account\'s login, or mirror it into the account directory.',
        )
      }

      // ── (5b) И ИСПОЛНИТ ЛИ ЭТА МАШИНА ТУ ПЕСОЧНИЦУ, КОТОРУЮ МЫ СОБИРАЕМСЯ ОБЕЩАТЬ ──
      //
      // ФЛАГ НА КОМАНДНОЙ СТРОКЕ — ЭТО ПРОСЬБА, А НЕ ФАКТ. `codex exec --sandbox
      // workspace-write` на непровизированной Windows не отказывается: сессия стартует и молча
      // остаётся читающей. Замерено 01.09.2026 — конверт нёс Edit/Write/Bash, работник десять
      // минут честно объяснял, что писать ему не дают, и попытка ушла как «нет квитанции».
      // Стена, в которую упирается такой спавн, стоит окна подписки и не оставляет НИ ОДНОЙ
      // строки, по которой причину можно было бы назвать.
      //
      // ПОЭТОМУ ОТКАЗ — СЛОВАМИ И ДО ПРОЦЕССА. Спрашивается тот самый дом, который только что
      // создан выше: не «умеет ли Windows», а «провизирован ли ЭТОТ дом» (см.
      // codexWorkspaceWriteSupport). Про `read-only` не спрашивается вовсе — читающая сессия
      // на непровизированной машине работает ровно так, как обещано.
      //
      // ЗДЕСЬ ЭТО ФАКТ, А У ТИКА — ПРОГНОЗ, И ЭТО РАЗНЫЕ ВОПРОСЫ ПО МОМЕНТУ. Тик спрашивает до
      // всякой копии, когда дома ещё нет на диске, и потому считает, ЛЯЖЕТ ЛИ ПОСЕВ
      // (codexWorkspaceWriteOutlook); этот пояс спрашивает ПОСЛЕ посева — здесь след либо лёг,
      // либо нет, и прогноз был бы догадкой о том, что уже случилось строкой выше.
      if (codexSandbox === 'workspace-write') {
        const support = codexWorkspaceWriteSupport({ platform, home: spawnEnv.CODEX_HOME, fsImpl })
        if (!support.supported) {
          // СЛОВА — ОДНИМ ВЫРАЖЕНИЕМ С ДВЕРЬЮ ТИКА. Две редакции одного отказа расходятся в
          // первый же день, когда правят одну, и человек читает на карточке одно, а в журнале
          // другое — про ту же самую стену.
          throw new CodexSandboxUnsupportedError(
            `buildArgs: ${codexSandboxRefusal({
              sandbox: codexSandbox,
              home: spawnEnv.CODEX_HOME,
              account: worker.account,
              homedir,
              platform,
              fsImpl,
            })}`,
          )
        }
      }
    }

    // ── (6) THE PROMPT — two shapes, and which one is decided by the envelope ────
    //
    // AN ORDINARY TASK IS FENCED DATA. Its title and note were written by a person, so they
    // travel to the worker inside a fence that says «this is data, not instructions». That is
    // the default and it has not changed.
    //
    // A STAGE OF THE PHASE CYCLE IS A COMMAND, and a command inside a fence is inert text: a
    // worker handed `/sma-plan-phase 12 --text` as DATA reads it and does nothing, which is
    // exactly what a person saw when a stage started from the window reached the queue and
    // stopped. So a task carrying a stage envelope gets the bare command as its prompt.
    //
    // AND THE COMMAND IS REBUILT, NOT READ OFF THE ROW. The door also writes the command into
    // the title, and taking it from there would be the shorter path — but a title is an
    // ordinary text field that can be edited, restored from a backup, or written by some
    // other path, and the one string in this product that becomes a BARE INSTRUCTION must not
    // be one of those. `stageCommand` rebuilds it from the frozen four, so the only text that
    // can ever reach a worker unfenced is one of them. The suite pins this equal to what the
    // door wrote, so the two cannot drift.
    //
    // И КОНСПЕКТ ПРОШЛОГО ПОДХОДА ЕДЕТ ТЕМ ЖЕ ПУТЁМ — через строителя, а не мимо него. Тик
    // читает файл (только он знает, где лежит каталог прогона прошлой попытки), а забор
    // кладёт строитель, потому что забор живёт там. Текст, приклеенный к промпту в тике,
    // поехал бы голым: это тот же класс ошибки, что и продолжение сессии, дописанное мимо
    // строителя аргументов, — написанное, покрытое делом, зелёное и не охраняющее ничего.
    // Стадия конспекта не получает: её промпт — замороженная команда, а не данные задачи.
    const prompt =
      stagePromptOf(task) ?? buildTaskPrompt({ task, continuationSummary: options.continuationSummary })

    // ── (7) AND HOW THAT PROGRAM IS STARTED ON THIS OPERATING SYSTEM ────────────
    //
    // LAST, AND DELIBERATELY AFTER EVERY GUARD. Everything above decides WHAT the CLI is asked
    // to do — the flags, the parity assertion, the envelope's boundary — and all of it is about
    // the CLI's own argument array, which this step does not touch. What it decides is the one
    // remaining question: can this machine start that program by name at all.
    //
    // On every POSIX machine the answer is yes and nothing happens here. On Windows a CLI
    // installed through npm is a `.cmd` SHIM rather than a program: `CreateProcess` will not run
    // a batch file, Node refuses to spawn one without a shell (CVE-2024-27980), and a shell is
    // what spawn.mjs forbids. The Codex lane was correct in every other part — home created,
    // seeded, authenticated, sandbox on the command line, the CLI accepting every argument —
    // and could not start one task, answering `spawn codex ENOENT`; the Claude lane worked
    // throughout for one accidental reason, that it ships as a real `.exe`. So the shim is
    // translated into the argument vector it would itself have built: node, and the script it
    // names. No shell is involved, and the CLI receives exactly the arguments assembled above.
    const started = resolveWorkerBin({ name: bin, env, fsImpl, execPath: nodePath })
    if (started.prefixArgs.length > 0) {
      bin = started.bin
      args = [...started.prefixArgs, ...args]
    }

    // `accountName` rides out because the SUBSCRIPTION, not the worker, is what a rate-limit
    // reading on the coming stream describes — and the caller reading that stream would
    // otherwise have to resolve the worker's account a second time, from config it does not hold.
    const accountName = String((worker.account && worker.account.name) || worker.id)

    return { bin, args, env: spawnEnv, prompt, workerId: worker.id, provider, accountName }
  }
}
