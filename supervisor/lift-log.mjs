/**
 * lift-log.mjs — КУДА ПИШЕТ ЗАПУСК, КОТОРЫЙ УМЕР МОЛЧА.
 *
 * Подъём демона запускается ОТДЕЛЁННЫМ от родителя процессом: и сторож, и команда перезапуска
 * должны иметь право закрыться, не унося поднятого демона с собой. У этой развязки есть цена,
 * и ночью на 29.08 её заплатили целиком: вывод отделённого процесса уходил в `ignore`, то есть
 * в никуда, и провал старта был невидим ПО ПОСТРОЕНИЮ. Сторож записал попытку словом «ok» —
 * вызов не бросил, — а в журнале скрипта подъёма за те десять минут не было ни одной строки.
 * Процесс не начался вовсе, и узнать об этом было неоткуда.
 *
 * Поэтому здесь одно правило: старт, который умер, обязан оставить причину ТАМ, ГДЕ ЕЁ ИЩУТ.
 * Это отдельный дневной журнал рядом с журналом демона (`daemon-lift-<день>.log` в
 * `~/.sma-daemon/logs`) — отдельный нарочно: в нём лежит вывод ровно того процесса, который мы
 * запустили, и ничей больше, поэтому его хвост можно послать человеку как причину, не разбирая
 * чужие строки. Виндовая обёртка ведёт свой журнал сама, и это НЕ ЗАМЕНА: она успевает начать
 * его только если сама запустилась, а именно этого в ту ночь и не случилось.
 *
 * Node built-ins и ни одного броска наружу: журнал — это удобство, и подъём, сорвавшийся из-за
 * того, что не открылся файл, был бы хуже подъёма без журнала.
 */

import { appendFileSync, existsSync as fsExistsSync, closeSync, mkdirSync, openSync, readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'

/** Имя дневного журнала запусков: тот же день, что у журнала демона, и явно другое имя. */
export const LIFT_LOG_PREFIX = 'daemon-lift-'

/** liftLogPath(logDir, at) — «…/logs/daemon-lift-20260829.log». */
export function liftLogPath(logDir, at = new Date()) {
  const stamp = at.toISOString().slice(0, 10).replace(/-/g, '')
  return join(logDir, `${LIFT_LOG_PREFIX}${stamp}.log`)
}

/**
 * openLiftLog(logDir) → {stdio, log, close}.
 *
 * `stdio` отдаётся прямо в `spawn`: поток вывода и поток ошибок ребёнка садятся на ОДИН файл,
 * потому что читать их порознь всё равно некому, а порядок строк между ними — половина улики.
 * `log` — путь, который потом назовут человеку; пустая строка означает, что журнал открыть не
 * вышло, и это честнее, чем назвать путь, которого нет.
 *
 * `'ignore'` остаётся только как ПОСЛЕДНЕЕ средство — когда каталог не создаётся и файл не
 * открывается. Раньше это был штатный путь на Windows, и ровно он сделал провал невидимым.
 */
export function openLiftLog(logDir, { at, mkdir = mkdirSync, open = openSync } = {}) {
  const path = liftLogPath(logDir, at)
  try {
    mkdir(logDir, { recursive: true })
    const fd = open(path, 'a')
    return {
      stdio: ['ignore', fd, fd],
      log: path,
      // Ребёнок получил СВОЮ копию дескриптора; родительская больше не нужна, и держать её
      // открытой у процесса, который живёт неделями, — течь на каждую попытку подъёма.
      close: () => {
        try {
          closeSync(fd)
        } catch {
          /* закрывать нечего — это не повод ронять подъём */
        }
      },
    }
  } catch {
    return { stdio: 'ignore', log: '', close: () => {} }
  }
}

/** noteLift(path, line) — строка от самого сторожа в тот же журнал: границы попыток видны. */
export function noteLift(path, line) {
  if (!path) return
  try {
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* журнал — удобство, а не условие подъёма */
  }
}

/**
 * tailLiftLog(path) — хвост журнала запусков, каким его пошлют человеку в телеграм.
 *
 * Ограничен и по строкам, и по знакам: сообщение, которое не помещается в экран телефона, —
 * это то же молчание, только длиннее. Нечитаемый и отсутствующий файл дают пустую строку, и
 * она значащая: «запуск не оставил ни строки» — сама по себе улика того, что он не начинался.
 */
export function tailLiftLog(path, { maxLines = 12, maxChars = 1200, readFile = fsReadFileSync, exists = fsExistsSync } = {}) {
  if (!path || !exists(path)) return ''
  try {
    const lines = String(readFile(path, 'utf8'))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
    const tail = lines.slice(-maxLines).join('\n')
    return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail
  } catch {
    return ''
  }
}

/**
 * spawnLiftLogged({spawn, lift, logDir}) → {log}.
 *
 * Один запуск подъёма на весь продукт: и сторож, и команда перезапуска зовут отсюда, потому
 * что «куда девается вывод» — это не деталь каждого вызывающего, а свойство подъёма.
 *
 * ОШИБКА ЗАПУСКА ПРИХОДИТ СОБЫТИЕМ, А НЕ БРОСКОМ. `spawn` над несуществующей командой не
 * бросает — он возвращает объект и позже роняет `'error'`. Отсюда и «ok» той ночи: у вызова не
 * было исключения, ловить было нечего. Слушатель здесь делает два дела сразу — кладёт причину
 * в журнал и снимает необработанное событие, которое иначе убило бы сам сторож: `'error'` без
 * подписчика бросает в пустой стек, и сторожить после этого стало бы некому.
 */
export function spawnLiftLogged({ spawn, lift, logDir, at }) {
  const { stdio, log, close } = openLiftLog(logDir, { at })
  noteLift(log, `── подъём: ${lift.cmd} ${lift.args.join(' ')} (cwd ${lift.cwd})`)
  const child = spawn(lift.cmd, lift.args, { cwd: lift.cwd, detached: true, stdio, windowsHide: true })
  child.on('error', (err) => noteLift(log, `ЗАПУСК НЕ СОСТОЯЛСЯ: ${String((err && err.message) || err)}`))
  child.on('exit', (code, signal) => {
    if (code || signal) noteLift(log, `процесс запуска завершился: код ${code ?? '—'}${signal ? `, сигнал ${signal}` : ''}`)
  })
  child.unref()
  close()
  return { log }
}
