/**
 * live-answer-drill.mjs — УЧЕНИЕ ВЫХОДНОГО ГЕЙТА РАБОТНИКА. Живой демон, живой тик, живой
 * git, живая очередь. Предмет — дверь, через которую выходит попытка, НЕ ТРОНУВШАЯ КОД.
 *
 * ЧТО ОНО ДОКАЗЫВАЕТ, и почему этого не может доказать ни один тест:
 *
 *   ПОЛОВИНА БЕЗ КОДА — работник написал записку и не тронул ни одного файла. Попытка
 *                       ЗАВЕРШАЕТСЯ на квитанции ответа с ПЕРВОГО раза, и второй попытки
 *                       не заводится.
 *   ПОЛОВИНА С КОДОМ  — работник сделал одну фиксацию. Квитанции ответа НЕ выдано:
 *                       кодовая работа выходит только через гейт кода.
 *   КОНТРОЛЬНАЯ       — то же учение на коде ДО починки. Вторая попытка ОБЯЗАНА появиться.
 *
 * ═══ ПОЧЕМУ ПРОГОН НА СОГЛАСОВАННОМ ДЕРЕВЕ НЕ ДОКАЗЫВАЕТ НИЧЕГО ═══════════════════
 *
 * Дефект жил не в «нет правок», а в ТОЧКЕ ОТСЧЁТА. Старая дверь спрашивала «сколько у
 * ветки работника коммитов сверх HEAD подключённого проекта» — и когда копия отведена от
 * одной точки, а проект к моменту суждения стоит на другой, ответ не ноль, даже если
 * попытка не тронула ничего. Дверь закрывалась, попытка получала «нет квитанции» и
 * заводилась вторая — впустую. На следующем прогоне две точки совпали, и промах «не
 * повторился»: это подсказка о причине, а не починка.
 *
 * Поэтому учение РАСХОЖДЕНИЕ ВОСПРОИЗВОДИТ, а не обходит: временный репозиторий, две
 * линии истории, копия отводится от вершины первой, а к моменту суждения проект стоит на
 * второй. Обе точки и разница ПЕЧАТАЮТСЯ числом. Разница ноль — учение НИЧЕГО не
 * проверяет и говорит это третьим кодом, а не печатает «прошло».
 *
 * КАКОЙ ИМЕННО ФОРМОЙ РАСХОЖДЕНИЯ. Проект уезжает на другую линию ПОКА ПОПЫТКА ИДЁТ —
 * так это и случается в жизни (человек переключил ветку, сосед влил свою работу). Есть и
 * вторая форма — ПЕРЕИСПОЛЬЗОВАННАЯ копия, у которой верб провизии базы не сообщает вовсе;
 * она этой починкой НЕ закрыта, названа отдельной находкой и здесь не проверяется. Учение
 * не выдаёт одну форму за обе.
 *
 * ═══ ЧЕМ ЗАМЕНЁН РАБОТНИК — СКАЗАНО ПРЯМО ═══════════════════════════════════════
 *
 * МОДЕЛЬ ПОДМЕНЕНА СЦЕНАРИЕМ УЗЛА. Сборка аргументов запуска (`buildArgs`) — единственная
 * дверь переопределения исполнителя в корне — собирает запуск не языковой модели, а
 * маленького сценария, который ведёт себя как работник: печатает записку о подходе в том
 * самом кадре, в каком её печатает настоящая сессия, и (во второй половине) делает одну
 * фиксацию. Подписка не тратится ни на цент, и прогон детерминирован.
 *
 * ПОДМЕНЕНА МОДЕЛЬ, А НЕ ДВЕРЬ. Проверяемый гейт живёт в цикле тика и здесь боевой:
 * настоящий `createDaemon`, настоящий git, настоящий верб провизии копии, настоящая
 * перепроверка, настоящий леджер (свой, временный), настоящая очередь Postgres (своя база).
 * Ни одна из этих частей не переопределена.
 *
 * ЧТО ЕЩЁ ПЕРЕОПРЕДЕЛЕНО, и каждое — граница безопасности, а не подпорка:
 *   1. СВОЙ ПОРТ (проба ниже) — общий демон основателя и соседние окна стоят на своих.
 *   2. СВОИ каталоги данных и леджера — временные. Живой леджер основателя не открывается.
 *   3. СВОЯ БАЗА ОЧЕРЕДИ на общем сервере: синтетическая задача, положенная в общую базу,
 *      может быть взята живым демоном основателя — это его деньги и его дерево. База
 *      создаётся и удаляется учением; данные общей очереди не трогаются.
 *   4. НЕТ ПОДКЛЮЧЁННОГО ПРОЕКТА, а подаваемое тику дерево — временный репозиторий.
 *   5. ЗЕРКАЛО ЛИЧНОГО СЛОЯ — пустышка. Боевое копирует домашний каталог человека в
 *      учётную запись работника; учению этого делать нельзя и не нужно.
 *   6. РЕЕСТР СЕРВЕРОВ — пустой, УБОРЩИК ЧУЖИХ КОПИЙ — пустышка: оба ходят по деревьям,
 *      которые учению не принадлежат.
 *   7. ПУТЬ К ПРОДУКТОВОМУ CLI сделан абсолютным. Тик зовёт верб как `node
 *      scripts/sma/cli.mjs …` ОТНОСИТЕЛЬНО каталога подключённого проекта, а временный
 *      репозиторий — не установка продукта. Верб, его аргументы и каталог запуска не
 *      тронуты; абсолютным сделан только путь к файлу.
 *
 * ═══ ОКНО НАБЛЮДЕНИЯ — ЧИСЛО, А НЕ «СРАЗУ ПОСЛЕ» ════════════════════════════════
 *
 * «Второй попытки не заведено» — утверждение об ОТСУТСТВИИ события. Спроси леджер сразу
 * после конца первой попытки — второй не будет НИКОГДА, даже на сломанном коде: она
 * заводится позже. Такое учение вернуло бы зелёное на невылеченном дереве.
 *
 * Поэтому интервал тика задаётся ЯВНО (боевое значение по умолчанию — пять секунд), берётся
 * маленьким, и после конца первой попытки учение ждёт названное число полных интервалов.
 * Интервал, число интервалов и получившиеся секунды печатаются.
 *
 * И ГЛАВНОЕ — КОНТРОЛЬНАЯ ПОЛОВИНА. Учение, которое ни разу не видело второй попытки, не
 * может утверждать её отсутствие. `--control` прогоняет ту же половину без кода на дереве,
 * где восстановлена СТАРАЯ точка отсчёта, и там вторая попытка ОБЯЗАНА появиться в том же
 * окне. Не появилась — окно мало или учение слепое, и это блокер, а не проход.
 *
 * ═══ ТРИ ИСХОДА ═════════════════════════════════════════════════════════════════
 *
 *   код 0 — чисто: все утверждения половин прошли;
 *   код 1 — блокеры: прогон СОСТОЯЛСЯ, но что-то из утверждённого не подтвердилось;
 *   код 3 — НЕ ПРОГНАНО: очередь молчит, порт занят, git недоступен, расхождение не вышло.
 *
 * Прогон, которого не было, никогда не считается проходом.
 *
 * Node built-ins + модули самого демона + pg. Ни одной новой зависимости.
 */

