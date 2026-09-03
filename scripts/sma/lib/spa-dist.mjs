/**
 * spa-dist.mjs — РАЗДАЧА ОКНА КАК ОТДЕЛЬНАЯ ВЕЩЬ: каталог, который демон отдаёт в браузер, и
 * три операции над ним, которые обязаны быть целыми.
 *
 * ═══════════════════════ ЧТО БЫЛО НЕ ТАК ═══════════════════════════════════════
 *
 * Окно собиралось ПРЯМО В РАЗДАЧУ. Сборщик начинает с того, что стирает выходной каталог
 * дочиста (`emptyOutDir`), и только потом пишет туда новый бандл. Между этими двумя
 * событиями раздачи не существует вовсе, а если сборка упала посередине — не существует и
 * дальше: каталог остаётся пустым. Дальше беда идёт молча и на трёх этажах сразу:
 *
 *   — человек в браузере получает не «старое окно», а НИЧЕГО;
 *   — гейт свежести раздачи в этом случае честно уходит в «неприменимо» (сравнивать не с
 *     чем — ни одного файла), то есть молчит ровно там, где хуже всего;
 *   — отказ двери называется «сборка окна не прошла» и ни словом не говорит, что заодно
 *     снесена раздача, которая до нажатия кнопки работала.
 *
 * Вторая половина той же беды — ОТКАЗАННАЯ ПОСАДКА. Дверь пересобирает окно на сведённом
 * дереве ДО прогона. Прогон краснеет, `merge --abort` возвращает `spa/src` к вершине — а
 * раздача гитом не отслеживается вовсе, и откат её не касается. На диске остаётся окно,
 * собранное из ОТКАЗАННОЙ ветки: демон показывает человеку то, чего на вершине нет, и ни
 * один сторож этого не видит (исходник чист, раздача новее исходника — всё «свежо»).
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ РЕШЕНО ══════════════════════════════════════
 *
 *   1. `stageSpaBuild` — сборка идёт во ВРЕМЕННЫЙ каталог рядом с раздачей, и раздача
 *      подменяется только тогда, когда сборка ЗАКОНЧИЛАСЬ УСПЕХОМ и что-то произвела.
 *      Упавшая сборка не трогает раздачу ни одним байтом: стирать нечего, потому что
 *      стирался временный каталог, а не она.
 *
 *   2. `keepDist` / `restoreDist` / `dropKept` — прежняя раздача, отложенная НА ВРЕМЯ
 *      ВЕРДИКТА. Посадка кладёт копию рядом перед сборкой и возвращает её, если ветка не
 *      вошла; вошла — копия убирается. Возврат выбран вместо второй сборки намеренно:
 *      сборка после отката — это ещё одно место, где можно упасть, и упасть там значит
 *      оставить человека вовсе без окна ради того, чтобы вернуть ему прежнее.
 *
 * ПОЧЕМУ ВРЕМЕННЫЙ КАТАЛОГ — СОСЕД РАЗДАЧИ, А НЕ `os.tmpdir()`. Подмена делается
 * переименованием, а переименование целого каталога атомарно только внутри одного тома;
 * системный временный каталог живёт на другом томе сплошь и рядом, и там «подмена»
 * выродилась бы в копирование с теми же дырами, ради закрытия которых всё это написано.
 *
 * ПОЧЕМУ ВЫХОДНОЙ КАТАЛОГ СБОРЩИКА ЗАДАЁТСЯ ПЕРЕМЕННОЙ ОКРУЖЕНИЯ. Команда сборки обязана
 * остаться ТОЙ ЖЕ, которую человек набирает руками; менять её ради постановки — значит
 * собирать окно не тем, чем его собирают. Настройка сборщика читает переменную и без неё
 * пишет ровно туда, куда писала всегда.
 *
 * Только встроенное в Node; запуск сборщика и файловый ввод-вывод — швы, чтобы прогон мог
 * проверить обе развилки, не поднимая настоящего сборщика.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Куда демон смотрит за окном. Одно место, названное один раз на весь продукт. */
export const SPA_DIST_REL = 'daemon/static/app'

/** Настоящая команда сборки окна — та, что стоит в `spa/package.json`. */
export const SPA_INNER_BUILD_ARGS = Object.freeze(['--prefix', 'spa', 'run', 'build'])

