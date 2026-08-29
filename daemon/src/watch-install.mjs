/**
 * watch-install.mjs — КАК СТОРОЖ ВСТАЁТ НА МАШИНУ, ГДЕ ПРАВ АДМИНИСТРАТОРА НЕТ.
 *
 * ═════════════ ЧТО БЫЛО СЛОМАНО ═════════════════════════════════════════════════
 * У сторожа (supervisor/daemon-watch.mjs) есть своя единица запуска: задача планировщика
 * `sma-daemon-watch-windows.task.xml` и её макосный близнец. На эталонной виндовой машине —
 * ровно на той, ради которой вся эта папка и написана, — виндовая половина закрыта: и
 * `schtasks /Create`, и `Register-ScheduledTask` из обычного сеанса отвечают «Access is
 * denied». Другого пути в комплекте не было, и сторож держался на ярлыке автозагрузки,
 * собранном руками: круг `while ($true) { node daemon-watch.mjs; sleep 60 }`, вписанный
 * строкой внутрь .lnk. Такой круг не версионируется, не читается в обзоре и не переезжает
 * вместе с продуктом — он существует только на одной машине и только пока цел ярлык.
 *
 * Здесь лежит решение о том, КАК ставить, — и оно проверяется без единого процесса, без
 * планировщика и без реестра. Сами действия делают два тонких скрипта рядом:
 * `supervisor/install-watch-windows.mjs` (ставит) и `supervisor/watch-loop.mjs` (крутит).
 *
 * ═════════════ ДВА ПУТИ, И ПЕРВЫЙ НЕ ЗАМАЛЧИВАЕТСЯ ══════════════════════════════
 * Задача планировщика лучше ярлыка: она переживает выход из сеанса и умеет перезапуск. Если
 * она СТАВИТСЯ — её и надо ставить. Поэтому постановка сначала пробует её, и, получив отказ,
 * НАЗЫВАЕТ его словами (`classifyTaskAttempt`) вместо того, чтобы проглотить и молча уйти в
 * запасной путь. Проглоченный отказ — это машина, про которую человек думает, что на ней
 * стоит задача планировщика, а на ней ярлык; такие расхождения всплывают в ночь падения.
 *
 * ═════════════ ЗАПАСНОЙ ПУТЬ ОБЯЗАН НЕСТИ ТЕ ЖЕ СВОЙСТВА ════════════════════════
 * Задача планировщика даёт три вещи, и ярлык, который их не даёт, — это тихое понижение:
 *   1. ЗАДЕРЖКА ПЕРЕД ПЕРВЫМ ВЗГЛЯДОМ. Сторож, посмотревший на машину раньше, чем та успела
 *      загрузиться, объявит падение, которого не было. Задача ждёт две минуты — их ждёт и
 *      круг (`--delay`), и ждёт он их у себя, а не строкой внутри ярлыка.
 *   2. ПЕРЕЗАПУСК СТОРОЖА. `RestartOnFailure` — последняя черепаха: сторож, который умер,
 *      это сторож, за которым никто не смотрит. Круг поднимает его снова (`restartVerdict`),
 *      но не бесконечно: несколько быстрых падений подряд — вопрос уже не к машине.
 *   3. ОДИН СТОРОЖ НА МАШИНУ. Два объявят одно падение дважды и дважды позовут подъём.
 *      Задача держит это через MultipleInstancesPolicy, круг — через замок (`lockVerdict`).
 *
 * ═════════════ ЧЕГО ЗДЕСЬ НЕТ ═══════════════════════════════════════════════════
 * Ни одного действия: ни записи файла, ни запуска процесса, ни обращения к планировщику. Всё,
 * что делает эта единица, — считает пути, строит текст и выносит вердикты по данным, которые
 * ей принесли. Поэтому её таблица решений проверяется целиком и в памяти.
 */

import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'

import { resolveConfigPath } from './config.mjs'
import { SMA_HOME } from './control.mjs'

/** Имя ярлыка в автозагрузке. Пробелы — нарочно: это имя видит человек в папке, а не скрипт. */
export const WATCH_SHORTCUT_NAME = 'SMA daemon watch'

/** Имя задачи планировщика — то же, что в шапке отгружаемого XML. */
export const WATCH_TASK_NAME = 'SMA-Daemon-Watch'

/** Отгружаемая единица планировщика, из которой постановка берёт задачу. */
export const WATCH_TASK_XML = 'sma-daemon-watch-windows.task.xml'

/** Дневной журнал круга — рядом с журналом демона и явно другим именем. */
export const WATCH_LOG_PREFIX = 'daemon-watch-'

