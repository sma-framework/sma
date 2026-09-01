/**
 * store-journal.mjs — ВАХТА НА СКЛАДЕ ЗАВИСИМОСТЕЙ: КТО ПРИКАСАЛСЯ, КОГДА, ЧЕМ.
 *
 * ═══════════════ ЗАЧЕМ ОНА, ЕСЛИ СТРАЖ УЖЕ СТОИТ ════════════════════════════════
 * `deps-guard.mjs` закрыл ДВА НАЗВАННЫХ пути к складу человека — сырую уборку копии со
 * живыми ссылками и установку сквозь ссылку наружу. Оба отказа судят по факту и работают.
 * Но 01.09.2026 склад опустел В ЧЕТВЁРТЫЙ РАЗ за двое суток, и ни один из двух отказов не
 * сработал: потрошил кто-то третий, чьё имя мы не знаем.
 *
 * ЧТО ИЗМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО (леджер попытки SB-203#1, времена UTC):
 *   • 10:09:52.482 из копии `wt-SB-203` пошёл `npx vitest run …` и ответил
 *     «'vitest' is not recognized» — то есть `node_modules/.bin` уже не было;
 *   • 10:10:11.983 `ls node_modules/.bin` в копии — «No such file or directory»;
 *   • 10:10:32.239 то же самое в ОСНОВНОМ дереве человека — каталога `.bin` нет;
 *   • 10:11:03.238 vitest падает `ERR_MODULE_NOT_FOUND: @jridgewell/sourcemap-codec`
 *     из `…/node_modules/.pnpm/magic-string@0.30.21/…`;
 *   • 10:11:15.490 в складе `.pnpm` есть `magic-string@0.30.21` и НЕТ
 *     `@jridgewell+sourcemap-codec@1.5.5`.
 * Пропали ровно ДВЕ записи, и обе — ПЕРВЫЕ в своём каталоге по порядку NTFS: `.bin` в
 * `node_modules`, `@jridgewell+…` в `.pnpm`. Это подпись рекурсивного удаления, которое
 * вошло в склад ПО ССЫЛКЕ и оборвалось на второй записи, а не подпись пакетного менеджера:
 * ни npm, ни pnpm не оставляют дерево согласованным-минус-одну-случайную-папку.
 *
 * ЧЕГО НЕ ХВАТИЛО, ЧТОБЫ НАЗВАТЬ РУКУ. Всё перечисленное — следы ПОСЛЕ. Ни один журнал
 * этого продукта не отвечал на вопрос «что шло в ту минуту, когда запись исчезла»: события
 * копятся по сессиям и попыткам, а склад — общий, и опустошает его тот, кого в своей
 * сессии не видно. Поэтому здесь заводится журнал самого СКЛАДА, а не сессии.
 *
 * ═══════════════ КАК ЭТО РАБОТАЕТ, ОДНИМ АБЗАЦЕМ ════════════════════════════════
 * Перед КАЖДЫМ вызовом Bash (гейт работника) и на каждом ходе терминала (`sma pre`)
 * снимается перепись склада: имена записей `node_modules` и `node_modules/.pnpm`. Перепись
 * сравнивается с предыдущей. Совпала — не пишется НИЧЕГО, кроме крошечной отметки «видел
 * целым, вот кто и когда». Разошлась — в журнал уходит одна строка: что пропало, что
 * пришло, КТО СТОИТ ЗДЕСЬ СЕЙЧАС и КТО ВИДЕЛ СКЛАД ЦЕЛЫМ ПОСЛЕДНИМ. Между этими двумя
 * отметками лежит ровно одна команда — она и названа подозреваемой, с процессом и временем.
 *
 * ЖУРНАЛ ЛЕЖИТ У СКЛАДА, А НЕ У ТОГО, КТО СМОТРИТ. Копия работника получает зависимости
 * ссылкой; её `node_modules` — junction в основное дерево. Значит и запись должна уходить
 * в `.sma/deps/` ТОГО дерева, которому склад принадлежит: иначе четыре наблюдателя завели
 * бы четыре журнала, и ни в одном не было бы соседней команды. Владелец вычисляется по
 * самой ссылке (`readlink`), а не по имени каталога.
 *
 * ═══════════════ ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ ═══════════════════════════════════════
 * Ни одного удаления, ни одного запуска, ни одного отказа. Вахта СМОТРИТ и ЗАПИСЫВАЕТ;
 * судят другие (`deps-guard.mjs`), а показывают третьи (`worktree store-log`, поток
 * `sma pre`). Сторож, который сам же и наказывает по своим же записям, не проверяется.
 *
 * ЦЕНА ХОДА НАЗВАНА ЧЕСТНО: два `readdir` одного уровня и запись ~200 байт. Полная
 * перепись имён читается и переписывается ТОЛЬКО когда дешёвый отпечаток разошёлся —
 * иначе вахта, стоящая перед каждым вызовом, стоила бы дороже самих вызовов.
 *
 * Всё fail-open: сломанная вахта не имеет права остановить ни один вызов. Любая внутренняя
 * ошибка — это «ничего не записано», и работа идёт дальше.
 *
 * Node built-ins only. `fsImpl`, `clock`, `platform` инъектируются — файл проверяется и на
 * подделке, и на настоящих ссылках.
 */

