/**
 * windows.mjs — per-account rolling-window state, honest by construction.
 *
 * WHAT IT IS: the model behind the roster's % window bars. It answers, per account: how
 * full is the 5h / weekly window, and is the account currently open for work?
 *
 * THREE SOURCES, IN ORDER OF AUTHORITY:
 *   (a) OBSERVATION — the CLI's own `rate_limit_event` carries the vendor's view of a window:
 *       which one, what fraction of it is spent, when it resets. This is the reading that
 *       includes the sessions a PERSON ran in their own terminal, which is most of them on a
 *       real machine, and it is preferred wherever a live one exists.
 *   (b) ESTIMATE — where nobody has reported a window, pct5h / pctWeek derive from the
 *       runner's OWN token accounting (usageReader = readUsage from usage.mjs, injected)
 *       against coarse per-account capacity constants. `measured` says which bars are which,
 *       and `estimated` stays true while any bar is still a guess.
 *   (c) GROUND-TRUTH CLOSE — when the CLI returns a rate-limit error it carries a reset time;
 *       the loop calls markWindowClosed() to PERSIST that close, and windowState reports
 *       closedUntil until it expires. A refusal outranks any percentage.
 *
 * THE ASSUMPTION THIS FILE WAS BUILT ON WAS WRONG, AND IT MATTERED. The module was written
 * around «there is no official quota API», so the bars were estimated from what this daemon
 * had spawned — and on a machine where the founder works in his own terminal all day, that is
 * not merely coarse but systematically low. It read near zero on an account three quarters
 * spent, which is the opposite of the question the screen exists to answer. The event was
 * there the whole time, on every spawn, unparsed.
 *
 * AN OBSERVATION EXPIRES. It describes a rolling window at a moment; past the reset it
 * carries, that window is gone and the number would be a stale high reading that keeps a
 * healthy account looking exhausted. Expiry falls back to the estimate rather than to silence.
 *
 * DEGRADATION IS SAFE: with no observation the estimates behave exactly as before; scheduling
 * degrades to reactive (exhaustion → wait or API-fallback per the budget rule) — never a
 * silent stop, never a dishonest bar.
 *
 * SEAM: windows.mjs NEVER imports usage.mjs — the loop wires readUsage in through the
 * `usageReader` DI seam, and tests inject fakes. Persisted closes live under
 * `<dataDir>/windows/<account>.json` written via atomicWriteJson (plan-01 zero-dep posture).
 *
 * Node built-ins + the zero-dep fs-atomics helper only; clock + fs injectable.
 */

import { atomicWriteJson, readJsonSafe } from '../../../scripts/sma/lib/fs-atomics.mjs'
import { join } from 'node:path'

/** Rolling-window spans. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * DEFAULT_CAPACITY — coarse per-account token budgets for the % estimate (A3: no official
 * quota API, so these are honest guesses, config-overridable per account). They exist only
 * to turn a token count into a bar; the rate-limit ground truth is what actually gates work.
 */
export const DEFAULT_CAPACITY = Object.freeze({ fiveHourTokens: 8_000_000, weekTokens: 80_000_000 })

/** accountName from an account profile (object) or a bare string. */
function nameOf(account) {
  if (typeof account === 'string') return account
  return account?.name
}

/** Whole-percent of used vs capacity (0 when capacity is non-positive; never negative). */
function pctOf(usedTokens, capacityTokens) {
  if (!(capacityTokens > 0)) return 0
  return Math.max(0, Math.round((100 * usedTokens) / capacityTokens))
}

/** Epoch-ms of a resetAt that may be a number or an ISO string; NaN when unparseable. */
function toMs(resetAt) {
  if (typeof resetAt === 'number') return resetAt
  const t = Date.parse(resetAt)
  return Number.isFinite(t) ? t : NaN
}

/**
 * windowState({account, usageReader, clock, dataDir, fsImpl, capacity}) → the honest state.
 *
 * `estimated` and `measured` are ALWAYS present: the first says «at least one of these bars is
 * a guess», the second says which. `closedUntil` is present ONLY when a persisted ground-truth
 * close has a reset time still in the future, and it outranks every percentage here.
 *
 * @param {{
 *   account: (string|{name:string, capacity?:object}),
 *   usageReader: (args:{accountName:string, windowMs:number, clock:Function})=>{inputTokens:number, outputTokens:number},
 *   clock?: ()=>number,
 *   dataDir?: string,        // when set, the persisted close under <dataDir>/windows/<account>.json is honored
 *   fsImpl?: {readFileSync?:Function},
 *   capacity?: {fiveHourTokens:number, weekTokens:number},
 * }} opts
 * @returns {{accountName:string|undefined, pct5h:number, pctWeek:number, estimated:boolean, measured:{fiveHour:boolean, week:boolean}, fiveHourResetsAt?:number, weekResetsAt?:number, closedUntil?:(number|string)}}
 */
