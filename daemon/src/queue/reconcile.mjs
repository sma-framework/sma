/**
 * reconcile.mjs — the attempt ledger, reconciled against the queue's own retry count:
 * the repudiation leg of fleet invariant four (a lease expiry unsays nothing).
 *
 * WHY THIS FILE EXISTS. A task has TWO recovery paths and until now only one of them left
 * evidence. When the liveness sweep notices a silent worker first, it calls
 * `adapter.fail(id, 'runtime_offline')` and the adapter appends an attempt row. When the
 * DAEMON is down while a worker dies, nobody calls anything: pg-boss's own lease expiry
 * returns the job from `active` to `created` with `retry_count + 1`, and the ledger holds
 * NOTHING — a worker ran, may have touched the world, and left no trace. That was recorded
 * as an open hole (FLEET-INVARIANTS §5.4) and pinned by the second kill-drill case rather
 * than fixed, because writing the row means observing an event the backend does not see.
 *
 * THIS IS THAT OBSERVATION, MADE AFTERWARDS. The queue counts retries whether or not anyone
 * was watching, so `attempt` on a queue row (`data.attempt + retry_count`) is a durable
 * statement about HOW MANY attempts have been made. Comparing it with the attempt NUMBERS
 * the ledger already holds yields the ones that were never written, and this pass appends
 * them. The daemon tick runs it once per tick, right after the liveness sweep, so the rows
 * the sweep has just written are already on disk when the comparison is made.
 *
 * ═══════════ A RECONSTRUCTED ROW NEVER MASQUERADES AS A LIVE ONE ═══════════════════
 * Every row this module appends carries `reconstructed: true`. It is the whole point: the
 * row says «an attempt existed», not «here is what happened in it». So it carries no
 * workerId, no provider and no receipt — nobody observed those — and its `recordedAt` is
 * the moment of RECONCILIATION, not the moment of the attempt, which is unknowable from a
 * retry counter. `outcome: 'failed'` and `failureReason: 'runtime_offline'` are the two
 * facts the counter really does carry: pg-boss increments `retry_count` only when an
 * attempt did NOT complete, and the sweep already names that exact event
 * 'runtime_offline' when it is the one that notices. The two paths therefore say the same
 * thing about the same event instead of two dialects of it.
 *
 * ═══════════ IT COMPARES NUMBERS, NOT COUNTS — AND THAT IS THE WHOLE FIX ═══════════
 * The obvious comparison — «does the ledger hold as many rows as the queue implies» — is
 * WRONG IN PRODUCTION, and it was written that way first and then rejected. A completed or
 * failed task on the real daemon gets TWO rows for ONE attempt: the adapter writes one
 * inside `complete()`/`fail()`, and the tick writes a richer one in
 * `completeTask`/`failTask`. So a task with one observed failure and one unobserved death
 * holds two rows against a queue count of two — a count comparison sees a full ledger and
 * reconstructs nothing, leaving exactly the hole this module exists to close. The pass
 * therefore asks, per attempt NUMBER, whether any row claims it, and fills the numbers
 * nobody claimed.
 *
 * ═══════════ CONSERVATIVE BY CONSTRUCTION — IT UNDER-REPORTS, NEVER INVENTS ════════
 * Three narrowings, each deliberate:
 *   1. Only tasks whose queue row shows `attempt > 1` are examined. A retry is the only
 *      event this pass can read, so a task that never retried is not its business — and
 *      this keeps the pass off the ledger files of every historical task on every tick.
 *   2. A ledger holding ANY row this pass cannot place — a row carrying no attempt number,
 *      as every row written before that number was recorded on it does — silences the whole
 *      task. Such a row is evidence of an attempt whose identity is unknown, and
 *      reconstructing «the missing number» beside it could duplicate the very attempt it
 *      already stands for.
 *   3. A number already present is never written twice, so re-running the pass is a no-op
 *      and the tick may call it as often as it likes.
 *
 * WHAT IT COSTS, SAID OUT LOUD: one durable `adapter.list({})` per pass, plus one ledger
 * file read per task the queue reports with `attempt > 1`. The pass holds no state between
 * calls (the daemon is killable at any line), so it cannot remember which tasks
 * it has already found complete and re-reads them every tick. On a queue whose retried
 * tasks number in the thousands that is the cost to watch, and the narrowing that would pay
 * for itself first is a time bound on how far back the pass looks.
 *
 * Node built-ins only — in fact none. The adapter, the ledger and the clock are injected;
 * this module opens nothing and holds no state between calls. A per-task failure is
 * FAIL-OPEN: one unreadable ledger file never stops the pass and never wedges a tick.
 */