import * as nodeFs from 'node:fs'
import { resolve as resolvePath, join as joinPath, dirname as dirnameOf } from 'node:path'

/** Каталог вахты внутри дерева-владельца склада. `.sma/` в этом продукте не отслеживается git. */
export const STORE_DIR_REL = '.sma/deps'

/** Журнал ИЗМЕНЕНИЙ склада — append-only JSONL, одна строка на расхождение переписи. */
export const STORE_JOURNAL_REL = `${STORE_DIR_REL}/store.jsonl`

/** Полная перепись имён. Переписывается только при расхождении отпечатка. */
export const STORE_CENSUS_REL = `${STORE_DIR_REL}/store.census.json`

/** Отметка «склад видели целым»: кто, когда, чем. Переписывается на каждом наблюдении. */
export const STORE_SEEN_REL = `${STORE_DIR_REL}/store.seen.json`

/** Уровни, которые переписываются. Глубже вахта не идёт: склад теряется записями, не файлами. */
const CENSUS_LEVELS = ['node_modules', 'node_modules/.pnpm']

/**
 * Записи, которые живут и умирают сами по себе. Кэш сборщика (`.vite`, `.vite-temp`)
 * создаётся и сносится на каждом прогоне тестов — вахта, считающая это пропажей, за сутки
 * напишет тысячу строк и утопит в них ту единственную, ради которой заведена.
 */
const VOLATILE_RE = /^\.(vite|cache|staging|tmp|package-lock\.json)/

/** Сколько записей одного уровня переписывается. Склад больше этого — беда другого рода. */
const CENSUS_CAP = 50000

/** Сколько строк журнала читается за раз. */
const JOURNAL_READ_CAP = 5000

/** Прямые слэши, без хвостового разделителя — одна форма пути на весь модуль. */
function normalizePath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * FNV-1a по объединённым именам — дешёвый отпечаток переписи. Криптографии здесь не нужно:
 * отпечаток отвечает на один вопрос — «изменилось ли», — и цена ответа важнее его стойкости,
 * потому что спрашивают перед каждым вызовом инструмента.
 */
