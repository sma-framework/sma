/**
 * live-approve-drill.mjs — УЧЕНИЕ ПРИЁМКИ. Живое нажатие кнопки «Одобрить» по сети, на
 * настоящем демоне, с настоящей очередью, настоящим git и настоящим прогоном тестов.
 *
 * ЧТО ОНО ДОКАЗЫВАЕТ, и почему этого не может доказать ни один тест:
 *
 *   КРАСНАЯ ПОЛОВИНА  — ветка работника, которая ломает сьют, ОТКАЗАНА дверью приёмки с
 *                       названной причиной «тесты красные», и слияния НЕ ПРОИЗОШЛО.
 *   ЗЕЛЁНАЯ ПОЛОВИНА  — ветка работника, которая сьют не ломает, ОДОБРЕНА, слияние
 *                       произошло, вершина дерева сдвинулась.
 *
 * Обе половины обязательны, и вторая — не украшение. Дверь, которая отказывает ВСЕГДА,
 * неотличима от двери, которая отказывает ПО СУЩЕСТВУ: сломанный прогонятель отвечает
 * «красные» на что угодно. Только зелёная половина отделяет работающий гейт от заклинившего.
 *
 * Сегодняшние тесты двери кормят её ПОДДЕЛКОЙ ритуала — они проверяют, что дверь понимает
 * форму ответа. Здесь ритуал боевой: слиятельный провод НЕ переопределяется ничем, потому
 * что у него для этого нет двери, и здесь это достоинство.
 *
 * ═══════════════════ ЧТО ПЕРЕОПРЕДЕЛЕНО, И ПОЧЕМУ ИМЕННО ЭТО ═══════════════════════
 *
 * Учение поднимает БОЕВУЮ фабрику демона (`createDaemon`) на настоящем машинном конфиге.
 * Переопределены ровно четыре вещи, и каждая — граница безопасности, а не подпорка:
 *
 *   1. СВОЙ ПОРТ. Общий демон уже слушает свой; занять его значило бы уронить чужую работу.
 *   2. СВОИ КАТАЛОГИ данных и журнала попыток — временные. Живой журнал основателя
 *      открывается только на чтение и здесь не открывается вовсе: запись в него испортила бы
 *      счёт завершённых попыток, на котором стоят чужие измерения.
 *   3. СВОЯ БАЗА ОЧЕРЕДИ на том же сервере. Очередь — общая и живая: рядом работает демон
 *      основателя, который забирает задачи из неё и запускает по ним НАСТОЯЩИХ работников.
 *      Синтетическая задача учения, положенная в общую базу, может быть взята им — это
 *      чужие деньги и чужое дерево. Отдельная база на том же сервере трогает данные общей
 *      ровно нулём, и при этом очередь остаётся настоящей: тот же движок, тот же Postgres,
 *      та же долговечная строка. База удаляется на выходе.
 *   4. НЕТ ПОДКЛЮЧЁННОГО ПРОЕКТА, и подаваемое дерево — клон (ниже). Это САМАЯ важная
 *      граница: дверь приёмки сливает в дерево ПОДКЛЮЧЁННОГО проекта, а подключённым в
 *      машинном конфиге стоит основной чекаут. Не сними этого — учение сливало бы ветку в
 *      дерево, которого не имеет права касаться.
 *
 * И одна вещь СЛОМАНА НАРОЧНО: сборщик аргументов запуска подан ложью вместо функции.
 * Тик демона спрашивает у себя, собран ли он с исполнителем, и, не найдя его, отказывает
 * задаче по имени вместо того, чтобы запустить процесс. То есть запуск живого работника
 * здесь физически недостижим — учение не может потратить ни одного токена, даже если
 * ошибётся. Конвейер вдобавок выключен в конфиге: два замка на одну дверь, потому что цена
 * промаха здесь — деньги и чужое дерево.
 *
 * ЧЕГО УЧЕНИЕ НЕ ДЕЛАЕТ И НЕ ВЫДАЁТ ЗА СДЕЛАННОЕ. Строка доводится до состояния «ждёт
 * приёмки» вызовами самой очереди (положить → взять → завершить с квитанцией) — теми же,
 * которые делает тик. Работник не запускается: предмет учения — ДВЕРЬ ПРИЁМКИ, а не путь
 * работника, и запуск живого работника ради синтетической задачи стоил бы денег и ничего
 * бы к доказательству не добавил. Сказано здесь, а не умолчано.
 *
 * ═══════════════════ ГДЕ ЛЕЖИТ КЛОН, И ПОЧЕМУ ИМЕННО ТАМ ═══════════════════════════
 *
 * Нажимают не на рабочую копию, а на её ЛОКАЛЬНЫЙ КЛОН: слияние — операция, меняющая
 * историю, и делать её в дереве, где идёт работа, нельзя.
 *
 * Клон лежит ВНЕ обоих деревьев — во временном каталоге системы, — и рядом с ним кладётся
 * ссылка `node_modules` на каталог зависимостей рабочей копии. Две части, и обе обязательны:
 *
 *   ВНЕ ДЕРЕВА — потому что по рабочей копии ходит не один только сьютер. По ней ходят
 *   сканер внутренних имён, проверка упаковки, штамп числа тестов и перепроверка рецептов.
 *   Вторая полная копия дерева ГДЕ УГОДНО внутри рабочей копии — риск для всех них сразу.
 *   Каталог зависимостей выглядит безопасным местом (его обходят все), но безопасен он лишь
 *   там, где он и вправду принадлежит этой копии. ИЗМЕРЕНО НА ЭТОЙ МАШИНЕ: `node_modules`
 *   рабочей копии — ССЫЛКА на каталог зависимостей ДРУГОГО чекаута, и клон, положенный
 *   «внутрь копии», физически оказывался внутри чужого дерева. Место, выбранное по
 *   рассуждению о том, как устроено дерево, обязано проверяться, а не предполагаться;
 *   временный каталог не зависит от того, как собрана чужая установка.
 *
 *   ССЫЛКА НА ЗАВИСИМОСТИ — потому что клон, у которого их нет, НЕ НАЙДЁТ СЬЮТЕРА. Узел
 *   ищет зависимости, поднимаясь по каталогам; от клона в чужом месте он не доходит никуда,
 *   и сьют покраснел бы ЦЕЛИКОМ. Тогда учение соврало бы в обе стороны разом: «отказ по
 *   красным тестам» стало бы неотличимо от «отказ потому что мы сломали клон», а зелёная
 *   половина не смогла бы стать зелёной вовсе. Ссылка кладётся на уровень ВЫШЕ клона, и
 *   подъём по каталогам приводит к ней сам.
 *
 * УБОРКА КЛОНА ИДЁТ НА ВХОДЕ, А НЕ ТОЛЬКО НА ВЫХОДЕ. Падение посередине и выход «НЕ
 * ПРОГНАНО» оставляют клон на месте; уборка, живущая только в конце, — это уборка, которой
 * при провале не было. Число файлов, которые видит сьютер в рабочей копии, снимается ДО и
 * ПОСЛЕ учения и обязано совпасть: разошлось — учение протекло в область поиска, и удвоенное
 * число уехало бы в чужое измерение как «факт».
 *
 * ═══════════════════ ОБЩИЙ СЛОТ СЛИЯНИЯ ═══════════════════════════════════════════
 *
 * Ритуал слияния сериализован одним общим слотом, и дверь приёмки зовёт его БЕЗ указания
 * своего каталога слотов — значит учение возьмёт тот же слот, что и любой другой терминал в
 * этой рабочей копии. Порядок жёсткий: состояние слота проверяется ДО старта; слот держит
 * кто-то другой — выход третьим кодом с названной причиной. Отбирать чужой слот учением
 * запрещено, слепая принудительная очистка запрещена тоже. Если учение упадёт посреди
 * слияния, слот останется занятым — команда освобождения печатается в сводке.
 *
 * ═══════════════════ ТРИ ИСХОДА ═══════════════════════════════════════════════════
 *
 *   код 0 — чисто: обе половины дали свой исход, все утверждения прошли;
 *   код 1 — есть блокеры: прогон СОСТОЯЛСЯ, но что-то из утверждённого не подтвердилось;
 *   код 3 — НЕ ПРОГНАНО: очередь молчит, порт занят, git недоступен, слот держит чужой.
 *
 * Третий исход — не пустой список находок, а отдельный отказ с названием причины. Прогон,
 * которого не было, никогда не считается проходом.
 *
 * Node built-ins + модули самого демона + pg. Ни одной новой зависимости.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { createDaemon } from '../daemon/src/main.mjs'
import { loadConfig } from '../daemon/src/config.mjs'
import { checkMergeClaim, MERGE_SLOT_NAME } from '../scripts/sma/lib/merge-gate.mjs'
import { resolveSuiteEntry, MERGE_SMOKE_TARGET } from '../scripts/sma/lib/merge-smoke.mjs'

// ── постоянные учения ──────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ОТКУДА БЕРЁТСЯ ДРАЙВЕР БАЗЫ. Он объявлен и установлен НЕ у корня продукта, а у демона
 * (`daemon/package.json` — «две рантаймовые зависимости демона»), и разрешение имён от этого
 * файла до `daemon/node_modules` не доходит: узел поднимается по каталогам, а `supervisor/`
 * демону не сосед по вертикали. Поэтому драйвер берётся требованием ОТ МАНИФЕСТА ДЕМОНА —
 * ровно тем же приёмом, каким прогонятель тестов находит сьютер рядом со своей установкой.
 * Ничего не устанавливается: используется то, что уже лежит в дереве демона.
 */
