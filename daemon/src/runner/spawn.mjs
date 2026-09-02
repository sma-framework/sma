/**
 * spawn.mjs — the shell-disabled worker child.
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
 * given IS the worker's environment. The copy carries `.claude/**` and CLAUDE.md because the
 * provisioning verb PUT THEM THERE — it copies the untracked layer named by the project's
 * manifest, and links dependencies rather than installing them; a bare worktree only brings
 * what git tracks, which in a project that keeps its rules out of git is nothing at all. With
 * the copy so provisioned the CLI itself picks up the checkout's hooks, memory and skills —
 * no wiring, no forwarding, no emulation. An ABSENT cwd is therefore not a harmless default: node's
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

import { spawn as defaultSpawn, execFile as defaultExecFile } from 'node:child_process'

/** Named error for a spawn with no working directory — the terminal-parity hole (see header). */
export class MissingWorkerCwdError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MissingWorkerCwdError'
  }
}

/**
 * killProcessTree({pid, platform, execFileImpl}) → был ли отдан приказ ДЕРЕВУ, а не одному pid.
 *
 * ЧТО СЛУЧИЛОСЬ, И ПОЧЕМУ ОДНОГО pid МАЛО. Отменённая попытка гасила ровно тот процесс, который
 * запустила, — а он у себя не один. Полоса codex перед первой строкой поднимает ПОМОЩНИКА
 * песочницы, который раздаёт право записи по каждому писаемому корню; помощник — отдельный
 * процесс, и родителя он не переживать не обязан. Замерено 02.09.2026: попытку сняли в 14:36,
 * а помощник жил дальше с МЁРТВЫМ родителем и молотил права ещё 193 секунды процессорного
 * времени — «умерла для учёта, жива для денег»: в очереди строка закрыта, на машине работа
 * продолжается, и никто на неё уже не смотрит.
 *
 * ПОРЯДОК ЗДЕСЬ — ЧАСТЬ ЛЕКАРСТВА, А НЕ СТИЛЬ. Дерево обходится ПО ЗАПИСЯМ О РОДИТЕЛЕ, и эти
 * записи живут ровно пока родитель жив: убей его первым — и помощник останется сиротой,
 * которого уже не с чего найти. Поэтому приказ дереву отдаётся ДО того, как кто-нибудь трогает
 * самого ребёнка (см. `kill` ниже), и только неотданный приказ откатывается на одиночное
 * `child.kill()`.
 *
 * WINDOWS — `taskkill /t /f`: единственный способ сказать «этот и всё, что он породил» на
 * системе без групп процессов. Приказ отдаётся АСИНХРОННО, потому что синхронный вызов на
 * несколько секунд остановил бы весь демон ради одной отмены.
 *
 * НА ОСТАЛЬНЫХ СИСТЕМАХ — ЧЕСТНО «НЕТ». Дерево там снимается группой процессов, а группы у
 * этого ребёнка нет: он запускается обычным `spawn`, и заводить ему группу значило бы менять
 * то, как демон живёт с сигналами, — решение шире этой починки. Функция возвращает `false`,
 * вызывающий гасит одиночный процесс ровно как раньше, и ни одна система не получает обещания,
 * которого здесь не исполняют. Продукт живёт на Windows, и лечится измеренная болезнь.
 *
 * @param {{pid?:number, platform?:string, execFileImpl?:Function}} args
 * @returns {boolean}
 */
export function killProcessTree({ pid, platform = process.platform, execFileImpl = defaultExecFile } = {}) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  if (String(platform) !== 'win32') return false
  try {
    execFileImpl('taskkill', ['/pid', String(pid), '/t', '/f'], () => {
      /* приказ отдан; чей-то отказ здесь не делает отмену несостоявшейся */
    })
    return true
  } catch {
    return false
  }
}

/**
 * spawnWorker(opts) → { pid, kill, alive }. Spawns `bin` with `args` under `cwd`/`env`, shell
 * DISABLED; writes `prompt` to stdin and ends it; line-buffers stdout and calls
 * `onLine(line)` per COMPLETE line (a trailing partial is flushed on exit); calls
 * `onExit({code, signal})` when the child exits.
 *
 * The prompt is the ONLY channel for task content — it is written to stdin, never added
 * to `args`. Callers pass the arg array from args.mjs unchanged.
 *
 * `alive()` ANSWERS «IS THE PROCESS STILL THERE», AND IT IS THE ONLY HONEST ANSWER AVAILABLE
 * HERE. Until it existed, the one signal anybody had about a running attempt was its OUTPUT:
 * the lease was renewed from the stream, so a worker thinking silently for longer than one
 * lease period was indistinguishable from a wedged process — and the watchdog buried it while
 * it worked. This is not a heuristic and not a timer: the child's death is reported by the OS
 * as the 'exit' event (and a child that never started as 'error'), so `alive` is a FACT the
 * handle observed, not a guess about it. A handle without a pid was never a process.
 *
 * `kill()` ENDS THE TREE, NOT THE ONE pid IT SPAWNED — see killProcessTree above: a cancelled
 * Codex attempt left the sandbox's own helper running with a dead parent, burning CPU on ACLs
 * for another three minutes after the row was closed. `killTreeImpl` and `platform` are
 * injected for the same reason `spawnImpl` is: the suite proves the order without a real
 * process tree.
 *
 * @param {{
 *   bin:string, args:string[], cwd:string, env:object, prompt?:string,
 *   spawnImpl?:Function, killTreeImpl?:Function, platform?:string,
 *   onLine?:(line:string)=>void, onExit?:(e:{code:number|null,signal:string|null})=>void,
 *   onError?:(err:Error)=>void
 * }} opts
 * @returns {{pid:number|undefined, kill:()=>void, alive:()=>boolean}}
 */
