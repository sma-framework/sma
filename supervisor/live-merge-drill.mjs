/**
 * live-merge-drill.mjs — УЧЕНИЕ ПРИЁМКИ ТЕРМИНАЛА. Живой боевой глагол `merge <ветка>`
 * командной строки, на настоящем git, с настоящим прогоном тестов.
 *
 * ЧТО ОНО ДОКАЗЫВАЕТ, и почему этого не докажет ни один тест и ни одно чтение кода:
 *
 *   ТЕРМИНАЛ ВХОДИТ В ТОТ ЖЕ РИТУАЛ ПРИЁМКИ, КАКИМ РАБОТАЕТ ДВЕРЬ ОДОБРЕНИЯ ДЕМОНА.
 *   Не в свой, не в похожий, не во второй копии. Глагол `merge` зовёт `runMerge`
 *   (`scripts/sma/lib/merge-gate.mjs`) и подаёт ему `runMergeSmoke`
 *   (`scripts/sma/lib/merge-smoke.mjs`) — ровно ту пару, которой собран корень демона.
 *   Чтением кода этого не доказать: обе версии — «зовёт тот же» и «зовёт свой» — выглядят
 *   на глаз одинаково правильными. Тестом тоже: сегодняшние тесты ритуала кормят его
 *   ПОДДЕЛКОЙ прогонятеля и подделкой git, то есть доказывают форму ответа, а не то, что
 *   на настоящем дереве что-то произошло. Здесь ритуал боевой и не переопределён ничем:
 *   git настоящий, прогонятель настоящий, слияние настоящее.
 *
 * ТРИ ИСХОДА, И ЗЕЛЁНАЯ ПОЛОВИНА — НЕ УКРАШЕНИЕ:
 *
 *   КРАСНАЯ   — ветка, ломающая целевой сьют, ОТКАЗАНА со словами о КРАСНЫХ ТЕСТАХ;
 *               вершина не сдвинулась, незакоммиченного слияния в дереве не осталось.
 *   ЗЕЛЁНАЯ   — ветка, сьют не ломающая, ВЛИТА; вершина сдвинулась, квитанция несёт
 *               имя получившегося коммита.
 *   ТРЕТИЙ    — ветка, уже лежащая в дереве: честное «сводить было нечего, прогон не
 *               запускался». Ни слияния, ни прогона, и оба факта названы своими словами.
 *
 * Дверь, которая отказывает ВСЕГДА, неотличима от двери, которая отказывает ПО СУЩЕСТВУ:
 * сломанный прогонятель отвечает «красные» на что угодно. Только зелёная половина отделяет
 * работающий гейт от заклинившего, а третий исход отделяет их обоих от гейта, который
 * выдаёт «ничего не произошло» за проход.
 *
 * ═══════════════════ МИНА КОНТРАКТА СМОКА, НАЗВАННАЯ ЗАРАНЕЕ ══════════════════════
 *
 * Прогонятель гонит РОВНО ОДИН файл — `MERGE_SMOKE_TARGET` — В ПРОВЕРЯЕМОМ ДЕРЕВЕ, и
 * ОТСУТСТВИЕ этого файла для него не «красные тесты», а «прогонять было нечего». Ритуал в
 * таком случае СЛИВАЕТ, честно пометив, что прогона не было. Значит учение, потерявшее свой
 * целевой файл, доказало бы не отказ, а дыру: слияние прошло бы, код выхода был бы нулём, и
 * «гейт работает» было бы написано о прогоне, которого не случилось.
 *
 * Поэтому красная половина утверждает не «не влито», а именно `testsPassed: false` в
 * квитанции слияния плюс слова об отказе по КРАСНЫМ тестам, и отдельно утверждает, что в
 * ответе НЕТ слов об отсутствии прогона. Три утверждения вместо одного — ровно потому, что
 * самое дешёвое из них проходит и тогда, когда доказывать нечего.
 *
 * Отсюда же устройство скретча: он ОБЯЗАН нести файл по пути `MERGE_SMOKE_TARGET` — микро-сьют
 * на сьютере продукта, утверждающий одно свойство файла-источника скретча. Путь и глубина
 * берутся ИЗ САМОЙ ПОСТОЯННОЙ, а не переписаны сюда руками: переедет цель — переедет и сьют.
 *
 * ═══════════════════ ЧТО ПЕРЕОПРЕДЕЛЕНО, И ПОЧЕМУ ИМЕННО ЭТО ══════════════════════
 *
 * Учение работает в СКРЕТЧ-РЕПОЗИТОРИИ во временном каталоге системы, и переопределены ровно
 * четыре вещи — каждая граница безопасности, а не подпорка:
 *
 *   1. СВОЁ ДЕРЕВО. Ритуал держит рабочее дерево с НЕЗАКОММИЧЕННЫМ слиянием всё время
 *      прогона тестов (цена названа в шапке самого ритуала). Прогон в общем чекауте, где
 *      рядом работают другие окна, — это чужая работа поверх половины чужого слияния.
 *      Скретч создаётся с нуля, живёт минуты и удаляется в `finally`.
 *   2. СВОЙ КОРЕНЬ СОСТОЯНИЯ (`SMA_ROOT_OVERRIDE`). Претензии, слот слияния и журнал с
 *      квитанциями уезжают в `.sma` скретча. Без этого общий слот слияния и чужой журнал
 *      получили бы записи учения — и общий слот учение могло бы у кого-то отобрать.
 *   3. СВОЙ ЯКОРЬ ПРОЕКТА (`CLAUDE_PROJECT_DIR`). Часть состояния окна ищется от якоря, а
 *      не от корня состояния; без него файл имён окон нашёлся бы у соседа.
 *   4. СВОЁ ИМЯ ОКНА (`SMA_TERMINAL_NAME`). Удостоверение учения детерминировано, журнал
 *      скретча читается по одному имени, и постоянное имя настоящего окна не трогается.
 *
 * Демон НЕ ПОДНИМАЕТСЯ: предмет учения — вход ТЕРМИНАЛА в ритуал, демону здесь делать нечего.
 * Порт не занимается, база очереди не создаётся, файл входа учётной записи не копируется —
 * ни одного токена потратить физически нечем.
 *
 * ═══════════════════ ТРИ КОДА ВЫХОДА ══════════════════════════════════════════════
 *
 *   код 0 — чисто: все три исхода получены, все утверждения прошли;
 *   код 1 — блокеры: прогон СОСТОЯЛСЯ, но что-то из утверждённого не подтвердилось;
 *   код 3 — НЕ ПРОГНАНО: git недоступен, сьютер не разрешается, скретч не собрался, глагол
 *           убит по времени. Это НЕ пустой список находок и никогда не переписывается в
 *           проход: прогон, которого не было, не считается проходом.
 *
 * Только встроенные модули узла и два модуля самого продукта. Ни одной новой зависимости,
 * ни одной установки пакетов: сьютер разрешается РЯДОМ С ЭТОЙ установкой, скретчу свои
 * зависимости не нужны.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MERGE_SMOKE_TARGET, resolveSuiteEntry } from '../scripts/sma/lib/merge-smoke.mjs'

// ── постоянные учения ──────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO_ROOT, 'scripts', 'sma', 'cli.mjs')

/**
 * Где живёт скретч — во временном каталоге системы, РАСКРЫТОМ (без ссылок). Не внутри
 * рабочей копии ни на каком уровне: по рабочей копии ходят сканер внутренних имён, проверка
 * упаковки и штамп числа тестов, а её каталог зависимостей на этой машине — ССЫЛКА в другой
 * чекаут, так что «спрятать внутрь зависимостей» значит положить в чужое дерево.
 */
