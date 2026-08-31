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
 *   --cooldown <сек>  выдержка перед вторым подъёмом, дальше удваивается (по умолчанию 120)
 *   --lift-wait <сек> сколько запущенный подъём ждёт живой двери (по умолчанию 240)
 *   --tries <N>       сколько подъёмов подряд, прежде чем звать человека (по умолчанию 3)
 *
 * Из корня проекта то же самое: `npm run daemon:watch`.
 *
 * ЧТО ОН ДЕЛАЕТ, КОГДА ДВЕРЬ ЗАМОЛЧАЛА. Говорит человеку в телеграм — сам, потому что тот,
 * кто мог бы сказать, и есть покойник, — и запускает ТОТ ЖЕ подъём, что и супервизор. А если
 * процесс за молчащей дверью ЖИВ, подъёму предшествует гашение той же остановкой, что и рукой
 * человека: демон умеет заклинивать живым, и поднятый рядом с клином второй демон только
 * проиграет гонку за порт, который клин всё ещё держит. Слова
 * «поднялся» он не говорит: оно принадлежит поднявшемуся демону, который скажет его после
 * того, как его собственная дверь ответит (daemon/src/outage.mjs). Зато слово «поднять не
 * смог» — его и больше ничьё: запущенный подъём он доводит до ИСХОДА (ждёт живой двери,
 * повторяет с растущей выдержкой) и, если исхода нет, говорит об этом человеку ВТОРЫМ
 * сообщением с причиной из журнала запусков. Разбор решений живёт в daemon/src/watch.mjs и
 * проверяется без процесса; этот файл только читает флаги, запускает подъём и печатает строки.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ. Не воскрешает демона, погашенного штатно: остановка убирает запись о
 * процессе, авария её оставляет, и сторож читает именно эту разницу. Не открывает ни одной
 * двери и не слушает ни одного порта — новых адресов у продукта не появилось.
 *
 * ВЫХОД: 0 — круг(и) отработали. 1 — не смог даже начать (нет конфига демона).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { loadConfig, resolveConfigPath } from '../daemon/src/config.mjs'
import { doorUrl, liftCommand } from '../daemon/src/control.mjs'
import { createWatch, LIFT_ATTEMPTS_MAX, LIFT_COOLDOWN_MS, LIFT_DOOR_WAIT_MS, MISSES_TO_DECLARE, POLL_MS } from '../daemon/src/watch.mjs'
import { spawnLiftLogged, tailLiftLog } from './lift-log.mjs'

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
 * spawnLift(lift) → {log} — подъём ОТДЕЛЬНО ОТ СТОРОЖА и переживающий его: сторож может быть
 * закрыт вместе с терминалом, а поднятый демон обязан жить дальше. Вывод отделённого процесса
 * ложится в дневной журнал запусков — на ВСЕХ платформах, включая Windows, где он раньше
 * уходил в `ignore` под тем предлогом, что .ps1 ведёт журнал сам. Ведёт — если запустилась;
 * ночью на 29.08 не запустилась именно она, и в её журнале не было ни строки. Путь возвращается
 * наверх: сторож назовёт его человеку и прочтёт оттуда причину неудавшегося подъёма.
 */
function spawnLift(lift, logDir) {
  return spawnLiftLogged({ spawn, lift, logDir })
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
        '  --cooldown <сек>  выдержка перед вторым подъёмом, дальше удваивается (по умолчанию 120)',
        '  --lift-wait <сек> сколько запущенный подъём ждёт живой двери (по умолчанию 240)',
        '  --tries <N>       подъёмов подряд, прежде чем звать человека (по умолчанию 3)',
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
  const triesAt = argv.indexOf('--tries')
  const tries = triesAt >= 0 && Number.isFinite(Number(argv[triesAt + 1])) ? Math.max(1, Number(argv[triesAt + 1])) : LIFT_ATTEMPTS_MAX
  const pollMs = seconds(argv, '--poll', POLL_MS)
  const liftCooldownMs = seconds(argv, '--cooldown', LIFT_COOLDOWN_MS)
  const liftDoorWaitMs = seconds(argv, '--lift-wait', LIFT_DOOR_WAIT_MS)

  const watch = createWatch({
    config,
    lift: liftCommand(),
    spawnLift: (lift) => spawnLift(lift, logDir),
    readLiftOutput: (path) => tailLiftLog(path),
    log: say,
    pollMs,
    missesToDeclare: misses,
    liftCooldownMs,
    liftDoorWaitMs,
    liftAttemptsMax: tries,
  })

  if (argv.includes('--once')) {
    const round = await watch.tick()
    say(`круг: ${round.phase}${round.misses ? ` (молчаний подряд: ${round.misses})` : ''}`)
    return 0
  }

  say(
    `сторожу ${doorUrl(config)}: стук раз в ${Math.round(pollMs / 1000)} с, падение — ${misses} молчания подряд, ` +
      `подъём ждёт живой двери ${Math.round(liftDoorWaitMs / 1000)} с, попыток ${tries} с выдержкой от ${Math.round(liftCooldownMs / 1000)} с.`,
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
