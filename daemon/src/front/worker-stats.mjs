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
 * ═══════════════ THE SAME SCAN ALSO ANSWERS «ЧТО ЭТОТ ДЕЛАЛ» ═════════════════════
 *
 * Two figures say how much, and say nothing about what. The roster could show a worker's
 * numbers and still leave a person unable to name a single piece of work he had led — so the
 * pass that counts also REMEMBERS, and hands back the list of pieces it counted.
 *
 * IT IS THE SAME PASS, DELIBERATELY. A second reader over the same directory would be a second
 * opinion the day one of them changed its window, its skip rules or its fold — and «сделано: 5»
 * standing over four lines of history is precisely the sort of quiet contradiction a person
 * stops believing a screen for. One scan, one set of rules, two answers.
 *
 * ONE LINE PER PIECE OF WORK, NOT PER TRY. The counts are about ATTEMPTS (work done twice cost
 * twice), the history is about WORK (a task redone three times is one thing this worker led).
 * So the history folds a worker's attempts on one task down to the LATEST of them, and the two
 * answers are allowed to differ in length without disagreeing. The card says which is which.
 *
 * WHAT THE LEDGER CANNOT SAY IT DOES NOT SAY. A ledger row carries no title, no phase and no
 * verdict of a person — those live on the queue row, and the caller joins them there. This
 * module answers exactly three things per line: which task, when the try ended, and how the
 * try itself ended.
 *
 * Node built-ins only; the ledger dir is caller-provided (DI). Fail-open throughout — a broken
 * ledger costs the screen a number, never the screen.
 */

import { readdirSync as fsReaddirSync } from 'node:fs'

import { readAttempts, foldAttemptRows } from '../queue/attempt-ledger.mjs'

const DAY_MS = 86_400_000

/**
 * HISTORY_CAP — how many pieces of work one worker's history carries.
 *
 * The list rides inside the state read, which is polled every few seconds by every open
 * window, so it is BOUNDED at the source rather than sliced by whoever draws it: a ceiling
 * applied on the screen would still have paid for the whole list on the wire. Twelve is the
 * near past a person actually asks about — «что он делал в последнее время» — and the window
 * of days above is the real answer to «how far back», stated in words beside the figures.
 */
export const HISTORY_CAP = 12

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
 * createWorkerStats({ledgerDir, fsImpl, clock, windowDays, ttlMs}) → {statsFor, historyFor, all}.
 *
 * `statsFor(workerId)` → `{done, failed}` for the window, `{done:0, failed:0}` for a worker the
 * readable ledger has nothing on, and `null` when the ledger could not be read at all.
 * `historyFor(workerId)` → the pieces of work that worker led inside the window, newest first
 * and capped, `[]` for a worker the readable ledger has nothing on, `null` under the same
 * unreadable-ledger condition as above. Each line: `{taskId, endedAt, outcome}`.
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

  /**
   * One pass over the ledger directory → `{counts, history}` by worker, or null when it cannot
   * be read. The two answers are built side by side from the SAME accepted row, so no rule
   * («вне окна», «никем не подписана», «восстановлена задним числом») can ever apply to one
   * of them and not to the other.
   */
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
    /** `{[workerId]: {[taskId]: {taskId, endedAt, outcome}}}` — one line per piece of work. */
    const led = {}
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
        else continue // a row that named no ending is counted nowhere and remembered nowhere

        // THE SAME ACCEPTED ROW, REMEMBERED. The id is taken off the row rather than off the
        // file name: the name went through `safeName`, so a task whose id carries a character
        // that rule replaces would be listed under a name no screen could open.
        const id = typeof rec.taskId === 'string' && rec.taskId.trim() !== '' ? rec.taskId.trim() : taskId
        const mine = led[workerId] || (led[workerId] = {})
        const prev = mine[id]
        // The LATEST try wins the line: a task redone three times is one piece of work, and the
        // word a person needs beside it is how it ended LAST, not how it once went.
        if (!prev || ended >= prev.endedAt) mine[id] = { taskId: id, endedAt: ended, outcome: rec.outcome }
      }
    }
    return { counts: out, history: led }
  }

  /** The one cached pass; `null` when the ledger could not be read at all. */
  function snapshot() {
    const at = now()
    if (cachedTaken && Number.isFinite(cachedAt) && at - cachedAt >= 0 && at - cachedAt < ttlMs) return cached
    cached = scan(at)
    cachedAt = at
    cachedTaken = true
    return cached
  }

  function all() {
    const taken = snapshot()
    return taken === null ? null : taken.counts
  }

  function statsFor(workerId) {
    const map = all()
    if (map === null) return null
    const hit = map[workerId]
    return hit ? { done: hit.done, failed: hit.failed } : { done: 0, failed: 0 }
  }

  function historyFor(workerId) {
    const taken = snapshot()
    if (taken === null) return null
    const mine = taken.history[workerId]
    if (!mine) return [] // the catalogue opened and this one led nothing in the period
    return Object.values(mine)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, HISTORY_CAP)
      .map((e) => ({ taskId: e.taskId, endedAt: e.endedAt, outcome: e.outcome }))
  }

  return { statsFor, historyFor, all }
}
