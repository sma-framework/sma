/**
 * branch-sync.mjs — СВЕДЕНИЕ ВЕТКИ С ВЕРШИНОЙ, и словарь конфликта, которым говорят обе двери.
 *
 * ═══════════════════════════ ЧТО ЗДЕСЬ ЧИНИТСЯ ══════════════════════════════════
 *
 * Очередь выдаёт работы веером на несколько мест, и все они отводятся от ОДНОЙ вершины,
 * которая через двадцать минут перестаёт существовать. Замерено 31.08.2026: за один вечер
 * пять готовых работ из шести не слились с первого раза, и во всех случаях причина была одна —
 * ветка отведена от вершины, устаревшей, пока работник работал. Конфликты садились в одни и те
 * же места: файл движка, который трогает почти всякая работа; оба README, куда каждая работа
 * дописывает свой абзац; сгенерированные числа. Цена каждой такой приёмки — либо возврат
 * работнику (полная стоимость подхода заново), либо ручной развод конфликта приёмщиком, а
 * ручной развод — ровно тот способ тихо откатить чужую свежую починку, от которого дом уже
 * пострадал.
 *
 * Это НЕ «просто гит»: систему конфликтам никто не учил, она создаёт их себе сама и сама же
 * перекладывает их разбор на человека. Этот модуль — три ответа на это, и все три живут в
 * ОДНОМ месте, потому что обе двери (сдача работником и приёмка человеком) задают git один и
 * тот же вопрос и обязаны отвечать на него одними словами:
 *
 *   1. `conflictedFiles` + `conflictWords` — ЧТО ИМЕННО не сошлось. До сих пор конфликт
 *      доезжал до человека одной строкой «слияние не прошло: Command failed», и приёмщик
 *      каждый раз выяснял состав конфликта сам, руками, в чужой копии.
 *   2. `resolveMechanical` — механический конфликт разводится БЕЗ человека. Механическим
 *      считается ровно то, что можно развести не выбирая: сгенерированное пересобирается своей
 *      же командой, а абзац, дописанный обеими сторонами в одно место, остаётся ОБОИМИ
 *      абзацами. Всё остальное — человеку, по имени файла.
 *   3. `syncWithTrunk` — свести ветку с нынешней вершиной ДО сдачи. Это работа сдающего, а не
 *      приёмщика: сведение, сделанное в копии работника, не трогает общее дерево вовсе, а
 *      приёмка получает ветку, которой больше не с чем спорить.
 *
 * ═══════════════════════ ЧТО СЧИТАЕТСЯ МЕХАНИЧЕСКИМ ════════════════════════════
 *
 * ОДНО ПРАВИЛО, И ОНО УЗКОЕ: механически разводится только то, где НЕТ ВЫБОРА. Развести
 * конфликт «на глазок» — это и есть тот тихий откат чужой починки, ради которого всё
 * затевалось, поэтому здесь нет ни одной эвристики про смысл правки.
 *
 *   union      — обе стороны только ДОПИСАЛИ в одно место, база пуста. Тогда оба куска
 *                остаются, каждый своей строкой, и не потеряно ничего. Если хоть одна сторона
 *                тронула существующие строки (база непуста) — это спор о содержании, и он
 *                уходит человеку. Класс ограничен объявленным списком путей: два соседних
 *                вставленных куска КОДА git конфликтом и называет именно потому, что рядом,
 *                и склеить их — сломать сборку.
 *   regenerate — файл машинный, и у него есть СВОЯ команда пересборки. Тогда стороны не
 *                разводят вовсе: артефакт пересобирается из источников и перестаёт быть
 *                предметом спора. Файл без команды пересборки НЕ объявляется механическим —
 *                это была бы подделка развода, а не развод.
 *
 * ДВЕ ПОХОДКИ ПЕРЕСБОРКИ, и разница между ними — в том, СКОЛЬКО файла команда собирает:
 *
 *   rebuild  — команда собирает файл ЦЕЛИКОМ из источников (индекс памяти — из заметок
 *              корпуса). Тогда её достаточно запустить один раз: она перепишет файл, и от
 *              спора не останется и следа. Маркеры, пережившие пересборку, означают, что файл
 *              этой командой не собирается, и он уходит человеку.
 *   rederive — команда правит в файле только СВОИ участки (карта замера: числа в размеченных
 *              спанах), а остальное в нём — рукописное. Запустить её поверх конфликта нельзя:
 *              маркеры останутся, потому что она их не трогает. Поэтому здесь берётся КАЖДАЯ
 *              сторона по очереди, пересобирается, и две пересборки СРАВНИВАЮТСЯ. Совпали —
 *              значит вся разница между сторонами была производной, выбирать было не из чего,
 *              и результат кладётся как разведённый. Разошлись — значит стороны спорили о
 *              рукописном, и файл уходит человеку. Это и есть доказательство отсутствия
 *              выбора, а не догадка о нём: ни одна сторона не объявляется правой.
 *
 * ПОЧЕМУ НЕ «ВЗЯТЬ НАШУ И ПЕРЕСОБРАТЬ». Карта несёт не только числа: пять исторических точек
 * роста и подпись под рисунком написаны руками. Взять одну сторону и пересобрать поверх неё —
 * это ровно тот тихий откат чужой правки, ради которого весь модуль и затевался. Сравнение
 * двух пересборок стоит одного лишнего прогона команды и снимает этот класс лжи целиком.
 *
 * ═════════════════════════════ ПОСТУРА ═══════════════════════════════════════════
 *
 * FAIL-OPEN/FAIL-HONEST, как у всего в этом слое: ни одна функция здесь не бросает. Не удалось
 * спросить git — так и сказано словами, и звонящий решает сам. Полусведённое дерево, которое
 * не удалось откатить, НАЗЫВАЕТСЯ вслух вместе с командой выхода из него: «откатить можно» и
 * «видно, к чему откатывать» — разные вещи.
 *
 * НИКАКОГО push. Здесь только локальные операции над рабочей копией — тот же закон, что у
 * ритуала слияния (merge-gate.mjs), и по той же причине.
 *
 * Только встроенные модули Node; git, файловая система и запуск команды пересборки — швы
 * (execGit / io / run), поэтому тесты не трогают ни настоящий репозиторий, ни настоящий диск.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync as fsRead, writeFileSync as fsWrite } from 'node:fs'
import { join } from 'node:path'

/** Вершина по умолчанию. Ветка задачи сводится с НЕЙ, и с ней же её сводит приёмка. */
export const TRUNK_DEFAULT = 'main'

