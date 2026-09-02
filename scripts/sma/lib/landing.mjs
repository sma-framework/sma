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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import { CAPTURE_CAP_BYTES, resolveSuiteEntry, summarizeRedRun } from './merge-smoke.mjs'

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

/** Прогона не было — и вот почему. Каждая причина своими словами, ни одна не выдана за отказ. */
export const RECEIPT_COVERS_NOTE =
  'квитанция работника снята ровно на этом дереве — полный набор не гонялся второй раз'
export const NO_SUITE_NOTE = 'в этом дереве нет полного набора — прогонять было нечего'
export const NO_SUITE_RUNNER_NOTE = 'сьютер не нашёлся рядом с этой установкой — полного прогона не было'
export const TIMED_OUT_NOTE = `полный прогон не уложился в ${Math.round(FULL_SUITE_TIMEOUT_MS / 60000)} мин — прогона не было`
export const OUTPUT_OVERFLOW_NOTE = 'вывод полного прогона перерос буфер — ребёнок убит, приговора нет'

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
 */
export function runFullSuiteAsync(o = {}) {
  const tree = o.cwd || process.cwd()
  const exists = o.exists || existsSync
  const resolveEntry = o.resolveEntry || resolveSuiteEntry
  const spawnImpl = o.spawn || spawn
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : FULL_SUITE_TIMEOUT_MS
  const reportPath = o.reportPath || join(tmpdir(), `sma-landing-${process.pid}-${Date.now()}.json`)

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
      { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
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
      const { failedTest, failureDetail } = summarizeRedRun(said)
      resolve({
        passed: false,
        ran: true,
        exitCode: code,
        reportPath,
        ...(failedTest ? { failedTest } : {}),
        ...(failureDetail ? { failureDetail } : {}),
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
 * createLanding({cwd, execGit, runSuite, fallbackRunner, io}) → `{runTests, stamp, state}` —
 * ПОСАДКА ОДНОЙ КАРТОЧКИ, собранная так, что оба её действия знают об одном и том же прогоне.
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
 */
export function createLanding(o = {}) {
  const execGit = typeof o.execGit === 'function' ? o.execGit : defaultExecGit
  const io = o.io || defaultIo()
  const runSuite = typeof o.runSuite === 'function' ? o.runSuite : runFullSuiteAsync
  const fallbackRunner = typeof o.fallbackRunner === 'function' ? o.fallbackRunner : null
  const state = { decided: null, reason: null, ran: false, reportPath: null, tree: null }

  async function runTests(call = {}) {
    const cwd = call.cwd || o.cwd
    const mergedTree = call.mergedTree ?? mergedTreeSha({ cwd, execGit })
    state.tree = mergedTree
    const verdict = receiptCoversTree({ cwd, execGit, mergedTree, readFile: io.readFile })
    state.reason = verdict.reason

    // (1) КВИТАНЦИЯ ЧЕСТНА ДЛЯ ЭТОГО ДЕРЕВА — прогона не будет, и это НЕ «красное»: ритуал
    //     читает `passed:null` как «прогона не было» и фиксирует слияние.
    if (verdict.covers) {
      state.decided = 'reused'
      return { passed: null, ran: false, note: RECEIPT_COVERS_NOTE, reusedReceipt: true }
    }

    // (2) ВЕРШИНА ДВИГАЛАСЬ — набор идёт ОДИН раз, здесь.
    state.decided = 'ran'
    const reportPath = o.reportPath || join(tmpdir(), `sma-landing-${process.pid}-${Date.now()}.json`)
    const answer = (await runSuite({ cwd, reportPath })) || {}

    // (3) …ЕСЛИ ЕМУ БЫЛО ГДЕ ПОЙТИ. Вопрос «есть ли в этом дереве набор» задаёт сам
    //     прогонятель — он единственный, кто знает, чем гонит, — и на «здесь нечего гонять»
    //     отвечает запасной, которого дала дверь. Посадка не имеет права превратить чужую
    //     копию без набора в «здесь красное».
    if (answer.noSuite === true) {
      state.decided = 'no-suite'
      if (fallbackRunner) return await fallbackRunner({ ...call, cwd })
      return answer
    }

    state.ran = answer.ran === true
    state.reportPath = answer.reportPath || reportPath
    return answer
  }

  /**
   * stamp({cwd}) — довести числа до вершины и зафиксировать. Зовётся ТОЛЬКО после зелёного
   * слияния: штамповать нечего там, где ветка не вошла.
   */
  function stamp(call = {}) {
    const cwd = call.cwd || o.cwd
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
    return {
      ...res,
      ran: state.decided === 'ran',
      reusedReceipt: state.decided === 'reused',
      ...(state.reason ? { whyRan: state.reason } : {}),
    }
  }

  return { runTests, stamp, state }
}
