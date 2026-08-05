/**
 * main.mjs — THE DAEMON COMPOSITION ROOT: the process entrypoint the supervisor plist
 * targets (Phase 9.5 Plan 08, Task 4; D-9.5-02/04/05 РЕВИЗИЯ).
 *
 * ═══════════════════════ PURE WIRING, NO LOGIC ═══════════════════════════════════
 * This file COMPOSES; it computes nothing. It constructs the config, the durable queue,
 * the event hub, the event-wrapped adapter, and hands that ONE wrapped adapter to BOTH
 * the stateless tick AND the roster front — one process, one adapter instance, so every
 * durable transition emits a live hint regardless of which side caused it. Like loop.mjs
 * it holds NO task state: this file constructs NO Map and NO Set (a literal grep gate);
 * any keyed state lives in the adapter/ledger, never here.
 *
 * ═══════════════════════ ONE ADAPTER, EMIT-AFTER-COMMIT ══════════════════════════
 * `wrapAdapterWithEvents(adapter, hub)` decorates the durable adapter so every committed
 * transition (enqueue/claim/touch/complete/fail) emits its hint AFTER the durable write
 * resolves (events.mjs). The tick drives the durable side; the front's approve/return
 * handlers emit their own post-CAS hints through the same hub. Truth always lives in the
 * queue + `.sma/`; the hub is a hint transport that a restart may drop losslessly
 * (D-9.5-02 statelessness holds because truth never lives in the hub).
 *
 * ═══════════════════════ THE FOUNDER-PUSH LAW (carried) ══════════════════════════
 * This process holds NO origin-push path (loop.mjs law). The front's approve runs the
 * EXISTING merge verb LOCALLY (runMerge, serialized by its own slot); nothing here talks
 * to origin. SMA-3: the push literal appears in no daemon source.
 *
 * Importing this module is SIDE-EFFECT-FREE — `createDaemon()` only wires, and the
 * process only starts under the `isMain` guard at the bottom.
 *
 * ═══════════════ THE COMPOSITION ROOT IS ITSELF UNDER TEST ═══════════════════════
 * This file used to be verified by GREP ONLY, and grep cannot see an ABSENCE: five
 * collaborators (execGit, casExec, readHarness and the two appliers) were simply never
 * wired, so on every real install approve/return/diff/harness answered «not implemented»
 * while a test suite that assembled its OWN server stayed green (the install-layout class
 * of hole: a test against an artificial build is silent about the real one). So
 * `composition-root.test.ts` now drives THIS factory — the production one, with no
 * collaborator overrides — across the whole route table and fails on any 501. A route
 * added without its wiring cannot survive a commit.
 *
 * Node built-ins + the daemon's own modules only. Zero new deps.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, addProject, renameProject, selectProject, addPeer, removePeer } from './config.mjs'
import { createPgBossQueue } from './queue/pgboss-backend.mjs'
import { APPROVAL_TABLE } from './queue/approval-store.mjs'
import { recordAttempt, readAttempts, appendJournalEntry, readJournalEntries } from './queue/attempt-ledger.mjs'
import { createEventHub, wrapAdapterWithEvents } from './front/events.mjs'
import { createFederation } from './front/federation.mjs'
import { handleChatTurn, readHistory } from './front/chat.mjs'
import {
  readHarness,
  loadMcpRegistry,
  applyAgentToggle,
  applySkillAssign,
  applyMcpToggle,
  applyStockTeamToggle,
} from './front/harness.mjs'
import {
  applyProjectMigration,
  previewProjectMigration,
  pruneMigrationStaging,
  readProjectMemory,
  stopWatch,
  watchProject,
} from './front/project-sync.mjs'
import { tick, runDaemon } from './loop.mjs'
import { createFrontServer } from './front/server.mjs'
import { deriveState, parseReceiptSummary } from './front/state.mjs'
import { resolveRoute } from './policy/routing.mjs'
import { windowState, isOpen } from './policy/windows.mjs'
import { readUsage, usageSeries } from './runner/usage.mjs'
import { spawnWorker } from './runner/spawn.mjs'
import { workerReadiness, poolReadiness } from './runner/readiness.mjs'
import { runMerge } from '../../scripts/sma/lib/merge-gate.mjs'

/**
 * createDaemon(overrides) — wire the whole daemon and return its handles WITHOUT starting
 * anything. Every collaborator is overridable so a future integration harness can drive
 * it; production calls it with no overrides.
 *
 * @param {object} [o] optional injected collaborators (config/dataDir/clock/…)
 * @returns {{config:object, hub:object, adapter:object, front:object, daemon:object, start:Function, stop:Function}}
 */