const requireFromDaemon = createRequire(new URL('../daemon/package.json', import.meta.url))
const pg = requireFromDaemon('pg')

/** Свой порт. Общий демон и соседняя снасть стоят на других — проба ниже это подтверждает. */
const FRONT_PORT = 7802
const FRONT_HOST = '127.0.0.1'

/** Сервер очереди — общий и живой. База — своя, создаётся и удаляется учением. */
const QUEUE_HOST = '127.0.0.1'
const QUEUE_PORT = 5433
const DRILL_DB = 'sma_approve_drill'
const ADMIN_URL = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/postgres`
const DRILL_QUEUE_URL = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/${DRILL_DB}`

/**
 * Где живёт клон, ссылка на зависимости и копия работника — вне обоих деревьев.
 * Путь берётся уже РАСКРЫТЫМ (без ссылок): проверка «мы не внутри чужого чекаута» имеет
 * смысл только над настоящим путём, а не над тем, как он написан.
 */
const DRILL_ROOT = join(realpathSync(tmpdir()), 'sma-approve-drill')
const CLONE_DIR = join(DRILL_ROOT, 'repo')
const COPIES_DIR = join(DRILL_ROOT, '.sma-worktrees')
const DEPS_LINK = join(DRILL_ROOT, 'node_modules')