const DRILL_ROOT = join(realpathSync(tmpdir()), 'sma-merge-drill')
const SCRATCH = join(DRILL_ROOT, 'repo')
const SCRATCH_SMA = join(SCRATCH, '.sma')

/** Удостоверение учения — детерминированное, чтобы журнал скретча читался по одному имени. */
const DRILL_IDENTITY = 'merge-drill'

/** Файл-источник скретча, про который утверждает микро-сьют. */
const SOURCE_FILE = 'src/hint.mjs'

/**
 * ЧТО СКРЕТЧ НЕ СЧИТАЕТ СВОИМИ ФАЙЛАМИ, и почему это не поблажка проверке. Учение утверждает,
 * что после отказа дерево ЧИСТО — иначе незакоммиченное слияние осталось бы висеть, и «ветка
 * не влита» было бы правдой ровно до следующей команды. Утверждение сильное, и оно обязано
 * остаться сильным. Но два каталога в скретче создаёт САМО УЧЕНИЕ, а не ритуал: `.sma` — это
 * корень состояния, который мы сюда нарочно увели (граница 2 в шапке), а `node_modules` —
 * кэш сьютера, который он кладёт в проверяемое дерево. Оба замечены живым прогоном, оба к
 * слиянию отношения не имеют. Названы поимённо здесь, а не спрятаны ослаблением проверки до
 * «отслеживаемых файлов»: тогда любой НОВЫЙ мусор ритуала прошёл бы молча.
 */
