/**
 * live-steer-drill.mjs — УЧЕНИЕ ЖИВОГО СЛОВА. Живой демон, живой тик, живая очередь и —
 * в отличие от соседних учений — НАСТОЯЩИЙ РАБОТНИК.
 *
 * ═══ ПОЧЕМУ ЗДЕСЬ НЕЛЬЗЯ ПОДМЕНИТЬ РАБОТНИКА ════════════════════════════════════
 *
 * Соседние учения (`live-answer-drill.mjs`, `live-approve-drill.mjs`) подменяют модель
 * сценарием узла: их предмет — двери и гейты тика, и подписка на них тратиться не должна.
 * ЗДЕСЬ ТАК НЕЛЬЗЯ. Предмет этого учения — хук, который вендор запускает ВНУТРИ процесса
 * работника, и кадры сессии, которые печатает вендорский CLI. Ни того, ни другого у
 * подменного сценария нет: он не исполняет хуков и не печатает `hook_response`. Учение с
 * подменённой моделью доказало бы ровно ничего, а стоило бы столько же времени.
 *
 * Поэтому сборка аргументов НЕ подменяется, и запускатель процессов НЕ подменяется. Оба
 * ОБЁРНУТЫ ради наблюдения, и обёртки объявлены здесь:
 *
 *   1. АРГУМЕНТЫ. Боевой сборщик зовётся как есть; к его массиву добавляется РОВНО ОДИН
 *      флаг — `--include-hook-events`. Без него кадров хуков в потоке нет вовсе (проверено
 *      живой пробой 21.08), и учение искало бы слово там, где его не будет и при исправном
 *      канале. Учение УТВЕРЖДАЕТ, что добавлен ровно один элемент и что весь боевой префикс
 *      совпал буква в букву; иначе — «НЕ ПРОГНАНО».
 *   2. ЗАПУСКАТЕЛЬ. Боевой `spawnWorker` вызывается как есть; обёртка только записывает
 *      аргументы и задание каждого запуска, чтобы «возобновление ТОЙ ЖЕ сессии» доказывалось
 *      командной строкой, а не пересказом. Учение сверяет ТОЖДЕСТВО обёрнутой функции с
 *      боевой по ссылке — подмена по недосмотру невозможна.
 *
 * ═══ ЧТО ОНО ДОКАЗЫВАЕТ, И ЧЕГО НЕ ДОКАЗЫВАЕТ НИ ОДИН ТЕСТ ══════════════════════
 *
 *   СЛОВО          — слово, посланное дверью ПОСРЕДИ хода, предъявлено модели ДО итога,
 *                    сессия одна, никого не убили, второго запуска внутри попытки не было.
 *   КОНТРОЛЬ       — та же задача без слова: приметного слова в стенограмме НЕТ. Учение,
 *                    не видевшее разницы, не вправе утверждать доставку.
 *   ПОСЛЕДНИЙ ВЫЗОВ— слово послано ПОСЛЕ последнего вызова инструмента. Исход НЕ предрешён:
 *                    доехало в тот же ход — так и записывается; не доехало — утверждается
 *                    СТРАХОВКА (строка осталась ждущей и доехала возобновлением). Оба исхода
 *                    законны, и вердикт печатается словами.
 *   ПЕРЕБИТЬ       — режим «перебить» посреди хода: живой ребёнок убит (дверь ответила
 *                    `live:true`), продолжение возобновило ТУ ЖЕ сессию, задание продолжения
 *                    несёт слово поправки, ход доведён до итога.
 *   ВОПРОС–ОТВЕТ   — работник закончил ход вопросом словами; ответ ушёл дверью возврата;
 *                    следующая попытка возобновила ТУ ЖЕ сессию и несёт ответ в задании.
 *   ОКНО           — свежая сборка окна (в каталог ВНЕ дерева) подана демону швом статики;
 *                    черновик набора переживает смену экрана и перезагрузку.
 *
 * ═══ ФОРМА ДОКАЗАТЕЛЬСТВА ДОСТАВКИ — УСТАНОВЛЕНА ПРОБОЙ, А НЕ ВЫБРАНА ═══════════
 *
 * Допконтекста НЕТ в пользовательских кадрах: вендор предъявляет его модели на стороне
 * запроса, а в поток кладёт только через `hook_response`. Значит доказательство доставки
 * складывается ровно из двух половин, и обе обязательны:
 *   (1) кадр `hook_response` с непустым `additionalContext`, несущим слово;
 *   (2) слово в рассуждении или в итоговом ответе модели — то есть модель его прочитала.
 * Поиск слова в кадрах `user` доказательством не является и здесь не делается.
 *
 * ═══ ЧТО ПЕРЕОПРЕДЕЛЕНО, И КАЖДОЕ — ГРАНИЦА БЕЗОПАСНОСТИ ═══════════════════════
 *
 *   1. СВОЙ ПОРТ (проба ниже). Общий демон и соседние окна стоят на своих; свободного нет —
 *      исход «НЕ ПРОГНАНО», а не отбор чужого порта.
 *   2. СВОЯ БАЗА очереди на общем сервере: создаётся и удаляется учением; данные общей
 *      очереди не открываются.
 *   3. СВОИ каталоги данных и леджера — временные, ВНЕ рабочего дерева (проверка места
 *      стоит в коде и роняет учение до старта).
 *   4. НЕТ ПОДКЛЮЧЁННОГО ПРОЕКТА: тику подаётся временный репозиторий.
 *   5. ИСТОЧНИК ЛИЧНОГО СЛОЯ — ПУСТОЙ каталог. Боевое зеркало копирует домашний каталог
 *      человека в учётную запись работника; учению этого делать нельзя. Само зеркало при
 *      этом БОЕВОЕ и не подменено — иначе в учётную запись не попал бы хук-калитка, то есть
 *      исчез бы предмет учения.
 *   6. УЧЁТНАЯ ЗАПИСЬ РАБОТНИКА — ТА ЖЕ, ЧТО У МАШИНЫ, и это НЕ небрежность, а измеренная
 *      осторожность (см. `useMachineAccount`): временная копия учётной записи уносит с собой
 *      обновлённый ключ входа и оставляет машину без него. Учение ключ входа не читает и не
 *      копирует ВООБЩЕ; в учётной записи оно меняет ровно один файл настроек — тот же, что
 *      боевое зеркало пишет туда перед каждым живым запуском, — и возвращает его на место.
 *   7. РЕЕСТР СЕРВЕРОВ пуст, УБОРЩИК ЧУЖИХ КОПИЙ — пустышка: оба ходят по деревьям, которые
 *      учению не принадлежат. Путь к продуктовому CLI сделан абсолютным (временный
 *      репозиторий не является установкой продукта).
 *
 * ═══ ТРИ ИСХОДА ════════════════════════════════════════════════════════════════
 *
 *   код 0 — чисто: все утверждения половин прошли;
 *   код 1 — блокеры: прогон СОСТОЯЛСЯ, но что-то из утверждённого не подтвердилось;
 *   код 3 — НЕ ПРОГНАНО: очередь молчит, порт занят, CLI недоступен, сессия не задышала.
 *
 * Прогон, которого не было, никогда не считается проходом.
 *
 * ═══ ПОДПИСКА ══════════════════════════════════════════════════════════════════
 *
 * Каждая половина — короткая сессия младшей модели на крошечной задаче. Половины
 * запускаются по одной флагом, чтобы починка одной не оплачивалась повторным прогоном
 * остальных. Число запусков и стоимость по кадрам итога печатаются.
 *
 *   node supervisor/live-steer-drill.mjs --word | --control | --last-call
 *                                        | --interrupt | --question | --ui | --all
 *
 * Node built-ins + модули самого демона + pg. Ни одной новой зависимости. Драйвер браузера
 * для половины «окно» разрешается в момент запуска (SMA_UI_DRIVER), как это делает движок
 * прогона окна, и его отсутствие — исход «НЕ ПРОГНАНО», а не пустой список находок.
 */

import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'
import net from 'node:net'

import { createDaemon } from '../daemon/src/main.mjs'
import { loadConfig } from '../daemon/src/config.mjs'
import { readAttempts, foldAttemptRows, readAttemptLog } from '../daemon/src/queue/attempt-ledger.mjs'
import { attemptIdFor } from '../daemon/src/front/journal.mjs'
import { readPendingRedirects, correctionsPreamble } from '../daemon/src/runner/redirects.mjs'
// БОЕВОЙ ЗАПУСКАТЕЛЬ, ВЗЯТЫЙ ПО ССЫЛКЕ — чтобы «мы обернули боевой, а не подменили» было
// утверждением о тождестве объектов, а не обещанием в комментарии.
import { spawnWorker as PRODUCTION_SPAWN } from '../daemon/src/runner/spawn.mjs'

// ── постоянные учения ──────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Драйвер базы берётся требованием ОТ МАНИФЕСТА ДЕМОНА — как в соседних учениях. */
const requireFromDaemon = createRequire(new URL('../daemon/package.json', import.meta.url))
const pg = requireFromDaemon('pg')

