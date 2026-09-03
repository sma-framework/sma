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
 * At the top level: WHICH window, WHETHER it is still letting work through, and WHEN it resets.
 * There is no fraction of the window spent up there — but the same frame carries a
 * `unifiedWindows` block naming BOTH windows with the fraction spent in each, and that block is
 * read (see runner/stream.mjs). Until it was, the weekly window was refreshed only on the rare
 * frame that NAMED it — about once a day — and the board showed a week nineteen hours stale.
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
 * `resetsAt` when the vendor named one, and `pct` ONLY where the vendor itself sent a
 * utilization fraction (null everywhere else; never a stand-in). It does send one on the status
 * line payload, and by now sometimes on the work stream too — `source` says which reading a
 * fact came from when it was not the account's own.
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
import { sameConfigDir, readAccountUuid, sameAccountUuid } from '../../../scripts/sma/lib/config-dir.mjs'
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

/** The two windows this module can name, each with every spelling it answers to. */
const WINDOW_KEYS = Object.freeze({ fiveHour: FIVE_HOUR_KEYS, week: WEEK_KEYS })

/**
 * canonicalWindow(limitType) → `'fiveHour'`, `'week'`, or null for a name we cannot place.
 *
 * THE ONE PLACE THAT DECIDES WHICH WINDOWS EXIST, and the reason it is exported. There used to
 * be two answers to that question and they disagreed: the screen drew only the names on the two
 * lists above, while the close that stops a whole account fired on ANY name the provider put on
 * the stream. On 31.08.2026 the provider refused `seven_day_overage_included` — the weekly
 * window with the paid overage folded in, on an account whose paid channel is off and whose
 * overage ceiling is zero — and that name is on neither list. Nothing about it could reach a
 * screen, and it shut the subscription for five days with thirty tasks queued; half an hour
 * later the window that actually governs answered `allowed_warning` at 74 %.
 *
 * So a refusal now has to name a window we can SHOW before it is allowed to stop anything. A
 * window we cannot draw has no right to stop the conveyor: an operator who cannot see why the
 * work stopped cannot decide whether it should have.
 *
 * The match is exact bar the trim — deliberately the same comparison `factOf` makes when it
 * looks a reading up, so «can this be closed on» and «can this be shown» can never again be
 * two different questions.
 *
 * @param {string|null|undefined} limitType
 * @returns {'fiveHour'|'week'|null}
 */
export function canonicalWindow(limitType) {
  const name = typeof limitType === 'string' ? limitType.trim() : ''
  if (!name) return null
  for (const [canonical, keys] of Object.entries(WINDOW_KEYS)) {
    if (keys.includes(name)) return canonical
  }
  return null
}

/** Nothing has been heard about this window. NOT «empty» — unheard. */
const UNKNOWN = Object.freeze({ status: 'unknown', resetsAt: null, pct: null, observedAt: null })

/** accountName from an account profile (object) or a bare string. */
function nameOf(account) {
  if (typeof account === 'string') return account
  return account?.name
}

/**
 * The config directory of an account profile — the directory the daemon hands its sessions as
 * `CLAUDE_CONFIG_DIR`. It is where BOTH identity signals come from: the directory itself, and
 * the account the vendor recorded in that directory's own files. A bare account NAME carries
 * neither fact and gets neither invented for it.
 */
function configDirOf(account) {
  if (!account || typeof account !== 'object') return null
  return typeof account.configDir === 'string' && account.configDir.trim() ? account.configDir : null
}

/** Epoch-ms of a resetAt that may be a number or an ISO string; NaN when unparseable. */
function toMs(resetAt) {
  if (typeof resetAt === 'number') return resetAt
  const t = Date.parse(resetAt)
  return Number.isFinite(t) ? t : NaN
}

