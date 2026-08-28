#!/usr/bin/env node
/**
 * ui-stage.mjs — raise THIS working tree's built window on a port and a directory of its
 * own, print the address, and take the whole scene down again — including on a signal.
 *
 * Usage:
 *   node scripts/sma/ui-stage.mjs                     # raise and hold (Ctrl+C takes it down)
 *   node scripts/sma/ui-stage.mjs -- <cmd> [args…]    # raise, run <cmd>, then take it down
 *
 * The address is printed, and it is also handed to the trailing command as `{url}` in its
 * arguments and as SMA_STAGE_URL in its environment. It is an ordinary url:
 *
 *   node scripts/sma/ui-stage.mjs -- node scripts/sma/ui-drive.mjs {url} --no-sweep
 *
 * Exit: 0 clean (or the trailing command's own code) · 2 bad arguments
 *       3 NOT RUN — there is no built window to open
 *
 * ═══════════════════ WHY THIS EXISTS: THE SCENE IS NOT THE DAEMON ════════════════
 * A live look at the window needs a window that is LIVE, and the real daemon is the wrong
 * one twice over: it serves the build of the MAIN tree (so a change made here would not be
 * on the screen at all), and it stands on the real queue (so a walk across it can move a
 * person's actual work). Every check therefore used to build its own scene by hand, and
 * hand-built scenes went wrong the same three ways: a second daemon on somebody else's
 * port, a made-up token typed into a file — which this product's own leak scanner reads,
 * correctly, as a published key — and a process left running after the check was over.
 * This command is that scene, built once:
 *
 *  - ITS OWN PORT, FOUND BY TAKING IT. The door binds port 0 and asks the socket which
 *    port it got. Taking a port is the only way to know it was free — a probe answers
 *    about the moment before the answer — and there is no flag to name one, because a
 *    named port is how a scene lands on the daemon's.
 *  - ITS OWN DIRECTORY, thrown away with it: a fresh temp dir, handed to the door as its
 *    whole world (config path, data, ledger, skill store), so nothing it decides to write
 *    can land in ~/.sma-daemon or in this repository.
 *  - ITS TOKEN IS NOT A FILE. Minted here with randomBytes at boot, held in this process,
 *    printed to the terminal and passed to the trailing command through the environment.
 *    `loadConfig` is never called, so the operator's own config is neither read nor
 *    written, and no scene of ours ever asks anybody to work around the secrets ban.
 *  - IT TAKES ITSELF DOWN. On a clean end, on a trailing command's exit, and on a signal:
 *    the child is killed, the door is closed, the directory is removed. The door cannot
 *    outlive this process because it IS this process — so even the one ending no handler
 *    sees (a kill from another process, which on Windows terminates outright) ends the
 *    window; what such an ending can leave is the empty directory, in the system temp dir
 *    where it belongs, and never a server on somebody else's port.
 *
 * ═══════════════════ WHAT IT DOES NOT DO ═════════════════════════════════════════
 * It does not BUILD. No build is a normal state with a one-line cure, and turning «open
 * the window» into «change the repository» silently is not a trade a check may make on the
 * operator's behalf — so a missing build is exit 3 with the command that fixes it.
 * It adds NO dependency: the browser driver is the run engine's business, resolved at run
 * time through SMA_UI_DRIVER (scripts/sma/ui-drive.mjs), and nothing here imports one.
 * It connects NO project, so the window opens exactly where a fresh install opens it — on the
 * first-run interview. That is a state, not a fault: a run that wants the board behind it walks
 * past the interview with an ordinary step of the run engine (`click:Позже`).
 * It wires only the read-only collaborators the window's shell asks for on every screen
 * (state, the phase list, the live channel). Anything else answers 501 by construction —
 * a refusal the run engine reports as a finding rather than a scene quietly faking a door.
 *
 * Node built-ins + this repository's own daemon modules only. Zero new deps.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEventHub } from '../../daemon/src/front/events.mjs'
import { createFrontServer } from '../../daemon/src/front/server.mjs'
import { derivePhaseIndex, deriveState } from '../../daemon/src/front/state.mjs'
import {
  EXIT_BAD_ARGS,
  EXIT_NO_BUILD,
  STAGE_DIR_PREFIX,
  URL_ENV,
  announcement,
  holdNotice,
  missingBuildMessage,
  parseStageArgs,
  stageCommandArgs,
  stageConfig,
  stageUrl,
} from './lib/ui-stage.mjs'

/** THIS tree, resolved from this file — never from the cwd: the scene serves the build of
 *  the checkout it lives in, which is the entire point of not using the real daemon. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_DIR = join(ROOT, 'daemon', 'static', 'app')

/** Ways a scene is interrupted. SIGBREAK exists only on Windows and SIGHUP only off it —
 *  each is attached on its own, so the platform that has no name for one keeps the rest. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']

const say = (line) => process.stdout.write(`${line}\n`)

const USAGE =
  'usage: node scripts/sma/ui-stage.mjs [-- <command> [args…]]   ({url} in the command is the address)'

async function main() {
  const parsed = parseStageArgs(process.argv.slice(2))
  if (!parsed.ok) {
    say(`SMA ui-stage: ${parsed.error}\n${USAGE}`)
    process.exit(EXIT_BAD_ARGS)
  }

  // The build is checked BEFORE anything is created, so a tree with no window leaves no
  // directory and no process behind to explain.
  if (!existsSync(join(APP_DIR, 'index.html'))) {
    say(missingBuildMessage(APP_DIR))
    process.exit(EXIT_NO_BUILD)
  }

  const token = randomBytes(32).toString('hex')
  const home = mkdtempSync(join(tmpdir(), STAGE_DIR_PREFIX))

  let front = null
  let child = null
  let torn = false
  /** The whole undo of this command, written once and called from every ending. */
  const teardown = () => {
    if (torn) return
    torn = true
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch {
        /* it is already gone — nothing to kill */
      }
    }
    try {
      if (front) {
        // The sockets are dropped BEFORE the door is closed. A browser holds its connection
        // open, and close() alone only stops new ones: the process then exits with a live
        // handle mid-close, which the runtime meets with an abort instead of an exit code.
        front.server.closeAllConnections()
        front.server.close()
      }
    } catch {
      /* the socket dies with the process anyway */
    }
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* a directory we could not remove is worth no second failure */
    }
  }
  // 'exit' covers every ordinary ending — a return, a throw, an explicit exit — and it is
  // synchronous, which is exactly what rmSync needs. The signal handlers exist because a
  // signal does not otherwise reach 'exit' at all, and the leftover from that was the whole
  // problem: a live daemon on somebody else's port, outliving the check that started it.
  process.on('exit', teardown)
  for (const sig of SIGNALS) {
    try {
      process.on(sig, () => {
        teardown()
        process.exit(130)
      })
    } catch {
      /* this platform has no such signal — the others still stand */
    }
  }

  const config = stageConfig({ port: 0, token })
  front = createFrontServer({
    config,
    deps: {
      // The scene's whole environment points INSIDE its own directory: a door that decides
      // to write something writes it here, never into the operator's daemon home.
      env: { ...process.env, SMA_DAEMON_CONFIG: join(home, 'config.json'), SMA_DAEMON_SKILLS: join(home, 'skills') },
      dataDir: home,
      ledgerDir: home,
      launchDir: home,
      // An EMPTY queue, in memory. The scene is a window, not a fleet: it must not be able
      // to see the real daemon's work, still less to move it.
      adapter: { list: async () => [] },
      deriveState,
      // The shell asks for the phase list on every screen; without this the door answers 501
      // and the run engine reports it as a blocking finding — rightly, so it is wired.
      derivePhaseIndex,
      hub: createEventHub({}),
      clock: () => Date.now(),
    },
  })

  const server = await new Promise((ok, no) => {
    front.server.once('error', no)
    front.listen(() => ok(front.server))
  })
  const { port } = server.address()
  // The door is holding it now, so the config stops saying 0 — anything that reads the port
  // back off the config reads the one a browser can actually reach.
  config.port = port
  const url = stageUrl({ port, token })
  say(announcement({ url, port, dir: home }))

  if (parsed.hold) {
    say(holdNotice())
    return // the open socket keeps this process alive; a signal is what ends it
  }

  const [cmd, ...rest] = stageCommandArgs(parsed.command, url)
  child = spawn(cmd, rest, { stdio: 'inherit', env: { ...process.env, [URL_ENV]: url } })
  child.on('error', (err) => {
    say(`SMA ui-stage: could not run «${cmd}» — ${err.message}`)
    teardown()
    process.exit(1)
  })
  // The command's verdict is the scene's verdict: this wrapper adds a window, never an
  // opinion about what was seen through it.
  child.on('exit', (code, signal) => {
    // The code is SET, not exited on: an exit(2) called from inside a child's own event lands
    // on Windows as a runtime abort (a live process handle mid-close) rather than as that
    // code. Taking the door down empties the loop, and the process then ends by itself with
    // the verdict already in hand.
    process.exitCode = signal ? 1 : (code ?? 1)
    teardown()
  })
}

main().catch((err) => {
  say(`SMA ui-stage: NOT RUN — ${err.message}`)
  process.exit(1)
})