const SCRATCH_IGNORE = ['.sma/', 'node_modules/', ''].join('\n')

/** Ветки учения. Имена говорят, что ветка делает с целевым сьютом. */
const RED_BRANCH = 'breaks-the-hint'
const GREEN_BRANCH = 'keeps-the-hint'

/**
 * ЧТО ИМЕННО ЛОМАЕТ КРАСНАЯ ВЕТКА — названо здесь, потому что красный по неизвестной причине
 * неотличим от красного по поломке снасти. Ветка убирает путь репозитория из подсказки «как
 * выйти из незавершённого слияния», и падает РОВНО одно утверждение микро-сьюта: то, которое
 * требует, чтобы подсказка несла путь. Поломка не выдуманная — без пути подсказка перестаёт
 * быть выполнимой командой, то есть «откатить можно, но не видно, к чему».
 */
const SOURCE_GREEN = [
  '// Источник скретча: подсказка выхода из незавершённого слияния.',
  'export function unfinishedMergeHint(cwd) {',
  "  return 'рабочее дерево осталось в НЕЗАВЕРШЁННОМ слиянии — выйти из него: git -C ' + cwd + ' merge --abort'",
  '}',
  '',
].join('\n')

const SOURCE_RED = [
  '// Красная ветка: путь репозитория выброшен из подсказки.',
  'export function unfinishedMergeHint(cwd) {',
  "  return 'рабочее дерево осталось в НЕЗАВЕРШЁННОМ слиянии — выйти из него: git merge --abort'",
  '}',
  '',
].join('\n')

const SOURCE_GREEN_BRANCH = [
  SOURCE_GREEN.trimEnd(),
  '',
  "export const HINT_VERB = 'merge --abort'",
  '',
].join('\n')

/**
 * Микро-сьют по пути `MERGE_SMOKE_TARGET`. Подъём до корня скретча выводится из ГЛУБИНЫ самой
 * постоянной, а не переписан сюда числом: переедет цель — переедет и импорт. Сьютер сам
 * разрешает свой собственный импорт в чужом дереве, поэтому скретчу зависимости не нужны.
 */
function microSuiteSource() {
  const upToRoot = '../'.repeat(MERGE_SMOKE_TARGET.split('/').length - 1)
  return [
    "import { test, expect } from 'vitest'",
    '',
    `import { unfinishedMergeHint } from '${upToRoot}${SOURCE_FILE}'`,
    '',
    "test('подсказка выхода несёт путь репозитория', () => {",
    "  expect(unfinishedMergeHint('/some/repo')).toContain('-C /some/repo')",
    '})',
    '',
  ].join('\n')
}

/** Потолок ожидания глагола. Смок отвечает секундами; минута — запас, а не бюджет. */
const VERB_TIMEOUT_MS = 180000

// ── печать и счёт ──────────────────────────────────────────────────────────────────

let failCount = 0
const proven = new Set()
const say = (s) => console.log(s)
const pass = (msg) => say(`PASS  ${msg}`)
const fail = (msg) => {
  failCount += 1
  say(`FAIL  ${msg}`)
}
const info = (msg) => say(`  ..  ${msg}`)
const head = (msg) => say(`\n=== ${msg}`)

/** Единственный выход с кодом 3. Причина называется всегда. */
function notRun(reason) {
  say(`\nНЕ ПРОГНАНО: ${reason}`)
  say('RESULT: НЕ ПРОГНАНО (exit 3) — это НЕ проход и никогда в проход не переписывается.')
  cleanup()
  process.exit(3)
}

