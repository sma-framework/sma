/**
 * baseline.mjs — the MEASUREMENT ORCHESTRATOR of the memory track.
 *
 * Before a memory system is modernized it must be MEASURED, and the measurement must
 * be re-runnable months later by a machine that was not in the room: known retrieval
 * recall, known critical misses, known context cost. This module produces those
 * numbers — and produces them as RECEIPT-SHAPED reports, never as prose. Every report
 * carries a `check_command`: the exact command that reproduces it, so the number can
 * be recorded through receipts.recordReceipt and re-verified by `sma reverify`. A
 * baseline that cannot be re-run is a story, not a baseline.
 *
 * COMPOSED, NEVER RE-IMPLEMENTED (the don't-hand-roll law):
 *   - context-pack.mjs scoreNoteCases — «which notes actually load for this task»,
 *     answered by the real loader path (generator CORE rule + tag-matched periphery),
 *     so the score can never drift from the behavior it measures.
 *   - economy.mjs corpusStats — the ONE versioned token estimator. This module counts
 *     no bytes and no tokens of its own; it passes the estimator's numbers, its
 *     version stamp and its honest approximation caveat straight through.
 *   - receipts.mjs — freshClone for the clean-install capture (only COMMITTED evidence is
 *     installed), and recordReceipt / verifyReceipts for the record + replay entries. The
 *     capture functions themselves still write nothing: recording is a separate, explicit
 *     step, so measuring never mutates the evidence store as a side effect.
 *
 * TWO CLASSES OF CAPTURE — and the difference is stated, never blurred:
 *
 *   PURE captures (captureRetrieval, captureContextCost) are pure over their inputs (a
 *   corpus directory + a gold-cases file). They read; they never write, never touch a
 *   clock, never touch the network. Same inputs → identical report bytes, which is what
 *   makes a baseline comparable to a later re-measurement at all.
 *
 *   WALL-CLOCK captures (captureHookLatency, ...) MEASURE THE WORLD: they spawn the real
 *   entry point and time it. They are deliberately NOT deterministic — a latency number
 *   that reproduced byte-for-byte would be a fake. What IS deterministic is their SHAPE
 *   and their method: a fixed run count, nothing discarded, nearest-rank percentiles, and
 *   the exact command that was timed carried in the report.
 *
 * HONEST EMPTIES: zero cases or zero expected notes yield `null` rates, never a
 * fabricated 1.0; a corpus with no index yields `core: null`, never 0-as-if-measured;
 * a corrupt gold-case line is skipped AND COUNTED (`corrupt_lines`), never silently
 * dropped; a hook entry that cannot be discovered yields `null` milliseconds and a
 * detail, never a 0 that reads like a measurement.
 *
 * Node built-ins only; io and runners injectable; zero npm deps, zero LLM, zero network.
 */

import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scoreNoteCases } from './context-pack.mjs'
import { corpusStats } from './economy.mjs'
import { freshClone } from './receipts.mjs'

/**
 * The re-run commands. Both are bare verb forms on purpose: a check_command must pass
 * the SAFE_COMMAND allowlist AND its charset (no backslashes — a machine-specific
 * absolute path would make the receipt unreproducible on any other checkout). The verb
 * resolves the project's own corpus and gold-cases file itself.
 */
export const RETRIEVAL_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline retrieval'
export const CONTEXT_COST_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline context-cost'
export const HOOK_LATENCY_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline capture --only hook-latency'
export const WORKER_RECOVERY_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline capture --only worker-recovery'
export const CLEAN_INSTALL_CHECK_COMMAND = 'node scripts/sma/cli.mjs baseline capture --only clean-install'

/** Round a rate to 4 decimals (never carry float noise into a recorded number). */
function rate(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  return Math.round((numerator / denominator) * 1e4) / 1e4
}

/** Round a millisecond value to 2 decimals (the house posture for reported ms). */
function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * Nearest-rank percentile over a numeric list. Deliberately a LOCAL four-liner: the same
 * helper is a private four-liner in every module that reports a p95 (the house shape), and
 * importing a whole benchmark module into a measurement module for four lines would buy a
 * dependency, not a saving. `null` for an empty list — never 0-as-if-measured.
 */
