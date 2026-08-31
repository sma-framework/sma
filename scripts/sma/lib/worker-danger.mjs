/**
 * worker-danger.mjs — what counts as DANGEROUS when a worker asks for it.
 *
 * ═══════════════ WHY THE WORKER GETS ITS OWN THRESHOLD ═══════════════════════════
 * A person at a keyboard and a headless worker are not in the same position, so the
 * same command does not mean the same thing. Publishing to a remote is the founder's
 * own act — he is the one entitled to make work public, and his safety net treats a
 * plain publish as ordinary because refusing it would refuse him his own job. For a
 * worker, publishing is the one act nobody asked it to perform and nobody would see
 * until it had already happened. The same asymmetry runs through reconfiguring a
 * remote (that is how a lock gets removed), merging, tagging, releasing a package,
 * destruction that never touches version control at all, and downloading a script
 * straight into a shell.
 *
 * ═══════════════ WHY THIS IS A SEPARATE MODULE ═══════════════════════════════════
 * The terminal already has a destructive-command matcher, and its classes overlap
 * with this one. They are NOT shared, and the duplication is deliberate: the day
 * somebody raises the worker's threshold — and that day comes with every new class of
 * mistake a worker makes — a shared function would change the founder's own safety
 * net in the same edit, silently, in his own terminal, hours before he noticed. So
 * the overlapping classes are restated here in this module's own words, and the
 * founder's net is not imported, not called and not touched by anything in this file.
 *
 * ═══════════════ WHAT THIS MODULE IS NOT ═════════════════════════════════════════
 * IT IS NOT A BOUNDARY, and it must not pretend to be one. It only NAMES what looks
 * dangerous; it refuses nothing. The hard boundary is the refusal that travels in the
 * launch arguments of the worker's process — a list the worker cannot reach, edit or
 * argue with. This classifier is the SOFT boundary inside what is already permitted:
 * it stops a call so a person can look at it.
 *
 * Which is why UNKNOWN IS NOT DANGEROUS. A classifier that answered «dangerous» to
 * everything it did not recognise would park every unlisted command, and a worker
 * whose every command is parked is a worker that cannot work — the exact failure mode
 * that once cost this product a night of silently refused calls inside a child
 * process. Whatever this file does not list, it lets through, and the argument-level
 * refusal is what stands behind it.
 *
 * A COMPOUND COMMAND IS AS DANGEROUS AS ITS WORST PART. The vendor's harness splits
 * substitutions itself and checks the pieces separately — measured on a live run,
 * where a forbidden call hidden inside `$(…)` was caught and the harmless one beside
 * it was not. This module does the same rather than leaning on that behaviour: a
 * classifier that trusts somebody else's parser inherits every blind spot it has.
 *
 * Pure: no disk, no clock, no network, no process. Node built-ins only.
 */

// ── sensitive verbs, assembled rather than written adjacent to their context ─────
// Same discipline the rest of this directory keeps: the source of a detector must not
// carry the literal it detects, or the detector fires on its own file.
const GIT = ['git'].join('')
const PUSH_VERB = ['push'].join('')
const RESET_VERB = ['reset'].join('')
const CLEAN_VERB = ['clean'].join('')
const CHECKOUT_VERB = ['checkout'].join('')
const RESTORE_VERB = ['restore'].join('')
const BRANCH_VERB = ['branch'].join('')
const REBASE_VERB = ['rebase'].join('')
const MERGE_VERB = ['merge'].join('')
const TAG_VERB = ['tag'].join('')
const REMOTE_VERB = ['remote'].join('')
const CONFIG_VERB = ['config'].join('')
const PUBLISH_VERB = ['publish'].join('')

/**
 * Every class this module can name, in the order it names them. Frozen on purpose:
 * a class added past this list is a class no test and no receipt knows about.
 */
export const WORKER_DANGER_CLASSES = Object.freeze([
  'force-push',
  'push',
  'remote-config',
  'merge',
  'tag',
  'publish',
  'reset-hard',
  'clean',
  'branch-delete',
  'checkout-paths',
  'restore',
  'rebase',
  'non-git-destruction',
  'net-exec',
  'write-outside-copy',
  'deps-install',
])

