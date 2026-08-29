/**
 * ПОСТАНОВКА СТОРОЖА БЕЗ ПРАВ АДМИНИСТРАТОРА: ТАБЛИЦА РЕШЕНИЙ.
 *
 * Единица планировщика, в которой сторож должен был жить, на эталонной виндовой машине не
 * ставится: и `schtasks /Create`, и `Register-ScheduledTask` из обычного сеанса отвечают
 * «Access is denied». Запасной путь — ярлык автозагрузки с вечным кругом — существовал только
 * как строка внутри .lnk, собранного руками: не версионируется, не читается в обзоре, не
 * переезжает вместе с продуктом.
 *
 * Здесь проверяется всё, что решает постановка, и НИ ОДНОГО процесса при этом не запускается:
 *
 *   (а) отказ по правам называется словами и отличается от любой другой неудачи — иначе
 *       человек, у которого сторож не встал, читает одно «не вышло» в двух разных случаях;
 *   (б) ярлык целит в абсолютный node и в вечный круг, а задержка едет аргументом, который
 *       можно прочитать, а не сном внутри строки ярлыка, который прочитать нельзя;
 *   (в) круг поднимает упавшего сторожа, но не бесконечно, и прожитая минута обнуляет счёт;
 *   (г) один круг на машину: замок держит живой процесс, а не файл, оставшийся от мёртвого;
 *   (д) вывод консоли в кодовой странице Windows читается словами, а не знаками замены.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import {
  WATCH_LOCK_FILE,
  WATCH_RESTART_TRIES,
  WATCH_SHORTCUT_NAME,
  classifyTaskAttempt,
  decodeConsole,
  lockVerdict,
  psQuote,
  restartVerdict,
  shortcutPathFromOutput,
  shortcutPlan,
  shortcutScript,
  startupDir,
  taskXmlFor,
  watchLockPath,
  watchLoopCommand,
} from '../src/watch-install.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..')

const WINDOWS_ENV = { APPDATA: 'C:\\Users\\owner\\AppData\\Roaming' }

describe('ярлык автозагрузки: чем он станет, поле в поле', () => {
  const plan = shortcutPlan({
    smaHome: 'C:\\sma',
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
    delaySec: 120,
    io: { env: WINDOWS_ENV },
  })

  it('ложится в папку автозагрузки пользователя и носит имя, которое видит человек', () => {
    expect(plan.dir).toBe(join(WINDOWS_ENV.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'))
    expect(plan.path).toBe(join(plan.dir, `${WATCH_SHORTCUT_NAME}.lnk`))
  })

  it('целит в АБСОЛЮТНЫЙ node: ярлык не ищет по PATH, и слово «node» было бы тишиной', () => {
    expect(plan.target).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(plan.workingDir).toBe('C:\\sma')
  })

  it('запускает вечный круг, а не самого сторожа — иначе упавшего сторожа некому поднять', () => {
    expect(plan.args).toContain(join('C:\\sma', 'supervisor', 'watch-loop.mjs'))
    expect(plan.args).not.toContain('daemon-watch.mjs')
  })

  it('несёт задержку АРГУМЕНТОМ, который можно прочитать', () => {
    expect(plan.args).toMatch(/--delay 120/)
  })

  it('свёрнутое окно, а не спрятанное: сторожа должно быть видно и можно закрыть', () => {
    expect(plan.windowStyle).toBe(7)
  })

  it('путь с пробелом уезжает в кавычках — иначе круг ищется по первому слову', () => {
    const spaced = shortcutPlan({ smaHome: 'C:\\my projects\\sma', nodeBin: 'node.exe', io: { env: WINDOWS_ENV } })
    expect(spaced.args).toContain(`"${join('C:\\my projects\\sma', 'supervisor', 'watch-loop.mjs')}"`)
  })

  it('без задержки флага нет вовсе, а не «--delay 0»', () => {
    const now = shortcutPlan({ smaHome: 'C:\\sma', nodeBin: 'node.exe', delaySec: 0, io: { env: WINDOWS_ENV } })
    expect(now.args).not.toMatch(/--delay/)
  })
})

describe('папка автозагрузки: считается от APPDATA, а не от домашнего каталога', () => {
  it('берёт APPDATA, когда он есть — перемещаемый профиль живёт не под своим домом', () => {
    expect(startupDir({ env: { APPDATA: 'D:\\roaming' }, homedir: () => 'C:\\Users\\owner' })).toBe(
      join('D:\\roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    )
  })

  it('без APPDATA отступает к дому, а не падает', () => {
    expect(startupDir({ env: {}, homedir: () => 'C:\\Users\\owner' })).toContain('AppData')
  })
})

describe('скрипт, который пишет ярлык', () => {
  const plan = shortcutPlan({ smaHome: 'C:\\sma', nodeBin: 'node.exe', io: { env: WINDOWS_ENV } })
  const script = shortcutScript(plan)

  it('спрашивает настоящую папку автозагрузки у Windows, а не верит расчёту', () => {
    expect(script).toContain("[Environment]::GetFolderPath('Startup')")
  })

  it('называет путь, по которому реально записал, — читающая сторона берёт его оттуда', () => {
    expect(script).toContain('Write-Output ("PATH=" + $path)')
  })

  it('проверяет, что файл появился: COM-вызов, который ничего не записал, не бросает', () => {
    expect(script).toContain('Test-Path')
    expect(script).toContain('$link.Save()')
  })

  it('кавычка в имени не разрывает строку PowerShell', () => {
    const odd = shortcutPlan({ smaHome: "C:\\it's\\sma", name: "SMA's watch", nodeBin: 'node.exe', io: { env: WINDOWS_ENV } })
    expect(shortcutScript(odd)).toContain("'SMA''s watch.lnk'")
    expect(psQuote("d'Arc")).toBe("'d''Arc'")
  })
})

describe('путь ярлыка читается из вывода, а не из собственных расчётов', () => {
  it('берёт строку PATH=', () => {
    expect(shortcutPathFromOutput('NOTE=D:\\redirected\r\nPATH=D:\\redirected\\SMA daemon watch.lnk\r\n')).toBe(
      'D:\\redirected\\SMA daemon watch.lnk',
    )
  })

  it('молчание — это пустая строка, а не догадка', () => {
    expect(shortcutPathFromOutput('что-то пошло не так')).toBe('')
    expect(shortcutPathFromOutput(undefined)).toBe('')
  })
})

describe('вечный круг: чем он запускается', () => {
  it('это node и watch-loop.mjs из этого клона', () => {
    const lift = watchLoopCommand({ smaHome: 'C:\\sma', nodeBin: 'node.exe', delaySec: 0 })
    expect(lift.cmd).toBe('node.exe')
    expect(lift.args).toEqual([join('C:\\sma', 'supervisor', 'watch-loop.mjs')])
    expect(lift.cwd).toBe('C:\\sma')
  })

  it('задержка добавляется отдельным аргументом', () => {
    expect(watchLoopCommand({ smaHome: 'C:\\sma', nodeBin: 'node.exe', delaySec: 90 }).args).toEqual([
      join('C:\\sma', 'supervisor', 'watch-loop.mjs'),
      '--delay',
      '90',
    ])
  })
})

describe('задача планировщика: отказ по правам назван словами', () => {
  it('код 0 — задача поставлена', () => {
    expect(classifyTaskAttempt({ code: 0, output: 'SUCCESS: The scheduled task was successfully created.' }).outcome).toBe('registered')
  })

  it('«Access is denied» — это ОТДЕЛЬНЫЙ исход, и слова называют права администратора', () => {
    const verdict = classifyTaskAttempt({ code: 1, output: 'ERROR: Access is denied.' })
    expect(verdict.outcome).toBe('denied')
    expect(verdict.words).toContain('schtasks')
    expect(verdict.words).toMatch(/прав/)
    // Дословный ответ системы едет наружу целиком: человек ищет в поиске именно эти слова.
    expect(verdict.words).toContain('Access is denied')
  })

  it('русский ответ той же машины читается так же', () => {
    expect(classifyTaskAttempt({ code: 1, output: 'ОШИБКА: Отказано в доступе.' }).outcome).toBe('denied')
  })

  it('код ошибки Windows тоже считается отказом по правам', () => {
    expect(classifyTaskAttempt({ code: 1, output: 'Register-ScheduledTask : 0x80070005' }).outcome).toBe('denied')
  })

  it('любая другая неудача — «failed», и причина не теряется', () => {
    const verdict = classifyTaskAttempt({ code: 1, output: 'ERROR: The task XML is malformed.' })
    expect(verdict.outcome).toBe('failed')
    expect(verdict.words).toContain('malformed')
  })

  it('отсутствие schtasks — тоже названная причина, а не тишина', () => {
    const verdict = classifyTaskAttempt({ code: -1, output: '', error: new Error('spawn schtasks ENOENT') })
    expect(verdict.outcome).toBe('failed')
    expect(verdict.words).toContain('ENOENT')
  })

  it('молчащий отказ всё равно называет код выхода', () => {
    expect(classifyTaskAttempt({ code: 1, output: '' }).words).toContain('1')
  })
})

describe('вывод консоли Windows читается словами', () => {
  it('866-я кодовая страница — это русские слова, а не знаки замены', () => {
    const cp866 = Buffer.from([0x8e, 0xe2, 0xaa, 0xa0, 0xa7, 0xa0, 0xad, 0xae]) // «Отказано»
    expect(decodeConsole(cp866)).toBe('Отказано')
  })

  it('UTF-8 остаётся собой', () => {
    expect(decodeConsole(Buffer.from('Отказано в доступе', 'utf8'))).toBe('Отказано в доступе')
  })

  it('ASCII проходит первой же попыткой, и пустота — это пустая строка', () => {
    expect(decodeConsole(Buffer.from('ERROR: Access is denied.', 'utf8'))).toBe('ERROR: Access is denied.')
    expect(decodeConsole(null)).toBe('')
  })
})

describe('единица планировщика: метка пути подставляется вся', () => {
  const raw = readFileSync(join(REPO_ROOT, 'supervisor', 'sma-daemon-watch-windows.task.xml'), 'utf8')

  it('в отгружаемом файле метка есть — иначе проверка ниже пуста', () => {
    expect(raw).toContain('SMA_HOME')
  })

  it('после подстановки метки не остаётся ни в аргументах, ни в комментарии', () => {
    const filled = taskXmlFor(raw, 'C:\\sma')
    expect(filled).not.toContain('SMA_HOME')
    expect(filled).toContain('C:\\sma\\supervisor\\daemon-watch.mjs')
  })

  it('амперсанд в пути уезжает экранированным — XML такого узла не терпит', () => {
    const filled = taskXmlFor(raw, 'C:\\r&d\\sma')
    expect(filled).toContain('C:\\r&amp;d\\sma\\supervisor\\daemon-watch.mjs')
  })
})

describe('круг поднимает упавшего сторожа, но не бесконечно', () => {
  it('прожитая минута — это работа: счёт быстрых падений обнуляется', () => {
    const verdict = restartVerdict({ ranMs: 3600_000, fastFailures: 3 })
    expect(verdict.restart).toBe(true)
    expect(verdict.fastFailures).toBe(0)
  })

  it('быстрое падение считается, и круг всё ещё поднимает', () => {
    const verdict = restartVerdict({ ranMs: 800, fastFailures: 1 })
    expect(verdict.restart).toBe(true)
    expect(verdict.fastFailures).toBe(2)
    expect(verdict.words).toContain(`из ${WATCH_RESTART_TRIES}`)
  })

  it('на потолке круг останавливается и говорит, почему: шестой запуск ничего не изменит', () => {
    const verdict = restartVerdict({ ranMs: 500, fastFailures: WATCH_RESTART_TRIES - 1 })
    expect(verdict.restart).toBe(false)
    expect(verdict.words).toMatch(/больше не поднимаю/)
  })

  it('потолок можно опустить — на нём и остановится', () => {
    expect(restartVerdict({ ranMs: 100, fastFailures: 0, tries: 1 }).restart).toBe(false)
  })
})

describe('один круг на машину', () => {
  it('замка нет — путь свободен', () => {
    expect(lockVerdict({ lock: null }).held).toBe(false)
  })

  it('живой процесс держит: второй сторож объявил бы одно падение дважды', () => {
    const verdict = lockVerdict({ lock: { pid: 4242, startedAt: '2026-08-29T10:00:00.000Z' }, isAlive: () => true })
    expect(verdict.held).toBe(true)
    expect(verdict.pid).toBe(4242)
    expect(verdict.words).toContain('4242')
  })

  it('замок от мёртвого процесса — мусор, а не занятость', () => {
    const verdict = lockVerdict({ lock: { pid: 4242 }, isAlive: () => false })
    expect(verdict.held).toBe(false)
    expect(verdict.words).toContain('4242')
  })

  it('бесформенный замок читается как свободный, а не роняет круг', () => {
    expect(lockVerdict({ lock: { pid: 'да' }, isAlive: () => true }).held).toBe(false)
  })

  it('замок лежит рядом с конфигом демона — второй демон на машине держит свой', () => {
    expect(watchLockPath({ env: { SMA_DAEMON_CONFIG: join('D:\\scratch', 'config.json') } })).toBe(join('D:\\scratch', WATCH_LOCK_FILE))
  })
})
