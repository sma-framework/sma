/**
 * state.mjs — the roster's ONE-POLL payload: derive everything, store nothing.
 *
 * ═══════════════════════ DERIVE, NEVER STORE ════════════════════════════════════
 * deriveState re-computes the WHOLE roster truth from durable sources every call — the
 * pg-boss rows (adapter.list), the per-attempt ledger, the honest window model, and the
 * usage book. No cache, no memo: a poll after ANY daemon restart is correct by
 * construction (the daemon holds no task state). The poll cadence (2-5s) is the researched
 * choice; the live-hint SSE layer (Task 4) is additive, never the source of truth.
 *
 * ═══════════════════════ PATTERN 2 — TWO LIVENESS AXES ══════════════════════════
 * The payload exposes BOTH axes but labels them: the QUEUE axis (counts, status,
 * agedForHours) drives requeue decisions UPSTREAM (the tick), never the roster; the
 * PULSE axis (pulseAgeSec) is an attention hint for the human. `presence` is a PURE
 * derive (window open × active task × touch freshness) — there is NO stored «working»
 * flag anywhere for it to read — a stored «working» flag was Multica's top prod complaint.
 *
 * ═══════════════════════ WHAT THE ROSTER RENDERS ════════════════════════════════
 *   - agedForHours on a queue row ONLY when it has been queued past config.agingHours
 *     (pure derive from the enqueuedAt timestamp, never a stored flag); on a row waiting
 *     for a PERSON the same field is the wait itself — fractional hours since the work
 *     stopped (completedAt), with no threshold and no field at all where the stop was
 *     never marked;
 *   - `acceptance` («обещано») carried onto done rows when the task had one, omitted
 *     when it did not (roster/return tasks are DoR-exempt);
 *   - failed rows carry {reason, reasonLabel} — reasonLabel from REASON_LABELS
 *     (adapter.mjs, the single source); the raw code still travels for machines.
 *
 * ═══════════ V5.1 — PROJECTS, MACHINES, FEDERATION ══════════════════════════════
 * The payload gains `projects[]`, `activeProject`, `machines[]` and `federation` — all
 * DERIVED, none stored: projects come from the config registry, their counts from the
 * queue selection, the machine from the config plus its federation role.
 *
 * THE SHAPE IS FINAL NOW, ON PURPOSE. `machines[]` holds this machine
 * ({id, title, role:'self', online:true}) and `federation.hubReachable` exists before
 * anything probes a hub. The SPA types the contract once and never revises it.
 * `hubReachable` is an injectable seam (`deps.hubReachable`) defaulting to true: nothing
 * has proven a hub unreachable until a probe is wired.
 *
 * ═══════════ THE AGGREGATOR SEAM — FILLED, NEVER REDEFINED ══════════════════════
 * A HUB daemon injects `deps.aggregator`: the last step of the derive hands the finished
 * local payload to it and returns what comes back — federation.mjs merges each peer's
 * machines[] entry and its rows into the SAME key set. Three properties make this seam
 * safe to have in the hot path of every poll:
 *   - ABSENT MEANS UNCHANGED. A standalone daemon injects nothing and gets byte-identical
 *     output to the pre-federation derive; the whole feature is invisible to it.
 *   - FAIL-OPEN. An aggregator that throws or returns a non-object is DISCARDED and the
 *     local payload is served. A peer storm must never blank the founder's own machine.
 *   - THIS FILE STILL STORES NOTHING. The peer snapshots (and their documented
 *     derive-never-store exception) live inside federation.mjs; deriveState only composes.
 *
 * Every task row carries its project and its machine, so a screen FILTERS instead of
 * guessing. The optional `project` filter narrows tasks and the kpis; it deliberately does
 * NOT narrow `projects[]` or `machines[]` — the project switcher has to see all of them,
 * and per-project counts are what make it useful.
 *
 * A ROW'S PROJECT IS THE ROW'S OWN, AND `null` WHEN IT HAS NONE. This file used to fill the
 * gap in with the project currently selected, which made every row that never named one
 * belong to whatever was being looked at — the same tasks under both projects, counters
 * agreeing with both, and no way to see it from the screen. The narrowing keeps rows of
 * unknown ownership rather than dropping them: work no filter shows is work nobody can act
 * on. They ride with `project: null`, and the window says «неизвестен» in words.
 *
 * Nothing here carries a peer url, a peer token or free text: the federation
 * field is a role and a boolean, and that is the whole of it.
 *
 * ═══════════ V5.1 — THE SETTINGS READ MODELS ════════════════════════════════════
 * The settings screens («Правила», «Аккаунты») ride the payload of the EXISTING state
 * route. The frozen table is the table of ROUTES; the shape of a payload was never the
 * frozen thing, and a new route per screen would have been the expensive way to say the
 * same sentence. `rules` and `accounts` are pure derives of the config plus the window
 * seam the roster already rides — no new stored field exists for them to disagree with.
 *
 * Neither section carries a secret VALUE, a credential env-var NAME, or an account's local
 * config path: they carry an account by NAME and nothing else.
 *
 * `memory` and `style` join them as SURFACES over local artifacts: counters, tags and
 * pointers for the corpus (never a note's body), metrics and already-redacted quotes for the
 * snapshot (never a transcript, never the exam's answer key). Both degrade to {absent:true}
 * on a machine that has none of it — a fresh install with no style is the normal case, not
 * an error case. `style` СЕГОДНЯ НИКТО НЕ ЧИТАЕТ — экран, который его показывал, снят
 * владельцем 28.08.2026; кто его читатель и почему счёт всё же остаётся, сказано словами над
 * `deriveStyle`.
 *
 * Every collaborator (adapter, ledger reader, the window-state function, usageReader,
 * the git/receipt readers, clock) is dependency-injected, so tests derive from fixtures
 * with no real Postgres / git / fs. Node built-ins only; zero deps; zero network.
 */

import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { join } from 'node:path'

import { pipelineEnabled } from '../config.mjs'
import { isOpen } from '../policy/windows.mjs'
import {
  isBatchParent,
  batchItemsOf,
  batchDecisionsOf,
  latestRowPerId,
  waveAddressOf,
  REASON_LABELS,
} from '../queue/adapter.mjs'
import { readWaveHolds } from '../queue/wave-holds.mjs'
import { readAttempts, foldAttemptRows } from '../queue/attempt-ledger.mjs'
import { attemptIdFor } from './journal.mjs'
import { readTaskChanges, taskBranch } from './task-changes.mjs'
import { runsDirOf, sumRunTokens, zeroTokens, TOKEN_FIELDS, RUN_DIRS_KEEP } from '../queue/run-dir.mjs'
import { parseNote } from '../../../scripts/sma/lib/frontmatter.mjs'
import { PIPELINE_DRAFT_KIND } from '../../../scripts/sma/lib/write-pipeline.mjs'
import { parseNoteToPair } from '../../../scripts/sma/lib/replay-exam.mjs'
import {
  createQuestions,
  findPhaseDir,
  phaseNumberOf,
  STAGE_ARTIFACTS,
  ALL_CHECKPOINT_SUFFIXES,
  CHECKPOINT_SUFFIX,
  EXEC_CHECKPOINT_SUFFIX,
} from './questions.mjs'

const HOUR_MS = 3600000
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
/** Touch freshness for the «работает» presence: a claimed task touched within this. */
const FRESH_TOUCH_SEC = 180
const DONE_COMMIT_CAP = 10

/** Generated / registry artifacts of the corpus — structural files, not notes. */
const MEMORY_STRUCTURAL = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])
/** How many corpus pointers the «Память» screen gets — a surface, not a feed. */
const MEMORY_RECENT_CAP = 10
/**
 * How much of a note's own line travels. A v2 `claim` is a full sentence and sometimes three;
 * a row on the screen is one line, and the whole note is read where it lives. The generated
 * corpus indexes cut their own lines at the same order of magnitude.
 */
const MEMORY_TITLE_CAP = 200
/** How much of the training history and how many drafts travel on one poll. */
const STYLE_TRAININGS_CAP = 20
const STYLE_DECISIONS_CAP = 20
/** Each redacted excerpt is a quote on a card, not a document. */
const STYLE_TEXT_CAP = 400

