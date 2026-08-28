/**
 * live-outage-drill.mjs — ПАДЕНИЕ ДЕМОНА, ПРОГНАННОЕ ПО-НАСТОЯЩЕМУ.
 *
 * Три обещания закрывают дыру «упал демон — упало окно и бот вместе с ним»:
 *   (а) окно, оставшееся открытым, говорит человеку СЛОВАМИ, что связь потеряна;
 *   (б) сторож поднимает демона сам, без терминала;
 *   (в) в телеграм приходят два сообщения — о падении и о подъёме, — и «поднялся» шлёт ТОТ,
 *       КТО ПОДНЯЛСЯ, уже после того, как его дверь ответила.
 *
 * Разбор решений проверяется сьютом (daemon/__tests__/outage-watch.test.ts). Этот прогон
 * проверяет ДРУГОЕ и незаменимое: что всё это происходит на живых процессах — настоящий
 * демон, настоящее убийство процесса, настоящий подъём, настоящая отправка через сокет — и
 * что времена складываются в тот порядок, который обещан.
 *
 *   node supervisor/live-outage-drill.mjs            падение → подъём → два сообщения
 *   node supervisor/live-outage-drill.mjs --window   слово окна при мёртвой двери (ui-drive)
 *   node supervisor/live-outage-drill.mjs --all      оба акта подряд
 *
 * ═══════════════ ЧЕГО ЭТОТ ПРОГОН НЕ ТРОГАЕТ ════════════════════════════════════
 *
 * СВОЯ БАЗА ОЧЕРЕДИ. Демон прогона поднимается на ОТДЕЛЬНОЙ базе (`sma_queue_drill` в той же
 * песочнице Postgres), а не на боевой. Причина не в аккуратности: у демона на загрузке есть
 * суточный обход копий закрытых задач, и обход, увидевший ЧУЖУЮ очередь, рассуждал бы о чужих
 * копиях. База создаётся один раз и остаётся — она пустая и стоит нисколько.
 *
 * СВОЙ АДРЕС BOT API. Отправка настоящая — тот же `sendMessage`, тот же клиент, тот же сокет,
 * — но уезжает она на подставной Bot API этого прогона (`telegram.apiBase` в конфиге прогона),
 * а не в чат владельца. Учебное сообщение в живой чат было бы наглостью, а подделка функции
 * отправки не доказала бы ровно того, ради чего прогон существует, — что времена реальны.
 *
 * СВОЙ ПОДЪЁМ. `liftCommand()` на Windows указывает на `start-daemon-windows.ps1`, который
 * поднимает БОЕВОГО демона машины. Здесь подъём указывает на тот же composition root, которым
 * тот скрипт кончается (`daemon/src/main.mjs`), но с конфигом прогона. Проверяется решение
 * сторожа «поднять», а не то, какой именно демон стоит на этой машине.
 *
 * СВОЙ КАТАЛОГ. Конфиг, данные, журнал попыток и рабочее дерево — всё во временном каталоге.
 * Ни один файл боевого демона не читается на запись и не трогается.
 *
 * Node built-ins плюс `pg` (через package.json демона — своего у супервизора нет).
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createServer as netCreateServer } from 'node:net'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Порты прогона БЕРУТСЯ СВОБОДНЫМИ, а не назначаются числом.
 *
 * Прибитый гвоздём порт делает прогон заложником всего, что на этой машине занимает то же
 * число, — и врёт при этом самым дорогим способом: 28.08 порт 7791 занял чужой процесс,
 * поднятый работником для своей проверки, поэтому «убитый» демон продолжал отвечать, падение
 * не объявилось и прогон отчитался тремя провалами, ни один из которых не был про продукт.
 * Полчаса ушло на поиск ошибки в правке, которой там не было.
 *
 * Ядро само отдаёт свободный порт на listen(0) — это и есть единственный надёжный способ
 * узнать, что порт свободен: не спросить, а занять.
 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = netCreateServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

const FRONT_PORT = await freePort()
const BOT_PORT = await freePort()
const WINDOW_PORT = await freePort()
const DEADLINE_MS = 240000

let failCount = 0
const pass = (m) => console.log(`PASS  ${m}`)
const fail = (m) => {
  failCount += 1
  console.log(`FAIL  ${m}`)
}
const info = (m) => console.log(`  ..  ${m}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** «09:41:07.412» — времена этого прогона читает человек, а не машина. */
const hms = (ms) => new Date(ms).toISOString().slice(11, 23)

