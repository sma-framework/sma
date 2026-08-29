#!/usr/bin/env node
/**
 * watch-loop.mjs — ВЕЧНЫЙ КРУГ ВОКРУГ СТОРОЖА.
 *
 * Сторож (`daemon-watch.mjs`) сторожит демона. За самим сторожем на Windows должна была
 * смотреть задача планировщика — её `RestartOnFailure` и есть последняя черепаха. Но задача
 * из обычного сеанса не ставится («Access is denied»), и на машине без администратора
 * последней черепахи не оставалось вовсе: сторож, умерший в три часа ночи, лежал до утра.
 *
 * Этот круг — она и есть, и ничего сверх того:
 *
 *   node supervisor/watch-loop.mjs               крутить, пока не остановят (Ctrl+C)
 *   node supervisor/watch-loop.mjs --delay 120   подождать перед первым взглядом
 *
 *   --delay <сек>  сколько ждать до первого запуска сторожа (по умолчанию 0)
 *   --pause <сек>  сколько ждать между падением и подъёмом (по умолчанию 60)
 *   --tries <N>    сколько БЫСТРЫХ падений подряд терпеть (по умолчанию 5)
 *   --force        снять чужой замок и крутить всё равно
 *   -- <флаги>     всё, что после двух тире, уезжает сторожу как есть
 *
 * Ставит его `install-watch-windows.mjs`; он же вписывает эту команду в ярлык автозагрузки.
 *
 * ТРИ СВОЙСТВА, РАДИ КОТОРЫХ ОН СУЩЕСТВУЕТ, и все три взяты у задачи планировщика:
 *   1. ЗАДЕРЖКА. Сторож, посмотревший на машину раньше, чем та загрузилась, объявит падение,
 *      которого не было. Задача ждёт две минуты после входа — ждёт и круг, но у себя, а не
 *      строкой внутри ярлыка, которую никто не прочтёт.
 *   2. ПОДЪЁМ УПАВШЕГО СТОРОЖА — с потолком: пять быстрых падений подряд означают причину,
 *      которую шестой запуск не изменит (см. restartVerdict в daemon/src/watch-install.mjs).
 *   3. ОДИН СТОРОЖ НА МАШИНУ. Замок рядом с конфигом демона; два сторожа объявили бы одно
 *      падение дважды и дважды позвали подъём.
 *
 * ЖУРНАЛ. Свои строки и вывод сторожа круг кладёт в `daemon-watch-<день>.log` рядом с
 * журналом демона, и день решается НА КАЖДУЮ СТРОКУ: этот процесс живёт неделями, а имя,
 * посчитанное один раз при запуске, прикалывает все последующие дни к файлу дня запуска —
 * виндовая обёртка уже заплатила за это сутками строк, ушедших не туда.
 *
 * ВЫХОД: 0 — остановили сигналом. 1 — потолок подъёмов исчерпан. 3 — замок держит другой круг.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { processAlive } from '../daemon/src/control.mjs'
import {
  WATCH_LOG_PREFIX,
  WATCH_RESTART_PAUSE_MS,
  WATCH_RESTART_TRIES,
  daemonDir,
  lockVerdict,
  restartVerdict,
  watchLockPath,
} from '../daemon/src/watch-install.mjs'
import { dayLogPath } from './lift-log.mjs'

/** Корень клона: этот файл лежит в <SMA_HOME>/supervisor. */
const SMA_HOME = join(dirname(fileURLToPath(import.meta.url)), '..')

const LOG_DIR = join(daemonDir(), 'logs')

/**
 * say — одна строка в журнал, с днём, посчитанным ПРЯМО СЕЙЧАС. На терминал она уходит
 * только когда терминал есть: когда круг запущен ярлыком, его stdout — тот же файл, и второй
 * экземпляр каждой строки в нём был бы шумом.
 */
function say(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(dayLogPath(LOG_DIR, WATCH_LOG_PREFIX), `${stamped}\n`)
  } catch {
    /* журнал — удобство; круг из-за него не останавливается */
  }
  if (process.stdout.isTTY) console.log(stamped)
}

