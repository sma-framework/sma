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
 *   - MCP servers. `buildMcpConfigFile` exists in args.mjs and is called by NOTHING in the
 *     daemon — a per-spawn MCP config needs a per-task directory, and this product has no
 *     convention for one yet. Inventing a directory here would be a worse answer than an
 *     absent flag, so a session starts without MCP servers until that convention is chosen.
 *   - Session resume. `resumeId` / `resumeThreadId` are supported by the argument builders;
 *     wiring them needs the session id recovered from the previous attempt's stream, which is
 *     a second concern with its own failure modes.
 */

import {
  buildClaudeArgs,
  buildCodexArgs,
  buildAccountEnv,
  buildTaskPrompt,
  assertProfileParity,
  expectedModelEffort,
} from './args.mjs'
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
 * createBuildArgs({config, env}) → the `buildArgs(task, route, options)` the tick wants.
 *
 * @param {{config?:object, env?:object}} [deps]
 * @returns {(task:object, route:object, options?:object) => {bin:string, args:string[], env:object, prompt:string, workerId:string, provider:string}}
 */
export function createBuildArgs({ config = {}, env = process.env } = {}) {
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
      args = buildClaudeArgs({ ...argOpts, forwardSubagentText: options.forwardSubagentText === true })
    }

    // THE GUARD THAT SCREAMS — imported, never re-implemented here. It throws
    // ProfileParityError naming the field that diverged.
    assertProfileParity({ args, worker, task })

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
    const prompt = stagePromptOf(task) ?? buildTaskPrompt({ task })

    return { bin, args, env: spawnEnv, prompt, workerId: worker.id, provider }
  }
}
