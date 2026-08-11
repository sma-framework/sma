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
 *     (pure derive from the enqueuedAt timestamp, never a stored flag);
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
 * an error case.
 *
 * Every collaborator (adapter, ledger reader, the window-state function, usageReader,
 * the git/receipt readers, clock) is dependency-injected, so tests derive from fixtures
 * with no real Postgres / git / fs. Node built-ins only; zero deps; zero network.
 */

import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { join } from 'node:path'

import { pipelineEnabled } from '../config.mjs'
import { isOpen } from '../policy/windows.mjs'
import { REASON_LABELS } from '../queue/adapter.mjs'
import { readAttempts } from '../queue/attempt-ledger.mjs'
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
 * @param {*} receiptRef
 * @returns {{kind:string, ref:string, path?:string, sha?:string}|null}
 */
export function parseReceiptProof(receiptRef) {
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
 */
function attemptsReader(deps) {
  const { ledger, ledgerDir } = deps
  if (typeof ledger === 'function') {
    return (id) => {
      try {
        return ledger(id) || []
      } catch {
        return []
      }
    }
  }
  if (ledger && typeof ledger.readAttempts === 'function') {
    return (id) => {
      try {
        return ledger.readAttempts(id) || []
      } catch {
        return []
      }
    }
  }
  if (ledgerDir) {
    return (id) => {
      try {
        return readAttempts(ledgerDir, id)
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

/** The window-state function seam: windows(account) → {pct5h, pctWeek, estimated, closedUntil?}. */
function windowFor(windows, account) {
  const fallback = { pct5h: 0, pctWeek: 0, estimated: true }
  if (typeof windows !== 'function') return fallback
  try {
    const w = windows(account)
    return w && typeof w === 'object' ? w : fallback
  } catch {
    return fallback
  }
}

/** The project a row belongs to: its own, else the active project, else the default id. */
function projectOf(row, activeProject) {
  const own = row && row.project
  return (typeof own === 'string' && own !== '' ? own : activeProject) || 'default'
}

/**
 * deriveProjects(rows, config) → [{id, name, connected, taskCounts}] over the WHOLE selection.
 * Counts are per project by construction, so they are computed from every row regardless
 * of an active filter — that is exactly what makes the switcher readable.
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
  const active = config.activeProject ?? (registry[0] && registry[0].id) ?? null
  return registry.map((p) => {
    const mine = rows.filter((r) => projectOf(r, active) === p.id)
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

/** A payload window bar — ALWAYS carries estimated (honest labels, A3). */
function windowBar(win) {
  return {
    pct5h: numOrNull(win.pct5h) ?? 0,
    pctWeek: numOrNull(win.pctWeek) ?? 0,
    estimated: win.estimated === undefined ? true : Boolean(win.estimated),
    ...(win.closedUntil != null ? { closedUntil: win.closedUntil } : {}),
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
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(ROADMAP_HEADING)
      if (!m) continue
      const n = Number(m[1])
      const full = m[2].trim()
      headings.push({ n, full })
      // FIRST heading wins: a roadmap that mentions a phase twice is naming it once and
      // referring to it afterwards.
      if (!byNumber.has(n)) byNumber.set(n, { n, title: stripLeadingAside(full) })
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
 * derivePhaseCard({projectDir, phaseId, fsImpl, parkedRows}) → one phase in full, or null when
 * the project has no such directory.
 *
 * {id, name, stages, questions, plans, summaries, uat}. The plans and summaries travel as
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
 * @param {{projectDir?:string, phaseId?:string|number, fsImpl?:object, parkedRows?:object[]}} [deps]
 * @returns {object|null}
 */
export function derivePhaseCard({ projectDir, phaseId, fsImpl, parkedRows } = {}) {
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

  return {
    id: dir,
    name: phaseTitleOf(dir, roadmapTitles(projectDir, io)),
    stages: stagesOf(files),
    questions,
    plans: artifactsOf(files, dir, '-PLAN.md'),
    summaries: artifactsOf(files, dir, '-SUMMARY.md'),
    uat: acceptance.items,
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
 * deriveState(deps) → the one-poll roster payload {kpis, queue, awaiting, workers, done,
 * spend}. (Task 4 augments it with costs.series over GET /api/state.) Pure over its
 * injected collaborators; re-derives fresh every call.
 *
 * `awaiting` exists because the day screen rides ROWS: it has to name the tasks that are
 * holding for a person's word, and a counter gives it nothing to show. It is derived from
 * the same rows the counter is, so the two can never fall out of step.
 *
 * @param {{
 *   adapter: {list:Function},
 *   ledgerDir?: string,
 *   windows?: (account:any)=>object,      // windowState per account (an injected seam)
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

  // The project filter narrows the TASKS only (the lists above are already built).
  const rows = deps.project ? allRows.filter((r) => projectOf(r, activeProject) === deps.project) : allRows

  const queuedRows = rows.filter((r) => r.status === 'queued')
  const claimedRows = rows.filter((r) => r.status === 'claimed')
  const awaitingRows = rows.filter((r) => r.status === 'awaiting_approval')
  const doneRows = rows.filter((r) => r.status === 'completed' || r.status === 'failed')

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
      project: projectOf(r, activeProject),
      machine: machineId,
      ...(r.provider ? { provider: r.provider } : {}),
      priority: Number(r.priority) || 0,
      status: r.status,
      position: i + 1,
    }
    if (ageMs > agingMs) out.agedForHours = Math.floor(ageMs / HOUR_MS) // «застряла» signal
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
  // longest comes first — waiting is the whole cost here, so priority has no say. The
  // queue keeps meaning what it says: rows waiting for a WORKER, never for a person. ──
  const awaiting = [...awaitingRows]
    .sort((a, b) => (toMs(a.enqueuedAt) || 0) - (toMs(b.enqueuedAt) || 0))
    .map(toTaskRow)

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
    const touchMs = active ? toMs(active.lastTouch ?? active.claimedAt) : NaN
    const pulseAgeSec = Number.isFinite(touchMs) ? Math.max(0, Math.round((now - touchMs) / 1000)) : undefined
    const presence = derivePresence({ windowOpen: open, hasActiveTask: !!active, pulseAgeSec })

    return {
      id: w.id,
      lane: w.lane,
      account: accountName,
      ...(active
        ? {
            taskId: active.id,
            taskTitle: active.title ?? null,
            project: projectOf(active, activeProject),
            branch: `wt/${active.id}`,
          }
        : {}),
      window: bar,
      ...(pulseAgeSec !== undefined ? { pulseAgeSec } : {}),
      presence,
    }
  })

  // ── done[] — «сделано за ночь»; durable sources only ──
  const done = doneRows.map((r) =>
    buildDoneRow(r, { readTaskAttempts, readReceipt, execGit, activeProject, machineId }),
  )

  // ── accounts — the deduped subscription list the spend strip ALSO rides (one dedup,
  // one window read per account, one order both sections agree on) ──
  const accounts = deriveAccounts(config, windows)
  const spendAccounts = accounts.map((a) => ({ name: a.name, pct5h: a.windows.pct5h, pctWeek: a.windows.pctWeek }))

  const apiAccountName = (config.budget && config.budget.apiAccountName) || 'api'
  const todayUsd = totalCost(usageReader, workersCfg, DAY_MS, now, apiAccountName)
  const monthUsd = totalCost(usageReader, workersCfg, MONTH_MS, now, apiAccountName)
  const capEur = Number(config.budget && config.budget.monthlyApiCapEur) || 0
  const anyClosed = workers.some((w) => w.window.closedUntil != null || (w.window.pct5h ?? 0) >= 100)
  const switchMode = anyClosed && capEur > 0 ? 'api' : 'subscription'
  const spend = {
    accounts: spendAccounts,
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

  const payload = {
    kpis,
    queue,
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

/** Build ONE «сделано за ночь» row from a durable done/failed adapter row + the ledger. */
function buildDoneRow(r, { readTaskAttempts, readReceipt, execGit, activeProject, machineId }) {
  const attempts = readTaskAttempts(r.id)
  const last = attempts.length ? attempts[attempts.length - 1] : null
  const receipt = parseReceiptSummary(last && last.receiptRef, { readReceipt })

  const branch = `wt/${r.id}`
  let commits = []
  let diffStat = null
  if (typeof execGit === 'function') {
    try {
      commits = String(execGit(['log', '--oneline', `-${DONE_COMMIT_CAP}`, branch]) || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, DONE_COMMIT_CAP)
    } catch {
      commits = []
    }
    try {
      diffStat = String(execGit(['diff', '--shortstat', `main...${branch}`]) || '').trim() || null
    } catch {
      diffStat = null
    }
  }

  const out = {
    id: r.id,
    title: r.title ?? null,
    project: projectOf(r, activeProject),
    machine: machineId ?? 'self',
    finishedAt: r.completedAt ?? null,
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