/** Число из флага, или значение по умолчанию, если флага нет или он бессмысленный. */
function number(argv, flag, fallback) {
  const at = argv.indexOf(flag)
  if (at < 0) return fallback
  const value = Number(argv[at + 1])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Замок пишется целиком: номер процесса без времени старта нечем показать человеку. */
function takeLock(path, watchPid = 0) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), smaHome: SMA_HOME, watchPid }, null, 2)}\n`)
  } catch {
    /* без замка круг всё равно крутится — он не условие работы, а вежливость ко второму */
  }
}

/** Замок читается «мягко»: порванный или нечитаемый файл — это ОТСУТСТВИЕ замка, а не бросок. */
function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Снимается только СВОЙ замок: чужой мы не брали и убирать его не наше дело. */
function dropLock(path) {
  const held = readLock(path)
  if (held && Number(held.pid) !== process.pid) return
  try {
    rmSync(path, { force: true })
  } catch {
    /* ничего не поделать, и падать из-за этого незачем */
  }
}

/**
 * pipeLines(stream, prefix) — вывод сторожа, строка за строкой, в наш дневной журнал.
 *
 * Именно строка за строкой, а не дескриптором в файл: дескриптор, открытый при запуске,
 * пишет в файл ДНЯ ЗАПУСКА до самой смерти процесса, а этот процесс живёт неделями.
 */
function pipeLines(stream, prefix) {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const parts = (rest + chunk).split(/\r?\n/)
    rest = parts.pop() ?? ''
    for (const line of parts) if (line.trim()) say(`${prefix}${line}`)
  })
  stream.on('end', () => {
    if (rest.trim()) say(`${prefix}${rest}`)
    rest = ''
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Вечный круг вокруг сторожа демона:',
        '  node supervisor/watch-loop.mjs               крутить, пока не остановят',
        '  node supervisor/watch-loop.mjs --delay 120   подождать перед первым взглядом',
        '',
        '  --delay <сек>  до первого запуска сторожа (по умолчанию 0)',
        '  --pause <сек>  между падением и подъёмом (по умолчанию 60)',
        '  --tries <N>    быстрых падений подряд до остановки (по умолчанию 5)',
        '  --force        снять чужой замок и крутить всё равно',
        '  -- <флаги>     всё после двух тире уезжает сторожу',
      ].join('\n'),
    )
    return 0
  }

  const dashes = argv.indexOf('--')
  const mine = dashes < 0 ? argv : argv.slice(0, dashes)
  const forWatch = dashes < 0 ? [] : argv.slice(dashes + 1)

  const delayMs = Math.round(number(mine, '--delay', 0) * 1000)
  const pauseMs = Math.round(number(mine, '--pause', WATCH_RESTART_PAUSE_MS / 1000) * 1000)
  const tries = Math.max(1, Math.round(number(mine, '--tries', WATCH_RESTART_TRIES)))

  const lockPath = watchLockPath()
  const previous = readLock(lockPath)
  const verdict = lockVerdict({ lock: previous, isAlive: (pid) => processAlive(pid) })
  if (verdict.held && !mine.includes('--force')) {
    say(`${verdict.words} Не встаю вторым; снять замок можно флагом --force (${lockPath}).`)
    return 3
  }
  if (previous) say(verdict.words)

  takeLock(lockPath)
  let child = null
  let stopping = false
  const stop = (sig) => {
    stopping = true
    say(`получен ${sig} — останавливаю круг.`)
    if (child) {
      try {
        child.kill()
      } catch {
        /* уже умер — это и требовалось */
      }
    }
    dropLock(lockPath)
    process.exit(0)
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig))
  process.on('exit', () => dropLock(lockPath))

  const watchScript = join(SMA_HOME, 'supervisor', 'daemon-watch.mjs')
  say(
    `круг пошёл: ${watchScript}${forWatch.length ? ` ${forWatch.join(' ')}` : ''}; ` +
      `задержка ${Math.round(delayMs / 1000)} с, пауза ${Math.round(pauseMs / 1000)} с, потолок быстрых падений ${tries}.`,
  )
  if (delayMs > 0) await sleep(delayMs)

  let fastFailures = 0
  for (;;) {
    const startedAt = Date.now()
    const code = await new Promise((resolve) => {
      child = spawn(process.execPath, [watchScript, ...forWatch], { cwd: SMA_HOME, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      // Замок называет ОБА номера: остановка круга должна убрать и сторожа, а на Windows
      // смерть родителя ребёнка не уносит — осиротевший сторож пережил бы свой круг.
      takeLock(lockPath, child.pid ?? 0)
      pipeLines(child.stdout, '')
      pipeLines(child.stderr, 'ошибки: ')
      // Запуск, который не состоялся, приходит СОБЫТИЕМ, а не броском: spawn над
      // несуществующей командой возвращает объект и роняет 'error' позже. Без этого
      // слушателя необработанное событие убило бы сам круг.
      child.on('error', (err) => {
        say(`запуск сторожа не состоялся: ${String((err && err.message) || err)}`)
        resolve(-1)
      })
      child.on('close', (exitCode, signal) => resolve(signal ? `сигнал ${signal}` : Number(exitCode ?? -1)))
    })
    child = null
    if (stopping) return 0

    const ranMs = Date.now() - startedAt
    say(`сторож завершился: ${typeof code === 'number' ? `код ${code}` : code}.`)
    const next = restartVerdict({ ranMs, fastFailures, tries })
    fastFailures = next.fastFailures
    say(next.words)
    if (!next.restart) return 1
    await sleep(pauseMs)
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    say(`круг сорвался: ${String((err && err.stack) || err)}`)
    process.exit(1)
  })