function percentile(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

/**
 * readGoldCases(casesPath, {readFile}) → {cases, corrupt}. One JSON object per line
 * (the note-level subset of the gold format):
 *   {task, expected_notes[], critical_notes[], forbidden_notes[]}
 * A missing file is an honest empty set, a corrupt line is skipped and counted —
 * reading the baseline's own input can never be the thing that fails the baseline.
 *
 * @param {string} casesPath
 * @param {{readFile?:Function}} [opts]
 * @returns {{cases: object[], corrupt: number}}
 */
export function readGoldCases(casesPath, { readFile } = {}) {
  const rf = typeof readFile === 'function' ? readFile : readFileSync
  let raw
  try {
    raw = rf(casesPath, 'utf8')
  } catch {
    return { cases: [], corrupt: 0 }
  }
  const cases = []
  let corrupt = 0
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      corrupt += 1
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      corrupt += 1
      continue
    }
    cases.push(parsed)
  }
  return { cases, corrupt }
}

/**
 * captureRetrieval(opts) → the retrieval-recall measurement of the CURRENT loader.
 *
 * Report:
 *   {metric:'retrieval-recall', cases, expected, hits, corrupt_lines,
 *    misses:[{case, missing_notes}], critical_misses:[{case, missing_notes}],
 *    forbidden_hits:[{case, forbidden_notes}], core_loaded:[...],
 *    summary:{recall, critical_miss_rate}, check_command}
 *
 *   - recall            = expected notes that loaded / all expected notes  (null when none)
 *   - critical_miss_rate= cases missing >= 1 critical note / cases         (null when none)
 *   - core_loaded       = the always-load set the corpus produces (the same for every case)
 *
 * @param {object} opts
 * @param {string} opts.corpusDir
 * @param {string} opts.casesPath   gold cases, one JSON object per line
 * @param {string} [opts.tagsPath]  defaults to <corpusDir>/TAGS.md through the loader
 * @param {object} [opts.dateMap]   file → last-commit ISO (INJECTED; ordering only)
 * @param {string} [opts.commit]    INJECTED (pack identity only, never the score)
 * @param {number} [opts.budget]    pack budget override
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.compile] compilePack double (tests)
 * @param {string} [opts.checkCommand] override the recorded re-run command
 * @returns {object}
 */
export function captureRetrieval(opts = {}) {
  const {
    corpusDir,
    casesPath,
    tagsPath,
    dateMap = {},
    commit = '',
    budget,
    readFile,
    compile,
    checkCommand = RETRIEVAL_CHECK_COMMAND,
  } = opts

  const { cases, corrupt } = readGoldCases(casesPath, { readFile })
  const scored = scoreNoteCases({
    cases,
    corpusDir,
    tagsPath,
    dateMap,
    commit,
    ...(budget == null ? {} : { budget }),
    ...(compile == null ? {} : { compile }),
  })

  const misses = []
  const criticalMisses = []
  const forbiddenHits = []
  for (const c of scored.cases) {
    if (c.missing.length) misses.push({ case: c.task, missing_notes: c.missing })
    if (c.criticalMissing.length) criticalMisses.push({ case: c.task, missing_notes: c.criticalMissing })
    if (c.forbiddenPresent.length) forbiddenHits.push({ case: c.task, forbidden_notes: c.forbiddenPresent })
  }

  const t = scored.totals
  return {
    metric: 'retrieval-recall',
    cases: t.cases,
    expected: t.expected,
    hits: t.hits,
    corrupt_lines: corrupt,
    misses,
    critical_misses: criticalMisses,
    forbidden_hits: forbiddenHits,
    core_loaded: scored.coreLoaded,
    summary: {
      recall: rate(t.hits, t.expected),
      critical_miss_rate: rate(t.casesWithCriticalMiss, t.cases),
    },
    check_command: checkCommand,
  }
}

