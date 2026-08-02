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

import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadConfig, addProject, renameProject, selectProject, addPeer, removePeer } from './config.mjs'
import { createPgBossQueue } from './queue/pgboss-backend.mjs'
import { APPROVAL_TABLE } from './queue/approval-store.mjs'
import { recordAttempt, readAttempts, appendJournalEntry, readJournalEntries } from './queue/attempt-ledger.mjs'
import { createEventHub, wrapAdapterWithEvents } from './front/events.mjs'
import { createFederation } from './front/federation.mjs'
import { handleChatTurn, readHistory } from './front/chat.mjs'
import { readHarness, loadMcpRegistry, applyAgentToggle, applySkillAssign, applyMcpToggle } from './front/harness.mjs'
import { tick, runDaemon } from './loop.mjs'
import { createFrontServer } from './front/server.mjs'
import { deriveState, parseReceiptSummary } from './front/state.mjs'
import { resolveRoute } from './policy/routing.mjs'
import { windowState, isOpen } from './policy/windows.mjs'
import { readUsage, usageSeries } from './runner/usage.mjs'
import { spawnWorker } from './runner/spawn.mjs'
import { workerReadiness, poolReadiness } from './runner/readiness.mjs'
import { runMerge, defaultExecGit } from '../../scripts/sma/lib/merge-gate.mjs'

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
  const config = o.config ?? loadConfig()
  const dataDir = o.dataDir ?? config.dataDir
  const ledgerDir = o.ledgerDir ?? config.ledgerDir
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

  // (2b) the read-only git runner. ONE instance, handed to every consumer that needs git
  // (the front's diff/timeline, the merge verb approve runs) — never a shell.
  const execGit = o.execGit ?? defaultExecGit

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
        repoDir,
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
      front.listen()
      daemon.start()
    },
    async stop() {
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
      // fail loud for the supervisor (KeepAlive restarts); mask any connection string.
      const msg = String((err && err.message) || err).replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, 'postgres://[masked]')
      console.error(`[SmaDaemon] fatal boot error: ${msg}`)
      process.exit(1)
    })
}