export function windowState({ account, usageReader, clock = Date.now, dataDir, fsImpl, capacity } = {}) {
  const accountName = nameOf(account)
  const cap = capacity ?? (typeof account === 'object' ? account?.capacity : undefined) ?? DEFAULT_CAPACITY
  const read = typeof usageReader === 'function' ? usageReader : () => ({ inputTokens: 0, outputTokens: 0 })

  const u5 = read({ accountName, windowMs: FIVE_HOURS_MS, clock }) || {}
  const uW = read({ accountName, windowMs: WEEK_MS, clock }) || {}
  const tokens5 = (Number(u5.inputTokens) || 0) + (Number(u5.outputTokens) || 0)
  const tokensW = (Number(uW.inputTokens) || 0) + (Number(uW.outputTokens) || 0)

  const rec = dataDir
    ? readJsonSafe(join(dataDir, 'windows', `${accountName}.json`), { readFn: fsImpl?.readFileSync })
    : null

  // ── the vendor's own reading, when there is a live one ──
  // A subscription window is a fact about the ACCOUNT, and the estimate below can only ever
  // see what this daemon spawned. On a machine where a person also works in their own
  // terminal — which is every machine — the estimate is therefore not merely coarse but
  // systematically low, and it read near zero on an account that was three quarters spent.
  // An observation is preferred wherever one exists, per window, and only the windows nobody
  // has reported stay estimates.
  const five = liveObservation(rec, FIVE_HOUR_LIMIT, clock)
  const week = liveObservation(rec, SEVEN_DAY_LIMIT, clock)

  const state = {
    accountName,
    pct5h: five ? pctOfFraction(five.utilization) : pctOf(tokens5, cap.fiveHourTokens),
    pctWeek: week ? pctOfFraction(week.utilization) : pctOf(tokensW, cap.weekTokens),
    // The single flag keeps its old meaning — «at least one of these bars is a guess» — so no
    // reader is newly told that a guess is measured. `measured` says WHICH, for a screen that
    // wants to label one bar and not the other.
    estimated: !(five && week),
    measured: { fiveHour: !!five, week: !!week },
  }
  if (five?.resetsAt != null) state.fiveHourResetsAt = five.resetsAt
  if (week?.resetsAt != null) state.weekResetsAt = week.resetsAt

  // Ground-truth close: a persisted rate-limit reset that is still in the future overrides.
  if (rec && rec.resetAt != null) {
    const resetMs = toMs(rec.resetAt)
    if (Number.isFinite(resetMs) && resetMs > clock()) state.closedUntil = rec.resetAt
  }

  return state
}

/** The window names the CLI reports, as it spells them. */
export const FIVE_HOUR_LIMIT = 'five_hour'
export const SEVEN_DAY_LIMIT = 'seven_day'

/** A fraction on the wire (0.73) becomes the whole percent a bar is drawn from. */
function pctOfFraction(fraction) {
  const n = Number(fraction)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n * 100)))
}

/**
 * The observation of one window, IF it is still about the window we are in.
 *
 * An observation is a snapshot of a rolling window that has since kept rolling, so it expires
 * at the reset time it carries: past that moment the window it described no longer exists and
 * its number would be a stale high reading that keeps a healthy account looking exhausted.
 * An observation with no reset time cannot be aged and is therefore not trusted to survive —
 * the estimate is a better answer than an undatable one.
 */
function liveObservation(rec, limitType, clock) {
  const all = rec && typeof rec.observed === 'object' && rec.observed !== null ? rec.observed : null
  const one = all && typeof all[limitType] === 'object' ? all[limitType] : null
  if (!one || !Number.isFinite(Number(one.utilization))) return null
  const resetMs = toMs(one.resetsAt)
  if (!Number.isFinite(resetMs) || resetMs <= clock()) return null
  return one
}

