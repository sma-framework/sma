/**
 * provider-adapter.mjs — ОДНА СТРОКА ТАБЛИЦЫ НА ПОЛОСУ, И ВСЁ ДЕРЕВО СПРАШИВАЕТ ЕЁ.
 *
 * ═══════════════ ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ ═══════════════
 *
 * У фронта работы два поставщика, и завтра будет третий. Пока «кто мы такие» решалось
 * сравнением имени в каждом месте, где это было нужно, полоса второго поставщика жила из
 * россыпи `if` по всему тракту задачи: один в сборке команды, один в учёте расхода, один в
 * доставке поправки, один в решении «кому коммитить из песочницы». Такая россыпь ломается не
 * тем, что она некрасива, а тем, что ТРЕТЬЯ полоса добавляется в неё по одному месту за раз, и
 * забытое место не падает — оно молча ведёт себя как Claude. Замерено на этой же неделе:
 * поправка, посланная живой работе стороннего поставщика, отвечала «принято», убивала ход и
 * никуда не доезжала, потому что дорогу выбирал `if` по имени двоичного файла.
 *
 * ПОЭТОМУ ПОЛОСА ОБЪЯВЛЯЕТСЯ ЗДЕСЬ ОДНОЙ СТРОКОЙ, а потребители спрашивают её СВОЙСТВА, а не
 * имя. Свойства названы так, как о них спрашивает продукт:
 *
 *   bin                      — чем эта полоса запускается;
 *   argsOf(opts)             — во что превращается набор решений о запуске. Каждая полоса
 *                              берёт из набора то, что её командная строка ПРАВДА умеет нести,
 *                              и это единственное место, где видно, чего она не умеет;
 *   sandboxOf(allowedTools)  — во что превращается грант конверта: у одной полосы это флаги
 *                              инструментов (и тогда здесь null), у другой — песочница;
 *   needsProvisionedSandbox  — исполняется ли эта граница машиной, которую надо готовить
 *                              заранее (и значит, задачу с правом писать надо отказать ДО
 *                              спавна, а не после сожжённого окна);
 *   seedsTaskHome            — чеканится ли этой полосе свой дом задачи перед первым словом;
 *   resumesSession           — есть ли дорога ВЕРНУТЬСЯ в идущую сессию. От этого зависит,
 *                              каким путём едет слово человека, сказанное работе на ходу;
 *   statesWindows            — говорит ли поток этой полосы о ОКНАХ подписки. «Нет» здесь —
 *                              это объявленная слепота, а не забытое место;
 *   deniesGitDir({platform}) — правда ли, что сессия этой полосы не сможет закоммитить сама и
 *                              коммит придётся делать снаружи;
 *   finalEventOf(line)       — ФИНАЛЬНЫЙ кадр этой полосы, если строка им является;
 *   usageFromFinal / tokensFromFinal — как с этого кадра снимаются строка книги и четыре числа.
 *
 * ЧТО ЗДЕСЬ НЕ ЖИВЁТ. Ни одного нового правила: каждое выражение уже написано в `args.mjs`,
 * `stream.mjs` и `usage.mjs` и зовётся отсюда. Этот файл — таблица, а не вторая редакция.
 * Вторая редакция правила — это способ, каким два места однажды начинают отвечать по-разному
 * об одной стене.
 *
 * ЧЕГО ЗДЕСЬ ПОКА НЕТ, И ЭТО НАЗВАНО ЧЕСТНО. Посев дома задачи (логин, след песочницы, свой
 * TEMP) и сборка окружения счёта остались в `args.mjs`/`build-args.mjs`: они трогают диск и
 * бросают именованные отказы, и переносить их вместе с таблицей значило бы менять две вещи
 * одним движением. Таблица уже говорит, КОМУ дом нужен (`seedsTaskHome`); переезд самого
 * посева — следующий шаг, а не этот.
 *
 * Node built-ins не нужны вовсе: чистая таблица над чистыми выражениями.
 */

import { buildClaudeArgs, buildCodexArgs, codexSandboxFor, codexSandboxDeniesGitDir } from './args.mjs'
import { parseClaudeEvent, parseCodexEvent } from './stream.mjs'
import { claudeUsageFromResult, claudeTokensFromResult, codexUsageFromFinal, codexTokensFromFinal } from './usage.mjs'

/**
 * The default binaries. Which one runs is the route's provider; WHERE it lives is PATH's job.
 *
 * ОБЪЯВЛЕНЫ ЗДЕСЬ, А НЕ В СБОРЩИКЕ КОМАНДЫ: имя двоичного файла — это свойство полосы, и
 * сборщик его теперь спрашивает, а не выбирает. `build-args.mjs` продолжает отдавать оба имени
 * наружу тем, кто их уже импортировал, — переименовывать чужие импорты ради переезда константы
 * было бы правкой не о деле.
 */
export const CLAUDE_BIN = 'claude'
export const CODEX_BIN = 'codex'

/**
 * ПОЛОСА CLAUDE. Грант конверта едет флагами инструментов, потолок ходов — числом на командной
 * строке, слово человека — возвратом в ту же сессию, окна — кадрами её собственного потока.
 */