/**
 * ЧТО ИМЕННО ЛОМАЕТ КРАСНАЯ ВЕТКА. Названо здесь, потому что красный по неизвестной причине
 * неотличим от красного по поломке снасти. Ветка убирает путь репозитория из подсказки
 * «как выйти из незавершённого слияния» — и падает РОВНО одно утверждение целевого сьюта,
 * то самое, которое требует, чтобы подсказка несла путь. Это не выдуманная поломка: без
 * пути подсказка перестаёт быть командой, которую можно выполнить, — «откатить можно, но не
 * видно, к чему».
 */
const RED_FILE = 'scripts/sma/lib/merge-gate.mjs'
const RED_FROM = 'выйти из него: git -C ${cwd} merge --abort'
const RED_TO = 'выйти из него: git merge --abort'
const RED_BREAKS =
  `${MERGE_SMOKE_TARGET} > «отмена, которая сама не удалась, НАЗЫВАЕТСЯ и несёт команду ` +
  'выхода» > утверждение «подсказка выхода несёт путь репозитория»'

const APPROVE_TIMEOUT_MS = 300000

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
    await sleep(400)
  }
  return false
}

/** git с массивом аргументов и без оболочки — та же дисциплина, что у ритуала слияния. */
function git(args, cwd = CLONE_DIR) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
}

function gitQuiet(args, cwd = CLONE_DIR) {
  try {
    return { ok: true, out: git(args, cwd).trim() }
  } catch (err) {
    return { ok: false, out: String((err && err.message) || err) }
  }
}

const tipOf = () => git(['rev-parse', 'HEAD']).trim()

/** Чистота ОТСЛЕЖИВАЕМОГО дерева: половина слияния видна именно здесь. */
const trackedDirty = () => git(['status', '--porcelain', '--untracked-files=no']).trim()