/** Чем сборщику говорят, куда писать. Читается настройкой сборщика; без неё — как раньше. */
export const SPA_OUT_DIR_ENV = 'SMA_SPA_OUT_DIR'

/** Куда сборщик пишет, когда никто ничего не назвал, — путь ОТ КАТАЛОГА ОКНА (`spa/`). */
export const SPA_DEFAULT_OUT_DIR = '../daemon/static/app'

/**
 * spaOutDir(env) — выходной каталог сборщика окна. ОДНО определение на весь продукт: его
 * читает настройка сборщика (`spa/vite.config.ts`) и им же пользуется постановка ниже, и
 * разойтись этим двоим негде — разошедшись, они собрали бы окно мимо подмены, то есть прямо
 * в живую раздачу, ради обхода которой всё и написано.
 */
export function spaOutDir(env = process.env) {
  const said = env && env[SPA_OUT_DIR_ENV]
  return typeof said === 'string' && said.trim() ? said : SPA_DEFAULT_OUT_DIR
}

/**
 * Имена соседей раздачи. Все три начинаются с точки и с `app-`, потому что гитом они
 * игнорируются одним правилом, а человек, увидевший их в `daemon/static`, обязан понять
 * без подсказки, чьи они и что с ними случилось.
 */
export const STAGE_PREFIX = '.app-build-'
export const KEPT_PREFIX = '.app-kept-'
export const DISPLACED_PREFIX = '.app-displaced-'

/** Слова, которыми раздача отчитывается о себе. Ни одно из них не выдаёт молчание за факт. */
export const DIST_UNTOUCHED_NOTE = 'раздача окна не тронута — прежнее окно осталось на диске'
export const DIST_RESTORED_NOTE =
  'раздача окна возвращена к прежней — собранное отказанной веткой на диске не осталось'
export const DIST_NOTHING_KEPT_NOTE = 'прежней раздачи рядом не было — возвращать нечего'
export const EMPTY_BUILD_NOTE =
  'сборщик закончил успехом, но не произвёл ни одного файла — раздача не тронута'

/**
 * Файловый ввод-вывод одним объектом — шов для прогона, значение по умолчанию для жизни.
 *
 * ЭКСПОРТИРОВАН РАДИ ПРОГОНА, И ЭТО НЕ ПОБЛАЖКА. Случаи, где ломается ОДНО переименование из
 * трёх, проверяются на настоящих файлах с одним подменённым движением: собранный в прогоне
 * поддельный набор проверял бы подделку, а не откат.
 */
