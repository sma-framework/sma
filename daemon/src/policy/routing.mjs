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
 * DAYTIME PRIORITY IS ABSOLUTE. A worker whose account carries
 * `dayPriorityOwner:true` is ALWAYS skipped during the founder's active hours
 * (config.activeHours, default 09–22 local). Review KILLED the earlier
 * «unless it is the ONLY open window» carve-out: that exception would drain the founder's
 * account at exactly the moment the rule forbids. So when the founder's account is the
 * only open window, the task WAITS ({workerId:null, reason:'window_exhausted'}) — the
 * budget rule (budget.mjs) may then choose the API lane, but routing never picks the
 * protected account during active hours.
 *
 * DEGRADATION IS SAFE. No eligible worker (all windows closed / only the protected account
 * open) → {workerId:null, reason:'window_exhausted'}. The task is never FAILED by routing;
 * it waits for a window or the loop composes the API fallback (budget.mjs). WITH ONE
 * CORRECTION: when everything is shut AND the money rule refused, the decision's code is the
 * MONEY VERDICT, not the word about windows — the shut windows are the reason the rule was
 * asked, and its answer is the reason the task is not running.
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

/**
 * The money rule's refusals, said in the roster's own English. The CODE is what the journal
 * and the attempt row carry; this only turns it into the half-sentence that follows «all
 * windows closed, and …». An unknown refusal still gets a sentence naming itself rather than
 * a blank — a rule that grows a fourth answer must not silently lose its word here.
 */
const MONEY_REFUSAL_WORDS = Object.freeze({
  budget_stop: 'the monthly paid-channel cap is spent',
  wait_for_window: 'the money rule chose not to spend',
  api_cap_unset: 'the paid channel is not configured',
})

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
 *
 * A CODE NOBODY COULD SIGN IS A PRODUCT DEFECT: IT IS COUNTED AND SHOWN, AND IT NEVER
 * BRINGS A DECISION DOWN. The vocabulary guard below stays exactly what it was — a silent
 * skip — and turning it into a throw is forbidden, not merely inadvisable: a typo in one
 * reason string would then kill the dispatcher, and a decision the daemon can act on is
 * worth more than a decision it can explain. So the break is not swallowed either: the
 * optional `unknownSink` is told, inside its own try/catch, because a sink that throws has
 * no more right to wedge a route than a journal that throws. The function keeps NO module
 * state, reads no process.env and returns on every path — its purity is the reason this
 * escape hatch is safe to add.
 */
function journalDecision(sink, task, code, fields, unknownSink) {
  if (typeof sink !== 'function') return
  if (!task || !task.id) return
  if (!Object.prototype.hasOwnProperty.call(DISPATCH_REASONS, code)) {
    if (typeof unknownSink === 'function') {
      try {
        unknownSink(code)
      } catch {
        /* an orphan-counter that throws is still only a counter */
      }
    }
    return
  }
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
 *   budget?: (args:{task:object, allClosed:boolean})=>{fallback:boolean, reason:string},
 *     // THE MONEY DECISION (policy/budget.mjs, pre-bound at the composition root). Two
 *     // things depended on it and neither ever asked: an explicit `provider:'api'` task ran
 *     // with NO ceiling at all, and the documented automatic switch — «all windows closed,
 *     // continue on the paid channel» — never happened, so tasks simply waited. Both screens
 *     // that describe those rules described nothing. Absent here → the old behaviour, and
 *     // the COMPOSITION ROOT is where its presence is locked: a policy a part cannot see is
 *     // missing is exactly the defect class this codebase keeps paying for.
 *   unknownReasonSink?: (code:string)=>void,
 *     // TOLD WHEN A DECISION COULD NOT BE SIGNED. The vocabulary guard is silent by design
 *     // and must stay so; silence about the guard FIRING is a different thing, and it is
 *     // what let a spend decision go unrecorded without anybody learning of it. Optional,
 *     // may throw with impunity, and never affects the answer.
 * }} deps
 * @returns {{workerId:string|null, provider:string|null, model:(string|null), effort:(string|null), useApiFallback:boolean, reason:string, reasonCode:string}}
 */
/**
 * askBudget(seam, task, allClosed) → the money verdict, or null when no seam was supplied.
 * NEVER throws: a budget rule that fails must not take the dispatcher down with it, and a
 * failure is treated as «no answer», which leaves the old path intact rather than inventing
 * a permission.
 */
function askBudget(seam, task, allClosed) {
  if (typeof seam !== 'function') return null
  try {
    const v = seam({ task, allClosed })
    return v && typeof v === 'object' && typeof v.fallback === 'boolean' ? v : null
  } catch {
    return null
  }
}

