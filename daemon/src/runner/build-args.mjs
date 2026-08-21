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
 *   - a task carrying a stage envelope this daemon has no command for (see stagePromptOf).
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
  buildClaudeArgs,
  buildCodexArgs,
  buildAccountEnv,
  buildTaskPrompt,
  assertProfileParity,
  expectedModelEffort,
} from './args.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { pipelineMaxTurns } from '../config.mjs'
import { stageCommand } from '../policy/phase-cycle.mjs'

/** The route named no worker this spawn could run as. */
export class NoWorkerForRouteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoWorkerForRouteError'
  }
}

/** The task carries a stage envelope this daemon has no command for. */
export class UnknownStageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownStageError'
  }
}

/** The default binaries. Which one runs is the route's provider; WHERE it lives is PATH's job. */
export const CLAUDE_BIN = 'claude'
export const CODEX_BIN = 'codex'

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
 * createBuildArgs({config, env, fsImpl}) → the `buildArgs(task, route, options)` the tick wants.
 *
 * `fsImpl` exists so the settings read above can be exercised without a real home directory:
 * the suite injects a reader, production passes nothing and gets `node:fs`.
 *
 * @param {{config?:object, env?:object, fsImpl?:object}} [deps]
 * @returns {(task:object, route:object, options?:object) => {bin:string, args:string[], env:object, prompt:string, workerId:string, provider:string}}
 */
export function createBuildArgs({ config = {}, env = process.env, fsImpl } = {}) {
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
    const provider = String(route.provider ?? worker.provider ?? 'claude')
    const isCodex = provider === 'codex'

    // ── (3) MODEL AND EFFORT ────────────────────────────────────────────────────
    // Taken from the SAME function the parity guard measures against, so the assertion below
    // can never be satisfied by accident: whatever precedence expectedModelEffort declares is
    // the precedence the spawn gets. null means «the CLI's own default» and emits no flag —
    // naming a model nobody asked for would itself be the substitution the guard exists to catch.
    const { model, effort } = expectedModelEffort({ worker, task })

    // ── (4) THE ARGUMENT ARRAY ──────────────────────────────────────────────────
    const argOpts = {}
    if (model !== null) argOpts.model = model
    if (effort !== null) argOpts.effort = effort

    let bin
    let args
    if (isCodex) {
      bin = CODEX_BIN
      args = buildCodexArgs(argOpts)
    } else {
      bin = CLAUDE_BIN
      // The live attempt log is the reason for this flag: without it a session that delegates
      // to subagents goes silent for minutes and the screen has a spinner and nothing else.
      // The envelope's tool grant travels WITH the spawn. Policy that is computed and never
      // reaches the process is not policy but bookkeeping — and for this fleet's whole life
      // it left every worker read-only: the child refused Edit on sight, the attempt died as
      // «no receipt», and no screen could name the cause (12.08.2026).
      args = buildClaudeArgs({
        ...argOpts,
        // HOW FAR THIS ATTEMPT MAY WALK, carried to the process rather than kept as a setting.
        //
        // A headless worker has nobody to stop it: handed work it cannot finish, it re-reads,
        // re-tries and re-reasons until the money runs out, and every one of those turns is a
        // subscription minute burnt in a circle at three in the morning. The ceiling is the one
        // number that turns that into a stop — and a stop only exists if the number is HERE, in
        // the argument array of the spawn, rather than in a field somebody means to read later.
        //
        // It comes from config, and this line is the last stretch of road between the person who
        // set it and the process that has to obey it. The resolver refuses anything that is not
        // a whole positive number, so a malformed file cannot put junk on a command line.
        maxTurns: pipelineMaxTurns(config),
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
        ...(Array.isArray(options.allowedTools) && options.allowedTools.length > 0
          ? { allowedTools: options.allowedTools }
          : {}),
        // AND THE REFUSAL TRAVELS BESIDE THE GRANT. The envelope's human-only actions —
        // the ones a person keeps for himself — arrive here already translated into tool
        // patterns, and this line is the last stretch of road between that decision and the
        // process that has to obey it. An empty list changes the argument array by not one
        // byte, so every spawn that names no refusal is assembled exactly as before.
        ...(Array.isArray(options.disallowedTools) && options.disallowedTools.length > 0
          ? { disallowedTools: options.disallowedTools }
          : {}),
      })
    }

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
    })

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

    // `accountName` rides out because the SUBSCRIPTION, not the worker, is what a rate-limit
    // reading on the coming stream describes — and the caller reading that stream would
    // otherwise have to resolve the worker's account a second time, from config it does not hold.
    const accountName = String((worker.account && worker.account.name) || worker.id)

    return { bin, args, env: spawnEnv, prompt, workerId: worker.id, provider, accountName }
  }
}
