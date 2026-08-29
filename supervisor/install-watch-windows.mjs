#!/usr/bin/env node
/**
 * install-watch-windows.mjs — ПОСТАНОВКА СТОРОЖА ИЗ ОБЫЧНОГО СЕАНСА.
 *
 * Демона поднимает `start-daemon-windows.ps1`, за демоном смотрит `daemon-watch.mjs`, а за
 * сторожем должна была смотреть задача планировщика. На машине без прав администратора её
 * поставить нельзя: и `schtasks /Create`, и `Register-ScheduledTask` отвечают «Access is
 * denied». Пути в комплекте не было, и сторож жил в ярлыке, собранном руками.
 *
 *   node supervisor/install-watch-windows.mjs           поставить и запустить сейчас
 *   node supervisor/install-watch-windows.mjs status    что стоит и что крутится
 *   node supervisor/install-watch-windows.mjs remove    убрать и остановить
 *
 *   --no-task        не пробовать задачу планировщика вовсе
 *   --no-start       поставить, но не запускать сейчас (встанет при следующем входе)
 *   --name <имя>     имя ярлыка в автозагрузке (по умолчанию «SMA daemon watch»)
 *   --task-name <и>  имя задачи планировщика (по умолчанию SMA-Daemon-Watch)
 *   --delay <сек>    задержка круга при входе в систему (по умолчанию 120)
 *   --keep-running   при remove не трогать уже крутящийся круг
 *
 * ПОРЯДОК ПУТЕЙ И ПОЧЕМУ ОН ТАКОЙ. Задача планировщика лучше ярлыка — она переживает выход из
 * сеанса и умеет перезапуск, — поэтому пробуется первой. Её отказ НАЗЫВАЕТСЯ СЛОВАМИ и только
 * после этого берётся ярлык: постановка, которая молча уходит в запасной путь, оставляет
 * человека с уверенностью, что на машине стоит задача, которой там нет.
 *
 * ЧТО ЭТО НЕ ДЕЛАЕТ. Не ставит демона (это `start-daemon-windows.ps1` и его ярлык) и не
 * включает конвейер. Ставится ровно сторож, и ставится он по явной команде человека — ни один
 * установщик продукта эту команду за него не выполняет.
 *
 * ВЫХОД: 0 — сторож поставлен (и запущен, если не просили обратного). 1 — не поставлен.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { processAlive } from '../daemon/src/control.mjs'
import {
  WATCH_LOG_PREFIX,
  WATCH_SHORTCUT_NAME,
  WATCH_START_DELAY_SEC,
  WATCH_TASK_NAME,
  WATCH_TASK_XML,
  classifyTaskAttempt,
  daemonDir,
  decodeConsole,
  lockVerdict,
  shortcutPathFromOutput,
  shortcutPlan,
  shortcutScript,
  taskXmlFor,
  watchLoopCommand,
  watchLockPath,
} from '../daemon/src/watch-install.mjs'
import { dayLogPath, openLiftLog } from './lift-log.mjs'

/** Корень клона: этот файл лежит в <SMA_HOME>/supervisor. */
const SMA_HOME = join(dirname(fileURLToPath(import.meta.url)), '..')

const LOG_DIR = join(daemonDir(), 'logs')

/** say — один голос на всю команду, чтобы вывод можно было грепать префиксом. */
function say(line) {
  console.log(`[sma-watch-install] ${line}`)
}

/** Запуск с ЧИТАЕМЫМ выводом: обе трубы вместе и кодовая страница консоли расшифрована. */
function run(cmd, args) {
  const res = spawnSync(cmd, args, { windowsHide: true })
  const output = `${decodeConsole(res.stdout)}${decodeConsole(res.stderr)}`
  return { code: res.status ?? -1, output, error: res.error ?? null }
}

