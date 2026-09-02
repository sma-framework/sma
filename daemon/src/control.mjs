/**
 * control.mjs — STOPPING AND RESTARTING THE DAEMON, as an operation instead of a ritual.
 *
 * WHAT IT IS. The supervisor owns the LIFT (supervisor/start-daemon-windows.ps1 on Windows,
 * the launchd plist on the Mac mini — both ending at daemon/src/main.mjs). Nothing owned the
 * other two halves: updating the code or the config of a LIVE daemon meant finding the
 * process by eye, killing it by hand, and running the start script again. This module is the
 * missing half, and `supervisor/daemon-control.mjs` is the command that drives it.
 *
 * ═════════════ HOW THE PROCESS IS FOUND — AND WHY NEVER BY NAME ══════════════════
 * `node` is the most common process on a developer's machine. A stop that hunts the process
 * table for a binary name would, sooner or later, kill somebody's editor server, a test run,
 * or another product entirely — and it would do it silently, because a name match carries no
 * evidence that the thing it matched is OURS. So there is no name matching here: no walk of
 * the process table, no port-to-owner lookup, no shelling out to the platform's process
 * tools. Two facts identify our daemon, and both must agree:
 *
 *   1. THE RECORD. On the boot in which it binds the door, the daemon writes
 *      `daemon.pid` beside its own data — `{pid, bind, port, startedAt}`. It states the
 *      DOOR IT BOUND, not just a number, so the record can be checked against the config
 *      the operator is stopping FOR.
 *   2. THE DOOR. The address in the config (`bind`/`port`) is asked whether anything is
 *      answering there, over the daemon's own front — GET /api/state behind the token. No
 *      new route is added: the stop asks the SAME door the window asks.
 *
 * A record whose door disagrees with the config is a record about SOMEBODY ELSE'S daemon and
 * is never signalled. A door that answers with no record behind it is refused OUT LOUD
 * («I can see a daemon, I cannot prove which process it is») rather than resolved by a
 * guess — an honest refusal costs one restart; a wrong kill costs whatever the other process
 * was doing.
 *
 * ═════════════ AN ABSENCE IS A CALM SUCCESS ══════════════════════════════════════
 * «Stop» asks for a state, not for an event. A machine where nothing is running is already
 * in that state, so `not-running` exits 0 and says so in one line. A stale record left by a
 * process that died is swept on the way past. This matters because the command is used in
 * scripts and by a person who does not yet know whether the daemon is up — an error there
 * would teach both to ignore the exit code.
 *
 * ═════════════ A LIVE ATTEMPT IS WORK, AND IT IS NOT DROPPED SILENTLY ════════════
 * Killing the daemon kills the workers it holds: an attempt in flight loses its turn, its
 * tokens and its unwritten receipt. So the stop LOOKS first — the state behind the door
 * names every worker holding a task — and refuses with the list when it finds one, until the
 * operator says `--force` in as many words. Where the door answers but will not talk (401,
 * or a body that is not the state), the refusal is impossible to make honestly, so the
 * command says that it could not ask instead of pretending the machine was idle.
 *
 * ═════════════ RESTART SAYS WHETHER THE DOOR CAME BACK ═══════════════════════════
 * A restart that only spawns a process reports on the spawn, and a daemon that dies in its
 * boot (an unreachable queue is the common one) leaves the operator believing it is up. So
 * restart = stop + the supervisor's OWN lift + waiting on the door, and the last line is
 * whether the door answered and how long it took. Under launchd (KeepAlive) the supervisor
 * relifts the process on its own; the restart notices that and does not spawn a second one.
 *
 * Node built-ins + one atomic-write helper. Every seam — probe, record io, liveness, signal,
 * spawn, sleep, clock — is injected, so the whole decision table is tested with no real
 * process, no real socket and no real file.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, rmSync as fsRmSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteJson } from '../../scripts/sma/lib/fs-atomics.mjs'
import { resolveConfigPath } from './config.mjs'

/** The file the daemon leaves behind on the boot in which it binds its door. */
export const PID_RECORD_FILE = 'daemon.pid'

