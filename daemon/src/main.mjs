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
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadConfig,
  addProject,
  renameProject,
  selectProject,
  addPeer,
  removePeer,
  addAccount,
  applyPipelineToggle,
  applyBudgetStop,
  pipelineEnabled,
} from './config.mjs'
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
import { attemptIdFor } from './front/journal.mjs'
import { collectDiagnostics } from './front/diagnostics.mjs'
import { createSearch } from './front/search.mjs'
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
  applyAgentModel,
  resolveWorkerContext,
} from './front/harness.mjs'
import { reportTaskEvent } from './report.mjs'
import {
  applyProjectMigration,
  previewProjectMigration,
  pruneMigrationStaging,
  readProjectMemory,
  stopWatch,
  watchProject,
} from './front/project-sync.mjs'
import { tick, runDaemon, parseVerbResult } from './loop.mjs'
import { createFrontServer } from './front/server.mjs'
import {
  deriveState,
  parseReceiptSummary,
  derivePhaseIndex,
  derivePhaseCard,
  deriveMemoryDrafts,
  deriveCoordination,
  deriveBacklog,
  deriveRules,
} from './front/state.mjs'
import { resolveRoute } from './policy/routing.mjs'
import { windowState, isOpen } from './policy/windows.mjs'
import { readUsage, usageSeries, bookUsage } from './runner/usage.mjs'
import { spawnWorker } from './runner/spawn.mjs'
import { createBuildArgs } from './runner/build-args.mjs'
import { workerReadiness, poolReadiness } from './runner/readiness.mjs'
import { runMerge } from '../../scripts/sma/lib/merge-gate.mjs'

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
 * runProjectVerb({verb, args, projectDir}) → {ok, code, result, reason}.
 *
 * One verb of the connected project's own runtime, run in that project's directory, with no
 * shell anywhere (an argument array, always). A project that is not connected and a project
 * with no SMA runtime are both an honest refusal — never a throw and never a silent zero.
 */
function runProjectVerb({ verb, args = [], projectDir }) {
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
    execFile(
      process.execPath,
      [cli, verb, ...args],
      { cwd: projectDir, encoding: 'utf8', timeout: PROJECT_VERB_TIMEOUT_MS, maxBuffer: PROJECT_VERB_MAX_BUFFER, windowsHide: true },
      (err, stdout) => {
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
 */
async function readCoordinationLedger({ projectDir, now = Date.now() }) {
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
  const windowsForState = (subject) => windowState({ account: accountOf(subject), usageReader, clock, dataDir })
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

  // (4b) THE CONNECTED PROJECT. The window shows a project the daemon does
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
        phaseCycleDir: () => connectedProjectDir() ?? repoDir,
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
          const run = await runProjectVerb({ verb: 'lint', args: ['--json'], projectDir })
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
        federation, // the action-proxy engine + the pairing book
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
        // approve runs the EXISTING serialized merge verb LOCALLY — never a push.
        verbRunner: (m) => runMerge({ ...m, execGit, runTests: o.runTests }),
        // «Дом системы»: the updater behind POST /api/update/run. A SEPARATE name from
        // `verbRunner` above on purpose — one door's collaborator is not the other's, and a
        // shared generic runner would be a request path that can name a command.
        updateRunner: o.updateRunner ?? (({ apply } = {}) => runUpdateVerb({ apply, projectDir: repoDir })),
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
    // THE OTHER HALF OF THE EXECUTOR. spawnWorker has been wired since the fleet shipped;
    // buildArgs had no implementation to wire, so `executorBlocker` refused every task with
    // «задачу некому запустить» — truthfully, on every tick. Both halves are present now, and
    // the closure is what lets the tick keep its three-argument call: a route names a worker
    // by id, and the account behind that id lives in config, which never travels through the tick.
    buildArgs: o.buildArgs ?? createBuildArgs({ config, env: o.env ?? process.env }),
    // The tree a DOCUMENTARY stage stands in. The same answer the front's phaseCycleDir
    // gives, and deliberately the same expression: a card that reads one directory while the
    // stage writes into another shows work as never started while it is being completed.
    projectDir: o.tickProjectDir ?? (() => connectedProjectDir() ?? config.repoDir),
    // WHAT AN ATTEMPT COST, into the same book the «Расходы» screen reads. The parser and the
    // writer both lived in runner/usage.mjs and only the chat door called them, so every task
    // the tick ran booked nothing and the screen answered zero. Same family as buildArgs above:
    // built, tested, and never joined to the thing that needed it.
    bookUsage: o.bookUsage ?? ((event) => bookUsage({ dataDir, event, clock })),
    verbRunner: o.verbRunner ?? cliVerbRunner,
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
      // The connected project is watched while the daemon runs. It is started AFTER the
      // queue and BEFORE the front only for tidiness — it owns nothing the others need, and
      // a project that cannot be watched degrades inside watchProject rather than here.
      // Staged previews are complete v2 renderings of a FOREIGN project's notes. Nothing used
      // to delete one; the sweep runs at boot and on every project switch.
      pruneMigrationStaging({ stagingDir: migrationStagingDir })
      retargetProjectWatch()
      front.listen()
      daemon.start()
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