/** Свой порт. 7777 — общий демон, 7788 — соседние окна, 7802–7830 расписаны соседями. */
const PORT_FIRST = 7831
const PORT_LAST = 7850
const FRONT_HOST = '127.0.0.1'

/** Сервер очереди — общий и живой. Базы — свои, создаются и удаляются учением. */
const QUEUE_HOST = '127.0.0.1'
const QUEUE_PORT = 5433
const ADMIN_URL = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/postgres`

/** Место учения — ВНЕ рабочих деревьев; путь берётся уже раскрытым (мина ссылок). */
const DRILL_ROOT = join(realpathSync(tmpdir()), 'sma-steer-drill')

/** Интервал тика учения. Боевое значение по умолчанию — 5000 мс. */
const TICK_MS = 1000

/** Модель половин — младшая: учение проверяет канал, а не рассуждение. */
const DRILL_MODEL = 'haiku'

/** Единственный флаг, который учение добавляет к боевым аргументам, — и он про наблюдение. */
const HOOK_EVENTS_FLAG = '--include-hook-events'

/** Сколько ждать конца попытки, прежде чем сказать «не прогнано». */
const ATTEMPT_TIMEOUT_MS = 300000
/** Сколько ждать, пока сессия задышит (первые кадры) — до этого слать слово некуда. */
const BREATH_TIMEOUT_MS = 120000

/** Путь к продуктовому CLI в том виде, в каком его зовёт тик (относительно проекта). */
const CLI_REL = 'scripts/sma/cli.mjs'

/** Токен фронта учения — свой, случайный, живёт столько же, сколько половина. */
const drillToken = () => `drill${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`

/**
 * Куда сложить стенограммы, ПРЕЖДЕ ЧЕМ уборка снесёт дерево учения (`--keep <каталог>`).
 *
 * Утверждение о доставке стоит ровно столько, сколько стоит кадр, на который оно ссылается.
 * Учение убирает за собой ВСЁ, включая леджер, — значит без этого шага у прогона не остаётся
 * ни одного предъявляемого следа, и «слово доехало» превращается в пересказ.
 */
let keepDir = null

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

/**
 * Единственный выход с кодом 3. Причина называется всегда.
 *
 * ОН БРОСАЕТ, А НЕ ГАСИТ ПРОЦЕСС, и это не стиль. Первая редакция звала `process.exit(3)`
 * прямо здесь — а немедленный выход перепрыгивает через ВСЕ `finally`: база очереди половины
 * оставалась на общем сервере, временное дерево — на диске, и учение, которое в шапке обещает
 * убирать за собой, оставляло мусор ровно в тот момент, когда что-то пошло не так. Проверено
 * фактом: после двух оборванных половин на сервере остались две их базы. Теперь причина
 * едет наверх исключением, по дороге срабатывают уборка половины и уборка прогона, и только
 * потом печатается исход.
 */
class NotRunError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'NotRunError'
  }
}

function notRun(reason) {
  throw new NotRunError(reason)
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

/** Одна дверь СВОЕГО демона. Никакого другого адреса учение не знает. */
function callDoor({ port, token, path, body }) {
  return new Promise((res) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: FRONT_HOST,
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          authorization: `Bearer ${token}`,
        },
      },
      (r) => {
        let text = ''
        r.setEncoding('utf8')
        r.on('data', (c) => {
          text += c
        })
        r.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          res({ status: r.statusCode, body: parsed, raw: text })
        })
      },
    )
    req.on('error', (err) => res({ status: 0, body: null, raw: String((err && err.message) || err) }))
    req.write(payload)
    req.end()
  })
}

// ── временный проект учения ────────────────────────────────────────────────────────

/**
 * Крошечный репозиторий: одна мишень для чтения и один снимок истории. Копия работника
 * отводится тиком от его вершины — расхождение баз этому учению не нужно и не строится.
 */
function buildProject(dir, targetText) {
  mkdirSync(dir, { recursive: true })
  // ПАСПОРТ ДОМА — ИНАЧЕ ОКНО ОТКРЫВАЕТСЯ ПЕРВЫМ ЗАПУСКОМ. Окно спрашивает у демона, обжит ли
  // дом, и без паспорта на диске занимает весь экран интервью — сайдбара нет, экранов нет, и
  // предмет половины «черновик» на экран не выходит вовсе. Пустой паспорт — ровно тот факт,
  // который дверь и читает: наличие файла.
  mkdirSync(join(dir, '.sma'), { recursive: true })
  writeFileSync(join(dir, '.sma', 'profile.json'), `${JSON.stringify({ drill: true }, null, 2)}\n`)
  git(['init', '-q', '-b', 'drill-main', '.'], dir)
  git(['config', 'user.email', 'drill@localhost'], dir)
  git(['config', 'user.name', 'steer drill'], dir)
  writeFileSync(join(dir, 'readme.md'), 'учение живого слова\n')
  writeFileSync(join(dir, 'target.txt'), targetText)
  git(['add', '--', 'readme.md', 'target.txt'], dir)
  git(['commit', '-q', '-m', 'drill: root'], dir)
  return { dir, head: git(['rev-parse', 'HEAD'], dir) }
}

// ── база очереди учения ────────────────────────────────────────────────────────────

async function ensureDb(name) {
  const client = new pg.Client({ connectionString: ADMIN_URL })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`)
  } catch (err) {
    if (!(err && err.code === '42P04')) {
      await client.end()
      throw err
    }
  }
  await client.end()
}

/**
 * Смести базы ПРОШЛЫХ прогонов этого учения — и только их: имена, которые оно само же и
 * минтит. Оборванный прогон оставляет базу на общем сервере, и уборка на входе — то же
 * правило, что и для временного дерева: она надёжнее уборки на выходе, потому что выход
 * может не наступить.
 */
