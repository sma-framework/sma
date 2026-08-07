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
 *   - a model/effort that does not match the profile — that guard is imported, not rewritten.
 * Each throw is caught by the tick's own catch and becomes a NAMED task failure, which is the
 * behaviour the rest of the loop is built around: a refusal on the record beats a crash.
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

/** The route named no worker this spawn could run as. */
export class NoWorkerForRouteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoWorkerForRouteError'
  }
}

/** The default binaries. Which one runs is the route's provider; WHERE it lives is PATH's job. */
export const CLAUDE_BIN = 'claude'
export const CODEX_BIN = 'codex'

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
      provider,
      env,
      useApiFallback: route.useApiFallback === true,
      taskId: task.id,
    })

    // ── (6) THE PROMPT — task content as fenced DATA, never as instructions ──────
    const prompt = buildTaskPrompt({ task })

    return { bin, args, env: spawnEnv, prompt, workerId: worker.id, provider }
  }
}