/** The repository root — this file lives at <root>/daemon/src/control.mjs. */
export const SMA_HOME = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Every outcome either command can reach, as a closed set. A command that can end in an
 * unlisted state is a command whose exit code nobody can rely on.
 *
 *   not-running   nothing was up (or a stale record was swept) — success
 *   stopped       the process ended after the polite signal — success
 *   killed        it took the hard signal — success, and the line says so
 *   live-work     a worker was holding a task and no --force was given — refused
 *   unnamed       the door answers, and no record proves which process owns it — refused
 *   refused       it survived even the hard signal — refused
 *   up            the door answered after our lift — success
 *   up-supervised the supervisor had already lifted it before we did — success
 *   no-door       the lift ran and the door never answered — failure
 */
export const OUTCOMES = Object.freeze([
  'not-running',
  'stopped',
  'killed',
  'live-work',
  'unnamed',
  'refused',
  'up',
  'up-supervised',
  'no-door',
])

/** Which outcomes an operator's script may read as «the machine is where I asked it to be». */
const SUCCESS = new Set(['not-running', 'stopped', 'killed', 'up', 'up-supervised'])

/** exitCodeFor(outcome) — 0 success, 2 «refused, and a flag would change it», 1 everything else. */
export function exitCodeFor(outcome) {
  if (SUCCESS.has(outcome)) return 0
  return outcome === 'live-work' ? 2 : 1
}

// ── the record ────────────────────────────────────────────────────────────────────

/**
 * pidRecordPath(config, io) — where the record lives: beside the daemon's own data when the
 * config has a data directory (it always does after loadConfig), else beside the config
 * file itself. Both resolve under ~/.sma-daemon by default, and both follow
 * SMA_DAEMON_CONFIG when it is set — so a second daemon on one machine keeps its own record.
 */
export function pidRecordPath(config = {}, { env = process.env, homedir = osHomedir } = {}) {
  const dir = config.dataDir || dirname(resolveConfigPath({ env, homedir }))
  return join(dir, PID_RECORD_FILE)
}

/**
 * writePidRecord({config, pid, now}) → the path written. States the door as well as the
 * number: a bare pid cannot be checked against anything, and an unverifiable pid is exactly
 * what this module refuses to act on.
 */
export function writePidRecord({ config = {}, pid = process.pid, now = Date.now, io = {}, writeOpts = {} } = {}) {
  const path = pidRecordPath(config, io)
  atomicWriteJson(
    path,
    {
      pid,
      bind: config.bind ?? '',
      port: config.port ?? 0,
      startedAt: new Date(now()).toISOString(),
    },
    writeOpts,
  )
  return path
}

/**
 * readPidRecord({config}) → the record, or null. A missing, unreadable, torn or shapeless
 * file is an ABSENT record, never a throw: the caller's next move is the same for all four,
 * and a stop that dies on a corrupt file leaves the operator with the ritual it replaces.
 */
export function readPidRecord({ config = {}, io = {}, fsImpl = {} } = {}) {
  const existsSync = fsImpl.existsSync ?? fsExistsSync
  const readFileSync = fsImpl.readFileSync ?? fsReadFileSync
  const path = pidRecordPath(config, io)
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const pid = Number(raw && raw.pid)
    if (!Number.isInteger(pid) || pid <= 0) return null
    return {
      pid,
      bind: typeof raw.bind === 'string' ? raw.bind : '',
      port: Number(raw.port) || 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      path,
    }
  } catch {
    return null
  }
}

/** clearPidRecord({config}) → true when a record was removed. Never throws. */
export function clearPidRecord({ config = {}, io = {}, fsImpl = {} } = {}) {
  const rmSync = fsImpl.rmSync ?? fsRmSync
  try {
    rmSync(pidRecordPath(config, io), { force: true })
    return true
  } catch {
    return false
  }
}

