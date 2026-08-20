/**
 * worker-stats.mjs — «сделано / не получилось» of one worker, MEASURED OVER A PERIOD.
 *
 * WHY THIS EXISTS. The roster's two numbers under a worker's name were counted on the screen,
 * by walking the `done[]` slice the state read happened to be carrying — a capped, «за ночь»
 * list. So the figures moved when that list moved: a worker whose finished work had scrolled
 * out of it read as a worker who had finished nothing, and the same worker read differently
 * on two polls a minute apart. That is not a statistic, it is a side effect of a list length.
 *
 * The material for an honest answer was already durable: the per-attempt ledger writes one
 * immutable row per try with the moment the try ENDED on it (attempt-ledger.mjs). The count
 * is therefore taken there, over an explicit window of days, and the screen only renders it.
 *
 * NO NEW DOOR. The numbers travel inside the state read that already runs — deriveState gets
 * this read model as one more injected collaborator, exactly as it already gets the ledger.
 * A route of its own would have forced a repin of a frozen route list in a neighbouring
 * project for two integers.
 *
 * ═══════════════ WHAT IS COUNTED, AND WHAT IS DELIBERATELY NOT ═══════════════════
 *
 * Counted: an attempt whose row names a worker, carries an END MARK inside the window, and
 * concluded — `completed` goes to done, `failed` to failed. Those are the two words the tick
 * and the durable backend write (loop.mjs completeTask/failTask, pgboss-backend complete/fail).
 *
 * NOT counted, and each omission is a number we refuse to invent:
 *   - an attempt with NO end mark. It may still be running. «Done» would be a claim about work
 *     that has not stopped, and the alternative — counting it as failed — is worse.
 *   - a row with `reconstructed: true`. reconcile.mjs appends those from the queue's own retry
 *     counter AFTER the fact, with outcome «failed», precisely because nobody watched them.
 *     Putting them in the failed column would state a failure no one observed.
 *   - an attempt that ended before the window began. The border is the whole point of saying
 *     «за 30 дней»: a figure that quietly included everything since installation is a different
 *     statement wearing the same words.
 *   - AN ATTEMPT WHOSE ROW NAMES NOBODY. It belongs to no worker, so it enters no worker's
 *     count — not even as a zero somewhere. Such rows exist and always will: for a long while
 *     the failing path wrote no worker at all (the finished one did), so the whole failed half
 *     of the history on disk is nameless, and those rows are never rewritten — the daemon is
 *     not the source of truth for its own past. The writer was fixed instead, so attempts made
 *     from now on say whose they were; the older ones stay honestly anonymous. Handing them to
 *     the worker of a neighbouring row would pin a failure on somebody possibly innocent, which
 *     is the same invented fact as an invented owner, only about blame.
 *
 * AN UNREADABLE LEDGER YIELDS NO ANSWER — `null`, never a zero. On this screen a zero reads as
 * «this worker did nothing», which is a measurement; «нет данных» is the truth when the
 * directory could not be opened or no ledger is wired at all. The distinction survives all the
 * way to the card, because it is the difference between a fact and a shrug.
 *
 * A READABLE BUT EMPTY LEDGER DOES yield zeros: the catalogue was opened, nothing concluded in
 * the period, and that IS a measurement.
 *
 * THE READ IS CACHED. The state read is polled often, and scanning a whole ledger directory on
 * every poll is the derive attacking its own daemon (the threat register names it). One TTL
 * window, one scan; the clock and the fs are injected seams like everywhere else in this
 * directory, so the cache is testable without waiting a minute.
 *
 * Node built-ins only; the ledger dir is caller-provided (DI). Fail-open throughout — a broken
 * ledger costs the screen a number, never the screen.
 */

import { readdirSync as fsReaddirSync } from 'node:fs'

import { readAttempts, foldAttemptRows } from '../queue/attempt-ledger.mjs'

const DAY_MS = 86_400_000

