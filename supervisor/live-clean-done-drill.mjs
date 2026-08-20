/**
 * live-clean-done-drill.mjs — УЧЕНИЕ ЧИСТОГО ЗАВЕРШЕНИЯ. Живой демон, живой тик, живой git,
 * живая очередь. Предмет — КВИТАНЦИЯ, С КОТОРОЙ ПОПЫТКА ВЫХОДИТ В «ЗАВЕРШЕНО».
 *
 * ═══ ЧТО ИМЕННО ПРЕДЪЯВЛЯЕТСЯ ═══════════════════════════════════════════════════
 *
 * «Завершено» бывает двух видов, и их разница — не косметика:
 *
 *   С ОГОВОРКОЙ  — ссылка на квитанцию несёт признак «не перепроверено» и причину словами.
 *                  Работа сделана, но НИЧТО В НЕЙ НЕ УДОСТОВЕРЕНО: либо в дереве уже были
 *                  красные рецепты до начала попытки, либо рецептов там нет вовсе.
 *   БЕЗ ОГОВОРКИ — признака «не перепроверено» нет: до попытки в дереве не было ни одного
 *                  красного рецепта, попытка положила коммиты, и ни один рецепт не покраснел.
 *                  Это и есть чистое завершение.
 *
 * На живом леджере (12.08–19.08.2026) чистых завершений НОЛЬ из тридцати четырёх. Причина —
 * не в двери приёмки: шестнадцать попыток закрыты формой ответа (работа без кода, для неё
 * чистое завершение недостижимо ПО ОПРЕДЕЛЕНИЮ — перепроверять нечего), пятнадцать несут
 * оговорку о предсуществующих красных рецептах, три — об отсутствии рецептов в дереве.
 *
 * ЭТО УЧЕНИЕ ПРЕДЪЯВЛЯЕТ ПЕРВОЕ ЧИСТОЕ ЗАВЕРШЕНИЕ — на дереве, где рецепты ЗЕЛЁНЫЕ, работой
 * С КОДОМ, и печатает строку леджера целиком.
 *
 * ═══ ПОЧЕМУ ПОЛОВИН ДВЕ ═════════════════════════════════════════════════════════
 *
 * Учение, которое никогда не видело ОГОВОРКИ, не может утверждать её отсутствие: половина,
 * печатающая «оговорки нет», обязана уметь напечатать «оговорка есть» — иначе она слепая и
 * зелёное в ней ничего не стоит.
 *
 *   ПОЛОВИНА «ЧИСТО»    — дерево с одним ЗЕЛЁНЫМ рецептом. Ожидание: завершено, оговорки НЕТ,
 *                         причина «нового красного не появилось», красных до = 0.
 *   ПОЛОВИНА «С КРАСНЫМ» — то же дерево плюс рецепт, который РЕАЛЬНО разошёлся (снасть
 *                         переписана после того, как отпечаток снят, — ровно так рецепты
 *                         краснеют в жизни). Ожидание ПЕРЕВЁРНУТОЕ: завершено, но С ОГОВОРКОЙ
 *                         и причиной «только предсуществующие красные». Не появилась оговорка
 *                         — блокер, а не проход.
 *
 * Обе половины делают ОДНУ И ТУ ЖЕ работу с кодом. Разница между ними — ровно одна: было ли
 * в дереве красное ДО начала попытки. Поэтому разница вердиктов приписывается ей, а не удаче.
 *
 * ═══ ДЕРЕВО ГОТОВИТСЯ ЧЕСТНО, А НЕ ПОДГОНЯЕТСЯ ══════════════════════════════════
 *
 * Отпечаток рецепта берётся ВЕРБОМ СНЯТИЯ ОТПЕЧАТКА самого продукта, а не выдумывается: учение
 * не имеет права написать в рецепт число, которого не измерило. Команда рецепта проходит
 * границу безопасных форм продукта (она пускает запуск узла из каталога снастей проекта) —
 * граница ПРОЧИТАНА в модуле предсказаний, а не угадана.
 *
 * И ПЕРЕД ПОПЫТКОЙ ДЕРЕВО ПРОВЕРЯЕТСЯ: перепроверка обязана назвать ноль расхождений (в
 * половине «чисто») и хотя бы один зелёный рецепт. Дерево, в котором уже есть красное там,
 * где его быть не должно, для этого критерия НЕ ГОДИТСЯ — учение говорит это третьим кодом и
 * останавливается. Подгонять ожидание под то, что получилось, нельзя.
 *
 * ═══ ЧЕМ ЗАМЕНЁН РАБОТНИК — СКАЗАНО ПРЯМО ══════════════════════════════════════
 *
 * МОДЕЛЬ ПОДМЕНЕНА СЦЕНАРИЕМ УЗЛА — той же формой, что у соседнего учения выходного гейта.
 * Сборка аргументов запуска собирает не языковую модель, а маленький сценарий: он делает ОДНУ
 * фиксацию, не трогая снасть, за которую отвечает рецепт, и печатает записку о подходе в том
 * кадре, в каком её печатает настоящая сессия. Подписка не тратится ни на цент.
 *
 * ПОДМЕНЕНА МОДЕЛЬ, А НЕ ДВЕРЬ. Предмет проверки — гейт кода в цикле тика — здесь боевой:
 * настоящая фабрика демона, настоящий git, настоящий верб провизии копии, НАСТОЯЩАЯ
 * ПЕРЕПРОВЕРКА (оба снимка, до и после), настоящий леджер (свой, временный), настоящая
 * очередь Postgres (своя база).
 *
 * ЧТО ЕЩЁ ПЕРЕОПРЕДЕЛЕНО, и каждое — граница безопасности:
 *   1. СВОЙ ПОРТ (проба ниже): 7777 — общий демон человека, 7788 — соседние окна,
 *      7802–7804 — соседние учения. Учение их не отбирает.
 *   2. СВОИ каталоги данных и леджера — временные. ЖИВОЙ ЛЕДЖЕР ЧЕЛОВЕКА НЕ ОТКРЫВАЕТСЯ И НЕ
 *      ПИШЕТСЯ: запись в него испортила бы счёт завершённых попыток, на котором стоит
 *      утверждение «чистых ноль из тридцати четырёх».
 *   3. СВОЯ БАЗА ОЧЕРЕДИ на общем сервере: синтетическая задача в общей базе может быть взята
 *      живым демоном — это чужие деньги и чужое дерево. База создаётся и удаляется учением.
 *   4. НЕТ ПОДКЛЮЧЁННОГО ПРОЕКТА; подаваемое тику дерево — временный репозиторий.
 *   5. ЗЕРКАЛО ЛИЧНОГО СЛОЯ и УБОРЩИК ЧУЖИХ КОПИЙ — пустышки, РЕЕСТР СЕРВЕРОВ пуст: все трое
 *      ходят по деревьям, которые учению не принадлежат.
 *   6. ПУТЬ К ПРОДУКТОВОМУ CLI сделан абсолютным: тик зовёт верб относительно каталога
 *      подключённого проекта, а временный репозиторий — не установка продукта. Верб, его
 *      аргументы и каталог запуска не тронуты; абсолютным сделан только путь к файлу.
 *
 * ═══ ТРИ ИСХОДА ════════════════════════════════════════════════════════════════
 *
 *   код 0 — чисто: обе половины подтвердили своё ожидание;
 *   код 1 — блокеры: прогон СОСТОЯЛСЯ, но что-то из утверждённого не подтвердилось;
 *   код 3 — НЕ ПРОГНАНО: очередь молчит, порт занят, git недоступен, дерево не годится.
 *
 * Прогон, которого не было, никогда не считается проходом.
 *
 * Node built-ins + модули самого демона + pg. Ни одной новой зависимости.
 */