const mergeHeadLeft = () => gitQuiet(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok

/** Дверь по сети, с токеном. Настоящий HTTP, настоящая проверка токена. */
async function req(method, path, { token, body, timeoutMs = 30000 } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`http://${FRONT_HOST}:${FRONT_PORT}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    /* не json — тело поедет как текст */
  }
  return { status: res.status, json, text }
}

/**
 * Сколько файлов видит сьютер В РАБОЧЕЙ КОПИИ. Запуск идёт узлом, под которым мы уже
 * работаем, с абсолютным путём к точке входа сьютера: запуск менеджера пакетов по имени на
 * этой машине падает «нет такого файла», и его провал прочитался бы как «файлов ноль».
 */
function suiteFileCount() {
  const entry = resolveSuiteEntry()
  const out = String(
    execFileSync(process.execPath, [entry, 'list', '--filesOnly'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 600000,
    }),
  )
  return out.split('\n').filter((l) => l.includes('test.ts')).length
}

// ── подготовка дерева, на которое нажимают ─────────────────────────────────────────

/**
 * Клон предыдущей попытки убирается ЗДЕСЬ, на входе. Уборка в конце не спасает: третий код
 * выхода и падение посередине оставляют клон на месте.
 */
function removeDrillTree() {
  rmSync(DRILL_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function prepareClone(redTask, greenTask) {
  mkdirSync(DRILL_ROOT, { recursive: true })
  // Зависимости — ссылкой, уровнем ВЫШЕ клона: подъём по каталогам приведёт к ней сам.
  // Тип «junction» выбран потому, что на этой платформе он не требует особых прав, а
  // обычная символическая ссылка на каталог — требует.
  symlinkSync(join(REPO_ROOT, 'node_modules'), DEPS_LINK, 'junction')
  git(['clone', '--local', '--no-hardlinks', REPO_ROOT, CLONE_DIR], REPO_ROOT)
  // Своё имя фиксаций в клоне: у машины оно может быть не настроено, и тогда фиксация ветки
  // упала бы по причине, к предмету учения отношения не имеющей.
  git(['config', 'user.email', 'drill@localhost'])
  git(['config', 'user.name', 'approve drill'])
  const base = tipOf()

  // КРАСНАЯ ВЕТКА — ломает ровно одно утверждение целевого сьюта.
  git(['checkout', '-q', '-b', `wt/${redTask}`])
  const file = join(CLONE_DIR, RED_FILE)
  const before = readFileSync(file, 'utf8')
  const after = before.replace(RED_FROM, RED_TO)
  if (after === before) {
    notRun(
      `в клоне не нашлось строки, которую ломает красная ветка (${RED_FILE}) — ` +
        'снасть рассчитана на другой текст, и «красный» получился бы по неизвестной причине',
    )
  }
  writeFileSync(file, after)
  git(['commit', '-q', '-m', 'drill: the unfinished-merge hint loses the repository path', '--', RED_FILE])

  // ЗЕЛЁНАЯ ВЕТКА — от той же базы, ничего в сьюте не задевает.
  git(['checkout', '-q', base])
  git(['checkout', '-q', '-b', `wt/${greenTask}`])
  const note = 'drill-green-note.md'
  writeFileSync(join(CLONE_DIR, note), '# зелёная половина учения\n\nБезобидная правка, сьюта не касается.\n')
  git(['add', '--', note])
  git(['commit', '-q', '-m', 'drill: a harmless note the suite never reads', '--', note])

  // Возврат на ветку, в которую сливает приёмка.
  git(['checkout', '-q', base])
  git(['checkout', '-q', '-B', 'trunk'])
  return base
}

/**
 * Копия работника — на своём месте по боевой раскладке (соседний каталог `.sma-worktrees`,
 * а не внутри дерева). Она нужна не для красоты: утверждение «копия при отказе НЕ убрана»
 * иначе прошло бы по пустому месту и не проверило бы ничего.
 */
function makeWorkerCopy(taskId) {
  const path = join(COPIES_DIR, taskId)
  git(['worktree', 'add', '--quiet', path, `wt/${taskId}`])
  return path
}

// ── очередь учения ─────────────────────────────────────────────────────────────────

async function ensureDrillDb() {
  const client = new pg.Client({ connectionString: ADMIN_URL })
  await client.connect()
  try {
    // Кодировка задаётся ЯВНО: `initdb` по умолчанию на этой платформе делает базу, в
    // которой название задачи кириллицей не хранится, и учение получило бы красноту,
    // к предмету отношения не имеющую.
    await client.query(`CREATE DATABASE ${DRILL_DB} TEMPLATE template0 ENCODING 'UTF8'`)
    info(`создана отдельная база очереди ${DRILL_DB} (общая база учением не открывается)`)
  } catch (err) {
    if (err && err.code === '42P04') info(`база ${DRILL_DB} осталась с прошлой попытки — переиспользована`)
    else {
      await client.end()
      throw err
    }
  }
  await client.end()
}

async function dropDrillDb() {
  try {
    const client = new pg.Client({ connectionString: ADMIN_URL })
    await client.connect()
    try {
      await client.query(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`)
      info(`база учения ${DRILL_DB} удалена; общая очередь оставлена работать`)
    } finally {
      await client.end()
    }
  } catch (err) {
    info(`база учения не удалилась: ${String((err && err.message) || err)} — удалить руками: DROP DATABASE ${DRILL_DB}`)
  }
}