export function defaultFs() {
  return {
    exists: existsSync,
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    readdir: (p) => readdirSync(p),
    rename: (from, to) => renameSync(from, to),
    copy: (from, to) => cpSync(from, to, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
  }
}

/** Метка, по которой два соседних каталога не сталкиваются именами. */
function suffix(clock) {
  const at = new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString().replace(/[:.]/g, '-')
  return `${at}-${process.pid}`
}

/** Есть ли в каталоге хоть один файл. Пустая «успешная» сборка — не повод стирать раздачу. */
function producedSomething(fs, dir) {
  try {
    return fs.readdir(dir).length > 0
  } catch {
    return false
  }
}

/**
 * ПОДМЕНА РАЗДАЧИ — ДВА ПЕРЕИМЕНОВАНИЯ И ОТКАТ МЕЖДУ НИМИ.
 *
 * Прежняя раздача сперва уходит в сторону под своим именем, новая встаёт на её место, и
 * только после этого отложенное убирается. Если второе переименование не прошло (на Windows
 * это обычное дело: кто-то читает файл, который мы двигаем) — отложенное возвращается на
 * место, и раздача остаётся ТОЙ ЖЕ, что была до вызова. Никакого промежуточного состояния,
 * в котором окна нет, наружу не видно дольше двух переименований.
 *
 * @returns {{swapped:boolean, note?:string}}
 */
export function swapIntoPlace({ dist, stage, fs, clock } = {}) {
  const io = fs || defaultFs()
  if (!io.exists(dist)) {
    try {
      io.mkdir(dirname(dist))
      io.rename(stage, dist)
      return { swapped: true }
    } catch (err) {
      return { swapped: false, note: `раздачу окна поставить на место не удалось (${String((err && err.message) || err)})` }
    }
  }
  const displaced = join(dirname(dist), `${DISPLACED_PREFIX}${suffix(clock)}`)
  try {
    io.rename(dist, displaced)
  } catch (err) {
    return { swapped: false, note: `прежнюю раздачу сдвинуть не удалось (${String((err && err.message) || err)})` }
  }
  try {
    io.rename(stage, dist)
  } catch (err) {
    // ОТКАТ. Раздача важнее новой сборки: лучше прежнее окно, чем никакого.
    try {
      io.rename(displaced, dist)
    } catch {
      /* и это не прошло — сказать об этом честнее, чем промолчать: см. note ниже */
    }
    return { swapped: false, note: `новую раздачу поставить на место не удалось (${String((err && err.message) || err)})` }
  }
  try {
    io.remove(displaced)
  } catch {
    /* отложенное не убралось — это мусор, а не поломка подмены */
  }
  return { swapped: true }
}

/** Соседи раздачи, оставшиеся от процессов, которых уже нет. Посадка сериализована слотом
 *  слияния, поэтому ЛЮБОЙ такой каталог на входе — сирота, а не чужая живая работа. */
function sweepOrphans(fs, staticDir, prefixes) {
  let swept = 0
  let names = []
  try {
    names = fs.readdir(staticDir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!prefixes.some((p) => String(name).startsWith(p))) continue
    try {
      fs.remove(join(staticDir, name))
      swept += 1
    } catch {
      /* чужой замок на каталоге — не повод ронять сборку */
    }
  }
  return swept
}

/** Настоящий запуск сборщика: тот же `npm`, что набирает человек, с выводом в наш поток. */
function defaultRun({ cwd, env }) {
  const shell = process.platform === 'win32'
  const npm = shell ? 'npm.cmd' : 'npm'
  const res = spawnSync(shell ? `${npm} ${SPA_INNER_BUILD_ARGS.join(' ')}` : npm, shell ? [] : [...SPA_INNER_BUILD_ARGS], {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell,
  })
  if (res.error) return { ok: false, exitCode: null, note: String(res.error.message || res.error) }
  return { ok: res.status === 0, exitCode: Number.isFinite(res.status) ? res.status : null }
}

/**
 * stageSpaBuild({root, run, fs, clock}) → `{built, distTouched, exitCode, stage, note?, swept?}`.
 *
 * Успех — это ДВА условия, а не одно: сборщик вышел нулём И что-то произвёл. Успешный
 * сборщик с пустым выходом однажды случится (настройка, отрезавшая вход; плагин, съевший
 * все файлы), и подменить им живую раздачу значило бы стереть окно «по правилам».
 */
export function stageSpaBuild(o = {}) {
  const root = o.root || process.cwd()
  const fs = o.fs || defaultFs()
  const run = typeof o.run === 'function' ? o.run : defaultRun
  const dist = join(root, ...SPA_DIST_REL.split('/'))
  const staticDir = dirname(dist)

  // ЗДЕСЬ ПОДМЕТАЮТСЯ ДВА ИМЕНИ ИЗ ТРЁХ, И ТРЕТЬЕ ПРОПУЩЕНО НАМЕРЕННО. `KEPT_PREFIX` — это
  // отложенная посадкой прежняя раздача, и постановка бежит ВНУТРИ той самой посадки, которая
  // её только что положила (сборка — её ребёнок). Подмети мы её здесь — страховка исчезала бы
  // ровно в тот момент, ради которого её и клали, и красный прогон возвращать было бы нечего.
  // Отложенные сироты подметает `keepDist`: там любая такая копия заведомо мертва.
  const swept = sweepOrphans(fs, staticDir, [STAGE_PREFIX, DISPLACED_PREFIX])
  const stage = join(staticDir, `${STAGE_PREFIX}${suffix(o.clock)}`)
  try {
    fs.mkdir(stage)
  } catch (err) {
    return {
      built: false,
      distTouched: false,
      exitCode: null,
      stage: null,
      swept,
      note: `${DIST_UNTOUCHED_NOTE}; поставить сборку было некуда (${String((err && err.message) || err)})`,
    }
  }

  const outcome = run({ cwd: root, env: { ...process.env, [SPA_OUT_DIR_ENV]: stage } }) || {}
  if (outcome.ok !== true) {
    try {
      fs.remove(stage)
    } catch {
      /* временный каталог переживёт нас — раздачи это не касается */
    }
    return {
      built: false,
      distTouched: false,
      exitCode: Number.isFinite(outcome.exitCode) ? outcome.exitCode : null,
      stage: null,
      swept,
      note: outcome.note ? `${DIST_UNTOUCHED_NOTE}; ${outcome.note}` : DIST_UNTOUCHED_NOTE,
    }
  }
  if (!producedSomething(fs, stage)) {
    try {
      fs.remove(stage)
    } catch {
      /* см. выше */
    }
    return { built: false, distTouched: false, exitCode: 0, stage: null, swept, note: EMPTY_BUILD_NOTE }
  }

  const put = swapIntoPlace({ dist, stage, fs, clock: o.clock })
  if (!put.swapped) {
    try {
      fs.remove(stage)
    } catch {
      /* см. выше */
    }
    return { built: false, distTouched: false, exitCode: 0, stage: null, swept, note: `${DIST_UNTOUCHED_NOTE}; ${put.note}` }
  }
  return { built: true, distTouched: true, exitCode: 0, stage, swept }
}

/**
 * keepDist({root, fs, clock}) → `{kept}` | `{keepNote}` — ПРЕЖНЯЯ РАЗДАЧА, ОТЛОЖЕННАЯ РЯДОМ.
 *
 * Копия, а не переименование: пока идёт сборка, демон продолжает отдавать окно, и вынимать
 * его из-под живого читателя ради страховки — плохой обмен.
 *
 * …И ИМЕННО ЗДЕСЬ ПОДМЕТАЮТСЯ ЧУЖИЕ ОТЛОЖЕННЫЕ КОПИИ. Посадка сериализована слотом слияния:
 * в ту секунду, когда одна из них собирается отложить свою копию, живой второй быть не может,
 * а лежащая на диске осталась от посадки, которую сняли между сборкой и вердиктом. Вернуть её
 * больше некому — это полмегабайта, которые иначе копились бы по копии на каждую снятую
 * посадку. Подметать их СБОРКОЙ (`stageSpaBuild`) нельзя: она бежит внутри посадки, чью копию
 * и снесла бы, — см. её собственную оговорку.
 */
export function keepDist({ root, fs, clock } = {}) {
  const io = fs || defaultFs()
  const dist = join(root || process.cwd(), ...SPA_DIST_REL.split('/'))
  const swept = sweepOrphans(io, dirname(dist), [KEPT_PREFIX])
  if (!io.exists(dist)) return { keepNote: DIST_NOTHING_KEPT_NOTE, ...(swept ? { swept } : {}) }
  const kept = join(dirname(dist), `${KEPT_PREFIX}${suffix(clock)}`)
  try {
    io.copy(dist, kept)
    return { kept, ...(swept ? { swept } : {}) }
  } catch (err) {
    return {
      keepNote: `прежнюю раздачу отложить не удалось (${String((err && err.message) || err)})`,
      ...(swept ? { swept } : {}),
    }
  }
}

/**
 * restoreDist({root, kept, fs, clock}) → `{restored, note}` — ВЕРНУТЬ ОТЛОЖЕННОЕ НА МЕСТО.
 * Той же подменой, что и у сборки: раздача либо прежняя, либо новая, но никогда не пустая.
 */
export function restoreDist({ root, kept, fs, clock } = {}) {
  const io = fs || defaultFs()
  if (!kept || !io.exists(kept)) return { restored: false, note: DIST_NOTHING_KEPT_NOTE }
  const dist = join(root || process.cwd(), ...SPA_DIST_REL.split('/'))
  const put = swapIntoPlace({ dist, stage: kept, fs: io, clock })
  if (!put.swapped) {
    try {
      io.remove(kept)
    } catch {
      /* см. ниже */
    }
    return { restored: false, note: put.note || 'раздачу окна вернуть не удалось' }
  }
  return { restored: true, note: DIST_RESTORED_NOTE }
}

/** dropKept({kept, fs}) — отложенное больше не нужно: ветка вошла, раздача правильная. */
export function dropKept({ kept, fs } = {}) {
  if (!kept) return false
  const io = fs || defaultFs()
  try {
    io.remove(kept)
    return true
  } catch {
    return false
  }
}

// ── прямой запуск (`node scripts/sma/lib/spa-dist.mjs`) — это и есть `npm run build:spa` ──
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const res = stageSpaBuild({ root })
  if (res.note) process.stdout.write(`build:spa: ${res.note}\n`)
  process.exit(res.built ? 0 : res.exitCode === null || res.exitCode === 0 ? 1 : res.exitCode)
}
