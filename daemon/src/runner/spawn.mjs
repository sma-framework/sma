/**
 * spawn.mjs — the shell-disabled worker child (Phase 9.5 Plan 04, Task 2;
 * D-9.5-03/04a, T-9.5-10).
 *
 * WHAT IT IS: the single function that turns an arg array (from args.mjs) + a per-account
 * env (from args.mjs) + a task prompt into a running CLI child, and line-buffers its
 * NDJSON stdout back to the caller. It NEVER builds an arg array itself and NEVER routes
 * task content through a shell.
 *
 * SAFE-CHILD CONTRACT (copied verbatim from excavate.mjs lines 15–23, the substrate's
 * canonical posture):
 *   - The child is spawned with an ARGUMENT ARRAY and the shell DISABLED ({ shell: false })
 *     — a hostile task prompt / title / note can never reach a shell.
 *   - Task content is DATA end to end: it enters the child ONLY via stdin (the '-' arg in
 *     the builder), is NEVER interpolated into a command string, eval'd, or executed here.
 *   - No http/https/net import; no LLM call. Deterministic plumbing only.
 *
 * TERMINAL PARITY STARTS HERE (chain step 1, args.mjs header): the cwd this function is
 * given IS the worker's environment. A worktree cwd carries `.claude/**` and CLAUDE.md
 * physically, so the CLI itself picks up the checkout's hooks, memory and skills — no wiring,
 * no forwarding, no emulation. An ABSENT cwd is therefore not a harmless default: node's
 * spawn would fall back to the DAEMON's own process directory, and the session would run
 * against a different checkout (or none) with every guard silently disarmed, while the run
 * still looked green. So cwd is REQUIRED and a missing one throws a named error — the parity
 * hole is closed at the only place that can close it.
 *
 * DEPENDENCY INJECTION (excavate.mjs posture — «the runner is DI so tests never touch a
 * real repo»): `spawnImpl` is injectable, so the whole suite drives a recording fake and
 * no test ever spawns a real CLI or spends a token. The default is node:child_process
 * spawn, used only in production.
 *
 * Node built-ins only; zero deps; zero network.
 */

import { spawn as defaultSpawn } from 'node:child_process'

/** Named error for a spawn with no working directory — the terminal-parity hole (see header). */
export class MissingWorkerCwdError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MissingWorkerCwdError'
  }
}

/**
 * spawnWorker(opts) → { pid, kill }. Spawns `bin` with `args` under `cwd`/`env`, shell
 * DISABLED; writes `prompt` to stdin and ends it; line-buffers stdout and calls
 * `onLine(line)` per COMPLETE line (a trailing partial is flushed on exit); calls
 * `onExit({code, signal})` when the child exits.
 *
 * The prompt is the ONLY channel for task content — it is written to stdin, never added
 * to `args`. Callers pass the arg array from args.mjs unchanged.
 *
 * @param {{
 *   bin:string, args:string[], cwd:string, env:object, prompt?:string,
 *   spawnImpl?:Function, onLine?:(line:string)=>void, onExit?:(e:{code:number|null,signal:string|null})=>void
 * }} opts
 * @returns {{pid:number|undefined, kill:()=>void}}
 */
export function spawnWorker({ bin, args, cwd, env, prompt, spawnImpl = defaultSpawn, onLine, onExit } = {}) {
  // TERMINAL PARITY (header): no cwd would mean the daemon's own directory, i.e. a session
  // outside the task's checkout — every hook, note and skill silently different. Refuse.
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new MissingWorkerCwdError(
      'spawnWorker: cwd is required — a worker session must stand in its task worktree (terminal parity)',
    )
  }
  const child = spawnImpl(bin, args, { shell: false, cwd, env })

  // Task content crosses into the child ONLY here, as stdin data — never a shell arg.
  if (child.stdin) {
    if (prompt !== undefined && prompt !== null) child.stdin.write(String(prompt))
    child.stdin.end()
  }

  let buf = ''
  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', (chunk) => {
      buf += String(chunk)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (onLine) onLine(line)
      }
    })
  }

  if (typeof child.on === 'function') {
    child.on('exit', (code, signal) => {
      if (buf.length && onLine) {
        onLine(buf) // flush a trailing partial line (no terminating newline)
        buf = ''
      }
      if (onExit) onExit({ code: code ?? null, signal: signal ?? null })
    })
  }

  return {
    pid: child.pid,
    kill: () => {
      if (typeof child.kill === 'function') child.kill()
    },
  }
}