const check = (cond, okMsg, badMsg) => (cond ? pass(okMsg) : fail(badMsg))

// ── мелкая механика ────────────────────────────────────────────────────────────────

function git(args, cwd = SCRATCH) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8' }))
}

const scratchHead = () => git(['rev-parse', 'HEAD']).trim()
const scratchDirty = () => git(['status', '--porcelain']).trim()

function cleanup() {
  try {
    rmSync(DRILL_ROOT, { recursive: true, force: true })
  } catch {
    /* уборка best-effort: скретч живёт во временном каталоге системы */
  }
}

/**
 * Боевой глагол, запущенный как его запускает человек: отдельный процесс узла, командная
 * строка продукта, рабочий каталог — скретч. Ничего внутри ритуала не подменяется; подменены
 * только четыре границы окружения, перечисленные в шапке.
 */
function runMergeVerb(branch) {
  const res = spawnSync(process.execPath, [CLI, 'merge', branch], {
    cwd: SCRATCH,
    encoding: 'utf8',
    timeout: VERB_TIMEOUT_MS,
    env: {
      ...process.env,
      SMA_ROOT_OVERRIDE: SCRATCH_SMA,
      CLAUDE_PROJECT_DIR: SCRATCH,
      SMA_TERMINAL_NAME: DRILL_IDENTITY,
      SMA_DISABLE_SNAPSHOT_SPAWN: '1',
    },
  })
  const out = String(res.stdout || '')
  const err = String(res.stderr || '')
  if (res.error && res.error.code === 'ETIMEDOUT') notRun(`глагол merge ${branch} не уложился в потолок ожидания`)
  if (res.status == null) notRun(`глагол merge ${branch} завершился без кода выхода (сигнал ${res.signal})`)
  return { code: res.status, out, err, all: `${out}${err}` }
}

/** Квитанции слияния из журнала скретча — в порядке появления. */
function mergeReceipts() {
  const dir = join(SCRATCH_SMA, 'journal')
  if (!existsSync(dir)) return []
  const found = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (rec && rec.type === 'merge' && rec.detail) found.push(rec.detail)
      } catch {
        /* нечитаемая строка журнала — не квитанция */
      }
    }
  }
  return found
}

const lastReceipt = () => {
  const all = mergeReceipts()
  return all.length ? all[all.length - 1] : null
}

// ── постройка скретча ──────────────────────────────────────────────────────────────

/**
 * УБОРКА ИДЁТ НА ВХОДЕ, А НЕ ТОЛЬКО НА ВЫХОДЕ: падение посреди прошлого прогона оставило бы
 * скретч на месте, и уборка, живущая только в конце, — это уборка, которой при провале не было.
 */
function buildScratch() {
  cleanup()
  mkdirSync(join(SCRATCH, dirname(SOURCE_FILE)), { recursive: true })
  mkdirSync(join(SCRATCH, dirname(MERGE_SMOKE_TARGET)), { recursive: true })

  git(['init', '--initial-branch=main'])
  git(['config', 'user.name', 'SMA drill'])
  git(['config', 'user.email', 'drill@localhost'])
  git(['config', 'commit.gpgsign', 'false'])

  writeFileSync(join(SCRATCH, '.gitignore'), SCRATCH_IGNORE)
  writeFileSync(join(SCRATCH, SOURCE_FILE), SOURCE_GREEN)
  writeFileSync(join(SCRATCH, MERGE_SMOKE_TARGET), microSuiteSource())
  git(['add', '.gitignore', SOURCE_FILE, MERGE_SMOKE_TARGET])
  git(['commit', '-m', 'scratch base'])
}

function makeBranch(name, source) {
  git(['checkout', '-b', name])
  writeFileSync(join(SCRATCH, SOURCE_FILE), source)
  git(['add', SOURCE_FILE])
  git(['commit', '-m', `scratch ${name}`])
  git(['checkout', 'main'])
}

// ── половины ───────────────────────────────────────────────────────────────────────