function digestOf(names) {
  let h = 0x811c9dc5
  const s = names.join('\n')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}:${names.length}`
}

/**
 * storeOwnerOf({cwd, fsImpl, platform}) -> {root, viaLink, link} | null
 *
 * ЧЕЙ СКЛАД ИСПОЛЬЗУЕТ ЭТОТ КАТАЛОГ. Если `node_modules` здесь — ссылка, владелец
 * находится по ЦЕЛИ ссылки: родитель каталога, на который она указывает. Так все копии,
 * подключённые к одному дереву, пишут в ОДИН журнал — тот, что лежит у склада.
 * Своего `node_modules` нет вовсе — владельца нет, и записывать нечего.
 * @param {{cwd:string, fsImpl?:object, platform?:string}} opts
 * @returns {{root:string, viaLink:boolean, link:(string|null)}|null}
 */
export function storeOwnerOf(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const cwd = String(opts.cwd ?? '')
  if (!cwd) return null
  const deps = resolvePath(cwd, 'node_modules')
  let st = null
  try {
    st = fs.lstatSync(deps)
  } catch {
    return null // склада здесь нет — вахте не над чем стоять
  }
  if (!st) return null
  if (!st.isSymbolicLink()) return { root: normalizePath(resolvePath(cwd)), viaLink: false, link: null }
  let target = null
  try {
    target = String(fs.readlinkSync(deps))
  } catch {
    return null // ссылка есть, а куда — не читается: владельца назвать нечем
  }
  const abs = resolvePath(cwd, target)
  return { root: normalizePath(dirnameOf(abs)), viaLink: true, link: normalizePath(abs) }
}

/**
 * censusStore({root, fsImpl}) -> {names, digest} | null — перепись склада дерева `root`.
 *
 * Имена, а не размеры и не содержимое: пропажа склада — это исчезнувшая ЗАПИСЬ, и вопрос
 * «чего не стало» отвечается списком имён. Каталога нет — вернётся null (склада нет,
 * пропаже неоткуда взяться); пустой склад — это пустой список имён, и это уже событие.
 * @param {{root:string, fsImpl?:object}} opts
 * @returns {{names:string[], digest:string}|null}
 */
export function censusStore(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const root = String(opts.root ?? '')
  if (!root) return null
  const names = []
  let sawAny = false
  for (const level of CENSUS_LEVELS) {
    let items
    try {
      items = fs.readdirSync(resolvePath(root, ...level.split('/')))
    } catch {
      continue // этого уровня в дереве нет — не всякий проект собран pnpm
    }
    sawAny = true
    let seen = 0
    for (const name of items) {
      if (seen >= CENSUS_CAP) break
      seen += 1
      if (level === 'node_modules' && VOLATILE_RE.test(name)) continue
      names.push(`${level}/${name}`)
    }
  }
  if (!sawAny) return null
  names.sort()
  return { names, digest: digestOf(names) }
}

/** Прочитать маленький JSON рядом со складом. Нечитаемый и битый — одинаково «нет». */
function readJsonAt(fs, path) {
  try {
    const parsed = JSON.parse(String(fs.readFileSync(path, 'utf8')))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Записать маленький JSON, заводя каталог. Fail-open: неудача записи — не событие. */
function writeJsonAt(fs, path, value) {
  try {
    fs.mkdirSync(dirnameOf(path), { recursive: true })
    fs.writeFileSync(path, `${JSON.stringify(value)}\n`)
    return true
  } catch {
    return false
  }
}

/** Кто стоит у склада прямо сейчас — в той форме, в какой это попадёт в журнал. */
function observerOf(opts, clock) {
  return {
    ts: new Date(clock()).toISOString(),
    actor: String(opts.actor ?? '') || 'unknown',
    pid: Number.isFinite(opts.pid) ? opts.pid : null,
    cwd: normalizePath(opts.cwd ?? ''),
    command: String(opts.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
  }
}

/**
 * noteStoreAccess({cwd, command, actor, pid, clock, fsImpl}) -> {recorded, owner, gone, came, entry}
 *
 * ОДНО НАБЛЮДЕНИЕ ВАХТЫ. Вызывается ПЕРЕД тем, как команда пойдёт работать, — поэтому
 * перепись описывает склад ДО неё, а не после. Из этого и берётся обвинение: расхождение,
 * увиденное сейчас, случилось между прошлым наблюдением и этим, а в том промежутке шла
 * ровно одна названная команда.
 *
 * Совпала перепись — обновляется только отметка «видел целым» (~200 байт) и возвращается
 * `recorded:false`. Разошлась — переписывается полная перепись и в журнал уходит строка.
 * @param {{cwd:string, command?:string, actor?:string, pid?:number, clock?:Function, fsImpl?:object}} opts
 * @returns {{recorded:boolean, owner:(string|null), gone:string[], came:string[], entry:(object|null)}}
 */
export function noteStoreAccess(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const clock = opts.clock ?? Date.now
  const idle = { recorded: false, owner: null, gone: [], came: [], entry: null }
  try {
    const owner = storeOwnerOf({ cwd: opts.cwd, fsImpl: fs })
    if (!owner) return idle
    const census = censusStore({ root: owner.root, fsImpl: fs })
    if (!census) return idle

    const seenPath = joinPath(owner.root, ...STORE_SEEN_REL.split('/'))
    const previous = readJsonAt(fs, seenPath)
    const observer = observerOf({ ...opts, cwd: opts.cwd }, clock)
    const now = { ...observer, digest: census.digest, owner: owner.root, viaLink: owner.viaLink }

    if (previous && previous.digest === census.digest) {
      writeJsonAt(fs, seenPath, now) // склад тот же — обновляем только «кто видел последним»
      return { ...idle, owner: owner.root }
    }

    const censusPath = joinPath(owner.root, ...STORE_CENSUS_REL.split('/'))
    const before = readJsonAt(fs, censusPath)
    const had = Array.isArray(before && before.names) ? before.names : null
    writeJsonAt(fs, censusPath, { ts: now.ts, digest: census.digest, names: census.names })
    writeJsonAt(fs, seenPath, now)

    // Первая перепись в этом дереве сравнивать не с чем — она БАЗА, а не событие.
    if (!had) return { ...idle, owner: owner.root }

    const nowSet = new Set(census.names)
    const hadSet = new Set(had)
    const gone = had.filter((n) => !nowSet.has(n))
    const came = census.names.filter((n) => !hadSet.has(n))
    if (!gone.length && !came.length) return { ...idle, owner: owner.root }

    const entry = {
      schema: 'sma-store-journal/1',
      ts: now.ts,
      owner: owner.root,
      count: census.names.length,
      gone,
      came,
      seenBy: observer,
      lastIntact: previous
        ? { ts: previous.ts, actor: previous.actor, pid: previous.pid, cwd: previous.cwd, command: previous.command }
        : null,
    }
    try {
      const journalPath = joinPath(owner.root, ...STORE_JOURNAL_REL.split('/'))
      fs.mkdirSync(dirnameOf(journalPath), { recursive: true })
      fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`)
    } catch {
      return { recorded: false, owner: owner.root, gone, came, entry }
    }
    return { recorded: true, owner: owner.root, gone, came, entry }
  } catch {
    return idle // fail-open: сломанная вахта не останавливает ни один вызов
  }
}

