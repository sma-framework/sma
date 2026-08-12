/**
 * windows.mjs — per-account subscription windows, said only as far as they are known.
 *
 * WHAT IT IS: the model behind everything the window says about a subscription — is this
 * account taking work right now, and when does its window turn over.
 *
 * WHAT THE VENDOR ACTUALLY SENDS, verified on a live stream on 12.08.2026:
 *
 *     {"type":"rate_limit_event","rate_limit_info":{
 *        "status":"allowed","resetsAt":1786539600,"rateLimitType":"five_hour",
 *        "overageStatus":"rejected","overageDisabledReason":"out_of_credits",
 *        "isUsingOverage":false}}
 *
 * Three facts and no fourth: WHICH window, WHETHER it is still letting work through, and
 * WHEN it resets. There is no fraction of the window spent. There never was one on this
 * stream, and no other programmatic source has one either — the interactive `/status`
 * command is a command of the interface and cannot be called from here.
 *
 * WHY THERE IS NO PERCENTAGE HERE ANY MORE. The screen showed «0%» on a subscription that was
 * being spent all day, and it got there by TWO roads that both ended in a zero:
 *
 *   (a) where nothing had been reported, an ESTIMATE — this daemon's own token accounting
 *       against a made-up per-account capacity constant. On a machine where a person also
 *       works in his own terminal, that count sees only the sessions this daemon spawned, so
 *       it reads near zero on an account three quarters spent;
 *   (b) where a reading HAD arrived, the missing fraction itself. The provider sends no
 *       `utilization`, the parser honestly reported it as null, and `Number(null)` is 0 — so
 *       the reading was stored and drawn as «0% spent», labelled as the provider's own
 *       measurement. That is the worse of the two: an estimate at least admitted to being one.
 *
 * A person reads a zero bar as «the quota is free». A number nobody measured, presented as a
 * measurement, is not a rough answer — it is a confident wrong answer to the exact question the
 * screen exists to answer. Both roads are closed. What is not known is reported as not known,
 * and the token count this machine really did spend is shown as OUR count, next to the work it
 * paid for, where it means what it says.
 *
 * WHAT THIS MODULE ANSWERS, per window: `status` — `open`, `exhausted` or `unknown` — plus
 * `resetsAt` when the vendor named one, and `pct` ONLY on the day the vendor starts sending
 * a utilization fraction (null until then; never a stand-in).
 *
 * AN OBSERVATION EXPIRES. It describes a rolling window at a moment; past the reset it
 * carries, that window is gone, so the reading goes back to `unknown` rather than to a stale
 * `exhausted` that would keep a healthy account looking refused. Expiry falls back to
 * silence, because silence is the truth at that point.
 *
 * DEGRADATION IS SAFE: `unknown` is treated as open, so a daemon that has never seen a
 * rate-limit frame behaves exactly as one that has — never a silent stop. A refusal is the
 * only thing that closes a window, and a refusal is always something the vendor said.
 *
 * Persisted state lives under `<dataDir>/windows/<account>.json` written via atomicWriteJson.
 * Node built-ins + the zero-dep fs-atomics helper only; clock + fs injectable.
 */

import { atomicWriteJson, readJsonSafe } from '../../../scripts/sma/lib/fs-atomics.mjs'
import { join } from 'node:path'

/** The window names the CLI reports, as it spells them. */
export const FIVE_HOUR_LIMIT = 'five_hour'
export const SEVEN_DAY_LIMIT = 'seven_day'

/**
 * The spellings each window has been seen under, most-canonical first. The vendor names the
 * weekly window `seven_day` on the stream and `week` in its own release notes; reading a
 * short list of aliases costs nothing and keeps a rename from silently emptying the screen.
 * A reading under a name that is on neither list is stored but not drawn — inventing which
 * window an unknown name refers to is exactly the class of guess this module just removed.
 */
const FIVE_HOUR_KEYS = [FIVE_HOUR_LIMIT, 'five_hours', 'fiveHour']
const WEEK_KEYS = [SEVEN_DAY_LIMIT, 'week', 'weekly', 'seven_days']

