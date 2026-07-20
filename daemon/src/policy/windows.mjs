/**
 * windows.mjs — per-account rolling-window state, honest by construction (Phase 9.5 Plan
 * 05, Task 2; Assumption A3, RESEARCH «Window awareness»).
 *
 * WHAT IT IS: the model behind the roster's % window bars. It answers, per account: how
 * full is the 5h / weekly window, and is the account currently open for work?
 *
 * ASSUMPTION A3 — THERE IS NO OFFICIAL QUOTA API for Claude Max windows. So this module is
 * honest about being an ESTIMATE plus a reactive ground truth:
 *   (a) ESTIMATE — pct5h / pctWeek derive from the runner's OWN token accounting
 *       (usageReader = readUsage from usage.mjs, injected) summed over the rolling window,
 *       against per-account capacity constants (config-overridable, coarse by design).
 *       Every derived state carries `estimated: true` so the roster labels the bars
 *       honestly — never presented as a vendor-authoritative number.
 *   (b) GROUND TRUTH — when the CLI returns a rate-limit error it carries a reset time; the
 *       loop calls markWindowClosed() to PERSIST that close. windowState then reports
 *       closedUntil from the persisted record until it expires, OVERRIDING the estimate.
 *       A real rate-limit always wins over a guess.
 *
 * DEGRADATION IS SAFE (A3): estimates stay coarse; scheduling degrades to reactive
 * (exhaustion → wait or API-fallback per the budget rule) — never a silent stop, never a
 * dishonest bar.
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
 * `estimated: true` is ALWAYS present. `closedUntil` is present ONLY when a persisted
 * ground-truth close has a reset time still in the future (it overrides the estimate).
 *
 * @param {{
 *   account: (string|{name:string, capacity?:object}),
 *   usageReader: (args:{accountName:string, windowMs:number, clock:Function})=>{inputTokens:number, outputTokens:number},
 *   clock?: ()=>number,
 *   dataDir?: string,        // when set, the persisted close under <dataDir>/windows/<account>.json is honored
 *   fsImpl?: {readFileSync?:Function},
 *   capacity?: {fiveHourTokens:number, weekTokens:number},
 * }} opts
 * @returns {{accountName:string|undefined, pct5h:number, pctWeek:number, estimated:true, closedUntil?:(number|string)}}
 */
export function windowState({ account, usageReader, clock = Date.now, dataDir, fsImpl, capacity } = {}) {
  const accountName = nameOf(account)
  const cap = capacity ?? (typeof account === 'object' ? account?.capacity : undefined) ?? DEFAULT_CAPACITY
  const read = typeof usageReader === 'function' ? usageReader : () => ({ inputTokens: 0, outputTokens: 0 })

  const u5 = read({ accountName, windowMs: FIVE_HOURS_MS, clock }) || {}
  const uW = read({ accountName, windowMs: WEEK_MS, clock }) || {}
  const tokens5 = (Number(u5.inputTokens) || 0) + (Number(u5.outputTokens) || 0)
  const tokensW = (Number(uW.inputTokens) || 0) + (Number(uW.outputTokens) || 0)

  const state = {
    accountName,
    pct5h: pctOf(tokens5, cap.fiveHourTokens),
    pctWeek: pctOf(tokensW, cap.weekTokens),
    estimated: true, // A3: this is an estimate, always labeled as one
  }

  // Ground-truth close: a persisted rate-limit reset that is still in the future overrides.
  if (dataDir) {
    const rec = readJsonSafe(join(dataDir, 'windows', `${accountName}.json`), { readFn: fsImpl?.readFileSync })
    if (rec && rec.resetAt != null) {
      const resetMs = toMs(rec.resetAt)
      if (Number.isFinite(resetMs) && resetMs > clock()) state.closedUntil = rec.resetAt
    }
  }

  return state
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
  const record = {
    accountName,
    resetAt,
    closedAt: new Date(clock()).toISOString(),
  }
  atomicWriteJson(join(dataDir, 'windows', `${accountName}.json`), record, {
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