/** Why each class is dangerous FOR A WORKER — the words a person reads on the card. */
const REASONS = Object.freeze({
  'force-push': 'принудительная отправка переписывает чужую историю в удалённом репозитории',
  push: 'отправка в удалённый репозиторий делает работу публичной — это действие человека, не работника',
  'remote-config': 'перенастройка удалённого репозитория или правка конфигурации снимает замок, который поставлен нарочно',
  merge: 'слияние меняет общую ветку — решение человека',
  tag: 'метка — это заявка на выпуск, и она видна всем',
  publish: 'публикация пакета или выпуск релиза необратимы за пределами этой машины',
  'reset-hard': 'жёсткий сброс уничтожает несохранённую работу без следа',
  clean: 'очистка сносит файлы, которых нет ни в одном коммите',
  'branch-delete': 'удаление ветки уносит работу, которая нигде больше не лежит',
  'checkout-paths': 'восстановление путей затирает правки в рабочем дереве',
  restore: 'восстановление затирает правки в рабочем дереве',
  rebase: 'перебазирование переписывает историю ветки',
  'non-git-destruction': 'рекурсивное удаление мимо системы контроля версий не восстанавливается ничем',
  'net-exec': 'скачанный из сети код исполняется сразу — содержимое не видел никто',
  'write-outside-copy': 'запись за пределы рабочей копии трогает то, что этой задаче не принадлежит',
  'deps-install': 'переустановка зависимостей в копии идёт по ссылке в дерево человека и опустошает его склад',
})

/** Инструменты, чей вход — строка команды оболочки. Всё остальное судится по пути. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Инструменты, которые ПИШУТ. Чтение не опасно никогда — оно ничего не меняет. */
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// ── git matchers (each one built from the assembled verbs above) ─────────────────
const reGit = new RegExp('\\b' + GIT + '\\s+')
const rePush = new RegExp('\\b' + GIT + '\\s+' + PUSH_VERB + '\\b([^&|;]*)')
const reReset = new RegExp('\\b' + GIT + '\\s+' + RESET_VERB + '\\b([^&|;]*)')
const reClean = new RegExp('\\b' + GIT + '\\s+' + CLEAN_VERB + '\\b([^&|;]*)')
const reCheckoutPaths = new RegExp('\\b' + GIT + '\\s+' + CHECKOUT_VERB + '\\s+--(\\s|$)')
const reRestore = new RegExp('\\b' + GIT + '\\s+' + RESTORE_VERB + '\\b([^&|;]*)')
const reBranchDelete = new RegExp('\\b' + GIT + '\\s+' + BRANCH_VERB + '\\s+(?:-D|--delete\\s+--force|--delete|-D\\s+-f|-f\\s+-D)\\b')
const reRebase = new RegExp('\\b' + GIT + '\\s+' + REBASE_VERB + '\\b([^&|;]*)')
// ГЛАГОЛ РОВНО `merge`, А НЕ НАЧАЛО ДРУГОГО. Со словарной границей `\b` сюда попадали и
// `merge-base`, и `merge-tree` — оба НИЧЕГО не двигают: первый печатает имя общего предка,
// второй считает слияние в памяти и не трогает ни одной ссылки. Замерено 31.08.2026: оба
// вопроса, заданные ради того, чтобы УЗНАТЬ состав будущего конфликта, вставали на парковку и
// умирали по сроку ожидания — то есть охрана мешала ровно той разведке, ради которой она стоит.
// САМО СЛИЯНИЕ ЭТИМ НЕ РАЗРЕШЕНО и разрешено не будет: оно остаётся решением человека, а
// работник сводит ветку с вершиной не рукой, а глаголом (`cli.mjs sync-branch`).
const reMerge = new RegExp('\\b' + GIT + '\\s+' + MERGE_VERB + '(?![-\\w])([^&|;]*)')
const reTag = new RegExp('\\b' + GIT + '\\s+' + TAG_VERB + '\\b([^&|;]*)')
const reRemote = new RegExp('\\b' + GIT + '\\s+' + REMOTE_VERB + '\\b([^&|;]*)')
const reConfig = new RegExp('\\b' + GIT + '\\s+' + CONFIG_VERB + '\\b([^&|;]*)')

