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
 * Every collaborator (adapter, ledger reader, the window-state function, usageReader,
 * the git/receipt readers, clock) is dependency-injected, so tests derive from fixtures
 * with no real Postgres / git / fs. Node built-ins only; zero deps; zero network.
 */

import { isOpen } from '../policy/windows.mjs'
import { REASON_LABELS } from '../queue/adapter.mjs'
import { readAttempts } from '../queue/attempt-ledger.mjs'

const HOUR_MS = 3600000
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
/** Touch freshness for the «работает» presence: a claimed task touched within this. */
const FRESH_TOUCH_SEC = 180
const DONE_COMMIT_CAP = 10

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

/** A payload window bar — ALWAYS carries estimated (honest labels, A3). */
function windowBar(win) {
  return {
    pct5h: numOrNull(win.pct5h) ?? 0,
    pctWeek: numOrNull(win.pctWeek) ?? 0,
    estimated: win.estimated === undefined ? true : Boolean(win.estimated),
    ...(win.closedUntil != null ? { closedUntil: win.closedUntil } : {}),
  }
}

/**
 * deriveState(deps) → the one-poll roster payload {kpis, queue, workers, done, spend}.
 * (Task 4 augments it with costs.series over GET /api/state.) Pure over its injected
 * collaborators; re-derives fresh every call.
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

  let rows = []
  try {
    rows = (await adapter.list({})) || []
  } catch {
    rows = []
  }
  const queuedRows = rows.filter((r) => r.status === 'queued')
  const claimedRows = rows.filter((r) => r.status === 'claimed')
  const awaitingRows = rows.filter((r) => r.status === 'awaiting_approval')
  const doneRows = rows.filter((r) => r.status === 'completed' || r.status === 'failed')

  // ── queue[] — ordered by priority desc, then enqueuedAt asc (the claimNext order) ──
  const orderedQueue = [...queuedRows].sort((a, b) => {
    const pa = Number(a.priority) || 0
    const pb = Number(b.priority) || 0
    if (pb !== pa) return pb - pa
    return (toMs(a.enqueuedAt) || 0) - (toMs(b.enqueuedAt) || 0)
  })
  const queue = orderedQueue.map((r, i) => {
    const enq = toMs(r.enqueuedAt)
    const ageMs = Number.isFinite(enq) ? now - enq : 0
    const out = {
      id: r.id,
      title: r.title ?? null,
      lane: r.lane ?? null,
      ...(r.provider ? { provider: r.provider } : {}),
      priority: Number(r.priority) || 0,
      status: r.status,
      position: i + 1,
    }
    if (ageMs > agingMs) out.agedForHours = Math.floor(ageMs / HOUR_MS) // «застряла» signal
    return out
  })

  // ── workers[] — presence is a PURE derive (Pitfall 2) ──
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
      ...(active ? { taskId: active.id, branch: `wt/${active.id}` } : {}),
      window: bar,
      ...(pulseAgeSec !== undefined ? { pulseAgeSec } : {}),
      presence,
    }
  })

  // ── done[] — «сделано за ночь»; durable sources only ──
  const done = doneRows.map((r) => buildDoneRow(r, { readTaskAttempts, readReceipt, execGit }))

  // ── spend strip — per (deduped) account % bars + the API-fallback € budget ──
  const seen = new Set()
  const spendAccounts = []
  for (const w of workersCfg) {
    const name = accountNameOf(w.account, w.id)
    if (seen.has(name)) continue
    seen.add(name)
    const bar = windowBar(windowFor(windows, w.account ?? name))
    spendAccounts.push({ name, pct5h: bar.pct5h, pctWeek: bar.pctWeek })
  }
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

  return { kpis, queue, workers, done, spend, costs }
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
function buildDoneRow(r, { readTaskAttempts, readReceipt, execGit }) {
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
