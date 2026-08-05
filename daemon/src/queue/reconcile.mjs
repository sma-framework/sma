/**
 * reconcile.mjs — the attempt ledger, reconciled against the queue's own retry count
 * (D-11-DEFER-07, 2026-08-05; canon invariant 4, the repudiation leg).
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
 * statement about HOW MANY attempts have been made. Comparing it with the number of rows in
 * the ledger yields the count that was never written, and this pass appends it.
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
 * ═══════════ CONSERVATIVE BY CONSTRUCTION — IT UNDER-REPORTS, NEVER INVENTS ════════
 * Three narrowings, each deliberate:
 *   1. Only tasks whose queue row shows `attempt > 1` are examined. A retry is the only
 *      event this pass can read, so a task that never retried is not its business — and
 *      this keeps the pass off the ledger files of every historical task on every tick.
 *   2. It appends ONLY when the ledger holds FEWER rows than the queue's count implies.
 *      A duplicate row, or a row written before `attempt` was recorded on it, therefore
 *      provokes no reconstruction — the pass stays silent rather than guessing.
 *   3. It fills the attempt NUMBERS that are absent, up to the number owed. A number
 *      already present is never written twice, so re-running the pass is a no-op and the
 *      tick may call it as often as it likes.
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
      const existing = ledger.readAttempts(row.id) || []
      let owed = concluded - existing.length
      if (owed < 1) continue // the ledger is complete, or holds more than the count implies
      const recorded = new Set(
        existing.map((r) => Number(r && r.attempt)).filter((n) => Number.isFinite(n)),
      )
      for (let n = 1; n <= concluded && owed > 0; n += 1) {
        if (recorded.has(n)) continue
        ledger.recordAttempt({
          taskId: row.id,
          attempt: n,
          ...RECONSTRUCTED_OUTCOME,
          reconstructed: true,
          // The moment of RECONCILIATION. The moment of the attempt is not knowable from a
          // retry counter, and a plausible timestamp would be a fabricated one.
          recordedAt: new Date(now()).toISOString(),
        })
        owed -= 1
        summary.reconstructed += 1
      }
    } catch {
      /* one unreadable or unwritable ledger file never stops the pass (fail-open) */
    }
  }
  return summary
}