/**
 * utilizationFraction(value) → the fraction of a window spent, IN THE ONE SCALE THIS MODULE
 * SPEAKS, plus the scale the wire used to say it.
 *
 * WHY A GUESS ABOUT SCALE IS SAFER THAN NO GUESS HERE. Everything downstream reads this number
 * as a FRACTION: 0.67 is «две трети израсходовано», and one whole window means the vendor is
 * done letting work through (`readingSaysExhausted`). That reading came off a documented block
 * and off the worker's own fixtures — never off a frame anybody has captured from a live
 * stream, because the vendor has not sent one on this machine yet. If it turns out to send
 * PERCENTS, every reading arrives at 18 or 67 — both « >= 1 » — and the whole subscription
 * reads «исчерпано» from the first frame. That failure has no floor and no way back: `isOpen`
 * answers false, the router stops spawning on the account, and nothing corrects it until the
 * reset the reading names, which for the weekly window is SEVEN DAYS away. A stopped conveyor
 * that nobody said stopped is the worst outcome this file can produce.
 *
 * So the scale is decided by the value, and each decision errs where a mistake is cheap:
 *
 *   - `0…1` is a FRACTION, unchanged. This is what the block is documented to carry, and 1
 *     stays a full window — «исчерпано» on a genuine one is the answer that must survive.
 *   - `>1…100` is PERCENT, divided by a hundred. A fraction cannot exceed one, so nothing
 *     legitimate lands here; reading 67 as «67 %» costs nothing if the vendor never sends it
 *     and saves the account if it does. The caller writes the scale into the journal, because
 *     a value we RE-INTERPRETED must be visible to a person, not quietly right.
 *   - anything else — negative, or past a hundred — is DROPPED, and said out loud. It is not
 *     a number this model can place in either scale, and inventing a placement for it is how
 *     the zero this whole module exists to remove got onto the screen in the first place.
 *     A dropped fraction is «нет данных», which is honest; a wrong one is a claim.
 *
 * @param {unknown} value
 * @returns {{fraction:number|null, scale:'absent'|'fraction'|'percent'|'out-of-range'}}
 */
export function utilizationFraction(value) {
  // An ABSENT fraction must not become a zero one: `Number(null)` and `Number('')` are both 0,
  // and 0 is finite — the exact cast that once filed «0 % spent» for a window the provider had
  // said nothing about. Only something that really is a number is read as one.
  if (value == null || value === '' || typeof value === 'boolean') return { fraction: null, scale: 'absent' }
  const n = Number(value)
  if (!Number.isFinite(n)) return { fraction: null, scale: 'absent' }
  if (n < 0) return { fraction: null, scale: 'out-of-range' }
  if (n <= 1) return { fraction: n, scale: 'fraction' }
  if (n <= 100) return { fraction: n / 100, scale: 'percent' }
  return { fraction: null, scale: 'out-of-range' }
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
 * A utilization of 1 is honoured too, for the day the vendor starts sending the fraction — but
 * only after `utilizationFraction` has decided WHICH SCALE it arrived in. Read raw, a vendor
 * that starts sending percents would say «исчерпано» at 18 % spent and shut the account until
 * its reset.
 *
 * @param {{status?:string, utilization?:number}} reading
 * @returns {boolean}
 */
export function readingSaysExhausted(reading) {
  if (!reading || typeof reading !== 'object') return false
  const { fraction } = utilizationFraction(reading.utilization)
  if (fraction != null && fraction >= 1) return true
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
    const { fraction } = utilizationFraction(one.utilization)
    const said = typeof one.status === 'string' && one.status.trim() ? one.status.trim() : null
    return {
      status: readingSaysExhausted(one) ? 'exhausted' : 'open',
      resetsAt: resetMs,
      // Present ONLY when the vendor sent a fraction — which it does, for BOTH windows, in the
      // unified block of every rate-limit frame. The number on the glass is its number and
      // nobody's arithmetic; null still means it said nothing. Readings written before the
      // scale guard existed pass through it unchanged: they are already fractions.
      pct: fraction == null ? null : Math.max(0, Math.min(100, Math.round(fraction * 100))),
      observedAt: typeof one.at === 'string' ? one.at : null,
      // THE VENDOR'S HEALTH WORD, VERBATIM, and only where it really said one. A reading taken
      // out of the unified block carries a fraction and a reset and no word at all — it is
      // measurement, not permission — so `said` is absent there, and the one thing that turns
      // on it (lifting a standing refusal, below) refuses to fire on a silence. Absent rather
      // than null for the same reason `source` is: a field appears where there is something in
      // it. See the `source` note in windowState.
      ...(said ? { said } : {}),
    }
  }
  return UNKNOWN
}

