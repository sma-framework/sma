/**
 * main.mjs — THE DAEMON COMPOSITION ROOT: the process entrypoint the supervisor plist
 * targets.
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
 * (statelessness holds because truth never lives in the hub).
 *
 * ═══════════════════════ THE FOUNDER-PUSH LAW (carried) ══════════════════════════
 * This process holds NO origin-push path (loop.mjs law). The front's approve runs the
 * EXISTING merge verb LOCALLY (runMerge, serialized by its own slot); nothing here talks
 * to origin: the push literal appears in no daemon source.
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

import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadConfig,
  addProject,
  renameProject,
  selectProject,
  setProjectPlanning,
  activeProjectEntry,
  codeTreeOf,
  planningHomeOf,
  addPeer,
  removePeer,
  addAccount,
  applyPipelineToggle,
  applyBudgetStop,
  applyTelegramConnect,
  applyTelegramPair,
  applyTelegramDisconnect,
  pipelineEnabled,
} from './config.mjs'
// ЧТО ЛЕЖИТ В ФАЙЛЕ НАСТРОЕК ПРЯМО СЕЙЧАС — против копии, прочитанной на запуске. Настройки,
// применяющиеся только с нового запуска, расходятся ровно с ней, и окно обязано это показать.
import { readConfigOnDisk } from './config-restart.mjs'
// The calling card this process leaves at the door, and the file the stop command reads to
// prove which process is ours. Written by start(), removed by stop() — see control.mjs.
import { writePidRecord, clearPidRecord, PID_RECORD_FILE } from './control.mjs'
import { announceRecovery } from './outage.mjs'
import { createSummons } from './summon.mjs'
import { createPgBossQueue } from './queue/pgboss-backend.mjs'
import { resolveExpireMs } from './queue/adapter.mjs'
import { APPROVAL_TABLE } from './queue/approval-store.mjs'
import {
  recordAttempt,
  readAttempts,
  appendJournalEntry,
  readJournalEntries,
  createAttemptLogWriter,
  readAttemptLog,
} from './queue/attempt-ledger.mjs'
import { appendBug, readBugs } from './queue/bug-journal.mjs'
import { cleanupTaskWorktree, createWorktreeSweeper } from './queue/worktree-cleanup.mjs'
import { scanBacklog } from './intake/backlog-scan.mjs'
import { createInFlight } from './queue/in-flight.mjs'
import { harvestTaskMemory } from './queue/memory-harvest.mjs'
import { attemptIdFor } from './front/journal.mjs'
import { collectDiagnostics } from './front/diagnostics.mjs'
import { createSearch } from './front/search.mjs'
import { createEventHub, wrapAdapterWithEvents } from './front/events.mjs'
import { createFederation } from './front/federation.mjs'
import {
  handleChatTurn,
  readHistory,
  createTurnRegistry,
  listConversations,
  renameConversation,
  createLiveConversations,
} from './front/chat.mjs'
import {
  readHarness,
  loadMcpRegistry,
  applyAgentToggle,
  applySkillAssign,
  createMachineSkill,
  applyMcpToggle,
  applyStockTeamToggle,
  applyAgentModel,
  resolveWorkerContext,
} from './front/harness.mjs'
import { reportTaskEvent } from './report.mjs'
// The window's entry link is assembled in ONE module shared with the CLI verb that opens it,
// so the boot line and `sma open` can never disagree about the same door.
import { entryLines, windowAddress } from '../../scripts/sma/lib/window.mjs'
import {
  applyProjectMigration,
  previewProjectMigration,
  pruneMigrationStaging,
  readProjectMemory,
  stopWatch,
  watchProject,
} from './front/project-sync.mjs'
import { tick, runDaemon, parseVerbResult } from './loop.mjs'
import { createTelegramBridge } from './telegram/poll.mjs'
import { createAgingMemory } from './policy/aging-memory.mjs'
import { createWorkerStats } from './front/worker-stats.mjs'
import { createFrontServer, runChatTurn } from './front/server.mjs'
import {
  deriveState,
  warmDoneGit,
  parseReceiptSummary,
  derivePhaseIndex,
  derivePhaseCard,
  deriveMemoryDrafts,
  deriveCoordination,
  deriveBacklog,
  deriveRules,
} from './front/state.mjs'
import { resolveRoute } from './policy/routing.mjs'
import { shouldApiFallback } from './policy/budget.mjs'
import { spendAccountNames } from './policy/spend.mjs'
import { windowState, terminalWindowState, isOpen } from './policy/windows.mjs'
import { readUsage, usageSeries, bookUsage } from './runner/usage.mjs'
import { spawnWorker } from './runner/spawn.mjs'
import { createBuildArgs } from './runner/build-args.mjs'
import { mirrorPersonalLayer } from './runner/personal-layer.mjs'
import { workerReadiness, poolReadiness } from './runner/readiness.mjs'
import { runMerge } from '../../scripts/sma/lib/merge-gate.mjs'
import { runMergeSmokeAsync } from '../../scripts/sma/lib/merge-smoke.mjs'

/**
 * runUpdateVerb({apply, projectDir}) — the update door's ONE collaborator, wired here and
 * nowhere else, so the request path can name whether to apply and never what to run.
 *
 * IT IS THE SAME UPDATER THE TERMINAL RUNS — `scripts/sma/lib/update.mjs`, the library
 * behind `sma update` — CONSUMED, not re-implemented: the version single-source law (the
 * installed stamp is capability.json), the honesty rule (installed newer than a source is
 * never phrased as an update) and the one write path (the standard installer, which owns
 * every preservation guarantee) all come along unchanged. Calling the CLI as a child would
 * have assumed the SERVED tree carries `scripts/sma/cli.mjs`; an installed consumer project
 * does not, and this daemon's own package always does.
 *
 * The module is imported LAZILY: it opens a network call to the registry, and a capability
 * like that is loaded when a person asks for it, not at boot.
 *
 * @param {{apply?:boolean, projectDir:string}} o
 * @returns {Promise<{ok:boolean, installed:(string|null), to:(string|null), source:(string|null), sources:object[], applied?:{ran:boolean, exitCode:(number|null)}}>}
 */
async function runUpdateVerb({ apply = false, projectDir }) {
  const upd = await import('../../scripts/sma/lib/update.mjs')
  const installed = upd.readInstalledVersion({ configDir: join(projectDir, '.claude') })
  const npm = await upd.fetchNpmVersion({}) // an unreachable registry is a verdict, never a throw
  const localDir = upd.detectLocalSource({ projectDir })
  const localRead = localDir ? upd.readSourceVersion({ sourceDir: localDir }) : null
  const local = localRead ? { ok: localRead.version != null, version: localRead.version, dir: localDir } : null
  const report = upd.buildReport({ installed: installed.version, npm, local })
  // npm is the default source and stays it unless the registry is unreachable and a local
  // checkout is not — the same precedence `sma update` uses without a --source flag.
  const npmSource = report.sources.find((s) => s.id === 'npm')
  const source = npmSource && npmSource.ok ? 'npm' : local && local.ok ? 'local' : 'npm'
  const chosen = report.sources.find((s) => s.id === source) || null
  // The reduction is where the PATHS stop: `label` names the local checkout's directory and
  // `detail` quotes an fs/network error, so neither is carried past this line.
  const base = {
    installed: installed.version ?? null,
    to: (chosen && chosen.version) ?? null,
    source,
    sources: report.sources.map((s) => ({ id: s.id, version: s.version ?? null, verdict: s.verdict })),
  }
  if (!apply) return { ...base, ok: true }
  if (!chosen || chosen.ok !== true || chosen.verdict === 'installed-newer') {
    // Nothing to apply, or applying would be a downgrade — refused, exactly as the verb does.
    return { ...base, ok: false, applied: { ran: false, exitCode: null } }
  }
  const plan = upd.planUpdate({ source, localDir, isGlobal: false })
  const applied = upd.applyUpdate({
    plan,
    runner: ({ command, args }) => {
      const res = spawnSync(command, args, {
        cwd: projectDir,
        stdio: 'inherit',
        // npx is a .cmd shim on Windows and needs a shell; node never does.
        shell: process.platform === 'win32' && command === 'npx',
      })
      return { exitCode: typeof res.status === 'number' ? res.status : 1 }
    },
  })
  return { ...base, ok: applied.ran && applied.exitCode === 0, applied: { ran: applied.ran, exitCode: applied.exitCode ?? null } }
}

// ══════════ THE WORKBENCH'S COLLABORATORS: the project's OWN runtime, run in place ══════════
//
// The memory workbench, the coordination panel and the backlog board all act on the CONNECTED
// project, and every act they offer ALREADY EXISTS there as a verb of that project's own SMA
// runtime. So the wiring below runs THAT runtime, in THAT directory, and nothing here
// re-implements a single rule it holds.
//
// WHY THE CHILD PROCESS RATHER THAN AN IMPORT, for these and not for the updater. The corpus
// linter and the index generator resolve `.claude/memory`, `CLAUDE.md`, `.planning/` and
// `.sma/` RELATIVE TO THE WORKING DIRECTORY. Imported into this process they would read the
// tree the DAEMON was started in and report it as the project's — the same class of mistake
// that once handed the served tree to a config writer and deleted the founder's pin. A child
// process with `cwd` set is the one arrangement in which «which project» is unambiguous.
//
// NO REQUEST NAMES A COMMAND. Each door gets a collaborator that takes DATA — a draft's name, a
// reservation's name, a reason — and the verb it runs is a constant of this file. A shared
// generic runner reaching a request path is the endpoint the front promises never to grow.

/** Where a project keeps its own SMA runtime — the layout the installer writes, and only it. */
const PROJECT_CLI_SEGMENTS = Object.freeze(['scripts', 'sma', 'cli.mjs'])

/** A verb of somebody else's checkout gets a bounded run: two minutes, eight megabytes. */
const PROJECT_VERB_TIMEOUT_MS = 120000
const PROJECT_VERB_MAX_BUFFER = 8 * 1024 * 1024

/** How much of a mechanism's refusal travels back — a sentence, never a transcript. */
const REFUSAL_CAP = 500

/**
 * A refusal with this machine's geography taken out of it.
 *
 * THE REDUCTION WHERE PATHS STOP, for the same reason the update door has one: the pipeline
 * writes honest messages that quote the file they are about, and a file is quoted BY ITS FULL
 * PATH. The words are the mechanism's; the directory they sit in is this machine's business.
 */
function withoutPaths(text, projectDir) {
  let out = String(text ?? '')
  for (const form of [projectDir, String(projectDir ?? '').replace(/\\/g, '/')]) {
    if (typeof form === 'string' && form.trim() !== '') out = out.split(form).join('…')
  }
  return out.slice(0, REFUSAL_CAP)
}

/**
 * runProjectVerb({verb, args, projectDir}, [overrides]) → {ok, code, result, reason}.
 *
 * One verb of the connected project's own runtime, run in that project's directory, with no
 * shell anywhere (an argument array, always). A project that is not connected and a project
 * with no SMA runtime are both an honest refusal — never a throw and never a silent zero.
 *
 * TWO LAWS LEARNED FROM A DOOR THAT HUNG FOREVER (QA D2, 11.08.2026 — «Проверяю корпус…»):
 *
 * 1. A DAEMON-SPAWNED VERB IS HEADLESS, AND ITS CHILDREN MUST KNOW IT. The project runtime
 *    spawns a window-snapshot child unless SMA_DISABLE_SNAPSHOT_SPAWN says otherwise. From a
 *    terminal that is a feature; from a daemon it is a window storm on the operator's desk —
 *    and the grandchild inherits this child's stdio pipe, which is the mechanism of law 2.
 * 2. THE DOOR ANSWERS EVEN WHEN THE PIPE NEVER CLOSES. execFile's callback waits for the
 *    child's stdio to close, not for the child to die: a grandchild holding the inherited
 *    pipe keeps the callback from firing even after the timeout KILLS the child. So the
 *    kill-timeout alone left the lint door silent forever, and the browser sat on
 *    «Проверяю корпус…» with no error branch ever taken. The race below guarantees an
 *    honest refusal a moment after the kill fires, whatever the pipe does.
 *
 * `overrides` exists for the tests (injectable exec + a short deadline), like every other
 * collaborator in this tree.
 */