/** Coerce an epoch-ms number or an ISO string to ms, or NaN. */
function toMs(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : NaN
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * derivePresence({windowOpen, hasActiveTask, pulseAgeSec}) → 'работает'|'ждёт окно'|
 * 'свободен'. PURE: a CLOSED window dominates (→ «ждёт окно») even with
 * queued work; an OPEN window with an active task freshly touched → «работает»;
 * everything else → «свободен». No storage is ever read — the fixtures carry no such
 * field to read.
 *
 * @param {{windowOpen:boolean, hasActiveTask:boolean, pulseAgeSec?:(number|null|undefined)}} o
 * @returns {'работает'|'ждёт окно'|'свободен'}
 */
export function derivePresence({ windowOpen, hasActiveTask, pulseAgeSec } = {}) {
  if (!windowOpen) return 'ждёт окно'
  const fresh = pulseAgeSec == null || pulseAgeSec <= FRESH_TOUCH_SEC
  if (hasActiveTask && fresh) return 'работает'
  return 'свободен'
}

/**
 * parseReceiptSummary(receiptRef, {readReceipt}) → {testsPassed, testsTotal, tscClean,
 * guardClean}. The receiptRef may ALREADY be a structured receipt object (the common
 * case — the loop writes the rich attempt row) or a string ref resolved via an injected
 * readReceipt reader. Missing / unreadable → an all-null summary (never throws). Data
 * comes ONLY from the durable receipt, never a guess.
 *
 * @param {*} receiptRef
 * @param {{readReceipt?:Function}} [opts]
 * @returns {{testsPassed:number|null, testsTotal:number|null, tscClean:boolean|null, guardClean:boolean|null}}
 */
export function parseReceiptSummary(receiptRef, { readReceipt } = {}) {
  let r = null
  if (receiptRef && typeof receiptRef === 'object') r = receiptRef
  else if (typeof receiptRef === 'string' && typeof readReceipt === 'function') {
    try {
      r = readReceipt(receiptRef)
    } catch {
      r = null
    }
  }
  if (!r || typeof r !== 'object') {
    return { testsPassed: null, testsTotal: null, tscClean: null, guardClean: null }
  }
  return {
    testsPassed: numOrNull(r.testsPassed ?? r.passed),
    testsTotal: numOrNull(r.testsTotal ?? r.total),
    tscClean: boolOrNull(r.tscClean),
    guardClean: boolOrNull(r.guardClean),
  }
}

/**
 * THE SHAPES A RECEIPT REFERENCE REALLY TAKES, and what each one PROVES.
 *
 * Every finished attempt carries a `receiptRef` STRING written by the tick at the moment its
 * exit gate opened. The four numbers `parseReceiptSummary` looks for — tests passed, tests
 * total, build clean, rules clean — have no producer anywhere in this system: the reverify
 * verb re-runs a recorded command and compares HASHES, deliberately knowing nothing about
 * what kind of run is inside, so it reports a verdict and not a count. A card that waits for
 * those numbers therefore shows nothing, forever, on every task.
 *
 * So this reads the proof that DOES exist. Each prefix is written in exactly one place in
 * loop.mjs and means one thing:
 *   reverify:<sha>          the code gate opened — the work was re-verified on the branch
 *   artifact:<path>@<sha>   a documentary stage really produced its document, and committed it
 *   answer:<attemptId>      the attempt correctly changed no code and answered instead
 *   preflight:<taskId>      the work was already on the branch before anybody was spawned
 *   forge:<...>             an agent draft passed its lint and was committed
 *
 * PURE, never throws, and it INVENTS NOTHING: an unrecognised reference is returned under
 * kind 'other' with its text intact rather than dressed up as a pass.
 */
const RECEIPT_KINDS = Object.freeze([
  { kind: 'reverify', re: /^reverify:(.*)$/ },
  { kind: 'artifact', re: /^artifact:(.*)$/ },
  { kind: 'answer', re: /^answer:(.*)$/ },
  { kind: 'preflight', re: /^preflight:(.*)$/ },
  { kind: 'forge', re: /^forge:(.*)$/ },
])

/**
 * parseReceiptProof(receiptRef) → {kind, ref, path?, sha?} | null — the durable proof a
 * finished attempt left, in a shape a screen can render as a sentence.
 *
 * TWO FORMS, AND ONLY ONE OF THEM WAS EVER READ.
 *
 * The tick writes this reference as a STRING when a receipt exists, and as an OBJECT in
 * exactly the two cases where one does not: the differential gate («красными остались только
 * рецепты, что были красны и до работника») and the tree that holds no recipes at all. That
 * object carries `unverified`, the reason in one word, and the numbers the verdict was made
 * from. This reader accepted the string alone — so every attempt closed by either of those
 * two gates produced an EMPTY proof, and «готово» read exactly like «готово, но никто не
 * перепроверял». Those are opposite sentences, and the second one had never once reached a
 * screen although the tick has been computing it since the differential gate existed. An
 * absence rendered as a pass is the lie this whole surface exists to prevent, so the object
 * form is read here, beside the string, and nothing about the string form changes by a byte.
 *
 * NOTHING IS INVENTED, on either path: a key absent from the object is absent from the proof,
 * and an object that names no gate reason is not a gate proof at all (the four-number receipt
 * summary is a different reader's job and is never dressed up as a verdict).
 *
 * @param {*} receiptRef
 * @returns {{kind:string, ref:string, path?:string, sha?:string, unverified?:boolean, reason?:string, branch?:string, base?:string, commits?:number, preexistingRed?:number, newRed?:number}|null}
 */
export function parseReceiptProof(receiptRef) {
  // ── THE OBJECT FORM: what the gate concluded when there was no receipt to point at ──
  if (receiptRef && typeof receiptRef === 'object' && !Array.isArray(receiptRef)) {
    const reason = typeof receiptRef.reason === 'string' ? receiptRef.reason.trim() : ''
    if (!reason) return null
    const num = (v) => (Number.isFinite(v) ? { value: v } : null)
    const commits = num(receiptRef.commits)
    const preexistingRed = num(receiptRef.preexistingRed)
    const newRed = num(receiptRef.newRed)
    const branch = typeof receiptRef.branch === 'string' && receiptRef.branch.trim() ? receiptRef.branch.trim() : null
    const base = typeof receiptRef.base === 'string' && receiptRef.base.trim() ? receiptRef.base.trim() : null
    return {
      kind: 'gate',
      // The reference verbatim: for this form the stored reason IS the reference — there is
      // no second text to quote, and minting a friendlier one would be an invention.
      ref: reason,
      unverified: receiptRef.unverified === true,
      reason,
      ...(branch ? { branch } : {}),
      ...(base ? { base } : {}),
      ...(commits ? { commits: commits.value } : {}),
      ...(preexistingRed ? { preexistingRed: preexistingRed.value } : {}),
      ...(newRed ? { newRed: newRed.value } : {}),
    }
  }
  const ref = typeof receiptRef === 'string' ? receiptRef.trim() : ''
  if (!ref) return null
  for (const { kind, re } of RECEIPT_KINDS) {
    const m = re.exec(ref)
    if (!m) continue
    const rest = String(m[1] || '').trim()
    if (kind === 'artifact') {
      // `path@sha` — split on the LAST @ so a path may contain one and still resolve.
      const at = rest.lastIndexOf('@')
      const path = at > 0 ? rest.slice(0, at) : rest
      const sha = at > 0 ? rest.slice(at + 1) : ''
      return { kind, ref, ...(path ? { path } : {}), ...(sha ? { sha } : {}) }
    }
    if (kind === 'reverify') return { kind, ref, ...(rest ? { sha: rest } : {}) }
    return { kind, ref }
  }
  return { kind: 'other', ref }
}

/**
 * attemptsReader(deps) → (taskId) => attempts[]. The per-attempt ledger is a DI SEAM so
 * tests derive from fixtures with no fs: `ledger` may be a function `(taskId)=>rows`, an
 * object `{readAttempts}`, otherwise `ledgerDir` binds the real readAttempts. Always
 * fail-open ([] on any error).
 *
 * ONE RECORD PER TRY, whichever seam the rows came through. The ledger holds TWO rows for one
 * attempt (the state machine's transition and the tick's richer row), so counting rows here
 * reported twice the tries that happened — «6 подходов» over three. The fold is applied at this
 * one reading seam rather than at each counter, so a consumer added later cannot re-acquire the
 * defect; `foldAttemptRows` owns the merge rule and the ledger file keeps every row it wrote.
 */
function attemptsReader(deps) {
  const { ledger, ledgerDir } = deps
  if (typeof ledger === 'function') {
    return (id) => {
      try {
        return foldAttemptRows(ledger(id) || [])
      } catch {
        return []
      }
    }
  }
  if (ledger && typeof ledger.readAttempts === 'function') {
    return (id) => {
      try {
        return foldAttemptRows(ledger.readAttempts(id) || [])
      } catch {
        return []
      }
    }
  }
  if (ledgerDir) {
    return (id) => {
      try {
        return foldAttemptRows(readAttempts(ledgerDir, id))
      } catch {
        return []
      }
    }
  }
  return () => []
}

/** accountName from an account profile object or a bare string. */
function accountNameOf(account, fallback) {
  if (typeof account === 'string') return account
  return (account && account.name) || fallback
}

/** The window-state function seam: windows(account) → {fiveHour, week, closedUntil?}. */
function windowFor(windows, account) {
  // NOT «zero per cent» — nothing heard. A daemon assembled without the seam knows nothing
  // about any window, and saying so is the whole point of this change.
  const fallback = { fiveHour: { status: 'unknown' }, week: { status: 'unknown' } }
  if (typeof windows !== 'function') return fallback
  try {
    const w = windows(account)
    return w && typeof w === 'object' ? w : fallback
  } catch {
    return fallback
  }
}

/**
 * projectOf(row) → the project the ROW ITSELF names, or null when it names none.
 *
 * IT NO LONGER FILLS THE GAP IN, and that is the whole point of it. This function used to
 * answer «its own, else whatever project is on the screen right now», which sounds like a
 * courtesy and was measured to be a lie: of the forty rows in the live queue not one carried
 * the fact, so every task belonged to whichever project was being looked at. Switch the
 * switcher and the same work re-registered itself under the other project, counters and all —
 * the window looked like it was working and was wrong in complete silence.
 *
 * A row that never said which project it is stays saying nothing. Ownership nobody measured is
 * an invented number like any other, only about whose work it is, and a confident wrong answer
 * is worse than none: nobody can tell it apart from a right one. The window says «неизвестен»
 * in words instead.
 */
function projectOf(row) {
  const own = row && row.project
  return typeof own === 'string' && own !== '' ? own : null
}

/**
 * inProject(row, project) → does this row belong in a selection narrowed to `project`?
 *
 * ITS OWN PROJECT MATCHES, OR IT NAMES NONE AT ALL. A row of unknown ownership dropped by
 * every filter is INVISIBLE WORK — the one outcome worse than an honest «неизвестен», because
 * a person cannot act on what no screen draws, and cannot even discover that it exists. So it
 * rides along in every selection carrying its own truth (null), and the window labels it.
 */
function inProject(row, project) {
  const own = projectOf(row)
  return own === null || own === project
}

/**
 * deriveProjects(rows, config) → [{id, name, connected, taskCounts}] over the WHOLE selection.
 * Counts are per project by construction, so they are computed from every row regardless
 * of an active filter — that is exactly what makes the switcher readable.
 *
 * A ROW COUNTS TOWARDS THE PROJECT IT ITSELF NAMES, and towards no other. While the missing
 * fact was filled in with the project on screen, these counters said the whole queue belonged
 * to whatever was being looked at and the other project stood at a permanent zero — two
 * numbers that moved together with the switcher and measured nothing. Work whose owner is
 * unknown is counted by NEITHER project: a count is a measurement, and this one has not been
 * made.
 *
 * `connected` is whether the registry entry names a folder on disk. The
 * default entry every install mints carries a NAME and no path, so the screens showed a
 * project they could not read a single file of: «Память» answered «нет подключённого
 * проекта» while «Машины и проекты» listed the project by name. An entry that names a
 * project it cannot open is the worst of the three states, so the fact travels and the
 * screens say it. The PATH itself never does — an absolute path on the wire is a
 * disclosure, and a boolean is the whole of what a screen needs.
 */
function deriveProjects(rows, config) {
  const registry = Array.isArray(config.projects) ? config.projects : []
  return registry.map((p) => {
    const mine = rows.filter((r) => projectOf(r) === p.id)
    const taskCounts = { queued: 0, claimed: 0, awaiting_approval: 0, completed: 0, failed: 0, total: mine.length }
    for (const r of mine) {
      if (Object.prototype.hasOwnProperty.call(taskCounts, r.status)) taskCounts[r.status] += 1
    }
    return { id: p.id, name: p.name, connected: typeof p.path === 'string' && p.path.trim() !== '', taskCounts }
  })
}

/**
 * deriveMachines(config) → the LOCAL machine list: exactly this machine. The injected
 * aggregator appends the peers into the SAME shape (their url/token stay out).
 */
function deriveMachines(config) {
  return [
    {
      id: config.machineId ?? 'self',
      title: config.machineTitle ?? 'Эта машина',
      role: 'self',
      online: true,
    },
  ]
}

/**
 * deriveRules(config, {switchMode}) → the «Правила» read model: the lanes with the workers
 * riding them, the worker profiles, the budget stops and the sub→API mode.
 *
 * PURE OVER THE CONFIG. Every field here already exists in the daemon config — this adds no
 * stored field, no second place a rule could be written down and then disagree with the one
 * the runner obeys. `switchMode` is passed IN rather than recomputed: the spend strip works
 * it out from the live windows, and a rule that reports a different mode than the strip is
 * worse than no rule at all.
 *
 * WHAT IT DELIBERATELY DROPS: the account OBJECT. A worker's account carries `configDir` (a
 * local path) and `oauthTokenEnv` (the NAME of the env var holding the token — a secret in
 * its own right). The read model carries the account NAME and nothing else, so a
 * payload that travels the LAN can never carry either.
 *
 * @param {object} config
 * @param {{switchMode?:'subscription'|'api'}} [opts]
 * @returns {{lanes:object[], workers:object[], budgetStops?:object, subApiSwitch:object}}
 */
export function deriveRules(config = {}, { switchMode } = {}) {
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const lanes = []
  const byLane = new Map()

  const workers = workersCfg.map((w) => {
    const lane = w.lane ?? null
    let bucket = byLane.get(lane)
    if (!bucket) {
      bucket = { lane, workers: [] }
      byLane.set(lane, bucket)
      lanes.push(bucket) // config order — the order the founder wrote them in
    }
    bucket.workers.push(w.id)
    return {
      id: w.id,
      lane,
      account: accountNameOf(w.account, w.id),
      // a profile field the config does not carry is OMITTED, never invented as null
      ...(w.provider !== undefined ? { provider: w.provider } : {}),
      ...(w.model !== undefined ? { model: w.model } : {}),
      ...(w.effort !== undefined ? { effort: w.effort } : {}),
      enabled: w.enabled === undefined ? true : Boolean(w.enabled),
    }
  })

  const budget = config.budget
  const capEur = Number(budget && budget.monthlyApiCapEur) || 0
  return {
    lanes,
    workers,
    // THE CONVEYOR'S OWN SWITCH, READ. A toggle that can only be written is a toggle no
    // screen can show as off, and «off» is the state this product ships in — so a window
    // that could not read it would present a stopped machine as a running one. It is
    // DERIVED here by the same predicate the tick is gated on (config.mjs pipelineEnabled),
    // never stored a second time: the answer on the screen and the answer in the tick are
    // one comparison, so they cannot come to disagree.
    pipeline: { enabled: pipelineEnabled(config) },
    ...(budget
      ? {
          budgetStops: {
            monthlyApiCapEur: capEur,
            ...(budget.warnPct !== undefined ? { warnPct: budget.warnPct } : {}),
          },
        }
      : {}),
    subApiSwitch: {
      mode: switchMode === 'api' ? 'api' : 'subscription',
      capEur,
      budgeted: capEur > 0, // no cap → there is no API fallback to switch TO
    },
  }
}

/**
 * deriveAccounts(config, windows) → the «Аккаунты» read model: one entry per SUBSCRIPTION
 * (deduped — several workers ride one account), its window bars, the workers riding it, and
 * the MACHINE it lives on.
 *
 * THE MACHINE BINDING IS THE POINT. A subscription belongs to exactly one machine (config.mjs:
 * federation aggregates views, never credentials), and this is the screen that makes that law
 * visible instead of folklore. Every locally-configured account is bound to THIS machine; a
 * peer's accounts arrive, if at all, through the peer's own payload.
 *
 * Same omission as deriveRules: the account object never travels, only its name.
 *
 * @param {object} config
 * @param {(account:any)=>object} [windows] the window-state seam
 * @returns {object[]}
 */
export function deriveAccounts(config = {}, windows) {
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const machineId = config.machineId ?? 'self'
  const byName = new Map()
  const out = []
  for (const w of workersCfg) {
    const name = accountNameOf(w.account, w.id)
    let entry = byName.get(name)
    if (!entry) {
      entry = { name, machineId, windows: windowBar(windowFor(windows, w.account ?? name)), workers: [] }
      byName.set(name, entry)
      out.push(entry)
    }
    // the founder's daytime account — a property of the ACCOUNT, flagged by
    // whichever worker profile carries it
    if (w.dayPriorityOwner) entry.dayPriorityOwner = true
    entry.workers.push(w.id)
  }
  return out
}

// ══════════════════ the corpus read models: memory + style ══════════════════════
//
// Both are READERS of artifacts that already exist on this machine, through an injectable
// fs seam, and both are fail-soft to the last line: an unreadable directory, an unparsable
// note and a malformed ledger row are ALL normal states of a working install. A settings
// screen that 500s because a note has a typo in its frontmatter is worse than a screen
// that shows one note fewer.

/** The three fs calls these readers make, defaulted to node:fs and injectable for tests. */
function fsSeam(fsImpl) {
  const io = fsImpl ?? {}
  return {
    readdirSync: io.readdirSync ?? fsReaddirSync,
    readFileSync: io.readFileSync ?? fsReadFileSync,
    statSync: io.statSync ?? fsStatSync,
  }
}

/** Sorted *.md in a directory; an absent/unreadable directory is an empty list. */
function listMarkdown(io, dir) {
  try {
    const entries = io.readdirSync(dir) || []
    return entries.filter((f) => typeof f === 'string' && f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/** Read a file as text, or null. Never throws. */
function readTextOrNull(io, path) {
  try {
    const text = io.readFileSync(path, 'utf8')
    return text == null ? null : String(text)
  } catch {
    return null
  }
}

/** A note file is anything that is not a generated index or the tag registry. */
function isNoteFile(file) {
  return !MEMORY_STRUCTURAL.has(file) && !/^INDEX-.+\.md$/.test(file)
}

/** Frontmatter of a note, or null when it is missing / unparsable (lint owns schema errors). */
function noteFrontmatter(text, file) {
  try {
    return parseNote(text, { file }).frontmatter
  } catch {
    return null
  }
}

/**
 * The note's own line, in whichever generation of the schema wrote it.
 *
 * A schema-v2 record states its subject in `claim`; the v1 note that came before it used
 * `description`. This read model was written against v1 and only ever looked at
 * `description`, so on the founder's own corpus — 34 notes, `generation: v2`, nothing pending
 * — every row came back with an empty title and the screen showed a column of bare file ids.
 * The corpus was not wrong and no migration was outstanding: the reader simply predated the
 * format it was reading.
 *
 * v2 first, v1 as the fallback, because older corpora exist and both are legitimate.
 */
function noteTitle(fm) {
  for (const value of [fm && fm.claim, fm && fm.description]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, MEMORY_TITLE_CAP)
  }
  return ''
}

/**
 * The tag surface of ONE note — what the «О чём записи» cloud counts.
 *
 * A v2 record carries two facet fields and they are two different vocabularies: `retrieval.areas`
 * is the topical axis the loader itself retrieves by (`load --tags os,memory`), and `applies_to`
 * is the narrower scope a claim is about. The areas are therefore the tag surface, and
 * `applies_to` stands in for a record that declares no areas — mixing both into one cloud would
 * put two vocabularies under one heading. `tags` is the v1 spelling and stays as the last fallback.
 *
 * The first non-empty list wins per note; nothing is merged.
 */
function noteTagSurface(fm) {
  const areas = fm && fm.retrieval && Array.isArray(fm.retrieval.areas) ? fm.retrieval.areas : null
  for (const list of [areas, fm && fm.applies_to, fm && fm.tags]) {
    if (!Array.isArray(list)) continue
    const clean = list.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    if (clean.length > 0) return clean
  }
  return []
}

/** Last-modified ms, or 0 when the platform / seam cannot say. */
function mtimeOf(io, path) {
  try {
    const st = io.statSync(path)
    const ms = Number(st && st.mtimeMs)
    return Number.isFinite(ms) ? ms : 0
  } catch {
    return 0
  }
}

/**
 * deriveMemory({memoryDir, fsImpl}) → {noteCount, coreSize, tags, recent} | {absent:true}.
 *
 * THE CORPUS AS A SURFACE, NOT A WINDOW. The «Память» screen answers how much there is,
 * what it is about, and what moved recently — a note's BODY is deliberately not in the
 * contract. Reading a note is a terminal's job with the whole loader behind it; a LAN
 * payload that carried note bodies would be a copy of the memory tree leaving the machine
 * every few seconds for no screen that needed it.
 *
 * The cost is bounded by the note count, and notes are small by budget (the corpus lint
 * caps them), so this stays a few milliseconds on a poll that already talks to Postgres.
 *
 * @param {{memoryDir?:string, fsImpl?:object}} [args]
 * @returns {object}
 */
export function deriveMemory({ memoryDir, fsImpl } = {}) {
  if (!memoryDir) return { absent: true } // nothing wired — a valid state, not an error
  const io = fsSeam(fsImpl)

  const index = readTextOrNull(io, join(memoryDir, 'MEMORY.md'))
  const coreSize = index == null ? 0 : Buffer.byteLength(index, 'utf8')

  const tagCounts = new Map()
  const notes = []
  for (const file of listMarkdown(io, memoryDir)) {
    if (!isNoteFile(file)) continue
    const path = join(memoryDir, file)
    const text = readTextOrNull(io, path)
    if (text == null) continue
    const fm = noteFrontmatter(text, file)
    if (!fm) continue
    for (const tag of noteTagSurface(fm)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
    notes.push({
      id: file.replace(/\.md$/, ''),
      title: noteTitle(fm),
      mtimeMs: mtimeOf(io, path),
    })
  }

  if (notes.length === 0 && coreSize === 0) return { absent: true } // a fresh install

  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  const recent = notes
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, MEMORY_RECENT_CAP)
    .map(({ id, title }) => ({ id, title }))

  return { noteCount: notes.length, coreSize, tags, recent }
}

/**
 * fencedEvidence(section) → the concatenated content of the section's fenced blocks, or ''.
 *
 * THIS IS THE REDACTION BOUNDARY, and it is a whitelist. The distillation writes its mined
 * material inside fenced `untrusted-evidence` blocks AFTER running it through the secret
 * scrubber; anything a human typed around those fences went through no scrubber at all.
 * Publishing only what is inside a fence means the payload can carry a decision the miner
 * produced and can NEVER carry a sentence nobody redacted.
 */
function fencedEvidence(section) {
  const text = String(section ?? '')
  const re = /```[^\n]*\n([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim())
  return blocks.join('\n').slice(0, STYLE_TEXT_CAP).trim()
}

/** The exam score ledger, oldest first. A malformed row is skipped, never thrown on. */
function readScoreLedger(io, memoryDir) {
  const raw = readTextOrNull(io, join(memoryDir, 'exam', 'scores.jsonl'))
  if (raw == null) return []
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      /* a ledger line that will not parse is a skipped row, not a broken screen */
    }
  }
  return rows
}

/** One training row of the history: when, over how many situations, and how it scored. */
function toTraining(row) {
  const n = (v) => Number(v) || 0
  return {
    date: String(row.ts ?? '').slice(0, 10),
    decisionsCount: n(row.total),
    ...(row.policyVersion != null ? { policyVersion: row.policyVersion } : {}),
    summary: `совпадение ${n(row.matchRate)}% · ${n(row.match)} / ${n(row.partial)} / ${n(row.miss)}`,
  }
}

/** The distillation drafts, newest id first, as redacted situation → decision → why. */
function readDecisionDrafts(io, memoryDir) {
  const draftsDir = join(memoryDir, 'drafts')
  const out = []
  for (const file of listMarkdown(io, draftsDir)) {
    if (!isNoteFile(file)) continue
    const text = readTextOrNull(io, join(draftsDir, file))
    if (text == null) continue
    const fm = noteFrontmatter(text, file)
    if (!fm || fm.kind !== 'founder-decision') continue
    const id = file.replace(/\.md$/, '')
    const pair = parseNoteToPair(id, text) // the SAME split the exam builder uses
    const situation = fencedEvidence(pair.situation)
    const decision = fencedEvidence(pair.decision)
    if (!situation && !decision) continue // nothing redacted to show — publish nothing
    out.push({ id, situation, decision, why: fencedEvidence(pair.why) })
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, STYLE_DECISIONS_CAP)
}

/**
 * deriveStyle({memoryDir, fsImpl}) → {policyVersion?, matchRate?, trainings, decisions}
 * | {absent:true}.
 *
 * THE SNAPSHOT AS METRICS AND ALREADY-REDACTED QUOTES. Two artifacts feed it and no third:
 * the exam score ledger (the training history keyed by policy version, and the latest match
 * rate — fidelity is MEASURED, not asserted) and the distillation's own drafts.
 *
 * WHAT IT NEVER OPENS, BY CONSTRUCTION:
 *   - the session transcripts. The raw material of the corpus never leaves the disk; this
 *     reader does not know where it lives and has no code path to it.
 *   - the exam ANSWER KEY (`exam-<date>-key.jsonl`). The blind-exam invariant is a path
 *     convention, and a payload that quietly read the key would dissolve it. This reader
 *     opens exactly one file under `exam/`: the score ledger.
 *   - the corpus root. A promoted, hand-written decision note went through no scrubber;
 *     only the miner's drafts are redacted artifacts.
 *
 * A metric the artifacts do not carry is OMITTED rather than invented: an install that has
 * never been graded has no matchRate, and a fresh machine has no style at all.
 *
 * КТО ЭТО ЧИТАЕТ СЕГОДНЯ — НИКТО, И ЭТО СКАЗАНО ЗДЕСЬ ВСЛУХ. Единственным читателем был экран
 * «Мой стиль», и владелец снял его 28.08.2026 словами «мой стиль вообще не работает… убери
 * пока экран»: витрина без провода — ни одной своей двери, и ни один промпт этих чисел не
 * читал (`resolvePolicyVoice` в chat.mjs берёт готовый дистиллят с диска, а не этот счёт).
 *
 * ПОЧЕМУ СЧЁТ ВСЁ РАВНО ОСТАЁТСЯ. Артефакты под ним живые: экзамен продолжает оцениваться, а
 * дистилляция — писать черновики решений, и голос беседы уже сегодня встаёт на их результат.
 * Снят ЭКРАН, а не обучение. Цена сказана честно: это чтение двух файлов на КАЖДОМ чтении
 * состояния, то есть на каждом опросе окна, ради поля, которое сейчас никто не открывает.
 * Поэтому решение временное: появится читатель (строка стиля в промпте или вернувшийся экран)
 * — он назовётся здесь; не появится — удаляются вместе и эта функция, и поле `style` в
 * payload, и типы под него.
 *
 * @param {{memoryDir?:string, fsImpl?:object}} [args]
 * @returns {object}
 */
export function deriveStyle({ memoryDir, fsImpl } = {}) {
  if (!memoryDir) return { absent: true }
  const io = fsSeam(fsImpl)

  const scores = readScoreLedger(io, memoryDir)
  const decisions = readDecisionDrafts(io, memoryDir)
  if (scores.length === 0 && decisions.length === 0) return { absent: true } // never taught

  const last = scores.length ? scores[scores.length - 1] : null
  const matchRate = last == null ? null : Number(last.matchRate)
  return {
    ...(last && last.policyVersion != null ? { policyVersion: last.policyVersion } : {}),
    ...(Number.isFinite(matchRate) ? { matchRate } : {}),
    trainings: scores.slice().reverse().slice(0, STYLE_TRAININGS_CAP).map(toTraining),
    decisions,
  }
}

/**
 * ONE window, as it goes on the wire.
 *
 * `status` is always one of three words, so a screen never has to tell an absent field from a
 * false one. `resetsAt` travels as an ISO string because that is what every clock face in the
 * window already reads. `pct` is null unless the vendor itself sent a fraction — the screens
 * draw a number only when there is a number, and there is none today.
 */
function windowFact(fact) {
  const f = fact && typeof fact === 'object' ? fact : {}
  const status = f.status === 'open' || f.status === 'exhausted' ? f.status : 'unknown'
  const resetsAt = toMs(f.resetsAt)
  return {
    status,
    resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
    // An absent percentage must stay absent. `numOrNull(null)` is 0, because Number(null) is 0 —
    // so an unknown window went on the wire as «0%», which is the one wrong answer this whole
    // change exists to stop: a zero bar is read as «the quota is free».
    pct: f.pct == null ? null : numOrNull(f.pct),
  }
}

/** A payload window bar: the two windows, plus a refusal when one is standing. */
function windowBar(win) {
  return {
    fiveHour: windowFact(win.fiveHour),
    week: windowFact(win.week),
    ...(win.closedUntil != null ? { closedUntil: win.closedUntil } : {}),
  }
}

/**
 * The TERMINAL'S OWN window reading, as it goes on the wire.
 *
 * It is the one place a real percentage comes from: the provider pipes it to the status line
 * command of the person's own terminal, and that reading counts the sessions he ran himself —
 * which on a real machine is most of them. It travels as its own block rather than as an
 * account's bar because nothing in that payload names an account, and pinning it on one would
 * be a guess.
 *
 * `observed` distinguishes «never heard» from «heard, but that window has since turned over»,
 * and `observedAt` survives the expiry so the screen can name the moment instead of drawing a
 * zero. Absent seam → honestly empty, never an error.
 */
function terminalBar(read) {
  const empty = { observed: false, observedAt: null, fiveHour: windowFact(null), week: windowFact(null) }
  if (typeof read !== 'function') return empty
  try {
    const t = read()
    if (!t || typeof t !== 'object') return empty
    return {
      observed: !!t.observed,
      observedAt: typeof t.observedAt === 'string' ? t.observedAt : null,
      fiveHour: windowFact(t.fiveHour),
      week: windowFact(t.week),
    }
  } catch {
    return empty
  }
}

// ══════════════ the CONNECTED PROJECT's corpus — a surface over a foreign tree ═══════════
//
// The window shows a project the daemon does not own: its
// memory, READ-ONLY, plus — when the corpus is still in the older format — a per-file
// preview of what a migration would change. Three properties are load-bearing:
//
//   - THE READERS ARE INJECTED. `readProjectMemory` and `previewProjectMigration` live in
//     project-sync.mjs, which imports `deriveMemory` from THIS file. Injecting them instead
//     of importing them keeps that edge one-way; a static import back would make the two
//     modules a cycle, and the composition root is where a daemon module learns about
//     another one anyway.
//   - LIVENESS IS NEVER ASSUMED. The section says `polling` unless the watcher seam actively
//     says `live`. A screen that claims live and shows stale is the failure the watcher's
//     whole reconcile exists to prevent, so the DEFAULT here is the modest claim.
//   - READ-ONLY IS ON THE WIRE. `readOnly: true` is carried rather than left implicit, so
//     the screen states the boundary from the payload rather than from a hard-coded belief
//     about what the daemon happens to do today.

/**
 * The connected project: the ACTIVE registry entry, and only when it names a folder on disk.
 * A registry entry with no `path` is a label for grouping tasks, not a connection — reading
 * it as one would be how the screen ends up showing a corpus that belongs to nobody.
 */
function connectedProject(config = {}) {
  const list = Array.isArray(config.projects) ? config.projects : []
  if (list.length === 0) return null
  const activeId = config.activeProject ?? (list[0] && list[0].id)
  const entry = list.find((p) => p && p.id === activeId) || null
  if (!entry || typeof entry.path !== 'string' || entry.path.trim() === '') return null
  return { id: entry.id, name: entry.name ?? entry.id, dir: entry.path }
}

/** The watcher's own word on whether it is watching or merely polling. Fail-modest. */
function resolveLiveness(seam) {
  try {
    const v = typeof seam === 'function' ? seam() : seam
    return v === 'live' ? 'live' : 'polling'
  } catch {
    return 'polling' // a seam that throws has told us nothing, and nothing is not «live»
  }
}

/**
 * deriveProjectMemory(deps) → the connected project's corpus surface, or {absent:true}.
 *
 * Nothing connected, nothing readable, no corpus, or a reader that throws — all four are the
 * SAME declared-absent value, because from the screen's chair they are the same fact: there
 * is no project memory to show. None of them is an error and none of them wedges the poll.
 *
 * The returned surface carries no path and no note body; that is the contract `deriveMemory`
 * already holds and this section inherits it unchanged.
 *
 * @param {{config?:object, readProjectMemory?:Function, previewProjectMigration?:Function,
 *          projectLiveness?:Function|string, migrationStagingDir?:string, fsImpl?:object,
 *          clock?:Function}} [deps]
 * @returns {object}
 */
export function deriveProjectMemory(deps = {}) {
  const project = connectedProject(deps.config || {})
  if (!project) return { absent: true }
  if (typeof deps.readProjectMemory !== 'function') return { absent: true }

  let surface
  try {
    surface = deps.readProjectMemory({ projectDir: project.dir, fsImpl: deps.fsImpl })
  } catch {
    return { absent: true }
  }
  if (!surface || surface.absent) return { absent: true }

  const out = {
    project: { id: project.id, name: project.name },
    liveness: resolveLiveness(deps.projectLiveness),
    readOnly: true,
    ...surface,
  }

  // The preview is offered ONLY when there is something to migrate: a corpus already in the
  // current format pays nothing for this section existing.
  if (surface.migratable && typeof deps.previewProjectMigration === 'function') {
    try {
      const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
      const migration = deps.previewProjectMigration({
        projectDir: project.dir,
        stagingDir: deps.migrationStagingDir,
        now: new Date(clock()),
      })
      if (migration) out.migration = migration
    } catch {
      /* a preview that cannot run is a section the screen does not show, never a broken poll */
    }
  }
  return out
}

// ══════════════ THE WORKBENCH: DRAFTS, RESERVATIONS, THE BACKLOG ════════════════
//
// Three read models over the CONNECTED project — the same project «Память» already shows,
// resolved through the same `connectedProject`. That is not a detail: the drafts panel and the
// corpus panel sit on one screen, and a drafts list read out of a different tree than the
// corpus beside it would be a screen where two halves disagree and neither says so.
//
// ALL THREE DERIVE AND STORE NOTHING. A draft is a file the write pipeline put in `drafts/`; a
// reservation is a directory in `.sma/claims`; a backlog line is a line of a markdown file a
// person edits by hand. Every one of them changes without this daemon's knowledge — which is
// exactly why none of them may be remembered here.
//
// AND NONE OF THEM WRITES. Applying a draft, clearing a reservation and putting a backlog line
// into the queue are three other doors, each standing in front of a mechanism that already
// exists. What is here is only the reading.

/** How many drafts / backlog rows one answer carries — a panel, never a feed. */
const DRAFTS_CAP = 200
const BACKLOG_CAP = 500

/**
 * How much of a draft travels as its preview.
 *
 * A person agreeing to a lesson is agreeing to WHAT IT SAYS, so the preview is the record
 * itself rather than its title. It is capped because a card is not a document — and a draft
 * past this size is one a person should open in an editor before saying yes to it.
 */
const DRAFT_PREVIEW_CAP = 16 * 1024

/** Where the corpus of a project sits, and where the pipeline stages what it will not write. */
const CORPUS_SEGMENTS = Object.freeze(['.claude', 'memory'])
const DRAFTS_SEGMENT = 'drafts'

/** The consumed-draft marker the apply doors leave behind — a spent draft is not a draft. */
const APPLIED_DRAFT_SUFFIX = '.applied.md'

/**
 * A draft's addressable name: the file's own stem, bounded so it can only ever name a file
 * INSIDE the drafts directory. No separator, no leading dot — the same posture the record-id
 * law of the write pipeline holds, for the same reason: this string is joined onto a path.
 */
const DRAFT_STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * ONE BACKLOG LINE, BY SHAPE AND NEVER BY DICTIONARY.
 *
 * A bulleted entry, optionally carrying a task checkbox, whose bold lead is an identifier:
 * some letters, a dash, a number. WHICH letters is the project's business — this daemon does
 * not know what they mean and must never grow an opinion about them, because the moment it
 * carries a list of known prefixes it is a window that works for one backlog and silently
 * shows nothing for everybody else's.
 */
export const BACKLOG_ID_RE = /^[A-Z][A-Z0-9]{1,7}-\d{1,6}$/
const BACKLOG_LINE_RE = /^[-*]\s+(?:\[([ xX])\]\s+)?\*\*([A-Z][A-Z0-9]{1,7}-\d{1,6})\*\*\s*(.*)$/

/** A `key:2026-08-07`-shaped inline-code tag — a date by SHAPE, not by the word in front. */
const BACKLOG_AGE_TAG_RE = /`([A-Za-z][A-Za-z0-9_-]{0,31}:\d{4}-\d{2}-\d{2})`/

/** A row's own text is a line on a board, not the paragraph the file keeps behind it. */
const BACKLOG_TITLE_CAP = 400

/**
 * How long ago, in the words a person uses.
 *
 * ONE implementation for every «age» on the workbench (a draft, a session, a reservation),
 * because three of them formatted three ways is how one panel ends up saying «2 ч» beside
 * «2 hours» beside an ISO timestamp. The contract calls this field a string and means a
 * duration; a timestamp under that name would be a fact the screen has to undo.
 */
function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч`
  return `${Math.floor(hours / 24)} дн`
}

/** The «now» every age on this screen is measured against — injected like everywhere else. */
function nowOf(clock) {
  return typeof clock === 'function' ? clock() : Date.now()
}

/**
 * deriveMemoryDrafts({config, fsImpl, clock}) → {drafts:[{id, targetFile, preview, age}]}.
 *
 * Every staged record of the connected project's corpus, read off disk on every call. A
 * project that is not connected, a corpus that has no drafts directory and a directory that
 * cannot be read are all the SAME answer — an empty list — because from the screen's chair
 * they are the same fact and none of them is an error.
 *
 * A draft that cannot be parsed still travels: it is a file somebody has to look at, and a
 * list that silently dropped it would be a list that hides the one row that needs a person.
 * Its `targetFile` then falls back to its own name, which is the honest answer to «what would
 * this become» for a file whose frontmatter nobody can read.
 *
 * @param {{config?:object, fsImpl?:object, clock?:Function}} [deps]
 * @returns {{drafts:object[]}}
 */
export function deriveMemoryDrafts({ config, fsImpl, clock } = {}) {
  const project = connectedProject(config || {})
  if (!project) return { drafts: [] }

  const io = fsSeam(fsImpl)
  const dir = join(project.dir, ...CORPUS_SEGMENTS, DRAFTS_SEGMENT)
  const now = nowOf(clock)

  const names = safeList(io, dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith(APPLIED_DRAFT_SUFFIX))
    .sort()
    .slice(0, DRAFTS_CAP)

  const drafts = []
  for (const name of names) {
    const id = name.slice(0, -3)
    // A name this daemon could not hand back to the apply door is a name it does not show:
    // a row a person can see and cannot act on is worse than a row that is not there.
    if (!DRAFT_STEM_RE.test(id)) continue

    let text = ''
    try {
      text = String(io.readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue // the file went away between the listing and the read — it is simply not a row
    }

    let targetFile = name
    let kind = ''
    try {
      const parsed = parseNote(text, { file: name })
      const fm = (parsed && parsed.frontmatter) || null
      const recordId = fm ? String(fm.id ?? '').trim() : ''
      if (recordId !== '') targetFile = `${recordId}.md`
      kind = fm ? String(fm.draft_kind ?? '').trim() : ''
    } catch {
      /* an unparseable draft keeps its own name as its target — see the header */
    }

    let ageMs = 0
    try {
      const st = io.statSync(join(dir, name))
      const mtime = st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : NaN
      ageMs = Number.isFinite(mtime) ? now - mtime : 0
    } catch {
      ageMs = 0
    }

    drafts.push({
      id,
      targetFile,
      // THE WHOLE FILE IS THE DIFF. The apply path refuses to write over a record that already
      // exists, so what a person is agreeing to is a NEW note — every line of it added. There
      // is no other side to show, and rendering an empty left column would invent one.
      preview: text.length > DRAFT_PREVIEW_CAP ? text.slice(0, DRAFT_PREVIEW_CAP) : text,
      age: humanAge(ageMs),
      // WHICH DOOR OWNS THIS DRAFT, said out loud on the row.
      //
      // A corpus keeps drafts of more than one kind, and the apply door in front of this list
      // is the STAGED-RECORD one — the pipeline refuses anything else, by name and correctly. A
      // list that did not carry the kind would be a panel of rows whose button always fails,
      // and the reader would learn why only by pressing it. `applicable` is not a second
      // decision: the pipeline still decides, and this is the same fact read early so a screen
      // can show the difference instead of discovering it.
      kind,
      applicable: kind === PIPELINE_DRAFT_KIND,
    })
  }
  return { drafts }
}

/**
 * deriveCoordination({config, readLedger, clock}) → {sessions, claims, collisions}.
 *
 * WHO ELSE HAS THIS CHECKOUT OPEN, what they reserved before touching it, and where two
 * reservations met. The ledger itself is read by the INJECTED reader — the composition root
 * hands over the coordination runtime's own readers, so this daemon never grows a second
 * parser of `.sma/`. What happens here is the shaping: explicit-pick, one age format, and
 * NOT ONE PATH from the founder's disk (a glob is a pattern the person typed; a session's
 * file name and a claim's directory are this machine's business).
 *
 * @param {{config?:object, readLedger?:Function, clock?:Function}} [deps]
 * @returns {{sessions:object[], claims:object[], collisions:object[]}}
 */
export async function deriveCoordination({ config, readLedger, clock } = {}) {
  const empty = { sessions: [], claims: [], collisions: [] }
  const project = connectedProject(config || {})
  if (!project || typeof readLedger !== 'function') return empty

  // The production reader is ASYNC — it imports the project runtime's own readers — and for
  // one release this derive consumed its Promise as though it were the ledger: `.sessions`
  // of a Promise is undefined, so the panel said «кроме Вас никого» while a session was
  // editing files in the checkout (QA D3, 11.08.2026). The await is the fix. The catch
  // below is thereby REACHABLE for the first time, and it no longer launders a failure:
  // an unreadable ledger is reported as such — the door answers 503 and the screen's
  // error branch shows it — never passed off as an empty checkout.
  let ledger
  try {
    ledger = await readLedger({ projectDir: project.dir })
  } catch {
    return { ...empty, unreadable: true }
  }
  if (!ledger || typeof ledger !== 'object') return empty

  const now = nowOf(clock)
  const list = (v) => (Array.isArray(v) ? v : [])

  return {
    sessions: list(ledger.sessions).map((s) => ({
      id: String((s && s.id) ?? ''),
      title: String((s && s.title) ?? ''),
      age: humanAge(Number.isFinite(s && s.ageMs) ? s.ageMs : now - toMs((s && s.since) ?? NaN)),
    })),
    claims: list(ledger.claims).map((c) => ({
      name: String((c && c.name) ?? ''),
      globs: list(c && c.globs).map(String),
      desc: String((c && c.desc) ?? ''),
      age: humanAge(Number.isFinite(c && c.ageMs) ? c.ageMs : now - toMs((c && c.since) ?? NaN)),
    })),
    collisions: list(ledger.collisions).map((x) => ({
      a: String((x && x.a) ?? ''),
      b: String((x && x.b) ?? ''),
      overlap: list(x && x.overlap).map(String),
    })),
  }
}

/**
 * deriveBacklog({config, fsImpl}) → {rows:[{id, title, ageLine}]}.
 *
 * The project's own `.planning/BACKLOG.md`, read as rows. NO FILE IS AN EMPTY LIST, honestly:
 * a project that keeps no backlog is not a broken project, and a 404 here would make the panel
 * look like a fault instead of an absence.
 *
 * The parser knows one SHAPE and no vocabulary (see BACKLOG_LINE_RE). A line that does not
 * carry an identifier is not a row — it is prose, a heading or a note to self, and the board
 * shows what the file marked as an entry rather than everything it happens to contain.
 *
 * @param {{config?:object, fsImpl?:object}} [deps]
 * @returns {{rows:object[]}}
 */
export function deriveBacklog({ config, fsImpl } = {}) {
  const project = connectedProject(config || {})
  if (!project) return { rows: [] }

  const io = fsSeam(fsImpl)
  let text = ''
  try {
    text = String(io.readFileSync(join(project.dir, '.planning', 'BACKLOG.md'), 'utf8'))
  } catch {
    return { rows: [] }
  }

  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const m = BACKLOG_LINE_RE.exec(line)
    if (!m) continue
    // A finished line is not work waiting to be done. The file's own checkbox says so, and
    // dropping it here is the difference between a board and a history.
    if (m[1] && m[1].toLowerCase() === 'x') continue
    const tail = String(m[3] ?? '').trim()
    const age = BACKLOG_AGE_TAG_RE.exec(tail)
    rows.push({
      id: m[2],
      title: tail.replace(/^[·—–\-:]\s*/, '').slice(0, BACKLOG_TITLE_CAP),
      ageLine: age ? age[1] : '',
    })
    if (rows.length >= BACKLOG_CAP) break
  }
  return { rows }
}

// ══════════════ THE PHASE CYCLE, DERIVED FROM THE DIRECTORY IT LIVES IN ══════════
//
// The card of a phase is READ, never remembered. Every number on it — which stages are done,
// how many questions are waiting, which plans exist and what a person said about each line of
// the acceptance — is counted off `.planning/phases/<dir>` at the moment the screen asks, for
// the same reason the discussion engine stores nothing: a phase is worked on from a terminal
// as often as from this window, and a daemon that kept its own copy would be the one holding
// the stale one.
//
// TWO RULES ARE BORROWED, NOT RESTATED. «Which directory is phase N» is `findPhaseDir`, the
// same function the daemon's exit gate finds a stage's document with. «Which document proves
// which stage» is `STAGE_ARTIFACTS`, the same map that gate closes a stage on. A card that
// answered either question its own way would show a stage as finished while the machine kept
// failing it — which is worse than showing nothing, because it looks like an answer.
//
// NO PATH ON THE FOUNDER'S DISK LEAVES HERE. What travels for a document is the name it has
// and the REPOSITORY-RELATIVE path the artefact door accepts, rooted at `.planning/` — which
// is the only root that door opens. The directory this all sits under stays on this side.

/** The four stages, in the order a phase goes through them. */
const PHASE_STAGES = Object.freeze(['discuss', 'plan', 'execute', 'verify'])

/** Where phases live under a checkout, in the forward-slashed form the artefact door takes. */
const PHASES_PATH = '.planning/phases'

/** A UAT file of a phase: the acceptance record `/sma-verify-work` keeps. */
const UAT_FILE_RE = /-UAT[^/\\]*\.md$/

/** One test block of that file: `### N. Name` / `expected:` / `result:` (+ an optional note). */
const UAT_ITEM_RE =
  /^###\s*(\d+)\.\s*(.+?)\s*$\n(?:expected:[^\n]*\n)?result:\s*\[?([A-Za-z_]+)\]?\s*$(?:\n(?:reported|reason):\s*([^\n]*))?/gm

/**
 * What a recorded UAT result means as a verdict.
 *
 * The template's own vocabulary is pass / issue / pending / skipped / blocked, and the door
 * that writes a verdict writes THAT vocabulary — `fail` is the word the screen uses and
 * `issue` is the word the file uses, and translating at the boundary is what keeps the file
 * readable by the workflow that owns it. Anything not yet decided is `null`, never `fail`:
 * «nobody has looked at this» and «somebody looked and it was broken» are different facts.
 */
function uatVerdictOf(result) {
  if (result === 'pass') return 'pass'
  if (result === 'issue' || result === 'fail') return 'fail'
  return null
}

/** Read a directory, or nothing at all. An unreadable phase root is «no phases», not a fault. */
function safeList(io, dir) {
  try {
    const entries = io.readdirSync(dir)
    return Array.isArray(entries) ? entries.map(String) : []
  } catch {
    return []
  }
}

/** Is this entry of the phases root a directory? An unstattable entry is not one. */
function isDir(io, path) {
  try {
    const st = io.statSync(path)
    return !!(st && typeof st.isDirectory === 'function' && st.isDirectory())
  } catch {
    return false
  }
}

/**
 * The human half of a phase directory's name: `phase-12-front-workplace` → `front-workplace`.
 * A directory that carries no number is its own name — inventing one would be a guess.
 */
function phaseNameOf(dir) {
  const m = String(dir).match(/^(?:phase-)?\d+(?:\.\d+)?[-_.]?(.*)$/i)
  const rest = m && m[1] ? m[1].trim() : ''
  return rest === '' ? String(dir) : rest
}

/** `front-workplace` → `front workplace`. A slug is a file name; a screen is read by a person. */
function readableSlug(slug) {
  return String(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** `### Phase 12: SMA — Рабочее место во фронте` → title, keyed by phase number. */
const ROADMAP_HEADING = /^#{2,4}\s*Phase\s+(\d+(?:\.\d+)?)\s*[:.—-]\s*(.+?)\s*$/i

/**
 * A title that OPENS with a bracketed aside is carrying bookkeeping in front of its name —
 * «(экс-49.7) SMA V5.1 — Импорт…», «(new, split out by the audit) …». The aside is written for
 * whoever maintains the roadmap; the person looking at the screen wants the name. Only a
 * LEADING group is removed, and only when something is left after it: a bracket in the middle
 * is part of the sentence, and a title that is nothing but an aside keeps it rather than
 * becoming blank.
 */
function stripLeadingAside(title) {
  const text = String(title).trim()
  const m = text.match(/^\([^)]*\)\s*(.+)$/)
  return m && m[1].trim() !== '' ? m[1].trim() : text
}

/**
 * roadmapTitles(projectDir, io) → Map(phase number → the title the ROADMAP gives it).
 *
 * WHY THE ROADMAP AND NOT THE DIRECTORY NAME. A directory name is a file-system identifier and
 * it reads like one: `11-49-9-sma-v5-3`, `49.2-sma-v3-trust-spine`. Shown on a screen that is
 * the whole point of not using a terminal, that is noise — the person recognises none of their
 * own work in it. The roadmap already holds the phase's name in the words its author chose,
 * and those words are what the person is looking for.
 *
 * Read once per derive, never cached: the roadmap is edited by hand and a screen that shows
 * yesterday's title is a smaller bug than one nobody can explain. A project without a roadmap,
 * or with headings in another shape, simply gets an empty map and the fallback below.
 */
function roadmapTitles(projectDir, io) {
  const byNumber = new Map()
  const headings = []

  for (const rel of ['ROADMAP.md', 'ROADMAP.ru.md']) {
    let raw = ''
    try {
      raw = String(io.readFileSync(join(projectDir, '.planning', rel), 'utf8'))
    } catch {
      continue // no roadmap of that name — not an error, just no titles from it
    }
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(ROADMAP_HEADING)
      if (!m) continue
      const n = Number(m[1])
      const full = m[2].trim()
      headings.push({ n, full })
      // FIRST heading wins: a roadmap that mentions a phase twice is naming it once and
      // referring to it afterwards.
      //
      // `lead` — абзац, который стоит ПОД этим заголовком. Он читается здесь, тем же единственным
      // чтением файла, потому что нужен он ровно тогда, когда у фазы нет своего CONTEXT.md, и
      // второе открытие того же роадмапа ради одной строки было бы вторым источником одного факта.
      if (!byNumber.has(n)) {
        byNumber.set(n, { n, title: stripLeadingAside(full), lead: paragraphAt(lines, i + 1) })
      }
    }
  }

  // SECOND PASS — the old number a phase used to carry, when the roadmap says so plainly.
  //
  // Directories outlive renumbering: `49.2-sma-v3-trust-spine` is «Phase 3» in the roadmap now,
  // and its heading says which one it used to be — «(экс-49.2)». Reading that turns six historic
  // directories from slugs into names.
  //
  // THE RULE IS DELIBERATELY NARROW, because the naive version is WRONG here and it is worth
  // saying how. Phase 8's aside reads «(новая — «дни 1–30» канона, выделена из экс-49.7 аудитом
  // K1)» — it MENTIONS 49.7, which belongs to Phase 9, and a rule that scanned asides for any
  // number would have given Phase 9's directory Phase 8's name. So an alias is taken only from a
  // SHORT aside carrying EXACTLY ONE number: prose is refused, and «is this an identifier or a
  // sentence» is decided by shape rather than by hope. A number already claimed by a heading of
  // its own is never overwritten — second pass, and primaries win.
  for (const { n, full } of headings) {
    const alias = shortAsideNumber(full)
    if (alias === null || byNumber.has(alias)) continue
    const primary = byNumber.get(n)
    if (primary) byNumber.set(alias, primary)
  }

  return byNumber
}

/**
 * `(экс-49.2)` → 49.2. `(ex-3)` → 3. Long prose, or a bracket holding two numbers, or none →
 * null. Fourteen characters is the whole of the judgement: an identifier is short, a sentence
 * is not.
 */
function shortAsideNumber(title) {
  const m = String(title).match(/^\(([^)]{0,14})\)/)
  if (!m) return null
  const numbers = m[1].match(/\d+(?:\.\d+)?/g)
  return numbers && numbers.length === 1 ? Number(numbers[0]) : null
}

/**
 * ОПИСАНИЕ ФАЗЫ СЛОВАМИ — сколько его вообще едет и откуда оно берётся.
 *
 * Абзац, а не документ: карточка отвечает на вопрос «о чём эта фаза», а сам файл открывается
 * одним кликом через дверь артефактов — то единственное место, где чтение файла ограничено.
 * Потолок здесь по той же причине, что у шапки плана рядом: файл на диске написан тем, кто его
 * написал, и абзац, приехавший на сорок тысяч знаков, должен стоить ограниченной работы.
 */
const DESCRIPTION_CAP = 600
const DESCRIPTION_HEAD_CHARS = 8192

/** `- **слово** — текст` → `слово — текст`. Разметка снимается, слова остаются. */
function stripMarkdownLine(line) {
  return String(line)
    .replace(/^[>\s]*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim()
}

/**
 * paragraphAt(lines, from) → первый связный абзац начиная с этой строки, или null.
 *
 * Пустые строки и заголовки ПЕРЕД абзацем пропускаются (описание почти всегда стоит под
 * названием), пустая строка или заголовок ПОСЛЕ его начала — конец абзаца. Ничего не
 * додумывается: файл, в котором после этого места только заголовки, честно отдаёт null.
 */
function paragraphAt(lines, from) {
  const out = []
  for (let i = Math.max(0, from); i < lines.length; i += 1) {
    const line = String(lines[i] ?? '').trim()
    const blank = line === '' || line.startsWith('#')
    if (out.length === 0) {
      if (blank) continue
    } else if (blank) {
      break
    }
    const words = stripMarkdownLine(line)
    if (words !== '') out.push(words)
  }
  const text = out.join(' ').trim()
  if (text === '') return null
  return text.length > DESCRIPTION_CAP ? `${text.slice(0, DESCRIPTION_CAP).trimEnd()}…` : text
}

/** Первый абзац файла, мимо его собственной шапки-фронтматтера. */
function firstParagraph(text) {
  if (text == null) return null
  const lines = String(text).slice(0, DESCRIPTION_HEAD_CHARS).split(/\r?\n/)
  let from = 0
  // Фронтматтер — это учётная запись файла, а не рассказ о фазе.
  if ((lines[0] ?? '').trim() === '---') {
    from = 1
    while (from < lines.length && lines[from].trim() !== '---') from += 1
    from += 1
  }
  return paragraphAt(lines, from)
}

/**
 * phaseDescription(...) → {text, source} — о чём эта фаза, СЛОВАМИ ЕЁ СОБСТВЕННОГО ДОКУМЕНТА,
 * или null, когда сказать нечем.
 *
 * ИСТОЧНИК И ЗАПАСНОЙ ПУТЬ НАЗВАНЫ ЗДЕСЬ ОДИН РАЗ. Основной — `-CONTEXT.md` самой фазы: это
 * документ, которым кончается её обсуждение, и в нём стоят слова владельца, а не пересказ.
 * Запасной — абзац роадмапа под заголовком этой фазы: фаза, обсуждение которой ещё не дошло до
 * контекста, всё равно чем-то названа. Ни один из двух не выдумывается: нет обоих — `null`, и
 * экран говорит «описания нет» словами вместо пустого места, которое читается как поломка.
 *
 * `source` едет вместе с текстом, потому что «это из контекста фазы» и «это из роадмапа» —
 * разные по весу утверждения, и человек имеет право видеть, какое из них перед ним.
 */
function phaseDescription(io, root, dir, files, titles) {
  const contextName = files.find((f) => f.endsWith(STAGE_ARTIFACTS.discuss.produces))
  if (contextName) {
    const text = firstParagraph(readTextOrNull(io, join(root, dir, contextName)))
    if (text) return { text, source: 'context' }
  }
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  return entry && entry.lead ? { text: entry.lead, source: 'roadmap' } : null
}

/**
 * The name a PERSON should see for a phase directory: its NUMBER, then the roadmap's title
 * when the phase number is in the roadmap, and a readable version of the directory's own slug
 * when it is not.
 *
 * THE NUMBER LEADS, and it is not decoration. A phase is referred to by number in every other
 * surface of this product — the commands take one, the plans are named by one, and a person
 * saying «двенадцатая» means the number. Taking the title from the roadmap dropped it, because
 * a roadmap heading names the phase and the heading's own number is stripped as part of
 * parsing it; the screen then read as a list of unrelated sentences. Restored here rather than
 * by keeping the slug, so the row says both what it IS and how to ask for it.
 *
 * Never invents: a phase the roadmap does not mention keeps its own words, only spelled with
 * spaces instead of dashes — and still carries its number.
 */
function phaseTitleOf(dir, titles) {
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  // The ROADMAP's number when the roadmap knows this phase — including through the old number
  // its directory still carries. `49.2-sma-v3-trust-spine` is «3 · SMA V3 — The Trust Spine»,
  // because three is what the phase is called now and the directory is only where it lives.
  if (entry) return `${entry.n} · ${entry.title}`
  const words = readableSlug(phaseNameOf(dir))
  return dirNumber === null ? words : `${dirNumber} · ${words}`
}

/**
 * The number a phase is SORTED by: the roadmap's, when it has one, and the directory's when it
 * does not. Newest first is the order a person wants — the phase they are working on is the one
 * they open, and it is the highest number, not the first line of an alphabet.
 *
 * Sorting by directory name put `10-…` before `9-…` and buried phase 12 under six directories
 * numbered 49.x that are, in the roadmap's own numbering, the OLDEST work in the project.
 */
function phaseOrderOf(dir, titles) {
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  if (entry) return entry.n
  return dirNumber === null ? Number.NEGATIVE_INFINITY : dirNumber
}

/** Where a stage stands, read off the files of the phase directory and nothing else. */
function stageStatusOf(files, spec) {
  if (!spec) return 'none'
  if (files.some((f) => f.endsWith(spec.produces))) return 'done'
  // a parked checkpoint is the honest middle state: the stage ran, and it stopped to ask
  if (spec.checkpoint && files.some((f) => f.endsWith(spec.checkpoint))) return 'in-progress'
  return 'none'
}

/** {discuss,plan,execute,verify} → 'none' | 'in-progress' | 'done'. */
function stagesOf(files) {
  const out = {}
  for (const stage of PHASE_STAGES) out[stage] = stageStatusOf(files, STAGE_ARTIFACTS[stage])
  return out
}

/** The documents of one kind, as {name, path} the artefact door will accept. */
function artifactsOf(files, dir, suffix) {
  return files
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((name) => ({ name, path: `${PHASES_PATH}/${dir}/${name}` }))
}

/** The two documents a plan of a phase is made of — named once, so the pairing below cannot drift. */
const PLAN_SUFFIX = '-PLAN.md'
const SUMMARY_SUFFIX = '-SUMMARY.md'

/**
 * HOW MUCH OF A PLAN FILE IS EVEN LOOKED AT. A header is a dozen short lines at the very top;
 * everything past this bound is the plan's body, which a card has no business reading. The
 * limit is here for the same reason the log summariser has one: a file on disk is written by
 * whatever wrote it, and a header that arrives as forty thousand lines must cost a bounded
 * amount of work rather than the whole poll. (The READ itself is the file, exactly as the
 * acceptance document a few lines below is read whole — bounding that too would be a second,
 * different rule for the same directory.)
 */
const PLAN_HEAD_CHARS = 8192
const PLAN_HEAD_LINES = 80
/** A title is a line on a screen; a plan that opened with an essay is cut, never wrapped. */
const PLAN_TITLE_CAP = 200
/** A status is a word from whoever wrote the file — bounded, because it is not our vocabulary. */
const PLAN_STATUS_CAP = 40
/** What a plan whose own header could not be read is called. It is NEVER called «done». */
const PLAN_UNREAD_STATUS = 'не прочитан'

/** `"03"` → `03`; `Живой прогон…` → itself. A quoted scalar is the quoted thing, not the quotes. */
function unquoteScalar(value) {
  const text = String(value ?? '').trim()
  const m = /^(['"])([\s\S]*)\1$/.exec(text)
  return (m ? m[2] : text).trim()
}

/**
 * The three things a plan's own header says about it: {wave, status, title}. `null` when the
 * file could not be read at all — which is a DIFFERENT answer from «read, and it says nothing».
 *
 * WHY THIS IS FOUR LINES OF STRING WORK AND NOT A YAML LIBRARY. The keys wanted are three
 * scalars at the top level of a header, and every parser already accepted into this codebase
 * reads exactly that way. A general parser would bring a dependency, a second failure mode and
 * a much larger blast radius for the sake of shapes no plan file uses. A key nested under
 * another is deliberately NOT found: `wave` is a top-level fact about the plan, and a `wave:`
 * sitting inside somebody's prediction block is not it.
 */
function planHeader(io, path) {
  const text = readTextOrNull(io, path)
  if (text == null) return null
  const out = { wave: null, status: null, title: null }
  const lines = text.slice(0, PLAN_HEAD_CHARS).split(/\r?\n/)
  // No opening fence is «this plan states nothing about itself», not a torn file: a plan
  // written before headers existed is still a plan, and it still belongs on the card.
  if ((lines[0] ?? '').trim() !== '---') return out
  for (let i = 1; i < lines.length && i <= PLAN_HEAD_LINES; i += 1) {
    const line = lines[i]
    if (line.trim() === '---') break
    const m = /^(wave|status|title)\s*:\s*(.+)$/.exec(line)
    if (!m) continue
    const value = unquoteScalar(m[2])
    if (value === '') continue
    if (m[1] === 'wave') {
      const n = Number(value)
      if (Number.isFinite(n)) out.wave = n
    } else if (m[1] === 'status') {
      out.status = value.slice(0, PLAN_STATUS_CAP)
    } else {
      out.title = value.slice(0, PLAN_TITLE_CAP)
    }
  }
  return out
}

/**
 * wavesOf(io, root, dir, files) → [{wave, plans:[{name, path, wave, status, title}]}], by wave
 * ascending.
 *
 * WHY THE CARD OPENS THE PLANS. A phase is EXECUTED in waves — several plans at once, then the
 * next several — and that shape exists in exactly one place: the `wave` line each plan writes
 * in its own header. Listing the plan file names (which is all this card did) shows a flat
 * column of thirteen identifiers and answers none of the questions a person has in front of a
 * running phase: what is going on right now, what it is waiting for, what is left.
 *
 * WHERE A STATUS COMES FROM, and why it is two sources rather than one. A plan states its own
 * `status` when somebody wrote one. Most never do — and for those, the phase directory holds
 * the fact anyway: a plan is finished when its SUMMARY exists beside it, which is the same rule
 * the roadmap's own progress count is made of, and the same documents this card already lists
 * under `summaries`. Neither source present → `null`, so a screen says «нет данных» in words
 * instead of showing a plan as done because nothing said otherwise.
 *
 * FAIL-SOFT, in the posture `progressOf` established next door: an unreadable plan file costs
 * that plan its metadata and NOTHING ELSE. It still appears, under the honest status word
 * «не прочитан», in the group of plans that named no wave. A phase card is how a person finds
 * the phase they need — including the phase they need in order to fix that very file.
 */
function wavesOf(io, root, dir, files) {
  const groups = new Map()
  for (const { name, path } of artifactsOf(files, dir, PLAN_SUFFIX)) {
    const head = planHeader(io, join(root, dir, name))
    const summaryDone = files.includes(`${name.slice(0, -PLAN_SUFFIX.length)}${SUMMARY_SUFFIX}`)
    const plan =
      head === null
        ? { name, path, wave: null, status: PLAN_UNREAD_STATUS, title: null }
        : {
            name,
            path,
            wave: head.wave,
            status: head.status ?? (summaryDone ? 'done' : null),
            title: head.title,
          }
    const key = plan.wave
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(plan)
  }
  // Wave one first, and the plans that named no wave at the END: they are the ones nobody has
  // placed in the order of work yet, and putting them in front would read as «this is first».
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([wave, plans]) => ({ wave, plans }))
}

/** The questions engine over a project's phases, reading BOTH parking files as one queue. */
function questionsEngine(projectDir, fsImpl) {
  return createQuestions({ projectDir, fsImpl, checkpointSuffix: ALL_CHECKPOINT_SUFFIXES })
}

/**
 * {open, answered} for one phase — and zero of zero for a phase whose checkpoint is torn.
 *
 * A single unreadable file on disk must not take the whole index down with it: the index is
 * how a person finds the phase they need, including the one they need in order to fix that
 * file. The engine names a torn checkpoint by throwing; here that is one row's counters, not
 * the poll.
 */
function progressOf(engine, phaseId) {
  try {
    return engine.progress(phaseId)
  } catch {
    return { open: 0, answered: 0 }
  }
}

/**
 * derivePhaseIndex({projectDir, fsImpl}) → {phases:[{id, name, stages, open, answered}]}.
 *
 * Every directory of `.planning/phases`, in name order, with where each stage of it stands and
 * how many questions it is holding. `id` is the DIRECTORY NAME — the one spelling that is
 * unambiguous, and one both this module and the daemon's gate resolve through the same
 * `findPhaseDir`, so a phase number reaches the same row.
 *
 * @param {{projectDir?:string, fsImpl?:object}} [deps]
 * @returns {{phases:object[]}}
 */
export function derivePhaseIndex({ projectDir, fsImpl } = {}) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return { phases: [] }
  const io = fsSeam(fsImpl)
  const root = join(projectDir, '.planning', 'phases')
  const engine = questionsEngine(projectDir, fsImpl)
  // Read ONCE for the whole list rather than per row: the roadmap is one file and this is the
  // screen that shows every phase at once. It decides both the names and the order below.
  const titles = roadmapTitles(projectDir, io)
  const dirs = safeList(io, root)
    .filter((name) => isDir(io, join(root, name)))
    // NEWEST FIRST. The phase somebody is working on is the highest-numbered one, and it should
    // be the first row rather than something to scroll past. Ties and unnumbered directories
    // fall back to their name so the order is total and stable.
    .sort((a, b) => phaseOrderOf(b, titles) - phaseOrderOf(a, titles) || String(a).localeCompare(String(b)))

  return {
    phases: dirs.map((dir) => {
      const files = safeList(io, join(root, dir))
      const { open, answered } = progressOf(engine, dir)
      return { id: dir, name: phaseTitleOf(dir, titles), stages: stagesOf(files), open, answered }
    }),
  }
}

/** The status of a row that has stopped and is waiting for a person — the parked round. */
const PARKED_STATUS = 'awaiting_approval'

/**
 * Which stage parked this question, read off the checkpoint file that asked it.
 *
 * There are exactly two files and therefore exactly two stages that can park a question: a
 * discussion round and an execute stage. `plan` and `verify` produce documents and never stop
 * to ask, so a path that is neither is not a stage — it is a file this function does not know,
 * and it says so rather than guessing.
 */
function stageOfCheckpoint(path) {
  const text = String(path ?? '')
  if (text.endsWith(EXEC_CHECKPOINT_SUFFIX)) return 'execute'
  if (text.endsWith(CHECKPOINT_SUFFIX)) return 'discuss'
  return null
}

/**
 * stage → the id of the row parked for it, for ONE phase directory.
 *
 * A row is matched to this phase through `findPhaseDir` — the same one rule for «which
 * directory is phase N» that resolved the card itself. That matters because the row records
 * the phase AS IT WAS TYPED at the door («12») while the card is a directory name
 * («phase-12-front-workplace»), and comparing those two strings would find nothing.
 *
 * Keyed by STAGE and not by phase, because one phase can hold two parked rows at once: the
 * queue's 409 forbids two rows for the same stage of the same phase, and nothing more. A
 * discussion and an execute stage of one phase can both be waiting, their questions arrive on
 * one card, and answering the last question of one must wake THAT one.
 */
function parkedStageTasks(rows, dirs, dir) {
  const out = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.status !== PARKED_STATUS) continue
    const data = row.data && typeof row.data === 'object' ? row.data : null
    const stage = data && data.stage
    if (!stage || out.has(stage)) continue
    if (findPhaseDir(dirs, data.phase) !== dir) continue
    out.set(stage, String(row.id))
  }
  return out
}

/**
 * phaseTaskRows(rows, dirs, dir) → строки работы, которые сами назвали ЭТУ фазу — по одной на
 * задачу, последним её словом.
 *
 * ИМЯ ФАЗЫ РАЗРЕШАЕТСЯ ТЕМ ЖЕ ПРАВИЛОМ, что у припаркованных раундов рядом: конверт строки
 * говорит «12», каталог зовётся «12-front», и знает об этом соответствии один findPhaseDir.
 * Сравнение строк напрямую отдало бы фазе пустой список ровно тогда, когда у неё есть работа.
 *
 * СВЁРНУТО ПО ЗАДАЧЕ. Повторённая задача лежит в очереди двумя строками, и сумма по строкам
 * посчитала бы её подходы дважды — задача платит за себя один раз.
 */
function phaseTaskRows(rows, dirs, dir) {
  const named = (Array.isArray(rows) ? rows : []).filter((row) => {
    const data = row && typeof row.data === 'object' && row.data !== null ? row.data : null
    if (!data || (typeof data.phase !== 'string' && typeof data.phase !== 'number')) return false
    return findPhaseDir(dirs, data.phase) === dir
  })
  return latestRowPerId(named)
}

/**
 * СКОЛЬКО ПОДХОДОВ ЗАПИСАНО НА СТРОКЕ — одно правило на фазу и на батч.
 *
 * Ноль здесь значит «ни одного», а не «неизвестно»: строка, которую ещё никто не брал, честно
 * не потратила ни хода, и это ИЗМЕРЕННЫЙ ноль. Второе написание этого разбора у батча однажды
 * посчитало бы те же ходы иначе — сборка и фаза меряют одни и те же строки очереди.
 */
function attemptsOf(row) {
  const n = Number(row && row.attempt)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
}

/**
 * phaseWork(rows) → {tasks, done, attempts, startedAt} — чем фаза меряется, кроме расхода.
 *
 * ПО ТЕМ ЖЕ САМЫМ СТРОКАМ, по которым складываются токены рядом: окошко показателей не может
 * назвать одну фазу двумя разными объёмами работы, потому что список задач у обоих чисел один.
 *
 * `startedAt` — САМЫЙ РАННИЙ МОМЕНТ, КОГДА ЗАДАЧУ ФАЗЫ ВЗЯЛИ В РАБОТУ, а не когда её поставили
 * в очередь: «фаза идёт с 06:12» — про работу, а не про намерение. `null` — ни одну задачу ещё
 * не брали, и экран говорит это прочерком, а не сегодняшней полночью.
 */
function phaseWork(rows) {
  const list = Array.isArray(rows) ? rows : []
  let done = 0
  let attempts = 0
  let startedAt = null
  for (const row of list) {
    if (row && row.status === 'completed') done += 1
    attempts += attemptsOf(row)
    const at = toMs(row && row.claimedAt)
    if (Number.isFinite(at) && (startedAt === null || at < startedAt)) startedAt = at
  }
  return { tasks: list.length, done, attempts, startedAt }
}

/**
 * derivePhaseCard({projectDir, phaseId, fsImpl, parkedRows, taskRows}) → one phase in full, or
 * null when the project has no such directory.
 *
 * {id, name, stages, questions, plans, waves, summaries, uat}. The plans and summaries travel as
 * NAMES and door-relative paths — never their contents: a card is a table of contents, and the
 * document itself is one click through the artefact door, which is the one place the reading
 * of a file is bounded.
 *
 * WHY A QUESTION CARRIES A TASK ID. The decision door records an answer always, and wakes the
 * parked round only when the answer was the LAST one AND the caller named the row to wake. The
 * screen can only name it if something told it which row that is — and this is that something.
 * Without it the door recorded every answer and woke nothing, so a discussion started from the
 * window could never get past its first question: the answer was on disk and the round was
 * still asleep.
 *
 * `parkedRows` is the queue's rows, passed IN rather than read here: this module stays a pure
 * function of the filesystem, and the door that has the adapter is the one that hands them
 * over. A card built without them is still a card — every question simply carries no id, which
 * is exactly the state the door treats as «record it, wake nothing».
 *
 * `taskRows` is the queue's rows again — passed IN for the same reason `parkedRows` is, and used
 * for a different question: во что фаза обошлась. A card built without them simply carries no
 * sum, which is the honest reading of «спросить было не у кого».
 *
 * @param {{projectDir?:string, phaseId?:string|number, fsImpl?:object, parkedRows?:object[],
 *          taskRows?:object[]}} [deps]
 * @returns {object|null}
 */
export function derivePhaseCard({ projectDir, phaseId, fsImpl, parkedRows, taskRows } = {}) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  const wanted = String(phaseId ?? '').trim()
  if (wanted === '') return null

  const io = fsSeam(fsImpl)
  const root = join(projectDir, '.planning', 'phases')
  const dirs = safeList(io, root).filter((name) => isDir(io, join(root, name)))
  const dir = findPhaseDir(dirs, wanted)
  if (!dir) return null

  const files = safeList(io, join(root, dir))
  const engine = questionsEngine(projectDir, fsImpl)

  const parked = parkedStageTasks(parkedRows, dirs, dir)

  let questions = []
  try {
    questions = engine.allQuestions(dir).map((q) => {
      // The question knows which FILE asked it; the file names the stage; the stage names the
      // row. No step of that chain is a guess, which is why a phase holding two parked stages
      // still sends every answer to its own round.
      const stage = stageOfCheckpoint(q.path)
      const taskId = stage === null ? undefined : parked.get(stage)
      return {
        id: q.id,
        area: q.area,
        question: q.text,
        options: q.options,
        answer: q.answer,
        // ABSENT, never empty: the door reads «no id» as «record the answer and wake nothing»,
        // and an empty string would be a value that fails its grammar instead.
        ...(taskId ? { taskId } : {}),
      }
    })
  } catch {
    // a torn checkpoint costs the card its question list, never the card
    questions = []
  }

  const acceptance = readAcceptance(io, root, dir, files)
  // Роадмап читается ОДИН раз на карточку: из него берутся и имя фазы, и запасной абзац
  // описания. Два чтения одного файла ради двух его строк — это два ответа на один вопрос.
  const titles = roadmapTitles(projectDir, io)
  // Задачи фазы узнаются один раз: по ним считаются и расход, и её собственные счётчики.
  const rows = phaseTaskRows(taskRows, dirs, dir)

  return {
    id: dir,
    name: phaseTitleOf(dir, titles),
    // О ЧЁМ ЭТА ФАЗА — абзац её контекста, а если контекста ещё нет, абзац роадмапа. `null`
    // означает ровно «сказать нечем», и экран говорит это словами.
    description: phaseDescription(io, root, dir, files, titles),
    stages: stagesOf(files),
    questions,
    plans: artifactsOf(files, dir, PLAN_SUFFIX),
    summaries: artifactsOf(files, dir, SUMMARY_SUFFIX),
    // The same plans, in the shape the phase is actually WORKED in — see wavesOf. `plans` stays
    // exactly as it was: the artefact list is what the document links are built from, and a
    // screen that wanted the flat column must not have to walk a tree to rebuild it.
    waves: wavesOf(io, root, dir, files),
    uat: acceptance.items,
    // ВО ЧТО ОБОШЛАСЬ ФАЗА — сумма четырёх чисел поставщика по ЕЁ задачам, а по каждой задаче
    // по всем её подходам. Фаза — это то, чем человек меряет кусок ночи; расход, посчитанный
    // только по одной попытке, отвечает не на тот вопрос.
    //
    // ЗАДАЧИ ФАЗЫ УЗНАЮТСЯ ТЕМ ЖЕ ПРАВИЛОМ, каким узнаются её припаркованные раунды: конверт
    // строки называет фазу, а какой каталог за этим именем — знает findPhaseDir, и второго
    // ответа на это здесь не заводится.
    //
    // `null` — «мерить негде»: строк не передали, задач у фазы нет, каталога прогонов не
    // существует. Ноль на этом месте назвал бы бесплатной работу, которую никто не измерял.
    tokens: totalTokens(rows.map(taskTokensReader({ runsDir: runsDirOf(projectDir), fsImpl }))),
    // ЧЕМ ЕЩЁ МЕРЯЕТСЯ ФАЗА, кроме расхода: сколько у неё задач, сколько из них закрыто, сколько
    // подходов на них потрачено и когда за неё взялись впервые. Всё — по тем же самым строкам,
    // по которым сложены токены, поэтому окошко показателей не может назвать одну и ту же фазу
    // двумя разными объёмами работы.
    //
    // `null` — «спросить было не у кого»: строк не передали вовсе. Пустой список строк — это
    // ИЗМЕРЕННЫЙ ноль (у фазы нет задач), и он отличается от неизвестности честно.
    work: Array.isArray(taskRows) ? phaseWork(rows) : null,
    // WHICH FILE IS THE ACCEPTANCE DOCUMENT is answered HERE and nowhere else. The door that
    // writes a verdict into it needs the same answer, and it takes it off this card rather
    // than looking the directory up a second time: two spellings of one rule is how a screen
    // ends up reading one file while a write lands in another.
    ...(acceptance.document ? { uatDocument: acceptance.document } : {}),
  }
}