export function createDaemon(o = {}) {
  const clock = typeof o.clock === 'function' ? o.clock : Date.now
  // THE DIRECTORY THIS PROCESS WAS STARTED IN — a fact about the process, decided before
  // anything is read, and the ONLY honest baseline for «would the derive produce this
  // value again?». Everything that ends in a config write is handed this one (LP-3).
  const launchDir = o.launchDir ?? process.cwd()
  const config = o.config ?? loadConfig({ repoDir: launchDir })
  const dataDir = o.dataDir ?? config.dataDir
  const ledgerDir = o.ledgerDir ?? config.ledgerDir
  // THE TREE THIS DAEMON SERVES — the file's pin when it has one, the launch directory when
  // it does not. Everything that READS a repository (the roster, git log, the interview's
  // target) uses this. It is NOT a write baseline: for a pinned config it IS the pin, and
  // comparing the pin against itself is what deleted it from the founder's file (LP-3).
  const repoDir = o.repoDir ?? config.repoDir

  // (1) durable queue truth (Postgres via pg-boss) — the ONLY task store; plus the
  // sidecar attempt ledger as an OBJECT seam (liveness/sp-report call ledger.readAttempts —
  // a bare dir string silently no-ops them; the pilot finding).
  const durable = o.adapter ?? createPgBossQueue({ queueUrl: config.queueUrl, clock, ledgerDir })
  const ledger =
    o.ledger ?? {
      readAttempts: (taskId) => readAttempts(ledgerDir, taskId),
      recordAttempt: (row) => recordAttempt(ledgerDir, row),
      // the decision journal rides the same ledger dir (D-9.7-14) — same seam, same object
      appendJournal: (entry) => appendJournalEntry(ledgerDir, entry),
      readJournalEntries: (taskId) => readJournalEntries(ledgerDir, taskId),
    }

  // (2) the SSE hint hub + the event-wrapped adapter handed to BOTH sides.
  const hub = o.hub ?? createEventHub({ clock })
  const adapter = wrapAdapterWithEvents(durable, hub, { clock })

  // (2b) the git runner. ONE instance, handed to every consumer that needs git (the
  // front's diff/timeline, the merge verb approve runs): an args ARRAY, no shell, and the
  // child's stderr CAPTURED rather than inherited. That last part is not cosmetic — asking
  // for the diff of a branch that does not exist is an ordinary 404, and without it git's
  // «fatal: ambiguous argument 'wt/…'» lands in the daemon log as if something broke. The
  // message still reaches the caller on the thrown error, where it belongs.
  const execGit =
    o.execGit ??
    ((args, opts = {}) => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))

  // (3) read seams for the front derive (windows state + usage), thin wiring only.
  const usageReader = (args) => readUsage({ dataDir, ...args })
  // The cost history the spend screen draws — the SAME book, read per day and per lane. The
  // derive declared this seam from its first line; here is where it stops being empty.
  const usageSeriesReader = (args) => usageSeries({ dataDir, ...args })
  const windowsForState = (account) => windowState({ account, usageReader, clock, dataDir })
  const windowsOpenFor = (account) => isOpen(windowsForState(account), clock)

  // (4) federation — a HUB daemon (and only a hub) aggregates its peers. A standalone or
  // peer role wires nothing, so its behaviour is bit-for-bit what it was before V5.1. The
  // registry is validated at construction: a peer url the SSRF guard refuses stops the boot
  // here, loudly, rather than failing on the first poll of a night.
  const federation =
    o.federation ??
    (config.federation && config.federation.role === 'hub' ? createFederation({ config, clock }) : null)

  // The aggregator runs on the SAME rhythm as the founder's own state poll (2-5s): one poll
  // in, one round of peer polls out. No timer to own, no reconnect state, no drift.
  const aggregator = federation
    ? async (payload) => {
        await federation.pollPeers() // fail-open by construction: it never rejects
        return federation.aggregateState(payload)
      }
    : undefined

  // (4b) THE CONNECTED PROJECT (SB-031 part 2). The window shows a project the daemon does
  // not own — read-only, live while the watcher holds, and honest about it when it does not.
  // Three things are composed here and nowhere else:
  //   - WHICH project is connected. The registry's active entry, re-read on every call, so a
  //     project switch (which mutates this same config object in place) is picked up without
  //     a restart on both the read and the apply path.
  //   - WHERE proposals are staged. Beside the daemon's own data — NEVER inside the
  //     connected project, which is what keeps a preview read-only with respect to a tree
  //     this process does not own.
  //   - WHETHER the connection may call itself live. Only when a watcher is running, is not
  //     degraded, AND is watching the project the screen is currently showing. Anything else
  //     answers «polling», so a stale screen can never present itself as a live one.
  const migrationStagingDir = o.migrationStagingDir ?? join(dataDir ?? '.', 'migration-staging')
  const connectedProjectDir = () => {
    const list = Array.isArray(config.projects) ? config.projects : []
    if (list.length === 0) return null
    const active = list.find((p) => p && p.id === (config.activeProject ?? list[0].id)) || null
    return active && typeof active.path === 'string' && active.path.trim() !== '' ? active.path : null
  }
  const connectedProjectId = () => {
    const list = Array.isArray(config.projects) ? config.projects : []
    return (config.activeProject ?? (list[0] && list[0].id)) || null
  }
  let projectWatch = null
  const projectLiveness = () =>
    projectWatch && !projectWatch.degraded && projectWatch.projectDir === connectedProjectDir() ? 'live' : 'polling'

  /**
   * Start a watcher on whatever project is connected RIGHT NOW, replacing the one that was
   * running. Called at boot and again on every project select (D-11-DEFER-09).
   *
   * WHY IT IS ONE FUNCTION AND NOT TWO. The watcher used to be started once, inside `start()`,
   * from the project that happened to be connected at boot. Switching projects therefore left
   * the watcher on the old tree: the new project's changes reached the screen only through the
   * SPA's own poll, and the only recovery was restarting the daemon. Nothing lied — the
   * liveness seam compares the running watcher's directory with the connected one and answers
   * `polling` when they differ — but the instant hint was gone until a restart.
   *
   * A project with no folder connected is a valid state and leaves no watcher running: there
   * is nothing to watch, and `projectLiveness` says `polling`, which is the truth.
   */
  const retargetProjectWatch = () => {
    stopWatch(projectWatch)
    projectWatch = null
    const projectDir = connectedProjectDir()
    if (!projectDir) return null
    projectWatch = watchProject({
      projectDir,
      projectId: connectedProjectId(),
      emit: (frame) => {
        try {
          hub.emit(frame)
        } catch {
          /* a hint failure never affects the poll, which is the truth */
        }
      },
    })
    if (projectWatch.degraded) {
      console.log(
        `[SmaDaemon] project watch degraded to polling: ${projectWatch.degradedReason} — the window will say so.`,
      )
    }
    return projectWatch
  }

  // (5) the roster front — the wrapped adapter + the derive + the merge verb + CAS seam.
  const front =
    o.front ??
    createFrontServer({
      config,
      deps: {
        clock,
        adapter,
        hub,
        ledger, // the attempt ledger AND the decision journal ride the same seam
        ledgerDir,
        repoDir, // the tree being SERVED — reads only
        launchDir, // the process's own start directory — the write-time derive baseline
        deriveState,
        parseReceiptSummary,
        // the project registry doors — the ONLY way a request reaches a config write
        addProject,
        renameProject,
        selectProject,
        // the PEER registry doors — same posture: the introduction wizard reaches the
        // config only through these, and only after a one-shot invitation was consumed.
        addPeer,
        removePeer,
        federation, // the action-proxy engine + the pairing book (D-9.7-06/07)
        aggregator,
        // the «Разговор» engine — INJECTED, because its free branch spawns a child: a
        // capability like that reaches a request path only through deliberate wiring.
        handleChatTurn,
        readChatHistory: readHistory,
        chatDir: o.chatDir ?? dataDir, // the transcript lives beside the daemon's own data
        dataDir, // the spend book the «что съело лимит» branch reads
        policyDir: o.policyDir ?? dataDir, // where «Мой стиль» puts the distilled voice
        windows: windowsForState,
        usageReader,
        usageSeries: usageSeriesReader,
        // The read-only git runner behind /api/diff and the task timeline: the SAME
        // execFileSync-with-an-args-array runner the merge gate uses (no shell, ever).
        execGit,
        // The SQL seam behind approve/return: the durable queue's own executor, so the
        // front CASes through the one connection that already knows the queue database.
        casExec: o.casExec ?? (typeof durable.execSql === 'function' ? durable.execSql : undefined),
        taskTable: o.taskTable ?? APPROVAL_TABLE,
        // The harness read model + the three appliers (agents / skills / MCP screens).
        // Injected, never statically imported by the front (T-9.5-38/39) — this is the
        // wiring that makes «включить агента» a real switch instead of a 501.
        // The harness read model + the three appliers (agents / skills / MCP screens).
        // Injected, never statically imported by the front (T-9.5-38/39) — this is the
        // wiring that makes «включить агента» a real switch instead of a 501.
        readHarness,
        loadMcpRegistry: o.loadMcpRegistry ?? (() => loadMcpRegistry({})),
        applyAgentToggle,
        applySkillAssign,
        applyMcpToggle,
        // The one act that switches the whole shipped SMA team on — it rides the agent
        // toggle door under a reserved target, so the route table stayed at thirty.
        applyStockTeamToggle,
        // The connected project's corpus: read on every poll, previewed only when the corpus
        // is still in the older format, and applied ONE file at a time behind the approve
        // door. The applier is a CLOSURE over «which project» and «where the staging lives»
        // so a request handler never gets to name either.
        readProjectMemory,
        previewProjectMigration,
        projectLiveness,
        migrationStagingDir,
        // A project switch moves the tree the watcher is on. Without this the watcher stayed
        // bound to whatever was connected at boot, and the only recovery was a restart
        // (D-11-DEFER-09). The switch is also the moment the previous project's staged
        // previews become residue, so the retention sweep runs here too.
        onProjectSelected: () => {
          retargetProjectWatch()
          pruneMigrationStaging({ stagingDir: migrationStagingDir })
        },
        applyProjectMigration: ({ file }) => ({
          ...applyProjectMigration({ projectDir: connectedProjectDir(), stagingDir: migrationStagingDir, file }),
          projectId: connectedProjectId(),
        }),
        // approve runs the EXISTING serialized merge verb LOCALLY — never a push.
        verbRunner: (m) => runMerge({ ...m, execGit, runTests: o.runTests }),
      },
    })

  // (6) the stateless tick — same wrapped adapter, so its transitions emit too.
  const tickDeps = {
    clock,
    adapter,
    config,
    ledger,
    routing: { resolveRoute },
    windows: windowsOpenFor,
    spawnWorker,
    verbRunner: o.verbRunner,
    report: o.report,
    // The daemon's own event log. It is wired UNCONDITIONALLY: an unwired sink is how a
    // refused task became a silence — every reason the tick names has to reach a log.
    journal: o.journal ?? ((entry) => console.log(`[SmaDaemon] ${describeTickEvent(entry)}`)),
    // «Can this worker start at all?» — asked BEFORE the attempt, so a placeholder account
    // produces a named, recorded refusal instead of three silent burnt attempts.
    workerReady: o.workerReady ?? ((worker) => workerReadiness(worker, { fsImpl: o.fsImpl })),
    // the DECISION journal sink (three layers per attempt) — distinct from `journal`,
    // which is the daemon's own event log
    decisionJournal:
      o.decisionJournal ?? ((entry) => (typeof ledger.appendJournal === 'function' ? ledger.appendJournal(entry) : undefined)),
  }
  const daemon = runDaemon({ tickMs: config.tickMs ?? 5000, onTick: () => tick(tickDeps) })

  return {
    config,
    hub,
    adapter,
    federation,
    front,
    daemon,
    async start() {
      // The daemon makes its OWN home before anything writes into it: a ledger dir that
      // does not exist is how an attempt's «почему» used to be thrown away (the writer
      // creates the dir per row, but the readers and the spend book do not).
      for (const dir of [dataDir, ledgerDir]) {
        try {
          if (dir) mkdirSync(dir, { recursive: true })
        } catch (err) {
          console.error(`[SmaDaemon] could not create ${dir}: ${String((err && err.message) || err)}`)
        }
      }
      // the durable adapter owns its connection + queue provisioning — it must come up
      // BEFORE the tick can claim or the front can enqueue (the pilot finding).
      if (typeof durable.start === 'function') await durable.start()
      // The connected project is watched while the daemon runs. It is started AFTER the
      // queue and BEFORE the front only for tidiness — it owns nothing the others need, and
      // a project that cannot be watched degrades inside watchProject rather than here.
      // Staged previews are complete v2 renderings of a FOREIGN project's notes. Nothing used
      // to delete one; the sweep runs at boot and on every project switch (D-11-DEFER-10).
      pruneMigrationStaging({ stagingDir: migrationStagingDir })
      retargetProjectWatch()
      front.listen()
      daemon.start()
    },
    async stop() {
      stopWatch(projectWatch)
      projectWatch = null
      daemon.stop()
      if (front.server && typeof front.server.close === 'function') front.server.close()
      if (typeof hub.close === 'function') hub.close()
      if (typeof durable.stop === 'function') await durable.stop()
    },
  }
}