async function dropOwnStaleDbs() {
  const client = new pg.Client({ connectionString: ADMIN_URL })
  await client.connect()
  let names = []
  try {
    const q = await client.query("SELECT datname FROM pg_database WHERE datname LIKE 'sma_steer_drill_%'")
    names = q.rows.map((r) => r.datname)
    for (const n of names) await client.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`)
  } finally {
    await client.end()
  }
  if (names.length) info(`смещены базы прошлых прогонов ЭТОГО учения: ${names.join(', ')}`)
  else info('баз прошлых прогонов этого учения на сервере нет')
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

// ── учётная запись работника учения ────────────────────────────────────────────────

/**
 * СВОЯ учётная запись, в которую скопированы ТОЛЬКО файлы входа.
 *
 * Сессия обязана быть настоящей — значит ей нужен вход. Писать в учётную запись работника
 * этой машины учение права не имеет (боевое зеркало перепишет там settings.json, а хук
 * укажет на дерево учения), поэтому файлы входа КОПИРУЮТСЯ в свой временный каталог, и он
 * исчезает вместе с учением. Ничего, кроме входа, не копируется: ни правил, ни истории,
 * ни настроек — их напишет боевое зеркало от ПУСТОГО источника личного слоя.
 */
/**
 * ЗАЁМ КЛЮЧА ВХОДА — И ЕГО ВОЗВРАТ. Список открытых займов; каждый закрывается в конце
 * прогона, ДО уборки дерева.
 *
 * ПОЧЕМУ ВОЗВРАТ ОБЯЗАТЕЛЕН, и это измерено, а не предположено. Ключ входа ОДНОРАЗОВЫЙ в
 * той части, которой обновляют сессию: CLI, поднявшись со старым ключом, обменивает его на
 * новый и пишет новый ТУДА, КУДА ЕМУ УКАЗАЛИ — то есть в копию учения. Прежний с этого
 * момента мёртв. Учение, которое скопировало ключ и не вернуло обновлённый, оставляет
 * учётную запись работника БЕЗ ВХОДА, и следующая живая попытка машины падает с «сессия
 * истекла и не обновляется». Ровно это и случилось на первом прогоне этого учения
 * 21.08.2026 — записано здесь, чтобы следующий читатель не повторил.
 *
 * Возвращается РОВНО ОДИН файл — тот же, что был взят, — и только если он изменился.
 */
const restores = []

/**
 * Вернуть настройки учётной записи в то состояние, в каком учение их застало. Зовётся в
 * конце прогона И из аварийного выхода: учение, которое оставило после себя чужой файл
 * изменённым, не имеет права называться убравшим за собой.
 */
function settleRestores() {
  for (const r of restores.splice(0)) {
    try {
      if (r.previous === null) rmSync(r.path, { force: true })
      else writeFileSync(r.path, r.previous)
      info(`настройки учётной записи возвращены в исходное состояние: ${r.path}`)
    } catch (err) {
      say(`FAIL  настройки ${r.path} НЕ возвращены: ${String((err && err.message) || err)} — вернуть руками`)
      failCount += 1
    }
  }
}

/**
 * useMachineAccount(config) → каталог учётной записи работника ЭТОЙ МАШИНЫ.
 *
 * ПОЧЕМУ НЕ СВОЯ ВРЕМЕННАЯ КОПИЯ, И ЭТО ИЗМЕРЕНО, А НЕ ВЫБРАНО ПО ВКУСУ. Первая редакция
 * этого учения делала «чисто»: заводила свой каталог и клала в него копию ключа входа. Ключ
 * входа в той части, которой обновляют сессию, ОДНОРАЗОВЫЙ: CLI обменял его на новый и
 * записал новый ТУДА, КУДА ЕМУ УКАЗАЛИ — во временную копию, — а копия исчезла с уборкой.
 * Учётная запись работника осталась с израсходованным ключом, и следующая живая попытка
 * машины упала с «сессия истекла и не обновляется». Аккуратность обернулась поломкой.
 *
 * Поэтому учение работает В САМОЙ учётной записи — то есть ровно так, как работает боевой
 * запуск: CLI обновляет ключ на месте, и никакая копия ничего не уносит. Учение не читает
 * и не копирует ключ входа ВООБЩЕ.
 *
 * ЧТО ОНО В НЕЙ МЕНЯЕТ, названо поимённо: один файл настроек, и меняет его БОЕВОЕ зеркало —
 * то самое, которое пишет туда же перед каждым живым запуском. Разница ровно одна: хук
 * калитки на время прогона указывает на ЭТУ рабочую копию, иначе слово отдавала бы чужая
 * редакция калитки и учение проверяло бы не то. Прежний файл запоминается целиком и
 * возвращается на место в конце прогона.
 */
function useMachineAccount(machineConfig) {
  const worker = (Array.isArray(machineConfig.workers) ? machineConfig.workers : []).find(
    (w) => w && w.account && typeof w.account.configDir === 'string' && w.account.configDir.trim() !== '',
  )
  if (!worker) {
    notRun(
      'в конфигурации машины нет ни одного работника с каталогом учётной записи — настоящей сессии не под чем ' +
        'запуститься, а подменять работника это учение не вправе (см. шапку)',
    )
  }
  const dir = worker.account.configDir
  if (!existsSync(dir)) {
    notRun(`каталог учётной записи работника (${dir}) не существует — настоящей сессии не под чем запуститься`)
  }
  const path = join(dir, 'settings.json')
  if (!restores.some((r) => r.path === path)) {
    restores.push({ path, previous: existsSync(path) ? readFileSync(path, 'utf8') : null })
  }
  info(`учётная запись работника машины: ${dir} (её настройки будут возвращены на место после прогона)`)
  return dir
}

// ── чтение стенограммы и леджера ───────────────────────────────────────────────────

/** Кадры одной попытки — читателем ПРОДУКТА, а не своим разбором каталога. */
function framesOf(ledgerDir, taskId, attempt) {
  const read = readAttemptLog({ dir: ledgerDir, attemptId: attemptIdFor(taskId, attempt), tail: 1000 })
  return read.entries.map((e) => String((e && e.line) || ''))
}

function parsedFrames(raw) {
  const out = []
  for (const line of raw) {
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch {
      obj = null
    }
    out.push({ line, obj })
  }
  return out
}

/** Все различные идентификаторы сессии, встретившиеся в кадрах. */
function sessionIdsOf(frames) {
  const ids = new Set()
  for (const f of frames) {
    const id = f.obj && typeof f.obj.session_id === 'string' ? f.obj.session_id : null
    if (id) ids.add(id)
  }
  return [...ids]
}

/** Сохранить стенограммы половины наружу, пока уборка не снесла дерево учения. */
function keepTranscripts(ledgerDir, key) {
  if (!keepDir) return []
  const saved = []
  try {
    mkdirSync(keepDir, { recursive: true })
    for (const name of readdirSync(ledgerDir)) {
      if (!String(name).endsWith('.log.ndjson')) continue
      const to = join(keepDir, `${key}-${name}`)
      copyFileSync(join(ledgerDir, name), to)
      saved.push(to)
    }
  } catch (err) {
    info(`стенограммы не сохранились: ${String((err && err.message) || err)}`)
  }
  for (const p of saved) info(`стенограмма сохранена: ${p}`)
  return saved
}

/** Терминальная запись попытки N — то, чем эта попытка кончилась. */
function terminalOf(ledgerDir, taskId, n) {
  return foldAttemptRows(readAttempts(ledgerDir, taskId)).find(
    (r) => r && r.attempt === n && (r.outcome === 'completed' || r.outcome === 'failed'),
  )
}

/** Номера попыток, которые леджер уже видел, после дедупа складывателем продукта. */
function attemptNumbers(ledgerDir, taskId) {
  const rows = readAttempts(ledgerDir, taskId)
  return [...new Set(rows.map((r) => r && r.attempt).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b)
}

/** Стоимость и число ходов — с кадра итога, как их печатает сам CLI. */
function costOf(frames) {
  let usd = null
  let turns = null
  for (const f of frames) {
    if (!f.obj || f.obj.type !== 'result') continue
    if (Number.isFinite(f.obj.total_cost_usd)) usd = f.obj.total_cost_usd
    if (Number.isFinite(f.obj.num_turns)) turns = f.obj.num_turns
  }
  return { usd, turns }
}

// ── половина учения: общий каркас ──────────────────────────────────────────────────

/**
 * Поднять СВОЙ демон для одной половины. Ничего из предмета учения не подменяется:
 * сборка аргументов и запускатель — боевые, обёрнуты только ради наблюдения (см. шапку).
 */
async function startHalf({ key, port, projectDir, pipeline = true, staticDir, machineConfig }) {
  const halfRoot = join(DRILL_ROOT, key)
  const dataDir = join(halfRoot, 'data')
  const ledgerDir = join(halfRoot, 'ledger')
  const emptyLayer = join(halfRoot, 'empty-personal-layer')
  for (const d of [dataDir, ledgerDir, emptyLayer]) mkdirSync(d, { recursive: true })

  const accountDir = useMachineAccount(machineConfig)
  const dbName = `sma_steer_drill_${key.replace(/[^a-z0-9_]/gi, '_')}`
  const queueUrl = `postgres://postgres:postgres@${QUEUE_HOST}:${QUEUE_PORT}/${dbName}`
  const token = drillToken()

  const config = {
    ...machineConfig,
    port,
    bind: FRONT_HOST,
    token,
    queueUrl,
    dataDir,
    ledgerDir,
    repoDir: projectDir,
    tickMs: TICK_MS,
    projects: [],
    activeProject: null,
    pipeline: { enabled: pipeline === true },
    // ИСТОЧНИК ЛИЧНОГО СЛОЯ — ПУСТОЙ КАТАЛОГ, а не отключённое зеркало. Зеркало боевое:
    // именно оно кладёт хук-калитку в учётную запись, и без него предмета учения нет.
    personalLayer: { sourceDir: emptyLayer },
    workers: [
      {
        id: 'drill-live',
        lane: 'prod',
        provider: 'claude',
        enabled: true,
        model: DRILL_MODEL,
        account: { name: 'drill-live', configDir: accountDir },
      },
    ],
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
    ...(staticDir ? { staticDir } : {}),
    verbRunner: drillVerbRunner,
    tickProjectDir: () => projectDir,
    workerReady: () => ({ ready: true }),
    loadMcpRegistry: () => ({ servers: [] }),
    sweepWorktrees: async () => ({ skipped: 'drill' }),
    journal: (entry) => {
      journalEntries.push(entry)
      if (entry && typeof entry.type === 'string' && entry.type.startsWith('task.')) {
        info(
          `журнал: ${entry.type}` +
            `${entry.reason ? ` reason=${entry.reason}` : ''}` +
            `${entry.delivery ? ` delivery=${entry.delivery}` : ''}` +
            `${entry.hop ? ` hop=${entry.hop}` : ''}` +
            `${entry.detail ? ` — ${String(entry.detail).slice(0, 200)}` : ''}`,
        )
      }
    },
  })

  // ── ОБЁРТКИ НАБЛЮДЕНИЯ, И ОБЕ ОБЪЯВЛЕНЫ ВСЛУХ ──
  const realBuildArgs = handles.tickDeps.buildArgs
  const realSpawn = handles.tickDeps.spawnWorker
  if (typeof realBuildArgs !== 'function') {
    await shutdown(handles)
    notRun('в корне не собрана сборка аргументов — запускать нечего')
  }
  if (realSpawn !== PRODUCTION_SPAWN) {
    await shutdown(handles)
    notRun('запускатель в корне НЕ равен боевому по ссылке — учение отказывается выдавать чужой запуск за живой')
  }

  const spawns = []
  let argsWrapChecked = false
  handles.tickDeps.buildArgs = (task, route, options) => {
    const spec = realBuildArgs(task, route, options)
    const args = [...spec.args, HOOK_EVENTS_FLAG]
    if (!argsWrapChecked) {
      argsWrapChecked = true
      const prefixSame = spec.args.every((a, i) => a === args[i])
      if (!prefixSame || args.length !== spec.args.length + 1) {
        fail('обёртка наблюдения изменила боевые аргументы больше, чем на один флаг')
      } else {
        pass(`работник НАСТОЯЩИЙ: боевые аргументы не тронуты, добавлен ровно один флаг наблюдения ${HOOK_EVENTS_FLAG}`)
        info(`командная строка запуска: ${spec.bin} ${args.join(' ')}`)
      }
    }
    return { ...spec, args }
  }
  handles.tickDeps.spawnWorker = (opts) => {
    spawns.push({ bin: opts && opts.bin, args: [...((opts && opts.args) || [])], prompt: String((opts && opts.prompt) || ''), cwd: opts && opts.cwd })
    return realSpawn(opts)
  }

  await ensureDb(dbName)
  info(`создана отдельная база очереди ${dbName} (общая база учением не открывается)`)

  await handles.start()
  if (!(await waitForPort(port, FRONT_HOST, Date.now() + 20000))) {
    await shutdown(handles)
    await dropDb(dbName)
    notRun(`демон так и не начал слушать ${FRONT_HOST}:${port}`)
  }
  info(`демон учения поднят: порт ${port}, тик ${TICK_MS} мс, конвейер ${pipeline ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`)

  return { handles, config, dataDir, ledgerDir, accountDir, dbName, token, port, journalEntries, spawns }
}