/**
 * The acceptance document of a phase and the lines inside it, or an empty answer.
 *
 * Read in the format `/sma-verify-work` writes and the `audit-uat` verb parses — this module
 * neither invents a second format nor migrates the one that exists. No UAT file is an empty
 * list: a phase nobody has accepted yet is a normal state, not a missing one.
 */
function readAcceptance(io, root, dir, files) {
  const file = files.filter((f) => UAT_FILE_RE.test(f)).sort()[0]
  if (!file) return { document: null, items: [] }
  const document = { name: file, path: `${PHASES_PATH}/${dir}/${file}` }
  const text = readTextOrNull(io, join(root, dir, file))
  if (text == null) return { document, items: [] }

  const items = []
  UAT_ITEM_RE.lastIndex = 0
  let m
  while ((m = UAT_ITEM_RE.exec(text)) !== null) {
    const note = typeof m[4] === 'string' ? m[4].trim().replace(/^"|"$/g, '') : ''
    items.push({
      item: m[1],
      name: m[2],
      verdict: uatVerdictOf(m[3]),
      ...(note ? { note } : {}),
    })
  }
  return { document, items }
}

/**
 * WHAT ONE ITEM OF A BATCH READS AS — the five queue statuses said in the words the assembly
 * cares about. The queue's vocabulary answers «where is this row»; a batch asks a different
 * question, «is anybody needed here», and the two are not the same sentence.
 */
