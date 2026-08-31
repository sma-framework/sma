/**
 * deps-guard.mjs — СКЛАД ЗАВИСИМОСТЕЙ ОДИН, А РУК, ТЯНУЩИХСЯ К НЕМУ, МНОГО.
 *
 * ═══════════════ ЧТО ИЗМЕРЕНО 31.08.2026, А НЕ ПРЕДПОЛОЖЕНО ══════════════════════
 * Копия работника получает зависимости ССЫЛКОЙ на каталоги основного дерева
 * (`node_modules`, `daemon/node_modules`, `spa/node_modules` — junction на Windows).
 * Это сделало копию дешёвой и ровно этим — опасной: любая команда, которая внутри копии
 * УДАЛЯЕТ или ПЕРЕУСТАНАВЛИВАЕТ зависимости, идёт по ссылке и бьёт по складу человека,
 * в дереве которого он в эту минуту работает.
 *
 * За 31.08 склад опустошался трижды. Механизм установлен по журналам, а не угадан:
 *   • 17:27:58.915Z чужая сессия выполнила СЫРОЙ `git worktree remove --force <копия>`
 *     на копии, внутри которой ещё висели три ссылки; mtime каталога
 *     `projects/sma/node_modules` — 17:28:00Z, через полторы секунды. Это и есть
 *     «19:28, daemon/node_modules основного дерева пуст» с карточки.
 *   • Уборка ДЕМОНА оправдана этим же журналом: 29 уборок за сутки, и в каждой строке
 *     попытки записано `unlinked: [daemon/node_modules, node_modules, spa/node_modules]`
 *     ДО того, как копию увидел git. Ни одна не стоит ближе получаса к опустошению.
 *   • Установка в копии — не гипотеза: в 17:54:36Z `npm ci` был запущен с cwd внутри копии
 *     работника (`…/<копия>/daemon`). Тот раз обошёлся: ссылку сняли ПЕРЕД установкой
 *     (`rm daemon/node_modules`), и менеджер писал уже в свой каталог. Порядок, который
 *     спас склад, держался на внимательности исполнителя — то есть ни на чём.
 *
 * Отсюда три вопроса, на которые отвечает этот модуль, и он единственный, кто отвечает
 * на них во всём продукте — чтобы «а ссылка ли это?» не разошлось в трёх местах:
 *   1. installRefusal — установка целится в каталог, чей `node_modules` есть ССЫЛКА
 *      наружу? Тогда ОТКАЗ СЛОВАМИ, до первой записи, а не разбор последствий потом.
 *   2. copyRemovalRefusal — сырая уборка копии, внутри которой ещё висят ссылки? Тогда
 *      отказ и имя верба, который убирает правильно (он снимает ссылки первым делом).
 *   3. checkEnvironmentFitness — годится ли дерево, чтобы вообще запускать в нём тесты?
 *      Разница между «тесты красные» и «среда сломана» — это разница между «работник
 *      сломал код» и «работнику нечем запуститься», и гейт слияния обязан называть её.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ НИ ОДНОГО УДАЛЕНИЯ И НИ ОДНОГО ЗАПУСКА. Модуль только СМОТРИТ на
 * файловую систему (lstat/stat/readlink/readdir) и выносит суждение словами. Руки —
 * у вызывающих: гейт вызовов работника, поток `sma pre`, гейт слияния. Судья, который
 * сам же и наказывает, не проверяется в памяти и не переиспользуется.
 *
 * Node built-ins only, никакой сети, никакого пакетного менеджера. `fsImpl`/`platform`
 * инъектируются, поэтому весь файл проверяется на подделке и на настоящих ссылках.
 */

import * as nodeFs from 'node:fs'
import { resolve as resolvePath, join as joinPath } from 'node:path'

import { readWorktreeInclude } from './worktree.mjs'

/** Начало любого отказа гейта по среде — одно слово на весь продукт, чтобы его искали грепом. */
export const ENV_BROKEN_PREFIX = 'среда сломана'

/**
 * Движок тестов — тот самый, которого 31.08 не было ни в одном дереве. Имя стоит здесь ОДИН
 * раз: страж, знающий движок под своим именем, и запускатель, знающий под другим, разойдутся
 * молча и на чужой машине.
 */