/**
 * The terminal snapshot, IF it is a reading of THIS account's subscription — otherwise null,
 * and nothing is attributed. Two signals answer that, and they rank.
 *
 * FIRST, THE CONFIG DIRECTORY. The daemon spawns this account's sessions with it and the
 * status line records the one it is signed into, so equal directories are one subscription.
 *
 * SECOND, THE SIGNED-IN ACCOUNT, and only where the first said nothing. One subscription is
 * routinely entered through TWO directories — the person's own terminal through the default
 * one, the fleet through the separate one the daemon hands it so the workers keep a history of
 * their own — and on the directory alone those two read as strangers. The vendor writes the
 * account into each directory's own file, so each side is asked about ITSELF and the two
 * answers are compared: same account uuid, same subscription. That is identity of the same
 * kind as the directory, not a relaxation of it — nothing is matched on coinciding reset times
 * and no list of «treat these as the same» is kept anywhere (see config-dir.mjs for why both
 * of those fail silently).
 *
 * BOTH HALVES OF EITHER CHECK MUST BE REAL. An account with no `configDir` has no identity at
 * all and matches nothing — not even a snapshot that has one — because there is then no file
 * of its own to ask. A missing uuid on either side is likewise two absences rather than a
 * match (`sameAccountUuid` refuses them, and that refusal is the whole safety of the feature).
 * The uuid is read only when the snapshot carries one to compare against, so the common case
 * — directories equal — never opens the vendor's account file at all.
 */
function terminalRecordFor(configDir, dataDir, fsImpl) {
  if (!configDir) return null
  const rec = readJsonSafe(join(dataDir, 'windows', TERMINAL_WINDOWS_FILE), { readFn: fsImpl?.readFileSync })
  if (!rec) return null
  if (sameConfigDir(rec.configDir, configDir)) return rec
  if (!rec.accountUuid) return null
  const mine = readAccountUuid({ configDir, readFn: fsImpl?.readFileSync })
  return sameAccountUuid(rec.accountUuid, mine) ? rec : null
}

/**
 * A fact borrowed from the terminal snapshot, LABELLED as borrowed. An unknown stays exactly
 * the shared UNKNOWN — a window nothing was heard about gains no provenance, because there is
 * nothing to have a provenance.
 */
function fromTerminal(fact) {
  return fact.status === 'unknown' ? fact : { ...fact, source: 'terminal' }
}

/**
 * Of two readings of THE SAME SUBSCRIPTION, the one taken later — whichever mouth said it.
 *
 * The rule used to be «the account's own reading always wins, a borrowed one may only fill a
 * silence», and on 02.09.2026 that turned into a board a day out of date: the account's own
 * weekly reading said 67 % from nineteen hours earlier, a reading of the very same plan taken
 * two minutes earlier said 7 %, and the older one held the screen because it was ours. Provenance
 * is not recency. Once both readings are established to be about one subscription — and
 * `terminalRecordFor` establishes exactly that, by config directory or by the account uuid each
 * side reads out of its own files — the later reading is simply the current one.
 *
 * THE ONE EXCEPTION IS A REFUSAL, and it is the exception the whole model is built around. A
 * window this account was itself refused stays refused until the vendor's own «allowed» about
 * that window lifts it (see standingClose): a fresher measurement from another mouth is a
 * fraction spent, not permission to work, and letting it re-open a shut window would send the
 * router at a subscription that is going to refuse it.
 *
 * A borrowed reading that cannot be dated loses to an own reading that can — an undatable
 * reading cannot be shown to be the later one, and «later» is the entire claim being made.
 */