/** Сколько имён файлов уезжает в человеческую строку. Остальные названы числом, не молчанием. */
export const CONFLICT_FILES_CAP = 8

/** Байт, которым git разделяет записи ответа с `-z`. Никогда не литералом в исходнике. */
const NUL = String.fromCharCode(0)

/** Маркеры конфликта в стиле diff3 — начало, база, середина, конец. */
const MARK_OURS = '<<<<<<<'
const MARK_BASE = '|||||||'
const MARK_MID = '======='
const MARK_THEIRS = '>>>>>>>'

/**
 * ПРАВИЛА МЕХАНИЧЕСКОГО РАЗВОДА, поставляемые по умолчанию.
 *
 * `union` — пути, где абзац дописывается каждой работой в один и тот же файл. Оба README
 * названы поимённо, потому что это ОБЯЗАННОСТЬ дома: всякая работа, меняющая продукт, правит
 * их обоих, и потому они конфликтуют чаще всего остального вместе взятого.
 *
 * `regenerate` — машинные артефакты и команда, которая их пересобирает. Индекс памяти собран
 * из заметок корпуса, каждая из которых лежит своим файлом: две ветки, добавившие по уроку,
 * спорят только в производном индексе, и спор снимается пересборкой, а не выбором стороны.
 * Карта замера идёт походкой `rederive`: её числа выводятся из квитанции прогона, а вокруг них
 * рукописное, поэтому две стороны пересобираются порознь и сравниваются (см. шапку файла).
 *
 * Список — ДАННЫЕ, а не закон: звонящий передаёт свои правила и получает своё поведение.
 */
