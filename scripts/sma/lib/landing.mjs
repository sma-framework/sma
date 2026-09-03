/**
 * landing.mjs — ПОСАДКА: что дверь приёмки делает ВОКРУГ слияния, чтобы вершина осталась
 * зелёной без единой команды в терминале.
 *
 * ═══════════════════════ ЧТО БЫЛО НЕ ТАК ═══════════════════════════════════════
 *
 * Кнопка «принять» сливала ветку и на этом заканчивалась. Числа продукта — значок прогона в
 * обоих README, измеренная квитанция и числа карты — оставались теми, что снял работник на
 * СВОЁМ дереве, а вершина после слияния становилась ДРУГИМ деревом. Сторож чисел краснел
 * сразу после нажатия, и человек доводил приёмку руками: свод, полный прогон, дозапись чисел,
 * возврат маркера версии, коммит явными путями. Пять команд после каждой кнопки.
 *
 * Вторая половина той же беды — цена прогона. Полный набор этого дерева измеряется тысячами
 * тестов и минутами; за жизнь одной карточки он шёл три-четыре раза: работник перед сдачей,
 * приёмщик при перештамповке, дверь при посадке. Все три раза — над ОДНИМ И ТЕМ ЖЕ деревом.
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ РЕШЕНО ══════════════════════════════════════
 *
 * ДВА ДЕЙСТВИЯ, И ОБА ПРИНАДЛЕЖАТ ПОСАДКЕ:
 *
 *   1. `runTests` — прогонятель, который РИТУАЛ СЛИЯНИЯ зовёт на сведённом, но ещё не
 *      зафиксированном дереве. Он задаёт ровно один вопрос: описывает ли квитанция, лежащая в
 *      этом дереве, ИМЕННО ЭТО дерево. Вопрос задаётся не на слово, а по хешу: `git write-tree`
 *      называет дерево слияния, `<коммит квитанции>^{tree}` — дерево, на котором мерили. Совпали
 *      — значит вершина с тех пор не двигалась, работник мерил ровно то, что сейчас сводится, и
 *      второй прогон измерил бы то же самое. Не совпали — набор идёт ОДИН раз, здесь, и его
 *      приговор решает судьбу слияния по общему закону ритуала (красный — `merge --abort`,
 *      ветка не входит).
 *
 *   2. `stamp` — штамп, который ставится ПОСЛЕ фиксации слияния, своим коммитом и явными
 *      путями. Раньше поставить его нельзя: квитанция обязана называть коммит, чьё дерево
 *      измерено, а коммита слияния до фиксации не существует. Именно поэтому у сторожа
 *      свежести есть исключение для производных мест — запись замера всегда делает ещё один
 *      коммит.
 *
 *   0. `buildWindow` — ПЕРЕСБОРКА ОКНА, и она идёт РАНЬШЕ прогона. Демон раздаёт окно не из
 *      `spa/src`, а из собранного бандла, который гитом не отслеживается вовсе: слияние
 *      приносит в дерево НОВЫЙ исходник и НЕ трогает раздачу. Дальше происходило одно и то
 *      же — сторож свежести сборки честно краснел на сведённом дереве, посадка называла это
 *      «тесты красные» и откатывала слияние. Ни одна правка окна не могла войти дверью
 *      приёмки: 02.09.2026 в очереди стояло шесть таких строк подряд. Поэтому посадка сперва
 *      спрашивает git, тронуто ли `spa/` этим слиянием, и если тронуто — зовёт ту же команду
 *      сборки, которую человек набирает руками. Время сборки едет в квитанцию; отказ сборки —
 *      СВОЙ отказ со своими словами, а не оттенок красного прогона (чинят его в другом месте:
 *      сломанный бандлер — это не упавший тест).
 *
 *      …И ПЕРЕСБОРКА ОБРАТИМА, ПОТОМУ ЧТО ВЕРДИКТ ПО ВЕТКЕ ЕЩЁ НЕ ВЫНЕСЕН. Раздача гитом не
 *      отслеживается, а значит `merge --abort` её не касается: собранное окно ОТКАЗАННОЙ ветки
 *      оставалось на диске и раздавалось человеку как вершина — молча, потому что по всем
 *      линейкам свежести оно новее исходника. Поэтому прежняя раздача откладывается копией
 *      рядом ДО сборки, `restoreWindow` возвращает её на любом отказе ритуала, а штамп
 *      состоявшейся посадки копию убирает. Упавшая сборка возвращает прежнее окно сама и
 *      немедленно: «сборка не прошла» не имеет права означать «и окна больше нет».
 *
 *   3. `refreshBundleMark` — МЕТКА СВЕЖЕСТИ РАЗДАЧИ, и она ставится ПОСЛЕ штампа, ровно там,
 *      где вся фиксация уже позади. Причина — в порядке шагов, а не в бандлере: окно
 *      собирается ДО прогона, а коммит слияния, несущий `spa/src`, рождается ПОСЛЕ зелёного
 *      прогона, минутами позже. Сторож свежести меряет возраст исходника чистого дерева
 *      временем последнего коммита — и раздача, собранная из этого самого дерева, выходит
 *      «старше» своего исходника на эти минуты. Краснело это не на той посадке, что собирала,
 *      а на СЛЕДУЮЩЕЙ, которая окна не трогала и пересобирать его не собиралась: три ночные
 *      посадки подряд получили «тесты красные» за чужой шов, и раздачу пересобирали руками из
 *      терминала. Поэтому посадка, СОБРАВШАЯ окно, после фиксации переставляет время файлов
 *      раздачи — ни байта содержимого, только метка, и только у того, кто эту раздачу собрал.
 *      Линейка при этом одна на обе стороны (`spa-freshness.mjs`): мерить обещание чем-то
 *      своим значило бы разойтись со сторожем молча.
 *
 *      МЕТИТСЯ ПОДМЕНЁННАЯ РАЗДАЧА, А НЕ ОТЛОЖЕННАЯ КОПИЯ, — и метится ТОЛЬКО она. Метка
 *      говорит «этот бандл собран из этого дерева», и потому её ставит лишь та посадка, что
 *      действительно собрала окно И вошла в вершину. Возвращённая прежняя раздача обещания не
 *      несёт: она собрана из ДРУГОГО дерева, и пометить её значило бы соврать сторожу ровно
 *      тем, чем он живёт.
 *
 * ПОЧЕМУ ПРОГОН ЖИВЁТ ВНУТРИ РИТУАЛА, А НЕ ПОСЛЕ НЕГО. Ритуал слияния устроен так, что тесты
 * идут по сведённому дереву ДО фиксации: красный прогон означает «ветка не вошла», а не
 * «вошла, и теперь вершина красная». Полный набор, запущенный после фиксации, отдал бы ровно
 * то, ради чего этот порядок и заведён.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: `git push`. Посадка целиком локальна — как и слияние, которому
 * она служит (закон шапки slots.mjs, не тронут).
 *
 * МАРКЕР ВЕРСИИ (`sma-core/VERSION`) ШТАМПОМ НЕ ДВИГАЕТСЯ. Дозапись чисел переписывает его
 * всякий раз, когда в дереве он лежит с чужим концом строки, — а сторож чисел сравнивает
 * ОБРЕЗАННОЕ значение и такой разницы не видит вовсе. Косметическую правку штамп возвращает
 * назад (её и убирали руками пятой командой ритуала); настоящую смену версии — оставляет и
 * называет, потому что это выпуск, а не замер.
 *
 * Только встроенное в Node; git, прогонятель и файловый ввод-вывод — швы, чтобы прогон мог
 * проверить оба пути, не заводя настоящего набора тестов.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ГАШЕНИЕ ДЕРЕВА ПРОЦЕССОВ — ОТТУДА, ГДЕ ОНО УЖЕ ИЗМЕРЕНО И ОПИСАНО. Сборка окна на Windows
// идёт через оболочку, и потолок, убивающий одного ребёнка, оставляет внука-сборщика жить с
// мёртвым родителем; это ровно тот случай, ради которого `killProcessTree` и написан.
import { killProcessTree } from '../../../daemon/src/runner/spawn.mjs'
import {
  applyBadge,
  BADGE_READMES,
  buildReceipt,
  checkBadge,
  parseVitestJson,
  readChangedSince,
  readHead,
  RECEIPT_FILE,
} from './badge.mjs'
import { audit, receiptDriftFiles, writeNumbers } from './doc-audit.mjs'
import { maskSecrets } from './history-search.mjs'
import { CAPTURE_CAP_BYTES, outputTail, resolveSuiteEntry, summarizeRedRun } from './merge-smoke.mjs'
import { DIST_NOTHING_KEPT_NOTE, dropKept, keepDist, restoreDist } from './spa-dist.mjs'
import { refreshBundleMark } from './spa-freshness.mjs'

/** Карта замера — производное место, которое штамп пересобирает вместе со значком. */
export const GRAPH_FILE = 'docs/master-graph.html'