/**
 * markWindowClosed({dataDir, accountName, resetAt, clock, fsImpl}) — persist a ground-truth
 * window close (the CLI rate-limit error carries the reset time). Written atomically under
 * `<dataDir>/windows/<account>.json` so it survives a daemon restart. Returns the record.
 *
 * @param {{dataDir:string, accountName:string, resetAt:(number|string), clock?:()=>number, fsImpl?:object}} opts
 * @returns {{accountName:string, resetAt:(number|string), closedAt:string}}
 */
export function markWindowClosed({ dataDir, accountName, resetAt, clock = Date.now, fsImpl } = {}) {
  const path = join(dataDir, 'windows', `${accountName}.json`)
  // MERGE, for the same reason markWindowObserved does: this file now holds the window
  // READINGS as well as the close, and a whole-file write here would delete them — leaving the
  // roster back on its estimates the moment an account was refused, which is precisely the
  // moment a person looks at the bars.
  const previous = readJsonSafe(path, { readFn: fsImpl?.readFileSync }) || {}
  const record = {
    ...previous,
    accountName,
    resetAt,
    closedAt: new Date(clock()).toISOString(),
  }
  atomicWriteJson(path, record, {
    mkdirFn: fsImpl?.mkdirSync,
    writeFn: fsImpl?.writeFileSync,
    renameFn: fsImpl?.renameSync,
  })
  return record
}

/**
 * markWindowObserved({dataDir, accountName, observation, clock, fsImpl}) — persist ONE window
 * reading the vendor sent, and return the whole record.
 *
 * MERGE, NEVER REPLACE. Three separate facts share this file: the ground-truth close, the
 * five-hour reading and the seven-day one. The CLI reports whichever window is closest to
 * biting, so consecutive spawns write DIFFERENT keys — and a whole-file write would mean each
 * new reading silently deleted the other two. The record is read first and written back with
 * one key changed.
 *
 * A reading with no window name, no utilization or no reset time is DROPPED rather than
 * stored: the freshness rule that keeps a stale high number off the screen can only work on a
 * reading that can be dated, and a percentage that never expires is worse than an estimate.
 *
 * @param {{dataDir:string, accountName:string, observation:{limitType?:string, utilization?:number, resetsAt?:number, status?:string, usingOverage?:boolean}, clock?:()=>number, fsImpl?:object}} opts
 * @returns {object|null} the record as written, or null when the reading was not storable
 */
export function markWindowObserved({ dataDir, accountName, observation, clock = Date.now, fsImpl } = {}) {
  const o = observation && typeof observation === 'object' ? observation : {}
  const limitType = typeof o.limitType === 'string' && o.limitType.trim() ? o.limitType : null
  const utilization = Number(o.utilization)
  const resetsAt = toMs(o.resetsAt)
  if (!dataDir || !accountName || !limitType) return null
  if (!Number.isFinite(utilization) || !Number.isFinite(resetsAt)) return null

  const path = join(dataDir, 'windows', `${accountName}.json`)
  const previous = readJsonSafe(path, { readFn: fsImpl?.readFileSync }) || {}
  const record = {
    ...previous,
    accountName,
    observed: {
      ...(previous.observed && typeof previous.observed === 'object' ? previous.observed : {}),
      [limitType]: {
        utilization,
        resetsAt,
        ...(typeof o.status === 'string' && o.status ? { status: o.status } : {}),
        ...(o.usingOverage === true ? { usingOverage: true } : {}),
        at: new Date(clock()).toISOString(),
      },
    },
  }
  atomicWriteJson(path, record, {
    mkdirFn: fsImpl?.mkdirSync,
    writeFn: fsImpl?.writeFileSync,
    renameFn: fsImpl?.renameSync,
  })
  return record
}

/**
 * isOpen(state, clock) — a window is CLOSED iff a ground-truth close is still in the future
 * OR the 5h estimate has reached 100%. Everything else is open.
 *
 * @param {{pct5h?:number, closedUntil?:(number|string)}} state
 * @param {()=>number} [clock]
 * @returns {boolean}
 */
export function isOpen(state, clock = Date.now) {
  if (!state) return true
  if (state.closedUntil != null) {
    const resetMs = toMs(state.closedUntil)
    if (Number.isFinite(resetMs) && resetMs > clock()) return false
  }
  if (Number(state.pct5h) >= 100) return false
  return true
}
