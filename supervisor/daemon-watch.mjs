#!/usr/bin/env node
/**
 * daemon-watch.mjs — СТОРОЖ, КОТОРЫЙ ВОЗВРАЩАЕТ ДЕМОНА БЕЗ ТЕРМИНАЛА.
 *
 * Супервизор этой папки умел поднимать демона (start-daemon-windows.ps1, launchd-агент) и,
 * с daemon-control.mjs, останавливать и перезапускать его РУКАМИ. Не умел он одного: заметить,
 * что демон умер, пока никто не смотрел. А смотреть некому по построению — окно раздаёт сам
 * демон, и телеграм опрашивает он же, так что его смерть выглядит как тишина в обоих каналах.
 *
 *   node supervisor/daemon-watch.mjs            сторожить, пока не остановят (Ctrl+C)
 *   node supervisor/daemon-watch.mjs --once     один круг и выход — для проверки и для крона
 *
 *   --poll <сек>      как часто стучаться в дверь (по умолчанию 15)
 *   --misses <N>      сколько молчаний подряд считать падением (по умолчанию 3)
 *   --cooldown <сек>  не повторять подъём чаще этого (по умолчанию 120)
 *
 * Из корня проекта то же самое: `npm run daemon:watch`.
 *
 * ЧТО ОН ДЕЛАЕТ, КОГДА ДВЕРЬ ЗАМОЛЧАЛА. Говорит человеку в телеграм — сам, потому что тот,
 * кто мог бы сказать, и есть покойник, — и запускает ТОТ ЖЕ подъём, что и супервизор. О
 * подъёме он не говорит НИЧЕГО: это слово принадлежит поднявшемуся демону, который скажет его
 * после того, как его собственная дверь ответит (daemon/src/outage.mjs). Разбор решений живёт
 * в daemon/src/watch.mjs и проверяется без процесса; этот файл только читает флаги, запускает
 * подъём и печатает строки.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ. Не воскрешает демона, погашенного штатно: остановка убирает запись о
 * процессе, авария её оставляет, и сторож читает именно эту разницу. Не открывает ни одной
 * двери и не слушает ни одного порта — новых адресов у продукта не появилось.
 *
 * ВЫХОД: 0 — круг(и) отработали. 1 — не смог даже начать (нет конфига демона).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { loadConfig, resolveConfigPath } from '../daemon/src/config.mjs'
import { doorUrl, liftCommand } from '../daemon/src/control.mjs'
import { createWatch, LIFT_COOLDOWN_MS, MISSES_TO_DECLARE, POLL_MS } from '../daemon/src/watch.mjs'

/** say — один голос на всю команду, чтобы скрипт мог грепать префикс. */
function say(line) {
  console.log(`[sma-watch] ${line}`)
}

/** Число из флага, или значение по умолчанию, если флага нет или он бессмысленный. */
function seconds(argv, flag, fallbackMs) {
  const at = argv.indexOf(flag)
  if (at < 0) return fallbackMs
  const value = Number(argv[at + 1])
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallbackMs
}

/**
 * spawnLift(lift) — подъём ОТДЕЛЬНО ОТ СТОРОЖА и переживающий его: сторож может быть закрыт
 * вместе с терминалом, а поднятый демон обязан жить дальше. На посиксе вывод boot'а уходит в
 * тот же дневной журнал, что пишет виндовая обёртка: boot, умерший молча, должен оставить
 * причину хоть где-то, а «унаследовал терминал, которого больше нет» — это нигде.
 */
function spawnLift(lift, logDir) {
  const stdio = (() => {
    if (process.platform === 'win32') return 'ignore' // .ps1 ведёт свой журнал сам
    try {
      mkdirSync(logDir, { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const fd = openSync(join(logDir, `daemon-${stamp}.log`), 'a')
      return ['ignore', fd, fd]
    } catch {
      return 'ignore'
    }
  })()
  const child = spawn(lift.cmd, lift.args, { cwd: lift.cwd, detached: true, stdio, windowsHide: true })
  child.unref()
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Сторож демона:',
        '  node supervisor/daemon-watch.mjs            сторожить, пока не остановят',
        '  node supervisor/daemon-watch.mjs --once     один круг и выход',
        '',
        '  --poll <сек>      как часто стучаться (по умолчанию 15)',
        '  --misses <N>      молчаний подряд до объявления падения (по умолчанию 3)',
        '  --cooldown <сек>  не повторять подъём чаще этого (по умолчанию 120)',
      ].join('\n'),
    )
    return 0
  }

  // Конфига нет — значит демон здесь не настроен. Читать его через loadConfig нельзя: тот
  // СОЗДАЛ бы конфиг (со свежим токеном) как побочный эффект вопроса.
  const configPath = resolveConfigPath()
  if (!existsSync(configPath)) {
    say(`конфига демона нет (${configPath}) — сторожить нечего.`)
    return 1
  }
  const config = loadConfig({ repoDir: process.cwd() })
  const logDir = join(dirname(configPath), 'logs')

  const missesAt = argv.indexOf('--misses')
  const misses = missesAt >= 0 && Number.isFinite(Number(argv[missesAt + 1])) ? Math.max(1, Number(argv[missesAt + 1])) : MISSES_TO_DECLARE
  const pollMs = seconds(argv, '--poll', POLL_MS)
  const liftCooldownMs = seconds(argv, '--cooldown', LIFT_COOLDOWN_MS)

  const watch = createWatch({
    config,
    lift: liftCommand(),
    spawnLift: (lift) => spawnLift(lift, logDir),
    log: say,
    pollMs,
    missesToDeclare: misses,
    liftCooldownMs,
  })

  if (argv.includes('--once')) {
    const round = await watch.tick()
    say(`круг: ${round.phase}${round.misses ? ` (молчаний подряд: ${round.misses})` : ''}`)
    return 0
  }

  say(
    `сторожу ${doorUrl(config)}: стук раз в ${Math.round(pollMs / 1000)} с, падение — ${misses} молчания подряд, подъём не чаще раза в ${Math.round(liftCooldownMs / 1000)} с.`,
  )
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      say('останавливаюсь.')
      watch.stop()
      process.exit(0)
    })
  }
  await watch.run()
  return 0
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    say(`сторож не отработал: ${String((err && err.stack) || err)}`)
    process.exit(1)
  })