/** Маркер установки. Дозапись чисел его трогает; штамп — нет (см. шапку). */
export const VERSION_MARKER = 'sma-core/VERSION'

/**
 * ЧТО ИМЕННО ВХОДИТ В КОММИТ ШТАМПА — список, а не `git add -A`. Посадка идёт в дереве, где
 * рядом работают люди и лежит чужое незакоммиченное; штамп имеет право ровно на производные
 * места и ни на байт больше.
 */
export const STAMP_PATHS = Object.freeze([RECEIPT_FILE, ...BADGE_READMES, GRAPH_FILE])

/** Признак того, что в дереве вообще есть полный набор, который можно прогнать. */
export const SUITE_CONFIG_FILES = Object.freeze(['vitest.config.mjs', 'vitest.config.js', 'vitest.config.ts'])

/**
 * Потолок полного прогона. Набор этого дерева идёт минутами; час — это порядок величины
 * запаса, за которым «прогон идёт» уже неотличимо от «прогон завис».
 */
export const FULL_SUITE_TIMEOUT_MS = 60 * 60 * 1000

/**
 * ПОСАДОЧНЫЙ ПРОГОН БЕРЁТ МАШИНУ ЦЕЛИКОМ — и это не исключение из правила, а само правило.
 *
 * Конфиг набора держит один прогон в трети потоков машины: работников во флоте несколько,
 * и три прогона обязаны умещаться рядом. Посадка — другой случай, единственный: дверь
 * приёмки меряет сведённое дерево ОДИН раз, никакого соседнего прогона в этот момент нет, а
 * потолок в треть всё равно растягивал её втрое. Поэтому дочернему сьютеру называется «вся
 * машина» — переменной окружения, которую конфиг набора и читает.
 *
 * Имя переменной повторено здесь строкой, а не подтянуто импортом из `vitest.config.mjs`
 * НАМЕРЕННО: этот файл живёт в боевой установке, где сьютера может не быть вовсе, и импорт
 * его конфига уронил бы посадку на отсутствующей зависимости. Что обе стороны говорят об
 * одном и том же имени, держит провод-тест, а не надежда.
 */
export const SUITE_WORKERS_ENV = 'SMA_TEST_WORKERS'
export const SUITE_WORKERS_LANDING = 'max'

/** Прогона не было — и вот почему. Каждая причина своими словами, ни одна не выдана за отказ. */
export const RECEIPT_COVERS_NOTE =
  'квитанция работника снята ровно на этом дереве — полный набор не гонялся второй раз'
export const NO_SUITE_NOTE = 'в этом дереве нет полного набора — прогонять было нечего'
export const NO_SUITE_RUNNER_NOTE = 'сьютер не нашёлся рядом с этой установкой — полного прогона не было'
export const TIMED_OUT_NOTE = `полный прогон не уложился в ${Math.round(FULL_SUITE_TIMEOUT_MS / 60000)} мин — прогона не было`


/**
 * ГДЕ ЛЕЖИТ ОТЧЁТ ОТКАЗАННОЙ ПОСАДКИ — каталог внутри дома данных демона.
 *
 * Отчёт зелёного прогона живёт ровно до штампа: числа из него переписаны в квитанцию, и
 * временный файл убирается той же рукой. У КРАСНОГО прогона такого читателя нет вовсе —
 * слияние откатывается, штамп не зовётся, — а вопрос «что именно упало» задаётся ровно
 * тогда. Замерено 02.09.2026 первой ночной приёмкой: дверь вернула «тесты красные», отчёт
 * лежал во временном каталоге под именем с номером процесса, и смотреть после отказа было
 * НЕГДЕ. Поэтому красный прогон оставляет свой отчёт и хвост вывода в доме данных демона —
 * там же, где живут журналы и реестры, то есть переживает и процесс, и уборку копии.
 */
export const LANDING_REPORTS_DIRNAME = 'landing'

/** Сколько имён упавших тестов едет в отказ: отказ читают глазами, а не грепом. */
export const FAILED_TESTS_SHOWN = 5

/** Пределы одной строки отказа — те же по смыслу, что у дымового прогонятеля. */
const NAME_CAP = 200
const LINE_CAP = 200
const DETAIL_LINES = 3

/** Отчёта сохранить не удалось — и это сказано, а не выдано за «отчёта не было». */
export const NO_KEEP_DIR_NOTE = 'дом данных демона не назван — отчёт красного прогона сохранять некуда'

/** Первая непустая строка чужого сообщения, обрезанная до читаемой длины. */
function firstLine(text) {
  const said = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s !== '')
  return said ? said.slice(0, LINE_CAP) : null
}

/**
 * summarizeVitestReport(text) → `{failedTest, failedTests, failedCount, failureDetail}` — ЧТО
 * ИМЕННО УПАЛО, прочитанное из ОТЧЁТА сьютера, а не из его печати на экране.
 *
 * ПОЧЕМУ НЕ ХВАТАЕТ РАЗБОРА ВЫВОДА. Полный прогон идёт с отчётом в файл, и печатать при этом
 * ему почти нечего: разбор экранного вывода (`summarizeRedRun`) находит там пусто и честно
 * отвечает «имени не назвали». Имена в этом прогоне живут ТОЛЬКО в отчёте — по файлу, по
 * набору и по тесту, — и берутся они отсюда.
 *
 * ЗАКОН ТОТ ЖЕ: НИЧЕГО НЕ ВЫДУМЫВАТЬ. Отчёт, который не разобрался, отдаёт пустой список.
 * Файл, упавший на сборке и не доехавший ни до одного утверждения, назван САМИМ ФАЙЛОМ —
 * это правда о нём, а имя теста там не существует.
 *
 * СКОЛЬКО УПАЛО — ОТДЕЛЬНОЕ ЧИСЛО, А НЕ ДЛИНА ПОКАЗАННОГО СПИСКА. Список режется до
 * `FAILED_TESTS_SHOWN` — отказ читают глазами, — и до этой строки резался ВНУТРИ, ничего не
 * оставляя от общего числа: сорок красных тестов приезжали к человеку как «упало 5», а фраза
 * «… ещё N» не могла показаться ни разу, потому что вычиталась из уже обрезанного списка.
 * Поэтому здесь два ответа: `failedTests` — те, кого назовут по имени, `failedCount` — сколько
 * их всего. Число берётся у самого отчёта (`numFailedTests`), когда он насчитал БОЛЬШЕ, чем
 * собралось имён: имён меньше, если какой-то файл не расписал свои утверждения, — и число,
 * меньшее показанного списка, было бы враньём в другую сторону.
 *
 * @param {string} text — содержимое отчёта сьютера
 * @returns {{failedTest: (string|null), failedTests: string[], failedCount: number,
 *   failureDetail: (string|null)}}
 */
export function summarizeVitestReport(text) {
  const empty = { failedTest: null, failedTests: [], failedCount: 0, failureDetail: null }
  let report = null
  try {
    report = JSON.parse(String(text ?? ''))
  } catch {
    return empty
  }
  const perFile = Array.isArray(report && report.testResults) ? report.testResults : []
  const names = []
  const details = []
  for (const file of perFile) {
    if (!file || typeof file !== 'object' || file.status === 'passed') continue
    const where = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : '(файл не назван)'
    const cases = (Array.isArray(file.assertionResults) ? file.assertionResults : []).filter(
      (a) => a && a.status === 'failed',
    )
    if (cases.length === 0) {
      // Файл, не доехавший до утверждений: падение есть, теста нет — и назван файл.
      names.push(where.slice(0, NAME_CAP))
      const said = firstLine(file.message)
      if (said) details.push(`${where}: ${said}`.slice(0, LINE_CAP))
      continue
    }
    for (const one of cases) {
      const title =
        (typeof one.fullName === 'string' && one.fullName.trim()) ||
        (typeof one.title === 'string' && one.title.trim()) ||
        ''
      names.push((title ? `${where} > ${title}` : where).slice(0, NAME_CAP))
      const said = firstLine(Array.isArray(one.failureMessages) ? one.failureMessages[0] : one.failureMessages)
      if (said) details.push(said)
    }
  }
  if (names.length === 0) return empty
  const counted = Number(report && report.numFailedTests)
  return {
    failedTest: names[0],
    failedTests: names.slice(0, FAILED_TESTS_SHOWN),
    failedCount: Number.isFinite(counted) && counted > names.length ? counted : names.length,
    failureDetail: details.length ? details.slice(0, DETAIL_LINES).join('\n') : null,
  }
}