// ── log helpers (the only formatting this file does; every line is operator-facing) ──

/** Mask any connection string before it reaches a log line (the queue url carries creds). */
function maskSecrets(text) {
  return String(text ?? '').replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, 'postgres://[masked]')
}

/** One tick-journal entry as ONE operator line: ids + reasons, never a task payload (T-9.5-09). */
function describeTickEvent(entry) {
  const e = entry && typeof entry === 'object' ? entry : { type: String(entry ?? 'event') }
  const parts = [String(e.type ?? 'event')]
  if (e.taskId) parts.push(`task=${e.taskId}`)
  if (e.workerId) parts.push(`worker=${e.workerId}`)
  if (e.reason) parts.push(`reason=${e.reason}`)
  if (e.detail) parts.push(String(e.detail))
  if (e.error) parts.push(maskSecrets(e.error))
  return parts.join(' · ')
}

/** `host:port` of the queue url, with credentials and database name left out. */
function queueEndpoint(queueUrl) {
  try {
    const u = new URL(String(queueUrl))
    return `${u.hostname}:${u.port || '5432'}`
  } catch {
    return 'the configured queue host'
  }
}

/**
 * describeBootFailure(err, config) → the operator sentence for a boot that did not happen.
 *
 * WHY: node's dual-stack connect rejects with an AggregateError whose OWN message is
 * EMPTY, so the entire diagnosis of «Postgres is not running» read
 * `fatal boot error: AggregateError` — no cause, no address, no next step. The first real
 * error inside it carries both the code and the address; a person needs those plus what to
 * do about them. The connection string never appears (maskSecrets), only host:port.
 */