/**
 * captureContextCost(opts) → the context-cost measurement of the corpus.
 *
 * Report:
 *   {metric:'context-cost', per_file:[{file, kind, tokens}], totals, top,
 *    estimator_version, caveat, check_command}
 *
 * Every number comes from economy.corpusStats — this function classifies and orders,
 * it does not count. `kind` is 'core' (the always-loaded index), 'index' (a per-area
 * INDEX-*.md) or 'note'. per_file is heaviest-first within each kind, core first.
 *
 * @param {object} opts
 * @param {string} opts.corpusDir
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.listFiles]
 * @param {number} [opts.topN]
 * @param {string} [opts.checkCommand]
 * @returns {object}
 */
export function captureContextCost(opts = {}) {
  const { corpusDir, readFile, listFiles, topN = 10, checkCommand = CONTEXT_COST_CHECK_COMMAND } = opts

  const stats = corpusStats({ corpusDir, readFile, listFiles, topN })

  const perFile = []
  if (stats.core != null) perFile.push({ file: 'MEMORY.md', kind: 'core', tokens: stats.core })
  for (const n of stats.notes) perFile.push({ file: n.file, kind: 'note', tokens: n.tokens })
  for (const i of stats.indexes) perFile.push({ file: i.file, kind: 'index', tokens: i.tokens })

  return {
    metric: 'context-cost',
    per_file: perFile,
    totals: stats.totals,
    top: stats.top,
    estimator_version: stats.estimatorVersion,
    caveat: stats.caveat,
    check_command: checkCommand,
  }
}

// ── hook latency: what the wired-in layer actually costs per tool call ─────────

/**
 * Which hook event to time when the caller does not name one. The per-tool-call events
 * come first ON PURPOSE: they are what an adopter pays on EVERY edit, so they are the
 * honest headline number; a once-per-session event is not.
 */
const HOOK_EVENT_PRIORITY = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart']

/** Default number of timed invocations. Nothing is discarded — no warmup, no trimming. */
export const DEFAULT_HOOK_RUNS = 20

/** The stdin a hook entry is fed: a representative empty JSON payload. */
const HOOK_STDIN_PAYLOAD = '{}'

/**
 * discoverHookEntry(settingsPath, {readFile, hook}) → {command, event, matcher} | null.
 *
 * READ-ONLY discovery of the ACTUALLY INSTALLED hook entry from a settings file's hooks
 * block ({event: [{matcher?, hooks:[{type:'command', command}]}]}). This module hardcodes
 * NO hook path: an instrument that times a guessed command measures a guess. Selection:
 * `hook` (an event name OR a substring of the command) when given, else the first entry in
 * HOOK_EVENT_PRIORITY order, else the first wired entry at all.
 *
 * A missing, unreadable, non-JSON or shapeless file is an honest `null` — never a throw
 * (the capture that follows reports the honest empty).
 *
 * @param {string} settingsPath
 * @param {{readFile?:Function, hook?:string}} [opts]
 * @returns {{command:string, event:string, matcher:(string|null)}|null}
 */
export function discoverHookEntry(settingsPath, { readFile, hook } = {}) {
  const rf = typeof readFile === 'function' ? readFile : readFileSync
  let parsed
  try {
    parsed = JSON.parse(String(rf(settingsPath, 'utf8')))
  } catch {
    return null
  }
  const blocks = parsed && typeof parsed === 'object' ? parsed.hooks : null
  if (!blocks || typeof blocks !== 'object') return null

  const entries = []
  for (const [event, groups] of Object.entries(blocks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const list = group && Array.isArray(group.hooks) ? group.hooks : []
      for (const h of list) {
        if (!h || h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) continue
        entries.push({ command: h.command.trim(), event, matcher: group.matcher ?? null })
      }
    }
  }
  if (!entries.length) return null

  if (hook != null && String(hook).trim()) {
    const want = String(hook).trim()
    const byEvent = entries.find((e) => e.event.toLowerCase() === want.toLowerCase())
    if (byEvent) return byEvent
    const byCommand = entries.find((e) => e.command.includes(want))
    if (byCommand) return byCommand
    return null
  }

  for (const event of HOOK_EVENT_PRIORITY) {
    const hit = entries.find((e) => e.event === event)
    if (hit) return hit
  }
  return entries[0]
}