export function runProjectVerb({ verb, args = [], projectDir }, { execFileImpl = execFile, timeoutMs = PROJECT_VERB_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (typeof projectDir !== 'string' || projectDir.trim() === '') {
      resolve({ ok: false, code: 1, reason: 'no project is connected' })
      return
    }
    const cli = join(projectDir, ...PROJECT_CLI_SEGMENTS)
    if (!existsSync(cli)) {
      resolve({ ok: false, code: 1, reason: `the connected project carries no SMA runtime (${PROJECT_CLI_SEGMENTS.join('/')})` })
      return
    }
    // Law 2: the answer deadline. Resolve is idempotent, so the late callback (if the pipe
    // ever closes) is a harmless no-op. unref'd — an answered door must not hold the process.
    const deadline = setTimeout(
      () => resolve({ ok: false, code: 1, reason: `the ${verb} verb did not answer within ${Math.round((timeoutMs + 5000) / 1000)}s` }),
      timeoutMs + 5000,
    )
    if (typeof deadline.unref === 'function') deadline.unref()
    execFileImpl(
      process.execPath,
      [cli, verb, ...args],
      {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: PROJECT_VERB_MAX_BUFFER,
        windowsHide: true,
        // Law 1: no snapshot children under a daemon — headless, and no pipe for a grandchild.
        env: { ...process.env, SMA_DISABLE_SNAPSHOT_SPAWN: '1' },
      },
      (err, stdout) => {
        clearTimeout(deadline)
        const parsed = parseVerbResult(String(stdout ?? ''))
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
        // A NON-ZERO EXIT IS NOT AUTOMATICALLY A FAILURE: these verbs answer «no» with an exit
        // code AND a parsed verdict, and the verdict is what the door reports. `ok` says only
        // whether the run produced one at all.
        const spoke = parsed && Object.keys(parsed).length > 0
        resolve({
          ok: spoke,
          code,
          result: parsed,
          ...(spoke ? {} : { reason: withoutPaths((err && err.message) || 'the verb printed no result', projectDir) }),
        })
      },
    )
  })
}

/**
 * The coordination ledger of one project, read by that runtime's OWN readers.
 *
 * This is a READ and it is done in-process on purpose — unlike the linter, these readers take
 * their directories as arguments rather than deriving them from a working directory, so there
 * is no ambiguity to resolve with a child process. What matters is that they are the readers
 * `status` itself uses: a second parser of `.sma/` is exactly what this daemon must not grow.
 *
 * Collisions are the JOURNALLED ones of today — the same window `status` counts, for the same
 * reason: the journal is append-only and never pruned, so an unbounded count becomes noise
 * within days of a busy checkout.
 *
 * EXPORTED FOR ONE CALLER BESIDES THIS ROOT: the live window scene (scripts/sma/ui-stage.mjs),
 * which raises the same door over a fixture checkout. Handing it this function is the whole
 * point — a scene that parsed `.sma/` its own way would be the second parser this comment
 * exists to forbid, and the day the ledger moved, the scene would keep showing the old one.
 */
export async function readCoordinationLedger({ projectDir, now = Date.now() }) {
  const out = { sessions: [], claims: [], collisions: [] }
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return out
  const smaRoot = join(projectDir, '.sma')
  const dirs = { smaRoot, sessionsDir: join(smaRoot, 'sessions'), claimsDir: join(smaRoot, 'claims'), journalDir: join(smaRoot, 'journal') }

  // WHAT A RESERVATION IS, IN THIS PRODUCT, IS TWO RECORDS. The scope a terminal reserved
  // (its globs and what it is doing) rides that terminal's own LEASE; the force-clearable
  // ENTRY is a directory named after the scope's slug. The join between them is the runtime's
  // own `scopeClaimSlug` — the same derivation the collision warning's «force-clear <slug>»
  // remediation uses — so a name shown here is a name that command will actually resolve.
  const scopes = new Map()
  try {
    const registry = await import('../../scripts/sma/lib/registry.mjs')
    const collision = await import('../../scripts/sma/lib/collision.mjs')
    const { sessions } = registry.readSessions(dirs)
    for (const s of sessions || []) {
      if (!registry.isSessionLive(s, { now })) continue // a graveyard lease is not somebody working
      out.sessions.push({
        id: registry.displayIdentity({ holderIdentity: s.holderIdentity, label: s.label }),
        title: s.label ?? '',
        since: s.acquireTime ?? s.renewTime ?? null,
      })
      const desc = s.scope && typeof s.scope.description === 'string' ? s.scope.description : ''
      if (desc !== '') {
        scopes.set(collision.scopeClaimSlug(desc), {
          globs: s.scope && Array.isArray(s.scope.globs) ? s.scope.globs : [],
          desc,
        })
      }
    }
  } catch {
    /* fail-open per source — one unreadable book never empties the other two */
  }

  try {
    const claims = await import('../../scripts/sma/lib/claims.mjs')
    for (const c of claims.readClaims(dirs) || []) {
      const scope = scopes.get(c.name) || null
      out.claims.push({
        name: c.name,
        globs: scope ? scope.globs : [],
        // A held slot whose owner's lease is gone still shows: the provenance line is what the
        // force-clear command prints, and «somebody reserved this and left» is the single most
        // useful row on this panel.
        desc: scope ? scope.desc : String(((c && c.provenance) || {}).reason ?? ''),
        ageMs: c.ageMs,
      })
    }
  } catch {
    /* fail-open */
  }

  try {
    const journal = await import('../../scripts/sma/lib/journal.mjs')
    const { events } = journal.readJournal(dirs)
    const today = new Date(now).toISOString().slice(0, 10)
    for (const e of events || []) {
      if (!e || e.type !== 'collision') continue
      if (typeof e.ts !== 'string' || e.ts.slice(0, 10) !== today) continue
      const actors = Array.isArray(e.actors) ? e.actors : []
      out.collisions.push({ a: actors[0] ?? '', b: actors[1] ?? '', overlap: e.scope ? [e.scope] : [] })
    }
  } catch {
    /* fail-open */
  }
  return out
}

/**
 * Квитанция слияния ОДНОЙ ветки из журнала терминалов — то есть доказательство приёмки,
 * когда принимал не человек.
 *
 * ПОЧЕМУ ЭТУ КНИГУ ВООБЩЕ ЧИТАЮТ. Приёмщиком стал терминал: он проводит ритуал слияния сам,
 * по стоящему добро, и в колонке решения после него не остаётся ничего — колонку заполняет
 * только нажатие двери окна. Пока эта книга не читалась, всякая терминальная приёмка
 * выглядела на экране как приёмка без приёмщика, а «принято» держалось на честном слове.
 *
 * ЧИТАЮТ ЕЁ ЕЁ ЖЕ ЧИТАТЕЛЕМ — тем самым, каким её читает `status`, и по тому же пути, каким
 * её пишет ритуал. Второй разборщик `.sma/` — ровно то, чего этому демону расти нельзя: в
 * день, когда журнал переедет, второй разборщик продолжит показывать вчерашний.
 *
 * ПОСЛЕДНЕЕ СЛИЯНИЕ, А НЕ ПЕРВОЕ: ветку задачи можно слить дважды (возврат, второй круг,
 * второе слияние), и действующая приёмка — последняя. Fail-open во всём: нечитаемый журнал,
 * отсутствующий каталог, битая строка — это `null`, «записи нет», и карточка скажет об этом
 * словами. Ни одно чтение здесь не имеет права уронить дверь.
 */
export async function readMergeJournal({ branch, projectDir } = {}) {
  if (typeof branch !== 'string' || branch.trim() === '') return null
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  try {
    const journal = await import('../../scripts/sma/lib/journal.mjs')
    const { events } = journal.readJournal({ journalDir: join(projectDir, '.sma', 'journal') })
    let hit = null
    for (const e of events || []) {
      if (!e || e.type !== 'merge') continue
      const detail = e.detail && typeof e.detail === 'object' ? e.detail : null
      if (!detail || detail.branch !== branch) continue
      hit = { terminal: typeof e.terminal === 'string' ? e.terminal : null, at: e.ts ?? null, receipt: detail }
    }
    return hit
  } catch {
    return null
  }
}

/**
 * The memory corpus, read for a search — through the SAME projection the loader uses.
 *
 * ONE READ PATH, and it is not this file's. `readNotes` + `projectNoteAxis` + `isVisibleNow`
 * are the corpus's own projection and its own read-time filters; the lexical layer above them
 * (with its FTS probe and its BM25 fallback) is the corpus's own retrieval. A daemon that
 * tokenized note files itself would be the second read path that layer's header names as the
 * main anti-pattern — and the two would drift apart silently the first time either changed.
 *
 * WHAT THE LAYER DOES NOT ANSWER, THE SHARED GRAMMAR DOES. `queryLexical` needs a BUILT index
 * (a derived artifact under `.sma/`, absent until somebody rebuilds it), and on a machine
 * without one it honestly answers «индекс не построен» and nothing else. So the visible axis
 * travels too, unscored: the projector ranks a scored row by the layer's score and an unscored
 * one by the same textual grammar the other four sources use. That is not a second READ — it
 * is the same projection, the same filter and the same rows, ranked by the box's own rule when
 * the corpus's own rule has nothing to say.
 *
 * The bodies are never read on any of these paths — the axis is the whole surface.
 */
async function readProjectNotes({ projectDir, query, limit }) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return []
  const corpusDir = join(projectDir, '.claude', 'memory')
  if (!existsSync(corpusDir)) return []

  const generator = await import('../../scripts/sma/lib/generator.mjs')
  const fts = await import('../../scripts/sma/lib/fts-index.mjs')

  const visible = (generator.readNotes(corpusDir) || []).filter((n) => generator.isVisibleNow(n))
  const byFile = new Map(visible.map((n) => [String(n.file ?? ''), n]))

  const scores = new Map()
  const note = (id, score) => {
    const prev = scores.get(id)
    if (prev === undefined || score > prev) scores.set(id, score)
  }
  try {
    const lexical = fts.queryLexical({ query, dbPath: join(projectDir, '.sma', fts.LEXICAL_INDEX_FILE), limit })
    for (const r of lexical.results || []) note(String(r.id), Number(r.score) || 0)
  } catch {
    /* an unreadable index is an absent one — the deterministic layers keep working */
  }
  try {
    // The exact layer is separate and CHEAP: it answers a path or a symbol somebody pasted,
    // needs no index at all, and is the reason a corpus with no built index is not silent.
    const exact = fts.queryExact({ query, notes: visible, limit })
    for (const r of exact.results || []) note(String(r.id), Number.MAX_SAFE_INTEGER)
  } catch {
    /* fail-open per layer */
  }

  const rows = []
  for (const [id, score] of scores) {
    const axis = byFile.get(id)
    if (axis) rows.push({ file: id, title: axis.description, hint: axis.useWhen, score })
  }
  const scored = new Set(scores.keys())
  for (const axis of visible) {
    if (scored.has(String(axis.file ?? ''))) continue
    rows.push({ file: String(axis.file ?? ''), title: axis.description, hint: axis.useWhen })
  }
  return rows
}

/**
 * ═══════════════ THE RELEASE GATE: three deterministic verbs, and their exit codes ═══════════
 *
 * WHAT A GATE IS MADE OF IS DECLARED HERE, ONCE, as data — never assembled from a request and
 * never named by a door. Each step is a verb the connected project's own runtime already
 * carries, each answers `--json`, and each decides GREEN by something the daemon can read
 * rather than something a model can claim:
 *
 *   консеквенции — `preship`, the product's own ship gate: open class-A events block, and the
 *                  verb says so with its exit code. This is not a check invented for a window;
 *                  it is the check the release ritual already refuses to ship past.
 *   корпус       — `lint`, the corpus linter: a critical finding exits non-zero.
 *   бейдж        — `passport --check-badge`, which answers whether the badge a reader sees
 *                  still matches the snapshot that was committed. It always exits 0 and
 *                  answers with a NUMBER, so this one step is judged by its verdict.
 *
 * WHAT IS NOT HERE, SAID OUT LOUD: the test suite. There is no verb in this product that runs
 * a project's tests, and there could not be one that a door may call — a door that took a
 * command to run is the single endpoint this whole front promises never to grow. The suite is
 * run by the person or by CI, and the gate reports on the evidence that IS machine-readable.
 */
