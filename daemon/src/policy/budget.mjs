/**
 * budget.mjs — the sub→API switch + the monthly budget stop (Phase 9.5 Plan 05, Task 3;
 * D-9.5-03b, RESEARCH Pitfall 9).
 *
 * WHAT IT IS: a PURE decision — should THIS task fall back from the subscription pool to
 * the paid API lane right now? The answer is bounded by real € so the fallback can never
 * run away.
 *
 * D-9.5-03b — «ПОДПИСКА → API» IS A FIRST-DAY SWITCH WITH A BUDGET STOP. The fallback is
 * permitted ONLY when BOTH hold:
 *   1. the task's lane worker windows are ALL closed (there is no subscription seat to wait
 *      a short moment for — otherwise the honest answer is «wait_for_window», not spend), AND
 *   2. month-to-date API spend + this task's cost-ceiling estimate stays UNDER
 *      monthlyApiCapEur.
 * Otherwise: {fallback:false, reason:'wait_for_window' | 'budget_stop'}.
 *
 * WARN BEFORE THE STOP: at ≥70% and ≥90% of the cap the decision carries `warn: 70|90` so
 * the roster shows the founder the budget filling BEFORE the hard stop at 100%
 * (reason:'budget_stop'). The stop halts the API lane in real € — it never touches the
 * honesty of the accounting (subscription work is still booked at token value, Pitfall 5).
 *
 * PITFALL 9 — ANTHROPIC REPRICING is the main economic risk (not a ban). The budget stop
 * IS the hedge: the architecture must stay economical under repricing because the paid lane
 * is capped in €. WATCH ITEM: the paused programmatic-credit split is announced to return;
 * a future revision may reintroduce a credit-based split beneath this cap.
 *
 * CURRENCY: usage rows carry cost in USD (Claude `total_cost_usd`); the cap is in EUR. The
 * conversion is a single config rate `budget.usdToEur` (default 1 — a deliberate pilot
 * placeholder the founder sets to a real rate; keeping same-currency until then makes the
 * cap unambiguous). Coarse by design; the stop is a guardrail, not an invoice.
 *
 * SEAM (documentation, not a test dependency): this function returns a DECISION only. The
 * env application (ANTHROPIC_API_KEY precedence over subscription auth) is buildAccountEnv's
 * job in the runner (plan 04) — the switch is env-only downstream.
 *
 * Node built-ins only; no imports; spend read via the injected usageReader; no process.env.
 */

/** Normalize the "are all lane windows closed?" signal — a boolean or {allClosed:boolean}. */
function allClosedSignal(windows) {
  if (typeof windows === 'boolean') return windows
  return Boolean(windows && windows.allClosed)
}

/** Local start-of-month epoch-ms for `nowMs` (month-to-date is a calendar window, not rolling). */
function startOfMonthMs(nowMs) {
  const d = new Date(nowMs)
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime()
}

/**
 * shouldApiFallback({task, windows, budget, usageReader, clock}) → the bounded decision.
 *
 * @param {{lane?:string, apiCostCeilingEur?:number}} task
 * @param {(boolean|{allClosed:boolean})} windows  // are the task's lane worker windows ALL closed?
 * @param {{monthlyApiCapEur?:number, warnPct?:number[], usdToEur?:number, apiAccountName?:string, perTaskCeilingEur?:number}} budget
 * @param {(args:{accountName:string, windowMs:number, clock:Function})=>{costUsd?:number}} usageReader
 * @param {()=>number} [clock]
 * @returns {{fallback:boolean, reason:string, warn?:number}}
 */
export function shouldApiFallback({ task = {}, windows, budget = {}, usageReader, clock = Date.now } = {}) {
  const cap = Number(budget.monthlyApiCapEur) || 0
  const usdToEur = Number.isFinite(Number(budget.usdToEur)) ? Number(budget.usdToEur) : 1
  const apiAccountName = budget.apiAccountName ?? 'api'
  const [warnLow = 70, warnHigh = 90] = Array.isArray(budget.warnPct) ? budget.warnPct : []
  const ceiling = Number(task.apiCostCeilingEur ?? budget.perTaskCeilingEur ?? 0) || 0

  // No budget configured (config default is 0) → the API lane has no money → cannot fall back.
  if (!(cap > 0)) return { fallback: false, reason: 'budget_stop' }

  // A subscription seat may free up shortly — only spend when there is genuinely none open.
  if (!allClosedSignal(windows)) return { fallback: false, reason: 'wait_for_window' }

  // Month-to-date API spend, in EUR.
  const now = clock()
  const windowMs = Math.max(0, now - startOfMonthMs(now))
  const read = typeof usageReader === 'function' ? usageReader({ accountName: apiAccountName, windowMs, clock }) : {}
  const monthToDateEur = (Number(read && read.costUsd) || 0) * usdToEur

  const pct = (100 * monthToDateEur) / cap
  const warn = pct >= warnHigh ? warnHigh : pct >= warnLow ? warnLow : undefined
  const withWarn = (obj) => (warn !== undefined ? { ...obj, warn } : obj)

  // Hard stop: already at/over the cap.
  if (monthToDateEur >= cap) return withWarn({ fallback: false, reason: 'budget_stop' })

  // This task's projected ceiling would breach the cap.
  if (monthToDateEur + ceiling > cap) return withWarn({ fallback: false, reason: 'budget_stop' })

  return withWarn({ fallback: true, reason: 'api_fallback' })
}