function fresherOf(own, borrowed) {
  if (own.status === 'exhausted') return own
  if (borrowed.status === 'unknown') return own
  if (own.status === 'unknown') return fromTerminal(borrowed)
  const theirs = borrowed.observedAt ? Date.parse(borrowed.observedAt) : NaN
  if (!Number.isFinite(theirs)) return own
  const ours = own.observedAt ? Date.parse(own.observedAt) : NaN
  if (Number.isFinite(ours) && ours >= theirs) return own
  return fromTerminal(borrowed)
}

/**
 * windowState({account, clock, dataDir, fsImpl}) → what is known about this account's windows.
 *
 * `fiveHour` and `week` are ALWAYS present and always carry a `status` of `open`, `exhausted`
 * or `unknown` — a caller never has to tell an absent field from a false one. `closedUntil` is
 * present ONLY when a persisted refusal has a reset time still in the future, and it outranks
 * both windows.
 *
 * A WINDOW NOBODY REPORTED CAN STILL BE KNOWN, IF THE TERMINAL IS SIGNED INTO THIS ACCOUNT.
 * The work stream reports whichever window is closest to biting, so consecutive spawns speak
 * about one window and the other quietly ages out: on the founder's own machine the five-hour
 * row had been «нет данных» for the better part of a day while a fresh reading of that very
 * subscription — WITH the percentage the work stream never carries — sat one file away, laid
 * down by the status line of a session running on this account. What was missing was never the
 * measurement; it was permission to say whose it was. `configDir` is that permission (see
 * config-dir.mjs): the daemon spawns this account's sessions with that directory, the status
 * line records the directory it is signed into, and a match is identity rather than
 * resemblance. So a window is filled from the terminal snapshot when the two sides are the same
 * subscription, and the fact says `source: 'terminal'` so every screen downstream can name
 * where its number came from.
 *
 * AND ONE SUBSCRIPTION HAS TWO DOORS. The person's terminal signs in through the default
 * directory; the fleet signs into the SAME subscription through the separate directory the
 * daemon gives it on purpose, so the workers keep a history that is not the person's. On the
 * directory alone those two are strangers, and the five-hour row went on saying «нет данных»
 * beside a percentage of that very plan read a minute earlier. So a second signal ranks under
 * the first: the account the vendor recorded in each directory's own file. Same account uuid,
 * same subscription — identity of the same kind, read from each side's own files, never a
 * human-kept list of pairs to treat as equal and never a match on reset times that coincide.
 *
 * AND OF TWO READINGS OF ONE PLAN, THE LATER ONE IS THE CURRENT ONE. «Ours always wins» held
 * the board a day out of date on 02.09.2026 — the account's own week said 67 % from nineteen
 * hours before, a reading of that same plan taken two minutes before said 7 %, and the stale
 * number stood because it was ours. Provenance is not recency, and once identity is established
 * the hour decides (see fresherOf). A REFUSAL is the exception: a window this account was
 * refused stays refused until the vendor's own «allowed» about that window lifts it.
 *
 * WHAT IS NOT DONE HERE. Where neither signal matches, or either side has no identity to offer,
 * nothing is attributed and the window keeps saying «unknown» — which is what a plan nobody
 * measured looks like.
 *
 * @param {{
 *   account: (string|{name:string, configDir?:string}),
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

  // The account's OWN readings, kept apart from what the terminal may lend below: only its own
  // word about a window may lift a close that was written about that window.
  const own = {
    fiveHour: factOf(rec, FIVE_HOUR_KEYS, clock),
    week: factOf(rec, WEEK_KEYS, clock),
  }
  const state = { accountName, ...own }

  // The terminal snapshot answers for this subscription too — when it IS this subscription.
  // It fills what this account has not heard about, and it also OUTRANKS an own reading it was
  // taken after: two readings of one plan are ranked by their hour, not by which mouth said
  // them (see fresherOf). A refusal is the one thing it may not touch.
  if (dataDir) {
    const terminal = terminalRecordFor(configDirOf(account), dataDir, fsImpl)
    if (terminal) {
      state.fiveHour = fresherOf(state.fiveHour, factOf(terminal, FIVE_HOUR_KEYS, clock))
      state.week = fresherOf(state.week, factOf(terminal, WEEK_KEYS, clock))
    }
  }

  const closed = standingClose(rec, own, clock)
  if (closed) {
    state.closedUntil = rec.resetAt
    // A CLOSE IS SAID ON THE ROW OF THE WINDOW IT CLOSED. It used to be said nowhere: the close
    // sat above both windows with no window on it, so a worker could read «ждёт окно» beside two
    // rows both saying the subscription was taking work, and the card pinned the words to the
    // five-hour line whatever had really been refused. Now the window that was shut carries the
    // refusal itself, and every screen names it without being told twice.
    state[closed.window] = exhaustedBy(state[closed.window], closed.resetMs)
  }

  return state
}

/**
 * The persisted refusal that is still standing over this account, or null.
 *
 * THREE THINGS MAKE A CLOSE STAND, and the account is open unless all three hold.
 *
 *   1. IT IS STILL IN ITS OWN WINDOW. Past the reset it carries, the window it described has
 *      turned over and the refusal is about a window that no longer exists.
 *   2. IT NAMES A WINDOW WE CAN SHOW. A close written on a name `canonicalWindow` cannot place
 *      is not honoured — nor is one that names no window at all, which is what the code that
 *      closed on any name at all left behind. An account stopped for a reason no screen can
 *      state is an account nobody can decide about; see canonicalWindow.
 *   3. THE PROVIDER HAS NOT SINCE SAID OTHERWISE. A reading of THAT SAME window, taken after
 *      the close and saying the window is allowing work, lifts it. The refusal and the later
 *      permission are both the vendor's own word about one window, and the later one is the
 *      current one — a stale refusal outliving it is how a healthy account stays shut. Only the
 *      account's own reading counts here: a borrowed terminal snapshot fills silence, it does
 *      not overrule a refusal this account was handed.
 */