const BATCH_ITEM_STATE = Object.freeze({
  completed: 'done',
  failed: 'failed',
  awaiting_approval: 'awaiting_decision',
  claimed: 'running',
  queued: 'waiting',
})

/**
 * THE SIXTH WORD, AND IT IS NOT A STATUS AT ALL: «пропущен» is what the OWNER said about a
 * piece, not where that piece stands in the queue. It overrules the status because it is a
 * later fact about the same piece — the queue still holds a broken row, and the person who
 * owns the assembly has decided it does not hold it any more.
 */
const BATCH_ITEM_SKIPPED = 'skipped'

/**
 * THE THREE ANSWERS A STOPPED ASSEMBLY OFFERS, in one place because they are offered in two —
 * the card a person presses and the door that accepts what he pressed have to be the same
 * three, or a screen would show a button nothing answers.
 *
 * WHY THERE IS NO FOURTH, «повторить автоматически»: the whole rule this question exists to
 * enforce is that nothing happens by itself. The loop of 12.08.2026 was exactly that fourth
 * option, taken without asking.
 */
export const BATCH_DECISIONS = Object.freeze([
  Object.freeze({ id: 'skip', label: 'Пропустить элемент' }),
  Object.freeze({ id: 'retry', label: 'Повторить' }),
  Object.freeze({ id: 'cancel', label: 'Отменить батч' }),
])