// ── non-git matchers ────────────────────────────────────────────────────────────
const rePublish = new RegExp(
  '(\\b(?:npm|pnpm|yarn|bun|cargo)\\s+' + PUBLISH_VERB + '\\b)' +
    '|(\\btwine\\s+upload\\b)' +
    '|(\\bgh\\s+release\\s+create\\b)' +
    '|(\\bnpm\\s+dist-tag\\b)',
)
const reRmRecursive = /(^|[\s(])rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/i
/**
 * ПЕРЕСБОРКА КАТАЛОГА ЗАВИСИМОСТЕЙ. В рабочей копии этот каталог — ССЫЛКА на дерево
 * человека, и менеджер идёт по ней: 31.08.2026 склад основателя опустошался трижды за
 * сутки. Ловятся только глаголы, которые каталог ПЕРЕСОБИРАЮТ; `run`, `exec`, `test`,
 * `pack` сюда не входят — классификатор, останавливающий `npm run build`, будет выключен
 * целиком, и вместе с ним всё остальное в этом файле.
 *
 * Матчер якорится на НАЧАЛО части команды (допуская присвоения переменных перед ней): иначе
 * `git commit -m "… npm install …"` читалось бы как установка, и работник стоял бы на
 * собственном сообщении коммита.
 */
const reDepsInstall =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(npm|pnpm|yarn|bun)\s+(?:-{1,2}\S+\s+|[a-z0-9._-]+\s+)*?(install|ci|add|update|upgrade|prune|dedupe|rebuild|i)(?![\w-])/i
const reRemoveItem = /\bRemove-Item\b[^&|;]*?\s-(Recurse|Force)\b/i
const reWindowsDirWipe = /\b(rmdir|rd)\s+\/s\b|\bdel\s+\/[sq]\b/i
const reShred = /\b(shred|Clear-Disk|mkfs(\.[a-z0-9]+)?)\b/i
const reNetExec =
  /\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|iex|Invoke-Expression)\b/i

/**
 * Тела подстановок, вынутые из текста: `{outer, bodies}`.
 * Подстановка разбирается ОТДЕЛЬНОЙ частью, а не остаётся текстом внутри внешней:
 * `echo "$(<опасное>)"` иначе читалось бы как безобидный вывод строки.
 */
function liftSubstitutions(text) {
  const bodies = []
  let outer = String(text)
  // Один проход по самым внутренним подстановкам, затем ещё раз по тому, что осталось:
  // двух хватает для форм, которые встречаются в живых командах, и цикл конечен.
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false
    outer = outer.replace(/\$\(([^()]*)\)/g, (_m, body) => {
      bodies.push(body)
      changed = true
      return ' '
    })
    outer = outer.replace(/`([^`]*)`/g, (_m, body) => {
      bodies.push(body)
      changed = true
      return ' '
    })
    if (!changed) break
  }
  return { outer, bodies }
}

/** Открывающая метка встроенного документа: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`. */
const reHeredocOpen = /<<-?\s*(?:'([^']*)'|"([^"]*)"|(\\?)([A-Za-z_][A-Za-z0-9_]*))/

/** Толкователь на строке-заголовке: тело такого документа — КОМАНДЫ, а не данные. */
const reInterpreter = /(^|[\s(|&;])(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|node|python3?|ruby|perl|php|iex|Invoke-Expression)\b/i

/**
 * liftHeredocs(command) → `{outer, scan}` — команда без тел встроенных документов и то из
 * этих тел, что всё-таки нужно разобрать как команды.
 *
 * ЗАЧЕМ. Тело `<<'EOF'`, отданное не толкователю, — это ДАННЫЕ: git читает его как текст
 * сообщения коммита и не исполняет ни строки. Разобранное построчно, оно читалось как
 * команды, а обратные кавычки внутри — как подстановка; сообщение коммита, назвавшее
 * глагол слияния (а на этой самой работе его называет каждое второе), вставало на парковку
 * и умирало по сроку ожидания человека. Замерено 31.08.2026 в живой сессии: работник
 * потерял готовый коммит на фразе о слиянии в собственной пояснительной записке.
 *
 * ГРАНИЦА ЭТИМ НЕ ОСЛАБЛЕНА, и три случая разведены нарочно:
 *   - на строке-заголовке есть толкователь (`bash <<EOF`, `cat <<'EOF' | sh`) — тело
 *     ИСПОЛНЯЕТСЯ, и оно разбирается как команды целиком. Заголовок смотрится ВЕСЬ, а не
 *     до `<<`: толкователь бывает и справа, за трубой;
 *   - метка не в кавычках (`<<EOF`) — оболочка раскроет `$(…)` и обратные кавычки ещё до
 *     того, как данные куда-то поедут, поэтому подстановки из тела разбираются, а простые
 *     строки — нет;
 *   - метка в кавычках и толкователя нет — тело не исполняется ничем и не судится.
 *
 * НЕЗАКРЫТЫЙ ДОКУМЕНТ НЕ ВЫНИМАЕТСЯ ВОВСЕ. Не нашлась метка конца — строка остаётся как
 * была и судится обычным порядком: ошибаться здесь можно только в сторону лишнего разбора.
 * По той же причине метка конца узнаётся по обрезанной строке, а не по точному равенству:
 * документ, закрытый РАНЬШЕ, чем думал автор, отдаёт остаток на разбор, а не прячет его.
 */
function liftHeredocs(command) {
  const lines = String(command).split('\n')
  const kept = []
  const scan = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const open = reHeredocOpen.exec(line)
    if (!open) {
      kept.push(line)
      continue
    }
    const marker = open[1] ?? open[2] ?? open[4]
    const quoted = open[1] !== undefined || open[2] !== undefined || open[3] === '\\'
    let end = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === marker) { end = j; break }
    }
    if (end === -1) {
      kept.push(line)
      continue
    }
    // Заголовок остаётся без самой метки: команда, ПРИНИМАЮЩАЯ документ, судится как всегда.
    kept.push(line.slice(0, open.index) + line.slice(open.index + open[0].length))
    const body = lines.slice(i + 1, end).join('\n')
    if (reInterpreter.test(line)) scan.push(body)
    else if (!quoted) scan.push(liftSubstitutions(body).bodies.join('\n'))
    i = end
  }
  return { outer: kept.join('\n'), scan }
}