// ── акт первый: падение, подъём и два сообщения ───────────────────────────────────

/**
 * Подставной Bot API — настоящий HTTP-сервер, отвечающий как телеграм. Он записывает КАЖДЫЙ
 * вызов со своим временем: именно эта лента, а не журнал демона, доказывает порядок.
 */
function startBotStandIn(port) {
  const tape = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const method = String(req.url || '').split('/').pop()
      let text = ''
      try {
        text = String(JSON.parse(body || '{}').text ?? '')
      } catch {
        text = ''
      }
      tape.push({ method, text, at: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json' })
      // getUpdates обязан вернуть массив, остальным хватает объекта.
      res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : { message_id: tape.length } }))
    })
  })
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ tape, close: () => server.close() })))
}

/** Сообщения, которые человек увидел бы в чате: служебный опрос обновлений — не сообщение. */
const messagesOf = (tape) => tape.filter((e) => e.method === 'sendMessage')

/**
 * Отдельная база очереди для прогона. Создаётся, если её нет; 42P04 (уже есть) — это успех,
 * а не ошибка. Единственный оператор, который здесь выполняется, — CREATE DATABASE.
 */
async function ensureDrillDatabase(queueUrl) {
  const require = createRequire(join(ROOT, 'daemon', 'package.json'))
  const pg = require('pg')
  const url = new URL(queueUrl)
  const dbName = url.pathname.replace(/^\//, '')
  const admin = new URL(queueUrl)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 5000 })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${dbName}`)
    info(`база очереди ${dbName} создана`)
  } catch (err) {
    if (err && err.code === '42P04') info(`база очереди ${dbName} уже есть`)
    else throw err
  } finally {
    await client.end()
  }
}

/** Стук в дверь прогона: {answered, status}. Никогда не бросает. */
async function knock(config) {
  try {
    const res = await fetch(`http://${config.bind}:${config.port}/api/state`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(2000),
    })
    return { answered: true, status: res.status }
  } catch {
    return { answered: false, status: 0 }
  }
}

async function waitForDoor(config, timeoutMs) {
  const until = Date.now() + timeoutMs
  for (;;) {
    if ((await knock(config)).answered) return true
    if (Date.now() >= until) return false
    await sleep(200)
  }
}