/** КРАСНАЯ: отказ ПО СУЩЕСТВУ — по красным тестам, а не по отсутствию прогона. */
function redHalf() {
  head('КРАСНАЯ ПОЛОВИНА — ветка ломает целевой сьют')
  const before = scratchHead()
  info(`вершина скретча ДО: ${before}`)

  const r = runMergeVerb(RED_BRANCH)
  for (const line of r.all.split(/\r?\n/)) if (line.trim()) info(`глагол: ${line.trim()}`)

  const after = scratchHead()
  info(`вершина скретча ПОСЛЕ: ${after}`)

  check(r.code !== 0, `глагол вышел ненулём (${r.code})`, `глагол вышел ${r.code} — отказ обязан быть ненулевым`)
  check(/ОТКАЗАНО/.test(r.all), 'ответ говорит об ОТКАЗЕ', 'в ответе нет слова об отказе')
  check(/КРАСНЫЕ/.test(r.all), 'причина отказа названа: тесты КРАСНЫЕ', 'причина отказа не названа красными тестами')
  check(
    !/прогонять было нечего|прогона не было|не запускались/.test(r.all),
    'в ответе НЕТ слов об отсутствии прогона — отказ по существу, а не по потерянной цели',
    'ответ говорит об ОТСУТСТВИИ прогона: целевой файл потерян, учение доказало бы дыру, а не отказ',
  )

  const rec = lastReceipt()
  check(!!rec, 'квитанция отказа записана в журнал скретча', 'квитанции отказа в журнале скретча нет')
  check(
    !!rec && rec.testsPassed === false,
    'квитанция несёт testsPassed: false — прогон СОСТОЯЛСЯ и был красным',
    `квитанция несёт testsPassed: ${rec ? JSON.stringify(rec.testsPassed) : '—'}, ожидалось false`,
  )
  check(!!rec && rec.refused === true, 'квитанция помечена отказом', 'квитанция не помечена отказом')
  check(after === before, 'вершина скретча НЕ сдвинулась', `вершина сдвинулась: ${before} -> ${after}`)
  check(scratchDirty() === '', 'дерево скретча чисто — незакоммиченного слияния не осталось', `дерево скретча грязное: ${scratchDirty()}`)
  check(
    !existsSync(join(SCRATCH, '.git', 'MERGE_HEAD')),
    'MERGE_HEAD снят — сведение отменено',
    'MERGE_HEAD на месте: дерево осталось в незавершённом слиянии',
  )
  proven.add('red')
}

/** ЗЕЛЁНАЯ: гейт не заклинил — ветка, не ломающая сьют, входит. */
function greenHalf() {
  head('ЗЕЛЁНАЯ ПОЛОВИНА — ветка целевой сьют не ломает')
  const before = scratchHead()
  info(`вершина скретча ДО: ${before}`)

  const r = runMergeVerb(GREEN_BRANCH)
  for (const line of r.all.split(/\r?\n/)) if (line.trim()) info(`глагол: ${line.trim()}`)

  const after = scratchHead()
  info(`вершина скретча ПОСЛЕ: ${after}`)

  check(r.code === 0, 'глагол вышел нулём', `глагол вышел ${r.code}, ожидался 0`)
  check(/влит/.test(r.all), 'ответ говорит, что ветка влита ЛОКАЛЬНО', 'в ответе нет слов о слиянии')
  check(/зелёные/.test(r.all), 'ответ называет прогон зелёным', 'ответ не называет прогон зелёным')
  check(after !== before, `вершина скретча сдвинулась: ${before} -> ${after}`, 'вершина не сдвинулась — слияния не произошло')

  const rec = lastReceipt()
  check(!!rec && rec.testsPassed === true, 'квитанция несёт testsPassed: true', `квитанция несёт testsPassed: ${rec ? JSON.stringify(rec.testsPassed) : '—'}`)
  check(
    !!rec && rec.resultSha === after,
    'квитанция несёт имя получившегося коммита слияния целиком',
    `квитанция несёт resultSha ${rec ? String(rec.resultSha) : '—'}, а вершина ${after}`,
  )
  check(scratchDirty() === '', 'дерево скретча чисто', `дерево скретча грязное: ${scratchDirty()}`)
  proven.add('green')
}