/** The suffix of an attempt file, and the two siblings that live in the same directory. */
const ATTEMPTS_SUFFIX = '.jsonl'
const JOURNAL_SUFFIX = '.journal.jsonl' // the decision journal — a different layer, not attempts
const LOG_SUFFIX = '.log.ndjson' // the live transcript of one attempt

/** A stored mark as milliseconds — a number stays, an ISO string parses, anything else is NaN. */
function stampMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v === 'string') return Date.parse(v)
  return NaN
}

/**
 * createWorkerStats({ledgerDir, fsImpl, clock, windowDays, ttlMs}) → {statsFor, all}.
 *
 * `statsFor(workerId)` → `{done, failed}` for the window, `{done:0, failed:0}` for a worker the
 * readable ledger has nothing on, and `null` when the ledger could not be read at all.
 * `all()` → `{[workerId]: {done, failed}}`, or `null` under the same condition.
 *
 * @param {{ledgerDir?:string, fsImpl?:object, clock?:()=>number, windowDays?:number, ttlMs?:number}} [args]
 */
export function createWorkerStats({ ledgerDir, fsImpl, clock, windowDays = 30, ttlMs = 60_000 } = {}) {
  const now = typeof clock === 'function' ? clock : Date.now
  const readdir = (fsImpl && fsImpl.readdirSync) || fsReaddirSync
  const windowMs = Math.max(0, Number(windowDays) || 0) * DAY_MS

  /** The last scan: the moment it was taken and what it found (`null` = unreadable). */
  let cachedAt = NaN
  let cached
  let cachedTaken = false

  /** One pass over the ledger directory → counts by worker, or null when it cannot be read. */
  function scan(at) {
    if (typeof ledgerDir !== 'string' || ledgerDir.trim() === '') return null
    let names
    try {
      names = readdir(ledgerDir) || []
    } catch {
      return null // no directory, no permission — no answer, and no exception either
    }
    const since = at - windowMs
    const out = {}
    for (const raw of names) {
      const name = String(raw)
      if (!name.endsWith(ATTEMPTS_SUFFIX)) continue
      if (name.endsWith(JOURNAL_SUFFIX) || name.endsWith(LOG_SUFFIX)) continue
      const taskId = name.slice(0, -ATTEMPTS_SUFFIX.length)
      if (taskId === '') continue
      let records
      try {
        // ONE RECORD PER TRY, not one per row: two writers append for the same attempt (the
        // transition and the tick), and counting rows would double every finished try.
        records = foldAttemptRows(readAttempts(ledgerDir, taskId))
      } catch {
        continue // one unreadable file never costs the whole count
      }
      for (const rec of records) {
        if (!rec || typeof rec !== 'object') continue
        if (rec.reconstructed === true) continue
        const workerId = typeof rec.workerId === 'string' ? rec.workerId.trim() : ''
        // A row that names nobody is nobody's: it is dropped here rather than attached to the
        // likeliest worker. See the note above — the anonymous half of the history is a fact
        // about the ledger, not about any one worker's record.
        if (workerId === '') continue
        const ended = stampMs(rec.endedAt)
        if (!Number.isFinite(ended)) continue
        if (ended < since) continue
        const bucket = out[workerId] || (out[workerId] = { done: 0, failed: 0 })
        if (rec.outcome === 'completed') bucket.done += 1
        else if (rec.outcome === 'failed') bucket.failed += 1
      }
    }
    return out
  }

  function all() {
    const at = now()
    if (cachedTaken && Number.isFinite(cachedAt) && at - cachedAt >= 0 && at - cachedAt < ttlMs) return cached
    cached = scan(at)
    cachedAt = at
    cachedTaken = true
    return cached
  }

  function statsFor(workerId) {
    const map = all()
    if (map === null) return null
    const hit = map[workerId]
    return hit ? { done: hit.done, failed: hit.failed } : { done: 0, failed: 0 }
  }

  return { statsFor, all }
}