async function shutdown(handles) {
  try {
    if (handles && typeof handles.stop === 'function') await handles.stop()
  } catch (err) {
    info(`остановка демона сказала: ${String((err && err.message) || err)}`)
  }
}

/** Убить СВОЕГО ребёнка — только через реестр СВОЕГО демона. Чужой недостижим. */
function stopOwnChild(ctx, taskId) {
  try {
    const reg = ctx.handles.tickDeps.attemptTurns
    if (reg && typeof reg.stop === 'function') return reg.stop(taskId)
  } catch {
    /* реестр молчит — значит убивать нечего */
  }
  return false
}

/**
 * ВХОД НЕ СОСТОЯЛСЯ — ЭТО НЕ «КАНАЛА НЕТ», И УЧЕНИЕ ОБЯЗАНО РАЗЛИЧАТЬ ЭТО СРАЗУ.
 *
 * Сессия, которую не пустили внутрь, печатает провайдерский обрыв и умирает; тик честно
 * заводит следующую попытку, и та умирает так же. Учение, которое просто ждёт кадров,
 * потратит на это всё окно ожидания и назовёт исходом молчание. Поэтому обрыв со словами
 * про вход читается из журнала СВОЕГО демона и обрывает половину третьим кодом с названной
 * причиной — вместе с тем, что надо сделать человеку.
 */
function authTrouble(ctx) {
  for (const e of ctx.journalEntries) {
    if (!e || e.type !== 'task.provider_abort') continue
    const text = `${e.detail ?? ''} ${e.error ?? ''}`
    if (/authenticat|oauth|expired|unauthorized|401/i.test(text)) return text.trim()
  }
  return null
}

/** Дождаться, пока сессия ЗАДЫШИТ: появился кадр результата первого вызова инструмента. */
async function waitForToolResult(ledgerDir, taskId, deadline, ctx) {
  while (Date.now() < deadline) {
    const auth = ctx ? authTrouble(ctx) : null
    if (auth) return { ok: false, auth }
    const frames = parsedFrames(framesOf(ledgerDir, taskId, 1))
    for (const f of frames) {
      const content = f.obj && f.obj.type === 'user' && f.obj.message && f.obj.message.content
      if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) {
        return { ok: true, frames: frames.length }
      }
    }
    await sleep(250)
  }
  return { ok: false }
}

async function waitForTerminal(ledgerDir, taskId, attempt, deadline, ctx) {
  while (Date.now() < deadline) {
    const t = terminalOf(ledgerDir, taskId, attempt)
    if (t) return t
    const auth = ctx ? authTrouble(ctx) : null
    if (auth) notRun(authAdvice(auth, ctx))
    await sleep(400)
  }
  return null
}

/** Что сказать человеку, когда внутрь не пустили. Команда — одна, и она его, а не наша. */
function authAdvice(text, ctx) {
  return (
    `ВХОД НЕ СОСТОЯЛСЯ: провайдер оборвал прогон словами «${String(text).slice(0, 160)}». ` +
    'Это НЕ отсутствие канала и НЕ исход учения — сессия просто не поднялась. ' +
    `Учётная запись работника (${ctx && ctx.accountDir}) требует нового входа: ` +
    `выполнить в терминале \`CLAUDE_CONFIG_DIR=<этот каталог> claude /login\` (или \`claude setup-token\` ` +
    'и положить полученный ключ в переменную окружения, названную в конфигурации работника), ' +
    'после чего прогнать половину заново.'
  )
}

// ── задания половин ────────────────────────────────────────────────────────────────

const NOTE_TAIL = [
  'Последними строками ответа выведи ровно две строки и ничего после них:',
  'APPROACH_NOTE: учение канала связи — только чтение, правок нет',
  'LESSON_NONE: учение связи, обобщать нечего',
].join('\n')

const NO_SIDE_EFFECTS = [
  'Файлы НЕ меняй, ничего НЕ коммить, команд оболочки НЕ запускай, урок командой НЕ пиши,',
  'индекс памяти НЕ читай (в этой копии его нет).',
].join(' ')

function readingTask(word) {
  return [
    'Это учение канала связи, а не работа с кодом. Сделай ровно следующее и ничего больше.',
    '',
    '1. ЧЕТЫРЕ раза подряд прочитай файл `target.txt` в корне рабочей копии — по одному вызову',
    '   инструмента чтения за раз, один за другим.',
    `2. ${NO_SIDE_EFFECTS}`,
    '3. В ИТОГОВОМ ответе процитируй ДОСЛОВНО текст любой поправки, которая приехала тебе',
    '   по ходу работы отдельным сообщением. Если ничего не приезжало — так и напиши:',
    '   «поправок не было».',
    '',
    NOTE_TAIL,
    word ? `(в этом учении приметное слово, если оно приедет, начинается на ${word.slice(0, 6)})` : '',
  ]
    .filter((s) => s !== '')
    .join('\n')
}

function lastCallTask() {
  return [
    'Это учение канала связи, а не работа с кодом. Сделай ровно следующее и ничего больше.',
    '',
    '1. РОВНО ОДИН раз прочитай файл `target.txt` в корне рабочей копии.',
    '2. После этого чтения НЕ делай НИ ОДНОГО вызова инструментов — ни чтений, ни поиска,',
    '   ни команд. Дальше только обычный текст ответа.',
    `3. ${NO_SIDE_EFFECTS}`,
    '4. В ИТОГОВОМ ответе процитируй ДОСЛОВНО текст любой поправки, которая приехала тебе',
    '   по ходу работы отдельным сообщением; если ничего не приезжало — напиши',
    '   «поправок не было».',
    '',
    NOTE_TAIL,
  ].join('\n')
}

function questionTask() {
  return [
    'Это учение возврата вопроса. Кода не трогай.',
    '',
    '1. Один раз прочитай файл `target.txt` в корне рабочей копии.',
    '2. Требование в нём читается двояко, и выбрать за человека нельзя.',
    `3. ${NO_SIDE_EFFECTS}`,
    '4. Закончи ход ВОПРОСОМ словами: что именно решается, какие варианты ты видишь,',
    '   что предлагаешь. Не выбирай молча и не придумывай правку.',
    '',
    NOTE_TAIL,
  ].join('\n')
}

const READING_TARGET = 'строка-мишень учения живого слова: её читают несколько раз подряд\n'
const QUESTION_TARGET = [
  'требование: «отчёт должен выходить регулярно».',
  'здесь не сказано, что значит регулярно: раз в день или раз в неделю —',
  'и от этого зависит вся остальная работа.',
].join('\n')

// ── половина «слово», «контроль», «последний вызов», «перебить» ────────────────────

/**
 * @param {{key:string, title:string, port:number, taskText:string, target:string,
 *          mode:('steer'|'interrupt'|null), expectWord:boolean, machineConfig:object}} o
 */
