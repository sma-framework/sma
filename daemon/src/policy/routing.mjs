/**
 * routing.mjs — the executor-routing POLICY: which provider/model/effort runs a task,
 * on which worker/account, and why.
 *
 * WHAT IT IS: a PURE, DI-clocked decision function. Given a task + the worker pool + a
 * window predicate + a clock, it returns exactly ONE routing decision with a human
 * `reason` string the roster renders. It NEVER spawns, NEVER reads process.env, NEVER
 * decides what "done" means (that is the unified reverify gate's job) — it
 * only decides WHO runs.
 *
 * ROUTING IS A CONFIGURABLE POLICY, NOT HARDWIRED. The default lane→provider
 * map (prod→claude, research/paperwork→codex, forge→claude) is only a default. On top of
 * it, provider AND model AND effort are re-assignable at TWO levels, in strict precedence:
 *
 *     per-TASK override  >  per-WORKER override  >  lane default
 *
 * («я хочу переставлять модели и поставщиков, а также их effort» — the founder's mandate.)
 *
 * D-9.5-03a — DAYTIME PRIORITY IS ABSOLUTE. A worker whose account carries
 * `dayPriorityOwner:true` is ALWAYS skipped during the founder's active hours
 * (config.activeHours, default 09–22 local). Review KILLED the earlier
 * «unless it is the ONLY open window» carve-out: that exception would drain the founder's
 * account at exactly the moment D-9.5-03a forbids. So when the founder's account is the
 * only open window, the task WAITS ({workerId:null, reason:'window_exhausted'}) — the
 * budget rule (budget.mjs) may then choose the API lane, but routing never picks the
 * protected account during active hours.
 *
 * DEGRADATION IS SAFE. No eligible worker (all windows closed / only the protected account
 * open) → {workerId:null, reason:'window_exhausted'}. The task is never FAILED by routing;
 * it waits for a window or the loop composes the API fallback (budget.mjs).
 *
 * THE ROUTER EXPLAINS ITSELF AT THE DECISION. Every outcome carries a
 * `reasonCode` from the CLOSED DISPATCH_REASONS vocabulary (the human `reason` string stays
 * for the roster, but it is no longer the machine-readable answer), and — when a
 * `decisionJournal` sink is injected AND the call is about a real task — the code is
 * APPENDED to that task's decision journal at the moment the decision is made, not narrated
 * afterwards. The sink call is fail-open and the function stays PURE without it: a lane
 * PROBE (a task with no id, as the tick's eligibility scan does) writes nothing.
 *
 * Node built-ins only; one import (the closed vocabulary, an import-free leaf module);
 * clock injected. `new Date(now).getHours()` reads LOCAL time — consistent with a
 * local-constructed clock on any runner timezone.
 */

import { DISPATCH_REASONS } from '../front/journal.mjs'

/** Default lane → provider routing. Config may override via config.laneRouting. */
export const DEFAULT_LANE_ROUTING = Object.freeze({
  prod: { provider: 'claude' },
  research: { provider: 'codex' },
  paperwork: { provider: 'codex' },
  forge: { provider: 'claude' },
})

/** Default founder-active hours (local 24h clock): 09:00 inclusive → 22:00 exclusive. */
const DEFAULT_ACTIVE_HOURS = Object.freeze({ start: 9, end: 22 })

/** True when the local hour of `nowMs` falls inside [start, end) — the founder is working. */
function withinActiveHours(nowMs, activeHours) {
  const { start, end } = activeHours ?? DEFAULT_ACTIVE_HOURS
  const h = new Date(nowMs).getHours()
  return h >= start && h < end
}

/** First defined value among the arguments (undefined/null are skipped). */
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v
  return undefined
}

/**
 * Record the dispatcher layer of THIS decision. Fail-open by construction: a journal that
 * refuses or throws never changes the routing answer (a decision the daemon can act on is
 * worth more than a decision it can explain — but it must try to explain every time).
 * A probe (no task id) is silently skipped: the tick asks routing once per lane per tick
 * just to learn eligibility, and those are not decisions about a task.
 */
function journalDecision(sink, task, code, fields) {
  if (typeof sink !== 'function') return
  if (!task || !task.id) return
  if (!Object.prototype.hasOwnProperty.call(DISPATCH_REASONS, code)) return
  try {
    sink({
      taskId: task.id,
      attempt: task.attempt,
      layer: 'dispatcher',
      payload: { code, ...fields },
    })
  } catch {
    /* the journal never wedges a routing decision */
  }
}