/** Файл замка: один круг на машину, и в нём написано, кто его держит. */
export const WATCH_LOCK_FILE = 'daemon-watch.lock.json'

/**
 * СКОЛЬКО КРУГ ЖДЁТ ПЕРЕД ПЕРВЫМ ВЗГЛЯДОМ, когда его запустил вход в систему.
 * Две минуты — ровно столько ждёт задача планировщика, и по той же причине: демон стартует
 * своим ярлыком через полминуты после входа, и ему нужно дать доделать boot.
 */
export const WATCH_START_DELAY_SEC = 120

/** Пауза между падением сторожа и следующим подъёмом — минута, как у RestartOnFailure. */
export const WATCH_RESTART_PAUSE_MS = 60000

/** Сколько БЫСТРЫХ падений подряд круг терпит, прежде чем перестать поднимать. */
export const WATCH_RESTART_TRIES = 5

/**
 * Что считается «быстрым падением». Сторож, проживший минуту, работал: его следующий выход —
 * новое событие, а не продолжение прежнего, и счёт начинается заново. Сторож, умерший за
 * секунду, не работал ни разу, и пять таких подряд означают причину, которую перезапуск не
 * лечит (нет конфига, сломан модуль, занят порт) — её надо читать глазами.
 */
export const WATCH_FAST_FAILURE_MS = 60000

// ── пути ──────────────────────────────────────────────────────────────────────────

/**
 * startupDir({env, homedir}) — папка автозагрузки текущего пользователя.
 *
 * Считается из APPDATA, а не из «C:\Users\<имя>»: профиль бывает перемещаемым, и тогда
 * домашний каталог и APPDATA — разные места. Настоящий путь всё равно спрашивается у Windows
 * в момент записи (см. `shortcutScript`) — этот здесь для планирования и для отчёта.
 */