/** Nothing has been heard about this window. NOT «empty» — unheard. */
const UNKNOWN = Object.freeze({ status: 'unknown', resetsAt: null, pct: null, observedAt: null })

/** accountName from an account profile (object) or a bare string. */
function nameOf(account) {
  if (typeof account === 'string') return account
  return account?.name
}

/** Epoch-ms of a resetAt that may be a number or an ISO string; NaN when unparseable. */
function toMs(resetAt) {
  if (typeof resetAt === 'number') return resetAt
  const t = Date.parse(resetAt)
  return Number.isFinite(t) ? t : NaN
}

/**
 * readingSaysExhausted(reading) — does this reading mean the vendor has stopped letting work
 * through on that window?
 *
 * The healthy statuses the CLI sends all begin with `allowed` (`allowed`, and the warning
 * variant it sends as a window fills). Anything else it puts in that field is a refusal.
 * Matching on the OPEN wording rather than on a list of refusal words is deliberate: a new
 * refusal spelling then reads as a refusal — the cautious direction — instead of quietly
 * passing as healthy, and a new healthy spelling in that family still reads as open.
 *
 * A utilization of 1 is honoured too, for the day the vendor starts sending the fraction.
 *
 * @param {{status?:string, utilization?:number}} reading
 * @returns {boolean}
 */
export function readingSaysExhausted(reading) {
  if (!reading || typeof reading !== 'object') return false
  const util = Number(reading.utilization)
  if (Number.isFinite(util) && util >= 1) return true
  const status = typeof reading.status === 'string' ? reading.status.trim().toLowerCase() : ''
  if (!status) return false
  return !status.startsWith('allowed')
}

/**
 * The stored reading for ONE window, IF it is still about the window we are in.
 *
 * Past the reset time it carries, the window it described no longer exists and the reading
 * would be a stale answer about a window that has since turned over. A reading with no reset
 * time cannot be aged at all and is therefore never trusted to survive — «unknown» is a better
 * answer than an undatable one.
 */
function factOf(rec, keys, clock) {
  const all = rec && typeof rec.observed === 'object' && rec.observed !== null ? rec.observed : null
  if (!all) return UNKNOWN
  for (const key of keys) {
    const one = all[key]
    if (!one || typeof one !== 'object') continue
    const resetMs = toMs(one.resetsAt)
    if (!Number.isFinite(resetMs) || resetMs <= clock()) continue
    const util = Number(one.utilization)
    return {
      status: readingSaysExhausted(one) ? 'exhausted' : 'open',
      resetsAt: resetMs,
      // Present ONLY when the vendor sent a fraction. It does not today; the field is here so
      // that the day it does, the number on the glass is its number and nobody's arithmetic.
      pct: Number.isFinite(util) ? Math.max(0, Math.min(100, Math.round(util * 100))) : null,
      observedAt: typeof one.at === 'string' ? one.at : null,
    }
  }
  return UNKNOWN
}

/**
 * windowState({account, clock, dataDir, fsImpl}) → what is known about this account's windows.
 *
 * `fiveHour` and `week` are ALWAYS present and always carry a `status` of `open`, `exhausted`
 * or `unknown` — a caller never has to tell an absent field from a false one. `closedUntil` is
 * present ONLY when a persisted refusal has a reset time still in the future, and it outranks
 * both windows.
 *
 * @param {{
 *   account: (string|{name:string}),
 *   clock?: ()=>number,
 *   dataDir?: string,        // when set, the persisted readings under <dataDir>/windows/<account>.json are read
 *   fsImpl?: {readFileSync?:Function},
 * }} opts
 * @returns {{accountName:string|undefined, fiveHour:object, week:object, closedUntil?:(number|string)}}
 */