/**
 * resolveRoute(task, {workers, windows, clock, config}) → routing decision.
 *
 * @param {{lane:string, provider?:string, model?:string, effort?:string}} task
 * @param {{
 *   workers?: Array<object>,     // the worker pool (config.workers shape)
 *   windows?: (worker:object)=>boolean, // window predicate: is this worker's window open?
 *   clock?: ()=>number,          // injected epoch-ms clock
 *   config?: {activeHours?:{start:number,end:number}, laneRouting?:object},
 *   decisionJournal?: (entry:object)=>void, // dispatcher-layer sink, optional
 * }} deps
 * @returns {{workerId:string|null, provider:string|null, model:(string|null), effort:(string|null), useApiFallback:boolean, reason:string, reasonCode:string}}
 */
export function resolveRoute(task = {}, deps = {}) {
  const workers = Array.isArray(deps.workers) ? deps.workers : []
  const isWindowOpen = typeof deps.windows === 'function' ? deps.windows : () => true
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const config = deps.config ?? {}
  const laneRouting = config.laneRouting ?? DEFAULT_LANE_ROUTING
  const activeHours = config.activeHours ?? DEFAULT_ACTIVE_HOURS
  const sink = deps.decisionJournal

  const lane = task.lane
  const laneDefault = laneRouting[lane] ?? {}

  // Provider selection: per-task override wins, else the lane default provider.
  const targetProvider = firstDefined(task.provider, laneDefault.provider) ?? null

  // Explicit API request bypasses the worker pool — the budget rule (budget.mjs) decides
  // whether the fallback is actually permitted; routing only surfaces the intent.
  if (task.provider === 'api') {
    journalDecision(sink, task, 'api_fallback_requested', { lane, provider: 'api' })
    return {
      workerId: null,
      provider: 'api',
      model: firstDefined(task.model, laneDefault.model) ?? null,
      effort: firstDefined(task.effort, laneDefault.effort) ?? null,
      useApiFallback: true,
      reason: 'per-task override: api',
      reasonCode: 'api_fallback_requested',
    }
  }

  const founderActive = withinActiveHours(clock(), activeHours)

  // Candidate workers: enabled, provider matches the target, window open, and NOT the
  // founder's protected day-priority account during active hours (D-9.5-03a, absolute).
  // `heldByDayPriority` remembers WHY the pool emptied, so the wait can name its own cause
  // instead of collapsing two different situations into one code.
  let heldByDayPriority = false
  const candidates = workers.filter((w) => {
    if (!w || w.enabled === false) return false
    if (targetProvider && w.provider !== targetProvider) return false
    const protectedNow = founderActive && (w.dayPriorityOwner === true || w.account?.dayPriorityOwner === true)
    if (protectedNow) {
      if (isWindowOpen(w)) heldByDayPriority = true
      return false
    }
    if (!isWindowOpen(w)) return false
    return true
  })

  if (candidates.length === 0) {
    // The task WAITS — routing never fails it. By review: no only-open-window
    // carve-out for the protected account.
    const code = heldByDayPriority ? 'day_priority_protected' : 'window_exhausted'
    journalDecision(sink, task, code, { lane, provider: targetProvider ?? undefined })
    return {
      workerId: null,
      provider: targetProvider,
      model: null,
      effort: null,
      useApiFallback: false,
      reason: 'window_exhausted',
      reasonCode: code,
    }
  }

  const chosen = candidates[0]

  // Precedence: per-task > per-worker > lane default, per field.
  const provider = firstDefined(task.provider, chosen.provider, laneDefault.provider) ?? null
  const model = firstDefined(task.model, chosen.model, laneDefault.model) ?? null
  const effort = firstDefined(task.effort, chosen.effort, laneDefault.effort) ?? null

  let reason
  let reasonCode
  if (task.provider !== undefined || task.model !== undefined || task.effort !== undefined) {
    reason = `per-task override → ${chosen.id}`
    reasonCode = 'per_task_override'
  } else if (chosen.model !== undefined || chosen.effort !== undefined || chosen.provider !== laneDefault.provider) {
    reason = `per-worker override → ${chosen.id}`
    reasonCode = 'per_worker_override'
  } else {
    reason = `default: ${lane}→${provider}`
    reasonCode = 'lane_default'
  }

  journalDecision(sink, task, reasonCode, { lane, workerId: chosen.id, provider: provider ?? undefined })

  return { workerId: chosen.id, provider, model, effort, useApiFallback: false, reason, reasonCode }
}