export const MECHANICAL_DEFAULTS = Object.freeze({
  union: Object.freeze(['README.md', 'README.ru.md', 'ROADMAP.md', 'ROADMAP.ru.md', 'CHANGELOG.md']),
  regenerate: Object.freeze([
    Object.freeze({
      files: Object.freeze(['.claude/memory/MEMORY.md', '.claude/memory/INDEX-*.md']),
      command: Object.freeze(['node', 'scripts/sma/cli.mjs', 'build-index', '--write']),
    }),
    Object.freeze({
      files: Object.freeze(['docs/master-graph.html']),
      command: Object.freeze(['node', 'scripts/sma/cli.mjs', 'doc-audit', '--target', 'numbers', '--write']),
      strategy: 'rederive',
    }),
  ]),
})

/** Настоящий git: execFileSync с МАССИВОМ аргументов (никакой подстановки через оболочку). */
export function defaultExecGit(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' })
}

/** Настоящий запуск команды пересборки — тем же массивом и в той же копии. */
export function defaultRun(command, opts = {}) {
  const [bin, ...rest] = command
  return execFileSync(bin, rest, { cwd: opts.cwd, encoding: 'utf8' })
}

/**
 * matchesPattern(path, pattern) — путь против образца с `*`.
 *
 * `*` не переходит через `/`: `.claude/memory/INDEX-*.md` — это про файлы одного каталога, и
 * образец, который тихо утекал бы вглубь дерева, объявлял бы механическим то, чего автор
 * правила не называл. Сравнение идёт по прямым слэшам: git отвечает только ими, а вызывающая
 * сторона может прийти из Windows.
 */
export function matchesPattern(path, pattern) {
  const p = String(path ?? '').replace(/\\/g, '/')
  const raw = String(pattern ?? '').replace(/\\/g, '/')
  if (!p || !raw) return false
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? NUL : `\\${ch}`))
  const rx = new RegExp(`^${escaped.split(NUL).join('[^/]*')}$`)
  return rx.test(p)
}

/**
 * conflictedFiles({cwd, execGit}) → `{answered, files, count, reason}` — что именно git считает
 * неразведённым ПРЯМО СЕЙЧАС, во время незавершённого слияния.
 *
 * `--diff-filter=U` — это и есть вопрос «что осталось в конфликте», заданный самому git, а не
 * выведенный из текста его ошибки. Сообщение об ошибке — проза, зависящая от версии и локали;
 * список стадий индекса — факт.
 *
 * FAIL-HONEST: git не ответил → `{answered:false, files:[], count:0, reason}`. Пустой список
 * при `answered:false` — это «мы не знаем», и звонящий обязан читать его именно так, а не как
 * «конфликтов нет».
 */
export function conflictedFiles({ cwd, execGit } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  if (!cwd) return { answered: false, files: [], count: 0, reason: 'рабочей копии нет' }
  let out = ''
  try {
    out = String(
      git(['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U', '-z'], { cwd }) || '',
    )
  } catch (err) {
    return { answered: false, files: [], count: 0, reason: `git не ответил: ${String((err && err.message) || err)}` }
  }
  const files = out
    .split(NUL)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return { answered: true, files, count: files.length, reason: files.length ? null : 'неразведённых файлов нет' }
}

/**
 * conflictWords({files, count}) → ОДНА строка для человека: число и имена.
 *
 * До этой строки конфликт доезжал до экрана как «слияние не прошло: Command failed» — то есть
 * не доезжал вовсе, и приёмщик каждый раз шёл выяснять состав руками. Число стоит впереди имён
 * намеренно: оно не врёт при переполнении потолка, а имена под потолком обрезаны честно и
 * остаток назван числом, а не отброшен молча.
 */
export function conflictWords({ files, count } = {}) {
  const list = Array.isArray(files) ? files : []
  const n = Number.isFinite(count) ? count : list.length
  if (n <= 0) return 'конфликтов не названо'
  const shown = list.slice(0, CONFLICT_FILES_CAP)
  const rest = Math.max(0, list.length - shown.length)
  const names = shown.join(' · ')
  return `конфликт в ${n} файл(ах): ${names}${rest ? ` … ещё ${rest}` : ''}`
}