/** Статус строки в собственной таблице приёмки демона — правда, а не её пересказ. */
async function approvalStatus(taskId) {
  const client = new pg.Client({ connectionString: DRILL_QUEUE_URL })
  await client.connect()
  try {
    const r = await client.query('SELECT status FROM sma_task_attempts WHERE id = $1', [taskId])
    return r.rows[0] ? r.rows[0].status : null
  } finally {
    await client.end()
  }
}

/**
 * Довести строку до состояния «ждёт приёмки» вызовами самой очереди — теми же, что делает
 * тик: положить → взять → завершить с квитанцией. Работник не запускается (см. шапку).
 */
async function parkAwaitingApproval(adapter, taskId, title) {
  await adapter.enqueue({ id: taskId, source: 'roster', title, lane: 'prod' })
  const claimed = await adapter.claimNext('drill-worker', { lanes: ['prod'] })
  if (!claimed || claimed.id !== taskId) {
    return { ok: false, why: `очередь отдала не ту строку: ${claimed ? claimed.id : 'ничего'}` }
  }
  await adapter.complete(taskId, { receiptRef: `drill:${taskId}`, workerId: 'drill-worker', provider: 'claude' })
  const status = await approvalStatus(taskId)
  return status === 'awaiting_approval' ? { ok: true } : { ok: false, why: `строка встала в «${status}», а не в ожидание приёмки` }
}

// ── половины учения ────────────────────────────────────────────────────────────────

async function redHalf(adapter, token, taskId) {
  head(`КРАСНАЯ ПОЛОВИНА — ${taskId}`)
  info(`ломается: ${RED_BREAKS}`)

  const parked = await parkAwaitingApproval(adapter, taskId, 'учение приёмки: красная ветка')
  if (!parked.ok) {
    fail(`строка не дошла до ожидания приёмки: ${parked.why} — это находка, а не повод подгонять состояние руками`)
    return
  }
  pass('строка стоит в ожидании приёмки (состояние прочитано в таблице приёмки демона)')

  const copyPath = makeWorkerCopy(taskId)
  if (existsSync(copyPath)) pass(`копия работника существует ДО нажатия: ${copyPath}`)
  else {
    fail('копии работника нет — утверждение «копия не убрана» прошло бы по пустому месту')
    return
  }

  const tipBefore = tipOf()
  const branchTip = git(['rev-parse', `wt/${taskId}`]).trim()
  const dirtyBefore = trackedDirty()
  info(`вершина клона до нажатия: ${tipBefore}; вершина ветки работника: ${branchTip}`)
  if (dirtyBefore !== '') info(`внимание: дерево клона было не чисто ДО нажатия: ${dirtyBefore}`)

  const t = Date.now()
  const res = await req('POST', '/api/approve', { token, body: { taskId }, timeoutMs: APPROVE_TIMEOUT_MS })
  info(`ответ двери за ${Date.now() - t} мс: HTTP ${res.status} ${res.text.slice(0, 400)}`)
  const b = res.json || {}

  if (res.status === 200) pass('дверь ответила по сети (HTTP 200)')
  else fail(`дверь ответила HTTP ${res.status}`)

  if (b.ok === false) pass('НЕ ОДОБРЕНО (ok:false)')
  else fail(`дверь одобрила красную ветку (ok:${JSON.stringify(b.ok)}) — это провал главного критерия`)

  if (b.reasonCode === 'tests_red') pass(`код причины — «tests_red»`)
  else fail(`код причины «${b.reasonCode}», ожидался «tests_red»`)

  if (typeof b.reason === 'string' && /тест/i.test(b.reason)) pass(`слово ответа говорит про тесты: «${b.reason}»`)
  else fail(`ответ не говорит про тесты: «${b.reason}»`)

  if (b.merged === false) pass('дверь сказала: слияния не было (merged:false)')
  else fail(`дверь сказала merged:${JSON.stringify(b.merged)}`)

  const receipt = b.receipt || {}
  if (receipt.testsPassed === false) pass('квитанция ритуала несёт красный прогон (testsPassed:false)')
  else fail(`квитанция несёт testsPassed:${JSON.stringify(receipt.testsPassed)}`)
  if (receipt.refused === true) pass('квитанция названа отказом (refused:true)')
  else info(`квитанция: ${JSON.stringify(receipt).slice(0, 300)}`)

  // ═══ И ГЛАВНОЕ — СЛОВО ОТВЕТА ПРОВЕРЯЕТСЯ ДЕРЕВОМ, А НЕ ПРИНИМАЕТСЯ НА ВЕРУ ═══
  const tipAfter = tipOf()
  info(`вершина клона после нажатия: ${tipAfter}`)
  if (tipAfter === tipBefore) pass('ВЕРШИНА КЛОНА НЕ СДВИНУЛАСЬ — ветка осталась невлитой')
  else fail(`вершина сдвинулась ${tipBefore} -> ${tipAfter} — слияние ПРОИЗОШЛО вопреки ответу`)

  const ancestor = gitQuiet(['merge-base', '--is-ancestor', branchTip, 'HEAD'])
  if (!ancestor.ok) pass(`работа работника (${branchTip}) НЕ содержится в дереве приёмки — спрошено у git`)
  else fail(`работа работника (${branchTip}) оказалась в дереве приёмки — слияние ПРОИЗОШЛО`)

  const dirtyAfter = trackedDirty()
  if (dirtyAfter === '') pass('рабочее дерево клона чистое — половины слияния не осталось')
  else fail(`дерево клона не чисто после отказа:\n${dirtyAfter}`)

  if (!mergeHeadLeft()) pass('следа незавершённого слияния нет (MERGE_HEAD отсутствует)')
  else fail('клон остался в НЕЗАВЕРШЁННОМ слиянии — выйти: git -C <клон> merge --abort')

  const status = await approvalStatus(taskId)
  if (status === 'awaiting_approval') pass('строка вернулась в ожидание приёмки')
  else fail(`строка встала в «${status}», а не вернулась в ожидание приёмки`)

  if (existsSync(copyPath)) pass('копия работника НЕ убрана — работу есть где доделать')
  else fail('копия работника убрана при отказе — доделывать работу негде')
}