async function runWordHalf(o) {
  head(`ПОЛОВИНА «${o.title}» — ${o.key}`)

  const projectDir = join(DRILL_ROOT, o.key, 'project')
  const proj = buildProject(projectDir, o.target)
  info(`проект учения: ${projectDir} (вершина ${proj.head.slice(0, 8)})`)

  const word = `STEER-AMBER-OWL-${Math.floor(Math.random() * 9000 + 1000)}`
  info(`приметное слово половины: ${word}`)

  const ctx = await startHalf({ key: o.key, port: o.port, projectDir, machineConfig: o.machineConfig })
  const taskId = `drill-${o.key}-${Date.now()}`
  let doorAnswer = null
  let sentAt = null
  let breath = null

  try {
    await ctx.handles.adapter.enqueue({
      id: taskId,
      source: 'roster',
      title: `учение живого слова: ${o.title}`,
      lane: 'prod',
      description: o.taskText,
    })
    info(`задача положена в очередь учения: ${taskId}`)

    // ── (1) ждём, пока сессия задышит ──
    breath = await waitForToolResult(ctx.ledgerDir, taskId, Date.now() + BREATH_TIMEOUT_MS, ctx)
    if (!breath.ok) {
      stopOwnChild(ctx, taskId)
      if (breath.auth) notRun(authAdvice(breath.auth, ctx))
      notRun(
        `сессия не задышала за ${Math.round(BREATH_TIMEOUT_MS / 1000)} с (ни одного кадра результата вызова ` +
          'инструмента) — слово слать некуда, и учение не выдаёт это за исход',
      )
    }
    pass(`сессия задышала: в стенограмме есть результат вызова инструмента (кадров: ${breath.frames})`)

    // ── (2) слово в СВОЮ дверь ──
    if (o.mode) {
      doorAnswer = await callDoor({
        port: ctx.port,
        token: ctx.token,
        path: '/api/redirect',
        body: { taskId, text: `КОДОВОЕ СЛОВО ${word}`, mode: o.mode },
      })
      sentAt = Date.now()
      info(`дверь ${o.mode}: ${doorAnswer.status} ${doorAnswer.raw.slice(0, 200)}`)
      if (doorAnswer.status !== 200) {
        stopOwnChild(ctx, taskId)
        notRun(`дверь учения отказала (${doorAnswer.status}): ${doorAnswer.raw.slice(0, 300)}`)
      }
      if (o.mode === 'steer') {
        if (doorAnswer.body && doorAnswer.body.live === false) {
          pass('дверь ответила live:false — НИКОГО не убили, и поле значит ровно это')
        } else {
          fail(`дверь ответила live:${doorAnswer.body && doorAnswer.body.live} — третья судьба не имеет права убивать`)
        }
      }
      if (o.mode === 'interrupt') {
        if (doorAnswer.body && doorAnswer.body.live === true) {
          pass('дверь ответила live:true — живой ребёнок ДЕЙСТВИТЕЛЬНО убит, а не «нечего было убивать»')
        } else {
          fail(
            `дверь ответила live:${doorAnswer.body && doorAnswer.body.live} — значит убивать было некого, и ` +
              'половина «перебить» ничего живого не перебивала',
          )
        }
      }
    } else {
      info('слово НЕ посылается: это контрольная половина')
    }

    // ── (3) конец попытки ──
    const terminal = await waitForTerminal(ctx.ledgerDir, taskId, 1, Date.now() + ATTEMPT_TIMEOUT_MS, ctx)
    if (!terminal) {
      stopOwnChild(ctx, taskId)
      notRun(`попытка не кончилась за ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)} с — свой ребёнок остановлен своим реестром`)
    }
    info(`попытка кончилась: outcome=${terminal.outcome} reason=${terminal.failureReason || '—'} receipt=${JSON.stringify(terminal.receiptRef ?? null)}`)

    // ── (4) утверждения по стенограмме ──
    const frames = parsedFrames(framesOf(ctx.ledgerDir, taskId, 1))
    const ids = sessionIdsOf(frames)
    const cost = costOf(frames)
    info(`кадров в стенограмме: ${frames.length}; различных идентификаторов сессии: ${ids.length}; ходов: ${cost.turns ?? '—'}; стоимость: ${cost.usd === null ? '—' : `$${cost.usd.toFixed(4)}`}`)
    info(`стенограмма: ${join(ctx.ledgerDir, `${attemptIdFor(taskId, 1).replace(/[^A-Za-z0-9._-]/g, '_')}.log.ndjson`)}`)

    const hookFrames = frames.filter(
      (f) => f.obj && f.obj.type === 'system' && f.obj.subtype === 'hook_response' && f.line.includes(word),
    )
    const modelFrames = frames.filter(
      (f) => f.obj && (f.obj.type === 'assistant' || f.obj.type === 'result') && f.line.includes(word),
    )
    const resultIdx = frames.findIndex((f) => f.obj && f.obj.type === 'result')
    const hookIdx = frames.findIndex(
      (f) => f.obj && f.obj.type === 'system' && f.obj.subtype === 'hook_response' && f.line.includes(word),
    )

    if (o.expectWord) {
      if (o.mode === 'interrupt') {
        // СЛОВО ПЕРЕБИТОГО ХОДА ЕДЕТ ПРОДОЛЖЕНИЕМ, НЕ КАЛИТКОЙ: живой ребёнок убит в момент
        // приёма (дверь ответила live:true), и отдавать слово ему уже некому. Требовать здесь
        // кадр хука — требовать доставку в процесс, которого по устройству перебивания больше
        // нет. Доказательство доставки этого режима — слово в задании продолжения (утверждается
        // ниже) плюс слово, ПРОЧИТАННОЕ моделью. Первый живой прогон 24.08.2026 показал ровно
        // это: слово в кадрах модели есть, кадра калитки нет — и это правильная форма.
        if (hookFrames.length > 0) {
          info(`кадр ответа хука со словом всё же есть (${hookFrames.length} шт.) — слово догнало ход ещё и калиткой`)
        }
      } else if (hookFrames.length > 0) {
        pass(`кадр ответа хука несёт слово допконтекстом (${hookFrames.length} шт.) — калитка отдала слово живому ходу`)
      } else {
        fail('кадра ответа хука со словом НЕТ — калитка слова не отдала (или флаг наблюдения не доехал)')
      }
      if (modelFrames.length > 0) {
        pass(`модель ПРОЧИТАЛА слово: оно есть в её кадрах (${modelFrames.length} шт.)`)
      } else {
        fail('слова нет ни в одном кадре модели — доставка не подтверждена второй половиной доказательства')
      }
      if (hookIdx >= 0 && resultIdx >= 0 && hookIdx < resultIdx) {
        pass(`слово предъявлено ДО итогового кадра (кадр ${hookIdx} против итога ${resultIdx})`)
      } else if (hookIdx >= 0 && resultIdx < 0) {
        info('итогового кадра в стенограмме нет — порядок «до итога» не проверяется')
      } else if (hookIdx >= 0) {
        fail(`слово предъявлено ПОСЛЕ итогового кадра (${hookIdx} против ${resultIdx}) — это уже не живой ход`)
      }
    } else {
      if (hookFrames.length === 0 && modelFrames.length === 0) {
        pass('КОНТРОЛЬ: приметного слова в стенограмме НЕТ ни в кадрах хука, ни в кадрах модели — учение видит разницу')
      } else {
        fail('КОНТРОЛЬ: слово нашлось там, где его никто не посылал — учение слепо и его зелёное ничего не значит')
      }
    }

    if (ids.length === 1) {
      pass(`идентификатор сессии ОДИН на всех кадрах: ${ids[0]}`)
    } else {
      fail(`различных идентификаторов сессии ${ids.length}: ${ids.join(', ')} — сессия не одна`)
    }

    // ── (5) сколько раз запускали процесс ──
    const spawnCount = ctx.spawns.length
    const resumed = ctx.spawns.filter((s) => s.args.includes('--resume'))
    info(`запусков процесса за половину: ${spawnCount}; с возобновлением: ${resumed.length}`)

    if (o.mode === 'interrupt') {
      if (spawnCount >= 2) {
        pass(`после убийства был ВТОРОЙ запуск — попытка вернулась (запусков: ${spawnCount})`)
      } else {
        fail(`запуск был один — продолжение не поднялось, «вернуться с места остановки» не показано`)
      }
      const cont = ctx.spawns[1]
      if (cont && cont.args.includes('--resume')) {
        const sid = cont.args[cont.args.indexOf('--resume') + 1]
        if (ids.includes(sid)) {
          pass(`продолжение возобновило ТУ ЖЕ сессию: --resume ${sid} совпал с идентификатором кадров`)
        } else {
          fail(`продолжение возобновило сессию ${sid}, которой нет среди кадров попытки`)
        }
      } else {
        fail('во втором запуске нет возобновления — сессия начата с нуля, место остановки потеряно')
      }
      if (cont && cont.prompt.includes(word)) {
        pass('задание продолжения несёт слово поправки')
      } else {
        fail('задание продолжения слова поправки НЕ несёт — убили и не доставили')
      }
      if (cont && cont.prompt.includes(correctionsPreamble([{ text: word }]).split('\n')[0])) {
        pass('шапка поправки — та же, что у производителя слов (одна форма у всех носителей)')
      } else {
        info('шапка поправки не сверена дословно (производитель мог измениться) — слово важнее шапки')
      }
    } else if (o.mode === 'steer' && o.expectWord) {
      if (spawnCount === 1) {
        pass('запуск был РОВНО ОДИН: слово доехало без повторного подъёма сессии')
      } else {
        fail(`запусков ${spawnCount} — слово доехало не в живой ход, а перезапуском`)
      }
    }

    // ── (6) что осталось в хранилище поправок ──
    const pending = readPendingRedirects({ dataDir: ctx.dataDir, taskId })
    info(`ждущих поправок после половины: ${pending.length}`)

    return {
      key: o.key,
      taskId,
      word,
      frames: frames.length,
      sessionIds: ids,
      cost,
      spawnCount,
      pending: pending.length,
      terminal,
      door: doorAnswer && doorAnswer.body,
      sentAt,
      transcripts: keepTranscripts(ctx.ledgerDir, o.key),
    }
  } finally {
    await shutdown(ctx.handles)
    await dropDb(ctx.dbName)
  }
}