async function actOutage() {
  const { loadConfig } = await import('../daemon/src/config.mjs')
  const { createWatch } = await import('../daemon/src/watch.mjs')
  const { outageMarkerPath, outageReceiptsDir } = await import('../daemon/src/outage.mjs')

  const scratch = mkdtempSync(join(tmpdir(), 'sma-outage-drill-'))
  const configPath = join(scratch, 'config.json')
  const repoDir = join(scratch, 'repo')
  mkdirSync(repoDir, { recursive: true })

  // Адрес очереди берётся у боевого конфига (та же песочница Postgres) и переписывается на
  // СВОЮ базу: пароль и порт песочницы — знание машины, а не этого файла.
  const homeConfigPath = join(process.env.USERPROFILE || process.env.HOME || '', '.sma-daemon', 'config.json')
  if (!existsSync(homeConfigPath)) {
    fail(`конфига демона на этой машине нет (${homeConfigPath}) — прогону неоткуда взять адрес очереди.`)
    return
  }
  const queueUrl = new URL(JSON.parse(readFileSync(homeConfigPath, 'utf8')).queueUrl)
  queueUrl.pathname = '/sma_queue_drill'

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        queueUrl: queueUrl.toString(),
        bind: '127.0.0.1',
        port: FRONT_PORT,
        token: randomBytes(16).toString('hex'),
        repoDir,
        workers: [],
        telegram: {
          botToken: '1000000:учебный-токен-этого-прогона',
          chatId: '424242',
          apiBase: `http://127.0.0.1:${BOT_PORT}`,
        },
      },
      null,
      2,
    ),
  )
  process.env.SMA_DAEMON_CONFIG = configPath

  await ensureDrillDatabase(queueUrl.toString())
  const bot = await startBotStandIn(BOT_PORT)
  const config = loadConfig({ repoDir: ROOT })
  info(`каталог прогона: ${scratch}`)

  /**
   * Демон прогона — тот же composition root, что и у боевого, но со своим конфигом. Вывод
   * уходит в файл рядом: boot, умерший молча, обязан оставить причину, а «унаследовал поток
   * прогона» — это нигде, когда прогон уже кончился.
   */
  const daemonLog = join(scratch, 'daemon.log')
  const children = []
  const spawnDaemon = () => {
    const fd = openSync(daemonLog, 'a')
    const child = spawn(process.execPath, [join(ROOT, 'daemon', 'src', 'main.mjs')], {
      cwd: ROOT,
      env: { ...process.env, SMA_DAEMON_CONFIG: configPath },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    children.push(child)
    return child
  }

  const done = () => {
    for (const c of children) {
      try {
        c.kill('SIGKILL')
      } catch {
        /* уже мёртв */
      }
    }
    bot.close()
  }

  try {
    // ── 1. живой демон ──
    const first = spawnDaemon()
    if (!(await waitForDoor(config, 90000))) {
      fail('демон прогона не поднялся с первого раза — дальше проверять нечего')
      info(`его вывод: ${daemonLog}`)
      console.log(existsSync(daemonLog) ? readFileSync(daemonLog, 'utf8').slice(-2000) : '(пусто)')
      return
    }
    pass(`демон прогона отвечает на :${FRONT_PORT}`)

    // ── 2. сторож встаёт рядом ──
    const watchLines = []
    const watch = createWatch({
      config,
      lift: { cmd: process.execPath, args: [join(ROOT, 'daemon', 'src', 'main.mjs')], cwd: ROOT },
      spawnLift: () => spawnDaemon(),
      log: (l) => {
        watchLines.push(l)
        info(`сторож: ${l}`)
      },
      pollMs: 1000,
      missesToDeclare: 2,
      liftCooldownMs: 20000,
    })
    void watch.run()
    pass('сторож пошёл: стук раз в секунду, падение — два молчания подряд')

    // ── 3. убийство ──
    //
    // SIGKILL, а не штатная остановка: штатная убирает запись о процессе, и сторож по этой
    // самой разнице отличает аварию от осознанного гашения. Здесь нужна авария.
    const killedAt = Date.now()
    first.kill('SIGKILL')
    info(`демон убит в ${hms(killedAt)}`)

    // ── 4. свои глаза на дверь ──
    //
    // Прогон смотрит на дверь САМ, часто и независимо от всех участников: «дверь ответила
    // снова» — это его собственное наблюдение, а не чужое слово. По нему и проверяется, что
    // сообщение о подъёме ушло ПОСЛЕ, а не до.
    let doorBackAt = 0
    let lastSilentAt = 0
    const eye = (async () => {
      const until = Date.now() + DEADLINE_MS
      for (;;) {
        const k = await knock(config)
        if (k.answered && doorBackAt === 0 && Date.now() > killedAt) {
          doorBackAt = Date.now()
          return
        }
        if (!k.answered) lastSilentAt = Date.now()
        if (Date.now() >= until) return
        await sleep(50)
      }
    })()

    // ── 5. ждём оба сообщения ──
    const until = Date.now() + DEADLINE_MS
    for (;;) {
      const said = messagesOf(bot.tape)
      if (said.length >= 2) break
      if (Date.now() >= until) break
      await sleep(250)
    }
    await eye
    watch.stop()

    const said = messagesOf(bot.tape)
    const fell = said.find((m) => m.text.includes('не отвечает'))
    const rose = said.find((m) => m.text.includes('поднялся'))

    if (fell) pass(`сообщение о падении пришло в ${hms(fell.at)} (через ${((fell.at - killedAt) / 1000).toFixed(1)} с после смерти)`)
    else fail('сообщения о падении не было')

    if (doorBackAt) pass(`дверь снова ответила в ${hms(doorBackAt)} (простой ${((doorBackAt - killedAt) / 1000).toFixed(1)} с)`)
    else fail('дверь так и не ответила — сторож демона не поднял')

    if (rose) pass(`сообщение о подъёме пришло в ${hms(rose.at)}`)
    else fail('сообщения о подъёме не было')

    // ── 6. ГЛАВНОЕ УТВЕРЖДЕНИЕ: порядок ──
    if (fell && rose) {
      if (fell.at < rose.at) pass('о падении сказано раньше, чем о подъёме')
      else fail(`порядок сообщений нарушен: падение ${hms(fell.at)}, подъём ${hms(rose.at)}`)
      if (!fell.text.includes('поднялся')) pass('в сообщении о падении нет обещания подъёма — сторож не обещает за поднявшегося')
      else fail('сообщение о падении обещает подъём')
    }
    // Проверяется НЕ «слово позже моего наблюдения». Глаз стучит раз в 50 мс, поэтому его
    // «дверь ожила» всегда ПОЗЖЕ настоящего оживания, а насколько — решает случай. Демон,
    // постучавший в свою дверь и сразу сказавший слово, попадает в этот зазор, и проверка
    // такого вида падает на ровном месте: она мерит не демона, а частоту опроса. Живой
    // прогон 28.08 разошёлся на ОДНУ миллисекунду именно так.
    //
    // Своими глазами устанавливается другое и достаточное: НЕ БЫЛО ЛИ МОЛЧАНИЯ ПОСЛЕ СЛОВА.
    // Скажи демон «поднялся» при мёртвой двери — глаз увидел бы молчание уже после этой
    // отметки. Он не увидел. Тот же отказ верить на слово, только без гонки.
    if (rose && doorBackAt) {
      if (rose.at > lastSilentAt) {
        pass(`«поднялся» ушло при уже живой двери: последнее молчание ${hms(lastSilentAt)}, слово ${hms(rose.at)}`)
      } else {
        fail(`«поднялся» ушло при мёртвой двери: молчание видели в ${hms(lastSilentAt)} — ПОСЛЕ слова в ${hms(rose.at)}`)
      }
    }

    // ── 7. квитанция ──
    const receiptsDir = outageReceiptsDir(config)
    const files = existsSync(receiptsDir) ? readdirSync(receiptsDir).filter((f) => f.endsWith('.json')) : []
    if (files.length !== 1) {
      fail(`квитанций о провале должно быть ровно одна, найдено ${files.length} (${receiptsDir})`)
    } else {
      const receiptPath = join(receiptsDir, files[0])
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      pass(`квитанция: ${receiptPath}`)
      console.log(JSON.stringify(receipt, null, 2))
      for (const key of ['downAt', 'declaredAt', 'fallNotifiedAt', 'doorBackAt', 'roseAt', 'riseNotifiedAt']) {
        if (receipt[key]) pass(`квитанция несёт ${key}: ${receipt[key]}`)
        else fail(`в квитанции нет времени ${key}`)
      }
      if (Array.isArray(receipt.lifts) && receipt.lifts.length >= 1) pass(`подъёмов записано: ${receipt.lifts.length}`)
      else fail('в квитанции нет ни одной попытки подъёма')
      if (Date.parse(receipt.riseNotifiedAt) >= Date.parse(receipt.doorBackAt)) {
        pass('и по собственным часам демона «поднялся» сказано после живой двери')
      } else {
        fail('по часам демона сообщение о подъёме опередило дверь')
      }
    }
    if (!existsSync(outageMarkerPath(config))) pass('открытого провала не осталось — он закрыт квитанцией')
    else fail('маркер провала остался на месте')
  } finally {
    done()
  }
}

// ── акт второй: слово окна при мёртвой двери ──────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

/**
 * Окно с МЁРТВОЙ ДВЕРЬЮ — ровно то, что видит человек, у которого демон упал под открытой
 * вкладкой: собранное окно раздаётся целиком, а любой запрос к `/api/...` обрывается на
 * уровне сокета. Не 404 и не 500: ответ со статусом означал бы живого демона со своим
 * мнением, а здесь надо воспроизвести ТИШИНУ — то же самое, что видит браузер, когда процесс
 * за дверью умер.
 */
function startDeadDoorWindow(port, appDir) {
  const server = createServer((req, res) => {
    const path = String(req.url || '/').split('?')[0]
    if (path.startsWith('/api')) {
      req.socket.destroy()
      return
    }
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    const file = join(appDir, rel)
    if (!file.startsWith(appDir) || !existsSync(file)) {
      res.writeHead(404).end('нет')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ close: () => server.close() })))
}

