/**
 * ЧЕСТНОСТЬ ДЕНЕГ — имя поля называет ту валюту, которая в нём лежит, и порог остановки денег
 * читает ТО ЖЕ число, которое человек видит на экране.
 *
 * ═══════════════ ЧТО БЫЛО ДО ЭТОГО ФАЙЛА ═══════════════
 * Поставщик выставляет стоимость в ДОЛЛАРАХ (`total_cost_usd`). Пересчёта курса в продукте нет
 * и не заводится — это отдельное решение владельца. При этом пять разных полей на пути до
 * человека назывались «…Eur», и в них клались сырые доллары: `todayEur`, `monthEur`, `capEur`,
 * `spentTodayEur`, `eur`/`apiEquivalentEur` точки истории. Пока курс мысленно считается
 * единицей, ошибка не видна — и ровно поэтому она дожила бы до дня, когда перестанет быть
 * незаметной. Дороже всего это стоило у ПОТОЛКА: он задавался «в евро», а сравнивался с этими
 * же долларами, то есть порог остановки денег стоял не там, где его ставил человек.
 *
 * ВТОРАЯ ПОЛОВИНА, ТОГО ЖЕ КЛАССА. Порог стопа и экран брали РАЗНЫЕ поля расхода: правило
 * отката читало `costUsd` — сумму ВСЕХ каналов — по одному аккаунту платной полосы за
 * календарный месяц, а «Расходы» читали `apiCostUsd` — только платный канал — по ВСЕМ аккаунтам
 * за скользящие тридцать суток. Три расхождения сразу, и все молчаливые: пока по подписке
 * ничего не записано, числа совпадают.
 *
 * ═══════════════ ЧТО ИМЕННО ЗДЕСЬ УТВЕРЖДАЕТСЯ ═══════════════
 * 1. ИМЯ ↔ СОДЕРЖИМОЕ. Ни одно поле, доехавшее до человека (полезная нагрузка двери и договор
 *    окна), не названо валютой, которой в нём нет. Валюта в системе ровно одна — доллар, — и
 *    имена это говорят. Переименуйте поле обратно в `…Eur` — случай покраснеет.
 * 2. ОДИН ИСТОЧНИК. Решение правила отката и число на экране совпадают ПОРАЗРЯДНО, и это
 *    утверждается на ПОДДЕЛКЕ, на которой прежние два чтения дали бы разное: платный расход
 *    записан под аккаунтом работника, у строк подписки своя стоимость, а читатель ещё и
 *    чувствителен к длине окна. На такой подделке совпадение случайным быть не может.
 * 3. СЛОВА РЯДОМ С ЧИСЛОМ. Там, где курс не считается, экран говорит об этом фразой, а не
 *    умалчивает: FX_NOTE стоит и под суммами «Расходов», и у поля ввода потолка.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { contractFields } from '../../tools/contract-shown-check.mjs'
import { apiCapUsd } from '../src/config.mjs'
import { shouldApiFallback } from '../src/policy/budget.mjs'
import { spendAccountNames } from '../src/policy/spend.mjs'
import { deriveState, deriveRules } from '../src/front/state.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')

const DAY = 86_400_000
/** 29 августа 2026, полдень по местному времени — месяц уже начался, но ещё не кончился. */
const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()
const win = (status: string) => ({ status, resetsAt: null, pct: null, observedAt: null })
const openWindows = () => ({ fiveHour: win('open'), week: win('open') })

/**
 * ЕДИНСТВЕННАЯ ВАЛЮТА ПРОДУКТА. Не «предпочтительная» — единственная: книга расхода несёт
 * `costUsd`/`apiCostUsd`, и больше в системе денег ниоткуда не берётся. Поэтому суффикс имени
 * поля — проверяемое утверждение, а не стиль.
 */
const CURRENCY_SUFFIX = 'Usd'

/** Валютные суффиксы, которых в именах быть не может, потому что таких денег в системе нет. */
const FOREIGN_SUFFIXES = ['Eur', 'Rub', 'Gbp', 'Chf']

/** Все пары «путь → ключ» глубоко внутри ответа двери: имя поля здесь и есть предмет проверки. */
function everyKey(value: unknown, path = '', out: { path: string; key: string; value: unknown }[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => everyKey(item, `${path}[${i}]`, out))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out.push({ path: path ? `${path}.${key}` : key, key, value: inner })
      everyKey(inner, path ? `${path}.${key}` : key, out)
    }
  }
  return out
}