function standingClose(rec, own, clock) {
  if (!rec || rec.resetAt == null) return null
  const resetMs = toMs(rec.resetAt)
  if (!Number.isFinite(resetMs) || resetMs <= clock()) return null

  const window = canonicalWindow(rec.closedWindow)
  if (!window) return null

  const fact = own[window]
  const seenMs = fact && fact.observedAt ? Date.parse(fact.observedAt) : NaN
  const closedMs = typeof rec.closedAt === 'string' ? Date.parse(rec.closedAt) : NaN
  // AND IT SAID «ALLOWED» IN SO MANY WORDS. Most readings now come out of the unified block,
  // which carries a fraction and a reset and no health word — read as permission, a routine
  // measurement taken a second after a refusal would re-open a subscription the vendor is still
  // refusing, and the next attempt would be spent learning what was already known. A silence
  // does not lift a refusal; only the vendor's own «allowed» about that window does.
  const lifted =
    fact &&
    fact.status === 'open' &&
    typeof fact.said === 'string' &&
    Number.isFinite(seenMs) &&
    Number.isFinite(closedMs) &&
    seenMs > closedMs
  return lifted ? null : { window, resetMs }
}

/**
 * A window fact restated as exhausted by a close that names it. A fact the account already
 * carries keeps everything it knows — its own reset, its percentage — and only changes the word
 * for its health; a window nothing was heard about gains the close's reset, because «исчерпано»
 * with no hour beside it is half an answer.
 *
 * `source` goes, and only `source`: a borrowed terminal reading may fill a silence, but the
 * refusal now written over it is this account's own, and a fact must not be labelled as somebody
 * else's word about the very thing that came from ours.
 */