/**
 * Default hook runner: spawn the entry with an empty payload on stdin; exit code as DATA.
 *
 * SHELL FIDELITY, and the trust boundary that comes with it: a hook entry is a COMMAND
 * STRING that the agent harness itself runs through a shell on every tool call, and hook
 * authors do write shell there. Timing it any other way (argv-splitting it into execFile)
 * would measure a different thing than the one an adopter pays for. So the string is run
 * as-is — which means the settings file is trusted here EXACTLY as much as the harness
 * already trusts it: whoever can write a hook command into it can already execute it
 * without this module. The string is never taken from a corpus, a note, a receipt or any
 * network input; it comes only from the settings file being measured, or from an explicit
 * operator-supplied override.
 */
function defaultHookRun(command, { cwd, timeoutMs } = {}) {
  try {
    execSync(command, { input: HOOK_STDIN_PAYLOAD, encoding: 'utf8', stdio: 'pipe', cwd, timeout: timeoutMs })
    return { exitCode: 0 }
  } catch (err) {
    return { exitCode: Number.isFinite(Number(err && err.status)) ? Number(err.status) : 1 }
  }
}

/**
 * captureHookLatency(opts) → the wall-clock cost of the INSTALLED hook entry.
 *
 * Report:
 *   {metric:'hook-latency', runs, p50_ms, p95_ms, mean_ms, entry_command, hook_event,
 *    nonzero_exits, detail?, check_command}
 *
 * Method (stated so the number is auditable): the entry command is discovered from the
 * settings file, spawned `runs` times with an empty JSON payload on stdin, and each wall
 * time is recorded. NOTHING IS DISCARDED — no warmup run is dropped, no outlier trimmed,
 * so `runs` is always the sample count. Percentiles are nearest-rank. A nonzero exit is
 * COUNTED (`nonzero_exits`) rather than excluded: a hook that fails fast would otherwise
 * report a flattering latency.
 *
 * This capture is a MEASUREMENT OF THE WORLD, not a pure function: it spawns a process and
 * reads a clock. Re-running it yields different milliseconds by nature — that is what a
 * latency baseline is. Both the runner and the clock are injectable so tests assert the
 * math and the shape without spawning anything.
 *
 * @param {object} opts
 * @param {number} [opts.runs]         default DEFAULT_HOOK_RUNS
 * @param {string} [opts.settingsPath] the settings file to discover the entry from
 * @param {string} [opts.entryCommand] skip discovery and time this command
 * @param {string} [opts.hook]         event name / command substring to select an entry
 * @param {string} [opts.cwd]          working directory for the spawn
 * @param {number} [opts.timeoutMs]    per-invocation timeout
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.run]        (command, {cwd, timeoutMs}) -> {exitCode}
 * @param {Function} [opts.hrtime]     () -> milliseconds
 * @param {string} [opts.checkCommand]
 * @returns {object}
 */
export function captureHookLatency(opts = {}) {
  const {
    runs = DEFAULT_HOOK_RUNS,
    settingsPath,
    entryCommand,
    hook,
    cwd,
    timeoutMs = 30_000,
    readFile,
    run,
    hrtime,
    checkCommand = HOOK_LATENCY_CHECK_COMMAND,
  } = opts

  const discovered = entryCommand
    ? { command: String(entryCommand), event: null, matcher: null }
    : settingsPath
      ? discoverHookEntry(settingsPath, { readFile, hook })
      : null

  const base = { metric: 'hook-latency', check_command: checkCommand }

  if (!discovered) {
    return {
      ...base,
      runs: 0,
      p50_ms: null,
      p95_ms: null,
      mean_ms: null,
      entry_command: null,
      hook_event: null,
      nonzero_exits: 0,
      // No path in the detail ON PURPOSE: a report is a public artifact, machine paths
      // are not part of the measurement.
      detail: settingsPath
        ? 'no hook entry command found in the settings file (absent, unreadable or no wired command hooks)'
        : 'no hook entry command given and no settings file to discover one from',
    }
  }

  const n = Number.isFinite(Number(runs)) && Number(runs) > 0 ? Math.floor(Number(runs)) : DEFAULT_HOOK_RUNS
  const doRun = typeof run === 'function' ? run : defaultHookRun
  const clock = typeof hrtime === 'function' ? hrtime : () => performance.now()

  const samples = []
  let nonzeroExits = 0
  for (let i = 0; i < n; i++) {
    const before = clock()
    const res = doRun(discovered.command, { cwd, timeoutMs })
    const after = clock()
    samples.push(Math.max(0, after - before))
    if (!res || Number(res.exitCode) !== 0) nonzeroExits += 1
  }

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    ...base,
    runs: samples.length,
    p50_ms: round2(percentile(samples, 50)),
    p95_ms: round2(percentile(samples, 95)),
    mean_ms: round2(mean),
    entry_command: discovered.command,
    hook_event: discovered.event,
    nonzero_exits: nonzeroExits,
  }
}