export function resolveRoute(task = {}, deps = {}) {
  const workers = Array.isArray(deps.workers) ? deps.workers : []
  const isWindowOpen = typeof deps.windows === 'function' ? deps.windows : () => true
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const config = deps.config ?? {}
  const laneRouting = config.laneRouting ?? DEFAULT_LANE_ROUTING
  const activeHours = config.activeHours ?? DEFAULT_ACTIVE_HOURS
  const sink = deps.decisionJournal
  // Optional, and its absence changes nothing: without it an unsignable code is dropped
  // exactly as it always was. With it, the drop is counted where a person can see it.
  const unknownSink = deps.unknownReasonSink

  const lane = task.lane
  const laneDefault = laneRouting[lane] ?? {}

  // Provider selection: per-task override wins, else the lane default provider.
  const targetProvider = firstDefined(task.provider, laneDefault.provider) ?? null

  // Explicit API request bypasses the worker pool — the budget rule (budget.mjs) decides
  // whether the fallback is actually permitted; routing only surfaces the intent.
  if (task.provider === 'api') {
    // ASK THE MONEY RULE FIRST. An explicit request is an intent, not a permission: the cap
    // is «one stop for the whole machine», and a task that names the paid channel by hand is
    // exactly the one that would walk past it.
    const verdict = askBudget(deps.budget, task, true)
    if (verdict && verdict.fallback === false) {
      journalDecision(sink, task, verdict.reason, { lane, provider: 'api' }, unknownSink)
      return {
        workerId: null,
        provider: null,
        model: null,
        effort: null,
        useApiFallback: false,
        reason:
          verdict.reason === 'budget_stop'
            ? 'budget stop: the paid channel is closed'
            : verdict.reason === 'api_cap_unset'
              ? 'the paid channel is not configured: waiting for a window'
              : 'waiting for a window',
        reasonCode: verdict.reason,
      }
    }
    journalDecision(sink, task, 'api_fallback_requested', { lane, provider: 'api' }, unknownSink)
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
  // founder's protected day-priority account during active hours (absolute, no carve-out).
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
    // NO SEAT ANYWHERE — this is the moment the paid channel exists for, and until now it was
    // never asked. The protected account is NOT a closed window: holding work for the
    // founder's own subscription must never be turned into spending, so the switch is offered
    // only when the pool emptied because every window is genuinely spent.
    let verdict = null
    if (!heldByDayPriority) {
      verdict = askBudget(deps.budget, task, true)
      if (verdict && verdict.fallback === true) {
        journalDecision(sink, task, 'api_fallback', { lane, provider: 'api' }, unknownSink)
        return {
          workerId: null,
          provider: 'api',
          model: firstDefined(task.model, laneDefault.model) ?? null,
          effort: firstDefined(task.effort, laneDefault.effort) ?? null,
          useApiFallback: true,
          reason: 'all windows closed: continuing on the paid channel',
          reasonCode: 'api_fallback',
        }
      }
    }
    // The task WAITS — routing never fails it. By review: no only-open-window
    // carve-out for the protected account.
    //
    // WHOSE WORD NAMES THE WAIT. Two facts are true here and only one of them is useful to
    // the person reading the row: the windows are shut (which is WHY the money rule was
    // asked at all) and the money rule refused (which is why nothing is running now). This
    // branch used to publish the first and discard the second, so a task stopped by a
    // ceiling its owner set himself told him to wait for a window that could never help.
    // The refusal, when there is one, is the answer. Absent a rule, or when the pool emptied
    // because the founder's own account is protected, the previous words stand exactly.
    const moneyRefusal =
      verdict && verdict.fallback === false && typeof verdict.reason === 'string' && verdict.reason !== '' ? verdict.reason : null
    const code = heldByDayPriority ? 'day_priority_protected' : (moneyRefusal ?? 'window_exhausted')
    journalDecision(sink, task, code, { lane, provider: targetProvider ?? undefined }, unknownSink)
    return {
      workerId: null,
      provider: targetProvider,
      model: null,
      effort: null,
      useApiFallback: false,
      // Both facts, in words, for the roster — the code above is the machine-readable half.
      reason: moneyRefusal ? `all windows closed, and ${MONEY_REFUSAL_WORDS[moneyRefusal] ?? `the money rule answered ${moneyRefusal}`}` : 'window_exhausted',
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

  journalDecision(sink, task, reasonCode, { lane, workerId: chosen.id, provider: provider ?? undefined }, unknownSink)

  return { workerId: chosen.id, provider, model, effort, useApiFallback: false, reason, reasonCode }
}