/** Имя файла отчёта не имеет права быть путём: чужая строка становится одним отрезком имени. */
function safeLabel(label) {
  const said = String(label ?? '').trim()
  const cleaned = said.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned ? cleaned.slice(0, 80) : 'landing'
}

/**
 * СКОЛЬКО СОХРАНЁННЫХ ПРОГОНОВ ЖИВЁТ В ЭТОМ КАТАЛОГЕ. Каждая красная посадка кладёт сюда два
 * файла, и `.log` — это весь пойманный вывод набора, до потолка захвата. Каталог, в который
 * только пишут, растёт ровно столько, сколько живёт машина: за неделю ночных приёмок это
 * сотни файлов и десятки мегабайт, и ни один из них после первого разбора никому не нужен.
 * Двадцать — это глубина, на которую человек реально возвращается («последние отказы»), а не
 * архив: старше двадцатого прогона вопрос задают ветке и коммиту, а не хвосту вывода.
 */
export const LANDING_REPORTS_KEEP = 20

/**
 * Чем сохранённый прогон отличается от чужого файла в том же каталоге — концом имени, который
 * поставила `keepRedRun`: минута в ISO с заменёнными двоеточиями. Уборка ходит ТОЛЬКО по этому
 * признаку, поэтому положенное сюда кем-то другим она не трогает вовсе, а не «не должна».
 */
const KEPT_RUN_STAMP_RE = /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/

/**
 * pruneKeptRuns({keepDir, keep}) → `{removed}` — УБОРКА, которая идёт РЯДОМ С ЗАПИСЬЮ.
 *
 * Отдельного часового у этого каталога нет и не заводится: единственный, кто знает, что в нём
 * прибавилось, — тот, кто только что положил файл. Порядок берётся из ИМЕНИ, а не из времени
 * файла: имя несёт минуту прогона, а время файла на копии, приехавшей с другой машины, значит
 * что угодно. Пара файлов одного прогона уходит целиком — отчёт без своего хвоста вывода
 * отвечает на половину вопроса.
 *
 * FAIL-OPEN во всём: каталога нет, файл не удалился — уборка молчит и возвращает то, что
 * успела. Посадка, упавшая на подметании, была бы хуже полного каталога.
 */
export function pruneKeptRuns({ keepDir, keep = LANDING_REPORTS_KEEP } = {}) {
  const removed = []
  if (!keepDir) return { removed }
  let names
  try {
    names = readdirSync(keepDir)
  } catch {
    return { removed } // каталога ещё нет — убирать нечего
  }
  const bases = new Set()
  for (const name of names) {
    const base = name.endsWith('.json') ? name.slice(0, -5) : name.endsWith('.log') ? name.slice(0, -4) : null
    if (base && KEPT_RUN_STAMP_RE.test(base)) bases.add(base)
  }
  const ordered = [...bases].sort((a, b) => {
    const at = a.match(KEPT_RUN_STAMP_RE)[1]
    const bt = b.match(KEPT_RUN_STAMP_RE)[1]
    return at === bt ? a.localeCompare(b) : at < bt ? -1 : 1
  })
  const limit = Number.isFinite(keep) && keep >= 0 ? keep : LANDING_REPORTS_KEEP
  for (const base of ordered.slice(0, Math.max(0, ordered.length - limit))) {
    for (const ext of ['.json', '.log']) {
      try {
        unlinkSync(join(keepDir, `${base}${ext}`))
        removed.push(`${base}${ext}`)
      } catch {
        /* файла этой пары нет или он занят — уборка не обязана быть полной */
      }
    }
  }
  return { removed }
}

/**
 * keepRedRun({keepDir, label, reportText, output, clock, keep}) → `{savedReport, savedLog}` либо
 * `{keepNote}` — ОТЧЁТ КРАСНОГО ПРОГОНА, ПОЛОЖЕННЫЙ ТУДА, ГДЕ ЕГО МОЖНО ОТКРЫТЬ ПОТОМ.
 *
 * Два файла, а не один: отчёт сьютера (`.json`) отвечает на «какие тесты упали и с чем», хвост
 * обоих потоков (`.log`) — на «а что вообще происходило», и он единственный говорит хоть
 * что-то, когда сьютер умер, не написав отчёта. Имя строится из названного ярлыка и минуты:
 * два отказа одной строки — два разных файла, и ни один не затирает другого.
 *
 * ХВОСТ ВЫВОДА ЛОЖИТСЯ ПРОСЕЯННЫМ. `.log` — это весь пойманный stdout и stderr набора, то
 * есть всё, что печатали тесты, включая окружение, которое они печатали не подумав. Файл после
 * этого лежит месяцами в доме данных, открывается глазами и уезжает в чужие руки вместе с
 * разбором отказа — поэтому он проходит тот же экран учётных данных (`maskSecrets`), которым
 * продукт просеивает выдачу поиска по истории. Один экран на обе двери: заводить здесь свой
 * значило бы разойтись с ним молча в первый же день.
 *
 * ОТЧЁТ СЬЮТЕРА (`.json`) КЛАДЁТСЯ БАЙТ В БАЙТ. Экран работает по непробельным отрезкам, а в
 * JSON такой отрезок несёт на себе кавычки и запятую — просеивание съело бы их вместе с
 * находкой и оставило файл, который не разберёт ни один читатель. Обещание здесь ровно такое:
 * просеян ВЫВОД, а машинный отчёт остаётся тем, что написал сьютер.
 *
 * FAIL-OPEN: не записалось — сказано словами. Посадка, упавшая на попытке сохранить объяснение
 * отказа, превратила бы честный красный в поломку. Записалась половина — названа и она, и
 * причина: путь к отчёту стоит дороже, чем ровность ответа.
 */
export function keepRedRun({ keepDir, label, reportText, output, clock, keep } = {}) {
  if (!keepDir) return { keepNote: NO_KEEP_DIR_NOTE }
  const at = new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString().replace(/[:.]/g, '-')
  const base = join(keepDir, `${safeLabel(label)}-${at}`)
  const kept = {}
  try {
    mkdirSync(keepDir, { recursive: true })
    if (typeof reportText === 'string' && reportText.trim()) {
      const path = `${base}.json`
      writeFileSync(path, reportText, 'utf8')
      kept.savedReport = path
    }
    const logPath = `${base}.log`
    writeFileSync(logPath, maskSecrets(String(output ?? '')), 'utf8')
    kept.savedLog = logPath
  } catch (err) {
    return { ...kept, keepNote: `отчёт красного прогона не сохранён (${String((err && err.message) || err)})` }
  }
  // УБОРКА — ПОСЛЕ ЗАПИСИ И НИКОГДА ВМЕСТО НЕЁ: только что положенный прогон уже в каталоге и
  // считается двадцатым, а не выброшенным вместе со старыми.
  pruneKeptRuns({ keepDir, keep })
  return kept
}

// ── ПЕРЕСБОРКА ОКНА: слияние принесло исходник, раздача осталась вчерашней ───────────────

/** Исходник окна. Тронут этим слиянием — значит раздаваемый бандл устарел в тот же миг. */
export const SPA_SOURCE_PREFIX = 'spa/'

/** Команда сборки окна — ТА ЖЕ, которую человек набирает руками, и названа она один раз. */
export const SPA_BUILD_SCRIPT = 'build:spa'

/**
 * Потолок сборки. Измерено на этой машине: окно собирается за ~2 с. Десять минут — порядок
 * величины запаса, за которым «сборка идёт» уже неотличимо от «сборка зависла».
 *
 * ЧИСЛО ЗДЕСЬ — ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ, А НЕ ЗАКОН. Машина слабее этой, холодный кеш сборщика
 * или ветка, впервые тянущая новый пакет, двигают «~2 с» на порядок, и потолок, который нельзя
 * назвать снаружи, превращается в отказ посадки, не имеющий отношения ни к ветке, ни к коду.
 */
export const SPA_BUILD_TIMEOUT_MS = 10 * 60 * 1000

/** …и вот чем его называют снаружи. Мусор в переменной читается как «не названо». */
export const SPA_BUILD_TIMEOUT_ENV = 'SMA_SPA_BUILD_TIMEOUT_MS'