import { execFile, execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

import { createDaemon } from '../daemon/src/main.mjs'
import { loadConfig } from '../daemon/src/config.mjs'
// Счёт попыток делает ТОТ ЖЕ складыватель, что и продукт: леджер пишет две строки на одну
// попытку, и посчитанные строки — это число писателей, а не число попыток.
import { readAttempts, foldAttemptRows, readJournalEntries } from '../daemon/src/queue/attempt-ledger.mjs'
// ГРАНИЦА БЕЗОПАСНЫХ КОМАНД ЧИТАЕТСЯ, А НЕ УГАДЫВАЕТСЯ. Команда рецепта, не прошедшая её,
// не была бы запущена вовсе, и учение мерило бы «пропущено», выдавая это за зелёный рецепт.
import { isSafeCommand } from '../scripts/sma/lib/predict.mjs'

// ── постоянные учения ──────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Драйвер базы — требованием ОТ МАНИФЕСТА ДЕМОНА; ничего не устанавливается. */
const requireFromDaemon = createRequire(new URL('../daemon/package.json', import.meta.url))
const pg = requireFromDaemon('pg')

/** Свои порты. 7777 — общий демон, 7788 — соседние окна, 7802–7804 — соседние учения. */
const PORT_FIRST = 7805
const PORT_LAST = 7830
const FRONT_HOST = '127.0.0.1'

/** Сервер очереди — общий и живой. Базы — свои, создаются и удаляются учением. */
const QUEUE_HOST = '127.0.0.1'
const QUEUE_PORT = 5433
const ADMIN_URL = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/postgres`

/**
 * Место учения — ВНЕ рабочих деревьев. Путь берётся уже раскрытым: в этих копиях каталог
 * зависимостей и часть каталогов приложения — ССЫЛКИ в чужое дерево, и проверка «мы не внутри
 * чужого чекаута» имеет смысл только над настоящим путём. Проба ниже падает третьим кодом.
 */
const DRILL_ROOT = join(realpathSync(tmpdir()), 'sma-clean-done-drill')

/** Куда откладывается леджер учения, чтобы строку можно было открыть ПОСЛЕ уборки. */
const KEEP_ROOT = join(realpathSync(tmpdir()), 'sma-clean-done-drill-ledger')

/** Интервал тика учения. Боевое значение по умолчанию — 5000 мс. */
const TICK_MS = 1000

/** Сколько ждать конца попытки, прежде чем сказать «не прогнано». */
const ATTEMPT_TIMEOUT_MS = 240000

/** Путь к продуктовому CLI в том виде, в каком его зовёт тик (относительно проекта). */
const CLI_REL = 'scripts/sma/cli.mjs'
const CLI_ABS = join(REPO_ROOT, CLI_REL)

/** Команды рецептов временного дерева. Обе обязаны пройти границу безопасных форм. */
const CMD_GREEN = 'node scripts/sma/drill-green.mjs'
const CMD_DRIFT = 'node scripts/sma/drill-drift.mjs'

/**
 * КОМАНДА, КОТОРОЙ ТО ЖЕ САМОЕ СПРАШИВАЕТСЯ У ЖИВОГО ЛЕДЖЕРА — целиком, а не многоточием:
 * число без команды, которой оно добыто, фактом не считается. Только чтение; дедуп по паре
 * «задача + номер попытки», потому что на одну попытку леджер пишет две строки.
 */
const LIVE_LEDGER_TALLY = String.raw`node -e "const{readdirSync,readFileSync}=require('fs');const{join}=require('path');const d=process.argv[1];const m=new Map();for(const f of readdirSync(d))if(f.endsWith('.jsonl')&&!f.endsWith('.journal.jsonl'))for(const l of readFileSync(join(d,f),'utf8').split(/\r?\n/)){if(!l.trim())continue;let r;try{r=JSON.parse(l)}catch{continue}if(!r.outcome)continue;const k=r.taskId+'#'+r.attempt;if(!m.has(k))m.set(k,r)}const c=[...m.values()].filter(r=>r.outcome==='completed');const clean=c.filter(r=>(typeof r.receiptRef==='string'&&r.receiptRef.startsWith('reverify:'))||(r.receiptRef&&typeof r.receiptRef==='object'&&r.receiptRef.unverified!==true));console.log('различных завершённых',m.size,'из них completed',c.length,'ЧИСТЫХ',clean.length)" ~/.sma-daemon/ledger`

/** Записка работника — ровно те строки, которые печатает двойник. */
const NOTE_APPROACH = 'APPROACH_NOTE: положил одну фиксацию в своей копии, снасть рецепта не трогал'
const NOTE_LESSON = 'LESSON_NONE: разовая правка учения, обобщать нечего'

/** Кадр, в котором живут обе строки: слова работника лежат ВНУТРИ кадра сессии. */
const NOTE_FRAME = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: `${NOTE_APPROACH}\n${NOTE_LESSON}` }] },
})

// ── печать и счёт ──────────────────────────────────────────────────────────────────

let failCount = 0
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

/** Продуктовый CLI, запущенный В КАТАЛОГЕ ВРЕМЕННОГО ДЕРЕВА. */
function cli(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [CLI_ABS, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    return { ok: true, out: String(out) }
  } catch (err) {
    return { ok: false, out: String((err && err.stdout) || ''), error: String((err && err.message) || err) }
  }
}

/** Последняя непустая строка вывода — контракт верба снятия отпечатка. */
function lastLine(s) {
  const rows = String(s || '')
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean)
  return rows.length ? rows[rows.length - 1] : ''
}

/**
 * ОТПЕЧАТОК РЕЦЕПТА СНИМАЕТСЯ ВЕРБОМ ПРОДУКТА. Число, написанное в рецепт мимо этого верба,
 * было бы выдумкой, а рецепт с выдуманным отпечатком краснеет всегда и ничего не измеряет.
 */
function receiptHash(command, cwd) {
  if (!isSafeCommand(command)) {
    notRun(`команда рецепта «${command}» не проходит границу безопасных форм продукта — она не была бы запущена вовсе`)
  }
  const r = cli(['receipt-hash', command, '--cwd', cwd], cwd)
  const sha = lastLine(r.out)
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    notRun(`верб снятия отпечатка не назвал отпечаток для «${command}»: ${r.error || r.out || 'пустой вывод'}`)
  }
  return sha
}

/** Счёт рецептов дерева одним вердиктом. Верб всегда выходит нулём в этой форме. */
function reverifyCount(treeDir, verdict) {
  const r = cli(['reverify', '--tree', '.', '--count', verdict], treeDir)
  const n = Number.parseInt(lastLine(r.out), 10)
  return Number.isFinite(n) ? n : NaN
}

// ── временное дерево с рецептами ───────────────────────────────────────────────────

/**
 * Репозиторий учения: снасть, рецепт на неё и (в половине «с красным») вторая снасть, чей
 * рецепт РЕАЛЬНО разошёлся — отпечаток снят с одного вывода, а в дереве лежит другой. Именно
 * так рецепты краснеют в жизни: работа давно закончена, снасть уехала, рецепт остался.
 */
function buildProject(dir, { withRedRecipe }) {
  mkdirSync(join(dir, 'scripts', 'sma'), { recursive: true })
  mkdirSync(join(dir, '.planning', 'phases', 'uchenie'), { recursive: true })
  git(['init', '-q', '-b', 'main', '.'], dir)
  git(['config', 'user.email', 'drill@localhost'], dir)
  git(['config', 'user.name', 'clean done drill'], dir)

  writeFileSync(join(dir, 'readme.md'), 'учение чистого завершения\n')
  writeFileSync(
    join(dir, 'scripts', 'sma', 'drill-green.mjs'),
    "process.stdout.write('РЕЦЕПТ УЧЕНИЯ: постоянный вывод, версия один\\n')\n",
  )
  git(['add', '--', 'readme.md', 'scripts/sma/drill-green.mjs'], dir)
  if (withRedRecipe) {
    writeFileSync(
      join(dir, 'scripts', 'sma', 'drill-drift.mjs'),
      "process.stdout.write('СНАСТЬ, КОТОРАЯ УЕДЕТ: вывод, каким он был при снятии отпечатка\\n')\n",
    )
    git(['add', '--', 'scripts/sma/drill-drift.mjs'], dir)
  }
  git(['commit', '-q', '-m', 'drill: tools of the tree'], dir)

  // Отпечатки — вербом продукта, на том дереве, где снасти уже лежат.
  const shaGreen = receiptHash(CMD_GREEN, dir)
  const shaDrift = withRedRecipe ? receiptHash(CMD_DRIFT, dir) : null

  const rows = [
    '---',
    'phase: uchenie',
    'plan: 01',
    'receipts:',
    '  - id: R-green',
    '    assertion: постоянный вывод снасти учения не изменился',
    `    check_command: ${CMD_GREEN}`,
    `    expected_sha256: ${shaGreen}`,
    '    hash_stdout: true',
  ]
  if (withRedRecipe) {
    rows.push(
      '  - id: R-drift',
      '    assertion: вывод второй снасти совпадает с тем, что был при снятии отпечатка',
      `    check_command: ${CMD_DRIFT}`,
      `    expected_sha256: ${shaDrift}`,
      '    hash_stdout: true',
    )
  }
  rows.push('---', '', '# Сводка учения', '', 'Рецепты этого дерева перезапускает перепроверка.', '')
  const summaryRel = '.planning/phases/uchenie/uchenie-01-SUMMARY.md'
  writeFileSync(join(dir, summaryRel), rows.join('\n'))
  git(['add', '--', summaryRel], dir)
  git(['commit', '-q', '-m', 'drill: recipes of the tree'], dir)

  if (withRedRecipe) {
    // СНАСТЬ УЕЗЖАЕТ ПОСЛЕ СНЯТИЯ ОТПЕЧАТКА — рецепт становится красным честно, а не назначением.
    writeFileSync(
      join(dir, 'scripts', 'sma', 'drill-drift.mjs'),
      "process.stdout.write('СНАСТЬ УЕХАЛА: вывод изменился уже после того, как отпечаток был снят\\n')\n",
    )
    git(['add', '--', 'scripts/sma/drill-drift.mjs'], dir)
    git(['commit', '-q', '-m', 'drill: the tool drifted away from its recipe'], dir)
  }

  return { dir, tip: git(['rev-parse', 'HEAD'], dir), summaryRel }
}

/**
 * ДВОЙНИК РАБОТНИКА. Делает ровно две вещи: одну фиксацию в СВОЕЙ копии (в каталоге, за который
 * не отвечает ни один рецепт) и записку в кадре сессии. Снасти рецептов он не трогает — иначе
 * покраснело бы новое, и учение мерило бы поломку, а не чистое завершение.
 */
function writeWorkerDouble(path) {
  const src = `import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')

try {
  const dir = join(cwd, 'notes')
  mkdirSync(dir, { recursive: true })
  const rel = 'notes/worker-note.md'
  writeFileSync(join(cwd, rel), 'правка работника: одна фиксация, снасти рецептов не тронуты\\n')
  execFileSync('git', ['add', '--', rel], { cwd })
  execFileSync('git', ['commit', '-q', '-m', 'drill: one commit by the worker double', '--', rel], { cwd })
  say({ type: 'drill', step: 'committed', file: rel })
} catch (err) {
  say({ type: 'drill_error', step: 'commit', error: String((err && err.message) || err) })
}

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

function attemptsOf(ledgerDir, taskId) {
  const rows = readAttempts(ledgerDir, taskId)
  const folded = foldAttemptRows(rows)
  const numbers = [...new Set(rows.map((r) => r && r.attempt).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b)
  return { rows, folded, numbers }
}

function terminalOf(ledgerDir, taskId, n) {
  return foldAttemptRows(readAttempts(ledgerDir, taskId)).find(
    (r) => r && r.attempt === n && (r.outcome === 'completed' || r.outcome === 'failed'),
  )
}

/**
 * ЧИСТОЕ ЛИ ЭТО ЗАВЕРШЕНИЕ — по определению самого продукта, обеими признанными формами:
 * строковая ссылка формы перепроверки ЛИБО объектная без признака «не перепроверено».
 */
function cleanliness(receiptRef) {
  if (typeof receiptRef === 'string') {
    return {
      shape: `строка «${receiptRef.split(':')[0]}:»`,
      clean: receiptRef.startsWith('reverify:'),
      reason: null,
    }
  }
  if (receiptRef && typeof receiptRef === 'object') {
    return {
      shape: 'объект гейта кода',
      clean: receiptRef.unverified !== true,
      reason: receiptRef.reason ?? null,
    }
  }
  return { shape: 'ссылки нет', clean: false, reason: null }
}

// ── одна половина учения ───────────────────────────────────────────────────────────

/**
 * @param {{key:string, title:string, withRedRecipe:boolean, expectClean:boolean,
 *          expectReason:string, port:number}} o
 */
async function runHalf(o) {
  head(`ПОЛОВИНА «${o.title}» — ${o.key}`)

  const halfRoot = join(DRILL_ROOT, o.key)
  const projectDir = join(halfRoot, 'project')
  const dataDir = join(halfRoot, 'data')
  const ledgerDir = join(halfRoot, 'ledger')
  const accountDir = join(halfRoot, 'account')
  const dbName = `sma_clean_done_drill_${o.key.replace(/[^a-z0-9_]/gi, '_')}`
  const queueUrl = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/${dbName}`
  for (const d of [dataDir, ledgerDir, accountDir]) mkdirSync(d, { recursive: true })

  // ── (1) дерево с рецептами ──
  const proj = buildProject(projectDir, { withRedRecipe: o.withRedRecipe })
  info(`проект учения: ${projectDir} (ветка main, вершина ${proj.tip})`)
  info(`рецепты дерева: ${proj.summaryRel}`)

  // ── (2) ДЕРЕВО ПРОВЕРЯЕТСЯ ДО НАЧАЛА РАБОТЫ, И ОЖИДАНИЕ ПОД НЕГО НЕ ПОДГОНЯЕТСЯ ──
  const beforeDivergent = reverifyCount(projectDir, 'divergent')
  const beforeVerified = reverifyCount(projectDir, 'verified')
  const beforeError = reverifyCount(projectDir, 'error')
  info(`перепроверка ДО работы: зелёных=${beforeVerified} расхождений=${beforeDivergent} ошибок=${beforeError}`)
  if (!Number.isFinite(beforeDivergent) || !Number.isFinite(beforeVerified)) {
    notRun('перепроверка не назвала чисел до начала работы — мерить нечем')
  }
  if (beforeVerified < 1) {
    notRun(
      'в дереве нет ни одного ЗЕЛЁНОГО рецепта — перепроверять нечего, и любое завершение здесь ' +
        'вышло бы с оговоркой «в дереве нет рецептов», то есть учение проверяло бы не то',
    )
  }
  const expectedRedBefore = o.withRedRecipe ? 1 : 0
  if (beforeDivergent !== expectedRedBefore) {
    notRun(
      `красных рецептов ДО работы ${beforeDivergent}, а половина строилась на ${expectedRedBefore} — ` +
        'дерево не то, за которое себя выдаёт, и подгонять его под ожидание нельзя',
    )
  }
  pass(
    o.withRedRecipe
      ? `дерево подготовлено С КРАСНЫМ: расхождений до работы ${beforeDivergent}, зелёных ${beforeVerified}`
      : `дерево подготовлено ЧИСТЫМ: расхождений до работы ${beforeDivergent}, зелёных ${beforeVerified}`,
  )

  // ── (3) боевая фабрика демона с названными границами ──
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
    projects: [],
    activeProject: null,
    // КОНВЕЙЕР ВКЛЮЧЁН — иначе тик не сделает ни одного шага и предмет учения не наступит.
    // Цена включения оплачена подменой модели: запускается сценарий узла.
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
  const buildArgsDouble = (task, route) => ({
    bin: process.execPath,
    args: [doublePath],
    accountName: 'drill-double',
    env: { ...process.env, CLAUDE_CONFIG_DIR: accountDir },
    prompt: `учение чистого завершения: ${task && task.id} (${route && route.workerId})`.trim(),
  })

  /** Верб продуктового CLI: абсолютный путь к файлу, всё остальное — как у боевого. */
  const drillVerbRunner = (bin, args, opts = {}) =>
    new Promise((res) => {
      const rewritten = args[0] === CLI_REL ? [CLI_ABS, ...args.slice(1)] : args
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
    mirrorPersonalLayer: async () => ({ drill: true }),
    loadMcpRegistry: () => ({ servers: [] }),
    sweepWorktrees: async () => ({ skipped: 'drill' }),
    journal: (entry) => {
      journalEntries.push(entry)
      if (entry && typeof entry.type === 'string' && entry.type.startsWith('task.')) {
        info(
          `журнал: ${entry.type}${entry.reason ? ` reason=${entry.reason}` : ''}` +
            `${entry.detail ? ` — ${String(entry.detail).slice(0, 240)}` : ''}`,
        )
      }
    },
  })

  // ДВА ЗАМКА НА ОДНУ ДВЕРЬ: учение отказывается работать там, где может стоить денег.
  if (handles.tickDeps.buildArgs !== buildArgsDouble) {
    await shutdown(handles)
    notRun('в корне собрана НЕ подмена аргументов — учение отказывается работать там, где может стоить денег')
  }
  info('исполнитель — сценарий узла (подмена названа в шапке); языковая модель недостижима')
  if (typeof handles.tickDeps.execGit !== 'function') {
    await shutdown(handles)
    notRun('git не подан тику — гейты, которые его спрашивают, ответили бы «нет» по посторонней причине')
  }
  if (typeof handles.tickDeps.verbRunner !== 'function') {
    await shutdown(handles)
    notRun('бегунок вербов не собран — перепроверка не состоится, и мерить будет нечего')
  }
  info('git, запускатель процессов и бегунок вербов — боевые, не переопределены')

  await ensureDb(dbName)
  info(`создана отдельная база очереди ${dbName} (общая база учением не открывается)`)

  await handles.start()
  if (!(await waitForPort(o.port, FRONT_HOST, Date.now() + 20000))) {
    await shutdown(handles)
    await dropDb(dbName)
    notRun(`демон так и не начал слушать ${FRONT_HOST}:${o.port}`)
  }
  info(`демон поднят: порт ${o.port}, тик ${TICK_MS} мс`)

  // ── (4) синтетическая задача — БЕЗ фазы, чтобы предполётная дверь не отвечала за неё ──
  const taskId = `drill-${o.key}-${Date.now()}`
  await handles.adapter.enqueue({
    id: taskId,
    source: 'roster',
    title: `учение чистого завершения: ${o.title}`,
    lane: 'prod',
  })
  info(`задача положена в очередь учения: ${taskId}`)

  // ── (5) ждём конца попытки ──
  const startedWaitAt = Date.now()
  let first = null
  while (Date.now() - startedWaitAt < ATTEMPT_TIMEOUT_MS) {
    first = terminalOf(ledgerDir, taskId, 1)
    if (first) break
    await sleep(300)
  }
  if (!first) {
    await shutdown(handles)
    await dropDb(dbName)
    notRun(`попытка не кончилась за ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)} с — прогон не состоялся`)
  }
  info(`попытка кончилась за ${Date.now() - startedWaitAt} мс`)

  // ── (6) СТРОКА ЛЕДЖЕРА ЦЕЛИКОМ — ЭТО И ЕСТЬ ПРЕДЪЯВЛЕНИЕ ──
  head(`СТРОКА ЛЕДЖЕРА — ${o.key}`)
  say(JSON.stringify(first))
  const status = await approvalStatus(queueUrl, taskId)
  const verdict = cleanliness(first.receiptRef)
  info(`форма ссылки на квитанцию: ${verdict.shape}; причина: ${verdict.reason ?? '—'}`)
  info(`строка встала в состояние: ${status}`)

  // ── (7) утверждения половины ──
  head(`УТВЕРЖДЕНИЯ — ${o.key}`)
  if (first.outcome === 'completed') pass('исход попытки — ЗАВЕРШЕНО')
  else fail(`исход попытки — «${first.outcome}» (${first.failureReason || 'без причины'}), ожидалось «завершено»`)

  const copyPath = first.worktreePath
  const commits = copyPath && first.base ? gitQuiet(['rev-list', '--count', `${first.base}..HEAD`], copyPath) : { ok: false, out: 'копия или база неизвестны' }
  if (commits.ok && commits.out === '1') pass('работа С КОДОМ: работник положил на ветку ровно одну фиксацию')
  else fail(`на ветке не одна фиксация (${commits.out}) — половина не воспроизведена`)

  const differential = journalEntries.filter((e) => e && e.type === 'task.gate_differential' && e.taskId === taskId)
  if (differential.length) {
    for (const d of differential) info(`дифференциальный вердикт гейта: ${d.detail}`)
    pass('гейт назвал свой дифференциальный вердикт вслух — «до», «после» и «новых» видны числами')
  } else {
    fail('в журнале оператора нет дифференциального вердикта — гейт молчит о том, что он сравнивал')
  }

  const approach = readJournalEntries(ledgerDir, taskId).find((e) => e && e.layer === 'approach' && e.attempt === 1)
  if (approach) pass('САМ ДЕМОН записал слой подхода попытки — записка дошла до тика, а не только до нас')
  else fail('в журнале попытки нет слоя подхода — тик записку не принял')

  if (o.expectClean) {
    if (verdict.clean) pass(`ЗАВЕРШЕНИЕ БЕЗ ОГОВОРКИ: признака «не перепроверено» в ссылке нет (${verdict.shape})`)
    else fail(`завершение С ОГОВОРКОЙ: ${JSON.stringify(first.receiptRef)} — чистое завершение НЕ предъявлено`)
  } else {
    if (!verdict.clean) {
      pass(
        `ПЕРЕВЁРНУТОЕ ОЖИДАНИЕ ПОДТВЕРЖДЕНО: на дереве с красным рецептом завершение вышло С ОГОВОРКОЙ ` +
          `(${JSON.stringify(first.receiptRef)}) — учение умеет видеть оговорку, значит его «оговорки нет» не слепое`,
      )
    } else {
      fail(
        'на дереве с ЗАВЕДОМО красным рецептом завершение вышло без оговорки — учение слепое, и зелёное ' +
          'в чистой половине ничего не доказывает',
      )
    }
  }
  if (verdict.reason === o.expectReason) pass(`причина названа ожидаемая: «${o.expectReason}»`)
  else fail(`причина «${verdict.reason}», ожидалась «${o.expectReason}»`)

  if (status === 'awaiting_approval') pass('строка поехала человеку в приёмку, а не в красное')
  else fail(`строка встала в «${status}», а не в ожидание приёмки`)

  const tally = attemptsOf(ledgerDir, taskId)
  if (tally.numbers.length === 1) pass('различных попыток ровно одна — работа закрылась с ПЕРВОГО раза')
  else fail(`различных попыток ${tally.numbers.length}: ${tally.numbers.join(', ')}`)

  // ── (8) леджер откладывается, чтобы строку можно было открыть после уборки ──
  const keptDir = join(KEEP_ROOT, o.key)
  mkdirSync(keptDir, { recursive: true })
  for (const f of readdirSync(ledgerDir)) {
    try {
      cpSync(join(ledgerDir, f), join(keptDir, f))
    } catch {
      /* нескопированный файл леджера не меняет вердикта — строка уже напечатана выше */
    }
  }
  info(`леджер учения отложен: ${keptDir}`)

  await shutdown(handles)
  await dropDb(dbName)
  return { taskId, first, verdict, keptDir, beforeDivergent, beforeVerified, status }
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
  say('=== учение чистого завершения: завершение БЕЗ оговорки и завершение С оговоркой ===')
  say(`рабочая копия: ${REPO_ROOT}`)
  say('ФОРМА ПРОГОНА: работник ПОДМЕНЁН сценарием узла (сборка аргументов запуска). Подменена')
  say('модель, а не дверь: демон, тик, git, верб провизии, ПЕРЕПРОВЕРКА и очередь — боевые.')
  say('ЖИВОЙ ЛЕДЖЕР ЧЕЛОВЕКА НЕ ОТКРЫВАЕТСЯ И НЕ ПИШЕТСЯ: у учения свой, временный.')

  // ── (0) ПРОБЫ ──
  head('ПРОБЫ ПЕРЕД СТАРТОМ')

  for (const cmd of [CMD_GREEN, CMD_DRIFT]) {
    if (!isSafeCommand(cmd)) notRun(`команда рецепта «${cmd}» не проходит границу безопасных форм продукта`)
  }
  info(`команды рецептов проходят границу безопасных форм: ${CMD_GREEN} · ${CMD_DRIFT}`)

  if (!(await probePort(QUEUE_PORT, QUEUE_HOST))) {
    notRun(`очередь Postgres ${QUEUE_HOST}:${QUEUE_PORT} не отвечает — поднять её: cd ~/pg-sandbox && node start.mjs`)
  }
  info(`очередь ${QUEUE_HOST}:${QUEUE_PORT} отвечает`)

  const ports = []
  for (let p = PORT_FIRST; p <= PORT_LAST && ports.length < 2; p += 1) {
    // eslint-disable-next-line no-await-in-loop -- пробы портов идут по одной намеренно
    if (!(await probePort(p))) ports.push(p)
  }
  if (ports.length < 2) notRun(`свободных портов в ${PORT_FIRST}..${PORT_LAST} не нашлось — учение не отбирает чужой порт`)
  info(`свободные порты учения: ${ports.join(', ')} (7777, 7788 и 7802–7804 не трогаются)`)

  try {
    info(`git на месте: ${git(['--version'], REPO_ROOT)}`)
  } catch (err) {
    notRun(`git недоступен: ${String((err && err.message) || err)}`)
  }

  // МЕСТО УЧЕНИЯ ПРОВЕРЯЕТСЯ, А НЕ ПРЕДПОЛАГАЕТСЯ: каталог зависимостей рабочей копии на этой
  // машине ЯВЛЯЕТСЯ ССЫЛКОЙ в чужое дерево. Сравниваются РАСКРЫТЫЕ пути.
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
    for (const place of [DRILL_ROOT, KEEP_ROOT]) {
      if (place === tree || place.startsWith(tree + sep)) {
        notRun(`место учения ${place} лежит внутри рабочего дерева ${tree} — там разворачивать репозитории нельзя`)
      }
    }
  }
  info(`место учения: ${DRILL_ROOT} (вне рабочих деревьев: ${forbidden.join(', ')})`)

  // ── (1) уборка НА ВХОДЕ ──
  head('ПОДГОТОВКА')
  removeDrillTree()
  rmSync(KEEP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(join(DRILL_ROOT, 'double'), { recursive: true })
  writeWorkerDouble(join(DRILL_ROOT, 'double', 'worker.mjs'))
  info('дерево прошлой попытки убрано (уборка на ВХОДЕ, а не только на выходе); двойник записан')

  const results = {}
  try {
    results.chisto = await runHalf({
      key: 'chisto',
      title: 'дерево с ЗЕЛЁНЫМИ рецептами — ожидается завершение БЕЗ оговорки',
      withRedRecipe: false,
      expectClean: true,
      expectReason: 'no_new_red',
      port: ports[0],
    })
    results.sKrasnym = await runHalf({
      key: 's-krasnym',
      title: 'дерево с КРАСНЫМ рецептом — ожидание перевёрнутое: оговорка ОБЯЗАНА появиться',
      withRedRecipe: true,
      expectClean: false,
      expectReason: 'preexisting_red_only',
      port: ports[1],
    })
  } finally {
    head('ПОСЛЕ УЧЕНИЯ')
    removeDrillTree()
    info('временные репозитории, копии работника и двойник убраны; общая очередь оставлена работать')
    info(`леджеры половин оставлены на месте: ${KEEP_ROOT} (там строка, напечатанная выше)`)
  }

  finish(results)
}

function finish(results) {
  head('ИТОГ')
  for (const [name, r] of Object.entries(results)) {
    if (!r) continue
    say(
      `  ${name}: задача=${r.taskId} красных до работы=${r.beforeDivergent} зелёных=${r.beforeVerified} ` +
        `исход=${r.first.outcome} состояние=${r.status} ` +
        `квитанция=${JSON.stringify(r.first.receiptRef ?? null)} ` +
        `оговорка=${r.verdict.clean ? 'НЕТ' : 'есть'}`,
    )
    say(`    леджер половины: ${r.keptDir}`)
  }
  head('ГДЕ ЭТО ЛЕЖИТ — СКАЗАНО ПРЯМО')
  say('  Учение писало в СВОЙ временный леджер. Живой леджер человека не тронут: запись в него')
  say('  испортила бы счёт завершённых попыток, на котором стоит утверждение «чистых ноль».')
  say('  Прочитать живой леджер и убедиться, что чистых там по-прежнему ноль (команда целиком,')
  say('  только чтение, дедуп по паре «задача + номер попытки»):')
  say(`    ${LIVE_LEDGER_TALLY}`)
  say('  Чтобы такая строка появилась в ЖИВОМ леджере, задача должна пройти на дереве, где')
  say('  перепроверка до её начала называет ноль расхождений и хотя бы один зелёный рецепт.')
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