export function windowState({ account, clock = Date.now, dataDir, fsImpl } = {}) {
  const accountName = nameOf(account)

  const rec = dataDir
    ? readJsonSafe(join(dataDir, 'windows', `${accountName}.json`), { readFn: fsImpl?.readFileSync })
    : null

  const state = {
    accountName,
    fiveHour: factOf(rec, FIVE_HOUR_KEYS, clock),
    week: factOf(rec, WEEK_KEYS, clock),
  }

  // Ground-truth close: a persisted refusal whose reset time is still in the future overrides.
  if (rec && rec.resetAt != null) {
    const resetMs = toMs(rec.resetAt)
    if (Number.isFinite(resetMs) && resetMs > clock()) state.closedUntil = rec.resetAt
  }

  return state
}

/**
 * The snapshot the terminal's own status line lays down, under the same window store.
 *
 * WRITTEN BY scripts/sma/lib/statusline.mjs (recordTerminalWindows), which carries the same
 * literal — the two sides of a file contract, one writing and one reading, and a test asserts
 * they agree. The leading underscore keeps it from colliding with the per-account files beside
 * it, which are named after configured accounts.
 */
export const TERMINAL_WINDOWS_FILE = '_terminal.json'

/**
 * terminalWindowState({dataDir, clock, fsImpl}) → what the person's OWN terminal last reported
 * about its subscription windows.
 *
 * WHY THIS IS A SUBJECT OF ITS OWN, AND NOT AN ACCOUNT'S READING. Claude Code pipes the window
 * percentages to the status line command it runs, and that is the one place a percentage exists
 * at all — the work stream this daemon spawns carries the window's name, health and reset, but
 * never a fraction. It is also a reading about the subscription THAT TERMINAL is signed into,
 * and nothing on that stdin names an account: attributing it to a configured worker account
 * would be a guess of exactly the kind this module exists to refuse. So it stands as itself,
 * labelled as the terminal's own, and no account row inherits it.
 *
 * It ages like every other reading: past the reset it carries, `unknown`. `observedAt` survives
 * that expiry on purpose — a screen that has to say «no fresh reading» still owes the person
 * the moment of the last one, and «last seen at 15:07» is a fact where a zero would be a claim.
 *
 * @param {{dataDir?:string, clock?:()=>number, fsImpl?:{readFileSync?:Function}}} [opts]
 * @returns {{observed:boolean, observedAt:string|null, fiveHour:object, week:object}}
 */
export function terminalWindowState({ dataDir, clock = Date.now, fsImpl } = {}) {
  const rec = dataDir
    ? readJsonSafe(join(dataDir, 'windows', TERMINAL_WINDOWS_FILE), { readFn: fsImpl?.readFileSync })
    : null
  const all = rec && typeof rec.observed === 'object' && rec.observed !== null ? rec.observed : null
  return {
    observed: !!all && Object.keys(all).length > 0,
    observedAt: lastSeenAt(rec),
    fiveHour: factOf(rec, FIVE_HOUR_KEYS, clock),
    week: factOf(rec, WEEK_KEYS, clock),
  }
}

/** The most recent moment any window in this record was seen — expired readings included. */
function lastSeenAt(rec) {
  const all = rec && typeof rec.observed === 'object' && rec.observed !== null ? rec.observed : null
  let best = null
  let bestMs = -Infinity
  for (const one of all ? Object.values(all) : []) {
    const at = one && typeof one.at === 'string' ? one.at : null
    const ms = at ? Date.parse(at) : NaN
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms
      best = at
    }
  }
  if (best) return best
  return rec && typeof rec.at === 'string' ? rec.at : null
}

/**
 * markWindowClosed({dataDir, accountName, resetAt, clock, fsImpl}) — persist a ground-truth
 * window close (a refused window carries the reset time). Written atomically under
 * `<dataDir>/windows/<account>.json` so it survives a daemon restart. Returns the record.
 *
 * @param {{dataDir:string, accountName:string, resetAt:(number|string), clock?:()=>number, fsImpl?:object}} opts
 * @returns {{accountName:string, resetAt:(number|string), closedAt:string}}
 */