/**
 * withTempFile(bytes, extension, body) — временный файл, который убирается за собой.
 *
 * КОДИРОВКА ЗДЕСЬ НЕ ДЕТАЛЬ, и оба вызывающих ниже передают байты сами:
 *   - .ps1 идёт с меткой порядка байтов. Windows PowerShell 5.1 читает файл без метки как
 *     ANSI, и первый же не-ASCII знак (русские слова здесь, возможно — русское имя
 *     пользователя в пути) превращается в кавычку, после которой скрипт не разбирается
 *     вовсе. Отгружаемая обёртка запуска уже заплатила эту цену целиком.
 *   - .xml идёт в UTF-16, потому что ровно это написано в его собственном объявлении и
 *     ровно этого ждёт schtasks: файл, чьи байты спорят с объявлением, он отвергает как
 *     испорченный — и человек читает «задача не встала» вместо «прав не хватило».
 */
function withTempFile(bytes, extension, body) {
  const path = join(tmpdir(), `sma-watch-${process.pid}-${Date.now()}${extension}`)
  writeFileSync(path, bytes)
  try {
    return body(path)
  } finally {
    try {
      rmSync(path, { force: true })
    } catch {
      /* временный файл — не повод ронять постановку */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── задача планировщика ───────────────────────────────────────────────────────────

/** Стоит ли уже такая задача. Спрашивать может кто угодно — прав для этого не нужно. */
function taskExists(taskName) {
  return run('schtasks', ['/Query', '/TN', taskName]).code === 0
}

/**
 * tryTask(taskName) → {outcome, words} — попытка поставить единицу планировщика.
 *
 * Отгружаемый XML несёт метку `<SMA_HOME>` и `<Enabled>false</Enabled>`: путь клона
 * подставляется, а включение — отдельный шаг, потому что «поставлена» и «включена» это
 * разные факты и разные отказы.
 */
function tryTask(taskName) {
  const xmlPath = join(SMA_HOME, 'supervisor', WATCH_TASK_XML)
  if (!existsSync(xmlPath)) return { outcome: 'failed', words: `единицы планировщика нет на месте: ${xmlPath}` }
  const filled = taskXmlFor(readFileSync(xmlPath, 'utf8'), SMA_HOME)
  const created = withTempFile(Buffer.from(`﻿${filled}`, 'utf16le'), '.xml', (path) =>
    run('schtasks', ['/Create', '/TN', taskName, '/XML', path, '/F']),
  )
  const verdict = classifyTaskAttempt(created)
  if (verdict.outcome !== 'registered') return verdict
  const enabled = run('schtasks', ['/Change', '/TN', taskName, '/ENABLE'])
  const enabledVerdict = classifyTaskAttempt(enabled)
  if (enabledVerdict.outcome !== 'registered') {
    return { outcome: 'failed', words: `задача создана, но не включилась: ${enabledVerdict.words}` }
  }
  return { outcome: 'registered', words: `задача планировщика «${taskName}» поставлена и включена.` }
}

// ── ярлык автозагрузки ────────────────────────────────────────────────────────────

/** Ставит ярлык и возвращает путь, который PowerShell назвал САМ. */
function installShortcut(plan) {
  const res = withTempFile(Buffer.from(`﻿${shortcutScript(plan)}\n`, 'utf8'), '.ps1', (path) =>
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path]),
  )
  const written = shortcutPathFromOutput(res.output)
  const note = res.output
    .split(/\r?\n/)
    .find((l) => l.startsWith('NOTE='))
  if (res.code !== 0 || !written) {
    return { ok: false, path: '', words: `ярлык не встал: ${res.output.trim() || `powershell вышел с кодом ${res.code}`}` }
  }
  return {
    ok: true,
    path: written,
    words: `ярлык автозагрузки: ${written}${note ? ` (папка автозагрузки перенаправлена: ${note.slice('NOTE='.length)})` : ''}`,
  }
}

// ── круг, который крутится прямо сейчас ───────────────────────────────────────────

/** Кто держит замок круга — и держит ли. */
function loopState() {
  const path = watchLockPath()
  let lock = null
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    lock = null
  }
  return { path, lock, verdict: lockVerdict({ lock, isAlive: (pid) => processAlive(pid) }) }
}

