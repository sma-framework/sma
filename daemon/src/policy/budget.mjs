/**
 * budget.mjs — the sub→API switch + the monthly budget stop.
 *
 * WHAT IT IS: a PURE decision — should THIS task fall back from the subscription pool to
 * the paid API lane right now? The answer is bounded by real € so the fallback can never
 * run away.
 *
 * «ПОДПИСКА → API» IS A FIRST-DAY SWITCH WITH A BUDGET STOP. The fallback is
 * permitted ONLY when BOTH hold:
 *   1. the task's lane worker windows are ALL closed (there is no subscription seat to wait
 *      a short moment for — otherwise the honest answer is «wait_for_window», not spend), AND
 *   2. month-to-date API spend + this task's cost-ceiling estimate stays UNDER
 *      monthlyApiCapEur.
 * Otherwise: {fallback:false, reason:'wait_for_window' | 'budget_stop' | 'api_cap_unset'}.
 *
 * THREE REFUSALS, NOT TWO — and the third exists because two of them used to be one word
 * carrying two incompatible meanings. When no cap was ever configured (and 0 is the SHIPPED
 * DEFAULT, so this is the ordinary state of a fresh install) this rule answered
 * «budget_stop»: the money ran out. The queue's own plaque, reading the very same facts,
 * said «платный канал не настроен». Both sentences reached a person and only one was true.
 * So the state gets its own name — `api_cap_unset`: the paid channel is not set up, nothing
 * was spent, nothing ran out, and the task waits for a subscription window like any other.
 *
 * WARN BEFORE THE STOP: at ≥70% and ≥90% of the cap the decision carries `warn: 70|90` so
 * the roster shows the founder the budget filling BEFORE the hard stop at 100%
 * (reason:'budget_stop'). The stop halts the API lane in real € — it never touches the
 * honesty of the accounting (subscription work is still booked at token value).
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
 * job in the runner — the switch is env-only downstream.
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
  // NOT «budget_stop»: nothing was spent and no ceiling was reached — the channel was never
  // set up. See the header: one word for two states is how a screen tells a person to raise
  // a limit he never set.
  if (!(cap > 0)) return { fallback: false, reason: 'api_cap_unset' }

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