const SHIP_GATE_STEPS = Object.freeze([
  {
    step: 'консеквенции',
    verb: 'preship',
    args: ['--json'],
    detail: (r, code) => (code === 0 ? 'открытых блокирующих событий нет' : `${(r.blocks || []).length} открытых блокирующих событий`),
  },
  {
    step: 'корпус',
    verb: 'lint',
    args: ['--json'],
    detail: (r, code) => (code === 0 ? 'критических находок нет' : `${(r.critical || []).length || '≥1'} критических находок`),
  },
  {
    step: 'бейдж',
    verb: 'passport',
    args: ['--check-badge', '--json'],
    ok: (r) => Number(r && r.consistent) === 1,
    detail: (r) => (Number(r && r.consistent) === 1 ? 'бейдж совпадает со снимком' : 'бейдж разошёлся со снимком'),
  },
])

/**
 * ═══════════════ AND WHAT PUBLISHING IS, IN THIS PRODUCT ═══════════════════════════════════
 *
 * This is the honest answer, and it is better than the obvious one. This product has NO verb
 * that pushes — every one of them says so in its own header, and the queue's capability rules
 * refuse the token by name. What it has instead is a soft-deny gate, GATE-PUSH, which lets a
 * push proceed only when the full gate has left its EVIDENCE MARKER for the current HEAD. So
 * «опубликовать» here is: put the run on the record, and write that marker.
 *
 * That is not a half-built door. It is the product's own model of a release: the machine does
 * every part it can be trusted with and GRANTS THE PERMISSION; the person performs the act.
 * A browser button that pushed would be this product disagreeing with its own law in the one
 * place the law was written for.
 */
const SHIP_PUBLISH_STEPS = Object.freeze([
  { step: 'полоса', verb: 'ship-lane', args: ['record', '--lane', 'full', '--outcome', 'green', '--json'] },
  { step: 'отметка ворот', verb: 'gates', args: ['mark-fullgate', '--json'] },
])

/**
 * THE RECORD OF WHAT THIS DAEMON WATCHED GO GREEN.
 *
 * It lives in this PROCESS and nowhere else, and that is a decision rather than a shortcut: a
 * gate receipt is a statement about the tree AT A MOMENT, and a receipt that outlived the
 * daemon that issued it would be a statement about a tree nobody was watching. A restart
 * therefore invalidates every outstanding receipt — which is the correct direction of error
 * for the lock in front of the most expensive act in the product, and it also means no receipt
 * can ever be forged by writing a file.
 *
 * The Map is bounded: a run that is not the newest few is forgotten, because a person
 * publishes from the gate they just watched, never from one from last Tuesday.
 */
const SHIP_GATE_RUNS = new Map()
const SHIP_GATE_RUNS_KEPT = 8
/** Which run, if any, is in flight. A lock held by whoever RUNS the thing, not by a door. */
let shipGateInFlight = null
let shipPublishInFlight = false

/** runShipGate({onStep, projectDir, clock}) — the steps above, in order, by their exit codes. */
async function runShipGate({ onStep, projectDir, clock = Date.now } = {}) {
  if (shipGateInFlight) return { busy: true, taskId: shipGateInFlight }
  const taskId = `G-${clock()}`
  shipGateInFlight = taskId
  const checks = []
  try {
    for (const s of SHIP_GATE_STEPS) {
      const run = await runProjectVerb({ verb: s.verb, args: s.args, projectDir })
      const result = run.result || {}
      const ok = run.ok === false ? false : typeof s.ok === 'function' ? !!s.ok(result) : run.code === 0
      checks.push({
        step: s.step,
        ok,
        detail: run.ok === false ? withoutPaths(run.reason ?? 'верб не ответил', projectDir) : String(s.detail(result, run.code)),
      })
      // AFTER each step, never before: a hint that a step «started» is a hint that says
      // nothing a spinner does not already say.
      if (typeof onStep === 'function') {
        try {
          onStep({ taskId, step: s.step, ok })
        } catch {
          /* a hint failure never affects the gate */
        }
      }
    }
  } finally {
    shipGateInFlight = null
  }
  const ok = checks.length === SHIP_GATE_STEPS.length && checks.every((c) => c.ok)
  const receipt = `ship-gate:${taskId}`
  SHIP_GATE_RUNS.set(receipt, { green: ok, at: clock() })
  while (SHIP_GATE_RUNS.size > SHIP_GATE_RUNS_KEPT) SHIP_GATE_RUNS.delete(SHIP_GATE_RUNS.keys().next().value)
  return { taskId, ok, checks, ...(ok ? { receipt } : {}) }
}

/** verifyGateReceipt(receipt) — was THIS the receipt of a run this process watched go green. */
function verifyGateReceipt(receipt) {
  const row = SHIP_GATE_RUNS.get(String(receipt ?? ''))
  if (!row) return { green: false, reason: 'этот прогон воротам неизвестен — прогоните ворота заново' }
  if (row.green !== true) return { green: false, reason: 'этот прогон ворот не был зелёным' }
  return { green: true }
}