// ── половина «последний вызов» ────────────────────────────────────────────────────

async function runLastCallHalf({ port, machineConfig }) {
  const key = 'posledniy-vyzov'
  head('ПОЛОВИНА «последний вызов» — открытый вопрос (а) решения о честном жёлтом')
  say('  ИСХОД НЕ ПРЕДРЕШЁН. Доехало в тот же ход — так и запишем; не доехало — утверждаем')
  say('  СТРАХОВКУ (строка осталась ждущей и доехала возобновлением). Оба исхода законны.')

  const projectDir = join(DRILL_ROOT, key, 'project')
  buildProject(projectDir, READING_TARGET)
  const word = `STEER-LAST-CALL-${Math.floor(Math.random() * 9000 + 1000)}`
  info(`приметное слово половины: ${word}`)

  const ctx = await startHalf({ key, port, projectDir, machineConfig })
  const taskId = `drill-${key}-${Date.now()}`

  try {
    await ctx.handles.adapter.enqueue({
      id: taskId,
      source: 'roster',
      title: 'учение живого слова: слово после последнего вызова',
      lane: 'prod',
      description: lastCallTask(),
    })
    info(`задача положена в очередь учения: ${taskId}`)

    const breath = await waitForToolResult(ctx.ledgerDir, taskId, Date.now() + BREATH_TIMEOUT_MS, ctx)
    if (!breath.ok) {
      stopOwnChild(ctx, taskId)
      if (breath.auth) notRun(authAdvice(breath.auth, ctx))
      notRun('сессия не сделала ни одного вызова инструмента — послать слово «после последнего вызова» некуда')
    }
    pass('единственный вызов инструмента состоялся — дальше вызовов быть не должно')

    const door = await callDoor({
      port: ctx.port,
      token: ctx.token,
      path: '/api/redirect',
      body: { taskId, text: `КОДОВОЕ СЛОВО ${word}`, mode: 'steer' },
    })
    info(`дверь steer: ${door.status} ${door.raw.slice(0, 200)}`)
    if (door.status !== 200) {
      stopOwnChild(ctx, taskId)
      notRun(`дверь учения отказала (${door.status}): ${door.raw.slice(0, 300)}`)
    }

    const terminal = await waitForTerminal(ctx.ledgerDir, taskId, 1, Date.now() + ATTEMPT_TIMEOUT_MS, ctx)
    if (!terminal) {
      stopOwnChild(ctx, taskId)
      notRun('попытка не кончилась — свой ребёнок остановлен своим реестром')
    }

    const frames = parsedFrames(framesOf(ctx.ledgerDir, taskId, 1))
    const ids = sessionIdsOf(frames)
    const cost = costOf(frames)
    const hookSaw = frames.some(
      (f) => f.obj && f.obj.type === 'system' && f.obj.subtype === 'hook_response' && f.line.includes(word),
    )
    const modelSaw = frames.some(
      (f) => f.obj && (f.obj.type === 'assistant' || f.obj.type === 'result') && f.line.includes(word),
    )
    const resumedSpawns = ctx.spawns.filter((s) => s.args.includes('--resume'))
    const carriedWord = resumedSpawns.filter((s) => s.prompt.includes(word))
    const pending = readPendingRedirects({ dataDir: ctx.dataDir, taskId })

    info(`кадров: ${frames.length}; сессий: ${ids.length}; запусков: ${ctx.spawns.length}; с возобновлением: ${resumedSpawns.length}`)
    info(`ждущих поправок в конце: ${pending.length}`)

    let verdict
    if (hookSaw && modelSaw) {
      verdict = 'ДОЕЗЖАЕТ В ТОТ ЖЕ ХОД'
      pass('слово доехало в тот же ход даже после последнего вызова инструмента: кадр хука + чтение моделью')
    } else if (carriedWord.length > 0) {
      verdict = 'НЕ ДОЕЗЖАЕТ В ТОТ ЖЕ ХОД; ДОВОЗИТ ПРОДОЛЖЕНИЕ'
      pass('СТРАХОВКА СРАБОТАЛА: непотреблённое слово довезено возобновлением ТОЙ ЖЕ сессии после хода')
      const sid = carriedWord[0].args[carriedWord[0].args.indexOf('--resume') + 1]
      if (ids.includes(sid)) pass(`возобновление шло по тому же идентификатору сессии: ${sid}`)
      else fail(`возобновление шло по идентификатору ${sid}, которого нет среди кадров`)
      say('  ВЕРДИКТ СЛОВАМИ: ход, в котором вызовов инструментов больше не будет, слова до своего')
      say('  конца НЕ увидит. Это ограничение канала, и оно записывается в доки словами; пункт')
      say('  реестра о впрыске от этого зелёным не становится (решения о честном жёлтом).')
    } else {
      verdict = 'НЕ ДОЕХАЛО НИ ОДНИМ ПУТЁМ'
      fail('слово не доехало ни в ход, ни продолжением — обещание хранилища сорвано')
    }
    say(`\n  ОТКРЫТЫЙ ВОПРОС (а) — ВЕРДИКТ: ${verdict}`)

    return {
      key,
      taskId,
      word,
      verdict,
      frames: frames.length,
      sessionIds: ids,
      cost,
      spawnCount: ctx.spawns.length,
      pending: pending.length,
      transcripts: keepTranscripts(ctx.ledgerDir, key),
    }
  } finally {
    await shutdown(ctx.handles)
    await dropDb(ctx.dbName)
  }
}

// ── половина «вопрос–ответ» ───────────────────────────────────────────────────────

async function runQuestionHalf({ port, machineConfig }) {
  const key = 'vopros-otvet'
  head('ПОЛОВИНА «вопрос — ответ — та же сессия»')

  const projectDir = join(DRILL_ROOT, key, 'project')
  buildProject(projectDir, QUESTION_TARGET)
  const answerWord = `HUMAN-ANSWER-${Math.floor(Math.random() * 9000 + 1000)}`
  info(`приметное слово ответа человека: ${answerWord}`)

  const ctx = await startHalf({ key, port, projectDir, machineConfig })
  const taskId = `drill-${key}-${Date.now()}`

  try {
    await ctx.handles.adapter.enqueue({
      id: taskId,
      source: 'roster',
      title: 'учение живого слова: вопрос по ходу',
      lane: 'prod',
      description: questionTask(),
    })
    info(`задача положена в очередь учения: ${taskId}`)

    const first = await waitForTerminal(ctx.ledgerDir, taskId, 1, Date.now() + ATTEMPT_TIMEOUT_MS, ctx)
    if (!first) {
      stopOwnChild(ctx, taskId)
      notRun('первая попытка не кончилась — свой ребёнок остановлен своим реестром')
    }
    info(`первая попытка: outcome=${first.outcome} receipt=${JSON.stringify(first.receiptRef ?? null)} session=${first.sessionId || '—'}`)

    const firstFrames = parsedFrames(framesOf(ctx.ledgerDir, taskId, 1))
    const firstIds = sessionIdsOf(firstFrames)
    const answerText = firstFrames
      .filter((f) => f.obj && f.obj.type === 'result')
      .map((f) => String((f.obj && f.obj.result) || ''))
      .join('\n')
    const asked = /\?/.test(answerText)
    if (asked) pass('работник закончил ход ВОПРОСОМ словами — право спросить дошло до того, кто им пользуется')
    else fail('в итоговом ответе первой попытки вопроса нет — работник решил за человека')
    if (typeof first.receiptRef === 'string' && first.receiptRef.startsWith('answer:')) {
      pass(`попытка вышла квитанцией ответа: ${first.receiptRef}`)
    } else {
      info(`квитанция первой попытки: ${JSON.stringify(first.receiptRef ?? null)} — форма ответа не выдана`)
    }

    // ── ответ человека уходит дверью возврата ──
    let ret = null
    const retDeadline = Date.now() + 60000
    for (;;) {
      ret = await callDoor({
        port: ctx.port,
        token: ctx.token,
        path: '/api/return',
        body: { taskId, note: `ОТВЕТ ЧЕЛОВЕКА: ${answerWord} — берём раз в неделю` },
      })
      if (ret.status === 200 || Date.now() > retDeadline) break
      await sleep(1000)
    }
    info(`дверь возврата: ${ret.status} ${ret.raw.slice(0, 200)}`)
    if (ret.status !== 200) {
      notRun(`дверь возврата отказала (${ret.status}): ${ret.raw.slice(0, 300)} — круг «вопрос-ответ» не замкнут`)
    }

    const second = await waitForTerminal(ctx.ledgerDir, taskId, 2, Date.now() + ATTEMPT_TIMEOUT_MS, ctx)
    if (!second) {
      stopOwnChild(ctx, taskId)
      notRun('вторая попытка не кончилась — круг «вопрос-ответ» не замкнут')
    }
    info(`вторая попытка: outcome=${second.outcome} receipt=${JSON.stringify(second.receiptRef ?? null)}`)

    const secondSpawn = ctx.spawns[ctx.spawns.length - 1]
    if (secondSpawn && secondSpawn.args.includes('--resume')) {
      const sid = secondSpawn.args[secondSpawn.args.indexOf('--resume') + 1]
      if (firstIds.includes(sid)) pass(`вторая попытка ВОЗОБНОВИЛА ту же сессию: --resume ${sid}`)
      else fail(`вторая попытка возобновила ${sid}, которой не было в кадрах первой (${firstIds.join(', ')})`)
    } else {
      fail('во второй попытке нет возобновления — ответ человека попал бы в пустую голову')
    }
    if (secondSpawn && secondSpawn.prompt.includes(answerWord)) {
      pass('задание второй попытки несёт ОТВЕТ человека')
    } else {
      fail('ответа человека в задании второй попытки нет')
    }
    const secondIds = sessionIdsOf(parsedFrames(framesOf(ctx.ledgerDir, taskId, 2)))
    if (secondIds.length && secondIds.every((id) => firstIds.includes(id))) {
      pass(`кадры второй попытки несут ТОТ ЖЕ идентификатор сессии: ${secondIds.join(', ')}`)
    } else {
      fail(`кадры второй попытки несут ${secondIds.join(', ') || 'ничего'} — сессия не та же`)
    }
    const resumedLogged = ctx.journalEntries.some((e) => e && e.type === 'task.session_resumed' && e.taskId === taskId)
    if (resumedLogged) pass('журнал назвал возобновление словами (task.session_resumed)')
    else info('журнал строки о возобновлении не написал — утверждение держится на аргументах запуска')

    const cost1 = costOf(firstFrames)
    const cost2 = costOf(parsedFrames(framesOf(ctx.ledgerDir, taskId, 2)))
    return {
      key,
      taskId,
      answerWord,
      attempts: attemptNumbers(ctx.ledgerDir, taskId),
      cost: { usd: (cost1.usd ?? 0) + (cost2.usd ?? 0), turns: (cost1.turns ?? 0) + (cost2.turns ?? 0) },
      spawnCount: ctx.spawns.length,
      transcripts: keepTranscripts(ctx.ledgerDir, key),
    }
  } finally {
    await shutdown(ctx.handles)
    await dropDb(ctx.dbName)
  }
}

