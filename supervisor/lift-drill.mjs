#!/usr/bin/env node
/**
 * lift-drill.mjs — ПРОВОД-ТЕСТ ПОДЪЁМА НА НАСТОЯЩЕЙ МАШИНЕ, без остановки живого демона.
 *
 * Зачем он есть. Подъём — единственная часть перезапуска, которую нельзя проверить моками:
 * ломается она не в решении «поднимать», а в том, КАК процесс создаётся операционной системой.
 * Виндовый провал 02.09.2026 именно такой: `detached: true` на Windows означает
 * DETACHED_PROCESS — «консоли не давать», — а PowerShell 5.1 без консоли не стартует. Ребёнок
 * выходил с нулём за миллисекунды, не выполнив ни строки скрипта и не написав ни слова, и все
 * тесты продукта при этом оставались зелёными: они проверяли решение, а не создание процесса.
 *
 * Что этот дым делает: зовёт РОВНО ту команду подъёма, что зовёт `daemon-control restart`
 * (`liftCommand` + `spawnLiftLogged`), и показывает, что осталось в дневном журнале запусков.
 * Живого демона он не трогает: обёртка подъёма первым делом смотрит на дверь и, если та
 * отвечает, честно выходит со словами «здесь уже кто-то служит». Поэтому дым проверяет весь
 * провод — создание процесса, консоль, перехват stdout/stderr, pid в журнале — и НЕ проверяет
 * холодный старт с нуля: для него дверь должна быть закрыта.
 *
 *   node supervisor/lift-drill.mjs [--wait 30]
 *
 * Выход 0 — подъём оставил в журнале и pid, и строки самой обёртки. Выход 1 — журнал молчит
 * после строки «подъём»: ровно та слепота, ради которой этот файл написан.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { loadConfig, resolveConfigPath } from '../daemon/src/config.mjs'
import { doorUrl, liftCommand, probeDoor } from '../daemon/src/control.mjs'
import { spawnLiftLogged, tailLiftLog } from './lift-log.mjs'

function say(line) {
  console.log(`[sma-lift-drill] ${line}`)
}

async function main(argv) {
  const waitAt = argv.indexOf('--wait')
  const waitSeconds = waitAt >= 0 ? Number(argv[waitAt + 1]) || 30 : 30

  const config = loadConfig({ repoDir: process.cwd() })
  const logDir = join(dirname(resolveConfigPath()), 'logs')

  const before = await probeDoor({ config })
  say(`дверь ${doorUrl(config)} до подъёма: ${before.answered ? before.status : before.reason || 'нет ответа'}`)

  const lift = liftCommand()
  say(`команда подъёма: ${lift.cmd} ${lift.args.join(' ')} (detached ${lift.detached})`)
  const started = Date.now()
  const { log } = spawnLiftLogged({ spawn, lift, logDir })
  say(`журнал запусков: ${log}`)

  await new Promise((r) => setTimeout(r, waitSeconds * 1000))

  const after = await probeDoor({ config })
  say(
    `дверь ${doorUrl(config)} через ${((Date.now() - started) / 1000).toFixed(1)}с: ${
      after.answered ? after.status : after.reason || 'нет ответа'
    }`,
  )

  const tail = tailLiftLog(log, { maxLines: 24, maxChars: 4000 })
  say('хвост журнала запусков:')
  console.log(tail)

  // ИСХОД, А НЕ НАМЕРЕНИЕ. Подъём считается прошедшим, только если журнал знает pid запущенного
  // процесса и хотя бы одну строку от него самого. Строка «подъём: …» и тишина после неё — это
  // провал, как бы спокойно ни завершился вызов spawn.
  const gotPid = /pid \d+/.test(tail)
  const gotBoot = /boot:|boot-err:/.test(tail)
  if (!gotPid || !gotBoot) {
    say(`НЕТ: журнал молчит о процессе (pid: ${gotPid ? 'есть' : 'нет'}, строки обёртки: ${gotBoot ? 'есть' : 'нет'}).`)
    return 1
  }
  say('ДА: подъём оставил pid и первые строки обёртки в журнале запусков.')
  return 0
}

// ВЫХОД БЕЗ `process.exit`. Замерено на первом живом прогоне этого дыма: `process.exit()` рядом
// с только что запущенным дитём роняет сам node на утверждении libuv («!(handle->flags &
// UV_HANDLE_CLOSING)», src/win/async.c) — и удачный подъём возвращает 127. Код возврата,
// выставленный полем, доезжает так же, а цикл событий закрывается сам: дитя отпущено `unref`,
// держать процесс нечему.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    say(`дым не отработал: ${String((err && err.stack) || err)}`)
    process.exitCode = 1
  })