/**
 * THE ORDER OF LOUDNESS — the first of these present among the items is what the batch reads
 * as, and the item wearing it is what HOLDS the assembly.
 *
 * A failure comes before a decision, and both come before anything that is merely under way:
 * the founder's rule for a batch is that a failed piece STOPS it and asks its owner what to do
 * (skip / retry / abandon), with nothing ever retried by itself. Which is also why a failed
 * item does not close: it is terminal for the QUEUE and unfinished for the ASSEMBLY, and a
 * batch reading «готово» with a failed piece in it would be the plainest lie this screen could
 * tell. Only work that actually produced counts as closed.
 */
const BATCH_STATE_ORDER = Object.freeze(['failed', 'awaiting_decision', 'running', 'waiting', 'done'])

/**
 * taskTokensReader({runsDir, fsImpl}) → (row) → четыре числа поставщика, сложенные по ВСЕМ
 * попыткам этой задачи, или `null`.
 *
 * ПОЧЕМУ НЕ ЧЕРЕЗ ЛЕДЖЕР. Номер последнего подхода лежит на самой строке — очередь его туда и
 * пишет, — а числа лежат в каталогах прогона, названных по задаче и номеру. Спрашивать ради
 * этого книгу попыток значило бы читать второй источник на каждый опрос экрана ради факта,
 * который уже в руках.
 *
 * ПОТОЛОК ПЕРЕБОРА — ЁМКОСТЬ САМОГО КАТАЛОГА, и он не «тихое урезание»: каталог прогонов хранит
 * ровно столько попыток, а запрошенные сверх того гарантированно отсутствуют и добавили бы к
 * сумме нули. Это защита от испорченной строки, которая назвалась миллионным подходом, а не
 * граница измерения.
 *
 * @param {{runsDir?:string|null, fsImpl?:object}} [args]
 * @returns {(row:object)=>({input:number,output:number,cacheRead:number,cacheWrite:number}|null)}
 */