/**
 * Сколько вывода сборки держится в памяти. Раньше здесь стоял потолок буфера синхронного
 * запуска (4 МБ), и переполнить его умеет всякая многословная сборка: запуск падал с ENOBUFS,
 * а посадка читала это как «сборка не прошла» — окно объявлялось несобираемым за то, что
 * сборщик слишком много говорил. Теперь вывод течёт мимо, а в памяти живёт КАТЯЩИЙСЯ ХВОСТ:
 * причина сборки стоит в последних строках, и никакая длина вывода больше ничего не решает.
 */
export const SPA_OUTPUT_TAIL_BYTES = 256 * 1024

/** Потолок сборки достигнут — прогона не было, и это НЕ «сборка упала». */
export const SPA_TIMED_OUT_NOTE = 'сборка окна не уложилась в потолок времени — её дерево процессов погашено'

/**
 * spaBuildTimeoutMs(env) — потолок сборки для ЭТОГО запуска: названный снаружи или общий.
 * Ноль и отрицательное — это не «без потолка», а мусор: такой потолок отказал бы посадке
 * мгновенно и молча.
 */
export function spaBuildTimeoutMs(env = process.env) {
  const said = Number((env && env[SPA_BUILD_TIMEOUT_ENV]) ?? NaN)
  return Number.isFinite(said) && said > 0 ? said : SPA_BUILD_TIMEOUT_MS
}

/** Сборки не было — и вот почему. Каждая причина своими словами, ни одна не выдана за отказ. */
export const SPA_UNTOUCHED_NOTE = 'окно этим слиянием не тронуто — пересобирать было нечего'
export const SPA_NO_SCRIPT_NOTE = `в этом дереве нет команды ${SPA_BUILD_SCRIPT} — окно собирать нечем`
/** …и одна оговорка: git смолчал, а молчание читается как «может быть», то есть собираем. */
export const SPA_DIFF_UNKNOWN_NOTE = 'git не сказал, тронуто ли окно — собрали на всякий случай'

/**
 * spaTouched({cwd, execGit, mergedTree}) → `{asked, touched, files}` — ПРИНЕСЛО ЛИ СЛИЯНИЕ
 * ПРАВКУ ОКНА. Спрашивается тот же diff, которым посадка сверяет квитанцию: `HEAD` — это
 * вершина ДО слияния (коммита слияния ещё не существует), `mergedTree` — дерево, которое
 * станет деревом этого коммита. Разница между ними и есть «что принесла ветка».
 *
 * FAIL-CLOSED, как и у сверки квитанции: git смолчал — считаем, что тронуло. Лишняя сборка
 * стоит секунды; пропущенная раздаёт человеку окно прошлой недели и краснеет гейтом свежести.
 */
export function spaTouched({ cwd, execGit, mergedTree } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  const args = mergedTree ? ['diff', '--name-only', 'HEAD', String(mergedTree)] : ['diff', '--name-only', 'HEAD']
  try {
    const files = String(git(args, { cwd }) || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => path.startsWith(SPA_SOURCE_PREFIX))
    return { asked: true, touched: files.length > 0, files }
  } catch {
    return { asked: false, touched: true, files: [] }
  }
}

/**
 * hasSpaBuildScript({cwd, readFile}) — умеет ли ЭТО дерево собирать окно. Установленная копия
 * и одноразовый репозиторий окна не собирают вовсе, и требовать с них сборку значило бы
 * отказывать в слиянии за то, чего в дереве никогда не было.
 */
export function hasSpaBuildScript({ cwd, readFile } = {}) {
  const read = typeof readFile === 'function' ? readFile : (p) => readFileSync(p, 'utf8')
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')))
    return typeof (pkg && pkg.scripts && pkg.scripts[SPA_BUILD_SCRIPT]) === 'string'
  } catch {
    return false
  }
}

/**
 * runSpaBuild({cwd, spawn, killTree, timeoutMs, platform}) → Promise к
 * `{built:true, ms}` | `{built:false, ms, exitCode, tail, timedOut?}`.
 *
 * ПОЧЕМУ ЗДЕСЬ ИМЯ КОМАНДЫ, А НЕ ПУТЬ К ДВОИЧНОМУ ФАЙЛУ. Прогонятель тестов запускается через
 * `process.execPath` именно потому, что имя пакетного менеджера на Windows — это `.cmd`,
 * которого не видит запуск без оболочки. Сборка окна — не тест: она обязана пройти РОВНО ТУ
 * ЖЕ командой, которую человек набирает руками и которая записана в `package.json` дерева, —
 * иначе дверь собирала бы окно не тем, чем его собирают. Поэтому имя платформенное и оболочка
 * на Windows включена, как это уже сделано у проверяющего значка (badge.mjs). Подстановки в
 * команде нет: оба слова — литералы этого файла, а дерево едет отдельным полем `cwd`.
 *
 * ПОЧЕМУ НА WINDOWS КОМАНДА ЕДЕТ ОДНОЙ СТРОКОЙ, А НЕ МАССИВОМ. Оболочка там обязательна, а
 * массив аргументов РЯДОМ С ОБОЛОЧКОЙ Node объявил устаревшим: он их не экранирует, а только
 * склеивает, и каждый вызов печатал бы предупреждение в журнал демона — шум, который однажды
 * станет поломкой. Склеиваем сами, и склеивать нечего: оба слова — литералы этого файла,
 * дерево едет отдельным полем `cwd`, и ни одна чужая строка в команду не попадает.
 *
 * ═══ И ИМЕННО ПОЭТОМУ ПОТОЛОК ГАСИТ ДЕРЕВО, А НЕ РЕБЁНКА ═══════════════════════════════
 *
 * Оболочка — это ОТДЕЛЬНЫЙ процесс, а сборщик — её внук. Синхронный запуск с полем `timeout`
 * бил сигналом ровно по оболочке: она умирала, посадка получала «сборка не уложилась», а
 * сборщик продолжал молоть — с мёртвым родителем, в дереве, где уже идёт откат слияния.
 * «Умерла для учёта, жива для машины». Приказ дереву отдаётся ДО того, как кто-нибудь трогает
 * самого ребёнка: записи о родителе живут ровно пока родитель жив, и убитый первым родитель
 * оставляет внука сиротой, которого больше не с чего найти.
 *
 * ВЫВОД ТЕЧЁТ, А НЕ КОПИТСЯ. Синхронный запуск держал весь вывод в буфере и падал на его
 * потолке (ENOBUFS) — то есть многословная сборка объявлялась НЕСОБИРАЕМОЙ. Здесь в памяти
 * живёт катящийся хвост фиксированного размера: причина стоит в последних строках, и длина
 * вывода больше не решает ничего.
 */
export function runSpaBuild(o = {}) {
  const cwd = o.cwd || process.cwd()
  const spawnImpl = typeof o.spawn === 'function' ? o.spawn : spawn
  const killTree = typeof o.killTree === 'function' ? o.killTree : killProcessTree
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : spaBuildTimeoutMs()
  const platform = o.platform || process.platform
  const startedAt = Date.now()
  const shell = platform === 'win32'
  const npm = shell ? 'npm.cmd' : 'npm'

  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(shell ? `${npm} run ${SPA_BUILD_SCRIPT}` : npm, shell ? [] : ['run', SPA_BUILD_SCRIPT], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell,
      })
    } catch (err) {
      resolve({ built: false, ms: Date.now() - startedAt, exitCode: null, tail: outputTail(String((err && err.message) || err)) })
      return
    }

    // КАТЯЩИЙСЯ ХВОСТ: держим ПОСЛЕДНИЕ байты обоих потоков, а не первые. У сборки причина
    // стоит в конце, и «первые 4 МБ» — это ровно те строки, которые никому не нужны.
    let said = ''
    const keep = (chunk) => {
      said += String(chunk)
      if (said.length > SPA_OUTPUT_TAIL_BYTES) said = said.slice(said.length - SPA_OUTPUT_TAIL_BYTES)
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream || typeof stream.on !== 'function') continue
      if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8')
      stream.on('data', keep)
    }

    let deadline = false
    const timer = setTimeout(() => {
      deadline = true
      // ДЕРЕВО ПЕРВЫМ, ребёнок — запасным путём: см. шапку выше.
      let ordered = false
      try {
        ordered = killTree({ pid: child.pid, platform }) === true
      } catch {
        ordered = false
      }
      if (!ordered) {
        try {
          child.kill()
        } catch {
          /* ребёнок опередил потолок — обработчик выхода уже сказал своё */
        }
      }
    }, timeoutMs)

    let settled = false
    const answer = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    child.on('error', (err) => {
      answer({
        built: false,
        ms: Date.now() - startedAt,
        exitCode: null,
        tail: outputTail(`${said}\n${(err && err.message) || err}`),
      })
    })
    child.on('exit', (code, signal) => {
      const ms = Date.now() - startedAt
      if (deadline) {
        return answer({ built: false, ms, exitCode: null, timedOut: true, tail: outputTail(`${said}\n${SPA_TIMED_OUT_NOTE}`) })
      }
      if (code === 0) return answer({ built: true, ms })
      answer({
        built: false,
        ms,
        exitCode: Number.isFinite(code) ? code : null,
        ...(signal ? { signal: String(signal) } : {}),
        tail: outputTail(said),
      })
    })
  })
}