function exhaustedBy(fact, resetMs) {
  const known = fact && fact.status !== 'unknown'
  const { source: _borrowed, ...rest } = fact || UNKNOWN
  return {
    ...rest,
    status: 'exhausted',
    resetsAt: known && fact.resetsAt != null ? fact.resetsAt : resetMs,
  }
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
 * percentages to the status line command it runs, and that is the one place a percentage
 * reliably exists — the work stream this daemon spawns carries the window's name, health and
 * reset, and a fraction only sometimes. It is a reading about the subscription THAT TERMINAL is
 * signed into, and nothing IN the payload names an account, so it stands as itself, labelled as
 * the terminal's own, and the «Расходы» screen shows it under that label.
 *
 * WHAT DOES NAME THE ACCOUNT IS THE CONFIG DIRECTORY BESIDE THE PAYLOAD — the one the daemon
 * hands its own sessions, and the one the status line writes into the snapshot. `windowState`
 * uses that match, and only that match, to fill a window an account has heard nothing about
 * (see there). This function stays the unattributed view: it answers «what did the terminal
 * last say», for the screen that asks exactly that question.
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
 * markWindowClosed({dataDir, accountName, resetAt, limitType, clock, fsImpl}) — persist a
 * ground-truth window close (a refused window carries the reset time). Written atomically under
 * `<dataDir>/windows/<account>.json` so it survives a daemon restart. Returns the record.
 *
 * A CLOSE NAMES THE WINDOW IT CLOSED, OR IT IS NOT WRITTEN. `limitType` must be a window
 * `canonicalWindow` can place; anything else returns null and changes nothing on disk. The
 * refusal is still FILED as a reading by markWindowObserved either way — what is refused is the
 * right to stop the account on a name no screen can show. The caller logs that refusal; see
 * canonicalWindow for the five days of stopped conveyor that bought this rule.
 *
 * @param {{dataDir:string, accountName:string, resetAt:(number|string), limitType:string, clock?:()=>number, fsImpl?:object}} opts
 * @returns {{accountName:string, resetAt:(number|string), closedWindow:string, closedAt:string}|null}
 */
export function markWindowClosed({ dataDir, accountName, resetAt, limitType, clock = Date.now, fsImpl } = {}) {
  const closedWindow = canonicalWindow(limitType)
  if (!closedWindow) return null
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
    closedWindow,
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
 * vendor sends one in the unified block and nowhere else, so a reading that came off the top of
 * a frame still has none. It used to be required, and the requirement did NOT reject the
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
  // AN ABSENT FRACTION MUST NOT BECOME A ZERO ONE, AND A PERCENT MUST NOT BECOME A FULL WINDOW.
  // Both hazards live in the same cast, and `utilizationFraction` answers both: null stays
  // absent, a value the wire sent in percents is brought into this file's one scale, and a
  // value that fits neither scale is dropped rather than filed as a measurement. WHAT IS STORED
  // IS ALWAYS A FRACTION — the file is read by `factOf` and by every later version of it, so
  // the scale is settled once, here, at the door.
  const { fraction: utilization } = utilizationFraction(o.utilization)

  const path = join(dataDir, 'windows', `${accountName}.json`)
  const previous = readJsonSafe(path, { readFn: fsImpl?.readFileSync }) || {}
  const record = {
    ...previous,
    accountName,
    observed: {
      ...(previous.observed && typeof previous.observed === 'object' ? previous.observed : {}),
      [limitType]: {
        resetsAt,
        ...(utilization != null ? { utilization } : {}),
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