function taskTokensReader({ runsDir, fsImpl } = {}) {
  return (row) => {
    const id = row && typeof row.id === 'string' ? row.id : ''
    if (id === '') return null
    const n = Number(row.attempt)
    const last = Math.min(Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1, RUN_DIRS_KEEP)
    const attemptIds = []
    for (let i = 1; i <= last; i += 1) attemptIds.push(attemptIdFor(id, i))
    return sumRunTokens({ runsDir, attemptIds, fsImpl })
  }
}

/**
 * totalTokens(parts) → сумма четырёх чисел по нескольким задачам, или `null`, когда ни одна из
 * них ничего не сказала.
 *
 * ДВА ВИДА «НУЛЯ» РАЗЛИЧАЮТСЯ ЗДЕСЬ ТОЖЕ. Задача, чьи квитанции молчат, приходит сюда как `null`
 * и в сумму не входит; но сборка, где НИ ОДНА задача не измерялась (каталога прогонов нет —
 * чужая машина, проект не подключён), честно отдаёт отсутствие, а не бодрый ноль.
 */
function totalTokens(parts) {
  const known = (Array.isArray(parts) ? parts : []).filter(Boolean)
  if (known.length === 0) return null
  const out = zeroTokens()
  for (const part of known) for (const field of TOKEN_FIELDS) out[field] += Number(part[field]) || 0
  return out
}

/**
 * deriveBatches(requests, rows, ctx) → the batches, each with its items, its own reading and
 * the item that is holding it.
 *
 * COMPUTED AT EVERY READ, NEVER STORED. «What holds this assembly» is a function of the items'
 * statuses and of nothing else; written down anywhere it would be a second truth about the
 * same five statuses, and the two would disagree the first time either moved — silently,
 * because nothing compares them. Same for «готово»: a batch is closed when its items are, and
 * a stored closed-flag is a promise the items can contradict.
 *
 * PURE over its arguments. An orphan item (a batch id with no request row) is deliberately NOT
 * invented into a batch of its own: the door writes the request last precisely so a half-written
 * batch reads as loose work, which a person can see and run.
 *
 * @param {object[]} requests the batch request rows
 * @param {object[]} rows     every WORK row (the requests are not among them)
 * @param {{machineId?:string, taskTokens?:(row:object)=>object|null}} ctx
 * @returns {object[]}
 */
function deriveBatches(requests, rows, { machineId, taskTokens } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) return []

  return [...requests]
    .sort((a, b) => (toMs(a.enqueuedAt) || 0) - (toMs(b.enqueuedAt) || 0))
    .map((req) => {
      // The request's own id IS the batch id (the door mints one identifier, not two); the
      // field is read first all the same, so a row written by anything else still groups.
      const batchId = req.batchId || req.id
      // WHAT THE OWNER HAS ALREADY SAID about this assembly — the one fact here that is not
      // recomputed from statuses, because nothing else can produce it.
      const { skipped, cancelled } = batchDecisionsOf(req)
      // The grouping, the de-duplication of a repeated piece and the order are the QUEUE's own
      // (adapter.mjs): the screen draws the pieces in the very order the next one is handed out
      // in, and two answers to «which piece is next» would be two batches on one request.
      const itemRows = batchItemsOf(rows, batchId)
      const items = itemRows.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        status: r.status,
        state: skipped.includes(r.id) ? BATCH_ITEM_SKIPPED : (BATCH_ITEM_STATE[r.status] ?? 'waiting'),
      }))

      const loudest = BATCH_STATE_ORDER.find((s) => items.some((i) => i.state === s))
      // CLOSED BY ITS ASSEMBLY, and only when every piece produced OR was let go by the owner.
      // A skipped piece does not hold the assembly — that is what skipping it MEANT — and it
      // is still shown, by name, saying «пропущен»: a decision that left no trace is a decision
      // nobody can be held to.
      const closed =
        items.length > 0 && items.every((i) => i.state === 'done' || i.state === BATCH_ITEM_SKIPPED)
      // AN ABANDONED ASSEMBLY READS AS ABANDONED, above every other word: its pieces were taken
      // out of the queue and what they say about themselves no longer describes the batch.
      const state = cancelled ? 'cancelled' : closed ? 'done' : (loudest ?? 'waiting')
      const broken = cancelled ? null : (items.find((i) => i.state === 'failed') ?? null)
      return {
        id: req.id,
        title: req.title ?? null,
        project: projectOf(req),
        machine: machineId,
        state,
        items,
        // КОГДА ВЛАДЕЛЕЦ ЭТО ПОПРОСИЛ — момент, записанный дверью батча на строку запроса.
        // Читается со строки, а не считается: «когда нажали» не выводится ни из одного статуса,
        // и отметка самой очереди говорит о другом — когда строку записали (запрос пишется
        // последним, и на длинной сборке это уже другая секунда). Строка, записанная до этого
        // поля, честно молчит: `null`, а не подставленный `enqueuedAt`, который выглядел бы
        // ровно так же и врал бы на величину, которую никто не заметит.
        requestedAt: Number.isFinite(Number(req.data && req.data.requestedAt))
          ? Number(req.data.requestedAt)
          : null,
        // ВО ЧТО ОБОШЛАСЬ ВСЯ СБОРКА — сумма четырёх чисел по её кускам, а по каждому куску —
        // по всем его подходам. Кусок, чьи квитанции молчат, даёт ноль и суммы не роняет;
        // `null` — «мерить негде», то есть каталога прогонов нет вовсе.
        tokens: typeof taskTokens === 'function' ? totalTokens(itemRows.map((r) => taskTokens(r))) : null,
        // СКОЛЬКО ХОДОВ СТОИЛА СБОРКА — подходы её кусков, сложенные тем же правилом, каким их
        // считает фаза рядом. Это ИЗМЕРЕННОЕ число, а не оценка: строки сборки известны поимённо,
        // и подход, записанный на строке, — единственное, что о ходах вообще известно.
        attempts: itemRows.reduce((n, r) => n + attemptsOf(r), 0),
        // WHAT IS HOLDING THE ASSEMBLY, named rather than left for a reader to work out: the
        // loudest item, and its state IS the reason (waiting for a person / under way / not
        // started). Null when there is nothing to wait for.
        holding: cancelled || closed ? null : (items.find((i) => i.state === state) ?? null),
        // THE QUESTION THE ASSEMBLY OWES ITS OWNER. Present exactly while a piece is broken and
        // he has not answered: the batch stops, hands out nothing, and asks — skip, repeat, or
        // abandon. It carries the piece by NAME and the three answers by name, so the card is
        // built from the daemon's own words and a button can never offer an answer no door
        // accepts. Absent when there is nothing to ask, rather than present and empty.
        ...(broken
          ? {
              question: {
                itemId: broken.id,
                itemTitle: broken.title,
                text: `«${broken.title ?? broken.id}» не получилось. Что делаем?`,
                options: BATCH_DECISIONS.map((o) => ({ ...o })),
              },
            }
          : {}),
      }
    })
}