const TEST_ENGINE = 'vitest'

/**
 * Команда, которой среда чинится. Отказ без неё — половина отказа: человек читает «среда
 * сломана» и идёт спрашивать, чем её лечат. 31.08 лечилось ровно этим, в ОСНОВНОМ дереве
 * (в копии работника склад — ссылка наружу, и установка в ней бьёт по чужому дереву).
 */
export const ENV_RESTORE_HINT = 'pnpm install --frozen-lockfile'

/** Каталог зависимостей — `node_modules` на любой глубине, и ничего кроме. */
const DEPENDENCY_DIR_RE = /(^|\/)node_modules$/

/**
 * Глаголы пакетных менеджеров, которые ПЕРЕСОБИРАЮТ каталог зависимостей. `run`, `exec`,
 * `test`, `pack`, `view` сюда не входят намеренно: они ничего не сносят, а гейт, который
 * останавливает `npm run build`, — это гейт, который выключат целиком.
 */
const INSTALL_VERB_RE = /^(install|ci|add|update|upgrade|prune|dedupe|rebuild|link|i)$/i

/** Менеджеры, чьи глаголы читаются выше. */
const MANAGER_RE = /^(npm|pnpm|yarn|bun)$/i

/** Флаги, переносящие установку в ДРУГОЙ каталог: `--prefix X`, `-C X`, `--dir X`. */
const PREFIX_FLAG_RE = /^(--prefix|--dir|-C)$/

/** Сколько записей каталога зависимостей просматривается на висячие ссылки. */
const DANGLING_SCAN_CAP = 4000

/** Прямые слэши, без хвостового разделителя — одна форма пути на весь модуль. */
function normalizeRel(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * `p` — это `root` или лежит под ним. Своя копия предиката, а не импорт: сравнение путей
 * читает `platform`, и общая функция на двоих означала бы, что уборка и установка однажды
 * разойдутся в ответе на «наружу ли это» — молча и на чужой машине.
 */
function isInside(root, p, platform) {
  const norm = (v) => {
    const s = resolvePath(String(v)).replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? s.toLowerCase() : s
  }
  const r = norm(root)
  const t = norm(p)
  return t === r || t.startsWith(`${r}/`)
}

/** Снять кавычки, которыми путь приехал из командной строки. */
function unquote(word) {
  const w = String(word ?? '').trim()
  if (w.length >= 2 && ((w[0] === '"' && w.endsWith('"')) || (w[0] === "'" && w.endsWith("'")))) {
    return w.slice(1, -1)
  }
  return w
}

/**
 * stripHeredocs(command) — тело «здесь-документа» это ДАННЫЕ, а не команды.
 *
 * Замерено на этом самом страже: `cat > файл <<'EOF' … EOF`, которым дописывался ТЕКСТ
 * теста про `npm ci`, был прочитан как установка и отклонён. Строка внутри документа
 * никогда не выполняется — она едет в файл, — а страж, останавливающий написание текста
 * о команде, выключат вместе со всем остальным. Поэтому тела вырезаются до разбора.
 */
function stripHeredocs(command) {
  const lines = String(command ?? '').split('\n')
  const out = []
  let terminator = null
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue // тело документа — данные, не часть команды
    }
    out.push(line)
    const m = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line)
    if (m) terminator = m[1] ?? m[2] ?? m[3]
  }
  return out.join('\n')
}