export function describeBootFailure(err, config = {}) {
  const causes = err && Array.isArray(err.errors) && err.errors.length ? err.errors : [err]
  const first = causes.find((c) => c && (c.code || c.message)) || err
  const code = (first && first.code) || (err && err.code) || ''
  const raw = maskSecrets((first && first.message) || (err && err.message) || String(err))
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) {
    return [
      `the task queue needs PostgreSQL at ${queueEndpoint(config.queueUrl)} and it did not answer (${code}).`,
      'Start PostgreSQL and create the queue database, or point "queueUrl" in the daemon config at a running one.',
      'How to set one up: docs/INSTALL.md.',
    ].join(' ')
  }
  return raw || String(code || 'unknown error')
}

// ── process entrypoint (the plist target). Import stays side-effect-free. ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const park = createDaemon()
  park
    .start()
    .then(() => {
      // succeed loud too: a silent boot reads as a hang from the operator's chair — but
      // «green» is a CLAIM, and it is only made when the pool can actually run a task.
      const where = `http://${park.config.bind}:${park.config.port}`
      const pool = poolReadiness(park.config)
      if (pool.total > 0 && pool.blocked.length === 0) {
        console.log(
          `[SmaDaemon] All systems green: queue up, front armed at ${where}, loop ticking. Buckle up, soldier — the park is live.`
        )
        return
      }
      console.log(`[SmaDaemon] Queue up, front armed at ${where}, loop ticking.`)
      if (pool.total === 0) {
        console.log('[SmaDaemon] NOT green: no enabled worker in the config, so no task can be run.')
        return
      }
      console.log(
        `[SmaDaemon] NOT green: ${pool.blocked.length} of ${pool.total} workers cannot start an attempt yet -`
      )
      for (const b of pool.blocked) console.log(`[SmaDaemon]   - ${b.id}: ${b.detail}`)
      console.log(
        '[SmaDaemon] Tasks routed to them will be refused with a recorded reason on the card ("missing_access"), never silently.'
      )
    })
    .catch((err) => {
      // fail loud for the supervisor (KeepAlive restarts), and fail USEFULLY: the cause,
      // the address and the next step, with no connection string in sight.
      console.error(`[SmaDaemon] cannot start: ${describeBootFailure(err, park.config)}`)
      process.exit(1)
    })
}