// ── the door ──────────────────────────────────────────────────────────────────────

/**
 * doorUrl(config) — the address to knock on. A daemon bound to a wildcard is REACHED at the
 * loopback: `0.0.0.0` is what it listens on, never an address a client can connect to.
 */
export function doorUrl(config = {}) {
  const bind = String(config.bind || '127.0.0.1')
  const host = bind === '0.0.0.0' || bind === '::' || bind === '' ? '127.0.0.1' : bind
  return `http://${host.includes(':') ? `[${host}]` : host}:${Number(config.port) || 0}`
}

/**
 * probeDoor({config}) → {answered, status, state, reason, kind}.
 *
 * `answered:true` means SOMETHING is serving that address — a 401 counts, because a refusal
 * is still an answer and the question here is «is the door up». `state` is filled only on a
 * 200 with a JSON body, so the live-work check below can tell «nobody is working» from «I was
 * not allowed to look».
 *
 * `path` CHOOSES WHICH DOOR THE QUESTION IS ASKED AT, and that choice is not cosmetic. The
 * default is `/api/state`, because the callers that also need the roster (the stop that
 * refuses to kill live work) can only get it there. But that door is the HEAVIEST thing the
 * product serves: it assembles the whole board. Under six live attempts it has answered in
 * 7.5 seconds, and once in 51. A caller that only wants «is anything alive» must not ask its
 * question at the most expensive door in the house — it will keep mistaking a busy daemon for
 * a dead one. `GET /` is served by the same process out of a built file and stays cheap under
 * any load, which is why the watchdog asks there. Both are EXISTING doors of the frozen
 * table; this module adds none.
 *
 * `kind` NAMES WHAT KIND OF SILENCE IT WAS, because they are not the same fact:
 *   refused — nothing is listening on that port (ECONNREFUSED and its kin). PROOF of death.
 *   timeout — something accepted the connection and did not answer in time. NOT proof: a
 *             daemon busy with six attempts looks exactly like this, and so does a hung one.
 *   other   — anything else.
 * Whoever decides «fallen» is entitled to be more patient with a timeout than with a refusal,
 * and cannot be unless the two arrive under different names.
 */
export async function probeDoor({ config = {}, fetchImpl = globalThis.fetch, timeoutMs = 3000, path = '/api/state' } = {}) {
  const url = `${doorUrl(config)}${path}`
  try {
    const res = await fetchImpl(url, {
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
    let state = null
    if (res.status === 200 && path === '/api/state') {
      try {
        state = await res.json()
      } catch {
        state = null // an answer we cannot read is an answer all the same
      }
    }
    return { answered: true, status: res.status, state, reason: '', kind: '' }
  } catch (err) {
    const code = String((err && err.code) || '')
    const name = String((err && err.name) || '')
    const kind =
      code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND'
        ? 'refused'
        : name === 'TimeoutError' || code === 'ABORT_ERR' || code === '23' || name === 'AbortError'
          ? 'timeout'
          : 'other'
    return {
      answered: false,
      status: 0,
      state: null,
      reason: String((err && err.code) || (err && err.message) || err),
      kind,
    }
  }
}

/**
 * liveWork(state) → [{worker, taskId, title}] — the attempts a kill would destroy.
 *
 * Read from the roster, which is the ONE list in the payload that names the task a worker is
 * holding (state.mjs: a claimed row's id/title ride on the worker, never on the queue lists).
 */
export function liveWork(state) {
  const workers = state && Array.isArray(state.workers) ? state.workers : []
  return workers
    .filter((w) => w && w.taskId)
    .map((w) => ({ worker: String(w.id ?? '?'), taskId: String(w.taskId), title: w.taskTitle ?? null }))
}

/**
 * identifyProcess({config, record, door, isAlive}) → {pid} | {refusal}
 *
 * The whole of «is this process mine». Every branch names what it saw, because the refusals
 * are what an operator has to act on:
 *   - no record at all → refuse (a door with no owner we can prove)
 *   - a record naming another door → refuse (a second daemon's record; never signalled)
 *   - a record whose pid is gone → no process (the caller sweeps it)
 */
export function identifyProcess({ config = {}, record = null, isAlive = () => false } = {}) {
  if (!record) return { pid: null, refusal: 'no-record' }
  const wantPort = Number(config.port) || 0
  const wantBind = String(config.bind ?? '')
  if (record.port !== wantPort || (record.bind !== '' && wantBind !== '' && record.bind !== wantBind)) {
    return { pid: null, refusal: 'other-door' }
  }
  if (!isAlive(record.pid)) return { pid: null, refusal: 'gone' }
  return { pid: record.pid, refusal: '' }
}

/** processAlive(pid) — signal 0 asks the OS about existence without touching the process. */
export function processAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists and belongs to somebody else. That is still ALIVE — and the signal
    // below will fail honestly rather than this function lying that nothing is there.
    return !!(err && err.code === 'EPERM')
  }
}