// ── detail hygiene: a report is a public artifact ──────────────────────────────

/**
 * safeDetail(text) — the ONLY way a free-text detail enters a report. Connection strings
 * (credentials and all), bare host:port pairs and machine paths are replaced by markers,
 * and the text is clipped to its first lines. A baseline report gets recorded, committed
 * and read by strangers; the measurement is the product, the operator's environment is not.
 */
function safeDetail(text) {
  return String(text ?? '')
    .split('\n')
    .slice(0, 3)
    .join(' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[endpoint masked]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, '[host masked]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[path]')
    .replace(/(?:\/[\w.@-]+){2,}/g, '[path]')
    .trim()
    .slice(0, 400)
}

/** An error's text, whatever shape it arrived in. */
function errText(err) {
  return String((err && err.message) ?? err)
}

// ── worker recovery: does an abandoned claim actually come back? ───────────────

/** How the recovery number is produced — carried IN the report so it is auditable. */
const DRILL_METHOD =
  'a no-op task is enqueued and claimed, then the claim is ABANDONED — never touched, never completed, never failed, exactly as a dead worker leaves it; recovery_ms is the wall time until the queue makes that task claimable again'

/** The worker identity the drill claims under (never a real lane worker's id). */
const DRILL_WORKER_ID = 'baseline-recovery-drill'

/** The lane the drill uses, and only ever while it is idle. */
const DRILL_LANE = 'paperwork'

/** {host, port} of a queue connection string, or null when there is nothing to reach. */
function parseEndpoint(queueUrl) {
  if (!queueUrl || typeof queueUrl !== 'string') return null
  try {
    const u = new URL(queueUrl)
    if (!u.hostname) return null
    return { host: u.hostname, port: Number(u.port) || 5432 }
  } catch {
    return null
  }
}

/** Bounded TCP reachability probe. Resolves true/false; NEVER throws, never leaks a socket. */
function probeTcp({ host, port, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      resolve(v)
    }
    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The default drill against a REAL queue. Composed of the daemon's own queue adapter —
 * loaded dynamically, because the queue backend is an optional peer of this product, not a
 * dependency of it: on a machine without it, the import fails and the capture reports the
 * honest environment-unavailable branch instead of a number.
 *
 * TWO SAFETY RULES, both structural:
 *   1. NOTHING IS EVER SIGNALLED. «Killing the worker» is modelled as abandoning the claim,
 *      because the queue cannot tell a killed process from a silent one — both surface as a
 *      claim that stops being refreshed, and both recover by the same expiry path. Killing
 *      a real process would add risk without adding fidelity, so the drill kills nothing.
 *   2. THE DRILL REFUSES A BUSY LANE. It checks the lane is idle before enqueuing, and
 *      aborts the moment it claims anything that is not its own task — a measurement must
 *      never delay somebody else's work.
 */
async function defaultRecoveryDrill({
  queueUrl,
  timeoutMs = 180_000,
  expireMs = 10_000,
  pollMs = 1_000,
  clock = () => performance.now(),
  loadBackend,
} = {}) {
  const load = typeof loadBackend === 'function' ? loadBackend : () => import('../../../daemon/src/queue/pgboss-backend.mjs')
  const { createPgBossQueue } = await load()
  const taskId = `${DRILL_WORKER_ID}-${Date.now()}`
  const adapter = createPgBossQueue({ queueUrl, expireMs })

  try {
    await adapter.start()

    // Rule 2: never drill on a lane that carries live work.
    const busy = (await adapter.list({ lane: DRILL_LANE })).filter((r) => r.status === 'queued' || r.status === 'claimed')
    if (busy.length) return { detail: 'the drill lane is not idle — refusing to drill while real work is queued or claimed' }

    await adapter.enqueue({ id: taskId, source: 'roster', lane: DRILL_LANE, title: 'baseline worker-recovery drill (no-op)' })

    const deadline = clock() + timeoutMs
    let claimed = null
    while (clock() < deadline) {
      const got = await adapter.claimNext(DRILL_WORKER_ID, { lanes: [DRILL_LANE] })
      if (got && got.id !== taskId) {
        return { detail: 'a task that is not the drill task was claimed — aborting so the drill never delays real work' }
      }
      if (got) {
        claimed = got
        break
      }
      await sleep(pollMs)
    }
    if (!claimed) return { detail: 'the drill task never became claimable — there was nothing to recover from' }

    // ABANDONED from here: no touch, no complete, no fail. Exactly what a dead worker leaves.
    const abandonedAt = clock()
    let recovered = false
    while (clock() < deadline) {
      await sleep(pollMs)
      const row = (await adapter.list({ lane: DRILL_LANE })).find((r) => r.id === taskId)
      if (row && row.status === 'queued') {
        recovered = true
        break
      }
    }
    if (!recovered) return { detail: `the abandoned claim did not become claimable again within ${timeoutMs} ms` }
    const recovery_ms = clock() - abandonedAt

    // Best-effort cleanup: reclaim OUR task and close it, so the drill leaves no residue.
    try {
      const mine = await adapter.claimNext(DRILL_WORKER_ID, { lanes: [DRILL_LANE] })
      if (mine && mine.id === taskId) await adapter.fail(taskId, 'manual')
    } catch {
      /* the number is already measured; residue is a housekeeping matter, not a result */
    }
    return { recovery_ms, detail: DRILL_METHOD }
  } finally {
    try {
      await adapter.stop()
    } catch {
      /* closing a connection can never change what was measured */
    }
  }
}

/**
 * captureWorkerRecovery(opts) → how long an abandoned claim takes to become claimable again.
 *
 * Report:
 *   {metric:'worker-recovery', status:'measured'|'environment-unavailable',
 *    recovery_ms?, detail, method?, check_command}
 *
 * THE HONEST TWO BRANCHES, and there are only two: either the drill ran against a reachable
 * queue and `recovery_ms` is a number that was MEASURED, or it did not and the report says
 * so. `recovery_ms` is ABSENT — not null, not 0 — on the unavailable branch, so no reader
 * and no downstream diff can mistake an unrun drill for a fast one. An environment that is
 * down is a FIRST-CLASS RESULT worth recording: «this environment could not be drilled on
 * this date» is exactly the fact a later re-measurement needs.
 *
 * @param {object} opts
 * @param {string} [opts.queueUrl]
 * @param {Function} [opts.probe]  ({host, port, timeoutMs}) -> Promise<boolean>
 * @param {Function} [opts.drill]  ({queueUrl, timeoutMs}) -> Promise<{recovery_ms?, detail?}>
 * @param {number} [opts.probeTimeoutMs]
 * @param {number} [opts.drillTimeoutMs]
 * @param {string} [opts.checkCommand]
 * @returns {Promise<object>}
 */
export async function captureWorkerRecovery(opts = {}) {
  const {
    queueUrl,
    probe,
    drill,
    probeTimeoutMs = 2000,
    drillTimeoutMs = 180_000,
    checkCommand = WORKER_RECOVERY_CHECK_COMMAND,
  } = opts

  const base = { metric: 'worker-recovery', check_command: checkCommand }
  const unavailable = (detail) => ({ ...base, status: 'environment-unavailable', detail: safeDetail(detail) })

  const endpoint = parseEndpoint(queueUrl)
  if (!endpoint) return unavailable('no queue endpoint configured — there is nothing to drill')

  const doProbe = typeof probe === 'function' ? probe : probeTcp
  let reachable
  try {
    reachable = await doProbe({ host: endpoint.host, port: endpoint.port, timeoutMs: probeTimeoutMs })
  } catch (err) {
    return unavailable(`the queue probe failed: ${errText(err)}`)
  }
  if (!reachable) return unavailable(`the queue endpoint did not accept a connection within ${probeTimeoutMs} ms`)

  const doDrill = typeof drill === 'function' ? drill : defaultRecoveryDrill
  let result
  try {
    result = await doDrill({ queueUrl, timeoutMs: drillTimeoutMs })
  } catch (err) {
    return unavailable(`the recovery drill did not complete: ${errText(err)}`)
  }

  const ms = Number(result && result.recovery_ms)
  if (!Number.isFinite(ms)) {
    return unavailable((result && result.detail) || 'the drill returned no measured recovery time')
  }
  return {
    ...base,
    status: 'measured',
    recovery_ms: round2(ms),
    detail: safeDetail(result.detail ?? DRILL_METHOD),
    method: DRILL_METHOD,
  }
}

// ── clean install: what a stranger pays to get from zero to installed ──────────

/**
 * captureCleanInstall(opts) → the wall-clock cost of a fresh install into an empty target.
 *
 * Report:
 *   {metric:'clean-install', status:'measured'|'incomplete', wall_ms,
 *    steps:[{name, ms, ok, detail?}], check_command}
 *
 * Two timed steps: a FRESH CLONE (receipts.freshClone — only COMMITTED evidence gets
 * installed, the same discipline the receipt layer verifies under) and the installer run
 * into an empty directory. A step that fails is reported `ok:false` and flips the status to
 * `incomplete`: the elapsed milliseconds are real, but a broken install is never allowed to
 * read as an install TIME.
 *
 * No path appears in the report (the target is a throwaway temp dir, and an operator's
 * machine layout is not part of the measurement). A temp dir this function created is
 * removed afterwards; a temp dir the CALLER supplied is never touched — deleting a
 * directory somebody else named is not this function's business.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot] the repository to clone (default: cwd)
 * @param {string} [opts.tmpDir]   scratch root (default: a fresh mkdtemp this call owns)
 * @param {Function} [opts.exec]   (file, args, opts) -> stdout
 * @param {Function} [opts.hrtime] () -> milliseconds
 * @param {boolean} [opts.cleanup] false keeps a self-created scratch dir for inspection
 * @param {string} [opts.checkCommand]
 * @returns {object}
 */
export function captureCleanInstall(opts = {}) {
  const {
    repoRoot = process.cwd(),
    tmpDir,
    exec,
    hrtime,
    cleanup,
    checkCommand = CLEAN_INSTALL_CHECK_COMMAND,
  } = opts

  const runExec =
    typeof exec === 'function'
      ? exec
      : (file, args, o = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe', ...o })
  const clock = typeof hrtime === 'function' ? hrtime : () => performance.now()

  const ownsScratch = tmpDir == null
  const scratch = ownsScratch ? mkdtempSync(join(tmpdir(), 'sma-clean-install-')) : tmpDir
  const cloneDir = join(scratch, 'clone')
  const targetDir = join(scratch, 'target')

  const steps = []
  let status = 'measured'
  const timed = (name, fn) => {
    const before = clock()
    let ok = true
    let detail
    try {
      fn()
    } catch (err) {
      ok = false
      status = 'incomplete'
      detail = safeDetail(errText(err))
    }
    const ms = round2(Math.max(0, clock() - before))
    steps.push(detail == null ? { name, ms, ok } : { name, ms, ok, detail })
    return ok
  }

  try {
    mkdirSync(targetDir, { recursive: true })
    const cloned = timed('clone', () =>
      freshClone({ repoRoot, targetDir: cloneDir, execGit: (args) => runExec('git', args, {}) }),
    )
    if (cloned) {
      timed('install', () => runExec(process.execPath, [join(cloneDir, 'bin', 'init.mjs'), '--local'], { cwd: targetDir }))
    } else {
      status = 'incomplete'
      steps.push({ name: 'install', ms: 0, ok: false, detail: 'skipped — the clone step did not complete' })
    }
  } finally {
    if (ownsScratch && cleanup !== false) {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        /* a leftover temp dir is a housekeeping matter, not a measurement failure */
      }
    }
  }

  return {
    metric: 'clean-install',
    status,
    wall_ms: round2(steps.reduce((a, s) => a + s.ms, 0)),
    steps,
    check_command: checkCommand,
  }
}