export function startupDir({ env = process.env, homedir = osHomedir } = {}) {
  const roaming = env.APPDATA && String(env.APPDATA).trim() ? String(env.APPDATA) : join(homedir(), 'AppData', 'Roaming')
  return join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

/** Каталог, в котором живут запись демона, журналы и замок круга. */
export function daemonDir({ env = process.env, homedir = osHomedir } = {}) {
  return dirname(resolveConfigPath({ env, homedir }))
}

/** Путь замка круга. Один на конфиг: второй демон на машине держит и свой замок. */
export function watchLockPath(io = {}) {
  return join(daemonDir(io), WATCH_LOCK_FILE)
}

/**
 * watchLoopCommand({smaHome, nodeBin, delaySec}) — чем запускается вечный круг.
 *
 * Круг — обычный node-процесс, поэтому команда одна на все платформы: ярлык Windows целит в
 * неё же, только через свои поля. Задержка едет АРГУМЕНТОМ, а не сном внутри ярлыка: строка в
 * .lnk не читается ни в обзоре, ни тестом, а аргумент читается обоими.
 */
export function watchLoopCommand({ smaHome = SMA_HOME, nodeBin = process.execPath, delaySec = 0 } = {}) {
  const args = [join(smaHome, 'supervisor', 'watch-loop.mjs')]
  if (Number(delaySec) > 0) args.push('--delay', String(Math.round(Number(delaySec))))
  return { cmd: nodeBin, args, cwd: smaHome }
}

/**
 * shortcutPlan({...}) — чем станет ярлык, полем в поле.
 *
 * TargetPath — АБСОЛЮТНЫЙ путь к node, а не слово «node»: ярлык не ищет по PATH, и
 * несуществующая цель — это ярлык, который не запускается и об этом молчит. Цена честная и
 * названа в документации: node, переставленный на другое место, требует повторной постановки.
 *
 * WindowStyle 7 — свёрнутое окно, а не спрятанное. Спрятанный процесс нельзя ни увидеть, ни
 * закрыть, не заходя в диспетчер задач; свёрнутый виден на панели и закрывается как всё
 * остальное. Сторож, которого нельзя выключить руками, — это не страховка.
 */
export function shortcutPlan({
  smaHome = SMA_HOME,
  name = WATCH_SHORTCUT_NAME,
  nodeBin = process.execPath,
  delaySec = WATCH_START_DELAY_SEC,
  io = {},
} = {}) {
  const dir = startupDir(io)
  const lift = watchLoopCommand({ smaHome, nodeBin, delaySec })
  return {
    dir,
    path: join(dir, `${name}.lnk`),
    name,
    target: lift.cmd,
    args: lift.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '),
    workingDir: lift.cwd,
    windowStyle: 7,
    description: 'Сторож демона SMA: стучит в дверь, зовёт человека и поднимает упавшего.',
  }
}

// ── текст для PowerShell ──────────────────────────────────────────────────────────

/** Строка внутри одинарных кавычек PowerShell: удваивается только сама кавычка. */
export function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/**
 * shortcutScript(plan) — PowerShell, который пишет ярлык.
 *
 * .lnk — это COM-объект, и никакого способа собрать его из node без WScript.Shell нет. Зато
 * есть способ не соврать о том, КУДА он лёг: папку автозагрузки скрипт спрашивает у самой
 * Windows (`GetFolderPath('Startup')`) и, если она не та, что посчитал node, пишет в
 * настоящую и говорит об этом строкой. Перенаправленный профиль встречается в конторских
 * машинах, а ярлык, положенный мимо, — это тишина вместо сторожа.
 *
 * Последняя строка вывода — `PATH=<куда легло>`; читающая сторона берёт путь оттуда, а не из
 * своих расчётов. Проверка `Test-Path` после `Save()` стоит здесь потому, что COM-вызов,
 * который ничего не записал, исключения не бросает.
 */
export function shortcutScript(plan) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$want = ${psQuote(plan.dir)}`,
    "$real = [Environment]::GetFolderPath('Startup')",
    '$dir = if ($real) { $real } else { $want }',
    'if ($real -and $real -ne $want) { Write-Output ("NOTE=" + $real) }',
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `$path = Join-Path $dir ${psQuote(`${plan.name}.lnk`)}`,
    "$shell = New-Object -ComObject WScript.Shell",
    '$link = $shell.CreateShortcut($path)',
    `$link.TargetPath = ${psQuote(plan.target)}`,
    `$link.Arguments = ${psQuote(plan.args)}`,
    `$link.WorkingDirectory = ${psQuote(plan.workingDir)}`,
    `$link.WindowStyle = ${Number(plan.windowStyle) || 7}`,
    `$link.Description = ${psQuote(plan.description)}`,
    '$link.Save()',
    'if (-not (Test-Path -LiteralPath $path)) { throw ("ярлык не записался: " + $path) }',
    'Write-Output ("PATH=" + $path)',
  ].join('\n')
}

/** Путь, который PowerShell назвал сам. Пустая строка означает «скрипт не сказал» — это провал. */
export function shortcutPathFromOutput(output) {
  const lines = String(output ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const at = lines[i].indexOf('PATH=')
    if (at === 0) return lines[i].slice('PATH='.length).trim()
  }
  return ''
}

// ── задача планировщика ───────────────────────────────────────────────────────────

/** Текстовые узлы XML не терпят трёх знаков; путь пользователя может нести любой из них. */
function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * taskXmlFor(raw, smaHome) — отгружаемая единица с подставленным путём клона.
 *
 * В файле метка стоит дважды и в двух видах: экранированной внутри аргументов и обычной
 * внутри комментария. Подставляются обе — оставшаяся метка означает задачу, которая при
 * запуске ищет `<SMA_HOME>\supervisor\daemon-watch.mjs` и не находит.
 */
export function taskXmlFor(raw, smaHome) {
  return String(raw).split('&lt;SMA_HOME&gt;').join(xmlEscape(smaHome)).split('<SMA_HOME>').join(smaHome)
}

/**
 * decodeConsole(bytes) — вывод консольной программы Windows, прочитанный так, чтобы его можно
 * было ПОКАЗАТЬ ЧЕЛОВЕКУ.
 *
 * schtasks пишет в кодовой странице консоли, а не в UTF-8: на русской машине это 866, и байты
 * «Отказано в доступе», прочитанные как UTF-8, превращаются в строку из знаков замены. Отказ,
 * названный нечитаемыми словами, — это тот же проглоченный отказ, только длиннее. Поэтому
 * берётся первая таблица, при которой ни одного знака замены не осталось: чистый ASCII
 * проходит первой же попыткой, русский ответ — второй.
 */
export function decodeConsole(bytes) {
  if (bytes == null) return ''
  if (typeof bytes === 'string') return bytes
  const buf = Buffer.from(bytes)
  for (const encoding of ['utf8', 'ibm866', 'windows-1251']) {
    try {
      const text = new TextDecoder(encoding).decode(buf)
      if (!text.includes('�')) return text
    } catch {
      /* такой таблицы в этой сборке нет — следующая */
    }
  }
  return buf.toString('latin1')
}

/** Признаки отказа по правам — на обоих языках, на которых Windows отвечает на этой машине. */
const DENIED = /access is denied|отказано в доступе|0x80070005|requires elevation|elevated/i

/**
 * classifyTaskAttempt({code, output, error}) → {outcome, words}.
 *
 *   registered  задача создана — ярлык не нужен, единица на машине одна
 *   denied      прав не хватило: это ОЖИДАЕМЫЙ исход обычного сеанса, и он называется словами
 *   failed      что-то другое: причина едет наружу целиком, а не превращается в «не вышло»
 *
 * Отдельный `denied` существует ради одной строки в выводе постановки. Без него отказ по
 * правам неотличим от сломанного XML, и человек, у которого сторож не встал, читает одно и то
 * же «не удалось» в двух совершенно разных случаях.
 */
export function classifyTaskAttempt({ code = 0, output = '', error = null } = {}) {
  const tail = String(output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
  if (error) {
    return {
      outcome: 'failed',
      words: `задачу планировщика поставить не вышло: ${String((error && error.message) || error)}`,
    }
  }
  if (Number(code) === 0) return { outcome: 'registered', words: `задача планировщика поставлена${tail ? `: ${tail}` : '.'}` }
  if (DENIED.test(tail)) {
    return {
      outcome: 'denied',
      words:
        'schtasks отказал по правам: «Access is denied» — задача планировщика ставится только из окна ' +
        `с правами администратора (Register-ScheduledTask отвечает тем же)${tail ? `. Дословно: ${tail}` : ''}`,
    }
  }
  return { outcome: 'failed', words: `schtasks вышел с кодом ${code}${tail ? `: ${tail}` : ' и не сказал ни слова'}` }
}

// ── вечный круг ───────────────────────────────────────────────────────────────────

/**
 * restartVerdict({ranMs, fastFailures}) → {restart, fastFailures, words}.
 *
 * Круг существует ради одного свойства задачи планировщика, которого у ярлыка нет: сторож,
 * который умер, поднимается снова. Но «снова» не значит «вечно»: сторож, падающий за секунду
 * пять раз подряд, падает по причине, которую шестой запуск не изменит, и единственное
 * полезное действие в этой точке — оставить причину в журнале и остановиться. Прожитая минута
 * обнуляет счёт: это была работа, а не отказ старта.
 */
export function restartVerdict({
  ranMs = 0,
  fastFailures = 0,
  tries = WATCH_RESTART_TRIES,
  fastMs = WATCH_FAST_FAILURE_MS,
} = {}) {
  const seconds = Math.round(Number(ranMs) / 100) / 10
  if (Number(ranMs) >= Number(fastMs)) {
    return { restart: true, fastFailures: 0, words: `сторож отработал ${seconds} с и вышел — поднимаю снова.` }
  }
  const next = Number(fastFailures) + 1
  if (next >= Number(tries)) {
    return {
      restart: false,
      fastFailures: next,
      words:
        `сторож упал за ${seconds} с, и это ${next}-е быстрое падение подряд — больше не поднимаю. ` +
        'Причина в строках выше: её надо прочитать, перезапуск её не лечит.',
    }
  }
  return {
    restart: true,
    fastFailures: next,
    words: `сторож упал за ${seconds} с (быстрых падений подряд: ${next} из ${tries}) — поднимаю снова.`,
  }
}

/**
 * lockVerdict({lock, isAlive}) → {held, pid, words}.
 *
 * Замок отвечает на один вопрос: крутится ли уже круг на этой машине. Живым его делает не
 * файл, а ПРОЦЕСС — файл, оставшийся от круга, убитого выключением машины, это не занятость,
 * а мусор, и второй круг из-за него не должен отказываться стартовать.
 *
 * ЧЕСТНАЯ ГРАНИЦА: номер процесса Windows переиспользует. Замок от давно умершего круга,
 * чей номер достался чужому процессу, будет прочитан как занятый — тогда `--force` снимает
 * его руками. Обратная ошибка (два сторожа) стоит человеку двух сообщений на одно падение,
 * эта — одной команды, поэтому выбор именно такой.
 */
export function lockVerdict({ lock = null, isAlive = () => false } = {}) {
  if (!lock || !Number.isInteger(Number(lock.pid)) || Number(lock.pid) <= 0) return { held: false, pid: 0, words: 'замок свободен.' }
  const pid = Number(lock.pid)
  if (!isAlive(pid)) return { held: false, pid: 0, words: `замок остался от процесса ${pid}, которого уже нет — беру.` }
  return {
    held: true,
    pid,
    words: `круг уже крутится: процесс ${pid}${lock.startedAt ? `, с ${lock.startedAt}` : ''}. Второй сторож объявил бы одно падение дважды.`,
  }
}