import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { createDaemon } from '../daemon/src/main.mjs'
import { loadConfig } from '../daemon/src/config.mjs'
// СЧЁТ ПОПЫТОК ДЕЛАЕТ ТОТ ЖЕ СКЛАДЫВАТЕЛЬ, ЧТО И ПРОДУКТ. Леджер пишет ДВЕ строки на одну
// попытку (машина состояний кладёт переход, тик кладёт исход), и посчитанные строки — это
// не число попыток, а число писателей. Складыватель продукта сводит строки одной попытки в
// одну запись; своего счётчика здесь нет и быть не должно.
import { readAttempts, foldAttemptRows, readJournalEntries } from '../daemon/src/queue/attempt-ledger.mjs'
// РАЗБОРЩИК ЗАПИСКИ — ТОТ ЖЕ, ЧТО ЧИТАЕТ ТИК. Форма его входа — факт, который читается, а
// не угадывается: записка живёт ВНУТРИ кадра сессии, и учение, напечатавшее её мимо этой
// формы, покраснело бы по посторонней причине и обвинило бы базу.
import { markerLinesFrom, parseApproachNote, parseLessonMarker } from '../daemon/src/front/journal.mjs'

// ── постоянные учения ──────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Драйвер базы берётся требованием ОТ МАНИФЕСТА ДЕМОНА: он объявлен и установлен у демона,
 * а разрешение имён от этого файла до `daemon/node_modules` не доходит. Ничего не
 * устанавливается — используется то, что уже лежит в дереве.
 */
const requireFromDaemon = createRequire(new URL('../daemon/package.json', import.meta.url))
const pg = requireFromDaemon('pg')

/** Свой порт. 7777 — общий демон основателя, 7788 — соседние окна, 7802 — учение приёмки. */
const PORT_FIRST = 7803
const PORT_LAST = 7820
const FRONT_HOST = '127.0.0.1'