/** ТРЕТИЙ ИСХОД: сводить нечего — и это сказано, а не разыграно как слияние. */
function alreadyHalf() {
  head('ТРЕТИЙ ИСХОД — ветка уже в дереве')
  const before = scratchHead()
  info(`вершина скретча ДО: ${before}`)

  const r = runMergeVerb(GREEN_BRANCH)
  for (const line of r.all.split(/\r?\n/)) if (line.trim()) info(`глагол: ${line.trim()}`)

  const after = scratchHead()
  info(`вершина скретча ПОСЛЕ: ${after}`)

  check(r.code === 0, 'глагол вышел нулём', `глагол вышел ${r.code}, ожидался 0`)
  check(/уже в дереве/.test(r.all), 'ответ говорит, что ветка уже в дереве', 'ответ не говорит про «уже в дереве»')
  check(/сводить было нечего/.test(r.all), 'ответ говорит «сводить было нечего»', 'ответ не говорит «сводить было нечего»')
  check(after === before, 'вершина скретча НЕ сдвинулась', `вершина сдвинулась: ${before} -> ${after}`)

  const rec = lastReceipt()
  check(!!rec && rec.alreadyUpToDate === true, 'квитанция помечена «сводить было нечего»', 'квитанция не помечена «сводить было нечего»')
  check(
    !!rec && rec.testsPassed === null,
    'квитанция несёт testsPassed: null — утверждать о прогоне нечего',
    `квитанция несёт testsPassed: ${rec ? JSON.stringify(rec.testsPassed) : '—'}, ожидался null`,
  )
  check(
    !!rec && typeof rec.testsNote === 'string' && /прогон не запускался/.test(rec.testsNote),
    'квитанция говорит словами, что прогон НЕ ЗАПУСКАЛСЯ',
    'квитанция не говорит, что прогона не было',
  )
  proven.add('already')
}

// ── ход учения ─────────────────────────────────────────────────────────────────────

function main() {
  head('ПЕРЕД УЧЕНИЕМ')

  try {
    info(`git: ${String(execFileSync('git', ['--version'], { encoding: 'utf8' })).trim()}`)
  } catch (err) {
    notRun(`git недоступен: ${String((err && err.message) || err)}`)
  }
  if (!existsSync(CLI)) notRun(`командная строка продукта не найдена: ${CLI}`)
  try {
    info(`сьютер: ${resolveSuiteEntry()}`)
  } catch (err) {
    notRun(`сьютер не разрешается рядом с этой установкой: ${String((err && err.message) || err)} — прогонять было бы нечем`)
  }
  info(`целевой файл смока: ${MERGE_SMOKE_TARGET}`)
  info(`скретч: ${SCRATCH}`)
  info(`корень состояния учения: ${SCRATCH_SMA} (общий слот слияния не трогается)`)

  try {
    buildScratch()
    makeBranch(RED_BRANCH, SOURCE_RED)
    makeBranch(GREEN_BRANCH, SOURCE_GREEN_BRANCH)
    info(`база скретча: ${scratchHead()}`)
  } catch (err) {
    notRun(`скретч не собрался: ${String((err && err.message) || err)}`)
  }

  try {
    redHalf()
    greenHalf()
    alreadyHalf()
  } finally {
    head('ПОСЛЕ УЧЕНИЯ')
    cleanup()
    info(`скретч убран: ${existsSync(DRILL_ROOT) ? 'НЕТ — каталог на месте' : 'да'}`)
  }

  finish()
}

function finish() {
  const missing = ['red', 'green', 'already'].filter((k) => !proven.has(k))
  if (missing.length) {
    say(`\nНЕ ПРОГНАНО: недоказанные исходы — ${missing.join(', ')}`)
    say('RESULT: НЕ ПРОГНАНО (exit 3) — это НЕ проход и никогда в проход не переписывается.')
    process.exit(3)
  }
  say(
    failCount === 0
      ? '\nRESULT: ЧИСТО (exit 0) — терминал вошёл в боевой ритуал приёмки: отказ по красным тестам, слияние на зелёном и честное «сводить было нечего» наблюдены живьём.'
      : `\nRESULT: БЛОКЕРЫ (exit 1) — не подтвердилось утверждений: ${failCount}`,
  )
  process.exit(failCount === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('УЧЕНИЕ УПАЛО:', err && err.stack ? err.stack : err)
  cleanup()
  process.exit(1)
}