/**
 * deriveWaves(rows, holds, ctx) → the ECHELONS, each with the work it actually consists of and
 * whether its owner has stopped it.
 *
 * WHY THIS EXISTS AT ALL, and it is the whole reason: «Останови волну 2» has to be answered with
 * WHO exactly will finish their step and stand and WHO is already standing. Without this list
 * the window could only say the sentence from the mockup with the numbers typed into it — the
 * one thing the founder's own acceptance criterion forbids. The rows are the answer, and the
 * screen composes his sentence out of them.
 *
 * COMPUTED AT EVERY READ, like every other reading here. Only the STOP is remembered (it is a
 * word somebody said and nothing derives it); who is running and who is waiting is a function of
 * the queue's own statuses.
 *
 * AN ECHELON IS LISTED WHEN THE QUEUE KNOWS OF IT **OR** WHEN IT IS STOPPED. The second half is
 * not symmetry for its own sake: an order given about an echelon whose tasks have not been put
 * in yet must stay visible, or the screen would show a stop that quietly is not there — and the
 * next tick would still be honouring it.
 *
 * ЧЕЙ ЭШЕЛОН — СЧИТАЕТСЯ ИЗ ЕГО СОБСТВЕННЫХ СТРОК, А НЕ ИЗ ТОГО, КУДА СМОТРЯТ. Раньше здесь
 * стояла подстановка «выбранный проект, а если его нет — „default“»: у эшелона появлялся
 * владелец, которого никто не записывал, и он менялся вместе со взглядом человека. Это та же
 * ошибка, что была на строках, только этажом выше — принадлежность домысливалась. Теперь эшелон
 * принадлежит проекту тогда и только тогда, когда его собственная незакрытая работа называет
 * ОДИН и тот же проект; эшелон из строк без проекта, из строк разных проектов и эшелон, о
 * котором известен только приказ об остановке, честно отдаются с `project: null`.
 *
 * @param {object[]} rows every queue row
 * @param {{phase:string, wave:string, since:number|null}[]} holds
 * @param {{machineId?:string}} ctx — только машина: проект эшелона считается из его строк
 * @returns {object[]}
 */
function deriveWaves(rows, holds, { machineId } = {}) {
  const all = Array.isArray(rows) ? rows : []
  const stops = Array.isArray(holds) ? holds : []
  const byKey = new Map()
  const keyOf = (phase, wave) => JSON.stringify([phase, wave])
  const slot = (phase, wave) => {
    const key = keyOf(phase, wave)
    if (!byKey.has(key)) {
      // `projects` — множество проектов, НАЗВАННЫХ собственными строками эшелона. Пусто —
      // никто не назвал; больше одного — эшелон общий, и назвать один было бы выдумкой.
      byKey.set(key, { phase, wave, held: false, heldSince: null, running: [], waiting: [], projects: new Set() })
    }
    return byKey.get(key)
  }

  for (const stop of stops) {
    const row = slot(String(stop.phase), String(stop.wave))
    row.held = true
    row.heldSince = Number.isFinite(stop.since) ? stop.since : null
  }
  for (const r of all) {
    const address = waveAddressOf(r)
    if (!address) continue
    // Только незакрытая работа: доведённое и провалившееся об эшелоне больше ничего не решает,
    // и в вопросе «кого остановит приказ» им не место.
    if (r.status !== 'queued' && r.status !== 'claimed') continue
    const row = slot(address.phase, address.wave)
    const named = { id: r.id, title: r.title ?? null }
    const own = projectOf(r)
    if (own !== null) row.projects.add(own)
    if (r.status === 'claimed') row.running.push(named)
    else row.waiting.push(named)
  }

  return [...byKey.values()]
    .map(({ projects, ...w }) => ({
      ...w,
      project: projects.size === 1 ? [...projects][0] : null,
      machine: machineId,
    }))
    .sort((a, b) => {
      const byPhase = String(a.phase).localeCompare(String(b.phase), undefined, { numeric: true })
      return byPhase !== 0 ? byPhase : String(a.wave).localeCompare(String(b.wave), undefined, { numeric: true })
    })
}

/**
 * deriveState(deps) → the one-poll roster payload {kpis, queue, awaiting, workers, done,
 * spend}. (Task 4 augments it with costs.series over GET /api/state.) Pure over its
 * injected collaborators; re-derives fresh every call.
 *
 * `awaiting` exists because the day screen rides ROWS: it has to name the tasks that are
 * holding for a person's word, and a counter gives it nothing to show. It is derived from
 * the same rows the counter is, so the two can never fall out of step.
 *
 * `batches` is the third kind of unit of work: one request of the owner and the pieces it was
 * broken into, with the piece that is holding the assembly NAMED. Every part of it is computed
 * from the queue's own rows at this call — see deriveBatches.
 *
 * @param {{
 *   adapter: {list:Function},
 *   ledgerDir?: string,
 *   windows?: (account:any)=>object,      // windowState per account (an injected seam)
 *   terminalWindows?: ()=>object,         // the terminal's own window reading (an injected seam)
 *   config?: object,                      // workers[], agingHours, budget
 *   usageReader?: (args:object)=>{costUsd?:number},
 *   readReceipt?: Function,               // resolve a receiptRef string → receipt object
 *   execGit?: (args:string[], opts?:object)=>string,
 *   clock?: ()=>number,
 *   project?: string,                     // optional filter — narrows tasks, never the lists
 *   hubReachable?: boolean,               // hub-probe seam; absent = true
 *   aggregator?: (payload:object)=>object, // hub-only federation merge; absent = local only
 * }} deps
 * @returns {Promise<object>}
 */
export async function deriveState(deps = {}) {
  const { adapter, windows, config = {}, usageReader, readReceipt, execGit } = deps
  const readTaskAttempts = attemptsReader(deps)
  // «Сделано / не получилось» ЗА ПЕРИОД — an injected read model over the attempt ledger
  // (front/worker-stats.mjs), wired at the composition root like every other collaborator, so
  // this file grows no static edge onto it and a daemon that wires none simply carries nothing.
  // The alternative it replaces was the screen counting the done[] slice of this very payload:
  // a figure that moved with the length of a list rather than with the work.
  const workerStats = deps.workerStats && typeof deps.workerStats.statsFor === 'function' ? deps.workerStats : null
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const now = clock()
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const agingMs = (config.agingHours ?? 24) * HOUR_MS

  let allRows = []
  try {
    allRows = (await adapter.list({})) || []
  } catch {
    allRows = []
  }

  // ── THE REQUESTS OF BATCHES ARE SEPARATED FIRST, and everything below this line sees only
  // WORK. A batch request is a record of what was asked: no worker will ever take it, so
  // counted among the queued rows it would add a unit to «в очереди» that never comes off,
  // and shown in the queue list it would be a card nobody can act on. It is read for one
  // purpose — to be the batch — and it is read here, once. ──
  const batchRequestRows = allRows.filter(isBatchParent)
  allRows = allRows.filter((r) => !isBatchParent(r))

  // ── projects / machines / federation — derived from the config, never stored ──
  const projectRegistry = Array.isArray(config.projects) ? config.projects : []
  const activeProject = config.activeProject ?? (projectRegistry[0] && projectRegistry[0].id) ?? null
  const projects = deriveProjects(allRows, config)
  const machines = deriveMachines(config)
  const machineId = machines[0].id
  const federation = {
    role: (config.federation && config.federation.role) || 'standalone',
    hubReachable: typeof deps.hubReachable === 'boolean' ? deps.hubReachable : true,
  }

  // The project filter narrows the TASKS only (the lists above are already built), and it
  // keeps the rows of UNKNOWN ownership — see inProject: work no filter shows is work nobody
  // can act on, and it is carried with its own truth rather than repainted as ours.
  const rows = deps.project ? allRows.filter((r) => inProject(r, deps.project)) : allRows

  // THE TREE THE WORK HAPPENED IN, resolved through the SAME expression the workbench and the
  // phase cycle already use: the connected project, and the served tree only when nothing is
  // connected. It is named HERE, above the first reader, because two of them now ask for it —
  // the commit log of a finished row below, and the run directories the batches are costed
  // from. A second spelling of it would cost one of the two its answer, silently.
  const gitDir =
    (connectedProject(config) || {}).dir ||
    (typeof deps.repoDir === 'string' && deps.repoDir.trim() !== '' ? deps.repoDir : null)
  // ЧЕМ СЧИТАЕТСЯ РАСХОД ЗАДАЧИ — один читатель на весь опрос: каталог прогонов подключённого
  // проекта плюс номер последнего подхода со строки. Проект не подключён — читателя нет, и
  // каждая сумма честно отсутствует вместо того, чтобы быть нулём.
  const taskTokens = taskTokensReader({ runsDir: runsDirOf(gitDir), fsImpl: deps.fsImpl })

  // The batches ride the SAME project filter as the tasks — a batch is work of one project.
  const batches = deriveBatches(
    deps.project ? batchRequestRows.filter((r) => inProject(r, deps.project)) : batchRequestRows,
    rows,
    { machineId, taskTokens },
  )

  // ── ЭШЕЛОНЫ: что за волны в работе и какие из них владелец остановил ──
  //
  // The stop is READ FROM THE REGISTER the loop obeys — the same file, not a second copy — so
  // the screen cannot show «идёт» over work the dispatcher is already withholding. Fail-open:
  // an unreadable register means «nothing is stopped», the reading that keeps the screen honest
  // about the queue rather than inventing a stop nobody ordered.
  let waveHolds = []
  try {
    if (config && config.dataDir) waveHolds = readWaveHolds({ dataDir: config.dataDir, fsImpl: deps.fsImpl })
  } catch {
    /* a register that will not read costs the payload its stops, never the payload */
  }
  const waves = deriveWaves(
    deps.project ? rows.filter((r) => inProject(r, deps.project)) : rows,
    waveHolds,
    { machineId },
  )

  // ── ONE TASK, ONE LINE — IN EVERY SECTION OF THE LIST ──
  //
  // A returned task is enqueued again under its OWN id, and a durable queue keeps the row it
  // stopped on beside the new one. Filtering by status alone therefore counted a single piece
  // of work as two for the whole span of the return: «ЖДУТ ВАС: 2» over one task, one of the
  // two lines nameless. So the rows are folded to the LAST WORD about each task first — the
  // QUEUE'S OWN rule, imported rather than restated, because a second definition of «which row
  // wins» is a second answer waiting to disagree. While the task is being redone its last word
  // is «в работе» and it owes nobody a decision; once it stands for approval again it is one
  // line. The counters below read the lengths of these very lists, so they are fixed by the
  // same move.
  //
  // THE FOLD USED TO STOP AT THE WAITING LIST, with the reason that the defect had been
  // measured only in the waiting count and that widening the edit would change screens nobody
  // asked about. A live press measured the same defect one screen up and retired that reason:
  // a task sent back three times drew FOUR lines on the top-level list — three closed
  // approaches plus the live one — while its own card honestly showed one task on its fourth
  // approach. The length of that list is how a person measures the size of his night, so it has
  // to count TASKS. Every section now reads the same folded rows, and a task stands in the
  // section of its LAST word: queued while it waits for a worker, «в работе» while one holds it,
  // «сделано» only once nothing newer exists.
  const foldedRows = latestRowPerId(rows)
  const queuedRows = foldedRows.filter((r) => r.status === 'queued')
  const claimedRows = foldedRows.filter((r) => r.status === 'claimed')
  const awaitingRows = foldedRows.filter((r) => r.status === 'awaiting_approval')
  const doneRows = foldedRows.filter((r) => r.status === 'completed' || r.status === 'failed')

  // ── ONE task row, named field by field. An adapter row may carry anything at all; a
  // payload carries only what a screen was promised, so the pick is explicit and both
  // task lists below ride exactly the same one. ──
  const toTaskRow = (r, i) => {
    const enq = toMs(r.enqueuedAt)
    const ageMs = Number.isFinite(enq) ? now - enq : 0
    const out = {
      id: r.id,
      title: r.title ?? null,
      lane: r.lane ?? null,
      project: projectOf(r),
      machine: machineId,
      ...(r.provider ? { provider: r.provider } : {}),
      priority: Number(r.priority) || 0,
      status: r.status,
      position: i + 1,
      // WHEN THE WORK WAS TAKEN, and — a different fact — when its lease was last renewed. The
      // queue keeps the two apart now (a renewal used to move both, so every running task
      // reported a duration of about zero), and a screen that measures «идёт столько-то» has to
      // read the first. Carried as NULL rather than as a zero wherever the queue does not know:
      // a row waiting for a worker has nothing to measure, and a zero there renders as «just
      // started», which is a statement about work that is not happening.
      claimedAt: r.claimedAt ?? null,
      leaseRenewedAt: r.leaseRenewedAt ?? null,
    }
    // ── HOW LONG IT HAS BEEN WAITING, and the two lists are aged by DIFFERENT clocks ──
    //
    // A row waiting for a WORKER is aged from `enqueuedAt` past the configured patience: that
    // reading is a «застряла» signal, and below the threshold there is nothing to report.
    //
    // A row waiting for a PERSON is aged from `completedAt` — the mark put down at the moment
    // the work stopped and started owing somebody a word (both backends write it: the memory
    // queue in complete(), the durable one out of completed_on). It is NOT the claim time and
    // NOT the lease renewal: those say when a worker took the task and when it last said it
    // lived, which are facts about the work, not about the wait. Three screens — the «ждут вас»
    // strip, the list line, the card and the console pill — already read `agedForHours` off this
    // row and printed «сколько ждёт — нет данных» because nothing ever computed it.
    //
    // FRACTIONAL HOURS, and no patience threshold. The screens turn anything under an hour into
    // minutes themselves, so a floor here would hand every fresh decision the word «ноль часов»;
    // and waiting for a person is the whole cost of the row, so no span of it is «не считается».
    // Where the stop was never marked (a row reconstructed after the fact) the field is ABSENT —
    // a zero would read as «остановилась только что», which is a claim about work nobody watched.
    if (r.status === 'awaiting_approval') {
      const stoppedAt = toMs(r.completedAt)
      if (Number.isFinite(stoppedAt) && now - stoppedAt >= 0) out.agedForHours = (now - stoppedAt) / HOUR_MS
    } else if (ageMs > agingMs) {
      out.agedForHours = Math.floor(ageMs / HOUR_MS) // «застряла» signal
    }
    return out
  }

  // ── queue[] — ordered by priority desc, then enqueuedAt asc (the claimNext order) ──
  const orderedQueue = [...queuedRows].sort((a, b) => {
    const pa = Number(a.priority) || 0
    const pb = Number(b.priority) || 0
    if (pb !== pa) return pb - pa
    return (toMs(a.enqueuedAt) || 0) - (toMs(b.enqueuedAt) || 0)
  })
  const queue = orderedQueue.map(toTaskRow)

  // ── awaiting[] — the work that is finished but still owes a person a word. The day
  // screen shows those tasks, not a number beside them, so the payload has to carry the
  // rows: a counter alone leaves the screen with nothing to draw. The one that has waited
  // longest comes first — waiting is the whole cost here, so priority has no say — and the
  // wait is measured from the moment the work STOPPED, the same mark the row's age is stated
  // from, falling back to the queue mark only where the stop was never written. The
  // queue keeps meaning what it says: rows waiting for a WORKER, never for a person. ──
  const waitingSince = (r) => {
    const stopped = toMs(r.completedAt)
    return Number.isFinite(stopped) ? stopped : toMs(r.enqueuedAt) || 0
  }
  const awaiting = [...awaitingRows].sort((a, b) => waitingSince(a) - waitingSince(b)).map(toTaskRow)

  // ── workers[] — presence is a PURE derive. The roster is ALSO the only list
  // that names a claimed task, so the three facts a screen needs to place that task travel
  // with it: its id, its NAME and its PROJECT. Without the last two a board can only print
  // the routing id where a title belongs, and its project filter has to let every running
  // card through — a column that answers a narrowed question with unnarrowed rows. All
  // three ride the same conditional: a worker holding nothing states nothing about a task,
  // rather than carrying nulls a filter would then have to special-case. ──
  const workers = workersCfg.map((w) => {
    const accountName = accountNameOf(w.account, w.id)
    const win = windowFor(windows, w.account ?? accountName)
    const bar = windowBar(win)
    const open = isOpen(bar, () => now)

    const active = claimedRows.find((r) => r.workerId === w.id) || null
    // The sign of life is the RENEWAL clock: «событие N секунд назад» is a statement about the
    // last time the worker said it lives, not about when it started. The two older names stay as
    // the fallback for a reading that carries only one of them.
    const touchMs = active ? toMs(active.leaseRenewedAt ?? active.lastTouch ?? active.claimedAt) : NaN
    const pulseAgeSec = Number.isFinite(touchMs) ? Math.max(0, Math.round((now - touchMs) / 1000)) : undefined
    const presence = derivePresence({ windowOpen: open, hasActiveTask: !!active, pulseAgeSec })

    // The period figures. ABSENT rather than zeroed when the ledger could not be read (or none
    // is wired): on the card a zero reads as «этот ничего не сделал», which is a measurement,
    // and «нет данных» is the truth. A readable but empty ledger DOES yield zeros — the
    // catalogue was opened and nothing concluded in the period, and that is a measurement.
    const stats30d = workerStats ? workerStats.statsFor(w.id) : null

    return {
      id: w.id,
      lane: w.lane,
      account: accountName,
      ...(active
        ? {
            taskId: active.id,
            taskTitle: active.title ?? null,
            project: projectOf(active),
            branch: `wt/${active.id}`,
            // WHEN THIS WORK WAS TAKEN — and it rides HERE because the roster is the only list
            // that names a claimed task: queue[] carries rows waiting for a worker and awaiting[]
            // rows waiting for a person, so a screen building a running row builds it from the
            // worker holding it. A claim time that reached only the task lists would be computed
            // and delivered to nobody. Null while the queue cannot say; the renewal clock is
            // already stated beside it as pulseAgeSec.
            taskClaimedAt: active.claimedAt ?? null,
          }
        : {}),
      window: bar,
      ...(pulseAgeSec !== undefined ? { pulseAgeSec } : {}),
      presence,
      ...(stats30d ? { stats30d } : {}),
    }
  })

  // ── done[] — «сделано за ночь»; durable sources only ──
  // The tree the work happened in is named once, above the batches — without it the card's git
  // reads ran in the daemon's launch directory.
  const done = doneRows.map((r) =>
    buildDoneRow(r, { readTaskAttempts, readReceipt, execGit, gitDir, machineId }),
  )

  // ── accounts — the deduped subscription list the spend strip ALSO rides (one dedup,
  // one window read per account, one order both sections agree on) ──
  const accounts = deriveAccounts(config, windows)
  // The spend strip carries the WHOLE window bar, not two numbers off it. «Расходы» used to
  // rebuild half of this by hunting for the worker riding each account, which meant an account
  // nobody was riding lost the very facts the screen is there to state.
  const spendAccounts = accounts.map((a) => ({ name: a.name, ...a.windows }))

  const apiAccountName = (config.budget && config.budget.apiAccountName) || 'api'
  const todayUsd = totalCost(usageReader, workersCfg, DAY_MS, now, apiAccountName)
  const monthUsd = totalCost(usageReader, workersCfg, MONTH_MS, now, apiAccountName)
  const capEur = Number(config.budget && config.budget.monthlyApiCapEur) || 0
  const anyClosed = workers.some((w) => !isOpen(w.window, () => now))
  const switchMode = anyClosed && capEur > 0 ? 'api' : 'subscription'
  const spend = {
    accounts: spendAccounts,
    // The figure the person reads on his own status line, carried through unchanged.
    terminal: terminalBar(deps.terminalWindows),
    apiFallback: {
      todayEur: round2(todayUsd), // FX out of scope for the pilot (rate 1); honest label at render
      monthEur: round2(monthUsd),
      capEur,
      switchMode,
    },
  }

  // ── costs.series — the SPA's cost view rides GET /api/state:
  // cheaper than a new endpoint since this derive already holds the usage seam. A
  // dedicated per-account/per-day reader is injected (usageSeries); absent → an empty
  // (but always-present) series, so the 9.6 contract is stable from day one. ──
  let series = []
  if (typeof deps.usageSeries === 'function') {
    try {
      series = deps.usageSeries({ days: 14, accounts: spendAccounts.map((a) => a.name), clock: () => now }) || []
    } catch {
      series = []
    }
  }
  const costs = { series, apiFallback: spend.apiFallback }

  // ── kpis ──
  const windowsOpen = workers.filter((w) => isOpen(w.window, () => now)).length
  const kpis = {
    workersBusy: workers.filter((w) => !!w.taskId).length,
    workersTotal: workersCfg.length,
    queued: queuedRows.length,
    awaitingApproval: awaitingRows.length,
    spentTodayEur: round2(todayUsd),
    windowsOpen,
  }

  // ── the settings read models — the SAME route, a fuller payload ──
  const rules = deriveRules(config, { switchMode })
  // The corpus lives in the repository the daemon serves; an explicit memoryDir wins, so a
  // test (and a future multi-repo wiring) never has to own the layout convention.
  const memoryDir = deps.memoryDir ?? (deps.repoDir ? join(deps.repoDir, '.claude', 'memory') : null)
  const memory = deriveMemory({ memoryDir, fsImpl: deps.fsImpl })
  const style = deriveStyle({ memoryDir, fsImpl: deps.fsImpl })
  // The CONNECTED project's corpus — a different question from `memory`, which is the corpus
  // of the repository this daemon itself serves. Additive: a daemon with no project
  // connected answers {absent:true} and every existing key keeps its exact shape.
  const projectMemory = deriveProjectMemory({
    config,
    readProjectMemory: deps.readProjectMemory,
    previewProjectMigration: deps.previewProjectMigration,
    projectLiveness: deps.projectLiveness,
    migrationStagingDir: deps.migrationStagingDir,
    fsImpl: deps.fsImpl,
    clock,
  })

  // ── WHY THE QUEUE IS NOT MOVING, said out loud. A queued row that nothing will pick up
  // used to look exactly like a queued row seconds from running — the founder learned the
  // difference by waiting (recon 11.08, the Multica anti-pattern «Queued без причины и
  // предела»). The reason is a DERIVE from facts this function already holds, in priority
  // order: a switched-off conveyor beats everything (nothing runs, whatever the windows
  // say); then all-windows-closed with no paid budget (nowhere to run); then a paid
  // channel that exists but is already spent (budget stop). Windows closed WITH budget
  // left is not idle — the fallback engages — so it stays unmarked. ──
  const monthEurSpent = round2(monthUsd)
  const queueIdleReason = !pipelineEnabled(config)
    ? 'pipeline_off'
    : windowsOpen === 0 && capEur === 0
      ? 'windows_closed'
      : windowsOpen === 0 && capEur > 0 && monthEurSpent >= capEur
        ? 'budget_stop'
        : null
  if (queueIdleReason) for (const q of queue) q.idleReason = queueIdleReason

  const payload = {
    kpis,
    queue,
    batches,
    waves,
    awaiting,
    workers,
    done,
    spend,
    costs,
    projects,
    activeProject,
    machines,
    federation,
    rules,
    accounts,
    memory,
    style,
    projectMemory,
  }

  // ── the federation merge (hub only) — FILLS this payload, never redefines it ──
  return applyAggregator(payload, deps.aggregator)
}