const CLAUDE_LANE = Object.freeze({
  id: 'claude',
  bin: CLAUDE_BIN,

  /**
   * ЧТО ЭТА КОМАНДНАЯ СТРОКА ПРАВДА УМЕЕТ НЕСТИ. Набор решений о запуске один на все полосы;
   * здесь он раскладывается по флагам, которые у этого CLI есть.
   */
  argsOf({ model, effort, maxTurns, wakeKind, resumeId, mcpConfigPath, forwardSubagentText, allowedTools, disallowedTools } = {}) {
    return buildClaudeArgs({
      ...(model !== undefined && model !== null ? { model } : {}),
      ...(effort !== undefined && effort !== null ? { effort } : {}),
      ...(maxTurns !== undefined && maxTurns !== null ? { maxTurns } : {}),
      ...(wakeKind ? { wakeKind: String(wakeKind) } : {}),
      ...(resumeId ? { resumeId: String(resumeId) } : {}),
      ...(mcpConfigPath ? { mcpConfigPath: String(mcpConfigPath) } : {}),
      forwardSubagentText: forwardSubagentText === true,
      ...(Array.isArray(allowedTools) && allowedTools.length > 0 ? { allowedTools } : {}),
      ...(Array.isArray(disallowedTools) && disallowedTools.length > 0 ? { disallowedTools } : {}),
    })
  },

  /** Грант этой полосы едет флагами инструментов, а не границей запуска. */
  sandboxOf() {
    return null
  },

  needsProvisionedSandbox: false,
  seedsTaskHome: false,
  resumesSession: true,
  statesWindows: true,

  /** Эта сессия коммитит себя сама: её работа с git ничем не ограничена. */
  deniesGitDir() {
    return false
  },

  finalEventOf(line) {
    const event = parseClaudeEvent(line)
    return event && event.type === 'result' ? event : null
  },

  usageFromFinal(event, ctx) {
    return claudeUsageFromResult(event, ctx)
  },

  tokensFromFinal(event) {
    return claudeTokensFromResult(event)
  },
})

/**
 * ПОЛОСА CODEX. Грант конверта едет ПЕСОЧНИЦОЙ (другой формы у этого CLI нет), потолка ходов
 * его командная строка не несёт вовсе, окон её поток не говорит, и вернуться в идущую сессию
 * сегодня нечем — слово человека едет заданием следующего захода.
 */
const CODEX_LANE = Object.freeze({
  id: 'codex',
  bin: CODEX_BIN,

  /**
   * ТРИ РЕШЕНИЯ ИЗ НАБОРА, И ЭТО ВИДНО. Потолок ходов, список инструментов и отказ по
   * инструментам этой командной строкой не переносятся: у `codex exec` нет для них флага.
   * Молча уронить их здесь — не то же самое, что уронить их в развилке посреди сборки: тут
   * это ОДНА строка, о которой можно спросить, и опись паритета спрашивает именно её.
   */
  argsOf({ model, effort, sandbox } = {}) {
    return buildCodexArgs({
      ...(model !== undefined && model !== null ? { model } : {}),
      ...(effort !== undefined && effort !== null ? { effort } : {}),
      ...(sandbox !== undefined && sandbox !== null ? { sandbox } : {}),
    })
  },

  sandboxOf(allowedTools) {
    return codexSandboxFor(allowedTools)
  },

  needsProvisionedSandbox: true,
  seedsTaskHome: true,
  resumesSession: false,
  statesWindows: false,

  deniesGitDir({ platform } = {}) {
    return codexSandboxDeniesGitDir({ platform, provider: 'codex' })
  },

  finalEventOf(line) {
    const event = parseCodexEvent(line)
    return event && event.type === 'turn.completed' ? event : null
  },

  usageFromFinal(event, ctx) {
    return codexUsageFromFinal(event, ctx)
  },

  tokensFromFinal(event) {
    return codexTokensFromFinal(event)
  },
})

/**
 * ВСЕ ПОЛОСЫ, КОТОРЫЕ ЭТОТ ДЕМОН УМЕЕТ ЗАПУСКАТЬ. Платного канала (`api`) здесь нет и не
 * должно быть: у него нет ни работника, ни командной строки — маршрут по нему не запускает
 * процесса вовсе, и строка в таблице запуска обещала бы обратное.
 */
export const PROVIDER_ADAPTERS = Object.freeze({ claude: CLAUDE_LANE, codex: CODEX_LANE })

/** Полоса, которой читается всё, о чём таблица молчит. Объявлена, а не подразумевается. */
export const DEFAULT_PROVIDER = 'claude'

/**
 * providerAdapter(name) → строка таблицы или `null`.
 *
 * NULL — ЭТО ОТВЕТ. «Такой полосы у нас нет» и «полоса ведёт себя как Claude» — разные факты, и
 * тот, кто спрашивает про наличие (опись паритета, проверка настроек), обязан различать их.
 *
 * @param {string} [name]
 * @returns {object|null}
 */
export function providerAdapter(name) {
  const key = typeof name === 'string' ? name : ''
  return Object.prototype.hasOwnProperty.call(PROVIDER_ADAPTERS, key) ? PROVIDER_ADAPTERS[key] : null
}

/**
 * laneAdapter(name) → строка таблицы, и всегда какая-нибудь.
 *
 * ДЛЯ ТЕХ, КОМУ НУЖЕН ОТВЕТ ВСЕГДА. Тик посреди попытки не может остановиться на вопросе «а
 * что это за полоса»: маршрут мог не назвать поставщика вовсе, и до этой таблицы такое место
 * читалось как Claude — просто потому, что ветка `else` была его. Поведение сохранено ровно
 * тем же, но теперь оно ОБЪЯВЛЕНО одной строкой, а не разлито по развилкам.
 *
 * @param {string} [name]
 * @returns {object}
 */
export function laneAdapter(name) {
  return providerAdapter(name) ?? PROVIDER_ADAPTERS[DEFAULT_PROVIDER]
}