/** Настоящий git: execFileSync с МАССИВОМ аргументов (никакой подстановки через оболочку). */
export function defaultExecGit(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' })
}

/** Файловый ввод-вывод посадки одним объектом — шов для прогона, значение по умолчанию для жизни. */
function defaultIo() {
  return {
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, data) => writeFileSync(p, data, 'utf8'),
    remove: (p) => rmSync(p, { force: true }),
  }
}

/**
 * mergedTreeSha({cwd, execGit}) → хеш дерева, которое получится из НЕЗАФИКСИРОВАННОГО слияния,
 * или null. `write-tree` спрашивает индекс — то есть ровно то, что станет деревом коммита, — и
 * потому отвечает и до фиксации. Молчание git читается как «не знаем», а не как «дерево другое».
 */
export function mergedTreeSha({ cwd, execGit } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  try {
    const sha = String(git(['write-tree'], { cwd })).trim()
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * receiptCoversTree({cwd, execGit, mergedTree, readFile}) → `{covers, reason, receipt}` —
 * ЧЕСТНА ЛИ КВИТАНЦИЯ ДЛЯ ЭТОГО ДЕРЕВА.
 *
 * Три условия, и все три обязательны:
 *   - квитанция есть и несёт числа;
 *   - она снята на ЧИСТОМ дереве (`dirty` — это «измерено то, чего никто не может назвать»);
 *   - между коммитом, который она называет, и сведённым деревом не двинулось НИ ОДНОГО файла
 *     кода или тестов.
 *
 * ПОЧЕМУ ТРЕТЬЕ УСЛОВИЕ — НЕ «ХЕШИ ДЕРЕВЬЕВ СОВПАЛИ». Так и было написано сначала, и так оно
 * не работает НИ РАЗУ: работник меряет на чистой вершине C1, а потом штампует числа — и
 * вершиной ветки становится C2, чьё дерево уже другое. Требование побайтового совпадения
 * отправляло бы набор на второй прогон всегда, то есть отменяло бы саму цель.
 *
 * Спрашивается ровно то, что спрашивает сторож значка: `git diff` между коммитом квитанции и
 * сведённым деревом, пропущенный через `receiptDriftFiles` — ОДНО определение сноса на весь
 * продукт. Пусто — код и тесты те же самые, второй прогон измерил бы то же самое. Не пусто —
 * вершина двигалась по существу, и числа надо мерить заново.
 *
 * FAIL-CLOSED: любой неотвеченный вопрос — это `covers:false`, то есть лишний прогон. Ошибка в
 * эту сторону стоит десять минут; ошибка в другую публикует число, которого никто не мерил.
 */
export function receiptCoversTree({ cwd, execGit, mergedTree, readFile } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  const read = typeof readFile === 'function' ? readFile : (p) => readFileSync(p, 'utf8')
  if (!mergedTree) {
    return { covers: false, reason: 'хеш сведённого дерева не назван — сверять не с чем', receipt: null }
  }
  let receipt = null
  try {
    receipt = JSON.parse(read(join(cwd, RECEIPT_FILE)))
  } catch {
    return { covers: false, reason: `${RECEIPT_FILE} в сведённом дереве не прочитан — мерить придётся заново`, receipt: null }
  }
  if (!receipt || !Number.isFinite(Number(receipt.tests)) || !Number.isFinite(Number(receipt.files))) {
    return { covers: false, reason: `${RECEIPT_FILE} не несёт измеренных чисел`, receipt: null }
  }
  if (receipt.dirty === true) {
    return { covers: false, reason: 'квитанция снята на грязном дереве — назвать измеренное нечем', receipt }
  }
  const commit = typeof receipt.commit === 'string' ? receipt.commit.trim() : ''
  if (!commit) {
    return { covers: false, reason: 'квитанция не называет коммита — сверить дерево не с чем', receipt }
  }
  let changed = null
  try {
    changed = String(git(['diff', '--name-only', commit, mergedTree], { cwd }) || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return { covers: false, reason: `коммита квитанции (${commit.slice(0, 8)}) в этом дереве нет`, receipt }
  }
  const drift = receiptDriftFiles(changed)
  if (drift.length > 0) {
    const rest = drift.length > 1 ? ` и ещё ${drift.length - 1}` : ''
    return {
      covers: false,
      reason:
        `с коммита квитанции (${commit.slice(0, 8)}) до сведённого дерева (${String(mergedTree).slice(0, 8)}) ` +
        `двинулось ${drift.length} файл(ов) кода или тестов (${drift[0]}${rest}) — числа надо мерить заново`,
      receipt,
    }
  }
  return { covers: true, reason: null, receipt }
}

/** hasFullSuite({cwd, exists}) — лежит ли в дереве настройка набора, то есть есть ли что гонять. */
export function hasFullSuite({ cwd, exists } = {}) {
  const has = typeof exists === 'function' ? exists : existsSync
  return SUITE_CONFIG_FILES.some((name) => has(join(cwd, name)))
}

/**
 * runFullSuiteAsync({cwd, reportPath, ...}) → тот же трёхзначный ответ, что и у дымового
 * прогонятеля: `{passed:true|false, ran:true}` — приговор, `{passed:null, ran:false, note}` —
 * прогона не было. Отличий от дыма ровно два, и оба по делу:
 *
 *   - гонится ВЕСЬ набор, а не один файл: посадка обязана измерить дерево целиком, иначе
 *     штамповать нечем;
 *   - прогон пишет ОТЧЁТ в формате сьютера, и путь к нему едет в ответе — из этого отчёта
 *     штамп берёт числа, ни одного из них не выдумывая.
 *
 * ОТЧЁТ ПИШЕТСЯ ВО ВРЕМЕННЫЙ КАТАЛОГ, А НЕ В ДЕРЕВО. Прогон идёт в чужой копии; лишний файл,
 * оставленный в ней, — это грязь в чужом рабочем дереве и, в худшем случае, лишняя строка в
 * чужом коммите.
 *
 * …И ИМЕННО ПОЭТОМУ У КРАСНОГО ПРОГОНА ОТЧЁТ ЛОЖИТСЯ ВТОРОЙ РАЗ. Временный файл переживает
 * ровно зелёный случай: числа из него уезжают в квитанцию, и штамп его убирает. Красный
 * прогон откатывает слияние и штампа не зовёт — а вопрос «что упало» задаётся именно здесь.
 * `keepDir` (дом данных демона) получает отчёт и хвост обоих потоков, и путь к ним едет в
 * ответе, чтобы дойти до квитанции отказа.
 */
export function runFullSuiteAsync(o = {}) {
  const tree = o.cwd || process.cwd()
  const exists = o.exists || existsSync
  const resolveEntry = o.resolveEntry || resolveSuiteEntry
  const spawnImpl = o.spawn || spawn
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : FULL_SUITE_TIMEOUT_MS
  const reportPath = o.reportPath || join(tmpdir(), `sma-landing-${process.pid}-${Date.now()}.json`)
  const keepDir = typeof o.keepDir === 'string' && o.keepDir.trim() ? o.keepDir.trim() : null
  const readReport = typeof o.readFile === 'function' ? o.readFile : (p) => readFileSync(p, 'utf8')

  if (!hasFullSuite({ cwd: tree, exists })) {
    // `noSuite` — признак ДЛЯ ЧИТАТЕЛЯ, а не для глаз: посадка по нему зовёт запасного
    // прогонятеля, и разбирать ради этого текст записки было бы сверкой прозы.
    return Promise.resolve({ passed: null, ran: false, noSuite: true, note: NO_SUITE_NOTE })
  }
  let entry
  try {
    entry = resolveEntry()
  } catch {
    return Promise.resolve({ passed: null, ran: false, note: NO_SUITE_RUNNER_NOTE })
  }

  return new Promise((resolve) => {
    const child = spawnImpl(
      process.execPath,
      [entry, 'run', '--reporter=json', `--outputFile=${reportPath}`],
      {
        cwd: tree,
        // Вся машина — см. SUITE_WORKERS_ENV выше: посадочный прогон на машине один.
        // Названное снаружи сильнее: тот, кто уже поставил переменную, знает обстановку
        // лучше этого файла.
        env: { [SUITE_WORKERS_ENV]: SUITE_WORKERS_LANDING, ...(o.env || process.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let said = ''
    const keep = (chunk) => {
      if (said.length >= CAPTURE_CAP_BYTES) return
      said += String(chunk)
      if (said.length > CAPTURE_CAP_BYTES) said = said.slice(0, CAPTURE_CAP_BYTES)
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream || typeof stream.on !== 'function') continue
      if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8')
      stream.on('data', keep)
    }
    let deadline = false
    const timer = setTimeout(() => {
      deadline = true
      try {
        child.kill()
      } catch {
        /* ребёнок опередил потолок — обработчик выхода уже сказал своё */
      }
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ passed: null, ran: false, note: NO_SUITE_RUNNER_NOTE })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (deadline || (signal != null && code == null)) {
        return resolve({ passed: null, ran: false, note: TIMED_OUT_NOTE })
      }
      if (code === 0) return resolve({ passed: true, ran: true, reportPath })

      // КРАСНЫЙ ПРОГОН ОТВЕЧАЕТ ИМЕНАМИ, А НЕ ОТСЫЛКОЙ К ВЫВОДУ, КОТОРОГО НЕТ. Отчёт —
      // ПЕРВЫЙ источник и единственный полный: полный прогон печатает на экран почти
      // ничего (весь его отчёт уходит в файл), и разбор печати честно отвечал «имени не
      // назвали» на КАЖДОМ красном отказе посадки. Печать остаётся запасным источником —
      // сьютер, умерший до отчёта, говорит только ею.
      let reportText = null
      try {
        reportText = readReport(reportPath)
      } catch {
        reportText = null
      }
      const fromReport = summarizeVitestReport(reportText)
      const fromSaid = summarizeRedRun(said)
      const failedTest = fromReport.failedTest || fromSaid.failedTest
      const failureDetail = fromReport.failureDetail || fromSaid.failureDetail
      const kept = keepRedRun({ keepDir, label: o.label, reportText, output: said, clock: o.clock, keep: o.keep })
      resolve({
        passed: false,
        ran: true,
        exitCode: code,
        reportPath,
        ...(failedTest ? { failedTest } : {}),
        ...(failureDetail ? { failureDetail } : {}),
        ...(fromReport.failedTests.length ? { failedTests: fromReport.failedTests } : {}),
        // СКОЛЬКО ИХ ВСЕГО — рядом с показанными именами и отдельно от них: список режется до
        // пяти, число не режется никогда, иначе «упало 5» из сорока красных.
        ...(fromReport.failedCount ? { failedCount: fromReport.failedCount } : {}),
        ...kept,
      })
    })
  })
}

/**
 * versionMarkerIsCosmetic(before, after) — отличается ли переписанный маркер ТОЛЬКО концом
 * строки. Сторож чисел сравнивает обрезанное значение, поэтому такая правка ничего не чинит и
 * ничего не значит — она только тащит в коммит штампа файл, которому там не место.
 */
export function versionMarkerIsCosmetic(before, after) {
  if (before == null || after == null) return false
  return String(before).trim() === String(after).trim() && String(before) !== String(after)
}

/** Что git считает изменённым СРЕДИ названных путей. Пустой список — «штамповать нечего». */
function changedAmong({ cwd, execGit, paths }) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  try {
    const out = String(git(['status', '--porcelain', '--', ...paths], { cwd }) || '')
    return out
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function safeRead(read, path) {
  try {
    return read(path)
  } catch {
    return null
  }
}

/**
 * stampLanding({cwd, execGit, io, measurement, clock}) — ШТАМП: числа замера доводятся до всех
 * производных мест сведённой вершины и фиксируются ОДНИМ коммитом с явными путями.
 *
 * `measurement` — `{tests, files, startedAt}` от прогона, который ТОЛЬКО ЧТО состоялся; его
 * отсутствие означает «прогона не было, и числа уже лежат в квитанции этого дерева» (случай
 * честной квитанции работника). Третьего значения нет: выдумать числа посадке нечем.
 *
 * @returns {{stamped:boolean, committed:boolean, sha:(string|null), tests:(number|null),
 *   files:(number|null), wrote:string[], notes:string[], badgeViolations:(number|null),
 *   numbersViolations:(number|null), reason?:string}}
 */
export function stampLanding(o = {}) {
  const cwd = o.cwd
  const execGit = typeof o.execGit === 'function' ? o.execGit : defaultExecGit
  const io = o.io || defaultIo()
  const notes = []
  const wrote = []
  const empty = {
    stamped: false,
    committed: false,
    sha: null,
    tests: null,
    files: null,
    wrote,
    notes,
    badgeViolations: null,
    numbersViolations: null,
  }
  if (!cwd) return { ...empty, reason: 'дерево посадки не названо' }

  const head = readHead({ cwd })

  // ЧИСТО ЛИ ДЕРЕВО — СКАЗАНО ЗДЕСЬ, А НЕ ВЫВЕДЕНО ПОТОМ ИЗ ОТКАЗА СТОРОЖА. Квитанция
  // наследует этот признак у дерева (`dirty`), и сторож значка такую квитанцию отвергает: она
  // измерила в том числе то, чего нет ни в одном коммите. Причина при этом лежит вне посадки —
  // в чужой незакоммиченной правке или в мусоре рядом с деревом, — и человеку надо назвать её
  // словами, а не оставить его гадать над кодом отказа.
  if (head && head.dirty) {
    notes.push(
      'дерево посадки не чистое — в квитанции стоит признак «измерено на грязном дереве», и сторож значка её отвергнет; ' +
        'уберите незакоммиченное и лишнее из дерева, где идёт приёмка',
    )
  }

  // (1) ЧИСЛА. От прогона — переписываем квитанцию; без прогона — читаем ту, что уже лежит.
  let tests = null
  let files = null
  if (o.measurement) {
    const receipt = buildReceipt({ ...o.measurement, head })
    io.writeFile(join(cwd, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`)
    tests = receipt.tests
    files = receipt.files
  } else {
    let receipt = null
    try {
      receipt = JSON.parse(io.readFile(join(cwd, RECEIPT_FILE)))
    } catch {
      receipt = null
    }
    if (!receipt || !Number.isFinite(Number(receipt.tests)) || !Number.isFinite(Number(receipt.files))) {
      return { ...empty, reason: `в сведённом дереве нет измеренной квитанции — штамповать нечем (${RECEIPT_FILE})` }
    }
    tests = Number(receipt.tests)
    files = Number(receipt.files)
  }

  // (2) ЗНАЧОК В ОБОИХ README. Квитанция — источник, README — её проекции; переписываются
  //     всегда обе и только из числа, которое измерено.
  for (const name of BADGE_READMES) {
    const path = join(cwd, name)
    if (!io.exists(path)) continue
    const before = safeRead(io.readFile, path)
    if (before == null) continue
    const { text } = applyBadge(before, tests)
    if (text !== before) {
      io.writeFile(path, text)
      wrote.push(name)
    }
  }

  // (3) ЧИСЛА КАРТЫ — той же командой, что зовёт ритуал свода веток. Маркер версии, если его
  //     переписало ради конца строки, возвращается на место: см. шапку файла.
  const markerPath = join(cwd, ...VERSION_MARKER.split('/'))
  const markerBefore = safeRead(io.readFile, markerPath)
  const numbers = writeNumbers({ readFile: io.readFile, writeFile: io.writeFile, rootDir: cwd })
  for (const n of numbers.notes) notes.push(n)
  for (const w of numbers.written) {
    if (w !== VERSION_MARKER) wrote.push(w)
  }
  const stampPaths = [...STAMP_PATHS]
  if (numbers.written.includes(VERSION_MARKER)) {
    const markerAfter = safeRead(io.readFile, markerPath)
    if (versionMarkerIsCosmetic(markerBefore, markerAfter)) {
      io.writeFile(markerPath, markerBefore)
    } else {
      // Настоящая смена версии — это выпуск. Штамп её не выдумывал, но и бросать в дереве
      // незакоммиченной не имеет права: она едет в коммит и называется словами.
      stampPaths.push(VERSION_MARKER)
      wrote.push(VERSION_MARKER)
      notes.push(`${VERSION_MARKER} разошёлся с версией пакета — маркер обновлён вместе со штампом`)
    }
  }

  // (4) КОММИТ ЯВНЫМИ ПУТЯМИ. Ничего, кроме названного, в него попасть не может — в этом
  //     дереве рядом живут чужие незакоммиченные правки.
  const present = stampPaths.filter((rel) => io.exists(join(cwd, ...rel.split('/'))))
  const dirty = changedAmong({ cwd, execGit, paths: present })
  let sha = null
  let committed = false
  if (dirty.length > 0) {
    execGit(['add', '--', ...present], { cwd })
    // `--no-verify`: посадка идёт внутри демона, и хук, решивший прогнать здесь ещё один
    // набор, держал бы дверь открытой вторые десять минут.
    execGit(['commit', '-q', '--no-verify', '-m', stampMessage({ tests, files })], { cwd })
    committed = true
    try {
      sha = String(execGit(['rev-parse', 'HEAD'], { cwd })).trim() || null
    } catch {
      sha = null
    }
  } else {
    notes.push('числа уже сходились — коммит штампа не понадобился')
  }

  // (5) ПРОВЕРКА СОБСТВЕННОЙ РАБОТЫ, теми же сторожами, что краснеют у человека: значок против
  //     квитанции и числа документации против кода. Ответ едет наружу числом, а не молчанием.
  const verdict = verifyLanding({ cwd, io })
  return {
    stamped: true,
    committed,
    sha,
    tests,
    files,
    wrote,
    notes,
    badgeViolations: verdict.badgeViolations,
    numbersViolations: verdict.numbersViolations,
    ...(verdict.details.length ? { violations: verdict.details } : {}),
  }
}

/** Слова коммита штампа — те же, которыми его пишет человек в терминале. */
export function stampMessage({ tests, files } = {}) {
  return `docs: штамп значка и чисел графа на сведённой вершине — ${tests} тестов / ${files} файлов`
}

/**
 * verifyLanding({cwd, io}) → `{badgeViolations, numbersViolations, details}` — два сторожа,
 * которыми человек проверял вершину руками, заданные посадкой самой себе.
 */
export function verifyLanding({ cwd, io } = {}) {
  const files = io || defaultIo()
  const details = []
  let badgeViolations = null
  let numbersViolations = null
  try {
    const head = readHead({ cwd })
    let receiptCommit = null
    try {
      receiptCommit = JSON.parse(files.readFile(join(cwd, RECEIPT_FILE))).commit
    } catch {
      receiptCommit = null
    }
    const changedSince = readChangedSince({ cwd, commit: receiptCommit })
    const badge = checkBadge({ pkgRoot: cwd, head, changedSince })
    badgeViolations = badge.violations.length
    for (const v of badge.violations) details.push(`[${v.code}] ${v.detail}`)
  } catch (err) {
    details.push(`сторож значка не ответил: ${String((err && err.message) || err)}`)
  }
  try {
    const numbers = audit({ target: 'numbers', rootDir: cwd })
    numbersViolations = numbers.count
    for (const v of numbers.violations) details.push(`[${v.rule}] ${v.file}: ${v.detail ?? ''}`)
  } catch (err) {
    details.push(`сторож чисел не ответил: ${String((err && err.message) || err)}`)
  }
  return { badgeViolations, numbersViolations, details }
}

/**
 * createLanding({cwd, execGit, runSuite, fallbackRunner, io}) → `{runTests, stamp,
 * restoreWindow, state}` — ПОСАДКА ОДНОЙ КАРТОЧКИ, собранная так, что все её действия знают
 * об одном и том же прогоне и об одной и той же отложенной раздаче.
 *
 * ПОЧЕМУ ЭТО ФАБРИКА, А НЕ ДВЕ СВОБОДНЫЕ ФУНКЦИИ. Решение «гнать или не гнать» принимается
 * ВНУТРИ ритуала слияния (на сведённом, ещё не зафиксированном дереве), а штамп ставится ПОСЛЕ
 * него — и штампу нужно знать, что именно решил прогонятель и куда он положил отчёт. Общее
 * замыкание — это и есть та память; передавать её через ритуал значило бы учить ритуал полям,
 * которые его не касаются.
 *
 * `fallbackRunner` — прогонятель для дерева, у которого полного набора нет вовсе (чужая копия,
 * временный репозиторий). Дверь отдаёт сюда свой дымовой прогонятель: посадка не имеет права
 * превратить «здесь нечего гонять» в «здесь красное».
 *
 * `dataDir` — дом данных демона, и он здесь ровно ради красного прогона: отчёт отказанной
 * посадки ложится в `<dataDir>/landing/`. Без него посадка работает по-прежнему и говорит
 * словами, что сохранять отчёт было некуда, — молчания на этом месте быть не должно.
 */
export function createLanding(o = {}) {
  const execGit = typeof o.execGit === 'function' ? o.execGit : defaultExecGit
  const io = o.io || defaultIo()
  const runSuite = typeof o.runSuite === 'function' ? o.runSuite : runFullSuiteAsync
  const runBuild = typeof o.runBuild === 'function' ? o.runBuild : runSpaBuild
  const markBundle = typeof o.markBundle === 'function' ? o.markBundle : refreshBundleMark
  const fallbackRunner = typeof o.fallbackRunner === 'function' ? o.fallbackRunner : null
  const dataDir = typeof o.dataDir === 'string' && o.dataDir.trim() ? o.dataDir.trim() : null
  const keepDir =
    (typeof o.keepDir === 'string' && o.keepDir.trim() ? o.keepDir.trim() : null) ||
    (dataDir ? join(dataDir, LANDING_REPORTS_DIRNAME) : null)
  const state = {
    decided: null,
    reason: null,
    ran: false,
    reportPath: null,
    tree: null,
    spaBuild: null,
    /** Путь к отложенной прежней раздаче — живёт РОВНО до вердикта по ветке. */
    spaKept: null,
    spaRestored: null,
    cwd: o.cwd || null,
  }

  /**
   * ОКНО ПЕРЕСОБИРАЕТСЯ ЗДЕСЬ — между слиянием и прогоном, и ни на шаг позже. Прогон судит
   * дерево целиком, а в дереве после слияния лежит новый исходник окна и вчерашняя раздача:
   * гейт свежести краснеет, и посадка объявляет красным чужое — тесты. Сборка идёт и тогда,
   * когда прогон решат не гонять: вершине с устаревшей раздачей всё равно, гоняли по ней
   * набор или доверились квитанции, — человек в браузере увидит старое окно.
   *
   * ═══ ПРЕЖНЯЯ РАЗДАЧА ОТКЛАДЫВАЕТСЯ РЯДОМ ДО ВЕРДИКТА ══════════════════════════════════
   *
   * Раздача гитом не отслеживается, и `merge --abort` её не касается: собранное отказанной
   * веткой окно осталось бы на диске и раздавалось человеку как вершина. Поэтому копия
   * прежней раздачи кладётся рядом ДО сборки и возвращается на место, если ветка не вошла
   * (`restoreWindow`); вошла — копию убирает штамп. Упавшая сборка возвращает её НЕМЕДЛЕННО
   * и сама: сборщик мог снести раздачу прежде, чем упасть, и «сборка не прошла» не должно
   * означать «и окна больше нет».
   *
   * @returns {{built:(boolean|null), touched:boolean, ms?:number, note?:string, files?:string[]}}
   */
  async function buildWindow({ cwd, mergedTree }) {
    const seen = spaTouched({ cwd, execGit, mergedTree })
    if (seen.asked && !seen.touched) return { built: null, touched: false, note: SPA_UNTOUCHED_NOTE }
    if (!hasSpaBuildScript({ cwd, readFile: io.readFile })) {
      return { built: null, touched: true, note: SPA_NO_SCRIPT_NOTE }
    }
    const said = { touched: true, files: seen.files, ...(seen.asked ? {} : { note: SPA_DIFF_UNKNOWN_NOTE }) }

    const keep = keepDist({ root: cwd, clock: o.clock })
    state.spaKept = keep.kept || null
    const held = keep.kept ? { distKept: true } : { distKept: false, distNote: keep.keepNote || DIST_NOTHING_KEPT_NOTE }

    /** Упавшая сборка не имеет права оставить человека без окна — возвращаем прежнее сразу. */
    const putBack = () => {
      if (!state.spaKept) return { distNote: keep.keepNote || DIST_NOTHING_KEPT_NOTE }
      const back = restoreDist({ root: cwd, kept: state.spaKept })
      state.spaKept = null
      return { distRestored: back.restored === true, distNote: back.note }
    }

    let answer
    try {
      answer = (await runBuild({ cwd, script: SPA_BUILD_SCRIPT })) || {}
    } catch (err) {
      // Сборщик, который БРОСИЛ, — это не собранное окно. Молчаливое «ну и ладно» здесь
      // вернуло бы ровно ту беду, ради которой всё это написано.
      return { ...said, ...held, built: false, ms: 0, tail: String((err && err.message) || err).slice(0, 400), ...putBack() }
    }
    const built = answer.built === true
    return {
      ...said,
      ...held,
      built,
      ...(Number.isFinite(answer.ms) ? { ms: answer.ms } : {}),
      ...(Number.isFinite(answer.exitCode) ? { exitCode: answer.exitCode } : {}),
      ...(answer.timedOut === true ? { timedOut: true } : {}),
      ...(answer.tail ? { tail: String(answer.tail) } : {}),
      ...(built ? {} : putBack()),
    }
  }

  /**
   * restoreWindow() — ВЕТКА НЕ ВОШЛА, И РАЗДАЧА ВОЗВРАЩАЕТСЯ К ВЕРШИНЕ. Зовёт её ритуал
   * слияния на КАЖДОМ своём отказе после прогонятеля: `merge --abort` возвращает исходник,
   * а раздачу — никто, потому что её нет ни в одном коммите. Без этого вызова демон
   * продолжал бы раздавать окно, собранное из ОТКАЗАННОЙ ветки, и ни один сторож этого не
   * увидел бы: исходник чист, раздача новее исходника — по всем линейкам «свежо».
   *
   * @returns {{restored:boolean, note:string}}
   */
  function restoreWindow(call = {}) {
    const cwd = call.cwd || state.cwd || o.cwd
    if (!state.spaKept) return { restored: false, note: DIST_NOTHING_KEPT_NOTE }
    const back = restoreDist({ root: cwd, kept: state.spaKept })
    state.spaKept = null
    state.spaRestored = back
    return back
  }

  async function runTests(call = {}) {
    const cwd = call.cwd || o.cwd
    state.cwd = cwd
    const mergedTree = call.mergedTree ?? mergedTreeSha({ cwd, execGit })
    state.tree = mergedTree

    // (0) ОКНО — ПЕРВЫМ ДЕЛОМ. Отказ сборки уходит СВОИМ признаком: ритуал по нему откажет
    //     своими словами, а не выдаст поломку бандлера за упавший тест.
    const spa = await buildWindow({ cwd, mergedTree })
    state.spaBuild = spa
    if (spa.built === false) {
      return {
        passed: false,
        ran: false,
        spaBuildFailed: true,
        spaBuild: spa,
        ...(spa.tail ? { failureDetail: spa.tail } : {}),
      }
    }

    const verdict = receiptCoversTree({ cwd, execGit, mergedTree, readFile: io.readFile })
    state.reason = verdict.reason

    // (1) КВИТАНЦИЯ ЧЕСТНА ДЛЯ ЭТОГО ДЕРЕВА — прогона не будет, и это НЕ «красное»: ритуал
    //     читает `passed:null` как «прогона не было» и фиксирует слияние.
    if (verdict.covers) {
      state.decided = 'reused'
      return { passed: null, ran: false, note: RECEIPT_COVERS_NOTE, reusedReceipt: true, spaBuild: spa }
    }

    // (2) ВЕРШИНА ДВИГАЛАСЬ — набор идёт ОДИН раз, здесь.
    state.decided = 'ran'
    const reportPath = o.reportPath || join(tmpdir(), `sma-landing-${process.pid}-${Date.now()}.json`)
    // ЧЬЯ ЭТО ПОСАДКА — сказано именем ветки, потому что другого имени у ритуала нет. Оно же
    // становится именем сохранённого отчёта: человек, читающий отказ, ищет файл по строке,
    // которую нажимал, а не по номеру процесса демона.
    const label = typeof call.branch === 'string' ? call.branch.replace(/^wt\//, '') : null
    const answer = (await runSuite({ cwd, reportPath, keepDir, label })) || {}

    // (3) …ЕСЛИ ЕМУ БЫЛО ГДЕ ПОЙТИ. Вопрос «есть ли в этом дереве набор» задаёт сам
    //     прогонятель — он единственный, кто знает, чем гонит, — и на «здесь нечего гонять»
    //     отвечает запасной, которого дала дверь. Посадка не имеет права превратить чужую
    //     копию без набора в «здесь красное».
    if (answer.noSuite === true) {
      state.decided = 'no-suite'
      if (fallbackRunner) return { ...((await fallbackRunner({ ...call, cwd })) || {}), spaBuild: spa }
      return { ...answer, spaBuild: spa }
    }

    state.ran = answer.ran === true
    state.reportPath = answer.reportPath || reportPath
    return { ...answer, spaBuild: spa }
  }

  /**
   * stamp({cwd}) — довести числа до вершины и зафиксировать. Зовётся ТОЛЬКО после зелёного
   * слияния: штамповать нечего там, где ветка не вошла.
   *
   * И здесь же — последним действием — ставится метка свежести раздачи, если окно собиралось
   * (см. пункт 3 шапки): это единственное место посадки, где вся фиксация уже позади.
   */
  function stamp(call = {}) {
    const cwd = call.cwd || o.cwd
    // ВЕТКА ВОШЛА — ОТЛОЖЕННОЕ ОКНО БОЛЬШЕ НЕ НУЖНО. Раздача на диске собрана ровно из того
    // дерева, которое стало вершиной; копия прежней с этой секунды — мусор, а не страховка.
    // СТОИТ ПЕРВЫМ И РАНЬШЕ МЕТКИ (см. ниже) НАМЕРЕННО: метку ставят на ПОДМЕНЁННУЮ раздачу,
    // и отложенная копия не должна дожить до этой строки даже как сосед на диске.
    if (state.spaKept) {
      dropKept({ kept: state.spaKept })
      state.spaKept = null
    }
    let measurement = null
    if (state.decided === 'ran') {
      if (!state.ran) {
        return {
          stamped: false,
          committed: false,
          sha: null,
          tests: null,
          files: null,
          wrote: [],
          notes: [],
          badgeViolations: null,
          numbersViolations: null,
          reason: 'полного прогона не было — числа этого дерева никем не измерены',
        }
      }
      try {
        measurement = parseVitestJson(io.readFile(state.reportPath))
      } catch (err) {
        return {
          stamped: false,
          committed: false,
          sha: null,
          tests: null,
          files: null,
          wrote: [],
          notes: [],
          badgeViolations: null,
          numbersViolations: null,
          reason: `отчёт прогона не прочитан (${String((err && err.message) || err)}) — штамповать по чужой квитанции нельзя`,
        }
      } finally {
        try {
          io.remove(state.reportPath)
        } catch {
          /* забытый временный отчёт — не провал посадки */
        }
      }
    }
    const res = stampLanding({ cwd, execGit, io, measurement })

    // МЕТКА СВЕЖЕСТИ — ПОСЛЕДНИМ ДЕЙСТВИЕМ, и только если окно ДЕЙСТВИТЕЛЬНО собиралось.
    // Раньше поставить её нельзя: коммит слияния, из-за которого раздача и выглядит старой,
    // к этому месту уже зафиксирован, а штамп своим коммитом `spa/src` не трогает вовсе.
    // Исход штампа на это не влияет: незаштампованные числа — беда чисел, а раздача, которую
    // никто не пометил, отправит СЛЕДУЮЩУЮ посадку в ложное красное.
    if (state.spaBuild && state.spaBuild.built === true) {
      let mark
      try {
        mark = markBundle({ cwd })
      } catch (err) {
        // FAIL-OPEN: не переставленное время файлов — повод сказать словами, а не превратить
        // состоявшуюся посадку в отказ.
        mark = { refreshed: 0, note: `метку свежести раздачи поставить не вышло: ${String((err && err.message) || err)}` }
      }
      state.spaBuild = { ...state.spaBuild, mark }
    }

    return {
      ...res,
      ran: state.decided === 'ran',
      reusedReceipt: state.decided === 'reused',
      // ПЕРЕСОБИРАЛОСЬ ЛИ ОКНО, СКОЛЬКО ЭТО СТОИЛО И ПОМЕЧЕНА ЛИ РАЗДАЧА — на карточке, а не
      // только в журнале: раздача, собранная дверью, — такая же часть посадки, как и
      // штампованные числа.
      ...(state.spaBuild ? { spaBuild: state.spaBuild } : {}),
      ...(state.reason ? { whyRan: state.reason } : {}),
    }
  }

  return { runTests, stamp, restoreWindow, state }
}