async function greenHalf(adapter, token, taskId) {
  head(`ЗЕЛЁНАЯ ПОЛОВИНА — ${taskId}`)

  const parked = await parkAwaitingApproval(adapter, taskId, 'учение приёмки: зелёная ветка')
  if (!parked.ok) {
    fail(`строка не дошла до ожидания приёмки: ${parked.why}`)
    return
  }
  pass('строка стоит в ожидании приёмки')

  makeWorkerCopy(taskId)
  const tipBefore = tipOf()
  // Вершина ВЕТКИ работника запоминается ДО нажатия: одобренная приёмка уносит с собой и
  // копию, и саму ветку, поэтому спросить потом «содержится ли ветка» будет уже не у чего —
  // имени не останется. Отпечаток остаётся всегда.
  const branchTip = git(['rev-parse', `wt/${taskId}`]).trim()
  info(`вершина клона до нажатия: ${tipBefore}; вершина ветки работника: ${branchTip}`)

  const t = Date.now()
  const res = await req('POST', '/api/approve', { token, body: { taskId }, timeoutMs: APPROVE_TIMEOUT_MS })
  info(`ответ двери за ${Date.now() - t} мс: HTTP ${res.status} ${res.text.slice(0, 600)}`)
  const b = res.json || {}

  if (b.ok === true) pass('ОДОБРЕНО (ok:true)')
  else fail(`зелёная ветка не одобрена: ok:${JSON.stringify(b.ok)} reasonCode:${b.reasonCode} reason:${b.reason}`)

  if (b.merged === true) pass('дверь сказала: слияние произошло (merged:true)')
  else fail(`дверь сказала merged:${JSON.stringify(b.merged)}`)

  const receipt = b.receipt || {}
  if (receipt.testsPassed === true) pass('в квитанции про тесты сказано «зелёные» (testsPassed:true)')
  else fail(`квитанция несёт testsPassed:${JSON.stringify(receipt.testsPassed)} — прогон не был зелёным ПО СУЩЕСТВУ`)

  const tipAfter = tipOf()
  info(`вершина клона после нажатия: ${tipAfter}`)
  if (tipAfter !== tipBefore) pass(`ВЕРШИНА КЛОНА СДВИНУЛАСЬ ${tipBefore} -> ${tipAfter}`)
  else fail('вершина не сдвинулась — слияния не было')

  if (receipt.resultSha) pass(`квитанция несёт отпечаток слияния: ${receipt.resultSha}`)
  else fail('квитанция без отпечатка слияния')

  const ancestor = gitQuiet(['merge-base', '--is-ancestor', branchTip, 'HEAD'])
  if (ancestor.ok) pass(`работа работника (${branchTip}) содержится в дереве приёмки — спрошено у git`)
  else fail(`работы работника (${branchTip}) нет в дереве приёмки: ${ancestor.out}`)

  const status = await approvalStatus(taskId)
  if (status === 'approved') pass('строка перешла в «одобрено»')
  else fail(`строка встала в «${status}», а не в «одобрено»`)

  if (b.cleanup) info(`уборка копии сказала: ${JSON.stringify(b.cleanup).slice(0, 300)}`)
  if (b.harvest) info(`сбор памяти сказал: ${JSON.stringify(b.harvest).slice(0, 300)}`)
}