/** Сервер очереди — общий и живой. Базы — свои, создаются и удаляются учением. */
const QUEUE_HOST = '127.0.0.1'
const QUEUE_PORT = 5433
const ADMIN_URL = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/postgres`

/**
 * Место учения — ВНЕ рабочих деревьев. Путь берётся уже раскрытым: в этих копиях каталог
 * зависимостей и часть каталогов приложения — ССЫЛКИ в дерево основателя, и проверка «мы не
 * внутри чужого чекаута» имеет смысл только над настоящим путём, а не над написанным.
 * Проба ниже падает третьим кодом, если место всё же оказалось внутри дерева.
 */
const DRILL_ROOT = join(realpathSync(tmpdir()), 'sma-answer-drill')

/** Интервал тика учения. Боевое значение по умолчанию — 5000 мс (`config.tickMs ?? 5000`). */
const TICK_MS = 1000
/** Сколько полных интервалов держится окно наблюдения после конца первой попытки. */
const WINDOW_TICKS = 8
const WINDOW_MS = TICK_MS * WINDOW_TICKS

/** Сколько ждать конца ПЕРВОЙ попытки, прежде чем сказать «не прогнано». */
const FIRST_ATTEMPT_TIMEOUT_MS = 180000

/** Сколько коммитов уходит на первую линию истории — она и есть будущее расхождение. */
const LINE_A_COMMITS = 3

/** Путь к продуктовому CLI в том виде, в каком его зовёт тик (относительно проекта). */
const CLI_REL = 'scripts/sma/cli.mjs'

/** Записка работника — ровно те строки, которые печатает двойник. */
const NOTE_APPROACH = 'APPROACH_NOTE: разобрался по коду и отвечаю словами; править нечего'
const NOTE_LESSON = 'LESSON_NONE: разовый разбор, обобщать нечего'

/**
 * КАДР, В КОТОРОМ ЖИВУТ ОБЕ СТРОКИ. Настоящая сессия печатает NDJSON, и слова работника
 * лежат внутри `message.content[].text`, а не отдельной строкой. Двойник печатает ровно эту
 * форму — иначе учение проверяло бы разборщик, а не гейт.
 */
const NOTE_FRAME = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: `${NOTE_APPROACH}\n${NOTE_LESSON}` }] },
})

const CONTROL = process.argv.includes('--control')

// ── печать и счёт ──────────────────────────────────────────────────────────────────

let failCount = 0
const lines = []
const say = (s) => {
  lines.push(s)
  console.log(s)
}
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
  process.exit(3)
}

// ── мелкая механика ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function probePort(port, host = FRONT_HOST, timeoutMs = 2000) {
  return new Promise((res) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* закрытие сокета пробы ничего не решает */
      }
      res(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

async function waitForPort(port, host, deadline) {
  while (Date.now() < deadline) {
    if (await probePort(port, host)) return true
    await sleep(300)
  }
  return false
}

/** git с массивом аргументов и без оболочки — та же дисциплина, что у боевого бегунка. */
function git(args, cwd) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).trim()
}

function gitQuiet(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd) }
  } catch (err) {
    return { ok: false, out: String((err && err.message) || err) }
  }
}

// ── временное дерево, воспроизводящее расхождение ──────────────────────────────────

/**
 * Две линии истории от общего корня. Копия задачи будет отведена от вершины линии А (тик
 * отводит её от HEAD подключённого проекта), а двойник работника переведёт проект на линию
 * Б — то есть к моменту суждения база копии и вершина проекта РАЗОШЛИСЬ, ровно как 19.08.
 */
function buildProject(dir) {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'line-a', '.'], dir)
  git(['config', 'user.email', 'drill@localhost'], dir)
  git(['config', 'user.name', 'answer drill'], dir)
  writeFileSync(join(dir, 'readme.md'), 'учение выходного гейта\n')
  git(['add', '--', 'readme.md'], dir)
  git(['commit', '-q', '-m', 'drill: root'], dir)
  const root = git(['rev-parse', 'HEAD'], dir)

  for (let i = 1; i <= LINE_A_COMMITS; i += 1) {
    writeFileSync(join(dir, `line-a-${i}.md`), `линия А, шаг ${i}\n`)
    git(['add', '--', `line-a-${i}.md`], dir)
    git(['commit', '-q', '-m', `drill: line a ${i}`], dir)
  }
  const tipA = git(['rev-parse', 'HEAD'], dir)

  git(['branch', 'line-b', root], dir)
  git(['switch', '-q', 'line-b'], dir)
  writeFileSync(join(dir, 'line-b-1.md'), 'линия Б, шаг 1\n')
  git(['add', '--', 'line-b-1.md'], dir)
  git(['commit', '-q', '-m', 'drill: line b 1'], dir)
  const tipB = git(['rev-parse', 'HEAD'], dir)

  // Проект стоит на линии А: копия отведётся отсюда. Уедет он на линию Б уже в попытке.
  git(['switch', '-q', 'line-a'], dir)

  const divergence = Number.parseInt(git(['rev-list', '--count', 'line-a', '^line-b'], dir), 10)
  return { dir, root, tipA, tipB, divergence }
}

/**
 * ДВОЙНИК РАБОТНИКА. Пишется на диск учением, ВНЕ рабочего дерева. Это не языковая модель:
 * он делает ровно три вещи и ни одной больше — уводит подключённый проект на другую линию
 * (это и есть воспроизведение расхождения), при необходимости делает ОДНУ фиксацию в своей
 * копии, и печатает записку в кадре сессии.
 */
function writeWorkerDouble(path) {
  const src = `import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.SMA_DRILL_MODE || 'answer'
const projectDir = process.env.SMA_DRILL_PROJECT || ''
const switchTo = process.env.SMA_DRILL_SWITCH_TO || ''
const cwd = process.cwd()
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')

// (1) РАСХОЖДЕНИЕ БАЗ, воспроизведённое живьём: пока попытка идёт, подключённый проект
// уезжает на другую линию истории. Копия остаётся отведённой от прежней точки.
if (projectDir && switchTo) {
  try {
    execFileSync('git', ['switch', '-q', switchTo], { cwd: projectDir, stdio: 'ignore' })
    say({ type: 'drill', step: 'project moved', to: switchTo })
  } catch (err) {
    say({ type: 'drill_error', step: 'project move', error: String((err && err.message) || err) })
  }
}