async function actWindow() {
  const appDir = join(ROOT, 'daemon', 'static', 'app')
  if (!existsSync(join(appDir, 'index.html'))) {
    fail(`собранного окна нет (${appDir}) — сначала: npm run build:spa`)
    return
  }
  const window = await startDeadDoorWindow(WINDOW_PORT, appDir)
  info(`окно с мёртвой дверью: http://127.0.0.1:${WINDOW_PORT}`)
  try {
    // Слова проверяет ui-drive — он открывает НАСТОЯЩИЙ браузер и читает то, что на экране.
    // Три ожидания: потеря связи, молчание бота по той же причине и путь назад.
    const steps = [
      `http://127.0.0.1:${WINDOW_PORT}`,
      'wait:9000',
      'expect:Связь с демоном потеряна',
      'expect:в телеграме сейчас тоже тишина',
      'expect:npm run daemon:watch',
      'shot:окно-без-демона',
      '--no-sweep',
    ]
    let out = ''
    const code = await new Promise((r) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'sma', 'ui-drive.mjs'), ...steps], {
        cwd: ROOT,
        env: process.env,
      })
      child.stdout.on('data', (c) => {
        out += c
        process.stdout.write(c)
      })
      child.stderr.on('data', (c) => process.stderr.write(c))
      child.on('exit', (c) => r(c ?? 1))
    })

    if (code === 3) {
      fail('ui-drive НЕ ЗАПУСКАЛСЯ: браузерного драйвера нет (SMA_UI_DRIVER=/путь/к/playwright)')
      return
    }
    if (code === 2) {
      fail('ui-drive не понял шаги прогона')
      return
    }

    // ── ЧЕЙ ЭТО КРАСНЫЙ ───────────────────────────────────────────────────────────────
    //
    // Дверь здесь убита НАРОЧНО, и каждый запрос к ней обязан провалиться — это и есть
    // воспроизводимое условие. ui-drive считает оборванный запрос блокирующим, и он прав
    // для обычного приложения; здесь это ровно то, что заказано. Поэтому прогон читает
    // машинную половину квитанции и прощает РОВНО ОДНО: оборванный запрос к своей же
    // мёртвой двери. Всё остальное — включая `step-failed`, то есть НЕСКАЗАННОЕ окном
    // слово, — остаётся красным, и прощение названо вслух, а не спрятано.
    const at = /Receipt:\s*(.+RUN\.md)/.exec(out)
    if (!at) {
      fail('ui-drive не назвал свою квитанцию — судить не по чему')
      return
    }
    const runJson = join(dirname(at[1].trim()), 'run.json')
    const findings = JSON.parse(readFileSync(join(ROOT, runJson), 'utf8')).findings ?? []
    const deadDoor = (f) => f.kind === 'request-failed' && f.detail.includes(`127.0.0.1:${WINDOW_PORT}/api`)
    const blockers = findings.filter((f) => f.severity === 'blocking' || f.severity === 'BLOCKER')
    const forgiven = blockers.filter(deadDoor)
    const left = blockers.filter((f) => !deadDoor(f))

    info(`прощено оборванных запросов к убитой двери: ${forgiven.length} — это условие прогона, а не находка`)
    if (left.length === 0) {
      pass(`ui-drive: окно при мёртвой двери говорит человеку словами (квитанция: ${at[1].trim()})`)
    } else {
      for (const f of left) fail(`ui-drive: ${f.kind} — ${f.detail}`)
    }
  } finally {
    window.close()
  }
}

// ── ход прогона ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const wantsWindow = argv.includes('--window') || argv.includes('--all')
const wantsOutage = argv.includes('--all') || !argv.includes('--window')

console.log('=== живой прогон: упал демон ===')
try {
  if (wantsOutage) await actOutage()
  if (wantsWindow) await actWindow()
} catch (err) {
  fail(`прогон сорвался: ${String((err && err.stack) || err)}`)
}
console.log(failCount === 0 ? '\nВСЁ ЗЕЛЁНОЕ' : `\nКРАСНОГО: ${failCount}`)
process.exit(failCount === 0 ? 0 : 1)
