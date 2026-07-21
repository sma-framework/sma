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
 * process only starts under the `isMain` guard at the bottom. NO test imports this file
 * (it is verified by grep only — the same same-wave signature-coding posture the plan
 * uses for loop.mjs); the front modules are unit-tested directly.
 *
 * Node built-ins + the daemon's own modules only. Zero new deps.
 */

import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.mjs'
import { createPgBossQueue } from './queue/pgboss-backend.mjs'
import { recordAttempt, readAttempts } from './queue/attempt-ledger.mjs'
import { createEventHub, wrapAdapterWithEvents } from './front/events.mjs'
import { tick, runDaemon } from './loop.mjs'
import { createFrontServer } from './front/server.mjs'
import { deriveState, parseReceiptSummary } from './front/state.mjs'
import { resolveRoute } from './policy/routing.mjs'
import { windowState, isOpen } from './policy/windows.mjs'
import { readUsage } from './runner/usage.mjs'
import { spawnWorker } from './runner/spawn.mjs'
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
    }

  // (2) the SSE hint hub + the event-wrapped adapter handed to BOTH sides.
  const hub = o.hub ?? createEventHub({ clock })
  const adapter = wrapAdapterWithEvents(durable, hub, { clock })

  // (3) read seams for the front derive (windows state + usage), thin wiring only.
  const usageReader = (args) => readUsage({ dataDir, ...args })
  const windowsForState = (account) => windowState({ account, usageReader, clock, dataDir })
  const windowsOpenFor = (account) => isOpen(windowsForState(account), clock)

  // (4) the roster front — the wrapped adapter + the derive + the merge verb + CAS seam.
  const front =
    o.front ??
    createFrontServer({
      config,
      deps: {
        clock,
        adapter,
        hub,
        ledgerDir,
        repoDir,
        deriveState,
        parseReceiptSummary,
        windows: windowsForState,
        usageReader,
        execGit: o.execGit,
        casExec: o.casExec, // read-only SQL seam (same as pg-boss list()); wired at deploy
        // approve runs the EXISTING serialized merge verb LOCALLY — never a push.
        verbRunner: (m) => runMerge({ ...m, execGit: o.execGit, runTests: o.runTests }),
      },
    })

  // (5) the stateless tick — same wrapped adapter, so its transitions emit too.
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
    journal: o.journal,
  }
  const daemon = runDaemon({ tickMs: config.tickMs ?? 5000, onTick: () => tick(tickDeps) })

  return {
    config,
    hub,
    adapter,
    front,
    daemon,
    async start() {
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

// ── process entrypoint (the plist target). Import stays side-effect-free. ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  createDaemon()
    .start()
    .catch((err) => {
      // fail loud for the supervisor (KeepAlive restarts); mask any connection string.
      const msg = String((err && err.message) || err).replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, 'postgres://[masked]')
      console.error(`[SmaDaemon] fatal boot error: ${msg}`)
      process.exit(1)
    })
}