/**
 * startNow() — круг ЗАПУСКАЕТСЯ ОТДЕЛЁННЫМ процессом и переживает это окно.
 *
 * Ровно это и есть смысл постановки из обычного сеанса: сторож, который умирает вместе с
 * терминалом, где его поставили, ничего не сторожит. `detached` + `unref` снимают связь с
 * родителем, а вывод уходит в дневной журнал, а не в `ignore`: старт, который не состоялся,
 * обязан оставить причину там, где её ищут.
 */
async function startNow() {
  const before = loopState()
  if (before.verdict.held) return { ok: true, pid: before.verdict.pid, words: `сторож уже крутится: процесс ${before.verdict.pid}.` }

  mkdirSync(LOG_DIR, { recursive: true })
  const log = openLiftLog(LOG_DIR, { prefix: WATCH_LOG_PREFIX })
  const lift = watchLoopCommand({ smaHome: SMA_HOME, delaySec: 0 })
  const child = spawn(lift.cmd, lift.args, { cwd: lift.cwd, detached: true, stdio: log.stdio, windowsHide: true })
  child.on('error', (err) => say(`круг не запустился: ${String((err && err.message) || err)}`))
  child.unref()
  log.close()

  // Живым круг делает не вызов spawn, а замок, который он ВЗЯЛ: «вызов не бросил» — не исход.
  const deadline = Date.now() + 15000
  for (;;) {
    await sleep(500)
    const now = loopState()
    if (now.verdict.held) return { ok: true, pid: now.verdict.pid, words: `круг пошёл: процесс ${now.verdict.pid}.` }
    if (Date.now() > deadline) {
      return {
        ok: false,
        pid: 0,
        words: `круг запущен, но за 15 с не взял замок — причина в журнале ${dayLogPath(LOG_DIR, WATCH_LOG_PREFIX)}`,
      }
    }
  }
}

/** Останавливает круг и сторожа под ним: на Windows смерть родителя ребёнка не уносит. */
function stopNow() {
  const { path, lock, verdict } = loopState()
  if (!verdict.held) return `круг не крутится${lock ? ' (замок остался от мёртвого процесса — убран)' : ''}.`
  const killed = []
  for (const pid of [Number(lock?.watchPid) || 0, verdict.pid]) {
    if (!pid) continue
    try {
      process.kill(pid)
      killed.push(pid)
    } catch {
      /* уже умер — этого и добивались */
    }
  }
  try {
    rmSync(path, { force: true })
  } catch {
    /* замок останется мусором; следующий круг прочтёт его как свободный */
  }
  return killed.length ? `круг остановлен: процессы ${killed.join(', ')}.` : `круг ${verdict.pid} не остановился — остановите его руками.`
}

// ── команды ───────────────────────────────────────────────────────────────────────