/**
 * classifyConflicts(files, rules) → `{union, regenerate, human}` — кто из названных файлов
 * разводится без человека и чем именно.
 *
 * Порядок проверки — `regenerate` перед `union`: у машинного артефакта есть своя правда
 * (источники), и склеивать две его версии, когда его можно просто пересобрать, значило бы
 * оставить в дереве строку, которой в источниках нет.
 */
export function classifyConflicts(files, rules = MECHANICAL_DEFAULTS) {
  const list = Array.isArray(files) ? files : []
  const unionPatterns = Array.isArray(rules && rules.union) ? rules.union : []
  const regenRules = Array.isArray(rules && rules.regenerate) ? rules.regenerate : []
  const union = []
  const regenerate = []
  const human = []
  for (const file of list) {
    const rule = regenRules.find(
      (r) => r && Array.isArray(r.files) && Array.isArray(r.command) && r.command.length > 0 &&
        r.files.some((pat) => matchesPattern(file, pat)),
    )
    if (rule) {
      // Походка по умолчанию — `rebuild`: правило, не назвавшее своей, ведёт себя ровно так,
      // как вело до появления второй, и ни одна чужая таблица правил от этого не поехала.
      regenerate.push({ file, command: [...rule.command], strategy: rule.strategy === 'rederive' ? 'rederive' : 'rebuild' })
      continue
    }
    if (unionPatterns.some((pat) => matchesPattern(file, pat))) {
      union.push(file)
      continue
    }
    human.push(file)
  }
  return { union, regenerate, human }
}

/** Есть ли в тексте хоть один маркер конфликта — вопрос «остался ли спор в файле». */
export function hasConflictMarkers(text) {
  return /^(<<<<<<<|=======|>>>>>>>)/m.test(String(text ?? ''))
}

/**
 * unionResolve(text) → `{text, hunks}` или `{text:null, reason}` — развести дописывания.
 *
 * ТЕКСТ ОБЯЗАН БЫТЬ В СТИЛЕ diff3, то есть нести БАЗУ. Без базы «обе стороны только дописали»
 * не отличить от «обе стороны переписали одно и то же место», а это и есть та самая разница
 * между безопасным разводом и тихим откатом чужой правки. Секция без маркера базы поэтому не
 * разводится вовсе — не потому что она непременно опасна, а потому что доказать обратное
 * нечем.
 *
 * Правило одно: база ПУСТА → остаются обе стороны, наша первой, каждая своими строками. База
 * непуста → отказ, весь файл уходит человеку (частично разведённый файл — худший из исходов:
 * он выглядит разведённым).
 *
 * Одинаковые куски не удваиваются: если обе стороны дописали буквально одно и то же, остаётся
 * один. Это не «умное слияние», а отказ печатать одну и ту же строку дважды.
 */
export function unionResolve(text) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  const out = []
  let hunks = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.startsWith(MARK_OURS)) {
      out.push(line)
      i += 1
      continue
    }
    const ours = []
    const base = []
    const theirs = []
    i += 1
    while (i < lines.length && !lines[i].startsWith(MARK_BASE) && !lines[i].startsWith(MARK_MID)) {
      ours.push(lines[i])
      i += 1
    }
    if (i >= lines.length || !lines[i].startsWith(MARK_BASE)) {
      return { text: null, reason: 'в разметке нет базы — какой стороной правили существующее, неизвестно' }
    }
    i += 1
    while (i < lines.length && !lines[i].startsWith(MARK_MID)) {
      base.push(lines[i])
      i += 1
    }
    if (i >= lines.length) return { text: null, reason: 'разметка конфликта оборвана' }
    i += 1
    while (i < lines.length && !lines[i].startsWith(MARK_THEIRS)) {
      theirs.push(lines[i])
      i += 1
    }
    if (i >= lines.length) return { text: null, reason: 'разметка конфликта оборвана' }
    i += 1
    if (base.some((l) => l.trim() !== '')) {
      return { text: null, reason: 'обе стороны правили существующие строки — это спор о содержании' }
    }
    out.push(...ours)
    if (theirs.join('\n') !== ours.join('\n')) out.push(...theirs)
    hunks += 1
  }
  if (hunks === 0) return { text: null, reason: 'маркеров конфликта в файле нет' }
  return { text: out.join('\n'), hunks }
}