/** Части составной команды: оболочечные соединители, тела подстановок и то из встроенных
 *  документов, что исполняется. */
function commandParts(command) {
  const { outer, scan } = liftHeredocs(command)
  const out = []
  for (const source of [outer, ...scan]) {
    const lifted = liftSubstitutions(source)
    for (const piece of [lifted.outer, ...lifted.bodies]) {
      for (const part of String(piece).split(/&&|\|\||[;|\n]/)) {
        const t = part.trim()
        if (t) out.push(t)
      }
    }
  }
  return out
}

/** `git config --get x` читает, `git config --unset x` правит. Чтение не опасно. */
function configIsRead(rest) {
  const r = String(rest || '').trim()
  if (!r) return true
  // Явная правка объявлена флагом и перевешивает всё остальное: `--unset <ключ>` несёт
  // ровно одно слово-имя и без этой проверки читалось бы как чтение этого ключа.
  if (/(^|\s)(--unset\b|--unset-all\b|--replace-all\b|--add\b|--edit\b|-e\b|--rename-section\b|--remove-section\b)/.test(r)) return false
  if (/(^|\s)(--get\b|--get-all\b|--get-regexp\b|--list\b|-l\b)/.test(r)) return true
  // Одно имя ключа без значения — это чтение (`git config user.name`).
  const words = r.split(/\s+/).filter((w) => w && !w.startsWith('-'))
  return words.length <= 1
}

/** `git remote` без глагола перечисляет; правят его именованные подкоманды. */
function remoteIsWrite(rest) {
  return /(^|\s)(add|remove|rm|rename|set-url|set-head|set-branches|prune)\b/.test(String(rest || ''))
}

/** Голая `git tag` и `-l` перечисляют; всё, что создаёт или удаляет метку, — нет. */
function tagIsWrite(rest) {
  const r = String(rest || '').trim()
  if (!r) return false
  if (/(^|\s)(-l\b|--list\b|-n\d*\b|--contains\b|--points-at\b|--sort\b)/.test(r)) return false
  if (/(^|\s)(-a\b|-d\b|-s\b|-f\b|-m\b|--delete\b|--force\b|--annotate\b|--sign\b)/.test(r)) return true
  return r.split(/\s+/).some((w) => w && !w.startsWith('-'))
}