/** Части составной команды в порядке выполнения — `cd` слева меняет каталог справа. */
function commandSteps(command) {
  return stripHeredocs(command)
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Слова одной части, с сохранением кавычек до момента разбора. */
function words(step) {
  return String(step)
    .match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map((w) => w) ?? []
}

/**
 * dependencyDirsOf({root, fsImpl, discover}) -> ['node_modules', 'daemon/node_modules', …]
 *
 * ИМЕНА БЕРУТСЯ ИЗ ТОГО ЖЕ МАНИФЕСТА, ПО КОТОРОМУ ПРОВИЗИЯ СТАВИТ ССЫЛКИ. Отдельный
 * список здесь означал бы, что провизия подключает четвёртый каталог, а страж о нём не
 * знает — и узналось бы это опустошением, а не тестом.
 *
 * `discover:true` ДОБАВЛЯЕТ подпроекты первого уровня (каталог со своим package.json).
 * Это нужно там, где манифеста нет: он лежит в `.sma/`, а `.sma/` в копию НЕ переносится
 * — значит, спрошенная внутри копии, эта функция без разведки увидела бы только корневой
 * склад и промолчала бы ровно о `daemon/node_modules`, который 31.08 и опустел.
 * @param {{root:string, fsImpl?:object, discover?:boolean}} opts
 * @returns {string[]}
 */
export function dependencyDirsOf(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const manifest = readWorktreeInclude({ mainRoot: opts.root, fsImpl: fs })
  const out = []
  for (const entry of Array.isArray(manifest.link) ? manifest.link : []) {
    const rel = normalizeRel(entry)
    if (rel && DEPENDENCY_DIR_RE.test(rel) && !out.includes(rel)) out.push(rel)
  }
  if (!out.includes('node_modules')) out.push('node_modules')
  if (opts.discover) {
    let items = []
    try {
      items = fs.readdirSync(opts.root, { withFileTypes: true })
    } catch {
      items = []
    }
    for (const it of items) {
      if (!it.isDirectory() || it.name.startsWith('.') || it.name === 'node_modules') continue
      const rel = `${it.name}/node_modules`
      if (out.includes(rel)) continue
      try {
        fs.readFileSync(joinPath(opts.root, it.name, 'package.json'), 'utf8')
      } catch {
        continue // не подпроект — не наше дело
      }
      out.push(rel)
    }
  }
  return out
}

/**
 * linkedDepsOf({root, fsImpl, platform}) -> [{path, target, outside}] — какие каталоги
 * зависимостей этого дерева на самом деле являются ССЫЛКАМИ и куда они ведут.
 * Отсутствующий каталог не упоминается вовсе: беречь нечего. Подпроекты разведываются
 * (`discover`), потому что спрашивают об этом чаще всего ИЗ копии, где манифеста нет.
 * @param {{root:string, fsImpl?:object, platform?:string}} opts
 * @returns {Array<{path:string, target:(string|null), outside:boolean}>}
 */
export function linkedDepsOf(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const platform = opts.platform ?? process.platform
  const root = opts.root
  const out = []
  for (const rel of dependencyDirsOf({ root, fsImpl: fs, discover: true })) {
    const abs = resolvePath(root, ...rel.split('/'))
    let st = null
    try {
      st = fs.lstatSync(abs)
    } catch {
      continue // каталога нет — нечего беречь
    }
    if (!st || !st.isSymbolicLink()) continue
    let target = null
    try {
      target = String(fs.readlinkSync(abs))
    } catch {
      /* нечитаемая цель всё равно остаётся ссылкой */
    }
    out.push({ path: rel, target, outside: target ? !isInside(root, target, platform) : true })
  }
  return out
}

/**
 * linksAt({dir, rels, fsImpl}) -> [{path, target}] — какие из НАЗВАННЫХ относительных
 * путей внутри `dir` являются ссылками. Три lstat, а не обход дерева: страж стоит перед
 * каждым вызовом инструмента, и обход копии на сотни тысяч файлов он не переживёт.
 */
function linksAt({ dir, rels, fsImpl }) {
  const fs = fsImpl ?? nodeFs
  const out = []
  for (const rel of rels) {
    const abs = resolvePath(dir, ...rel.split('/'))
    let st = null
    try {
      st = fs.lstatSync(abs)
    } catch {
      continue
    }
    if (!st || !st.isSymbolicLink()) continue
    let target = null
    try {
      target = String(fs.readlinkSync(abs))
    } catch {
      /* цель не прочиталась — ссылка от этого не перестала быть ссылкой */
    }
    out.push({ path: rel, target })
  }
  return out
}

/**
 * installTargetOf({command, cwd}) -> {dir, manager, verb} | null — В КАКОЙ КАТАЛОГ
 * целится установка. Части команды проходятся слева направо, `cd X` двигает каталог,
 * `--prefix X` перебивает его для своей части: `cd копия && cd daemon && npm ci` — это
 * ровно тот вид, в котором установка приехала в копию 31.08 в 17:54.
 * @param {{command:string, cwd:string}} opts
 * @returns {{dir:string, manager:string, verb:string}|null}
 */
export function installTargetOf(opts = {}) {
  let dir = String(opts.cwd ?? '') || '.'
  for (const step of commandSteps(opts.command)) {
    const parts = words(step)
    if (!parts.length) continue
    const head = unquote(parts[0])
    if (head === 'cd' && parts.length > 1) {
      dir = resolvePath(dir, unquote(parts[1]))
      continue
    }
    if (!MANAGER_RE.test(head)) continue
    let verb = null
    let prefix = null
    for (let i = 1; i < parts.length; i += 1) {
      const w = unquote(parts[i])
      if (PREFIX_FLAG_RE.test(w) && i + 1 < parts.length) {
        prefix = unquote(parts[i + 1])
        i += 1
        continue
      }
      if (w.startsWith('-')) continue
      if (!verb && INSTALL_VERB_RE.test(w)) verb = w.toLowerCase()
      else if (!verb) break // первый не-флаг — не наш глагол: `npm run …`, `npm exec …`
    }
    if (!verb) continue
    return { dir: prefix ? resolvePath(dir, prefix) : dir, manager: head.toLowerCase(), verb }
  }
  return null
}

/**
 * installRefusal({command, cwd, fsImpl, platform}) -> {refuse, reason?, dir?, target?}.
 *
 * ОТКАЗ ВЫНОСИТСЯ ПО ФАКТУ, А НЕ ПО ИМЕНИ КАТАЛОГА. Установка запрещена не «в копии» —
 * копия ни при чём, — а там, где `node_modules` есть ссылка НАРУЖУ: именно тогда запись
 * уходит в чужое дерево. Свой настоящий каталог зависимостей в копии (кто-то уже снял
 * ссылку) — это его дело и его каталог, и отказывать в нём не за что.
 * @param {{command:string, cwd:string, fsImpl?:object, platform?:string}} opts
 * @returns {{refuse:boolean, reason?:string, dir?:string, target?:string|null, verb?:string}}
 */
export function installRefusal(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const platform = opts.platform ?? process.platform
  const hit = installTargetOf({ command: opts.command, cwd: opts.cwd })
  if (!hit) return { refuse: false }

  const depsPath = joinPath(hit.dir, 'node_modules')
  let st = null
  try {
    st = fs.lstatSync(depsPath)
  } catch {
    return { refuse: false } // каталога ещё нет — менеджер создаст свой, сквозь нечего идти
  }
  if (!st || !st.isSymbolicLink()) return { refuse: false }

  let target = null
  try {
    target = String(fs.readlinkSync(depsPath))
  } catch {
    /* нечитаемая цель — тем более не место для установки */
  }
  if (target && isInside(hit.dir, target, platform)) return { refuse: false }

  return {
    refuse: true,
    dir: hit.dir,
    target,
    verb: `${hit.manager} ${hit.verb}`,
    reason:
      `установка отменена: «${hit.manager} ${hit.verb}» целится в ${hit.dir}, где node_modules — ССЫЛКА` +
      `${target ? ` на ${target}` : ''}. Пакетный менеджер пойдёт по ссылке и перепишет склад зависимостей ЧУЖОГО ` +
      'дерева — того, в котором человек сейчас работает (измерено 31.08.2026). Нужна новая зависимость — назовите ' +
      'её словами в записке о подходе; нужен свой склад в этой копии — сначала снимите ссылку (`rm node_modules` ' +
      'снимает саму ссылку, цель не трогает), и ставьте в свой каталог.',
  }
}

/**
 * copyRemovalTargetsOf({command, cwd}) -> [абсолютные пути] — какие каталоги эта команда
 * собирается снести целиком. Разбираются две формы, которыми копию убирают руками:
 * `git worktree remove [флаги] <путь>` и рекурсивное удаление (`rm -rf <путь>`,
 * `Remove-Item <путь> -Recurse`). Всё остальное сюда не относится.
 * @param {{command:string, cwd:string}} opts
 * @returns {string[]}
 */
export function copyRemovalTargetsOf(opts = {}) {
  const out = []
  let dir = String(opts.cwd ?? '') || '.'
  const push = (raw) => {
    const p = unquote(raw)
    if (!p || p.startsWith('-')) return
    const abs = resolvePath(dir, p)
    if (!out.includes(abs)) out.push(abs)
  }
  for (const step of commandSteps(opts.command)) {
    const parts = words(step)
    if (!parts.length) continue
    const head = unquote(parts[0])
    if (head === 'cd' && parts.length > 1) {
      dir = resolvePath(dir, unquote(parts[1]))
      continue
    }
    if (head === 'git') {
      const wt = parts.findIndex((w) => unquote(w) === 'worktree')
      const rm = parts.findIndex((w) => unquote(w) === 'remove')
      if (wt > 0 && rm === wt + 1) for (const w of parts.slice(rm + 1)) push(w)
      continue
    }
    if (head === 'rm' && parts.slice(1).some((w) => /^-[a-z]*r/i.test(unquote(w)))) {
      for (const w of parts.slice(1)) push(w)
      continue
    }
    if (/^Remove-Item$/i.test(head) && parts.some((w) => /^-Recurse$/i.test(unquote(w)))) {
      for (const w of parts.slice(1)) push(w)
    }
  }
  return out
}

/**
 * copyRemovalRefusal({command, cwd, root, fsImpl, platform}) -> {refuse, reason?, path?, links?}.
 *
 * ЭТО ТОТ САМЫЙ ОТКАЗ, КОТОРОГО НЕ БЫЛО 31.08 В 17:27:58. Сырой `git worktree remove`
 * на копии со ссылками внутри опустошает каталоги-цели в основном дереве — измерено
 * дважды на настоящем git и подтверждено меткой времени каталога. Верб проекта делает то
 * же самое безопасно: сначала снимает ссылки, потом отдаёт копию git. Поэтому отказ не
 * запрещает уборку — он называет руку, которой её делают.
 * @param {{command:string, cwd:string, root?:string, fsImpl?:object, platform?:string}} opts
 * @returns {{refuse:boolean, reason?:string, path?:string, links?:Array}}
 */
export function copyRemovalRefusal(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  // СНАЧАЛА РАЗБОР КОМАНДЫ, ПОТОМ ДИСК. Этот вопрос задаётся перед КАЖДЫМ вызовом Bash — и в
  // потоке `sma pre`, и в гейте работника, — а уборка копии встречается раз в сотни команд.
  // Спрашивать файловую систему до того, как в команде нашлось что убирать, значит платить
  // разведкой подпроектов за каждый `git status`.
  const targets = copyRemovalTargetsOf({ command: opts.command, cwd: opts.cwd })
  if (!targets.length) return { refuse: false }
  const root = opts.root ?? opts.cwd
  // `discover:true` по той же причине, что и в linkedDepsOf: чаще всего об уборке спрашивают
  // ИЗ копии, а `.sma/` в копию не переносится — без разведки виден был бы только корневой
  // склад, и `daemon/node_modules`, опустевший 31.08, не попал бы в вопрос вовсе.
  const rels = dependencyDirsOf({ root, fsImpl: fs, discover: true })
  if (!rels.length) return { refuse: false }
  for (const target of targets) {
    const links = linksAt({ dir: target, rels, fsImpl: fs })
    if (!links.length) continue
    const named = links.map((l) => `${l.path}${l.target ? ` → ${l.target}` : ''}`).join(', ')
    return {
      refuse: true,
      path: target,
      links,
      reason:
        `уборка отменена: в ${target} ещё висят ссылки на склад зависимостей (${named}). ` +
        'Сырое удаление идёт ПО ссылке и опустошает каталог-цель в основном дереве — так 31.08.2026 в 19:28 ' +
        'опустел daemon/node_modules человека. Убирайте копию вербом проекта: ' +
        `node scripts/sma/cli.mjs worktree remove ${target} --force --delete-branch — он снимает ссылки ПЕРВЫМ ` +
        'делом и отказывается продолжать, пока хоть одна цела.',
    }
  }
  return { refuse: false }
}

/** Объявленные зависимости одного package.json — прод и разработка вместе. */
function declaredDepsOf(fs, projectDir) {
  let raw
  try {
    raw = String(fs.readFileSync(joinPath(projectDir, 'package.json'), 'utf8'))
  } catch {
    return null // проекта здесь нет — и спрашивать не о чем
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // сломанный package.json — это не «среда сломана», это чужая беда
  }
  const names = []
  for (const key of ['dependencies', 'devDependencies']) {
    const block = parsed && parsed[key]
    if (!block || typeof block !== 'object') continue
    for (const name of Object.keys(block)) if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * engineFault(fs, projectDir, label) — ДВИЖОК ТЕСТОВ ОБЪЯВЛЕН, НО ЗАПУСКАТЬ ЕГО НЕЧЕМ.
 *
 * Перекличка объявленных зависимостей отвечает на вопрос «папка на месте?», а гейту слияния
 * нужен другой: «этот прогон вообще запустится?». 31.08.2026 разница была видна глазами — в
 * складе осталось 39 записей из сотен, каталога `.bin` не было вовсе, и `vitest` не находился
 * КОМАНДОЙ. Молчание стража в таком дереве дороже ложной тревоги: прогон не состоится, а
 * несостоявшийся прогон, принятый за приговор, ошибается в обе стороны — сегодня отказывает
 * здоровой работе, завтра пропускает непроверенную.
 *
 * Спрашивается ровно то, что нужно запуску: манифест движка читается и называет файл запуска,
 * а файл лежит на диске. Ни версии, ни целостности содержимого — страж, проверяющий всё
 * подряд, однажды объявит сломанной здоровую машину, и его выключат целиком.
 * @returns {(string|null)} причина словами — или null, если запускать есть чем
 */
function engineFault(fs, projectDir, label) {
  const engineRel = normalizeRel(joinPath(label, 'node_modules', TEST_ENGINE))
  const engineDir = joinPath(projectDir, 'node_modules', TEST_ENGINE)
  let manifest
  try {
    manifest = JSON.parse(String(fs.readFileSync(joinPath(engineDir, 'package.json'), 'utf8')))
  } catch {
    return `движок тестов ${TEST_ENGINE} не читается: нет ${engineRel}/package.json`
  }
  const bin = manifest && manifest.bin
  const entry = typeof bin === 'string' ? bin : bin && bin[TEST_ENGINE]
  if (!entry) return `движок тестов ${TEST_ENGINE} не объявляет файла запуска`
  try {
    fs.statSync(joinPath(engineDir, ...String(entry).split('/')))
  } catch {
    return `движок тестов ${TEST_ENGINE} не запускается: нет файла запуска ${engineRel}/${normalizeRel(entry).replace(/^\.\//, '')}`
  }
  return null
}

/** Первая ВИСЯЧАЯ ссылка среди записей каталога (сама ссылка есть, цели нет). */
function firstDangling(fs, dir) {
  let items
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let seen = 0
  for (const it of items) {
    if (seen >= DANGLING_SCAN_CAP) break
    seen += 1
    if (!it.isSymbolicLink || !it.isSymbolicLink()) continue
    const abs = joinPath(dir, it.name)
    try {
      fs.statSync(abs) // ПРОХОДИТ по ссылке: висячая здесь и отвалится
    } catch {
      let target = null
      try {
        target = String(fs.readlinkSync(abs))
      } catch {
        /* без цели — всё равно висячая */
      }
      return { name: it.name, target }
    }
  }
  return null
}

/**
 * checkEnvironmentFitness({root, fsImpl}) -> {fit, reason, broken}.
 *
 * ГОДИТСЯ ЛИ ДЕРЕВО, ЧТОБЫ ЗАПУСКАТЬ В НЁМ ТЕСТЫ. Вопрос задаётся ровно теми четырьмя
 * способами, которыми среда ломалась 31.08, и ни одним больше — страж, который проверяет
 * всё подряд, однажды объявит сломанной здоровую машину и его выключат:
 *   1. каталог зависимостей проекта, который что-то объявил, ОТСУТСТВУЕТ или пуст;
 *   2. объявленная зависимость не разрешается (пропала папка, висит битая ссылка);
 *   3. ДВИЖОК ТЕСТОВ не запускается: папка на месте, а файла запуска нет — ровно то, что
 *      было видно глазами («каталога `.bin` не было вовсе, vitest не находился командой»),
 *      и то, чего перекличка папок сама по себе не ловит;
 *   4. среди записей каталога есть ВИСЯЧАЯ ссылка — след разорванного склада pnpm,
 *      из-за которого 31.08 vitest не поднимался ни в одном дереве.
 * Проекты берутся из манифеста ссылок: `daemon/node_modules` в нём — это и есть заявление
 * проекта «у меня в daemon свой склад».
 *
 * Причина отказа несёт КОМАНДУ восстановления (`ENV_RESTORE_HINT`), а не только диагноз:
 * человек у окна не обязан знать, каким менеджером собран этот продукт.
 *
 * Ответ — ДАННЫЕ, а не исключение: гейт слияния должен уметь сказать «среда сломана» и
 * продолжить жить. Любая внутренняя ошибка читается как «годится» (fail-open): страж,
 * который от собственной поломки останавливает все слияния, хуже отсутствующего.
 * @param {{root:string, fsImpl?:object}} opts
 * @returns {{fit:boolean, reason:(string|null), broken:Array<{project:string, why:string}>}}
 */
export function checkEnvironmentFitness(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const root = opts.root
  const broken = []
  try {
    const projects = []
    for (const rel of dependencyDirsOf({ root, fsImpl: fs, discover: true })) {
      const projectRel = normalizeRel(rel.replace(/(^|\/)node_modules$/, ''))
      if (!projects.includes(projectRel)) projects.push(projectRel)
    }
    if (!projects.length) projects.push('')

    for (const projectRel of projects) {
      const projectDir = projectRel ? resolvePath(root, ...projectRel.split('/')) : resolvePath(root)
      const label = projectRel || '.'
      const declared = declaredDepsOf(fs, projectDir)
      if (declared === null || !declared.length) continue

      const depsDir = joinPath(projectDir, 'node_modules')
      let entries = null
      try {
        entries = fs.readdirSync(depsDir)
      } catch {
        broken.push({ project: label, why: `нет каталога зависимостей ${normalizeRel(joinPath(label, 'node_modules'))}` })
        continue
      }
      if (!entries.length) {
        broken.push({ project: label, why: `каталог зависимостей ${normalizeRel(joinPath(label, 'node_modules'))} ПУСТ` })
        continue
      }

      let missing = null
      for (const name of declared) {
        try {
          fs.statSync(joinPath(depsDir, ...name.split('/')))
        } catch {
          missing = name
          break
        }
      }
      if (missing) {
        broken.push({ project: label, why: `не разрешается объявленная зависимость ${missing}` })
        continue
      }

      // ЗАПУСТИТСЯ ЛИ ПРОГОН — спрашивается только у того, кто движок ОБЪЯВИЛ. Проект без
      // движка тестов не сломан, он просто другой, и отказывать ему было бы ложной тревогой.
      if (declared.includes(TEST_ENGINE)) {
        const fault = engineFault(fs, projectDir, label)
        if (fault) {
          broken.push({ project: label, why: fault })
          continue
        }
      }

      const dangling = firstDangling(fs, depsDir)
      if (dangling) {
        broken.push({
          project: label,
          why: `висячая ссылка ${dangling.name}${dangling.target ? ` → ${dangling.target}` : ''}`,
        })
      }
    }
  } catch {
    return { fit: true, reason: null, broken: [] } // fail-open: собственная поломка не останавливает работу
  }

  if (!broken.length) return { fit: true, reason: null, broken: [] }
  const first = broken[0]
  return {
    fit: false,
    broken,
    reason:
      `${ENV_BROKEN_PREFIX}: ${first.project} — ${first.why}` +
      (broken.length > 1 ? ` (и ещё ${broken.length - 1})` : '') +
      '. Это НЕ красные тесты: прогону не на чем запуститься. Восстановите зависимости из локфайла в ОСНОВНОМ ' +
      `дереве (${ENV_RESTORE_HINT}) и повторите.`,
  }
}