/**
 * resolveMechanical({cwd, execGit, files, rules, io, run}) →
 *   `{resolved:[{file, how}], remaining:[string], notes:[string]}`
 *
 * Разводит то, что разводится без выбора, и НЕ ТРОГАЕТ ничего больше. Всё, что осталось в
 * `remaining`, — работа человека, и звонящий обязан на этом остановиться: наполовину
 * разведённое слияние опаснее неразведённого, потому что выглядит готовым.
 *
 * ПОСЛЕ ПЕРЕСБОРКИ ФАЙЛ ПРОВЕРЯЕТСЯ ЗАНОВО. Команда пересборки могла не тронуть тот самый
 * файл (не тот путь, отказ на полдороге, другое дерево) — и тогда в дереве остались бы
 * маркеры, добавленные в индекс как «разведено». Проверка стоит одно чтение файла и снимает
 * ровно этот класс лжи.
 */
export function resolveMechanical({ cwd, execGit, files, rules = MECHANICAL_DEFAULTS, io, run } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  const runner = typeof run === 'function' ? run : defaultRun
  const readFile = (io && io.readFileSync) || fsRead
  const writeFile = (io && io.writeFileSync) || fsWrite
  const { union, regenerate, human } = classifyConflicts(files, rules)
  const resolved = []
  const remaining = [...human]
  const notes = []

  for (const file of union) {
    try {
      // Перематериализуем файл со стадий индекса В СТИЛЕ diff3 — база нужна, чтобы отличить
      // дописывание от спора, а обычная разметка её не несёт.
      git(['-c', 'merge.conflictStyle=diff3', 'checkout', '--conflict=diff3', '--', file], { cwd })
      const before = String(readFile(join(cwd, file), 'utf8'))
      const merged = unionResolve(before)
      if (merged.text === null) {
        remaining.push(file)
        notes.push(`${file}: ${merged.reason}`)
        continue
      }
      writeFile(join(cwd, file), merged.text, 'utf8')
      git(['add', '--', file], { cwd })
      resolved.push({ file, how: 'union' })
    } catch (err) {
      remaining.push(file)
      notes.push(`${file}: развести дописывания не удалось — ${String((err && err.message) || err)}`)
    }
  }

  // ── ПОХОДКА `rederive`: ДВЕ ПЕРЕСБОРКИ, И ОНИ ДОЛЖНЫ СОВПАСТЬ ────────────────────────
  //
  // Команда правит в файле только свои участки, поэтому поверх конфликта её запускать
  // бессмысленно — маркеры она не трогает. Вместо этого материализуется КАЖДАЯ сторона и
  // пересобирается, а решает СРАВНЕНИЕ: совпали две пересборки — вся разница между сторонами
  // была производной, и выбирать было не из чего; разошлись — спор о рукописном, и он уходит
  // человеку. Ни одна сторона не объявляется правой ни в одном из исходов.
  for (const { file, command } of regenerate.filter((r) => r.strategy === 'rederive')) {
    const path = join(cwd, file)
    /** Материализовать сторону, пересобрать и вернуть получившиеся байты. */
    const sideBytes = (side) => {
      git(['checkout', `--${side}`, '--', file], { cwd })
      runner(command, { cwd })
      return String(readFile(path, 'utf8'))
    }
    try {
      const ours = sideBytes('ours')
      const theirs = sideBytes('theirs')
      if (ours !== theirs) {
        remaining.push(file)
        notes.push(`${file}: стороны пересобираются в РАЗНОЕ — спор не только в производных числах`)
        continue
      }
      // Маркеры после пересборки означают, что своя сторона их и несла: файл этой командой
      // не собирается целиком, и разведённым он не считается.
      if (hasConflictMarkers(theirs)) {
        remaining.push(file)
        notes.push(`${file}: пересборка прошла, а маркеры конфликта остались — файл её командой не собирается`)
        continue
      }
      git(['add', '--', file], { cwd })
      resolved.push({ file, how: 'rederive' })
    } catch (err) {
      remaining.push(file)
      notes.push(`${file}: пересобрать обе стороны не удалось — ${String((err && err.message) || err)}`)
    }
  }

  // Одна команда пересобирает СВОЙ набор файлов целиком, поэтому запускается один раз на
  // команду, а не один раз на файл: индекс памяти и его INDEX-*.md — это один прогон.
  const byCommand = new Map()
  for (const item of regenerate.filter((r) => r.strategy !== 'rederive')) {
    const key = item.command.join(' ')
    if (!byCommand.has(key)) byCommand.set(key, { command: item.command, files: [] })
    byCommand.get(key).files.push(item.file)
  }
  for (const { command, files: group } of byCommand.values()) {
    try {
      runner(command, { cwd })
    } catch (err) {
      remaining.push(...group)
      notes.push(`${group.join(' · ')}: пересборка отказала — ${String((err && err.message) || err)}`)
      continue
    }
    for (const file of group) {
      try {
        const after = String(readFile(join(cwd, file), 'utf8'))
        if (hasConflictMarkers(after)) {
          remaining.push(file)
          notes.push(`${file}: пересборка прошла, а маркеры конфликта остались — файл её командой не собирается`)
          continue
        }
        git(['add', '--', file], { cwd })
        resolved.push({ file, how: 'regenerate' })
      } catch (err) {
        remaining.push(file)
        notes.push(`${file}: после пересборки файл не прочитан — ${String((err && err.message) || err)}`)
      }
    }
  }

  return { resolved, remaining, notes }
}