/** publishRelease({version, projectDir, clock}) — the record and the marker, in that order. */
async function publishRelease({ version, projectDir, clock = Date.now } = {}) {
  if (shipPublishInFlight) return { busy: true }
  shipPublishInFlight = true
  const startedAt = new Date(clock()).toISOString()
  const receipts = []
  try {
    for (const s of SHIP_PUBLISH_STEPS) {
      const args = s.verb === 'ship-lane' ? [...s.args, '--started', startedAt, '--ended', new Date(clock()).toISOString()] : s.args
      const run = await runProjectVerb({ verb: s.verb, args, projectDir })
      if (!run.ok || run.code !== 0) {
        return { ok: false, reason: `${s.step}: ${withoutPaths(run.reason ?? 'верб отказал', projectDir)}` }
      }
      receipts.push(`${s.step}=${run.result && run.result.sha ? String(run.result.sha).slice(0, 12) : 'ok'}`)
    }
  } finally {
    shipPublishInFlight = false
  }
  return { ok: true, receipt: `ship-publish:${version}@${receipts.join('+')}` }
}

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
  // value again?». Everything that ends in a config write is handed this one.
  const launchDir = o.launchDir ?? process.cwd()
  const config = o.config ?? loadConfig({ repoDir: launchDir })
  const dataDir = o.dataDir ?? config.dataDir
  const ledgerDir = o.ledgerDir ?? config.ledgerDir
  // THE TREE THIS DAEMON SERVES — the file's pin when it has one, the launch directory when
  // it does not. Everything that READS a repository (the roster, git log, the interview's
  // target) uses this. It is NOT a write baseline: for a pinned config it IS the pin, and
  // comparing the pin against itself is what deleted it from the founder's file.
  const repoDir = o.repoDir ?? config.repoDir

  // (1) durable queue truth (Postgres via pg-boss) — the ONLY task store; plus the
  // sidecar attempt ledger as an OBJECT seam (liveness/sp-report call ledger.readAttempts —
  // a bare dir string silently no-ops them; the pilot finding).
  // The liveness value is resolved ONCE and handed to the queue, whose lease is one of the
  // two mechanisms that requeue a silent worker's task; the tick's sweep — the other one —
  // resolves the same config through the same function. They used to be independent: the
  // sweep read the config, the queue was built without it and leased on the built-in
  // default, so an operator who lengthened the expiry moved one clock and not the other.
  const durable =
    o.adapter ?? createPgBossQueue({ queueUrl: config.queueUrl, clock, ledgerDir, expireMs: resolveExpireMs(config) })
  const ledger =
    o.ledger ?? {
      readAttempts: (taskId) => readAttempts(ledgerDir, taskId),
      recordAttempt: (row) => recordAttempt(ledgerDir, row),
      // the decision journal rides the same ledger dir — same seam, same object
      appendJournal: (entry) => appendJournalEntry(ledgerDir, entry),
      readJournalEntries: (taskId) => readJournalEntries(ledgerDir, taskId),
      // …и ЕДИНЫЙ ЖУРНАЛ СРЫВОВ — там же, потому что сводит он именно то, что лежит здесь:
      // слово очереди и слово реестра об одной задаче. Один файл на все проекты; проект
      // назван в строке (bug-journal.mjs).
      appendBug: (entry) => appendBug(ledgerDir, entry, { now: clock }),
      readBugs: () => readBugs(ledgerDir),
      // …and so does the LIVE log: the worker's stdout, appended while the process is still
      // alive, one file per attempt. A write that fails reaches the daemon's log ONCE and
      // changes nothing else — the transcript is an observation of the work, not a condition
      // of it, and a founder who loses the picture must not lose the task with it.
      // …and the other half of that log: the READ. Same directory, same one file per attempt,
      // and the ceiling on a tail belongs to the reader rather than to whoever asks — so the
      // door hands the asked-for number through untouched instead of growing a second limit.
      readAttemptLog: ({ attemptId, tail }) => readAttemptLog({ dir: ledgerDir, attemptId, tail }),
      attemptLog: ({ attemptId }) =>
        createAttemptLogWriter({
          dir: ledgerDir,
          attemptId,
          clock,
          onError: (err) =>
            console.error(`[SmaDaemon] attempt log unavailable for ${attemptId}: ${String((err && err.message) || err)}`),
        }),
    }

  // …and the roster's period figures over that same ledger dir: «сделано / не получилось»
  // за 30 дней, counted from the concluded attempts instead of from whatever finished rows a
  // poll still carried. Built once because it holds the TTL cache that keeps a frequent state
  // read from scanning the whole ledger directory every time.
  const workerStats = o.workerStats ?? createWorkerStats({ ledgerDir, clock })

  // (2) the SSE hint hub + the event-wrapped adapter handed to BOTH sides.
  const hub = o.hub ?? createEventHub({ clock })
  const adapter = wrapAdapterWithEvents(durable, hub, { clock })

  // ── THE STEERING REGISTRY: one instance, both sides (phase «Двигатель») ──
  // The redirect door (front) tells a live child to die; the tick registers each child's
  // kill-handle here. One object, both consumers, same law as the event hub: hint plumbing,
  // never truth — a restart loses only the ability to kill children that died with it.
  const attemptTurns = createTurnRegistry()

  // ── ДОМ ИДУЩИХ ПОПЫТОК: ОДИН НА ОБЕ СТОРОНЫ ──────────────────────────────────────────────
  //
  // Построен ЗДЕСЬ, рядом с хабом и реестром ходов, по той же причине, что и они: его
  // спрашивают двое. Тик берёт в нём место перед захватом и отдаёт в `finally`; дверь
  // состояния спрашивает, сколько мест занято, чтобы человек прочёл на экране «занято X из N».
  //
  // ИМЕННО ОДИН ОБЪЕКТ, а не по дому на сторону. Второй дом отвечал бы двери «свободно» ровно
  // тогда, когда первый отказывает тику в месте, — и подпись на экране объясняла бы машину,
  // которой нет. Ошибку в настройке потолка тем и не могли уличить целый день, что снаружи
  // потолка не было видно вовсе.
  const inFlight = o.inFlight ?? createInFlight()

  // (2b) the git runner. ONE instance, handed to every consumer that needs git (the
  // front's diff/timeline, the merge verb approve runs): an args ARRAY, no shell, and the
  // child's stderr CAPTURED rather than inherited. That last part is not cosmetic — asking
  // for the diff of a branch that does not exist is an ordinary 404, and without it git's
  // «fatal: ambiguous argument 'wt/…'» lands in the daemon log as if something broke. The
  // message still reaches the caller on the thrown error, where it belongs.
  const execGit =
    o.execGit ??
    ((args, opts = {}) => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))

  // …И ТОТ ЖЕ ВОПРОС, ЗАДАННЫЙ ТАК, ЧТОБЫ НЕ ДЕРЖАТЬ ДОМ. Синхронный бегун выше честен на
  // пути одного запроса — один подпроцесс, один ответ, — но у демона ОДИН цикл событий, и
  // работа, которой нужны сотни запусков подряд (досылка истории закрытых работ), обязана
  // спрашивать иначе: иначе она отнимает дверь у человека ровно так же, как отнимала её
  // сборка выдачи до того, как перестала спрашивать git на пути ответа.
  const execGitAsync =
    o.execGitAsync ??
    ((args, opts = {}) =>
      new Promise((resolve, reject) => {
        execFile('git', args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        )
      }))

  // (2c) THE TICK'S VERB RUNNER — the third collaborator the loop declares and production
  // never wired. `invokeVerb` runs one SMA CLI verb (`worktree provision` above all) through
  // it; with nothing injected it called `undefined(...)`, its own catch turned that into
  // `{code:1}`, the tick fell back to a worktree path that does not exist, and the spawn then
  // failed on a missing cwd. Measured: a code task died in 300 ms with «среда исполнения
  // недоступна» while the routing journal showed a perfectly good worker.
  //
  // NOT the same collaborator as the front's `verbRunner` further down — that one is the
  // merge verb and takes a merge description. This one takes (bin, args, {cwd}) and answers
  // {code, stdout}, which is what invokeVerb parses.
  //
  // ASYNC on purpose, unlike execGit above: a worktree provision is seconds of git, and a
  // synchronous child would freeze the front while a task starts.
  const cliVerbRunner = (bin, args, opts = {}) =>
    new Promise((resolve) => {
      execFile(bin, args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        // A non-zero verb is DATA, not an exception: the verb prints its own envelope on the
        // way out and the tick reads it. Only the code changes.
        resolve({
          code: err && Number.isFinite(err.code) ? err.code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    })

  // (3) read seams for the front derive (windows state + usage), thin wiring only.
  const usageReader = (args) => readUsage({ dataDir, ...args })
  // The cost history the spend screen draws — the SAME book, read per day and per lane. The
  // derive declared this seam from its first line; here is where it stops being empty.
  const usageSeriesReader = (args) => usageSeries({ dataDir, ...args })
  /**
   * A WINDOW BELONGS TO AN ACCOUNT, AND TWO CALLERS ASK ABOUT IT WITH DIFFERENT NOUNS.
   *
   * The front asks about an account, because that is what its screen lists. The router asks
   * about a WORKER, because that is what it is choosing between — and a worker is not an
   * account, it merely has one. The window module reads `.name` off whatever it is given, so
   * the router's question resolved to `undefined`: the state was read from a file named after
   * nothing, and the usage estimate behind it, given no account to filter by, summed the whole
   * machine against one account's capacity.
   *
   * Both failure directions were live at once. A subscription the vendor itself reported as
   * spent still received work, because the gate never saw that reading; and on a busy machine
   * every worker's estimate could cross 100% together and idle the whole conveyor while the
   * real accounts were fresh. Neither could be caught by a test: every test of the router
   * injects its own predicate, and every test of the window module passes an account.
   */
  const accountOf = (subject) => {
    if (!subject || typeof subject !== 'object') return subject
    return subject.account && typeof subject.account === 'object' ? subject.account : subject
  }
  // No usage reader here any more: a window is what the vendor said about the ACCOUNT, and
  // this daemon's own token count could only ever see the sessions it spawned itself.
  const windowsForState = (subject) => windowState({ account: accountOf(subject), clock, dataDir })
  const windowsOpenFor = (subject) => isOpen(windowsForState(subject), clock)

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

  // (4a) THE CONNECTED PROJECT. The window shows a project the daemon does
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
  const connectedProjectDir = () => codeTreeOf(activeProjectEntry(config))
  /**
   * ВТОРОЙ АДРЕС ТОГО ЖЕ ПРОЕКТА — дом планирования: каталог, где лежит его `.planning`.
   * Не задан — это тот же каталог, что и дерево кода, и всё ниже отвечает как раньше. Задан —
   * фазы, беклог и дорожная карта читаются оттуда, а код по-прежнему строится в дереве кода.
   */
  const connectedPlanningDir = () => planningHomeOf(activeProjectEntry(config))
  const connectedProjectId = () => {
    const list = Array.isArray(config.projects) ? config.projects : []
    return (config.activeProject ?? (list[0] && list[0].id)) || null
  }
  let projectWatch = null
  const projectLiveness = () =>
    projectWatch && !projectWatch.degraded && projectWatch.projectDir === connectedProjectDir() ? 'live' : 'polling'

  // ═══ WHAT HAPPENS TO THE COPY A TASK RAN IN — two callers, one module ═══════════════
  //
  // Every code task works in its own copy on its own branch and nothing ever removed one:
  // the approval merged the branch and walked away. Both halves are wired here because both
  // need the same three collaborators (the project's CLI, the attempt ledger, the clock) and
  // neither may be handed a runner it could aim anywhere else.
  //
  // The copies live in the CONNECTED project, so that is the tree the verb is run in; the
  // served tree is the fallback for a daemon with nothing connected.
  const worktreeLog = (entry) => {
    const e = entry && typeof entry === 'object' ? entry : { type: String(entry ?? 'event') }
    const parts = [String(e.type ?? 'event')]
    if (e.taskId) parts.push(`task=${e.taskId}`)
    if (e.by) parts.push(`by=${e.by}`)
    if (e.reason) parts.push(`reason=${e.reason}`)
    if (e.path) parts.push(`path=${e.path}`)
    if (e.error) parts.push(`error=${maskSecrets(e.error)}`)
    console.log(`[SmaDaemon] ${parts.join(' ')}`)
  }
  // A SEPARATE NAME FOR THE DOOR'S COLLABORATOR, exactly like `updateRunner` further down:
  // the approve handler receives a function that can only remove the copy of the task it was
  // given, never a runner it could ask to run something else.
  //
  // `cwd` — ДЕРЕВО, В КОТОРОМ КОПИЯ РЕАЛЬНО ЛЕЖИТ, названное дверью по адресам задачи и её
  // проекта: то же выражение, каким та же дверь только что искала ветку. Без него уборка
  // спрашивала бы про копию задачи проекта A у проекта B — и честно не находила бы её.
  const worktreeCleanup = ({ taskId, by, cwd }) =>
    cleanupTaskWorktree({
      taskId,
      by,
      projectDir: (typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null) ?? connectedProjectDir() ?? repoDir,
      ledger,
      verbRunner: cliVerbRunner,
      clock,
      log: worktreeLog,
    })
  // ЧТО РАБОТНИК УЗНАЛ — В КОРПУС ПРОЕКТА, И РАНЬШЕ УБОРКИ. Четвёртое отдельное имя рядом с
  // `worktreeCleanup`, `updateRunner` и `verbRunner`, и по той же причине: дверь получает
  // функцию, которая умеет назвать ТОЛЬКО задачу. Корпус берётся у подключённого проекта, а
  // не у каталога запуска демона: урок принадлежит дереву, которое человек читает.
  const memoryHarvest = ({ taskId }) =>
    harvestTaskMemory({
      taskId,
      projectDir: connectedProjectDir() ?? repoDir,
      ledger,
      verbRunner: cliVerbRunner,
      execGit,
      clock,
      log: worktreeLog,
    })
  // …and the tick's half: every OTHER closed task, swept once a day. Both the connected
  // project and every project the roster knows — a copy left in a project the founder
  // switched away from is exactly the one nobody would ever come back for.
  //
  // ОБА АДРЕСА КАЖДОГО ПРОЕКТА. Копия документарной ступени режется из ДОМА ПЛАНИРОВАНИЯ, и
  // обход, знающий только деревья кода, оставлял бы её лежать вечно.
  const worktreeSweeper = createWorktreeSweeper({
    projectsOf: () => [
      ...new Set(
        [
          connectedProjectDir(),
          connectedPlanningDir(),
          ...(Array.isArray(config.projects) ? config.projects.flatMap((p) => [codeTreeOf(p), planningHomeOf(p)]) : []),
        ].filter(Boolean),
      ),
    ],
    adapter,
    ledger,
    verbRunner: cliVerbRunner,
    clock,
    log: worktreeLog,
  })

  /**
   * Start a watcher on whatever project is connected RIGHT NOW, replacing the one that was
   * running. Called at boot and again on every project select.
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

  // THE TESTS THE MERGE GATE RUNS — resolved HERE, once, exactly like the updater, the copy
  // sweep and the memory harvest below it. It was the only collaborator of that door with no
  // production value behind it: the closure passed `o.runTests` straight through, production
  // calls this factory with no overrides at all, and so the gate that decides whether accepted
  // work enters the trunk ran nothing and recorded «no runner was wired». Written down as
  // «вычислено, но не подключено»: the runner existed, was covered, was green, and was
  // reachable from nowhere.
  //
  // A NAME OF ITS OWN, for the same reason the three below have one: a door names the task it
  // needs done, never a command it wants run. A generic «run whatever» collaborator on a
  // request path is how a browser gets to name a program.
  //
  // THE ASYNC ONE, deliberately. The ritual has awaited its runner since the day it was
  // written; what the root handed it was still the synchronous body, so the approval door
  // froze the daemon's one event loop for up to two minutes of smoke run while a person
  // waited on «Одобрить». The command line keeps the synchronous runner — it blocks only
  // its own process; a door may not block anybody's.
  const mergeTestRunner = o.runTests ?? runMergeSmokeAsync

  // ═══ КОД, КОТОРЫЙ НИКТО НЕ СМОГ ПОДПИСАТЬ ═══
  //
  // The daemon's own event log, resolved HERE rather than at the tick, because two things
  // now write to it and the one built later must not get a second copy of the default.
  const daemonJournal = o.journal ?? ((entry) => console.log(tickJournalLine(entry, clock)))
  // The bounded register of dispatcher codes the closed vocabulary could not sign. It lives
  // at the root, beside the decision journal it is the counterpart of: the journal records
  // what WAS explained, this records what could not be. Built once, held in memory for the
  // life of the daemon, and read by the feedback window — a defect nobody can see is a defect
  // that gets rediscovered by the next person to lose an afternoon to it.
  const unknownDispatchCodes = o.unknownDispatchCodes ?? createUnknownDispatchRegistry({ journal: daemonJournal, clock })

  // ── ONE DERIVE IN FLIGHT, AND ITS ANSWER LIVES A MOMENT ──────────────────────────────────
  //
  // The window polls /api/state every 3 seconds, and /api/done rides the SAME full derive.
  // The derive itself can be expensive (it walks the ledger, the corpus and — before its git
  // reads were remembered — spawned two subprocesses per finished task), and everything here
  // shares ONE event loop. Measured 26.08.2026: a 26-second derive with a 3-second poll means
  // the loop is saturated by overlapping copies of the SAME question, and every other door —
  // including the founder's «Одобрить» — waits behind them.
  //
  // Two rules, both bounded by the poll the window already lives with:
  //   (1) while a derive for a project filter is IN FLIGHT, every caller shares that flight;
  //   (2) a settled answer is handed out again for a moment shorter than one poll interval.
  // A rejection settles the flight like a value does — the next caller past the moment asks
  // fresh, so a failing derive cannot pin its failure to the door.
  const DERIVE_SHARE_MS = 2500
  const deriveFlights = new Map() // project key -> { promise, pending, settledAt }
  const sharedDeriveState = (sd) => {
    const key = sd && typeof sd.project === 'string' ? sd.project : ''
    const hit = deriveFlights.get(key)
    if (hit && (hit.pending || clock() - hit.settledAt < DERIVE_SHARE_MS)) return hit.promise
    const flight = { promise: null, pending: true, settledAt: 0 }
    flight.promise = deriveState(sd).finally(() => {
      flight.pending = false
      flight.settledAt = clock()
    })
    deriveFlights.set(key, flight)
    return flight.promise
  }

  // ── ДОРОГОЕ ДОСЫЛАЕТСЯ, А НЕ ЗАДЕРЖИВАЕТ ОТВЕТ ───────────────────────────────────────────
  //
  // Дерайв больше не спрашивает git ни об одной закрытой работе на пути запроса (см.
  // `doneGitFacts`), поэтому холодная дверь отвечает очередью и работниками сразу. Спросить
  // всё-таки надо — иначе история закрытых работ не появится никогда, — и спрашивается это
  // ЗДЕСЬ, после того как ответ уехал человеку, асинхронным бегуном и по четыре за раз.
  //
  // НЕ ЖДЁМ НАМЕРЕННО. Дождаться досылки значило бы вернуть в дверь ровно ту цену, ради
  // ухода от которой всё и делалось; отказ досылки — это отсутствие истории на одной
  // карточке, а не отказ двери, поэтому он проглатывается здесь и не всплывает наружу.
  const deriveStateAndWarm = (sd) => {
    const flight = sharedDeriveState(sd)
    flight.then(() => warmDoneGit({ execGitAsync })).catch(() => {})
    return flight
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
        // СКОЛЬКО МЕСТ ЗАНЯТО ПРЯМО СЕЙЧАС — тот же дом идущих попыток, что и у тика ниже.
        // Дверь состояния спрашивает у него «занято», а не пересчитывает по карточкам
        // работников: карточка говорит про строку в руках, место занимает проход тика, и
        // расходятся эти два счёта ровно тогда, когда потолок ведёт себя не так, как думает
        // человек, — то есть в единственный момент, когда числа и нужны.
        inFlight,
        // ЧТО СТОИТ В ФАЙЛЕ НАСТРОЕК ПРЯМО СЕЙЧАС. Читается на КАЖДЫЙ опрос, а не один раз:
        // весь смысл в том, что человек правит файл при живом демоне, и запомненный ответ
        // повторил бы ровно тот дефект, который здесь и показывается. Чтение fail-open
        // (readJsonSafe), поэтому наполовину записанный файл стоит двери ноль.
        configOnDisk: () => readConfigOnDisk(),
        // WHAT THE DISPATCHER COULD NOT EXPLAIN, for the feedback window's diagnostics —
        // a READER, so the door owns none of the state and cannot add to it.
        unknownDispatchCodes: () => unknownDispatchCodes.codes(),
        ledger, // the attempt ledger AND the decision journal ride the same seam
        ledgerDir,
        // ВТОРАЯ КНИГА ПРИЁМКИ. Человеческое нажатие оставляет квитанцию в колонке решения;
        // терминал, принимающий сам, — в журнале терминалов. Дверь карточки спрашивает
        // колонку первой и эту книгу второй, и потому умеет назвать обоих приёмщиков
        // словом. Шов необязательный: демон без него отвечает про человека ровно так же.
        mergeJournal: readMergeJournal,
        // …and the read model that counts a worker's concluded attempts over the last 30 days
        // out of that same ledger. It is built ONCE here (it holds a TTL cache) and injected,
        // so the derive keeps no static edge onto it and the numbers ride the existing read.
        workerStats,
        repoDir, // the tree being SERVED — reads only
        launchDir, // the process's own start directory — the write-time derive baseline
        // ── WHERE THE BUILT WINDOW IS READ FROM ────────────────────────────────────────
        //
        // A SEAM THAT EXISTED AND WAS REACHABLE FROM NOWHERE. The two handlers that serve
        // the window — the index and the hashed bundles — have read `deps.staticDir ||
        // STATIC_APP_DIR` for as long as they have existed, and the door's own suite has
        // been driving them through it. What was missing is the line below: THIS root, the
        // only one production ever calls, never passed the key, so on every real daemon the
        // seam could not be reached at all. Injectable and unreachable are not the same
        // property, and only the second one is worth anything to anybody.
        //
        // That is the THIRD time this codebase has paid for the same shape in short order —
        // the merge gate's test runner was written, covered, green and wired to nothing;
        // the money rule that switches to the paid channel was called by no one. Each part
        // was fine on its own. None of them was joined to its neighbour. The composition
        // test beside this file exists so that a MACHINE catches the next one, because a
        // reading never has: an absence is exactly what grep cannot see.
        //
        // WHO NEEDS IT. A drill that wants to show the daemon a FRESH build of the window
        // has to build it somewhere, and in a linked working copy the build's own output
        // directory is a link INTO ANOTHER TREE — building there empties the tree the
        // person is working in, while `git status` in the copy stays clean, so the usual
        // check is silent precisely when it is needed. Naming the directory here lets such
        // a drill build OUTSIDE any working tree and hand the result over, touching no link
        // at all.
        //
        // ABSENT MEANS ABSENT. An empty or non-string option adds NO key, so the door falls
        // back to the build that shipped beside it — its own default, decided from its own
        // module url and never from a process's current directory.
        ...(typeof o.staticDir === 'string' && o.staticDir.trim() !== '' ? { staticDir: o.staticDir } : {}),
        // the derive behind /api/state and /api/done — shared-flight wrapped (see above), so
        // overlapping polls of a slow derive collapse into one instead of stacking the loop,
        // and trailed by the git catch-up the answer itself no longer waits for.
        deriveState: deriveStateAndWarm,
        parseReceiptSummary,
        // The phase cycle's two read models. Injected like every other derive, so the door
        // carries no build edge onto state.mjs.
        derivePhaseIndex,
        derivePhaseCard,
        // WHICH TREE THE PHASE CYCLE LIVES IN — the CONNECTED project, not the served one.
        //
        // It used to be repoDir, and the reasoning was sound in the abstract: the tick stands
        // a documentary stage in one root and its gate looks for the document under that same
        // root, so a card reading a different directory would show a stage as never started
        // while the daemon was completing it. One root, one truth.
        //
        // The trouble is which root. On this installation the served tree is the product and
        // the phases live in the workshop beside it, so the screen honestly listed ZERO phases
        // while twelve sat one directory away — a correct answer to a question nobody asked.
        // The founder chose the connected project, and the tick was moved with it in the same
        // change (tickDeps.projectDir below): the two must never disagree, which is why this
        // is one decision expressed in two places rather than two settings.
        //
        // The workbench below has always followed the connected project. Now the whole window
        // speaks about one project — the one the person selected.
        //
        // И ЭТО ЕГО ВТОРОЙ АДРЕС, А НЕ ПЕРВЫЙ. Фазы живут в `.planning`, а `.planning` живёт в
        // ДОМЕ ПЛАНИРОВАНИЯ — том же проекте, но, в двухрепном доме, в другом каталоге. Пока
        // проект знал один адрес, «подключить мастерскую» значило завести её ВТОРЫМ ПРОЕКТОМ:
        // в одном видны задачи, в другом фазы. Второй адрес не задан — выражение отвечает тем
        // же каталогом, что и раньше, буква в букву.
        phaseCycleDir: () => connectedPlanningDir() ?? repoDir,
        // ДЕРЕВО КОДА ТОГО ЖЕ ПРОЕКТА — второй половине окна. Каталоги прогонов, коммиты ветки
        // и её различия живут там, где работает работник, а не там, где лежат фазы; одно
        // выражение на оба вопроса было бы ровно тем самым «читаем одно дерево, пишем другое».
        codeTreeDir: () => connectedProjectDir() ?? repoDir,
        // ── the workbench: three read models and four acts, all over the CONNECTED project ──
        // Unlike the phase cycle above, these follow the project the founder SELECTED, because
        // that is the corpus, the checkout and the backlog the window is already showing him.
        deriveMemoryDrafts,
        // ONE DRAFT, ONE YES. The collaborator takes a draft's NAME and runs the write
        // pipeline's own apply path — per-file confirmation, secret screen, validation and the
        // consumed marker all belong to that path and none of them is re-decided at the door.
        applyMemoryDraft: async ({ draftId }) => {
          const projectDir = connectedProjectDir()
          const relative = `${['.claude', 'memory', 'drafts'].join('/')}/${draftId}.md`
          if (!projectDir) return { applied: false, reason: 'no project is connected' }
          if (!existsSync(join(projectDir, relative))) return { applied: false, missing: true }
          const run = await runProjectVerb({
            verb: 'memory',
            args: ['write', '--apply', relative, '--confirm', `${draftId}.md`, '--yes', '--json'],
            projectDir,
          })
          if (!run.ok) return { applied: false, reason: run.reason ?? 'the apply path did not answer' }
          const r = run.result || {}
          return r.applied === true
            ? { applied: true, targetFile: r.target_path ? basename(String(r.target_path)) : `${draftId}.md` }
            : { applied: false, reason: withoutPaths(r.reason ?? 'refused', projectDir) }
        },
        rebuildMemoryIndex: async () => {
          const projectDir = connectedProjectDir()
          const run = await runProjectVerb({ verb: 'build-index', args: ['--write', '--json'], projectDir })
          if (!run.ok) return { ok: false, reason: run.reason ?? 'the index was not rebuilt' }
          const r = run.result || {}
          return { ok: run.code === 0, bytes: r.bytes ?? 0, areaFiles: r.areaFiles ?? [], ...(run.code === 0 ? {} : { reason: 'the index was not rebuilt' }) }
        },
        readMemoryLint: async () => {
          const projectDir = connectedProjectDir()
          // THE WALK GETS A BUDGET, because the browser has one. In a project that carries a
          // plans tree the linter's prediction checks spawn a git subprocess per fingerprint —
          // hundreds of them on a mature checkout, minutes on Windows — and the panel sat on
          // «Проверяю корпус…» past any patience (QA D2, 11.08.2026). The budget is the verb's
          // OWN honesty mechanism: past it the run stops, exits 2, and NAMES what it did not
          // check — a bounded honest report, never a silent green and never a spinner.
          const run = await runProjectVerb({ verb: 'lint', args: ['--json', '--budget', '20'], projectDir })
          // A corpus WITH critical findings exits 1 and is a perfectly good report: the verdict
          // is the payload, never the exit code.
          return run.ok ? { ok: true, report: run.result } : { ok: false, reason: run.reason ?? 'unavailable' }
        },
        // The coordination snapshot: the ledger's own readers do the reading, the derive does
        // the shaping, and neither of them is in the door.
        deriveCoordination: (args) => deriveCoordination({ ...args, readLedger: readCoordinationLedger }),
        // The backlog board reads the project's own file and NEVER writes it — there is no
        // writing collaborator here at all, which is the strongest form the rule can take.
        deriveBacklog,
        // TAKING A RESERVATION AWAY IS A RISKY OPERATION and the verb says so: it refuses
        // without a written reason AND a stated check, and it journals the steal with the
        // former holder's name. None of that is re-implemented here — which is precisely why
        // none of it can be skipped from a browser.
        clearClaim: async ({ claim, reason }) => {
          const projectDir = connectedProjectDir()
          const run = await runProjectVerb({
            verb: 'force-clear',
            args: [
              claim,
              '--yes',
              '--reason',
              reason,
              // THE CHECK IS ONE THIS SYSTEM ACTUALLY MADE. The panel this button sits on shows
              // the holder and the age of every reservation, read live from the ledger, before
              // anything can be pressed. That is a true statement; a fabricated «I verified the
              // owner is gone» would make the evidence record worse than empty.
              '--checked',
              'holder and age read live from the coordination ledger and shown in the window before the clear',
              '--json',
            ],
            projectDir,
          })
          if (!run.ok) return { cleared: false, reason: run.reason ?? 'the reservation was not cleared' }
          const r = run.result || {}
          return r.cleared === true
            ? { cleared: true, by: r.formerHolder ?? '(unknown)' }
            : { cleared: false, reason: withoutPaths(r.reason ?? 'the runtime refused the clear', projectDir) }
        },
        // the project registry doors — the ONLY way a request reaches a config write
        addProject,
        renameProject,
        selectProject,
        // ВТОРОЙ АДРЕС ПРОЕКТА — той же дорогой и тем же правилом: запрос доходит до записи
        // настроек только через дверь модуля настроек, и эта дверь умеет ровно одно.
        setProjectPlanning,
        // the PEER registry doors — same posture: the introduction wizard reaches the
        // config only through these, and only after a one-shot invitation was consumed.
        addPeer,
        removePeer,
        // The account door — the same posture again: a subscription joins the pool through
        // the config module's own applier, DISABLED, and its token never crosses this line.
        addAccount,
        // The three switches a person holds. `applyBudgetStop` is wired ONLY here and reached
        // ONLY from the door: how much of the founder's money the machine may spend is not a
        // decision any worker, workflow or verb gets a path to.
        applyPipelineToggle,
        applyBudgetStop,
        // THE TELEGRAM LINK, FROM THE WINDOW. Two appliers and one restart, wired exactly
        // like every other config write: the door owns the shape of the request, the applier
        // owns the file, and `telegramRestart` is what makes the loop match the config it was
        // just given — the bot a person connects starts listening without a restart. The
        // THIRD applier — the one that writes the paired chat — is deliberately NOT here: it
        // is wired to the loop and to nothing else, so no request can name a chat id.
        applyTelegramConnect,
        applyTelegramDisconnect,
        // ЛЕНИВО, И ЭТО НЕ УКРАШЕНИЕ. Мост строится ПОСЛЕ фронта — его единственная
        // способность есть сборка хода этой самой двери, — поэтому здесь берётся обёртка,
        // а не сама перестройка: прямая ссылка вычислилась бы в момент сборки этого объекта,
        // когда `telegramRestart` ещё не существует, и демон падал бы на старте вместо того,
        // чтобы работать. Вызов происходит из двери, то есть заведомо позже.
        telegramRestart: () => telegramRestart(),
        federation, // the action-proxy engine + the pairing book
        aggregator,
        // the «Разговор» engine — INJECTED, because its free branch spawns a child: a
        // capability like that reaches a request path only through deliberate wiring.
        handleChatTurn,
        readChatHistory: readHistory,
        // СПИСОК РАЗГОВОРОВ и имя, данное рукой: книга та же, читается она по-другому —
        // сгруппированной по нити, а не одной сплошной лентой (слово владельца 31.08).
        listChatConversations: listConversations,
        renameChatConversation: renameConversation,
        // Какие беседы ЗАНЯТЫ прямо сейчас — живая точка списка. Реестр, а не запись: он
        // общий для окна и для моста телеграма и обязан обнуляться перезапуском демона.
        chatLive: createLiveConversations(),
        // the Стоп button's registry: live chat-turn kill-handles, minted per client turn id.
        // Hint plumbing (a restart loses only the ability to stop turns that died with it).
        chatTurns: createTurnRegistry(),
        // the steering registry the redirect door shares with the tick (declared above).
        attemptTurns,
        chatDir: o.chatDir ?? dataDir, // the transcript lives beside the daemon's own data
        dataDir, // the spend book the «что съело лимит» branch reads
        policyDir: o.policyDir ?? dataDir, // where the style distillation puts the distilled voice
        windows: windowsForState,
        // The person's own terminal reports its subscription windows to its status line, and
        // that reading — unlike anything on the work stream — carries the percentage AND counts
        // the sessions he ran himself. The status line lays it down in the same window store;
        // this is the read side.
        terminalWindows: () => terminalWindowState({ clock, dataDir }),
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
        // Injected, never statically imported by the front — this is the
        // wiring that makes «включить агента» a real switch instead of a 501.
        // The harness read model + the three appliers (agents / skills / MCP screens).
        // ── THE RELEASE: the gate, its record, the version, and the publication ──
        // Four narrow collaborators, each taking DATA and each with its verbs baked in here.
        // They are wired into the FRONT and nowhere else: `tickDeps` below names none of them,
        // which is what makes «a worker cannot publish» a property of the assembly rather than
        // a rule somebody has to keep.
        runShipGate: o.runShipGate ?? ((args) => runShipGate({ ...args, projectDir: connectedProjectDir(), clock })),
        verifyGateReceipt: o.verifyGateReceipt ?? ((receipt) => verifyGateReceipt(receipt)),
        // The version this machine states it is about to publish — the SAME single source the
        // diagnostics door reads, so the string a person is asked to type is the string the
        // product answers with everywhere else. The connected project's own stamp wins; a
        // daemon serving a tree that carries none falls back to its own.
        releaseVersion:
          o.releaseVersion ??
          (() => {
            const projectDir = connectedProjectDir()
            const own = join(projectDir ?? '.', 'sma-core', 'capabilities', 'sma', 'capability.json')
            return collectDiagnostics(projectDir && existsSync(own) ? { capabilityPath: own } : {}).version
          }),
        publishRelease:
          o.publishRelease ?? ((args) => publishRelease({ ...args, projectDir: connectedProjectDir(), clock })),
        // ONE QUESTION, FIVE CORPORA. The projection is injected like every other read model;
        // what is composed HERE is which reader answers for which corpus, and each of them is
        // the reader that corpus already has. Nothing below tokenizes, parses or indexes
        // anything itself — the one source with real retrieval (the memory axis) is consumed
        // through its own layer, and the other four are asked the question they can answer.
        search: o.search ??
          createSearch({
            listTasks: async () => (typeof adapter.list === 'function' ? await adapter.list({}) : []),
            queryNotes: (query, limit) => readProjectNotes({ projectDir: connectedProjectDir(), query, limit }),
            readRegistries: async () => {
              // Names and descriptions, and nothing that is a VALUE: a lane is a name, a
              // helper's «can» is a description of what it does. A model id, an account, a
              // budget number and an environment block all live one field away and none of
              // them is read — a search box is the widest surface in the window, and the
              // cheapest way for it to never disclose a setting is to never look at one.
              const rules = (deriveRules(config).lanes || []).map((l) => ({
                id: String(l.lane ?? ''),
                title: `Полоса «${l.lane ?? '—'}»`,
                description: `работают: ${(l.workers || []).join(', ') || '—'}`,
              }))
              let agents = []
              try {
                const harness = await readHarness({ config, registry: loadMcpRegistry({}), repoDir })
                agents = [
                  ...(harness.agents || []).map((a) => ({
                    id: a.id,
                    title: a.title,
                    description: (a.can || []).join(' · '),
                  })),
                  ...(harness.stockTeam || []).map((a) => ({ id: a.id, title: a.title ?? a.id, description: a.description })),
                ]
              } catch {
                /* an unreadable registry is an absent source, never an empty search */
              }
              return { rules, agents }
            },
            listAttempts: async () => {
              const rows = typeof adapter.list === 'function' ? await adapter.list({}) : []
              return (Array.isArray(rows) ? rows : [])
                .filter((r) => r && Number.isFinite(Number(r.attempt)) && Number(r.attempt) >= 1)
                .map((r) => ({ attemptId: attemptIdFor(r.id, r.attempt), taskId: r.id, title: r.title }))
            },
            statusLabel: (s) => String(s ?? ''),
          }),
        // Injected, never statically imported by the front — this is the
        // wiring that makes «включить агента» a real switch instead of a 501.
        readHarness,
        loadMcpRegistry: o.loadMcpRegistry ?? (() => loadMcpRegistry({})),
        applyAgentToggle,
        applySkillAssign,
        // Написать навык из окна. Пишет ТОЛЬКО в машинное хранилище — тем и отличается от
        // раздачи, которая читает оба: навык, положенный в служимое дерево, был бы навыком
        // одного проекта и чужим файлом в чужом репозитории.
        createMachineSkill,
        applyMcpToggle,
        // The one act that switches the whole shipped SMA team on — it rides the agent
        // toggle door under a reserved target, so the route table stayed at thirty.
        applyStockTeamToggle,
        // Which model this agent runs — the one part of a worker's session that does not come
        // from the project checkout, and therefore the one worth a door of its own.
        applyAgentModel,
        // The connected project's corpus: read on every poll, previewed only when the corpus
        // is still in the older format, and applied ONE file at a time behind the approve
        // door. The applier is a CLOSURE over «which project» and «where the staging lives»
        // so a request handler never gets to name either.
        readProjectMemory,
        previewProjectMigration,
        projectLiveness,
        migrationStagingDir,
        // A project switch moves the tree the watcher is on. Without this the watcher stayed
        // bound to whatever was connected at boot, and the only recovery was a restart.
        // The switch is also the moment the previous project's staged
        // previews become residue, so the retention sweep runs here too.
        onProjectSelected: () => {
          retargetProjectWatch()
          pruneMigrationStaging({ stagingDir: migrationStagingDir })
        },
        applyProjectMigration: ({ file }) => ({
          ...applyProjectMigration({ projectDir: connectedProjectDir(), stagingDir: migrationStagingDir, file }),
          projectId: connectedProjectId(),
        }),
        // The smoke the ritual runs on the merged-but-uncommitted tree, VISIBLE here rather
        // than buried inside the closure below: a collaborator nobody outside the closure can
        // see is a collaborator no test can ask a question of, and «is it a function» is the
        // only question you may ask a closure. This one can be CALLED by a test — and answers
        // in the runner's own words.
        mergeTestRunner,
        // approve runs the EXISTING serialized merge verb LOCALLY — never a push.
        verbRunner: (m) => runMerge({ ...m, execGit, runTests: mergeTestRunner }),
        // «Дом системы»: the updater behind POST /api/update/run. A SEPARATE name from
        // `verbRunner` above on purpose — one door's collaborator is not the other's, and a
        // shared generic runner would be a request path that can name a command.
        updateRunner: o.updateRunner ?? (({ apply } = {}) => runUpdateVerb({ apply, projectDir: repoDir })),
        // Accepted work takes its copy and its branch with it. A THIRD separate name for the
        // same reason as the two above — the door names a task, never a command.
        worktreeCleanup: o.worktreeCleanup ?? worktreeCleanup,
        // Приёмка — момент, когда урок и записка ещё существуют и уже приняты. Стоит ВЫШЕ
        // уборки в самой двери; здесь важно лишь то, что зависимость вообще есть.
        memoryHarvest: o.memoryHarvest ?? memoryHarvest,
      },
    })

  // (5a) THE TELEGRAM LINK — a NULL on every daemon that was not asked for one. The factory
  // itself refuses a config with no `telegram.botToken`, so this line constructs nothing, arms
  // no timer and makes no request unless the owner connected a bot: a daemon without one runs
  // byte-for-byte the way it ran before the bridge existed. The decision lives in the factory
  // rather than in a condition here for the usual reason — a predicate written twice is a
  // predicate that will one day disagree with itself.
  //
  // IT STANDS AFTER THE FRONT ON PURPOSE, and this is the whole of the wiring: the bridge's
  // one capability is the front door's OWN turn assembly, called with the front's OWN
  // collaborator set (`front.deps`, echoed back by the factory for exactly this kind of use).
  // Not a copy of that set — the same object — so the board snapshot, the transcript directory
  // and the free branch the phone reaches are the ones the window reaches, and «мозг
  // идентичный» is a property of the assembly instead of a rule somebody has to keep. Building
  // a second dependency set here is precisely how a bot starts answering «одобрять нечего» to
  // a task that is standing in front of the founder awaiting his decision.
  // ─ AND IT IS REBUILT WHEN THE OWNER CONNECTS ONE FROM THE WINDOW ─────────────────────
  // The token now arrives at a RUNNING daemon: a person types it on the «Подключения»
  // screen, the door writes it into the config, and the loop that has to receive the pairing
  // code did not exist a second ago. Without the rebuild below, connecting a bot would work
  // and then wait for a restart nobody knows to perform — the code would go into a chat no
  // process was listening to. So the bridge is held in a variable, and `telegramRestart`
  // stops the old one and constructs a new one from the config as it is NOW; the factory
  // still owns the decision, so a disconnect (no token) rebuilds to null and the loop stops.
  let telegram = null
  let telegramRunning = false
  const telegramLog = (line) => console.log(`[SmaDaemon] ${line}`)
  const buildTelegram = () =>
    createTelegramBridge({
      config,
      // THE ONE CAPABILITY, and it is the front's own turn assembly (see above): rebuilding
      // the bridge must never rebuild this wiring differently, or a reconnected bot would
      // quietly start answering from a second brain.
      chatTurn: ({ text, conversationId }) =>
        runChatTurn({ config, deps: front.deps ?? {}, text, conversationId }),
      log: telegramLog,
      // WHO WRITES THE PAIR DOWN. The loop learns a chat id and hands it here; this is the
      // only path from a Telegram message to the config file, and it goes through the same
      // applier the door uses. The in-process config is refreshed in the same breath (the
      // one-config rule the front's appliers obey — a write nobody sees is a write that
      // did not happen as far as the next request is concerned).
      onPaired: ({ chatId, chatTitle }) => {
        const next = applyTelegramPair(config, { chatId, chatTitle }, { launchDir })
        if (next && next.telegram) config.telegram = next.telegram
        return true
      },
      now: clock,
    })
  const telegramRestart = () => {
    if (telegram) {
      try {
        telegram.stop()
      } catch {
        /* a link that refuses to stop never blocks the next one */
      }
    }
    telegram = o.telegram ?? buildTelegram()
    if (telegramRunning && telegram) void telegram.start()
    return telegram
  }
  telegram = o.telegram ?? buildTelegram()

  /**
   * The object the tick reads its secondary intake through. Built here rather than inline in
   * `tickDeps` because it CARRIES the cadence: `lastScanAt` is the only state the tick is
   * allowed to read back, and it has to survive between passes on the same object.
   *
   * The git runner is bound to the project the window is connected to — the same expression
   * `projectDir` uses below. Unbound, the scanner's `git fetch` would run wherever the daemon
   * process happens to stand, which is not the tree whose backlog it is about to read.
   */
  const createBacklogIntake = () => {
    // ИЗ ДОМА ПЛАНИРОВАНИЯ. `BACKLOG.md` лежит в `.planning`, и сканер, читавший дерево кода,
    // на двухрепном доме молчал совершенно честно: файла по этому адресу нет. Второй адрес не
    // задан — тот же каталог, что и раньше.
    const backlogRoot = () => connectedPlanningDir() ?? config.repoDir
    const intake = {
      lastScanAt: 0,
      async scan() {
        try {
          return await scanBacklog({
            repoDir: backlogRoot(),
            execGit: (args, opts = {}) => execGit(args, { cwd: opts.cwd ?? backlogRoot() }),
            clock,
            fsImpl: o.fsImpl ?? { readFileSync },
            // ЧЕЙ ЭТО BACKLOG.md, СКАН ЗНАЕТ — и это единственный момент, когда владелец строки
            // ещё известен. Без штампа строка рождается бесхозной, и сито проекта на экране
            // «Сегодня» прячет готовую работу, которая по нему не проходит.
            project: connectedProjectId() ?? undefined,
          })
        } finally {
          // stamped even when the scan threw: an attempt is an attempt, and only stamping
          // successes turns a broken scan into a git fetch every five seconds.
          intake.lastScanAt = clock()
        }
      },
    }
    return intake
  }

  // (6) the stateless tick — same wrapped adapter, so its transitions emit too.
  const tickDeps = {
    clock,
    adapter,
    config,
    ledger,
    attemptTurns,
    routing: { resolveRoute },
    // THE MONEY RULE, JOINED TO THE DISPATCHER. `shouldApiFallback` was written, tested and
    // called by nobody: an explicit `provider:'api'` task ran with no ceiling, and the
    // automatic switch three screens describe («все окна закрыты — продолжаем по платному
    // каналу») never happened. Bound here, where the cap, the rate and the spend book all
    // live; the dispatcher only asks.
    // `accountNames` is the SAME account set «Расходы» sums — the stop and the screen must
    // never be able to answer «сколько уже потрачено» differently.
    budget: ({ task, allClosed }) =>
      shouldApiFallback({
        task,
        windows: allClosed,
        budget: config.budget ?? {},
        usageReader,
        accountNames: spendAccountNames(config),
        clock,
      }),
    windows: windowsOpenFor,
    spawnWorker,
    // THE OTHER HALF OF THE EXECUTOR. spawnWorker has been wired since the fleet shipped;
    // buildArgs had no implementation to wire, so `executorBlocker` refused every task with
    // «задачу некому запустить» — truthfully, on every tick. Both halves are present now, and
    // the closure is what lets the tick keep its three-argument call: a route names a worker
    // by id, and the account behind that id lives in config, which never travels through the tick.
    // `fsImpl` is the seam the parity guard reads through: the builder has to look at the
    // account's own settings file to see the two halves of a session no argument array can
    // show — the enabled plugins and the hosted-connectors switch.
    buildArgs: o.buildArgs ?? createBuildArgs({ config, env: o.env ?? process.env, fsImpl: o.fsImpl }),
    // THE FOUNDER’S OWN LAYER, PUT INTO THE WORKER’S ACCOUNT BEFORE EVERY SPAWN. The source
    // is the home of the OS user this daemon runs as — that is where his instructions, his
    // hooks and his narrowing permissions actually live — unless the config names another.
    // Unwired, the mirror is a module nobody calls: the account keeps whatever it happened
    // to hold, and since the parity guard refuses a spawn whose account was never mirrored,
    // an unwired root would refuse every task by name instead of running one.
    mirrorPersonalLayer:
      o.mirrorPersonalLayer ??
      ((args) =>
        mirrorPersonalLayer({
          sourceDir: (config.personalLayer && config.personalLayer.sourceDir) || join(homedir(), '.claude'),
          ...args,
        })),
    // WHICH SERVERS A WORKER MAY BE GIVEN. The same registry the window’s switches write,
    // read once per spawn so a server enabled a minute ago reaches the very next attempt.
    loadMcpRegistry: o.loadMcpRegistry ?? (() => loadMcpRegistry({})),
    // WHERE THE PER-SPAWN MCP CONFIG IS WRITTEN. Named for the tick in its own right rather
    // than reached through the config block: the file is an artefact of a SPAWN, and an
    // install that keeps its spawn scratch elsewhere may say so without moving the data dir.
    dataDir,
    // ЗАПАСНОЕ ДЕРЕВО КОДА — для строки, которая не назвала своего проекта. Штампованная
    // строка отвечает на этот вопрос сама (loop.mjs, taskTreeDir), и это выражение до неё не
    // доходит.
    projectDir: o.tickProjectDir ?? (() => connectedProjectDir() ?? config.repoDir),
    // ЗАПАСНОЙ ДОМ ПЛАНИРОВАНИЯ — тем же правилом, для документарной ступени без штампа. Тот
    // же ответ, что даёт окну phaseCycleDir выше, и НАМЕРЕННО то же выражение: карточка,
    // читающая один каталог, пока ступень пишет в другой, показывает работу неначатой ровно в
    // тот момент, когда её завершают.
    planningDir: o.tickPlanningDir ?? (() => connectedPlanningDir() ?? config.repoDir),
    // WHAT AN ATTEMPT COST, into the same book the «Расходы» screen reads. The parser and the
    // writer both lived in runner/usage.mjs and only the chat door called them, so every task
    // the tick ran booked nothing and the screen answered zero. Same family as buildArgs above:
    // built, tested, and never joined to the thing that needed it.
    bookUsage: o.bookUsage ?? ((event) => bookUsage({ dataDir, event, clock })),
    verbRunner: o.verbRunner ?? cliVerbRunner,
    // THE COPIES OF EVERY CLOSED TASK THE APPROVAL DOOR DOES NOT COVER. It keeps its own
    // once-a-day clock, so the tick may ask on every pass and pay one comparison for it.
    sweepWorktrees: o.sweepWorktrees ?? ((a) => worktreeSweeper.run(a)),
    // GIT, FOR THE THREE EXIT GATES THAT ASK IT WHETHER THE WORK IS REALLY ON THE BRANCH.
    // Same family as buildArgs and bookUsage above, and the most expensive member of it: the
    // runner was built here and handed to the front and to the merge verb, and simply never to
    // the tick. Every gate that asks git therefore answered «no» in production — a documentary
    // stage whose document WAS committed failed with «есть на диске, но не закоммичен»; a
    // checkpoint with open questions failed instead of parking for a person; an attempt that
    // correctly changed no code fell through to «нет квитанции», the exact red row the
    // answer-only gate exists to remove. The suite never saw it: every test of those gates
    // injects its own git runner, so the seam was green and the product was dead.
    execGit,
    // «ВКЛЮЧЁН» MADE REAL IN THE SESSION. Without this the roster's agent switch changed a
    // config file and nothing else: no role preamble, no skills list — and because the loop
    // writes the journal's MEMORY layer inside the same branch, no record of what the worker
    // was given to remember. The switch answered 200 and meant nothing.
    resolveWorkerContext: o.resolveWorkerContext ?? resolveWorkerContext,
    // REPORT-BACK. OFF BY DEFAULT and it stays off: reportTaskEvent returns immediately unless
    // `webhookUrl` is a real http(s) address, which the shipped config leaves empty. Wiring it
    // is what makes that knob mean anything — until now setting it produced no webhook ever.
    report: o.report ?? ((event) => reportTaskEvent({ config, event, clock, journal: o.journal })),
    // The daemon's own event log. It is wired UNCONDITIONALLY: an unwired sink is how a
    // refused task became a silence — every reason the tick names has to reach a log.
    journal: daemonJournal,
    // ПАМЯТЬ ДЕДУПА СТАРЕНИЯ — построена ЗДЕСЬ, один раз, рядом с deps, и живёт столько же,
    // сколько демон. Без этой строки дедуп был бы «вычислен, но не подключён»: функция есть,
    // тесты зелёные, а в жизни сигнал по-прежнему кричит каждые пять секунд.
    agingMemory: o.agingMemory ?? createAgingMemory(),
    // ЗОВ ЧЕЛОВЕКА В ТЕЛЕГРАМ — построен ЗДЕСЬ, один раз, рядом с памятью старения и по той же
    // причине: тик обязан оставаться без состояния, а «одно ожидание — одно сообщение» без
    // памяти между проходами не бывает. Ей передаётся ЖИВОЙ конфиг: бота подключают из окна на
    // ходу, и зов обязан увидеть подключение без перезапуска — тот же приём, что у моста.
    // Бот не подключён — объект собран и молчит, ровно как молчал продукт до него.
    summon: o.summon ?? createSummons({ config, now: clock, log: (line) => console.log(`[SmaDaemon] ${line}`) }),
    // «Can this worker start at all?» — asked BEFORE the attempt, so a placeholder account
    // produces a named, recorded refusal instead of three silent burnt attempts.
    workerReady: o.workerReady ?? ((worker) => workerReadiness(worker, { fsImpl: o.fsImpl })),
    // the DECISION journal sink (three layers per attempt) — distinct from `journal`,
    // which is the daemon's own event log
    decisionJournal:
      o.decisionJournal ?? ((entry) => (typeof ledger.appendJournal === 'function' ? ledger.appendJournal(entry) : undefined)),
    // …and its counterpart: told when the decision journal could NOT take a code, so the
    // silent drop stops being invisible. Same register the feedback window reads.
    unknownReasonSink: o.unknownReasonSink ?? ((code) => unknownDispatchCodes.record(code)),
    // THE SECONDARY INTAKE, JOINED TO THE TICK. `runIntake` asks for this object on its FIRST
    // line and returns when it is absent — so the scanner was written, ported faithfully from
    // the origin parser, covered by tests and asked for on every pass, while the root never
    // built it. `backlogScanMinutes` was therefore a setting that changed nothing, and a ready
    // backlog line never became a task. Same family as buildArgs, execGit and bookUsage above.
    //
    // THE CADENCE LIVES ON THIS OBJECT, not in the tick: the tick reads `lastScanAt` and stays
    // stateless. The scan stamps itself IN A FINALLY, so a scan that threw still counts as an
    // attempt — recording only successes would let a broken scan fetch git every five seconds.
    //
    // The DoR gate inside the scanner is what keeps this safe to switch on: an open line is
    // enqueued only when it carries an estimate within the ceiling, and everything else is
    // surfaced as not-ready rather than pulled into the queue.
    intake: o.intake ?? createBacklogIntake(),
    // КТО СЕЙЧАС РАБОТАЕТ — тот же самый дом, что отдан двери состояния выше (построен один
    // раз, рядом с хабом). Тик обязан оставаться без состояния, а счёт идущих попыток обязан
    // пережить проход. Без этой строки потолок был бы «вычислен, но не подключён»: тик
    // спрашивал бы о занятости объект, которого нет, и считал бы место свободным на каждом
    // проходе — то есть ровно то, что и было 12.08.2026, когда три процесса шли одновременно
    // при пустой доске.
    inFlight,
    // ЧЕМ ТИК ЗВОНИТ В ЖИВОЙ ПОТОК. Тот же хаб, что и у двери событий, — переданный, а не
    // взятый: тик не знает ни про SSE, ни про клиентов, он только называет случившееся. Пока
    // шва не было, отказ в месте оставался в журнале демона, и снаружи «потолок держит» было
    // неотличимо от «конвейер сломался».
    emitEvent: o.emitEvent ?? ((frame) => hub.emit(frame)),
  }
  const daemon = runDaemon({ tickMs: config.tickMs ?? 5000, onTick: () => tick(tickDeps) })

  return {
    config,
    hub,
    adapter,
    federation,
    // NULL unless a bot is connected — returned so the suite can assert the ABSENCE of the
    // loop on a daemon nobody asked to have one, which is the only way to check an absence.
    //
    // A GETTER, because the link is no longer decided once at boot: connecting a bot from the
    // window rebuilds it, and a value copied onto this object at construction would keep
    // answering with the loop that used to be there — the exact «write nobody sees» defect the
    // in-process config refresh exists to prevent, one level up.
    get telegram() {
      return telegram
    },
    front,
    daemon,
    // WHAT THE ROOT ACTUALLY WIRED, returned so it can be asserted rather than assumed. This
    // exists because half the executor was missing for an entire release line: spawnWorker was
    // wired, buildArgs was not, and every task was refused with «задачу некому запустить» —
    // truthfully, and invisibly to a suite that injected its own fake into every loop test.
    // A wiring gap is not findable by testing the parts; it is findable only by asking the
    // root what it built. Nothing secret is added — `config` is already on this object.
    tickDeps,
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
      // THE RECORD IS WRITTEN WHEN THE DOOR IS BOUND, not before: it is a claim about the
      // address, and a claim made a second earlier would be a claim about a port this
      // process may still fail to take. `sma daemon stop` reads it to name THIS process —
      // the alternative is hunting the process table for a binary called `node`, which is
      // how a stop command kills somebody else's work (daemon/src/control.mjs).
      //
      // ─ И ДВЕРЬ ОТКРЫВАЕТСЯ ДО УБОРКИ, А НЕ ПОСЛЕ НЕЁ ────────────────────────────────
      // ЗАМЕР 31.08: после подъёма дверь честно молчит ~45 секунд (29.08 наблюдалось до ~2
      // минут), и молчала она ровно потому, что стояла ЗА стартовым обходом копий. Обход не
      // держит поток — он спрашивает верб проекта отдельным процессом на каждое дерево, — но
      // держал ОЧЕРЕДЬ ЗАГРУЗКИ: пока он шёл, порт не был занят, записи о процессе не
      // существовало, и снаружи поднимающийся демон был неотличим от мёртвого. Сторож на такое
      // молчание отвечает подъёмом ВТОРОГО демона поверх первого, и они дерутся за один адрес.
      // Уборке не нужно, чтобы дверь была закрыта; двери нужно, чтобы её было слышно. Тик
      // по-прежнему стартует ПОСЛЕ обхода — вот его уборка касается напрямую.
      front.listen(() => {
        try {
          writePidRecord({ config })
        } catch (err) {
          // Fail-soft, and loud: a daemon that could not leave its calling card still serves.
          // Only the штатная остановка is lost, and the operator is told which.
          console.error(
            `[SmaDaemon] не смог записать ${PID_RECORD_FILE}: ${String((err && err.message) || err)} — штатная остановка не сможет назвать этот процесс.`,
          )
        }
      })
      // The connected project is watched while the daemon runs. It is started AFTER the
      // queue and BEFORE the front only for tidiness — it owns nothing the others need, and
      // a project that cannot be watched degrades inside watchProject rather than here.
      // Staged previews are complete v2 renderings of a FOREIGN project's notes. Nothing used
      // to delete one; the sweep runs at boot and on every project switch.
      pruneMigrationStaging({ stagingDir: migrationStagingDir })
      // The same kind of residue, one size up: the working copies of tasks closed long ago.
      // FORCED here on purpose — the sweeper's once-a-day mark lives in process memory, so a
      // daemon that is restarted daily would otherwise never reach its own interval and the
      // copies would accumulate exactly as they did before the sweep existed.
      try {
        await worktreeSweeper.run({ force: true })
      } catch (err) {
        console.error(`[SmaDaemon] worktree sweep at boot failed: ${maskSecrets(String((err && err.message) || err))}`)
      }
      retargetProjectWatch()
      daemon.start()
      // ── ЕСЛИ ЭТО ВОЗВРАЩЕНИЕ, А НЕ ПРОСТО ЗАПУСК, ЧЕЛОВЕК УЗНАЕТ ОБ ЭТОМ ОТ МЕНЯ ───────
      //
      // Сторож (supervisor/daemon-watch.mjs) оставляет запись о провале, когда дверь
      // замолкает: он же говорит о падении, потому что сказать больше некому. А «поднялся»
      // говорит ТОТ, КТО ПОДНЯЛСЯ, — этот процесс, и только после того, как его собственная
      // дверь ответила на настоящий запрос. Сторож знает лишь то, что он запустил подъём;
      // между запуском и живой дверью стоит весь этот boot, который умеет падать, и обещание
      // в его журнале ничего не стоит.
      //
      // Не ждём: разбор внутри сам себе кладёт срок, глотает каждый отказ и закрывает провал
      // квитанцией со временами. Провала не было — не делает ничего: обычный запуск не
      // событие, и будить им человека каждый перезапуск было бы худшим видом шума.
      void announceRecovery({ config, log: (line) => console.log(line) }).catch(() => {})
      // The link, when there is one. Not awaited: its promise is the loop's whole life, and
      // the loop swallows every refusal of its own, so nothing here can be left unhandled.
      // The flag is what a bot connected LATER inherits: `telegramRestart` starts the loop it
      // builds only for a daemon that is itself running.
      telegramRunning = true
      if (telegram) void telegram.start()
      // SAY IT OUT LOUD. The conveyor ships off, so a daemon that starts and then does
      // nothing is the NORMAL state — and it is indistinguishable from a broken one unless
      // the boot says which. One line, naming the state and the way out of it.
      console.log(
        pipelineEnabled(config)
          ? '[SmaDaemon] конвейер ВКЛЮЧЁН — задачи будут разбираться по мере появления.'
          : '[SmaDaemon] конвейер ВЫКЛЮЧЕН — ничего не запускается само. Включить: тумблер в окне (POST /api/pipeline/toggle {"enabled":true}).',
      )
    },
    async stop() {
      // The card goes first: from here on this process is no longer the owner of the door,
      // and a record that outlives the process it names is exactly the claim this module
      // refuses to act on.
      clearPidRecord({ config })
      stopWatch(projectWatch)
      projectWatch = null
      telegramRunning = false
      if (telegram) telegram.stop()
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

/**
 * tickJournalLine(entry, clock) → the daemon's own journal line, WITH THE TIME ON IT.
 *
 * ONE FILE HELD TWO FORMATS: the supervisor's lines carried a timestamp and ours did not, so
 * in a journal 43 000 lines long there was no way to say WHEN any of our lines happened —
 * neither how long a task had been shouting nor whether a line was from this hour or the
 * previous day. The format now lives in one exported function so a test can assert the line
 * itself rather than a formatter that nobody may be calling.
 */
export function tickJournalLine(entry, clock) {
  const now = typeof clock === 'function' ? clock() : Date.now()
  return `[SmaDaemon] ${new Date(now).toISOString()} ${describeTickEvent(entry)}`
}

/**
 * ═══════════ THE REGISTER OF CODES NOBODY COULD SIGN ═══════════
 *
 * The router explains every decision with a code from a CLOSED vocabulary, and the journal
 * drops any code that vocabulary does not carry. That drop is silent on purpose — a
 * dispatcher that dies of a typo is worse than one that cannot explain itself — and the
 * silence cost an entire class of defect its visibility: the one decision that spends real
 * money went unrecorded for as long as it existed, and the card politely reported that the
 * route had never been decided.
 *
 * So the drop is COUNTED. Not fixed, not thrown, not retried: counted, and shown to whoever
 * opens the feedback window. Bounded twice over, because this is memory a running daemon
 * holds and a value a public issue may quote: at most CODES_CAP distinct codes, each cut to
 * CODE_CAP characters. The total keeps counting past the cap — losing the twenty-first NAME
 * is acceptable, losing the knowledge that it happened is not.
 *
 * ONE OPERATOR LINE PER NEW CODE, never per occurrence: a code written in a hot loop would
 * otherwise turn a log into a wall, and the second sighting teaches nobody anything the
 * first did not.
 */
export const UNKNOWN_DISPATCH_CODES_CAP = 20
export const UNKNOWN_DISPATCH_CODE_CAP = 64

export function createUnknownDispatchRegistry({ journal, clock = Date.now } = {}) {
  let total = 0
  const seen = new Map()

  return {
    /** Told by the router. Never throws — it is a counter, and a counter owes nobody a stack. */
    record(rawCode) {
      const code = String(rawCode ?? '').slice(0, UNKNOWN_DISPATCH_CODE_CAP)
      if (code === '') return
      total += 1
      const now = typeof clock === 'function' ? clock() : Date.now()
      const known = seen.get(code)
      if (known) {
        known.lastAt = now
        known.count += 1
        return
      }
      // The cap bites on NAMES only: `total` above already counted this sighting.
      if (seen.size >= UNKNOWN_DISPATCH_CODES_CAP) return
      seen.set(code, { code, firstAt: now, lastAt: now, count: 1 })
      try {
        if (typeof journal === 'function') journal({ type: 'dispatch.unknown_reason', reason: code })
      } catch {
        /* a log that refuses does not get to stop the counting */
      }
    },
    /** The names, for the diagnostic. Copied out, so a reader can never edit the register. */
    codes() {
      return [...seen.keys()]
    },
    /** The whole picture, for a test and for whatever later screen wants the counts. */
    read() {
      return { total, codes: [...seen.values()].map((e) => ({ ...e })) }
    },
  }
}

/** One tick-journal entry as ONE operator line: ids + reasons, never a task payload. */
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
  // ── A DEATH GETS ITS NAME. ────────────────────────────────────────────────────────────────
  //
  // The boot .catch below covers the START; after start() resolved this process used to have
  // no error net at all. Measured 27.08.2026: Postgres went down under a running daemon, an
  // event nobody listened for became an uncaught throw, and the last words in the log were a
  // raw object dump with no line saying WHO died or WHY — the diagnosis took an outside
  // autopsy. These two nets do not try to survive (a process in an unknown state serving a
  // queue would be worse than a dead one the supervisor can restart): they say the daemon's
  // own name, the reason, and then die honestly with exit 1.
  process.on('uncaughtException', (err) => {
    console.error(`[SmaDaemon] СМЕРТЬ: uncaughtException — ${(err && err.stack) || err}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    console.error(`[SmaDaemon] СМЕРТЬ: unhandledRejection — ${(err && err.stack) || err}`)
    process.exit(1)
  })
  const park = createDaemon()
  park
    .start()
    .then(() => {
      // succeed loud too: a silent boot reads as a hang from the operator's chair — but
      // «green» is a CLAIM, and it is only made when the pool can actually run a task.
      // «Armed at <address>» was the whole of what a boot said about the window, and it was
      // an address nobody could enter by: a bare visit answers 401 by design, and the one
      // exchange that opens it was documented nowhere the boot could be read. It also
      // printed the BIND verbatim, so a daemon listening on 0.0.0.0 announced a link no
      // browser will dial. Both halves are fixed in one place (lib/window.mjs), which is
      // also where the rule about what may be written into a LOG lives — the token goes to
      // a person's own console and never into a log file.
      const where = windowAddress(park.config)
      const entry = entryLines({ ...park.config, isTty: process.stdout.isTTY === true })
      const sayEntry = () => {
        for (const line of entry) console.log(`[SmaDaemon] ${line}`)
      }
      const pool = poolReadiness(park.config)
      if (pool.total > 0 && pool.blocked.length === 0) {
        console.log(
          `[SmaDaemon] All systems green: queue up, front armed at ${where}, loop ticking. Buckle up, soldier — the park is live.`
        )
        sayEntry()
        return
      }
      console.log(`[SmaDaemon] Queue up, front armed at ${where}, loop ticking.`)
      sayEntry()
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
