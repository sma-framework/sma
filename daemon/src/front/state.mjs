/**
 * state.mjs — the roster's ONE-POLL payload: derive everything, store nothing (Phase
 * 9.5 Plan 08, Task 2; D-9.5-02, D-9.5-11, Pitfall 2).
 *
 * ═══════════════════════ DERIVE, NEVER STORE ═════════════════════════════════════
 * deriveState re-computes the WHOLE roster truth from durable sources every call — the
 * pg-boss rows (adapter.list), the per-attempt ledger, the honest window model, and the
 * usage book. No cache, no memo: a poll after ANY daemon restart is correct by
 * construction (D-9.5-02 statelessness). The poll cadence (2-5s) is the researched
 * choice; the live-hint SSE layer (Task 4) is additive, never the source of truth.
 *
 * ═══════════════════════ PATTERN 2 — TWO LIVENESS AXES ═══════════════════════════
 * The payload exposes BOTH axes but labels them: the QUEUE axis (counts, status,
 * agedForHours) drives requeue decisions UPSTREAM (the tick), never the roster; the
 * PULSE axis (pulseAgeSec) is an attention hint for the human. `presence` is a PURE
 * derive (window open × active task × touch freshness) — there is NO stored «working»
 * flag anywhere for it to read (Pitfall 2, Multica's top prod complaint).
 *
 * ═══════════════════════ D-9.5-11 CARRY (plan 09 renders) ═══════════════════════
 *   - agedForHours on a queue row ONLY when it has been queued past config.agingHours
 *     (pure derive from the D-9.5-10 enqueuedAt timestamp, never a stored flag);
 *   - `acceptance` («обещано») carried onto done rows when the task had one, omitted
 *     when it did not (roster/return tasks are DoR-exempt);
 *   - failed rows carry {reason, reasonLabel} — reasonLabel from REASON_LABELS
 *     (adapter.mjs, the single source); the raw code still travels for machines.
 *
 * ═══════════ V5.1 — PROJECTS, MACHINES, FEDERATION (D-9.7-01 / D-9.7-04) ═════════
 * The payload gains `projects[]`, `activeProject`, `machines[]` and `federation` — all
 * DERIVED, none stored: projects come from the config registry, their counts from the
 * queue selection, the machine from the config plus its federation role.
 *
 * THE SHAPE IS FINAL NOW, ON PURPOSE. `machines[]` holds this machine
 * ({id, title, role:'self', online:true}) and `federation.hubReachable` exists before
 * anything probes a hub. The SPA (plan 9.7-04) types the contract once and never revises it.
 * `hubReachable` is an injectable seam (`deps.hubReachable`) defaulting to true: nothing
 * has proven a hub unreachable until a probe is wired.
 *
 * ═══════════ THE AGGREGATOR SEAM — FILLED, NEVER REDEFINED (D-9.7-01) ════════════
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
 * Nothing here carries a peer url, a peer token or free text (T-9.7-05): the federation
 * field is a role and a boolean, and that is the whole of it.
 *
 * ═══════════ V5.1 — THE SETTINGS READ MODELS (D-9.7-09 holds) ═══════════════════
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

import { isOpen } from '../policy/windows.mjs'
import { REASON_LABELS } from '../queue/adapter.mjs'
import { readAttempts } from '../queue/attempt-ledger.mjs'
import { parseNote } from '../../../scripts/sma/lib/frontmatter.mjs'
import { parseNoteToPair } from '../../../scripts/sma/lib/replay-exam.mjs'

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
 * 'свободен'. PURE (Pitfall 2): a CLOSED window dominates (→ «ждёт окно») even with
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
 * `connected` is whether the registry entry names a folder on disk (D-11-DEFER-18). The
 * default entry every install mints carries a NAME and no path, so the screens showed a
 * project they could not read a single file of: «Память» answered «нет подключённого
 * проекта» while «Машины и проекты» listed the project by name. An entry that names a
 * project it cannot open is the worst of the three states, so the fact travels and the
 * screens say it. The PATH itself never does — an absolute path on the wire is a disclosure
 * (T-11-09-01), and a boolean is the whole of what a screen needs.
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
 * aggregator appends the peers into the SAME shape (T-9.7-05 keeps their url/token out).
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
 * its own right, T-9.5-01). The read model carries the account NAME and nothing else, so a
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
    // the founder's daytime account (D-9.5-03a) — a property of the ACCOUNT, flagged by
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
 * The note's own line, in whichever generation of the schema wrote it (D-11-DEFER-20).
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
 * every few seconds for no screen that needed it (T-9.7-35).
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
 * produced and can NEVER carry a sentence nobody redacted (D-9.5-08, T-9.7-35).
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
// SB-031 part 2 (phase 11 plan 09). The window shows a project the daemon does not own: its
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
//     about what the daemon happens to do today (founder decision SB-031 / D-11-08).

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
 *   windows?: (account:any)=>object,      // windowState per account (plan 05 seam)
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

  // ── workers[] — presence is a PURE derive (Pitfall 2). The roster is ALSO the only list
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

  const todayUsd = totalCost(usageReader, workersCfg, DAY_MS, now)
  const monthUsd = totalCost(usageReader, workersCfg, MONTH_MS, now)
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

  // ── costs.series — the SPA (9.6) cost view rides GET /api/state (D-9.5-05 РЕВИЗИЯ):
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

  // ── the settings read models — the SAME route, a fuller payload (D-9.7-09) ──
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
function totalCost(usageReader, workersCfg, windowMs, now) {
  if (typeof usageReader !== 'function') return 0
  const seen = new Set()
  let sum = 0
  for (const w of workersCfg) {
    const name = accountNameOf(w.account, w.id)
    if (seen.has(name)) continue
    seen.add(name)
    try {
      const u = usageReader({ accountName: name, windowMs, clock: () => now })
      sum += Number(u && u.costUsd) || 0
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
    diffStat,
    branch,
    commits,
    attempts: attempts.length || (Number.isFinite(r.attempt) ? r.attempt : 0),
  }
  // acceptance («обещано») — carried ONLY when the task had one (roster/return exempt).
  if (r.acceptance != null && String(r.acceptance).trim() !== '') out.acceptance = r.acceptance
  // failed red-card fields (D-9.5-11).
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