// ── the commands ──────────────────────────────────────────────────────────────────

/** A result every caller reads the same way: what happened, what to print, what to exit with. */
function result(outcome, lines) {
  return { outcome, lines, code: exitCodeFor(outcome) }
}

/**
 * stopDaemon(deps) → {outcome, lines, code}
 *
 * The order is the point: look at the door, name the process, ask about live work, and only
 * then signal. Each step can end the command on its own, and each ending says why.
 */
export async function stopDaemon({
  config = {},
  force = false,
  probe = (cfg) => probeDoor({ config: cfg }),
  readRecord = (cfg) => readPidRecord({ config: cfg }),
  clearRecord = (cfg) => clearPidRecord({ config: cfg }),
  isAlive = (pid) => processAlive(pid),
  signal = (pid, sig) => process.kill(pid, sig),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  graceMs = 15000,
  killWaitMs = 5000,
  pollMs = 250,
} = {}) {
  const where = doorUrl(config)
  const door = await probe(config)
  const record = readRecord(config)
  const lines = []

  // ── nothing is up: the calm success ──
  if (!door.answered && !(record && isAlive(record.pid))) {
    if (record) {
      clearRecord(config)
      lines.push(`демон уже не работает: дверь ${where} молчит, а запись о процессе ${record.pid} осталась от мёртвого — убрал её.`)
    } else {
      lines.push(`демон уже не работает: дверь ${where} молчит, записи о процессе нет. Останавливать нечего.`)
    }
    return result('not-running', lines)
  }

  // ── whose process is this ──
  const id = identifyProcess({ config, record, isAlive })
  if (id.refusal === 'no-record') {
    return result('unnamed', [
      `на ${where} кто-то отвечает, но записи о процессе (${pidRecordPath(config)}) нет — назвать свой процесс нечем.`,
      'По имени двоичного файла искать не буду: на машине бывает чужой node, и промах здесь стоит чужой работы.',
      'Что делать: поднимите демона штатным подъёмом супервизора — он оставит запись, и остановка станет обычной командой.',
    ])
  }
  if (id.refusal === 'other-door') {
    return result('unnamed', [
      `запись о процессе ${record.pid} говорит про дверь ${record.bind || '?'}:${record.port || '?'}, а остановить просили ${where}.`,
      'Это запись ЧУЖОГО демона — трогать его процесс я не стану.',
    ])
  }
  if (id.refusal === 'gone') {
    // The door answers, the recorded pid does not exist: somebody else holds that address.
    clearRecord(config)
    return result('unnamed', [
      `на ${where} кто-то отвечает, но записанный процесс ${record.pid} уже мёртв — значит дверь держит не он.`,
      'Убрал устаревшую запись. Чей это процесс — я честно не знаю и убивать наугад не буду.',
    ])
  }

  // ── is somebody working right now ──
  if (door.answered && door.state) {
    const busy = liveWork(door.state)
    if (busy.length > 0 && !force) {
      return result('live-work', [
        `сейчас идёт работа — ${busy.length} ${busy.length === 1 ? 'живая попытка' : 'живых попыток'}:`,
        ...busy.map((b) => `  ${b.worker}: ${b.taskId}${b.title ? ` — ${b.title}` : ''}`),
        'Гашение убьёт эту работу: попытка потеряет ход, потраченные токи и ненаписанную квитанцию.',
        'Если это осознанное решение — повторите с флагом --force.',
      ])
    }
    if (busy.length > 0) lines.push(`--force: гашу вместе с живой работой (${busy.map((b) => b.taskId).join(', ')}).`)
  } else if (door.answered) {
    lines.push(`дверь ${where} ответила ${door.status}, но состояние не отдала — о живой работе спросить некого, гашу вслепую.`)
  } else {
    lines.push(`дверь ${where} молчит, а процесс ${id.pid} жив — гашу его; о живой работе спросить некого.`)
  }

  // ── the signal, and the wait ──
  //
  // SIGTERM first. On Windows node maps every signal onto TerminateProcess, so the wait
  // below is short there by nature — that is a fact about the platform, not a promise
  // broken: the command still reports what actually ended the process.
  const started = now()
  try {
    signal(id.pid, 'SIGTERM')
  } catch (err) {
    if (err && err.code === 'ESRCH') {
      clearRecord(config)
      return result('not-running', [...lines, `процесс ${id.pid} закончился сам, пока я к нему шёл.`])
    }
    return result('refused', [...lines, `не смог послать сигнал процессу ${id.pid}: ${String((err && err.message) || err)}`])
  }

  const gone = await waitGone({ pid: id.pid, isAlive, sleep, now, deadlineMs: graceMs, pollMs })
  if (gone) {
    clearRecord(config)
    return result('stopped', [...lines, `остановлен: процесс ${id.pid} завершился за ${secs(now() - started)} после SIGTERM.`])
  }

  lines.push(`процесс ${id.pid} не закончился за ${secs(graceMs)} — перехожу на SIGKILL.`)
  try {
    signal(id.pid, 'SIGKILL')
  } catch (err) {
    if (!(err && err.code === 'ESRCH')) {
      return result('refused', [...lines, `не смог добить процесс ${id.pid}: ${String((err && err.message) || err)}`])
    }
  }
  const dead = await waitGone({ pid: id.pid, isAlive, sleep, now, deadlineMs: killWaitMs, pollMs })
  if (!dead) {
    return result('refused', [...lines, `процесс ${id.pid} жив и после SIGKILL — запись оставляю, разбираться нужно руками.`])
  }
  clearRecord(config)
  return result('killed', [...lines, `остановлен жёстко: процесс ${id.pid} умер по SIGKILL за ${secs(now() - started)}.`])
}