export function markWindowClosed({ dataDir, accountName, resetAt, clock = Date.now, fsImpl } = {}) {
  const path = join(dataDir, 'windows', `${accountName}.json`)
  // MERGE, for the same reason markWindowObserved does: this file holds the window READINGS as
  // well as the close, and a whole-file write here would delete them — leaving the screen with
  // nothing to say at the exact moment an account was refused, which is precisely the moment a
  // person looks at it.
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
 * five-hour reading and the weekly one. The CLI reports whichever window is closest to biting,
 * so consecutive spawns write DIFFERENT keys — and a whole-file write would mean each new
 * reading silently deleted the other two. The record is read first and written back with one
 * key changed.
 *
 * WHAT MAKES A READING STORABLE: a window name and a reset time. NOT a utilization — the
 * vendor does not send one. It used to be required, and the requirement did NOT reject the
 * readings: `Number(null)` is 0 and 0 is finite, so every real reading passed the guard and was
 * filed as «0% of this window is spent». That is worse than dropping it would have been — the
 * screen then showed a MEASURED-looking zero, sourced to the provider, for a quantity the
 * provider had never mentioned. The reset time is still required, because the freshness rule
 * that keeps a stale answer off the screen can only work on a reading that can be dated.
 *
 * @param {{dataDir:string, accountName:string, observation:{limitType?:string, utilization?:number, resetsAt?:number, status?:string, usingOverage?:boolean}, clock?:()=>number, fsImpl?:object}} opts
 * @returns {object|null} the record as written, or null when the reading was not storable
 */
export function markWindowObserved({ dataDir, accountName, observation, clock = Date.now, fsImpl } = {}) {
  const o = observation && typeof observation === 'object' ? observation : {}
  const limitType = typeof o.limitType === 'string' && o.limitType.trim() ? o.limitType.trim() : null
  const resetsAt = toMs(o.resetsAt)
  if (!dataDir || !accountName || !limitType) return null
  if (!Number.isFinite(resetsAt)) return null
  // AN ABSENT FRACTION MUST NOT BECOME A ZERO ONE. The parser hands `utilization: null` on
  // every real frame, and `Number(null)` is 0 — which is finite, so a bare Number() here stored
  // «0% spent» for a window the provider said nothing about, and the screen drew the same
  // confident zero this whole change exists to remove. Null is checked before the cast.
  const utilization = o.utilization == null ? NaN : Number(o.utilization)

  const path = join(dataDir, 'windows', `${accountName}.json`)
  const previous = readJsonSafe(path, { readFn: fsImpl?.readFileSync }) || {}
  const record = {
    ...previous,
    accountName,
    observed: {
      ...(previous.observed && typeof previous.observed === 'object' ? previous.observed : {}),
      [limitType]: {
        resetsAt,
        ...(Number.isFinite(utilization) ? { utilization } : {}),
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
 * isOpen(state, clock) — a window is CLOSED iff a ground-truth close is still in the future,
 * or the vendor's own reading of either window says it is no longer allowing work.
 *
 * `unknown` is OPEN. Nothing was heard, and refusing to spawn on the strength of a silence
 * would idle a healthy machine forever; a real refusal, when it comes, arrives on the stream
 * of the very next attempt and closes the window then.
 *
 * THE WEEKLY WINDOW CLOSES A WORKER TOO. Routing past a spent week means spawning a session
 * the subscription will refuse, which costs a whole attempt to learn what was already known.
 *
 * Accepts the internal state and the payload bar alike — both carry the same two facts under
 * the same two names, so the screen and the router can never disagree about who is open.
 *
 * @param {{fiveHour?:{status?:string}, week?:{status?:string}, closedUntil?:(number|string)}} state
 * @param {()=>number} [clock]
 * @returns {boolean}
 */
export function isOpen(state, clock = Date.now) {
  if (!state) return true
  if (state.closedUntil != null) {
    const resetMs = toMs(state.closedUntil)
    if (Number.isFinite(resetMs) && resetMs > clock()) return false
  }
  if (state.fiveHour && state.fiveHour.status === 'exhausted') return false
  if (state.week && state.week.status === 'exhausted') return false
  return true
}