/** Имя, названное чужой валютой, — с любым регистром хвоста: `capEur`, `capEUR`, `totaleur`. */
function namesForeignCurrency(name: string): string | null {
  for (const suffix of FOREIGN_SUFFIXES) {
    if (new RegExp(`${suffix}$`, 'i').test(name)) return suffix
  }
  return null
}

/**
 * Код без комментариев: правило про ИМЕНА, а комментарий, называющий прежнее имя, — это
 * история, и стирать её ради зелёного гейта значило бы потерять причину, по которой имя сменили.
 */
function codeOnly(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** Настоящий ответ двери на одной подделке читателя расхода. */
async function payloadWith(config: any, usageReader: any, usageSeries?: any) {
  return (await deriveState({
    adapter: { list: async () => [] },
    windows: openWindows,
    config,
    usageReader,
    ...(usageSeries ? { usageSeries } : {}),
    clock: () => NOW,
  })) as any
}

describe('деньги: имя поля называет ту валюту, которая в нём лежит', () => {
  const config = {
    budget: { monthlyApiCapUsd: 50 },
    workers: [
      { id: 'max-1', lane: 'prod', account: { name: 'max-1' } },
      { id: 'max-2', lane: 'prod', account: { name: 'max-2' } },
    ],
  }

  it('ни одно поле ответа двери не названо валютой, которой в системе нет', async () => {
    const payload = await payloadWith(config, ({ accountName }: any) => {
      const paid: Record<string, number> = { 'max-1': 2.4, 'max-2': 1.15 }
      const apiCostUsd = paid[accountName] ?? 0
      return { costUsd: apiCostUsd, apiCostUsd }
    })

    const foreign = everyKey(payload)
      .map((entry) => ({ ...entry, suffix: namesForeignCurrency(entry.key) }))
      .filter((entry) => entry.suffix)
      .map((entry) => `${entry.path} → назван «${entry.suffix}», а в нём доллары`)

    expect(foreign).toEqual([])
  })

  it('в поле, названном долларом, лежат ровно те доллары, что дал читатель', async () => {
    // Читатель отдаёт РАЗНЫЕ `costUsd` и `apiCostUsd`: подделка, на которой эти два числа
    // совпадают, не отличила бы «взяли платный канал» от «взяли всё подряд».
    const payload = await payloadWith(config, ({ accountName }: any) => {
      const paid: Record<string, number> = { 'max-1': 2.4, 'max-2': 1.15 }
      const apiCostUsd = paid[accountName] ?? 0
      return { costUsd: apiCostUsd + 100, apiCostUsd }
    })

    expect(payload.spend.apiFallback.todayUsd).toBe(3.55)
    expect(payload.spend.apiFallback.monthUsd).toBe(3.55)
    expect(payload.kpis.spentTodayUsd).toBe(3.55)
    expect(payload.spend.apiFallback.capUsd).toBe(50)
  })

  it('договор окна не объявляет ни одного поля с чужой валютой в имени', () => {
    const fields = contractFields(read('spa', 'src', 'api', 'types.ts'))
    const foreign = fields
      .map((f: any) => ({ ...f, suffix: namesForeignCurrency(f.name) }))
      .filter((f: any) => f.suffix)
      .map((f: any) => `types.ts:${f.line} ${f.name}`)

    expect(foreign).toEqual([])
    // …и денежные поля в договоре ЕСТЬ — иначе пустой список выше ничего не доказывал бы.
    expect(fields.some((f: any) => f.name.endsWith(CURRENCY_SUFFIX))).toBe(true)
  })

  it('в коде денежного пути не осталось имён на чужую валюту', () => {
    const files = [
      join('daemon', 'src', 'policy', 'spend.mjs'),
      join('daemon', 'src', 'policy', 'budget.mjs'),
      join('daemon', 'src', 'front', 'state.mjs'),
      join('daemon', 'src', 'front', 'federation.mjs'),
      join('daemon', 'src', 'runner', 'usage.mjs'),
      join('daemon', 'src', 'sp-report.mjs'),
      join('spa', 'src', 'api', 'types.ts'),
      join('spa', 'src', 'screens', 'costs', 'index.tsx'),
      join('spa', 'src', 'screens', 'costs', 'SpendTable.tsx'),
      join('spa', 'src', 'screens', 'costs', 'BudgetDialog.tsx'),
      join('spa', 'src', 'screens', 'costs', 'money.ts'),
      join('spa', 'src', 'screens', 'rules', 'index.tsx'),
      join('spa', 'src', 'screens', 'accounts', 'index.tsx'),
      join('spa', 'src', 'screens', 'task-card', 'spend.ts'),
    ]
    const hits: string[] = []
    for (const rel of files) {
      const code = codeOnly(read(rel))
      for (const suffix of FOREIGN_SUFFIXES) {
        const found = code.match(new RegExp(`\\b[A-Za-z_$][A-Za-z0-9_$]*${suffix}\\b`, 'g'))
        if (found) hits.push(`${rel}: ${[...new Set(found)].join(', ')}`)
      }
    }
    expect(hits).toEqual([])
  })

  /**
   * ЕДИНСТВЕННОЕ МЕСТО, КОТОРОЕ ЕЩЁ ЗНАЕТ ПРЕЖНЕЕ ИМЯ, И ЭТО НЕ НЕДОСМОТР. На дисках уже стоят
   * файлы с `monthlyApiCapEur`; забыть это число молча значило бы обнулить потолок, который
   * человек однажды поставил руками, — платная полоса встала бы целиком, а окно объявило бы её
   * «не настроенной». Число переносится КАК ЕСТЬ: пересчёта не было и здесь его нет.
   */
  it('потолок из старого файла на диске читается и не теряется', () => {
    expect(apiCapUsd({ monthlyApiCapEur: 50 })).toBe(50)
    expect(apiCapUsd({ monthlyApiCapUsd: 40, monthlyApiCapEur: 50 })).toBe(40) // новое имя главнее
    expect(apiCapUsd({})).toBe(0)
    // …и старое имя доезжает до самого экрана, а не только до чтения настройки.
    const rules: any = deriveRules({ workers: [], budget: { monthlyApiCapEur: 50 } })
    expect(rules.budgetStops.monthlyApiCapUsd).toBe(50)
    expect(rules.subApiSwitch.capUsd).toBe(50)

    // И ЕГО ВИДИТ НЕ ТОЛЬКО ЭКРАН. Правило со своим собственным чтением потолка означало бы,
    // что на старом файле экран показывает «потолок 50», а платная полоса стоит как
    // ненастроенная, — та же болезнь этажом ниже.
    const decision: any = shouldApiFallback({
      task: { lane: 'prod' },
      windows: { allClosed: true },
      budget: { monthlyApiCapEur: 50, apiAccountName: 'api' },
      usageReader: () => ({ costUsd: 0, apiCostUsd: 0 }),
      clock: () => NOW,
    })
    expect(decision.reason).not.toBe('api_cap_unset')
    expect(decision.fallback).toBe(true)
  })
})

describe('деньги: порог остановки и число на экране — один источник', () => {
  /**
   * ПОДДЕЛКА, НА КОТОРОЙ ПРЕЖНИЕ ДВА ЧТЕНИЯ ДАЛИ БЫ РАЗНОЕ.
   *
   * • платный расход записан под аккаунтом РАБОТНИКА (`max-1`), а не под аккаунтом полосы —
   *   прежний порог обходил только аккаунт полосы и этого расхода не видел вовсе;
   * • у строк подписки своя стоимость (`costUsd` много больше `apiCostUsd`) — прежний порог
   *   читал сумму ВСЕХ каналов и записывал оплаченную планом работу в счёт платной полосы.
   */
  const config = {
    budget: { monthlyApiCapUsd: 5 },
    workers: [
      { id: 'max-1', lane: 'prod', account: { name: 'max-1' } },
      { id: 'max-2', lane: 'prod', account: { name: 'max-2' } },
    ],
  }
  const byAccount: Record<string, { costUsd: number; apiCostUsd: number }> = {
    'max-1': { costUsd: 40, apiCostUsd: 4 },
    'max-2': { costUsd: 12, apiCostUsd: 0 },
    api: { costUsd: 2, apiCostUsd: 2 },
  }
  const usageReader = ({ accountName }: any) => byAccount[accountName] ?? { costUsd: 0, apiCostUsd: 0 }

  it('решение правила и цифра «за месяц» на экране — одно и то же число', async () => {
    const payload = await payloadWith(config, usageReader)
    const decision: any = shouldApiFallback({
      task: { lane: 'prod' },
      windows: { allClosed: true },
      budget: config.budget,
      usageReader,
      accountNames: spendAccountNames(config),
      clock: () => NOW,
    })

    expect(payload.costs.apiFallback.monthUsd).toBe(6) // 4 (max-1) + 0 (max-2) + 2 (полоса)
    expect(decision.spentUsd).toBe(payload.costs.apiFallback.monthUsd)

    // И это не совпадение чисел на ровном месте: потолок 5, значит ОБА видят перебор — правило
    // останавливает деньги, а очередь объясняет это тем же словом.
    expect(decision.reason).toBe('budget_stop')
    expect(decision.fallback).toBe(false)

    // ПОДДЕЛКА ДЕЙСТВИТЕЛЬНО РАЗЛИЧАЮЩАЯ: прежнее чтение порога (все каналы, один аккаунт
    // полосы) дало бы на ней ДРУГОЕ число — и другое решение. Без этой строки случай выше мог
    // бы пройти на подделке, где источники неотличимы.
    const asTheStopUsedToRead = usageReader({ accountName: 'api' }).costUsd
    expect(asTheStopUsedToRead).not.toBe(payload.costs.apiFallback.monthUsd)
    expect(asTheStopUsedToRead).toBeLessThan(config.budget.monthlyApiCapUsd)
  })

  it('окно у обоих одно: календарный месяц, а не скользящие тридцать суток', async () => {
    // Читатель отвечает ДЛИНОЙ ОКНА в сутках. Скользящее окно дало бы ровно 30; календарное
    // с первого числа — 28 с половиной. Совпадение двух чисел здесь может значить только то,
    // что окно у них общее.
    const windowSensitive = ({ accountName, windowMs }: any) =>
      accountName === 'api' ? { costUsd: 0, apiCostUsd: windowMs / DAY } : { costUsd: 0, apiCostUsd: 0 }

    const payload = await payloadWith({ ...config, budget: { monthlyApiCapUsd: 500 } }, windowSensitive)
    const decision: any = shouldApiFallback({
      task: { lane: 'prod' },
      windows: { allClosed: true },
      budget: { monthlyApiCapUsd: 500 },
      usageReader: windowSensitive,
      accountNames: spendAccountNames(config),
      clock: () => NOW,
    })

    expect(decision.spentUsd).toBe(payload.costs.apiFallback.monthUsd)
    expect(payload.costs.apiFallback.monthUsd).toBe(28.5) // 28 суток и полдня от 1-го числа
    expect(payload.costs.apiFallback.monthUsd).not.toBe(30) // а не скользящее окно
  })

  it('очередь объясняет остановку тем же числом, которым она и происходит', async () => {
    const payload = await payloadWith(
      { ...config, pipeline: { enabled: true }, budget: { monthlyApiCapUsd: 5 } },
      usageReader,
    )
    // Окна закрыты нечем — держим их открытыми, значит остановки нет и причина не ставится.
    expect(payload.costs.apiFallback.monthUsd).toBe(6)

    const shut = (await deriveState({
      adapter: { list: async () => [{ id: 'BL-1', status: 'queued', lane: 'prod', title: 'x', priority: 0, enqueuedAt: NOW }] },
      windows: () => ({ fiveHour: win('exhausted'), week: win('exhausted'), closedUntil: NOW + DAY }),
      config: { ...config, pipeline: { enabled: true }, budget: { monthlyApiCapUsd: 5 } },
      usageReader,
      clock: () => NOW,
    })) as any

    expect(shut.queue[0].idleReason).toBe('budget_stop')
  })
})

describe('деньги: где курс не считается, рядом с числом стоят слова', () => {
  const money = read('spa', 'src', 'screens', 'costs', 'money.ts')

  it('фраза о том, что курс не пересчитывается, существует и называет обе вещи', () => {
    const quoted = /FX_NOTE = '([^']+)'/.exec(money)
    expect(quoted).not.toBeNull()
    const note = quoted![1]
    expect(note).toMatch(/курс/i)
    expect(note).toMatch(/доллар/i)
  })

  it('она стоит там, где человек читает суммы и где он ставит потолок', () => {
    for (const rel of [
      join('spa', 'src', 'screens', 'costs', 'index.tsx'),
      join('spa', 'src', 'screens', 'costs', 'BudgetDialog.tsx'),
    ]) {
      const text = read(rel)
      expect(text).toMatch(/\bFX_NOTE\b/)
      expect(text).toMatch(/\{FX_NOTE\}/) // не только импортирована — нарисована
    }
  })

  it('знака чужой валюты на экранах не осталось ни одного', () => {
    const files = [
      join('spa', 'src', 'screens', 'costs', 'index.tsx'),
      join('spa', 'src', 'screens', 'costs', 'SpendTable.tsx'),
      join('spa', 'src', 'screens', 'costs', 'BudgetDialog.tsx'),
      join('spa', 'src', 'screens', 'costs', 'money.ts'),
      join('spa', 'src', 'screens', 'rules', 'index.tsx'),
      join('spa', 'src', 'screens', 'accounts', 'index.tsx'),
      join('spa', 'src', 'screens', 'task-card', 'spend.ts'),
    ]
    const withEuroSign = files.filter((rel) => read(rel).includes('€'))
    expect(withEuroSign).toEqual([])
  })
})