// ── половина «окно»: свежая сборка ВНЕ дерева, поданная швом статики ───────────────

/**
 * Драйвер браузера разрешается в момент запуска — той же дисциплиной, что у движка прогона
 * окна: ни одной новой зависимости, а отсутствие драйвера — исход «НЕ ПРОГНАНО».
 */
async function resolveDriver() {
  const tried = []
  const external = process.env.SMA_UI_DRIVER
  const candidates = [
    ...(external ? [pathToFileURL(join(external, 'index.js')).href, pathToFileURL(external).href, external] : []),
    'playwright',
    'playwright-core',
    '@playwright/test',
  ]
  for (const pkg of candidates) {
    try {
      const mod = await import(pkg)
      const chromium = mod.chromium ?? (mod.default && mod.default.chromium)
      if (chromium) return { ok: true, chromium }
      tried.push(`${pkg} (нет chromium)`)
    } catch {
      tried.push(pkg)
    }
  }
  return { ok: false, reason: tried.join(', ') }
}

function buildWindow(outDir) {
  const viteBin = join(REPO_ROOT, 'spa', 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) notRun(`сборщик окна не найден по пути ${viteBin} — ставить его учение не имеет права`)
  // КАТАЛОГ НАЗВАН ЯВНО. Конфигу сборки верить нельзя: его выходной каталог — ССЫЛКА в
  // дерево основателя, и сборка по умолчанию опустошила бы его сборку.
  const out = execFileSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(REPO_ROOT, 'spa'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return String(out).trim().split('\n').slice(-4).join('\n')
}

async function runUiHalf({ port, machineConfig }) {
  const key = 'okno'
  head('ПОЛОВИНА «окно»: свежая сборка ВНЕ дерева, поданная швом статики')

  const outDir = join(DRILL_ROOT, key, 'window-build')
  const projectDir = join(DRILL_ROOT, key, 'project')
  mkdirSync(dirname(outDir), { recursive: true })
  buildProject(projectDir, READING_TARGET)

  // Место сборки — ВНЕ дерева, и это проверено тем же правилом, что и место учения.
  assertOutsideTrees(outDir)
  info(`каталог сборки окна: ${outDir} (вне рабочих деревьев)`)
  const tail = buildWindow(outDir)
  info(`сборка окна закончена:\n${tail}`)
  const built = readdirSync(outDir)
  if (!built.includes('index.html')) notRun(`в собранном каталоге нет index.html: ${built.join(', ')}`)
  pass(`окно собрано в каталог ВНЕ дерева: ${built.join(', ')}`)

  const driver = await resolveDriver()
  if (!driver.ok) {
    notRun(
      `драйвер браузера не разрешился (${driver.reason}) — прогон окна НЕ состоялся. Указать установленный: ` +
        'SMA_UI_DRIVER=<путь к node_modules/playwright>',
    )
  }
  info('драйвер браузера разрешён')

  // Конвейер ВЫКЛЮЧЕН: половине «окно» работник не нужен, и подписка на неё не тратится.
  const ctx = await startHalf({ key, port, projectDir, pipeline: false, staticDir: outDir, machineConfig })
  const taskId = `drill-${key}-${Date.now()}`
  const draft = `ЧЕРНОВИК-${Math.floor(Math.random() * 9000 + 1000)}`
  const url = `http://${FRONT_HOST}:${port}/?token=${ctx.token}`

  try {
    await ctx.handles.adapter.enqueue({
      id: taskId,
      source: 'roster',
      title: 'учение живого слова: карточка для окна',
      lane: 'prod',
    })
    info(`адрес окна учения: ${url}`)

    const browser = await driver.chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const consoleErrors = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
    })
    const composer = 'input[aria-label="Сообщение руководителю команды"]'
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(1500)
      // ЧТО ИМЕННО ОТДАЛ ДЕМОН — сборку из НАЗВАННОГО каталога, а не ссылку в чужое дерево.
      const html = await page.content()
      if (html.includes('<div id="root"')) pass('демон отдал окно из НАЗВАННОГО каталога сборки (шов статики употреблён)')
      else fail('на странице нет корня окна — шов статики отдал не то')

      await page.getByText('Разговор', { exact: false }).first().click({ timeout: 10000 })
      await page.waitForTimeout(800)
      await page.fill(composer, draft, { timeout: 10000 })
      await page.waitForTimeout(600)
      const typed = await page.inputValue(composer)
      if (typed === draft) pass(`черновик набран в поле разговора: «${draft}»`)
      else fail(`в поле оказалось «${typed}» вместо «${draft}»`)

      // (1) СМЕНА ЭКРАНА
      await page.getByText('Сегодня', { exact: false }).first().click({ timeout: 10000 })
      await page.waitForTimeout(800)
      await page.getByText('Разговор', { exact: false }).first().click({ timeout: 10000 })
      await page.waitForTimeout(800)
      const afterNav = await page.inputValue(composer)
      if (afterNav === draft) pass('черновик ПЕРЕЖИЛ смену экрана: ушли на соседний экран и вернулись — текст на месте')
      else fail(`после смены экрана в поле «${afterNav}» вместо «${draft}» — черновик съеден`)

      // (2) ПЕРЕЗАГРУЗКА
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(1500)
      await page.getByText('Разговор', { exact: false }).first().click({ timeout: 10000 })
      await page.waitForTimeout(800)
      const afterReload = await page.inputValue(composer)
      if (afterReload === draft) pass('черновик ПЕРЕЖИЛ перезагрузку страницы — текст на месте')
      else fail(`после перезагрузки в поле «${afterReload}» вместо «${draft}» — черновик съеден`)

      if (consoleErrors.length === 0) pass('окно не выругалось в консоль ни разу за прогон')
      else fail(`окно выругалось в консоль ${consoleErrors.length} раз(а): ${consoleErrors.slice(0, 3).join(' | ')}`)
    } finally {
      await browser.close()
    }

    // Общий прогон окна — движком продукта, его кодами и его квитанцией.
    const drive = await new Promise((res) => {
      execFile(
        process.execPath,
        [join(REPO_ROOT, 'scripts', 'sma', 'ui-drive.mjs'), url, 'wait:1500', 'click:Разговор', 'shot:razgovor'],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env },
        (err, stdout, stderr) => res({ code: err && Number.isFinite(err.code) ? err.code : err ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
      )
    })
    const receipt = (drive.stdout.match(/\.planning[\\/]ui-reviews[\\/][^\s]+/) || [])[0] || 'путь не напечатан'
    info(`движок прогона окна: код ${drive.code}; квитанция: ${receipt}`)
    say(drive.stdout.split('\n').slice(-25).join('\n'))
    if (drive.code === 0) pass('движок прогона окна: ЧИСТО (код 0)')
    else if (drive.code === 3) fail('движок прогона окна: НЕ ПРОГНАНО (код 3) — это не проход')
    else fail(`движок прогона окна нашёл блокеры (код ${drive.code})`)

    return { key, url, draft, outDir, built, driveCode: drive.code, receipt }
  } finally {
    await shutdown(ctx.handles)
    await dropDb(ctx.dbName)
  }
}

