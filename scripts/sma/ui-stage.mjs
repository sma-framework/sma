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
 * ═══════════════════ …AND IT BRINGS SOMETHING FOR THE WINDOW TO SHOW ═════════════
 * A door with nothing behind it answers 501, and on a screen that reads as «этого в продукте
 * нет». The first version of this scene wired the shell's three collaborators and stopped, so
 * four read models — the conversation, the backlog, coordination, the harness — refused every
 * request. For a command that promised to raise and clean up, that was honest; for the worker
 * who takes the scene to check «Задачи» or «Бэклог», it is a red verdict about somebody else's
 * work, and they go looking for a defect where there is none.
 *
 * So the scene carries a KIT (lib/ui-stage.mjs), written into its own throwaway directory and
 * dying with it:
 *  - TWO TREES, not one. The two-tree case is our own and it is the treacherous one — work
 *    routed to the tree the code is not in — so «switch the project» has to be something a run
 *    can actually do. They differ deliberately: the first is a busy checkout (a backlog, a
 *    live session, a held reservation, a collision journalled today, a skill of its own), the
 *    second is quiet. A switch that changes nothing on the screen proves nothing.
 *  - THE LEDGER IS WRITTEN BY THE RUNTIME'S OWN WRITERS and read back by the daemon's own
 *    reader (`readCoordinationLedger`). Neither half is re-implemented here, so the fixture
 *    cannot drift away from the format the product actually keeps.
 *  - A PROFILE IN EACH TREE, so the window opens on the BOARD. The first-run interview is a
 *    real state of a real install, but it is not the state somebody raising a scene came to
 *    look at, and walking past it with a click was a step every run had to remember.
 * The registry doors keep their applier and lose their PEN: `selectProject` decides exactly as
 * it does in production and writes through an fs seam that goes nowhere, so the switch works
 * and the token still meets no file.
 *
 * ═══════════════════ THE RECEIPT OUTLIVES THE SCENE ══════════════════════════════
 * The scene hands its trailing command a receipts root OUTSIDE every working copy
 * (SMA_UI_RECEIPTS) and prints it. A run made in a throwaway copy used to write its verdict
 * and its screenshots into that copy, which is removed at acceptance — twice in one shift the
 * only evidence that the window worked stopped existing at the moment somebody went to read
 * it. This is the one directory the scene makes and does not take away.
 *
 * ═══════════════════ WHAT IT DOES NOT DO ═════════════════════════════════════════
 * It does not BUILD. No build is a normal state with a one-line cure, and turning «open
 * the window» into «change the repository» silently is not a trade a check may make on the
 * operator's behalf — so a missing build is exit 3 with the command that fixes it.
 * It adds NO dependency: the browser driver is the run engine's business, resolved at run
 * time through SMA_UI_DRIVER (scripts/sma/ui-drive.mjs), and nothing here imports one.
 * It opens NO door the daemon does not already have: the route table is untouched, and what
 * changed here is which collaborators the scene hands the SAME doors.
 * Its QUEUE STAYS EMPTY, in memory. The scene is a window, not a fleet: it must not be able
 * to see the real daemon's work, still less to move it — so the board shows an empty queue,
 * and that is a fixture's honest state rather than a hole.
 *
 * Node built-ins + this repository's own daemon modules only. Zero new deps.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectProject } from '../../daemon/src/config.mjs'