/** Класс ОДНОЙ части команды, или null. Порядок проверок — порядок WORKER_DANGER_CLASSES. */
function classifyPart(part) {
  // Сеть с исполнением проверяется ДО разбора на части — здесь она уже не видна,
  // поэтому вызывающий сначала смотрит на строку целиком.
  if (reGit.test(part)) {
    const push = rePush.exec(part)
    if (push) {
      const rest = push[1] || ''
      if (/(^|\s)(--force\b|--force-with-lease\b|-f\b)/.test(rest)) return 'force-push'
      // Проба ничего не отправляет и потому не опасна.
      if (!/(^|\s)(--dry-run\b|-n\b)/.test(rest)) return 'push'
    }

    const remote = reRemote.exec(part)
    if (remote && remoteIsWrite(remote[1])) return 'remote-config'
    const config = reConfig.exec(part)
    if (config && !configIsRead(config[1])) return 'remote-config'

    const merge = reMerge.exec(part)
    if (merge && !/(^|\s)--(abort|quit|continue)\b/.test(merge[1] || '')) return 'merge'

    const tag = reTag.exec(part)
    if (tag && tagIsWrite(tag[1])) return 'tag'

    const reset = reReset.exec(part)
    if (reset && /(^|\s)--hard\b/.test(reset[1] || '')) return 'reset-hard'

    const clean = reClean.exec(part)
    if (clean) {
      const rest = clean[1] || ''
      if (/(^|\s)-{1,2}[a-z]*f/i.test(rest) || /--force\b/.test(rest)) return 'clean'
    }

    if (reBranchDelete.test(part)) return 'branch-delete'
    if (reCheckoutPaths.test(part)) return 'checkout-paths'

    const restore = reRestore.exec(part)
    if (restore) {
      const rest = restore[1] || ''
      const staged = /(^|\s)--staged\b/.test(rest)
      const worktree = /(^|\s)(--worktree\b|-W\b)/.test(rest)
      if (!(staged && !worktree)) return 'restore'
    }

    const rebase = reRebase.exec(part)
    if (rebase && !/(^|\s)--(continue|abort|skip|quit|edit-todo)\b/.test(rebase[1] || '')) return 'rebase'
  }

  // ── и то, на чём подушка терминала молчит по построению ──
  if (rePublish.test(part)) return 'publish'
  if (reDepsInstall.test(part)) return 'deps-install'
  if (reRmRecursive.test(part) || reRemoveItem.test(part) || reWindowsDirWipe.test(part) || reShred.test(part)) {
    return 'non-git-destruction'
  }
  return null
}

/** Пути сравниваются в одной форме; на Windows регистр не значит ничего. */
function normalizePath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** Абсолютный путь вне копии — единственное, что делает не-оболочечный вызов опасным. */
function outsideCopy(filePath, copyRoot) {
  if (!filePath || !copyRoot) return false // копия не названа → путь не судится
  const p = normalizePath(filePath)
  const root = normalizePath(copyRoot)
  if (!p || !root) return false
  // Относительный путь берётся от каталога сессии, то есть от самой копии.
  const absolute = /^([a-z]:\/|\/)/i.test(p)
  if (!absolute) return false
  return p !== root && !p.startsWith(root + '/')
}

/**
 * classifyForWorker(tool, input, options) → `{dangerous, class, reason}`.
 *
 * `dangerous:false, class:null` — «этот модуль не нашёл здесь опасного», и это НЕ
 * то же самое, что «это разрешено»: разрешает или отказывает граница из аргументов
 * запуска, а не эта функция.
 *
 * @param {string} tool имя инструмента, как его называет харнесс
 * @param {object} input вход инструмента (для оболочки — `{command}`, для записи — `{file_path}`)
 * @param {{copyRoot?:string}} [options] корень рабочей копии; без него путь не судится
 * @returns {{dangerous:boolean, class:(string|null), reason:string}}
 */
export function classifyForWorker(tool, input, options = {}) {
  const safe = { dangerous: false, class: null, reason: '' }
  const name = typeof tool === 'string' ? tool : ''
  const arg = input && typeof input === 'object' ? input : {}

  if (SHELL_TOOLS.has(name)) {
    const command = typeof arg.command === 'string' ? arg.command : ''
    if (!command.trim()) return safe
    // Сеть с исполнением живёт ИМЕННО в соединителе, поэтому строка смотрится целиком
    // до разбора: разложенная на части, она читается как два безобидных вызова.
    if (reNetExec.test(command)) return { dangerous: true, class: 'net-exec', reason: REASONS['net-exec'] }
    for (const part of commandParts(command)) {
      const found = classifyPart(part)
      if (found) return { dangerous: true, class: found, reason: REASONS[found] }
    }
    return safe
  }

  if (WRITING_TOOLS.has(name)) {
    const target = typeof arg.file_path === 'string' ? arg.file_path : typeof arg.path === 'string' ? arg.path : ''
    if (outsideCopy(target, options && options.copyRoot)) {
      return { dangerous: true, class: 'write-outside-copy', reason: REASONS['write-outside-copy'] }
    }
    return safe
  }

  // Всё остальное — включая чтение любого пути — этот модуль опасным не называет.
  return safe
}