/** A task is only examined when the queue itself says an attempt was retried. */
const MIN_RETRIED_ATTEMPT = 2

/**
 * The outcome a retry counter really does carry. pg-boss advances `retry_count` only for
 * an attempt that did not complete; the liveness sweep names that same event
 * 'runtime_offline' when it is the one that notices first.
 */
const RECONSTRUCTED_OUTCOME = Object.freeze({ outcome: 'failed', failureReason: 'runtime_offline' })

/** Terminal queue statuses — for these the CURRENT attempt has concluded as well. */
const TERMINAL_STATUSES = Object.freeze(['completed', 'failed'])

/**
 * concludedAttempts(row) → how many attempts of this task have finished, per the QUEUE.
 *
 * `row.attempt` is the number of the attempt now in flight (`data.attempt + retry_count`),
 * so every attempt before it has concluded. A terminal row adds one more: its current
 * attempt concluded too. Returns 0 for anything unreadable — an unparseable row is not an
 * accusation that a row is missing.
 *
 * @param {{attempt?:number, status?:string}} row
 * @returns {number}
 */
export function concludedAttempts(row) {
  const attempt = Number(row && row.attempt)
  if (!Number.isFinite(attempt) || attempt < MIN_RETRIED_ATTEMPT) return 0
  return attempt - 1 + (TERMINAL_STATUSES.includes(row.status) ? 1 : 0)
}

/**
 * missingAttemptNumbers(existing, concluded) → the attempt numbers in 1..concluded that no
 * ledger row claims, or NULL when the ledger holds a row this pass cannot place.
 *
 * Null is a refusal to guess, not an error (narrowing 2 above). PURE.
 *
 * @param {object[]} existing
 * @param {number} concluded
 * @returns {number[]|null}
 */
export function missingAttemptNumbers(existing, concluded) {
  const recorded = new Set()
  for (const row of Array.isArray(existing) ? existing : []) {
    const n = Number(row && row.attempt)
    if (!Number.isFinite(n)) return null // an unplaceable row silences the whole task
    recorded.add(n)
  }
  const missing = []
  for (let n = 1; n <= concluded; n += 1) if (!recorded.has(n)) missing.push(n)
  return missing
}

/**
 * reconcileAttempts({adapter, ledger, clock}) — one pass over durable queue state,
 * appending the attempt rows the ledger is missing. Returns a summary
 * `{examined, reconstructed}`; never throws.
 *
 * @param {{adapter:object, ledger?:object, clock?:Function|number}} opts
 * @returns {Promise<{examined:number, reconstructed:number}>}
 */
export async function reconcileAttempts({ adapter, ledger, clock = Date.now } = {}) {
  if (!adapter || typeof adapter.list !== 'function') {
    throw new TypeError('reconcileAttempts requires an adapter with list()')
  }
  const summary = { examined: 0, reconstructed: 0 }
  // Without BOTH ledger doors there is nothing to compare and nowhere to write: the pass
  // is a no-op rather than an error (the same DI-guard posture the tick uses everywhere).
  if (!ledger || typeof ledger.readAttempts !== 'function' || typeof ledger.recordAttempt !== 'function') {
    return summary
  }
  const now = () => (typeof clock === 'function' ? clock() : clock)

  const rows = await adapter.list({}) // durable read — never an in-memory registry
  for (const row of rows) {
    const concluded = concludedAttempts(row)
    if (concluded < 1) continue
    summary.examined += 1
    try {
      const missing = missingAttemptNumbers(ledger.readAttempts(row.id) || [], concluded)
      if (missing === null) continue // a row this pass cannot place — stay silent
      for (const attempt of missing) {
        ledger.recordAttempt({
          taskId: row.id,
          attempt,
          ...RECONSTRUCTED_OUTCOME,
          reconstructed: true,
          // The moment of RECONCILIATION. The moment of the attempt is not knowable from a
          // retry counter, and a plausible timestamp would be a fabricated one.
          recordedAt: new Date(now()).toISOString(),
        })
        summary.reconstructed += 1
      }
    } catch {
      /* one unreadable or unwritable ledger file never stops the pass (fail-open) */
    }
  }
  return summary
}
