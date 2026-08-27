#!/usr/bin/env node
/**
 * daemon-control.mjs — THE STOP AND THE RESTART, beside the lift that was already here.
 *
 * The supervisor folder owned only half an operation: `start-daemon-windows.ps1` (and the
 * launchd plist beside it) bring the daemon UP, and taking it down again — the thing you do
 * every time you change its code or its config — was «find the process, kill it, run the
 * start script». This command is the other half, and it is deliberately a COMMAND and not a
 * door: nothing new listens, and the frozen route table is untouched.
 *
 *   node supervisor/daemon-control.mjs stop [--force]
 *   node supervisor/daemon-control.mjs restart [--force]
 *
 * From the project root the same two are npm scripts: `npm run daemon:stop`,
 * `npm run daemon:restart`.
 *
 * WHAT IT WILL NOT DO: it never looks for a process by the name of its binary. It reads the
 * daemon's own record (`daemon.pid`, written on the boot that bound the door) and checks it
 * against the door address in the config; a record it cannot check is a refusal, not a
 * guess. The reasoning, in full, is at the top of daemon/src/control.mjs.
 *
 * EXIT CODES: 0 — the machine is where you asked it to be (including «it was already
 * stopped»). 2 — refused because a worker is holding a task and you did not say --force.
 * 1 — anything else, and the line above it says what.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { loadConfig, resolveConfigPath } from '../daemon/src/config.mjs'
import { stopDaemon, restartDaemon, liftCommand, exitCodeFor } from '../daemon/src/control.mjs'

const USAGE = [
  'Управление демоном:',
  '  node supervisor/daemon-control.mjs stop [--force]      остановить своего демона',
  '  node supervisor/daemon-control.mjs restart [--force]   остановить и поднять тем же путём, что супервизор',
  '',
  '  --force   гасить, даже если прямо сейчас идёт живая попытка (её работа пропадёт)',
].join('\n')

/** say — one voice for the whole command, so a script can grep the prefix. */
function say(line) {
  console.log(`[sma-daemon] ${line}`)
}

/**
 * spawnLift(lift) — start the supervisor's own lift DETACHED, so this command can report on
 * the door and exit while the daemon goes on living. stdout/stderr of the posix lift land in
 * the same rotating daily log the Windows wrapper writes: a boot that dies must leave its
 * reason somewhere, and «inherited from a terminal that has closed» is nowhere.
 */
function spawnLift(lift, logDir) {
  const stdio = (() => {
    if (process.platform === 'win32') return 'ignore' // the .ps1 owns its own log file
    try {
      mkdirSync(logDir, { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const fd = openSync(join(logDir, `daemon-${stamp}.log`), 'a')
      return ['ignore', fd, fd]
    } catch {
      return 'ignore'
    }
  })()
  const child = spawn(lift.cmd, lift.args, { cwd: lift.cwd, detached: true, stdio, windowsHide: true })
  child.unref()
}

async function main(argv) {
  const verb = argv[0]
  const flags = new Set(argv.slice(1))
  const force = flags.has('--force') || flags.has('-f')

  if (!verb || verb === '--help' || verb === '-h' || !['stop', 'restart'].includes(verb)) {
    console.log(USAGE)
    return verb && !['--help', '-h'].includes(verb) ? 1 : 0
  }

  // A config that does not exist is a machine where this daemon was never set up. Reading it
  // through loadConfig would CREATE one (fresh token and all) as a side effect of asking a
  // question — so the absence is answered here, before anything writes.
  const configPath = resolveConfigPath()
  if (!existsSync(configPath)) {
    say(`конфига демона нет (${configPath}) — здесь он не настроен, останавливать нечего.`)
    return 0
  }
  const config = loadConfig({ repoDir: process.cwd() })
  const logDir = join(dirname(configPath), 'logs')

  const res =
    verb === 'stop'
      ? await stopDaemon({ config, force })
      : await restartDaemon({ config, force, lift: liftCommand(), spawnLift: (lift) => spawnLift(lift, logDir) })

  for (const line of res.lines) say(line)
  return res.code
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    say(`команда не отработала: ${String((err && err.stack) || err)}`)
    process.exit(exitCodeFor('refused'))
  })