/** Дерево осталось в незавершённом слиянии — и тогда это НАЗЫВАЕТСЯ вместе с выходом из него. */
export function unfinishedMergeHint(cwd) {
  return `рабочая копия осталась в НЕЗАВЕРШЁННОМ слиянии — выйти из него: git -C ${cwd} merge --abort`
}

/**
 * behindBy({cwd, trunk, execGit}) → сколько коммитов вершины ещё нет в ветке, или null.
 *
 * Отдельной функцией, потому что это ЕДИНСТВЕННЫЙ дешёвый вопрос, отделяющий «сводить нечего»
 * от «сводить надо»: слияние, начатое там, где сводить нечего, оставляет за собой пустой
 * коммит слияния и путает всякого, кто потом считает работу попытки по коммитам.
 */
export function behindBy({ cwd, trunk = TRUNK_DEFAULT, execGit } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  if (!cwd) return null
  try {
    const out = String(git(['rev-list', '--count', `HEAD..${trunk}`], { cwd }) || '').trim()
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * syncWithTrunk({cwd, trunk, execGit, io, run, rules, message}) — СВЕСТИ ВЕТКУ С ВЕРШИНОЙ,
 * в копии сдающего, до всякой приёмки. Асинхронна ради симметрии с ритуалом слияния; внутри
 * ничего не ждёт, кроме собственных швов.
 *
 * ПО ПОРЯДКУ:
 *   1. есть ли вершина вообще (`rev-parse --verify`) — в дереве без неё сводить не с чем, и
 *      это не отказ работы, а факт о дереве;
 *   2. отстала ли ветка (`rev-list --count HEAD..trunk`) — ноль означает «уже сведено», и
 *      никакого слияния не делается вовсе;
 *   3. `merge --no-ff --no-commit <trunk>` — вершина въезжает в копию, НО НЕ В ИСТОРИЮ;
 *   4. конфликт → назвать файлы, развести механическое, и только если не осталось НИЧЕГО —
 *      зафиксировать; иначе `merge --abort` и честный отказ с именами файлов;
 *   5. зафиксировать слияние (`commit --no-edit`) — вот теперь ветка сведена по-настоящему,
 *      с вершиной в родителях. Собрать содержимое руками и положить обычным коммитом нельзя:
 *      граф не узнает о сведении, и те же файлы конфликтнут заново при вливании.
 *
 * @returns
 *   - вершины нет:      {ok:true, synced:false, reason:'no-trunk', detail}
 *   - сводить нечего:   {ok:true, synced:false, alreadyCurrent:true, behind:0}
 *   - сведено:          {ok:true, synced:true, behind, resolved:[], mergeSha}
 *   - конфликт:         {ok:false, conflict:true, files, count, remaining, resolved, detail[, unfinishedMerge, howToClear]}
 *   - иная беда:        {ok:false, conflict:false, detail[, unfinishedMerge, howToClear]}
 */
export async function syncWithTrunk({ cwd, trunk = TRUNK_DEFAULT, execGit, io, run, rules = MECHANICAL_DEFAULTS, message } = {}) {
  const git = typeof execGit === 'function' ? execGit : defaultExecGit
  let mergeInTree = false
  try {
    if (!cwd) return { ok: false, conflict: false, detail: 'рабочей копии нет — сводить негде' }
    try {
      git(['rev-parse', '-q', '--verify', `${trunk}^{commit}`], { cwd })
    } catch {
      return { ok: true, synced: false, reason: 'no-trunk', detail: `вершины ${trunk} в этой копии нет — сводить не с чем` }
    }

    const behind = behindBy({ cwd, trunk, execGit: git })
    if (behind === 0) return { ok: true, synced: false, alreadyCurrent: true, behind: 0 }

    mergeInTree = true
    let conflict = null
    /** Что развелось без человека — назовём это вслух в ответе, а не оставим молчаливым. */
    let mechanically = []
    try {
      git(['merge', '--no-ff', '--no-commit', trunk], { cwd })
    } catch (err) {
      const found = conflictedFiles({ cwd, execGit: git })
      if (!found.answered || found.count === 0) {
        // Слияние не пошло, и НЕ из-за конфликта: грязное дерево, исчезнувшая ветка, отказ
        // самого git. Сказано ровно это, вместе с его собственной первой строкой.
        conflict = { files: [], count: 0, remaining: [], resolved: [], detail: String((err && err.message) || err).split('\n')[0] }
      } else {
        const fixed = resolveMechanical({ cwd, execGit: git, files: found.files, rules, io, run })
        conflict = fixed.remaining.length === 0
          ? null
          : {
              files: found.files,
              count: found.count,
              remaining: fixed.remaining,
              resolved: fixed.resolved,
              detail: conflictWords({ files: fixed.remaining, count: fixed.remaining.length }),
              notes: fixed.notes,
            }
        // Всё до одного развелось механически — слияние продолжается, как если бы конфликта
        // не было. Разведённое названо вслух в ответе: молчаливый автоматический развод и
        // есть тот тихий откат, которого дом боится.
        if (!conflict) mechanically = fixed.resolved
      }
    }

    if (conflict) {
      let unfinished = false
      try {
        git(['merge', '--abort'], { cwd })
        mergeInTree = false
      } catch {
        unfinished = true
      }
      return {
        ok: false,
        conflict: conflict.count > 0,
        behind,
        files: conflict.files,
        count: conflict.count,
        remaining: conflict.remaining,
        resolved: conflict.resolved,
        ...(conflict.notes && conflict.notes.length ? { notes: conflict.notes } : {}),
        detail: conflict.detail,
        ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
      }
    }

    // Сводить было нечего на самом деле (вершина уже в дереве) — тогда MERGE_HEAD отсутствует,
    // и фиксировать нечего: пустой коммит слияния соврал бы о том, что что-то приехало.
    let mergeHead = ''
    try {
      mergeHead = String(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd })).trim()
    } catch {
      mergeHead = ''
    }
    if (!mergeHead) {
      mergeInTree = false
      return { ok: true, synced: false, alreadyCurrent: true, behind }
    }

    const words = message || `свести с ${trunk} перед сдачей`
    git(['commit', '-m', words], { cwd })
    mergeInTree = false

    let mergeSha = ''
    try {
      mergeSha = String(git(['rev-parse', 'HEAD'], { cwd })).trim()
    } catch {
      mergeSha = ''
    }
    return { ok: true, synced: true, behind, resolved: mechanically, mergeSha: mergeSha || null }
  } catch (err) {
    let unfinished = false
    if (mergeInTree) {
      try {
        git(['merge', '--abort'], { cwd })
      } catch {
        unfinished = true
      }
    }
    return {
      ok: false,
      conflict: false,
      detail: String((err && err.message) || err).split('\n')[0],
      ...(unfinished ? { unfinishedMerge: true, howToClear: unfinishedMergeHint(cwd) } : {}),
    }
  }
}
