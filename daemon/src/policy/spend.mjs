/**
 * spend.mjs — ОДНО ЧТЕНИЕ РАСХОДА ПЛАТНОГО КАНАЛА. То же число видит человек на «Расходах»,
 * то же число сравнивает с потолком порог остановки денег.
 *
 * ═══════════════ ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ ПОЯВИЛСЯ ═══════════════
 * Расход платного канала считался в двух местах, и оба считали по-своему:
 *   • порог стопа (policy/budget.mjs) брал `costUsd` — сумму ВСЕХ каналов — по ОДНОМУ
 *     аккаунту платной полосы, за календарный месяц;
 *   • экран (front/state.mjs) брал `apiCostUsd` — только платный канал — по ВСЕМ аккаунтам,
 *     за скользящие 30 суток.
 * Два числа об одном и том же расходятся не «если», а «когда»: пока по подписке ничего не
 * записано, они совпадают, и ошибка невидима ровно до дня, когда перестанет быть невидимой.
 * Хуже того, расходились они молча — на экране одно, а деньги останавливались по другому.
 *
 * Поэтому источник ровно один, и у него три составляющие, каждая названа:
 *   ПОЛЕ    — `apiCostUsd`: расход ПЛАТНОГО канала. Подписка уже оплачена планом, и её
 *             стоимость в потолок платной полосы не входит (иначе потолок останавливал бы
 *             деньги за работу, за которую никто второй раз не платит).
 *   АККАУНТЫ— аккаунты всех работников ПЛЮС собственный аккаунт платной полосы: у отката
 *             своего работника нет — в том и смысл отката, — а строка платного канала может
 *             быть записана и под аккаунтом работника, который на него свалился.
 *   ОКНО    — календарный месяц с первого числа. Потолок назван «в месяц», и месяц у него
 *             тот, который человек видит в календаре, а не скользящие тридцать суток.
 *
 * ═══════════════ ВАЛЮТА НАЗВАНА ЧЕСТНО, И КУРС НЕ СЧИТАЕТСЯ ═══════════════
 * Строки расхода приходят от поставщика в ДОЛЛАРАХ (`total_cost_usd`), и никакого пересчёта
 * в этом продукте нет. Значит все поля на этом пути называются `*Usd` и потолок задаётся
 * в долларах. Пересчёт курса — отдельное решение владельца, а не побочный эффект уборки;
 * пока его нет, обязанность сказать об этом словами лежит на экране (spa: FX_NOTE).
 *
 * Node built-ins only; никаких сторонних зависимостей и никакого process.env.
 */

/** accountName из профиля аккаунта или из голой строки. */
export function accountNameOf(account, fallback) {
  if (typeof account === 'string') return account
  return (account && account.name) || fallback
}

/** Начало календарного месяца для `nowMs`, по местному времени (месяц — окно, а не скольжение). */
export function startOfMonthMs(nowMs) {
  const d = new Date(nowMs)
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime()
}

/**
 * spendAccountNames(config) → аккаунты, под которыми вообще может быть записан платный расход,
 * без повторов и в устойчивом порядке: аккаунты работников, затем собственный аккаунт полосы.
 */
export function spendAccountNames(config = {}) {
  const workers = Array.isArray(config.workers) ? config.workers : []
  const apiAccountName = (config.budget && config.budget.apiAccountName) || 'api'
  const names = [...workers.map((w) => accountNameOf(w.account, w.id)), ...(apiAccountName ? [apiAccountName] : [])]
  const out = []
  const seen = new Set()
  for (const name of names) {
    if (name == null || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * apiSpendUsd({usageReader, accountNames, windowMs, clock}) → расход ПЛАТНОГО канала в
 * долларах за окно, одной суммой по названным аккаунтам.
 *
 * Читатель, который упал, вносит 0 и никогда не заклинивает опрос: экран, переставший
 * обновляться, — это худшая из возможных цифр. Читатель старее раскола каналов не знает
 * `apiCostUsd` и вносит 0, а не число из соседней колонки: занизить платный расход не так
 * страшно, как выдать за него расход подписки.
 */
export function apiSpendUsd({ usageReader, accountNames = [], windowMs, clock = Date.now } = {}) {
  if (typeof usageReader !== 'function') return 0
  let sum = 0
  const seen = new Set()
  for (const name of Array.isArray(accountNames) ? accountNames : []) {
    if (name == null || seen.has(name)) continue
    seen.add(name)
    try {
      const u = usageReader({ accountName: name, windowMs, clock })
      sum += Number(u && u.apiCostUsd) || 0
    } catch {
      /* сбой читателя стоит 0, а не красного экрана */
    }
  }
  return sum
}

/**
 * monthToDateApiSpendUsd({usageReader, accountNames, clock}) → ТО САМОЕ одно число: расход
 * платного канала с первого числа месяца, в долларах.
 *
 * Его сравнивает с потолком `shouldApiFallback`, его же печатает «Расходы» строкой
 * «за месяц» и по нему же очередь объясняет остановку. Один вызов — одно число.
 */
export function monthToDateApiSpendUsd({ usageReader, accountNames = [], clock = Date.now } = {}) {
  const now = typeof clock === 'function' ? clock() : Date.now()
  const windowMs = Math.max(0, now - startOfMonthMs(now))
  return apiSpendUsd({ usageReader, accountNames, windowMs, clock: () => now })
}

/** Копейки, а не доли: деньги округляются один раз — здесь. */
export function round2Usd(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}
