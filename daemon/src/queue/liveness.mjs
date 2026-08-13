/**
 * liveness.mjs — the durable liveness sweep.
 *
 * THE CONTRACT (Paperclip §8 as ТЗ / SPECIFICATION, our own implementation — no code
 * copied; see THIRD-PARTY-LICENSES.md): «every NON-TERMINAL task MUST have a durable
 * live path — a queued job, an active job with a FRESH touch, or a scheduled retry. A
 * background PID is NOT a live path.» One daemon tick audits this over DURABLE state
 * ONLY (the QueueAdapter + the attempt ledger) and requeues any violation.
 *
 * STATELESS BY LAW: there is NO in-memory registry of live
 * tasks, NO Map of running PIDs here — any such structure would be a bug. The sweep
 * reads `adapter.list()` (Postgres truth) every tick; the daemon is killable at any
 * line, and on restart the sweep re-derives every task's live path from durable state.
 *
 * REQUEUE MECHANICS: a stale-active task is requeued by `adapter.fail(id,
 * 'runtime_offline')`. On the pg-boss backend this hands the SAME job row back to
 * pg-boss's retryLimit/retryBackoff — «замолчал — задача вернулась в очередь» falls
 * out of the library, WITHOUT re-enqueuing (so no task field is lost). The adapter's
 * fail() is also what appends the durable attempt row. The sweep is the
 * belt-and-suspenders AUDIT on top of pg-boss's own expiry.
 *
 * REWAKE THROTTLE: a task with >= 2 consecutive no-progress
 * attempts is subject to computeCooldownMs(n) = min(120000 * 2^(n-2), 1800000) before
 * it should be woken again — coalescing + exponential backoff so a wedged task can
 * never burn a night window in a wake storm. The formula is exported and unit-tested;
 * the real delay is realized by pg-boss retryBackoff at requeue time.
 *
 * Node built-ins only; `clock` is dependency-injected so the sweep is deterministic in
 * tests. No live Postgres — the adapter + ledger are injected fakes in the suite.
 */

import { DEFAULT_EXPIRE_MS } from './adapter.mjs'

const BASE_COOLDOWN_MS = 120000 // 120s
const MAX_COOLDOWN_MS = 1800000 // 30 min

/**
 * computeCooldownMs(noProgressRuns) — the exponential rewake throttle. 0 for the first
 * run (n<2); from n=2, min(120000 * 2^(n-2), 1800000).
 *
 * @param {number} noProgressRuns  1-based count of consecutive no-progress attempts
 * @returns {number} cooldown in ms
 */
export function computeCooldownMs(noProgressRuns) {
  const n = Number(noProgressRuns) || 0
  if (n < 2) return 0
  const raw = BASE_COOLDOWN_MS * 2 ** (n - 2)
  return Math.min(raw, MAX_COOLDOWN_MS)
}

/** Consecutive no-progress (failed) attempts already on record for a task. */
function countNoProgress(attempts) {
  if (!Array.isArray(attempts)) return 0
  let n = 0
  for (const a of attempts) if (a && a.outcome === 'failed') n += 1
  return n
}

/**
 * livenessSweep({adapter, ledger, clock, expireMs}) — audit every non-terminal task
 * for a durable live path; requeue the ones that lost it. Returns a summary.
 *
 * A task is:
 *   - terminal (completed/failed) → not audited (no live-path obligation);
 *   - queued → OK (queued IS a durable live path);
 *   - active with a fresh renewal (now - leaseRenewedAt <= expireMs) → OK;
 *   - active with a STALE touch → no live path → adapter.fail(id, 'runtime_offline')
 *     (→ attempt row via the adapter + pg-boss auto-retry), counted as requeued, and
 *     counted as throttled when its cooldown (>= 2 no-progress runs) is non-zero.
 *
 * @param {{adapter:object, ledger?:object, clock?:Function|number, expireMs?:number}} opts
 * @returns {Promise<{audited:number, requeued:number, throttled:number}>}
 */
export async function livenessSweep({ adapter, ledger, clock = Date.now, expireMs = DEFAULT_EXPIRE_MS } = {}) {
  if (!adapter || typeof adapter.list !== 'function' || typeof adapter.fail !== 'function') {
    throw new TypeError('livenessSweep requires an adapter with list() and fail()')
  }
  const now = () => (typeof clock === 'function' ? clock() : clock)
  const rows = await adapter.list({}) // durable read — never an in-memory registry
  let audited = 0
  let requeued = 0
  let throttled = 0

  for (const r of rows) {
    if (r.status === 'completed' || r.status === 'failed') continue
    audited += 1
    if (r.status !== 'claimed') continue // queued / retry = durable live path (OK)

    // THE RENEWAL CLOCK, NOT THE CLAIM CLOCK. A row states both: when the attempt was taken and
    // when its lease was last renewed. This sweep asks «has this worker gone silent», which only
    // the renewal answers — measuring from the claim would declare every attempt that outlives
    // one lease period dead WHILE IT RUNS, kill nothing, and hand the same task to a second
    // worker and a third. That is the exact fault this file exists to catch, so it may not be
    // the one this file causes. `claimedAt` remains the fallback for a backend that renews by
    // restamping the same clock it claimed on — there the two are one value and either reads
    // correctly.
    const lastTouch = r.leaseRenewedAt ?? r.claimedAt ?? 0
    if (now() - lastTouch <= expireMs) continue // active + fresh renewal (OK)

    // Stale active: the worker went silent — no durable live path. Requeue it.
    const prior = ledger && typeof ledger.readAttempts === 'function' ? ledger.readAttempts(r.id) : []
    const noProgress = countNoProgress(prior) + 1 // this failure
    await adapter.fail(r.id, 'runtime_offline') // → attempt row (adapter) + pg-boss auto-retry
    requeued += 1
    if (computeCooldownMs(noProgress) > 0) throttled += 1
  }

  return { audited, requeued, throttled }
}