function flag(argv, name, fallback) {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

async function install(argv) {
  const name = flag(argv, '--name', WATCH_SHORTCUT_NAME)
  const taskName = flag(argv, '--task-name', WATCH_TASK_NAME)
  const delaySec = Number(flag(argv, '--delay', WATCH_START_DELAY_SEC)) || 0
  let unit = ''

  if (argv.includes('--no-task')) {
    say('задачу планировщика не пробую — просили ярлык.')
  } else {
    const task = tryTask(taskName)
    say(task.words)
    if (task.outcome === 'registered') unit = 'task'
    else say('беру путь, которому прав администратора не нужно: ярлык автозагрузки.')
  }

  if (!unit) {
    const plan = shortcutPlan({ smaHome: SMA_HOME, name, delaySec })
    const shortcut = installShortcut(plan)
    say(shortcut.words)
    if (!shortcut.ok) return 1
    say(`ярлык запускает: ${plan.target} ${plan.args} (свёрнутым окном, из ${plan.workingDir})`)
    unit = 'shortcut'
  }

  if (argv.includes('--no-start')) {
    say('сейчас не запускаю — просили только поставить. Встанет при следующем входе в систему.')
    return 0
  }
  const started = await startNow()
  say(started.words)
  say(`журнал круга: ${dayLogPath(LOG_DIR, WATCH_LOG_PREFIX)}`)
  return started.ok ? 0 : 1
}

function status(argv) {
  const name = flag(argv, '--name', WATCH_SHORTCUT_NAME)
  const taskName = flag(argv, '--task-name', WATCH_TASK_NAME)
  const plan = shortcutPlan({ smaHome: SMA_HOME, name })

  say(taskExists(taskName) ? `задача планировщика «${taskName}» стоит.` : `задачи планировщика «${taskName}» нет.`)
  if (existsSync(plan.path)) {
    say(`ярлык автозагрузки на месте: ${plan.path}`)
  } else {
    say(`ярлыка автозагрузки нет: ${plan.path}`)
  }
  const { verdict } = loopState()
  say(verdict.held ? verdict.words : `круг не крутится (${verdict.words})`)
  say(`журнал круга: ${dayLogPath(LOG_DIR, WATCH_LOG_PREFIX)}`)
  return verdict.held ? 0 : 1
}

function remove(argv) {
  const name = flag(argv, '--name', WATCH_SHORTCUT_NAME)
  const taskName = flag(argv, '--task-name', WATCH_TASK_NAME)
  const plan = shortcutPlan({ smaHome: SMA_HOME, name })

  if (existsSync(plan.path)) {
    rmSync(plan.path, { force: true })
    say(`ярлык убран: ${plan.path}`)
  } else {
    say(`ярлыка не было: ${plan.path}`)
  }
  if (taskExists(taskName)) {
    const deleted = classifyTaskAttempt(run('schtasks', ['/Delete', '/TN', taskName, '/F']))
    say(deleted.outcome === 'registered' ? `задача «${taskName}» удалена.` : deleted.words)
  }
  say(argv.includes('--keep-running') ? 'крутящийся круг не трогаю — просили оставить.' : stopNow())
  return 0
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Постановка сторожа демона на Windows без прав администратора:',
        '  node supervisor/install-watch-windows.mjs           поставить и запустить сейчас',
        '  node supervisor/install-watch-windows.mjs status    что стоит и что крутится',
        '  node supervisor/install-watch-windows.mjs remove    убрать и остановить',
        '',
        '  --no-task        не пробовать задачу планировщика',
        '  --no-start       поставить, но не запускать сейчас',
        '  --name <имя>     имя ярлыка в автозагрузке',
        '  --task-name <и>  имя задачи планировщика',
        '  --delay <сек>    задержка круга при входе в систему',
        '  --keep-running   при remove не трогать крутящийся круг',
      ].join('\n'),
    )
    return 0
  }

  if (process.platform !== 'win32') {
    say(`это виндовый путь постановки, а здесь ${process.platform}. На macOS сторож встаёт агентом: supervisor/com.sma.daemon-watch.plist.`)
    return 1
  }

  // Команда — ТОЛЬКО первое слово. Искать её по всей строке нельзя: значение флага
  // (`--name "SMA daemon watch"`) выглядит ровно так же, и «status» после него читалось бы
  // как имя ярлыка, а имя — как команда.
  const verb = argv.length && !argv[0].startsWith('-') ? argv[0] : 'install'
  if (verb === 'status') return status(argv)
  if (verb === 'remove') return remove(argv)
  if (verb !== 'install') {
    say(`не знаю команды «${verb}» — есть install, status и remove.`)
    return 1
  }
  return install(argv)
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    say(`постановка не отработала: ${String((err && err.stack) || err)}`)
    process.exit(1)
  })