// ── место учения проверяется, а не предполагается ─────────────────────────────────

function forbiddenTrees() {
  const forbidden = [realpathSync(REPO_ROOT)]
  const common = gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir'], REPO_ROOT)
  if (common.ok) {
    try {
      forbidden.push(realpathSync(dirname(common.out)))
    } catch {
      /* нераскрываемый путь просто не попадает в список запретов */
    }
  }
  return forbidden
}

function assertOutsideTrees(path) {
  for (const tree of forbiddenTrees()) {
    if (path === tree || path.startsWith(tree + sep)) {
      notRun(`путь ${path} лежит ВНУТРИ рабочего дерева ${tree} — там учению писать нельзя (мина ссылок)`)
    }
  }
}

// ── ход учения ────────────────────────────────────────────────────────────────────

function removeDrillTree() {
  try {
    rmSync(DRILL_ROOT, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 })
  } catch (err) {
    // УБОРКА — НЕ СУДЬЯ. Бросок отсюда шёл из finally и ПОДМЕНЯЛ собой настоящий вердикт
    // (24.08.2026: EPERM Windows съел «НЕ ПРОГНАНО» двери возврата — человек увидел
    // «УЧЕНИЕ УПАЛО» без причины). Хвост временного дерева — факт хозяйства: сказать вслух,
    // оставить путь, но исход учения решают половины, а не rmdir.
    say(`  !!  временное дерево не убрано (${String((err && err.code) || err)}): ${DRILL_ROOT} — убрать руками`)
  }
}

const FLAGS = {
  word: '--word',
  control: '--control',
  lastCall: '--last-call',
  interrupt: '--interrupt',
  question: '--question',
  ui: '--ui',
  all: '--all',
}

async function main() {
  const argv = process.argv.slice(2)
  const want = (flag) => argv.includes(flag) || argv.includes(FLAGS.all)
  if (argv.length === 0) {
    say('Половины запускаются по одной — это деньги подписки:')
    say('  --word | --control | --last-call | --interrupt | --question | --ui | --all')
    say('  --keep <каталог> — сложить стенограммы наружу до уборки (иначе следа не остаётся)')
    process.exit(2)
  }
  const keepAt = argv.indexOf('--keep')
  if (keepAt >= 0) {
    const dir = argv[keepAt + 1]
    if (!dir || dir.startsWith('--')) notRun('после --keep нужен каталог, в который сложить стенограммы')
    keepDir = resolve(dir)
    assertOutsideTrees(keepDir)
  }

  say('=== учение живого слова: слово идущему ходу, вопрос по ходу, черновик окна ===')
  say(`рабочая копия: ${REPO_ROOT}`)
  say('ФОРМА ПРОГОНА: работник НАСТОЯЩИЙ. Сборка аргументов и запускатель — боевые, обёрнуты')
  say('только ради наблюдения (один флаг кадров хуков + запись командной строки). Подмены нет.')

  // ── (0) ПРОБЫ ──
  head('ПРОБЫ ПЕРЕД СТАРТОМ')
  if (!(await probePort(QUEUE_PORT, QUEUE_HOST))) {
    notRun(`очередь Postgres ${QUEUE_HOST}:${QUEUE_PORT} не отвечает — поднять её: cd ~/pg-sandbox && node start.mjs`)
  }
  info(`очередь ${QUEUE_HOST}:${QUEUE_PORT} отвечает`)

  const needPorts = [FLAGS.word, FLAGS.control, FLAGS.lastCall, FLAGS.interrupt, FLAGS.question, FLAGS.ui].filter((f) => want(f)).length
  const ports = []
  for (let p = PORT_FIRST; p <= PORT_LAST && ports.length < needPorts; p += 1) {
    // eslint-disable-next-line no-await-in-loop -- пробы портов идут по одной намеренно
    if (!(await probePort(p))) ports.push(p)
  }
  if (ports.length < needPorts) {
    notRun(`свободных портов в диапазоне ${PORT_FIRST}..${PORT_LAST} нашлось ${ports.length}, нужно ${needPorts} — учение не отбирает чужой порт`)
  }
  info(`свободные порты учения: ${ports.join(', ')} (7777 общий демон и 7788 соседние окна не трогаются)`)

  try {
    info(`git на месте: ${git(['--version'], REPO_ROOT)}`)
  } catch (err) {
    notRun(`git недоступен: ${String((err && err.message) || err)}`)
  }

  assertOutsideTrees(DRILL_ROOT)
  info(`место учения: ${DRILL_ROOT} (вне рабочих деревьев: ${forbiddenTrees().join(', ')})`)

  const machineConfig = loadConfig()

  head('ПОДГОТОВКА')
  removeDrillTree()
  mkdirSync(DRILL_ROOT, { recursive: true })
  info('дерево прошлой попытки убрано (уборка на ВХОДЕ, а не только на выходе)')
  await dropOwnStaleDbs()

  const results = {}
  let nextPort = 0
  try {
    if (want(FLAGS.word)) {
      results.word = await runWordHalf({
        key: 'slovo',
        title: 'слово идущему ходу',
        port: ports[nextPort++],
        taskText: readingTask(),
        target: READING_TARGET,
        mode: 'steer',
        expectWord: true,
        machineConfig,
      })
    }
    if (want(FLAGS.control)) {
      results.control = await runWordHalf({
        key: 'kontrol',
        title: 'контроль: та же задача без слова',
        port: ports[nextPort++],
        taskText: readingTask(),
        target: READING_TARGET,
        mode: null,
        expectWord: false,
        machineConfig,
      })
    }
    if (want(FLAGS.lastCall)) {
      results.lastCall = await runLastCallHalf({ port: ports[nextPort++], machineConfig })
    }
    if (want(FLAGS.interrupt)) {
      results.interrupt = await runWordHalf({
        key: 'perebit',
        title: 'перебить посреди хода и вернуться с места остановки',
        port: ports[nextPort++],
        taskText: readingTask(),
        target: READING_TARGET,
        mode: 'interrupt',
        expectWord: true,
        machineConfig,
      })
    }
    if (want(FLAGS.question)) {
      results.question = await runQuestionHalf({ port: ports[nextPort++], machineConfig })
    }
    if (want(FLAGS.ui)) {
      results.ui = await runUiHalf({ port: ports[nextPort++], machineConfig })
    }
  } finally {
    head('ПОСЛЕ УЧЕНИЯ')
    settleRestores()
    removeDrillTree()
    info('временные репозитории, каталоги данных, учётная запись учения и сборка окна убраны')
    info('общая очередь и общий демон не открывались')
  }

  finish(results)
}

function finish(results) {
  head('ИТОГ')
  let totalUsd = 0
  let sessions = 0
  for (const [name, r] of Object.entries(results)) {
    if (!r) continue
    const usd = r.cost && Number.isFinite(r.cost.usd) ? r.cost.usd : 0
    totalUsd += usd
    sessions += Number.isFinite(r.spawnCount) ? r.spawnCount : 0
    say(
      `  ${name}: задача=${r.taskId ?? '—'} запусков=${r.spawnCount ?? 0} ` +
        `сессий-в-кадрах=${(r.sessionIds && r.sessionIds.length) ?? '—'} ` +
        `${r.verdict ? `вердикт=${r.verdict} ` : ''}` +
        `${usd ? `стоимость=$${usd.toFixed(4)}` : ''}`,
    )
  }
  say(`  ВСЕГО запусков настоящего работника: ${sessions}; стоимость по кадрам итога: $${totalUsd.toFixed(4)}`)
  say(
    failCount === 0
      ? '\nRESULT: ЧИСТО (exit 0)'
      : `\nRESULT: БЛОКЕРЫ (exit 1) — не подтвердилось утверждений: ${failCount}`,
  )
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((err) => {
  try {
    settleRestores()
  } catch {
    /* аварийный выход всё равно пробует вернуть чужой файл на место */
  }
  if (err instanceof NotRunError) {
    say(`\nНЕ ПРОГНАНО: ${err.message}`)
    say('RESULT: НЕ ПРОГНАНО (exit 3) — это НЕ проход и никогда в проход не переписывается.')
    process.exit(3)
  }
  console.error('УЧЕНИЕ УПАЛО:', err && err.stack ? err.stack : err)
  console.error(`Временное дерево могло остаться: ${DRILL_ROOT} — убрать руками, если оно там.`)
  process.exit(1)
})