/**
 * readStoreJournal({root, fsImpl}) -> {entries, corrupt} — журнал склада дерева `root`.
 * Битая строка пропускается и считается, никогда не бросается: журнал читают там, где
 * уже что-то сломалось, и падать вторым — худшее, что он может сделать.
 * @param {{root:string, fsImpl?:object}} opts
 * @returns {{entries:object[], corrupt:number}}
 */
export function readStoreJournal(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  let raw
  try {
    raw = String(fs.readFileSync(joinPath(String(opts.root ?? ''), ...STORE_JOURNAL_REL.split('/')), 'utf8'))
  } catch {
    return { entries: [], corrupt: 0 }
  }
  const entries = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (entries.length >= JOURNAL_READ_CAP) break
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1
    }
  }
  return { entries, corrupt }
}

/**
 * storeLosses({root, fsImpl}) -> [строки журнала, в которых что-то ПРОПАЛО].
 * Приход записей — обычная установка и никого не интересует; вопрос задачи один:
 * кто потрошил.
 * @param {{root:string, fsImpl?:object}} opts
 * @returns {object[]}
 */
export function storeLosses(opts = {}) {
  return readStoreJournal(opts).entries.filter((e) => Array.isArray(e && e.gone) && e.gone.length > 0)
}

/**
 * blameSentence(entry) -> одна строка, которую читает человек.
 *
 * ОБВИНЯЕТСЯ ПРОМЕЖУТОК, А НЕ ЧЕЛОВЕК. Вахта знает, что склад был цел при одной команде и
 * не цел при следующей; между ними могла пройти и рука, которую вахта не видит вовсе
 * (окно без гейта, установщик, сам git). Поэтому строка называет ИНТЕРВАЛ и команду,
 * которая в нём шла, — и не называет её виновной.
 * @param {object} entry
 * @returns {string}
 */
export function blameSentence(entry) {
  if (!entry || !Array.isArray(entry.gone) || !entry.gone.length) return ''
  const lost = entry.gone.slice(0, 4).join(', ') + (entry.gone.length > 4 ? ` (и ещё ${entry.gone.length - 4})` : '')
  const seen = entry.seenBy || {}
  if (!entry.lastIntact) {
    return `склад ${entry.owner} потерял: ${lost}. Прошлого наблюдения нет — назвать промежуток нечем.`
  }
  const p = entry.lastIntact
  return (
    `склад ${entry.owner} потерял: ${lost}. Целым его видели в ${p.ts} — там стоял «${p.command || '?'}» ` +
    `(${p.actor}, pid ${p.pid ?? '?'}, cwd ${p.cwd}); пропажу увидел в ${seen.ts} «${seen.command || '?'}» ` +
    `(${seen.actor}, pid ${seen.pid ?? '?'}). Потрошили В ЭТОМ промежутке — сама названная команда могла быть ` +
    'и ни при чём, если рядом работала рука без гейта.'
  )
}