// ── ход учения ─────────────────────────────────────────────────────────────────────

async function main() {
  say('=== учение приёмки: отказ по красным тестам и зеркальный зелёный ===')
  say(`рабочая копия: ${REPO_ROOT}`)

  // ── (0) ПРОБЫ. Любая не прошла — выход третьим кодом с названной причиной ──
  head('ПРОБЫ ПЕРЕД СТАРТОМ')

  if (!(await probePort(QUEUE_PORT, QUEUE_HOST))) {
    notRun(`очередь Postgres ${QUEUE_HOST}:${QUEUE_PORT} не отвечает — поднять её: cd ~/pg-sandbox && node start.mjs`)
  }
  info(`очередь ${QUEUE_HOST}:${QUEUE_PORT} отвечает`)

  if (await probePort(FRONT_PORT)) {
    notRun(`порт учения ${FRONT_PORT} занят — его кто-то держит; учение не отбирает чужой порт`)
  }
  info(`порт учения ${FRONT_PORT} свободен`)

  try {
    info(`git на месте: ${git(['--version'], REPO_ROOT).trim()}`)
  } catch (err) {
    notRun(`git недоступен: ${String((err && err.message) || err)}`)
  }

  // ═══ МЕСТО КЛОНА ПРОВЕРЯЕТСЯ, А НЕ ПРЕДПОЛАГАЕТСЯ ═══════════════════════════════
  //
  // Учение разворачивает полный клон и несколько копий работника. Оказаться этому внутри
  // рабочего дерева — чужого или своего — нельзя: по дереву ходят сканеры, которые сочтут
  // копию частью продукта. Каталог рабочей копии может быть собран ссылками на чужой
  // чекаут (здесь так и есть), поэтому сравниваются РАСКРЫТЫЕ пути, а не написанные.
  const forbidden = [realpathSync(REPO_ROOT)]
  const common = gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir'], REPO_ROOT)
  if (common.ok) forbidden.push(realpathSync(dirname(common.out)))
  for (const tree of forbidden) {
    if (DRILL_ROOT === tree || DRILL_ROOT.startsWith(tree + sep)) {
      notRun(`место учения ${DRILL_ROOT} лежит внутри рабочего дерева ${tree} — там разворачивать клон нельзя`)
    }
  }
  info(`место учения: ${DRILL_ROOT} (вне рабочих деревьев: ${forbidden.join(', ')})`)

  // Слот слияния — ОБЩИЙ. Чужой держатель означает выход, а не отбор.
  const slot = checkMergeClaim({})
  if (slot.live) {
    notRun(
      `общий слот «${MERGE_SLOT_NAME}» держит ${slot.who}${slot.since ? ` (с ${slot.since})` : ''} — ` +
        'учение не отбирает чужой слот и не чистит его вслепую; дождитесь конца чужого слияния',
    )
  }
  if (slot.stale) {
    notRun(
      `общий слот «${MERGE_SLOT_NAME}» держит ЗАВИСШАЯ запись (${slot.who}, с ${slot.since}) — ` +
        'решает человек: убедитесь, что держатель мёртв, и снимите вручную: ' +
        `node scripts/sma/cli.mjs force-clear ${MERGE_SLOT_NAME}`,
    )
  }
  info(`общий слот «${MERGE_SLOT_NAME}» свободен`)

  // ── (1) УБОРКА КЛОНА НА ВХОДЕ + число файлов сьютера ДО ──
  head('ПОДГОТОВКА')
  removeDrillTree()
  info('клон предыдущей попытки убран (уборка на ВХОДЕ, а не только на выходе)')

  const filesBefore = suiteFileCount()
  info(`файлов видит сьютер ДО учения: ${filesBefore}`)

  const stamp = Date.now()
  const redTask = `drill-red-${stamp}`
  const greenTask = `drill-green-${stamp}`

  const base = prepareClone(redTask, greenTask)
  info(`клон: ${CLONE_DIR}`)
  info(`база клона: ${base}; ветки: wt/${redTask} (красная), wt/${greenTask} (зелёная)`)

  await ensureDrillDb()

  // ── (2) БОЕВАЯ ФАБРИКА ДЕМОНА, четыре границы и один нарочно сломанный исполнитель ──
  head('ДЕМОН')
  const machine = loadConfig()
  const dataDir = join(DRILL_ROOT, 'data')
  const ledgerDir = join(DRILL_ROOT, 'ledger')
  const config = {
    ...machine,
    port: FRONT_PORT,
    bind: FRONT_HOST,
    queueUrl: DRILL_QUEUE_URL,
    dataDir,
    ledgerDir,
    repoDir: CLONE_DIR,
    // Ни одного подключённого проекта: дверь приёмки сливает в дерево подключённого
    // проекта, а в машинном конфиге им стоит чужой чекаут.
    projects: [],
    activeProject: null,
    pipeline: { enabled: false },
  }
  const token = config.token
  info(`порт ${FRONT_HOST}:${FRONT_PORT}; данные ${dataDir}; журнал попыток ${ledgerDir}`)
  info(`подключённых проектов нет; дерево приёмки — клон ${CLONE_DIR}`)

  const handles = createDaemon({
    config,
    dataDir,
    ledgerDir,
    // Сборщик аргументов запуска подан ложью вместо функции: демон отвечает «задачу некому
    // запустить» вместо запуска процесса. Живой работник здесь недостижим физически.
    buildArgs: false,
  })

  if (typeof handles.tickDeps.buildArgs !== 'function') {
    info('исполнитель нарочно не собран — учение не может запустить живого работника')
  } else {
    notRun('исполнитель оказался собран — учение отказывается работать там, где может стоить денег')
  }
  if (typeof handles.front.deps.mergeTestRunner === 'function') {
    info('дверь приёмки собрана с БОЕВЫМ прогонятелем тестов (спрошено у собранного объекта)')
  } else {
    fail('у двери приёмки нет прогонятеля — отказ по красным тестам был бы недостижим')
  }

  await handles.start()
  const up = await waitForPort(FRONT_PORT, FRONT_HOST, Date.now() + 20000)
  if (!up) {
    await shutdown(handles)
    notRun(`дверь так и не начала слушать ${FRONT_HOST}:${FRONT_PORT}`)
  }
  info('демон поднят, дверь слушает')

  const noAuth = await req('POST', '/api/approve', { body: { taskId: 'x' } })
  if (noAuth.status === 401 || noAuth.status === 403) pass(`нажатие БЕЗ токена -> ${noAuth.status} (дверь заперта)`)
  else fail(`нажатие без токена вернуло ${noAuth.status}, ожидались 401/403`)

  // ── (3) ОБЕ ПОЛОВИНЫ ──
  try {
    await redHalf(handles.adapter, token, redTask)
    await greenHalf(handles.adapter, token, greenTask)
  } finally {
    await shutdown(handles)
  }

  // ── (4) ЧИСЛО ФАЙЛОВ СЬЮТЕРА ПОСЛЕ — клон обязан быть невидим ──
  head('ПОСЛЕ УЧЕНИЯ')
  removeDrillTree()
  info('клон и копии работников убраны')
  await dropDrillDb()

  const filesAfter = suiteFileCount()
  if (filesAfter === filesBefore) pass(`файлов видит сьютер ПОСЛЕ: ${filesAfter} — столько же, сколько до`)
  else fail(`файлов видит сьютер ПОСЛЕ: ${filesAfter}, а до было ${filesBefore} — клон протёк в область поиска`)

  finish()
}

