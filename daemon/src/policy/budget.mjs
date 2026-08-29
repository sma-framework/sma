/**
 * budget.mjs — the sub→API switch + the monthly budget stop.
 *
 * WHAT IT IS: a PURE decision — should THIS task fall back from the subscription pool to
 * the paid API lane right now? The answer is bounded by real money so the fallback can never
 * run away.
 *
 * «ПОДПИСКА → API» IS A FIRST-DAY SWITCH WITH A BUDGET STOP. The fallback is
 * permitted ONLY when BOTH hold:
 *   1. the task's lane worker windows are ALL closed (there is no subscription seat to wait
 *      a short moment for — otherwise the honest answer is «wait_for_window», not spend), AND
 *   2. month-to-date API spend + this task's cost-ceiling estimate stays UNDER
 *      monthlyApiCapUsd.
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
 * (reason:'budget_stop'). The stop halts the API lane in real money — it never touches the
 * honesty of the accounting (subscription work is still booked at token value).
 *
 * PITFALL 9 — ANTHROPIC REPRICING is the main economic risk (not a ban). The budget stop
 * IS the hedge: the architecture must stay economical under repricing because the paid lane
 * is capped. WATCH ITEM: the paused programmatic-credit split is announced to return;
 * a future revision may reintroduce a credit-based split beneath this cap.
 *
 * ═══════════ ВАЛЮТА: ОДНА НА ВСЁМ ПУТИ, И ИМЯ ПОЛЯ ГОВОРИТ ПРАВДУ ═══════════
 * Строки расхода приходят от поставщика в ДОЛЛАРАХ (`total_cost_usd`), и потолок задаётся
 * в тех же долларах — `budget.monthlyApiCapUsd`. Пересчёта курса в продукте НЕТ, и это
 * сказано словами (на экране — FX_NOTE), а не спрятано в имени поля: до этой уборки потолок
 * назывался `monthlyApiCapEur` и сравнивался с сырыми долларами, то есть порог остановки
 * денег стоял не там, где думал человек. Курс — отдельное решение владельца.
 *
 * ═══════════ ОДИН ИСТОЧНИК РАСХОДА, ОБЩИЙ С ЭКРАНОМ ═══════════
 * Число, с которым здесь сравнивается потолок, БЕРЁТСЯ ИЗ policy/spend.mjs — той же функции,
 * из которой «Расходы» берут строку «за месяц». Раньше их было два: здесь читалось `costUsd`
 * (все каналы, один аккаунт, календарный месяц), на экране — `apiCostUsd` (только платный,
 * все аккаунты, скользящие 30 суток). Оно и возвращается в решении полем `spentUsd`, чтобы
 * совпадение экрана и порога проверялось машиной, а не читалось на слово.
 *
 * SEAM (documentation, not a test dependency): this function returns a DECISION only. The
 * env application (ANTHROPIC_API_KEY precedence over subscription auth) is buildAccountEnv's
 * job in the runner — the switch is env-only downstream.
 *
 * Spend read via the injected usageReader; no process.env. Two imports, and both are the
 * point of this revision: the shared spend reading, and the shared reading of the cap.
 */

import { apiCapUsd } from '../config.mjs'
import { monthToDateApiSpendUsd, round2Usd } from './spend.mjs'

/** Normalize the "are all lane windows closed?" signal — a boolean or {allClosed:boolean}. */
function allClosedSignal(windows) {
  if (typeof windows === 'boolean') return windows
  return Boolean(windows && windows.allClosed)
}

/**
 * shouldApiFallback({task, windows, budget, usageReader, accountNames, clock}) → the bounded
 * decision, plus the very number it was decided on.
 *
 * `accountNames` is the account set the spend is read over, and it comes from the caller
 * (main.mjs: `spendAccountNames(config)`) so the stop and the screen read the SAME set.
 * Absent, it degrades to the paid lane's own account — the old behaviour, never a wider one.
 *
 * @param {{lane?:string, apiCostCeilingUsd?:number}} task
 * @param {(boolean|{allClosed:boolean})} windows  // are the task's lane worker windows ALL closed?
 * @param {{monthlyApiCapUsd?:number, warnPct?:number[], apiAccountName?:string, perTaskCeilingUsd?:number}} budget
 * @param {(args:{accountName:string, windowMs:number, clock:Function})=>{apiCostUsd?:number}} usageReader
 * @param {string[]} [accountNames]
 * @param {()=>number} [clock]
 * @returns {{fallback:boolean, reason:string, warn?:number, spentUsd?:number}}
 */
export function shouldApiFallback({
  task = {},
  windows,
  budget = {},
  usageReader,
  accountNames,
  clock = Date.now,
} = {}) {
  // ЧИТАЕТСЯ ТЕМ ЖЕ ВЫРАЖЕНИЕМ, ЧТО И НА ЭКРАНЕ (config.mjs: apiCapUsd) — включая перенос
  // прежнего имени с диска. Своё `Number(budget.monthlyApiCapUsd)` здесь означало бы, что на
  // старом файле экран показывает потолок, а правило его не видит: та же болезнь этажом ниже.
  const cap = apiCapUsd(budget)
  const apiAccountName = budget.apiAccountName ?? 'api'
  const [warnLow = 70, warnHigh = 90] = Array.isArray(budget.warnPct) ? budget.warnPct : []
  const ceiling = Number(task.apiCostCeilingUsd ?? budget.perTaskCeilingUsd ?? 0) || 0

  // No budget configured (config default is 0) → the API lane has no money → cannot fall back.
  // NOT «budget_stop»: nothing was spent and no ceiling was reached — the channel was never
  // set up. See the header: one word for two states is how a screen tells a person to raise
  // a limit he never set.
  if (!(cap > 0)) return { fallback: false, reason: 'api_cap_unset' }

  // A subscription seat may free up shortly — only spend when there is genuinely none open.
  if (!allClosedSignal(windows)) return { fallback: false, reason: 'wait_for_window' }

  // Month-to-date paid-channel spend, in USD — the SAME reading the screen prints.
  const names = Array.isArray(accountNames) && accountNames.length > 0 ? accountNames : [apiAccountName]
  const spentUsd = round2Usd(monthToDateApiSpendUsd({ usageReader, accountNames: names, clock }))

  const pct = (100 * spentUsd) / cap
  const warn = pct >= warnHigh ? warnHigh : pct >= warnLow ? warnLow : undefined
  const withWarn = (obj) => (warn !== undefined ? { ...obj, warn, spentUsd } : { ...obj, spentUsd })

  // Hard stop: already at/over the cap.
  if (spentUsd >= cap) return withWarn({ fallback: false, reason: 'budget_stop' })

  // This task's projected ceiling would breach the cap.
  if (spentUsd + ceiling > cap) return withWarn({ fallback: false, reason: 'budget_stop' })

  return withWarn({ fallback: true, reason: 'api_fallback' })
}