// (2) РАБОТА С КОДОМ — ровно одна фиксация в своей копии, и только в половине «с кодом».
if (mode === 'code') {
  try {
    const file = 'drill-code-change.md'
    writeFileSync(join(cwd, file), 'правка работника: одна фиксация в копии\\n')
    execFileSync('git', ['add', '--', file], { cwd })
    execFileSync('git', ['commit', '-q', '-m', 'drill: one commit by the worker double', '--', file], { cwd })
    say({ type: 'drill', step: 'committed', file })
  } catch (err) {
    say({ type: 'drill_error', step: 'commit', error: String((err && err.message) || err) })
  }
}

// (3) ЗАПИСКА — в том кадре, в каком её печатает настоящая сессия.
process.stdout.write(${JSON.stringify(NOTE_FRAME)} + '\\n')
`
  writeFileSync(path, src)
}

// ── база очереди учения ────────────────────────────────────────────────────────────

async function ensureDb(name) {
  const client = new pg.Client({ connectionString: ADMIN_URL })
  await client.connect()
  try {
    // Кодировка задаётся ЯВНО: по умолчанию на этой платформе получается база, в которой
    // название задачи кириллицей не хранится, и учение покраснело бы по посторонней причине.
    await client.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`)
  } catch (err) {
    if (!(err && err.code === '42P04')) {
      await client.end()
      throw err
    }
  }
  await client.end()
}

async function dropDb(name) {
  try {
    const client = new pg.Client({ connectionString: ADMIN_URL })
    await client.connect()
    try {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } finally {
      await client.end()
    }
    info(`база учения ${name} удалена; общая очередь оставлена работать`)
  } catch (err) {
    info(`база ${name} не удалилась: ${String((err && err.message) || err)} — удалить руками: DROP DATABASE ${name}`)
  }
}

/** Статус строки в собственной таблице приёмки демона — правда, а не её пересказ. */
async function approvalStatus(url, taskId) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const r = await client.query('SELECT status FROM sma_task_attempts WHERE id = $1', [taskId])
    return r.rows[0] ? r.rows[0].status : null
  } catch {
    return null
  } finally {
    await client.end()
  }
}

// ── чтение леджера учения ──────────────────────────────────────────────────────────

/**
 * СКОЛЬКО БЫЛО РАЗЛИЧНЫХ ПОПЫТОК — с дедупом по паре «задача + номер попытки», сделанным
 * складывателем продукта. Недедуплицированное число, поданное как факт, — неверное число:
 * на одну попытку леджер пишет две строки.
 */