export function spawnWorker({
  bin,
  args,
  cwd,
  env,
  prompt,
  spawnImpl = defaultSpawn,
  killTreeImpl = killProcessTree,
  platform = process.platform,
  onLine,
  onExit,
  onError,
} = {}) {
  // TERMINAL PARITY (header): no cwd would mean the daemon's own directory, i.e. a session
  // outside the task's checkout — every hook, note and skill silently different. Refuse.
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new MissingWorkerCwdError(
      'spawnWorker: cwd is required — a worker session must stand in its task worktree (terminal parity)',
    )
  }
  const child = spawnImpl(bin, args, { shell: false, cwd, env })

  // A FAILED SPAWN IS AN EVENT, NOT A THROW — and this listener is what keeps it from being
  // fatal. Node reports «the program could not be started» (ENOENT, EACCES) by EMITTING
  // 'error' on the child, asynchronously. An 'error' event with no listener is re-thrown by
  // EventEmitter as an uncaught exception, so the caller's try/catch — which has already
  // returned — cannot see it and THE WHOLE DAEMON DIES. Measured exactly that way: one task
  // whose binary was not on the child's PATH took the entire fleet down with
  // `Error: spawn claude ENOENT`, while the loop's own spawnError branch, written for this
  // very case, was never reached.
  //
  // Attached BEFORE the stdin write below, because that write is the first thing that can
  // fail on a child which never started.
  let failed = false
  // ЖИВ ИЛИ НЕТ — ОДИН ФЛАГ, ПОДНЯТЫЙ СОБЫТИЕМ ОС, а не вычисляемый по времени или по выводу.
  // Он поднимается в обоих концах жизни ребёнка: 'error' — процесс не родился, 'exit' — умер.
  let exited = false
  if (typeof child.on === 'function') {
    child.on('error', (err) => {
      failed = true
      exited = true
      if (onError) onError(err)
    })
  }

  // Task content crosses into the child ONLY here, as stdin data — never a shell arg.
  if (child.stdin) {
    try {
      if (prompt !== undefined && prompt !== null) child.stdin.write(String(prompt))
      child.stdin.end()
    } catch (err) {
      // A child that never started has no pipe to write into. The 'error' event above is the
      // report; this catch only stops the write from becoming a second, louder failure.
      if (!failed && onError) onError(err)
    }
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
      // ПЕРВОЙ СТРОКОЙ, до всякого повествования: чей-то обработчик может бросить, а факт
      // смерти ребёнка от этого фактом быть не перестанет.
      exited = true
      if (buf.length && onLine) {
        onLine(buf) // flush a trailing partial line (no terminating newline)
        buf = ''
      }
      if (onExit) onExit({ code: code ?? null, signal: signal ?? null })
    })
  }

  return {
    pid: child.pid,
    /**
     * ГАСИТСЯ ДЕРЕВО, А НЕ ОДИН pid — и в этом порядке.
     *
     * Приказ дереву отдаётся ПЕРВЫМ, пока родитель жив: обход идёт по записям о родителе, и
     * убитый родитель оставляет помощника сиротой, которого уже не с чего найти (см.
     * killProcessTree — 193 секунды такой сироты замерены живьём). Приказ не отдан — гасим
     * ребёнка ровно как раньше, чтобы отмена не перестала работать там, где дерева не снять.
     *
     * НО СНАЧАЛА — ЖИВ ЛИ ТОТ, КОГО ГАСЯТ. Это не оптимизация, а разница между пустой операцией
     * и приказом по ЧУЖОМУ процессу. `child.kill()` на мёртвом ребёнке не делает ничего: node
     * знает, что этого процесса больше нет, и сигнала никуда не отправляет. Приказ ДЕРЕВУ такой
     * защиты не имеет вовсе — он уходит наружу голым числом, а номера процессов система
     * переиспользует, и «этот и всё, что он породил» по переиспользованному номеру снимет
     * дерево того, кто занял номер после нас. Окно для этого не теоретическое: между выходом
     * ребёнка и закрытием попытки лежат ворота, квитанция и переповерка — секунды, и ровно в них
     * стоит обход живости, гасящий строки, которые сам же признал мёртвыми. Ручка, у которой
     * ОС уже забрала ребёнка, гасить не должна никого.
     */
    kill: () => {
      if (exited) return
      const treeOrdered = killTreeImpl({ pid: child.pid, platform })
      if (!treeOrdered && typeof child.kill === 'function') child.kill()
    },
    /** Жив ли ребёнок ПРЯМО СЕЙЧАС: есть pid и ОС ещё не сообщила о его конце. */
    alive: () => !exited && child.pid !== undefined && child.pid !== null,
  }
}