import { appendTurn, readHistory } from '../../daemon/src/front/chat.mjs'
import { createEventHub } from '../../daemon/src/front/events.mjs'
import { readHarness } from '../../daemon/src/front/harness.mjs'
import { createFrontServer } from '../../daemon/src/front/server.mjs'
import { deriveBacklog, deriveCoordination, derivePhaseIndex, deriveState } from '../../daemon/src/front/state.mjs'
import { readCoordinationLedger } from '../../daemon/src/main.mjs'
import { scopeClaimSlug } from './lib/collision.mjs'
import { claimSlot } from './lib/claims.mjs'
import { appendEvent } from './lib/journal.mjs'
import { heartbeat } from './lib/registry.mjs'
import { RECEIPTS_ENV } from './lib/ui-drive.mjs'
import {
  EXIT_BAD_ARGS,
  EXIT_NO_BUILD,
  STAGE_ACTIVE_PROJECT,
  STAGE_CHAT_TURNS,
  STAGE_DIR_PREFIX,
  STAGE_LEDGER,
  STAGE_RECEIPTS_DIR,
  URL_ENV,
  announcement,
  holdNotice,
  missingBuildMessage,
  parseStageArgs,
  stageCommandArgs,
  stageConfig,
  stageProjectFiles,
  stageProjects,
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

/**
 * THE APPLIER RUNS; THE PEN DOES NOT.
 *
 * The project switcher reaches a config write, and in production that write is the point. Here
 * it must not happen at all: `writeConfig` with no file on disk takes the caller's whole config
 * as the base, and this one carries the scene's TOKEN — so the first press of the switcher
 * would put the credential in a file, breaking the promise this command is built on and the
 * ban on secrets in a tree along with it.
 *
 * The fix is not a second applier. `selectProject` still decides — same validation, same named
 * refusal for an id nobody registered, same returned config — and is simply handed a
 * filesystem that writes nowhere. The registry the scene serves lives in memory for the length
 * of the scene, which is exactly as long as it is true.
 */
const PENLESS_FS = {
  readFileSync: () => {
    throw new Error('the scene keeps its registry in memory') // → readJsonSafe: no file on disk
  },
  writeFileSync: () => {},
  renameSync: () => {},
  mkdirSync: () => {},
  chmodSync: () => {},
}

/**
 * Write one tree of the kit: its plain files, and — for the busy one — the coordination ledger,
 * through the runtime's OWN writers. `.sma/` is a format this product keeps for its terminals;
 * a fixture that hand-shaped those files would be a second writer of it, and the day the real
 * one moved, the scene would go on showing a shape nothing else produces.
 */
function writeTree(project, { pid }) {
  for (const file of stageProjectFiles(project.id)) {
    const target = join(project.path, ...file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.text, 'utf8')
  }
  if (project.id !== STAGE_ACTIVE_PROJECT) return // the second tree is QUIET, and that is its whole job

  const smaRoot = join(project.path, '.sma')
  heartbeat(
    {
      scope: { globs: [...STAGE_LEDGER.globs], description: STAGE_LEDGER.description },
      status: 'working',
      label: STAGE_LEDGER.label,
    },
    {
      sessionsDir: join(smaRoot, 'sessions'),
      // The identity is HANDED OVER rather than resolved: a lease that took its name from the
      // machine would make the panel read differently on every operator's screen.
      identity: { terminalId: STAGE_LEDGER.terminalId, holderIdentity: STAGE_LEDGER.holderIdentity, pid },
      spawnSnapshot: false, // a fixture never reports itself anywhere
    },
  )
  // The reservation is filed under the slug the runtime derives from the scope's description —
  // the same join the panel and the force-clear command use, so the name shown is a name that
  // resolves.
  claimSlot(
    scopeClaimSlug(STAGE_LEDGER.description),
    { by: STAGE_LEDGER.holderIdentity, pid, session: STAGE_LEDGER.terminalId, reason: 'the scene holds this scope' },
    { claimsDir: join(smaRoot, 'claims') },
  )
  appendEvent(
    { type: 'collision', actors: [STAGE_LEDGER.holderIdentity, STAGE_LEDGER.otherActor], scope: STAGE_LEDGER.collisionScope },
    { journalDir: join(smaRoot, 'journal'), terminalId: STAGE_LEDGER.terminalId },
  )
}

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
  // The one directory that is NOT thrown away with the scene: where the run engine's receipt,
  // journal and screenshots go. A sibling of the scene's directory, never a child of it, and
  // outside every checkout — so neither the teardown below nor the removal of a working copy
  // can take the evidence with it.
  const receipts = join(tmpdir(), STAGE_RECEIPTS_DIR)
  mkdirSync(receipts, { recursive: true })

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

  // THE KIT, WRITTEN BEFORE THE DOOR OPENS. A screen that asked its question while the tree
  // behind it was still being made would photograph the gap and call it a fault.
  const projects = stageProjects(home)
  for (const project of projects) writeTree(project, { pid: process.pid })
  for (const turn of STAGE_CHAT_TURNS) appendTurn({ dir: home, turn })

  const config = stageConfig({ port: 0, token, projects, activeProject: STAGE_ACTIVE_PROJECT })
  front = createFrontServer({
    config,
    deps: {
      // The scene's whole environment points INSIDE its own directory: a door that decides
      // to write something writes it here, never into the operator's daemon home. BOTH machine
      // stores are named, not just the skills one — the harness read model walks the agents
      // store too, and an unnamed one resolves to the operator's own ~/.claude.
      env: {
        ...process.env,
        SMA_DAEMON_CONFIG: join(home, 'config.json'),
        SMA_DAEMON_SKILLS: join(home, 'skills'),
        SMA_DAEMON_AGENTS: join(home, 'agents'),
      },
      dataDir: home,
      ledgerDir: home,
      launchDir: home,
      chatDir: home, // the transcript lives beside the scene's own data, exactly as the daemon's does
      // The tree being SERVED — where the project's own skill and agent stores are looked for,
      // and where the interview looks for the profile that says the house is set up.
      repoDir: projects[0].path,
      // A home of its own, so nothing resolved «off the machine» reaches the operator's.
      homedir: () => home,
      // An EMPTY queue, in memory. The scene is a window, not a fleet: it must not be able
      // to see the real daemon's work, still less to move it.
      adapter: { list: async () => [] },
      deriveState,
      // The shell asks for the phase list on every screen; without this the door answers 501
      // and the run engine reports it as a blocking finding — rightly, so it is wired.
      derivePhaseIndex,
      // ── the four read models that used to refuse, each now given something to read ──
      // The board over the project's own file. There is no writing collaborator beside it,
      // which is the strongest form the «this door never edits your backlog» rule can take.
      deriveBacklog,
      // The ledger's own readers do the reading and the derive does the shaping — the daemon's
      // composition root hands over the very same reader, so the scene grows no second parser
      // of `.sma/` and cannot show a shape the product stopped writing.
      deriveCoordination: (args) => deriveCoordination({ ...args, readLedger: readCoordinationLedger }),
      // The transcript, read the way the daemon reads it. The engine that would WRITE a turn
      // (handleChatTurn, which spawns a child) is deliberately absent: a scene may show a
      // conversation, it may not start one.
      readChatHistory: readHistory,
      // Agents, skills, both stores and the connections state. Read-only; every applier that
      // could change any of it stays unwired.
      readHarness,
      // The switcher's one act. The production applier decides; PENLESS_FS holds the pen.
      selectProject: (cfg, args, io) => selectProject(cfg, args, { ...io, fsImpl: PENLESS_FS }),
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
  say(announcement({ url, port, dir: home, projects, receipts }))

  if (parsed.hold) {
    say(holdNotice())
    return // the open socket keeps this process alive; a signal is what ends it
  }

  const [cmd, ...rest] = stageCommandArgs(parsed.command, url)
  // The address AND the receipts root travel to the trailing command through its environment.
  // The second one is why a run made in a throwaway copy still has evidence after the copy is
  // gone, and it rides here rather than in an argument precisely so no command has to remember it.
  child = spawn(cmd, rest, { stdio: 'inherit', env: { ...process.env, [URL_ENV]: url, [RECEIPTS_ENV]: receipts } })
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