function attemptsOf(ledgerDir, taskId) {
  const rows = readAttempts(ledgerDir, taskId)
  const folded = foldAttemptRows(rows)
  const numbers = [...new Set(rows.map((r) => r && r.attempt).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b)
  return { rows, folded, numbers }
}

/** Терминальная запись попытки N — то, чем эта попытка кончилась. */
function terminalOf(ledgerDir, taskId, n) {
  return foldAttemptRows(readAttempts(ledgerDir, taskId)).find(
    (r) => r && r.attempt === n && (r.outcome === 'completed' || r.outcome === 'failed'),
  )
}

// ── одна половина учения ───────────────────────────────────────────────────────────

/**
 * @param {{key:string, title:string, mode:'answer'|'code', expectAnswer:boolean,
 *          requireSecondAttempt:boolean, port:number}} o
 */
async function runHalf(o) {
  head(`ПОЛОВИНА «${o.title}» — ${o.key}`)

  const halfRoot = join(DRILL_ROOT, o.key)
  const projectDir = join(halfRoot, 'project')
  const dataDir = join(halfRoot, 'data')
  const ledgerDir = join(halfRoot, 'ledger')
  const accountDir = join(halfRoot, 'account')
  const dbName = `sma_answer_drill_${o.key.replace(/[^a-z0-9_]/gi, '_')}`
  const queueUrl = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/${dbName}`
  for (const d of [dataDir, ledgerDir, accountDir]) mkdirSync(d, { recursive: true })

  // ── (1) дерево с расхождением ──
  const proj = buildProject(projectDir)
  info(`проект учения: ${projectDir} (ветка line-a)`)
  info(`вершина линии А (от неё отведётся копия): ${proj.tipA}`)
  info(`вершина линии Б (туда уедет проект):      ${proj.tipB}`)
  if (!Number.isFinite(proj.divergence) || proj.divergence === 0) {
    notRun(
      'две точки совпали — расхождение баз НЕ воспроизведено, и учение в таком виде не проверяет ' +
        'ничего: ровно поэтому промах 19.08 «не повторился» 20.08',
    )
  }
  pass(`расхождение баз воспроизведено: линия А впереди линии Б на ${proj.divergence} коммит(ов)`)

  // ── (2) боевая фабрика демона с названными границами ──
  const machine = loadConfig()
  const config = {
    ...machine,
    port: o.port,
    bind: FRONT_HOST,
    queueUrl,
    dataDir,
    ledgerDir,
    repoDir: projectDir,
    tickMs: TICK_MS,
    // Ни одного подключённого проекта: всё, что ходит по проектам, должно ходить по
    // временному дереву учения и никуда больше.
    projects: [],
    activeProject: null,
    // КОНВЕЙЕР ВКЛЮЧЁН — иначе тик не сделает ни одного шага, и предмет учения не наступит.
    // Цена этого включения оплачена подменой модели: запускается сценарий узла.
    pipeline: { enabled: true },
    workers: [
      {
        id: 'drill-double',
        provider: 'claude',
        enabled: true,
        account: { name: 'drill-double', configDir: accountDir },
      },
    ],
  }

  const doublePath = join(DRILL_ROOT, 'double', 'worker.mjs')

  /** Сборка аргументов, собирающая СЦЕНАРИЙ вместо модели. Названо в шапке вслух. */
  let builtSpecs = 0
  const buildArgsDouble = (task, route, opts = {}) => {
    builtSpecs += 1
    return {
      bin: process.execPath,
      args: [doublePath],
      accountName: 'drill-double',
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: accountDir,
        SMA_DRILL_MODE: o.mode,
        SMA_DRILL_PROJECT: projectDir,
        SMA_DRILL_SWITCH_TO: 'line-b',
      },
      prompt: `учение выходного гейта: ${task && task.id} (${route && route.workerId}) ${opts ? '' : ''}`.trim(),
    }
  }

  /** Верб продуктового CLI: абсолютный путь к файлу, всё остальное — как у боевого. */
  const drillVerbRunner = (bin, args, opts = {}) =>
    new Promise((res) => {
      const rewritten = args[0] === CLI_REL ? [join(REPO_ROOT, CLI_REL), ...args.slice(1)] : args
      execFile(bin, rewritten, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        res({
          code: err && Number.isFinite(err.code) ? err.code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    })

  const journalEntries = []
  const handles = createDaemon({
    config,
    dataDir,
    ledgerDir,
    buildArgs: buildArgsDouble,
    verbRunner: drillVerbRunner,
    tickProjectDir: () => projectDir,
    workerReady: () => ({ ready: true }),
    // Зеркало личного слоя — пустышка: боевое копирует домашний каталог человека.
    mirrorPersonalLayer: async () => ({ drill: true }),
    loadMcpRegistry: () => ({ servers: [] }),
    // Уборщик чужих копий ходит по деревьям, которые учению не принадлежат.
    sweepWorktrees: async () => ({ skipped: 'drill' }),
    journal: (entry) => {
      journalEntries.push(entry)
      if (entry && typeof entry.type === 'string' && entry.type.startsWith('task.')) {
        info(`журнал: ${entry.type}${entry.reason ? ` reason=${entry.reason}` : ''}${entry.detail ? ` — ${String(entry.detail).slice(0, 200)}` : ''}`)
      }
    },
  })

  // ДВА ЗАМКА НА ОДНУ ДВЕРЬ: учение отказывается работать, если в корне оказалась боевая
  // сборка аргументов — она запускает языковую модель и стоит денег основателя.
  if (handles.tickDeps.buildArgs !== buildArgsDouble) {
    await shutdown(handles)
    notRun('в корне собрана НЕ подмена аргументов — учение отказывается работать там, где может стоить денег')
  }
  info('исполнитель — сценарий узла (подмена названа в шапке); языковая модель недостижима')
  if (typeof handles.tickDeps.spawnWorker !== 'function') {
    await shutdown(handles)
    notRun('запускатель процессов не собран — тик не дойдёт до попытки')
  }
  if (typeof handles.tickDeps.execGit !== 'function') {
    await shutdown(handles)
    notRun('git не подан тику — гейты, которые его спрашивают, ответили бы «нет» по посторонней причине')
  }
  info('git и запускатель процессов — боевые, не переопределены')

  await ensureDb(dbName)
  info(`создана отдельная база очереди ${dbName} (общая база учением не открывается)`)

  await handles.start()
  if (!(await waitForPort(o.port, FRONT_HOST, Date.now() + 20000))) {
    await shutdown(handles)
    await dropDb(dbName)
    notRun(`демон так и не начал слушать ${FRONT_HOST}:${o.port}`)
  }
  info(`демон поднят: порт ${o.port}, тик ${TICK_MS} мс`)

  // ── (3) синтетическая задача — БЕЗ фазы, чтобы предполётная дверь не отвечала за неё ──
  const taskId = `drill-${o.key}-${Date.now()}`
  await handles.adapter.enqueue({
    id: taskId,
    source: 'roster',
    title: `учение выходного гейта: ${o.title}`,
    lane: 'prod',
  })
  info(`задача положена в очередь учения: ${taskId}`)

  // ── (4) ждём конца ПЕРВОЙ попытки ──
  const startedWaitAt = Date.now()
  let first = null
  while (Date.now() - startedWaitAt < FIRST_ATTEMPT_TIMEOUT_MS) {
    first = terminalOf(ledgerDir, taskId, 1)
    if (first) break
    await sleep(300)
  }
  if (!first) {
    await shutdown(handles)
    await dropDb(dbName)
    notRun(`первая попытка не кончилась за ${Math.round(FIRST_ATTEMPT_TIMEOUT_MS / 1000)} с — прогон не состоялся`)
  }
  const firstEndedAt = Date.now()
  info(`первая попытка кончилась за ${firstEndedAt - startedWaitAt} мс: outcome=${first.outcome} reason=${first.failureReason || '—'}`)
  info(`квитанция первой попытки: ${JSON.stringify(first.receiptRef ?? null)}`)
  info(`база, записанная в строку попытки: ${first.base || 'нет'}`)

  // ── (4b) РАСХОЖДЕНИЕ ИЗМЕРЯЕТСЯ В МОМЕНТ СУЖДЕНИЯ, А НЕ ПРИ ПОДГОТОВКЕ ──
  //
  // Подготовленное расхождение и расхождение, которое ВИДЕЛА дверь, — разные факты.
  // Двойник уводит проект на другую линию ПОКА попытка идёт, и если этот шаг у него не
  // вышел, две точки к моменту суждения совпадут: дверь ответа откроется и на СТАРОМ якоре,
  // а учение напечатает зелёное, ничего не проверив. Поэтому обе точки спрашиваются здесь
  // ещё раз, у живого git, и печатается ЧИСЛО, которое прочитала бы старая дверь.
  const projectHeadAtGate = git(['rev-parse', 'HEAD'], projectDir)
  const oldAnchor = gitQuiet(['rev-list', '--count', `wt/${taskId}`, '^HEAD'], projectDir)
  info(`вершина подключённого проекта в момент суждения: ${projectHeadAtGate}`)
  info(`база копии (точка отвода):                      ${first.base || 'нет'}`)
  if (projectHeadAtGate === proj.tipA) {
    await shutdown(handles)
    await dropDb(dbName)
    notRun(
      'подключённый проект остался на линии А — две точки СОВПАЛИ к моменту суждения, ' +
        'расхождение не воспроизведено, и прогон в таком виде не проверяет ничего',
    )
  }
  if (projectHeadAtGate === proj.tipB) {
    pass(`проект к моменту суждения стоял на ДРУГОЙ линии (${proj.tipB}) — условие промаха воспроизведено живьём`)
  } else {
    fail(`вершина проекта «${projectHeadAtGate}» не равна ни одной из подготовленных точек`)
  }
  const oldAnchorCount = oldAnchor.ok ? Number.parseInt(oldAnchor.out, 10) : NaN
  if (Number.isFinite(oldAnchorCount) && oldAnchorCount > 0) {
    pass(`СТАРАЯ точка отсчёта дала бы ${oldAnchorCount} — то есть «попытка что-то положила», хотя она ${o.mode === 'code' ? 'положила ровно один коммит' : 'не тронула ничего'}`)
  } else {
    fail(`старая точка отсчёта дала бы «${oldAnchor.out}» — расхождение не читается, контроль ничего не покажет`)
  }

  // ── (5) ЗАПИСКА РАСПОЗНАНА — утверждается ДО любого суждения о базе ──
  const parsedNote = parseApproachNote(markerLinesFrom([NOTE_FRAME], ['APPROACH_', 'LESSON_']))
  const parsedLesson = parseLessonMarker(markerLinesFrom([NOTE_FRAME], ['APPROACH_', 'LESSON_']))
  if (parsedNote && parsedNote.approach) pass(`записка о подходе ПРИНЯТА разборщиком продукта: «${parsedNote.approach}»`)
  else fail('разборщик продукта не принял записку двойника — красное было бы по посторонней причине, а не по базе')
  if (parsedLesson && parsedLesson.none) pass(`урок назван отсутствующим с причиной: «${parsedLesson.none}»`)
  else fail('маркер урока не принят — попытка покраснела бы за отсутствие урока, а не за базу')

  const journalLayers = readJournalEntries(ledgerDir, taskId)
  const approachLayer = journalLayers.find((e) => e && e.layer === 'approach' && e.attempt === 1)
  if (approachLayer) pass('САМ ДЕМОН записал слой подхода первой попытки — записка дошла до тика, а не только до нас')
  else fail('в журнале попытки нет слоя подхода — тик записку не принял')

  // ── (6) чем кончилась первая попытка ──
  const receiptRef = first.receiptRef
  const isAnswerReceipt = typeof receiptRef === 'string' && receiptRef.startsWith('answer:')
  const answered = journalEntries.filter((e) => e && e.type === 'task.answered' && e.taskId === taskId)

  if (o.expectAnswer) {
    if (first.outcome === 'completed') pass('исход первой попытки — ЗАВЕРШЕНО')
    else fail(`исход первой попытки — «${first.outcome}» (${first.failureReason || 'без причины'}), ожидалось «завершено»`)
    if (isAnswerReceipt) pass(`ссылка на квитанцию — форма ответа: ${receiptRef}`)
    else fail(`квитанция «${JSON.stringify(receiptRef)}» — не форма ответа`)
    if (answered.length === 1) pass('в журнале оператора есть строка о том, что исход прошёл МИМО гейта кода')
    else fail(`строк «ответ принят» в журнале: ${answered.length}, ожидалась одна`)
    const status = await approvalStatus(queueUrl, taskId)
    if (status === 'awaiting_approval') pass('строка встала в ожидание приёмки — ответ поехал человеку, а не в красное')
    else fail(`строка встала в «${status}», а не в ожидание приёмки`)
    if (first.base === proj.tipA) pass(`счёт вёлся ОТ ТОЧКИ ОТВОДА КОПИИ (${proj.tipA}), а не от вершины проекта`)
    else fail(`база попытки «${first.base}» не равна вершине линии А «${proj.tipA}»`)
  } else if (o.mode === 'code') {
    // Предмет второй половины — что дверь ответа для кодовой работы ЗАКРЫТА. Чем именно
    // кончился гейт кода — записывается фактом, зелёного здесь не требуется.
    const copyPath = first.worktreePath
    const commits = copyPath ? gitQuiet(['rev-list', '--count', `${first.base}..HEAD`], copyPath) : { ok: false, out: 'копия неизвестна' }
    if (commits.ok) info(`коммитов работника сверх базы копии: ${commits.out}`)
    else info(`число коммитов не спрошено: ${commits.out}`)
    if (commits.ok && commits.out === '1') pass('работник действительно положил на ветку одну фиксацию')
    else fail(`на ветке не одна фиксация (${commits.ok ? commits.out : commits.out}) — половина «с кодом» не воспроизведена`)
    if (!isAnswerReceipt) pass(`квитанции ответа НЕ выдано — квитанция: ${JSON.stringify(receiptRef ?? null)}`)
    else fail(`кодовой работе выдана квитанция ответа: ${receiptRef} — дверь ответа открылась для правок кода`)
    if (answered.length === 0) pass('строки «ответ принят» для этой задачи в журнале нет — попытка пошла в гейт кода')
    else fail(`есть ${answered.length} строк(и) «ответ принят» — исход прошёл мимо гейта кода`)
    info(`ФАКТ (без требования зелёного): гейт кода кончил попытку как «${first.outcome}»${first.failureReason ? ` / ${first.failureReason}` : ''}`)
  } else {
    // Контрольная половина: старая точка отсчёта. Дверь ответа обязана остаться закрытой.
    if (!isAnswerReceipt) pass(`на СТАРОЙ точке отсчёта дверь ответа закрыта — квитанция: ${JSON.stringify(receiptRef ?? null)}`)
    else fail(`на старой точке отсчёта дверь ответа ОТКРЫЛАСЬ (${receiptRef}) — контроль не воспроизвёл прежнее поведение`)
    info(`ФАКТ: первая попытка кончилась как «${first.outcome}»${first.failureReason ? ` / ${first.failureReason}` : ''}`)
  }

  // ── (7) ОКНО НАБЛЮДЕНИЯ — числом, и оно печатается ──
  head(`ОКНО НАБЛЮДЕНИЯ — ${o.key}`)
  info(`интервал тика: ${TICK_MS} мс (боевое значение по умолчанию — 5000 мс)`)
  info(`окно: ${WINDOW_TICKS} полных интервалов = ${(WINDOW_MS / 1000).toFixed(1)} с`)
  info('окно держится ПОСЛЕ конца первой попытки; спрошенный сразу леджер не показал бы второй попытки никогда')

  let secondSeenAfterMs = null
  const windowEnd = firstEndedAt + WINDOW_MS
  while (Date.now() < windowEnd) {
    const a = attemptsOf(ledgerDir, taskId)
    if (a.numbers.some((n) => n >= 2)) {
      secondSeenAfterMs = Date.now() - firstEndedAt
      break
    }
    await sleep(200)
  }
  const held = Math.min(Date.now() - firstEndedAt, WINDOW_MS)

  const tally = attemptsOf(ledgerDir, taskId)
  info(`строк в леджере: ${tally.rows.length}; РАЗЛИЧНЫХ попыток после дедупа: ${tally.numbers.length} (номера: ${tally.numbers.join(', ') || 'нет'})`)
  info(`окно продержано: ${(held / 1000).toFixed(1)} с`)

  if (o.requireSecondAttempt) {
    if (secondSeenAfterMs !== null) {
      pass(`КОНТРОЛЬ: вторая попытка ПОЯВИЛАСЬ через ${secondSeenAfterMs} мс после конца первой — окно достаточное, учение умеет видеть событие`)
    } else {
      fail(
        `КОНТРОЛЬ: второй попытки в окне ${(WINDOW_MS / 1000).toFixed(1)} с НЕ появилось — значит окно мало или ` +
          'учение слепое, и зелёное на вылеченном коде ничего не значит',
      )
    }
  } else if (secondSeenAfterMs === null) {
    pass(`второй попытки не заведено за окно ${(WINDOW_MS / 1000).toFixed(1)} с (${WINDOW_TICKS} интервалов тика)`)
    if (tally.numbers.length === 1) pass('различных попыток ровно одна — работа закрылась с ПЕРВОГО раза')
    else fail(`различных попыток ${tally.numbers.length}: ${tally.numbers.join(', ')}`)
  } else {
    fail(`вторая попытка появилась через ${secondSeenAfterMs} мс — ответ снова стоил лишнего запуска`)
  }

  // ── (8) уборка половины ──
  await shutdown(handles)
  await dropDb(dbName)
  return { taskId, first, tally, secondSeenAfterMs, proj, builtSpecs }
}

async function shutdown(handles) {
  try {
    if (handles && typeof handles.stop === 'function') await handles.stop()
  } catch (err) {
    info(`остановка демона сказала: ${String((err && err.message) || err)}`)
  }
}

// ── ход учения ─────────────────────────────────────────────────────────────────────

function removeDrillTree() {
  rmSync(DRILL_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function main() {
  say('=== учение выходного гейта работника: ответ без кода и работа с кодом ===')
  say(`рабочая копия: ${REPO_ROOT}`)
  say(
    CONTROL
      ? 'РЕЖИМ: КОНТРОЛЬНЫЙ — ожидается СТАРОЕ поведение, вторая попытка ОБЯЗАНА появиться'
      : 'РЕЖИМ: основной — обе половины на вылеченном коде',
  )
  say('ФОРМА ПРОГОНА: работник ПОДМЕНЁН сценарием узла (сборка аргументов запуска). Подменена')
  say('модель, а не дверь: демон, тик, git, верб провизии, перепроверка и очередь — боевые.')

  // ── (0) ПРОБЫ. Любая не прошла — выход третьим кодом с названной причиной ──
  head('ПРОБЫ ПЕРЕД СТАРТОМ')

  if (!(await probePort(QUEUE_PORT, QUEUE_HOST))) {
    notRun(`очередь Postgres ${QUEUE_HOST}:${QUEUE_PORT} не отвечает — поднять её: cd ~/pg-sandbox && node start.mjs`)
  }
  info(`очередь ${QUEUE_HOST}:${QUEUE_PORT} отвечает`)

  const ports = []
  for (let p = PORT_FIRST; p <= PORT_LAST && ports.length < 2; p += 1) {
    // eslint-disable-next-line no-await-in-loop -- пробы портов идут по одной намеренно
    if (!(await probePort(p))) ports.push(p)
  }
  if (ports.length < 2) notRun(`свободных портов в диапазоне ${PORT_FIRST}..${PORT_LAST} не нашлось — учение не отбирает чужой порт`)
  info(`свободные порты учения: ${ports.join(', ')} (7777 общий демон, 7788 соседние окна, 7802 учение приёмки — не трогаются)`)

  try {
    info(`git на месте: ${git(['--version'], REPO_ROOT)}`)
  } catch (err) {
    notRun(`git недоступен: ${String((err && err.message) || err)}`)
  }

  // ═══ МЕСТО УЧЕНИЯ ПРОВЕРЯЕТСЯ, А НЕ ПРЕДПОЛАГАЕТСЯ ═══
  // Учение разворачивает репозитории и копии работника. Оказаться этому внутри рабочего
  // дерева — своего или чужого — нельзя: каталог зависимостей рабочей копии на этой машине
  // ЯВЛЯЕТСЯ ССЫЛКОЙ в дерево основателя, и «внутри копии» физически означает «в чужом
  // дереве». Сравниваются РАСКРЫТЫЕ пути, а не написанные.
  const forbidden = [realpathSync(REPO_ROOT)]
  const common = gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir'], REPO_ROOT)
  if (common.ok) {
    try {
      forbidden.push(realpathSync(dirname(common.out)))
    } catch {
      /* нераскрываемый путь просто не попадает в список запретов */
    }
  }
  for (const tree of forbidden) {
    if (DRILL_ROOT === tree || DRILL_ROOT.startsWith(tree + sep)) {
      notRun(`место учения ${DRILL_ROOT} лежит внутри рабочего дерева ${tree} — там разворачивать репозитории нельзя`)
    }
  }
  info(`место учения: ${DRILL_ROOT} (вне рабочих деревьев: ${forbidden.join(', ')})`)

  // ── (1) уборка НА ВХОДЕ: падение посередине оставляет дерево на месте ──
  head('ПОДГОТОВКА')
  removeDrillTree()
  mkdirSync(join(DRILL_ROOT, 'double'), { recursive: true })
  writeWorkerDouble(join(DRILL_ROOT, 'double', 'worker.mjs'))
  info('дерево прошлой попытки убрано (уборка на ВХОДЕ, а не только на выходе); двойник работника записан')

  const results = {}
  try {
    if (CONTROL) {
      results.control = await runHalf({
        key: 'control',
        title: 'контроль на старой точке отсчёта',
        mode: 'answer',
        expectAnswer: false,
        requireSecondAttempt: true,
        port: ports[0],
      })
    } else {
      results.answer = await runHalf({
        key: 'bez-koda',
        title: 'работа БЕЗ кода',
        mode: 'answer',
        expectAnswer: true,
        requireSecondAttempt: false,
        port: ports[0],
      })
      results.code = await runHalf({
        key: 's-kodom',
        title: 'работа С кодом',
        mode: 'code',
        expectAnswer: false,
        requireSecondAttempt: false,
        port: ports[1],
      })
    }
  } finally {
    head('ПОСЛЕ УЧЕНИЯ')
    removeDrillTree()
    info('временные репозитории, копии работника и двойник убраны; общая очередь оставлена работать')
  }

  finish(results)
}

function finish(results) {
  head('ИТОГ')
  for (const [name, r] of Object.entries(results)) {
    if (!r) continue
    say(
      `  ${name}: задача=${r.taskId} расхождение=${r.proj.divergence} ` +
        `квитанция=${JSON.stringify(r.first.receiptRef ?? null)} ` +
        `различных попыток=${r.tally.numbers.length} ` +
        `вторая попытка=${r.secondSeenAfterMs === null ? 'не заведена' : `через ${r.secondSeenAfterMs} мс`}`,
    )
  }
  say(
    failCount === 0
      ? '\nRESULT: ЧИСТО (exit 0)'
      : `\nRESULT: БЛОКЕРЫ (exit 1) — не подтвердилось утверждений: ${failCount}`,
  )
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('УЧЕНИЕ УПАЛО:', err && err.stack ? err.stack : err)
  console.error(`Временное дерево могло остаться: ${DRILL_ROOT} — убрать руками, если оно там.`)
  process.exit(1)
})