/**
 * applyAggregator(payload, aggregator) — hand the finished local payload to the injected
 * federation merge and return its result, FAIL-OPEN: no aggregator, a throw, or anything
 * that is not a plain object → the local payload is served untouched. A peer storm degrades
 * the peers, never the founder's own machine. The merge may be async (the hub polls its
 * peers inside it), so a REJECTED promise is caught by the same fail-open arm.
 *
 * @param {object} payload the local derive
 * @param {*} aggregator   a function (or {aggregateState}) injected by the composition root
 * @returns {Promise<object>}
 */
async function applyAggregator(payload, aggregator) {
  const merge =
    typeof aggregator === 'function'
      ? aggregator
      : aggregator && typeof aggregator.aggregateState === 'function'
        ? (p) => aggregator.aggregateState(p)
        : null
  if (!merge) return payload
  try {
    const merged = await merge(payload)
    return merged && typeof merged === 'object' && !Array.isArray(merged) ? merged : payload
  } catch {
    return payload
  }
}

/** Sum costUsd across every account over a rolling window via the injected usageReader. */
function totalCost(usageReader, workersCfg, windowMs, now, apiAccountName) {
  if (typeof usageReader !== 'function') return 0
  const seen = new Set()
  let sum = 0
  // The paid channel books under its OWN account (it has no worker — that is what the
  // fallback is), so a sum that walked only the workers' accounts could never see it.
  const names = [...workersCfg.map((w) => accountNameOf(w.account, w.id)), ...(apiAccountName ? [apiAccountName] : [])]
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    try {
      const u = usageReader({ accountName: name, windowMs, clock: () => now })
      // The paid share ONLY. This figure renders under «платный канал», and for one
      // release it summed every row's costUsd — so a subscription chat message read as
      // paid-channel spend directly above the line saying the paid channel is silent
      // (QA D4). The reader separates the two; a reader that predates the split
      // contributes 0 here rather than a number from the wrong column.
      sum += Number(u && u.apiCostUsd) || 0
    } catch {
      /* a reader failure contributes 0 — never wedges the poll */
    }
  }
  return sum
}

/**
 * Build ONE «сделано за ночь» row from a durable done/failed adapter row + the ledger.
 *
 * `gitDir` is WHERE THE TWO GIT READS RUN, and it is not optional bookkeeping: both used to be
 * called with no cwd at all, so they ran in the directory the daemon PROCESS was launched from.
 * On an install where the daemon serves one repository and the founder's project is another,
 * the branch `wt/<taskId>` does not exist there — git exits non-zero, both catches fire, and a
 * finished task's card showed no commits and no diff at all. The tree the work happened in is
 * the connected project, and that is what the caller passes.
 */
/**
 * How long ONE attempt ran, in milliseconds, from its own two ledger marks — or `null`.
 *
 * Both marks or nothing: a length derived from one of them would be a length measured against
 * «now», and «now» is when somebody happened to open the screen rather than when the work
 * stopped. A negative span (clocks moved, a row was rewritten) is refused for the same reason —
 * it is evidence the two marks are not comparable, not a number to show.
 */
function attemptDuration(attempt) {
  const from = toMs(attempt && attempt.startedAt)
  const to = toMs(attempt && attempt.endedAt)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const ms = to - from
  return ms >= 0 ? ms : null
}

/**
 * The GIT PART of a finished card, remembered per task — because it is history.
 *
 * Both reads below are SYNCHRONOUS subprocesses, and the done list is every finished task the
 * fold still carries. Measured 26.08.2026 on the founder's machine: two spawns per finished
 * task per poll, an uncapped list, a 3-second poll — /api/state answered in 26,7 s while
 * /api/diff (one spawn) answered in 0,4 s, and for those 26 s the ONE event loop served
 * nobody. A finished task's commit log does not change after it finishes, so paying that
 * price more than once per task is pure waste.
 *
 * An EMPTY answer is remembered too, but only briefly: after approve the branch is deleted,
 * so the oldest cards fail both reads on every poll — the full spawn price for an exit code.
 * Briefly, not forever, because empty can also mean «asked in the wrong tree» (a project
 * connected a moment later), and that answer deserves a second chance.
 */
const DONE_GIT_CACHE = new Map() // `${taskId}|${cwd}` -> { commits, diffStat, emptyAt }
const DONE_GIT_CACHE_CAP = 1000
const DONE_GIT_EMPTY_RETRY_MS = 60_000

function doneGitFacts(taskId, execGit, gitOpts) {
  if (typeof execGit !== 'function') return { commits: [], diffStat: null }
  const key = `${taskId}|${gitOpts.cwd || ''}`
  const hit = DONE_GIT_CACHE.get(key)
  if (hit && (hit.emptyAt === null || Date.now() - hit.emptyAt < DONE_GIT_EMPTY_RETRY_MS)) return hit

  const branch = taskBranch(taskId)
  let commits = []
  let diffStat = null
  try {
    commits = String(execGit(['log', '--oneline', `-${DONE_COMMIT_CAP}`, branch], gitOpts) || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, DONE_COMMIT_CAP)
  } catch {
    commits = []
  }
  try {
    // WHAT THIS TASK CHANGED — asked through the ONE seam that owns that question
    // (front/task-changes.mjs). The diff door answers the same question for the same card,
    // and while each surface built its own range they answered it differently: this one
    // counted the whole branch, that one showed the last commit. The range lives in one
    // place now, so the panel and the door cannot tell a person two different stories.
    diffStat = readTaskChanges(taskId, execGit, { cwd: gitOpts.cwd, shape: 'count' }).trim() || null
  } catch {
    diffStat = null
  }

  const entry = { commits, diffStat, emptyAt: commits.length === 0 && diffStat === null ? Date.now() : null }
  DONE_GIT_CACHE.set(key, entry)
  if (DONE_GIT_CACHE.size > DONE_GIT_CACHE_CAP) {
    // the Map iterates in insertion order — the first key is the oldest memory
    DONE_GIT_CACHE.delete(DONE_GIT_CACHE.keys().next().value)
  }
  return entry
}

function buildDoneRow(r, { readTaskAttempts, readReceipt, execGit, gitDir, machineId }) {
  const attempts = readTaskAttempts(r.id)
  const last = attempts.length ? attempts[attempts.length - 1] : null
  const receipt = parseReceiptSummary(last && last.receiptRef, { readReceipt })

  const branch = `wt/${r.id}`
  const gitOpts = gitDir ? { cwd: gitDir } : {}
  const { commits, diffStat } = doneGitFacts(r.id, execGit, gitOpts)

  const out = {
    id: r.id,
    title: r.title ?? null,
    project: projectOf(r),
    machine: machineId ?? 'self',
    finishedAt: r.completedAt ?? null,
    // HOW LONG IT ACTUALLY TOOK, from the two marks the ledger put down on the attempt that
    // CLOSED it — not from the first attempt to the last, which would silently include the hours
    // the task spent back in the queue between two tries and call that «работа».
    //
    // The two marks are what makes it honest. A finished row already carried `finishedAt`, and
    // the list beside it therefore printed «—» in the length column of every completed task —
    // the reading existed one field away and nobody handed it over. Where either mark is missing
    // (a row reconstructed after the fact, an attempt whose end was never written) this is NULL:
    // a zero would render as «заняло нисколько», which is a claim, and «нечего мерить» is the
    // truth.
    finishedDuration: attemptDuration(last),
    workerId: (last && last.workerId) ?? r.workerId ?? null,
    receipt,
    // The proof that really exists, beside the summary that waits for numbers nobody writes.
    proof: parseReceiptProof(last && last.receiptRef),
    diffStat,
    branch,
    commits,
    attempts: attempts.length || (Number.isFinite(r.attempt) ? r.attempt : 0),
  }
  // acceptance («обещано») — carried ONLY when the task had one (roster/return exempt).
  if (r.acceptance != null && String(r.acceptance).trim() !== '') out.acceptance = r.acceptance
  // failed red-card fields.
  if (r.status === 'failed') {
    const reason = r.failure_reason ?? (last && last.failureReason) ?? null
    out.failed = {
      reason,
      reasonLabel: reason ? REASON_LABELS[reason] ?? null : null,
      attemptsCount: attempts.length || (Number.isFinite(r.attempt) ? r.attempt : 0),
    }
  }
  return out
}