/** waitGone — poll liveness until the process is gone or the deadline passes. */
async function waitGone({ pid, isAlive, sleep, now, deadlineMs, pollMs }) {
  const until = now() + deadlineMs
  for (;;) {
    if (!isAlive(pid)) return true
    if (now() >= until) return false
    await sleep(pollMs)
  }
}

/** secs(ms) — «1.4с», the only formatting this module does. */
function secs(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}с`
}

/**
 * liftCommand({platform, smaHome}) — THE SUPERVISOR'S OWN LIFT, not a second way to start.
 *
 * On Windows that is `supervisor/start-daemon-windows.ps1`: the script the Scheduled Task
 * targets, which brings up the queue Postgres, ensures the queue database and only then runs
 * the composition root. Everywhere else it is `node daemon/src/main.mjs` — the exact
 * ProgramArguments of the launchd agent (com.sma.daemon.plist).
 *
 * ═════════ WHO DETACHES, AND WHY WINDOWS ANSWERS THAT DIFFERENTLY ════════════════
 * `detached` travels WITH the command because it is a property of the thing being started,
 * not a habit of whoever starts it. Detachment is what lets the caller report and exit while
 * the daemon lives on, and for a node composition root the flag does exactly that.
 *
 * For PowerShell it does the opposite, and the failure is silent. On Windows libuv turns
 * `detached` into DETACHED_PROCESS — the kernel is told the child must have NO console — and
 * Windows PowerShell 5.1 cannot start without one. Measured on this machine 02.09.2026, three
 * lifts in a row: the process was created, exited 0 in milliseconds, ran not one line of the
 * script, and wrote nothing to stdout, stderr or its own log. `daemon-lift-<day>.log` held the
 * «lifting» line and then silence; the door never opened. The identical spawn WITHOUT the flag
 * runs the script and captures every line.
 *
 * So on Windows the lift is one hop longer and NOT detached: a short-lived launcher
 * (`supervisor/lift-daemon-windows.ps1`) that starts the real wrapper hidden, with its streams
 * redirected to files, reports its pid and echoes the first lines of the boot back into the
 * lift log. The daemon's independence comes from that hidden start, and Windows does not kill
 * a child when its parent exits — so the daemon outlives the launcher exactly as it used to
 * outlive the caller.
 */
export function liftCommand({ platform = process.platform, smaHome = SMA_HOME, nodeBin = process.execPath } = {}) {
  if (platform === 'win32') {
    const launcher = join(smaHome, 'supervisor', 'lift-daemon-windows.ps1')
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-SmaHome', smaHome],
      cwd: smaHome,
      detached: false,
    }
  }
  return { cmd: nodeBin, args: [join(smaHome, 'daemon', 'src', 'main.mjs')], cwd: smaHome, detached: true }
}

/**
 * restartDaemon(deps) → {outcome, lines, code}
 *
 * Stop, then the supervisor's lift, then WAIT ON THE DOOR. A restart that reports on the
 * spawn reports on nothing: the boot failure this command exists to recover from (a queue
 * that is not there yet) happens after the process starts and before the door opens.
 */
export async function restartDaemon({
  config = {},
  force = false,
  stop = stopDaemon,
  probe = (cfg) => probeDoor({ config: cfg }),
  spawnLift,
  lift = liftCommand(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  doorTimeoutMs = 120000,
  pollMs = 1000,
  ...stopDeps
} = {}) {
  const stopped = await stop({ config, force, probe, sleep, now, ...stopDeps })
  if (stopped.code !== 0) return { ...stopped, lines: [...stopped.lines, 'подъём не делаю: сначала остановка.'] }

  const lines = [...stopped.lines]
  const where = doorUrl(config)

  // The supervisor may have relifted it already — launchd's KeepAlive does exactly that, and
  // a second process would only lose a race for the port and die confusingly.
  const early = await probe(config)
  if (early.answered) {
    return result('up-supervised', [...lines, `дверь ${where} уже отвечает — супервизор поднял демона сам, второй запуск не нужен.`])
  }

  lines.push(`поднимаю тем же путём, что и супервизор: ${lift.cmd} ${lift.args.join(' ')}`)
  try {
    spawnLift(lift)
  } catch (err) {
    return result('no-door', [...lines, `подъём не запустился: ${String((err && err.message) || err)}`])
  }

  const started = now()
  const until = started + doorTimeoutMs
  for (;;) {
    const knock = await probe(config)
    if (knock.answered) {
      return result('up', [...lines, `дверь ${where} ответила ${knock.status} через ${secs(now() - started)} — демон поднялся.`])
    }
    if (now() >= until) {
      return result('no-door', [
        ...lines,
        `дверь ${where} не ответила за ${secs(doorTimeoutMs)} (последняя причина: ${knock.reason || 'нет ответа'}).`,
        'Процесс запущен, но окно не открылось — смотрите лог демона: ~/.sma-daemon/logs.',
      ])
    }
    await sleep(pollMs)
  }
}