async function shutdown(handles) {
  try {
    if (handles && typeof handles.stop === 'function') await handles.stop()
  } catch (err) {
    info(`остановка демона сказала: ${String((err && err.message) || err)}`)
  }
  info('демон остановлен; общая очередь оставлена работать — её используют соседние окна')
}

function finish() {
  const slot = checkMergeClaim({})
  if (slot.live || slot.stale) {
    say(
      `\nВНИМАНИЕ: общий слот «${MERGE_SLOT_NAME}» остался занят (${slot.who}). ` +
        `Освободить, убедившись, что держатель мёртв: node scripts/sma/cli.mjs force-clear ${MERGE_SLOT_NAME}`,
    )
  } else {
    say(`\nобщий слот «${MERGE_SLOT_NAME}» свободен`)
  }
  say(
    failCount === 0
      ? '\nRESULT: ЧИСТО (exit 0) — отказ по красным тестам наблюдён живьём, зеркальный зелёный получен.'
      : `\nRESULT: БЛОКЕРЫ (exit 1) — не подтвердилось утверждений: ${failCount}`,
  )
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('УЧЕНИЕ УПАЛО:', err && err.stack ? err.stack : err)
  console.error(
    `Если падение пришлось на середину слияния — общий слот мог остаться занятым. Проверить и, ` +
      `убедившись, что держатель мёртв, снять: node scripts/sma/cli.mjs force-clear ${MERGE_SLOT_NAME}`,
  )
  process.exit(1)
})
