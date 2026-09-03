/**
 * СВЕЖЕСТЬ РАЗДАВАЕМОГО ОКНА — ОДНА ЛИНЕЙКА НА ВЕСЬ ПРОДУКТ.
 *
 * Демон отдаёт окно НЕ из `spa/src`, а из каталога `daemon/static/app` — готового бандла,
 * который кладёт туда `npm run build:spa`. Каталог гитом не отслеживается (полмегабайта
 * минифицированного кода в каждом диффе хуже, чем пересборка), а значит между исходником и
 * тем, что видит человек в браузере, стоит шаг, о котором ничто не напоминает.
 *
 * Здесь живёт ровно ответ на один вопрос: НЕ СТАРШЕ ЛИ РАЗДАЧА СВОЕГО ИСХОДНИКА. Спрашивают
 * его двое, и потому он вынесен сюда, а не оставлен в теле того, кто спросил первым:
 *   — сторож набора (`daemon/__tests__/spa-build-freshness.test.ts`) — краснеет на вершине,
 *     где раздача отстала от `spa/src`;
 *   — посадка (`landing.mjs`) — обновляет метку свежести раздачи после того, как собрала
 *     окно и зафиксировала слияние, и обязана мерить ТОЙ ЖЕ линейкой, которой её потом
 *     измерят. Две линейки в разных файлах разошлись бы молча.
 *
 * ЧАСОВ ЗДЕСЬ НЕТ. Сравнивается время двух деревьев между собой, а не с «сейчас».
 *
 * ЧЕМ МЕРИТЬ ВОЗРАСТ ИСХОДНИКА — двумя разными линейками, и выбор между ними не вкусовой.
 * Файловый mtime честен ровно тогда, когда файл правил человек. В свежеотрезанной рабочей
 * копии его штампует checkout временем «сейчас»: исходники выглядят новее любого бандла, и
 * гейт краснеет там, где `spa` никто не трогал. Поэтому:
 *   — `spa/src` по git чист → возраст исходника берётся у ПОСЛЕДНЕГО КОММИТА, тронувшего
 *     `spa/src` (`git log -1 --format=%ct`). Время коммита checkout не переписывает, и оно
 *     одинаково в любой копии дерева;
 *   — по `spa/src` есть незакоммиченные правки → mtime файлов честны, меряем как раньше.
 * Суть не слабеет: коммит в `spa/src` новее раздачи — такой же красный, как и правка в
 * рабочем дереве. Если git недоступен (распакованный тарбол, не репозиторий) — остаётся
 * файловая линейка: хуже, но не молча.
 *
 * И ИМЕННО ОТСЮДА РАСТЁТ ОБЯЗАННОСТЬ ПОСАДКИ. Коммит слияния, несущий `spa/src`, создаётся
 * ПОСЛЕ того, как посадка собрала окно: сборка идёт на сведённом, ещё не зафиксированном
 * дереве, а фиксация — после зелёного прогона, минутами позже. По коммитной линейке раздача
 * оказывается «старше» собственного исходника на эти минуты — при том что собрана она ровно
 * из него. Красным это становилось не на той посадке, что собирала (её прогон шёл до
 * коммита), а на СЛЕДУЮЩЕЙ, которая окна не трогала и пересобирать его не собиралась.
 * Поэтому посадка, собравшая окно, после фиксации обновляет метку свежести раздачи: дерево
 * то же самое, бандл тот же самый, меняется только то, что линейка о нём говорит.
 *
 * Только встроенное в Node; git и файловый ввод-вывод — швы, чтобы прогон мог проверить оба
 * пути, не заводя настоящего репозитория с настоящей сборкой.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

/** Исходник окна — путь от корня дерева, теми же разделителями, какими его называет git. */
export const SPA_SOURCE_PATH = 'spa/src'

/** Раздаваемая сборка окна — то, что демон отдаёт браузеру. */
export const SPA_BUNDLE_PATH = 'daemon/static/app'

/**
 * Что git знает про исходник окна: тронут ли он в рабочем дереве и когда его коммитили в
 * последний раз. `null` — git ничего не сказал (не репозиторий, нет git, нет коммитов по
 * этому пути); тогда зовущий остаётся на файловых mtime.
 *
 * @typedef {{dirty: boolean, commitMs: number} | null} SourceHistory
 */

/**
 * sourceHistory({cwd, path, execGit}) → SourceHistory.
 *
 * @param {{cwd?: string, path?: string, execGit?: Function}} [o]
 * @returns {SourceHistory}
 */
export function sourceHistory(o = {}) {
  const cwd = o.cwd || process.cwd()
  const relative = typeof o.path === 'string' && o.path ? o.path : SPA_SOURCE_PATH
  const git =
    typeof o.execGit === 'function'
      ? o.execGit
      : (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    if (String(git(['status', '--porcelain', '--', relative]) || '').trim()) return { dirty: true, commitMs: 0 }
    const seconds = String(git(['log', '-1', '--format=%ct', '--', relative]) || '').trim()
    if (!/^\d+$/.test(seconds)) return null
    return { dirty: false, commitMs: Number(seconds) * 1000 }
  } catch {
    return null
  }
}

/**
 * Все файлы дерева, рекурсивно.
 *
 * `withFileTypes` не годится: в рабочей копии каталог сборки — ссылка на дерево, где собирают,
 * и `isDirectory()` на записи каталога сказал бы «нет». Поэтому тип спрашивается у `statSync`,
 * который по ссылке проходит. Отсутствующее дерево — не ошибка, а пустой список: у зовущих
 * это законный ответ.
 *
 * @param {string} dir
 * @returns {{path: string, mtimeMs: number}[]}
 */
export function treeFiles(dir) {
  /** @type {{path: string, mtimeMs: number}[]} */
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(current, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(full)
      else found.push({ path: full, mtimeMs: info.mtimeMs })
    }
  }
  walk(dir)
  return found
}

/**
 * Самый свежий файл дерева — или `null`, если файлов нет вовсе.
 *
 * @param {string} dir
 * @returns {{path: string, mtimeMs: number} | null}
 */
export function newestFile(dir) {
  let best = null
  for (const file of treeFiles(dir)) if (!best || file.mtimeMs > best.mtimeMs) best = file
  return best
}

/**
 * freshnessVerdict(sourceDir, bundleDir, history) — ВЕРДИКТ ЛИНЕЙКИ.
 *
 * `applicable: false` — это часовой, а не зелёный: сравнивать было нечего. Два таких случая, и
 * оба со своим смыслом, иначе они молча превращали бы гейт в пустой:
 *   — нет `spa/src` — это установленная копия, у неё нет исходника окна, и спрашивать с неё
 *     свежесть бандла не за что;
 *   — нет ни одного файла в раздаче — сравнивать не с чем. «Окна нет вовсе» — вопрос проверки
 *     пакета (`package-check`), а не этой линейки; молчать здесь честнее, чем краснеть чужим
 *     красным на свежем клоне, где бандл ещё не собирали.
 *
 * `basis` называет линейку, которой мерили возраст исходника, — чтобы красное сообщение не
 * врало про причину.
 *
 * @param {string} sourceDir
 * @param {string} bundleDir
 * @param {SourceHistory} history
 */
export function freshnessVerdict(sourceDir, bundleDir, history) {
  const source = newestFile(sourceDir)
  const bundle = newestFile(bundleDir)
  if (!source || !bundle) {
    return { applicable: false, stale: false, basis: 'files', sourceMs: 0, source, bundle }
  }
  const byCommit = history !== null && history !== undefined && !history.dirty
  const sourceMs = byCommit ? history.commitMs : source.mtimeMs
  return {
    applicable: true,
    stale: sourceMs > bundle.mtimeMs,
    basis: byCommit ? 'commit' : 'files',
    sourceMs,
    source,
    bundle,
  }
}

/** Метку двигать было некуда — и вот почему, своими словами, а не молчанием. */
export const BUNDLE_ABSENT_NOTE = 'раздачи нет на диске — метку свежести двигать не на чем'

/**
 * refreshBundleMark({cwd, now}) → `{refreshed, note?}` — ОБНОВИТЬ МЕТКУ СВЕЖЕСТИ РАЗДАЧИ.
 *
 * Ни один байт раздачи при этом не меняется: заново проставляется время файлов, и только оно.
 * Право на такую запись есть ровно у того, кто ТОЛЬКО ЧТО собрал эту раздачу из этого дерева, —
 * иначе метка стала бы обещанием, которого никто не давал.
 *
 * ВРЕМЯ СТАВИТСЯ ВСЕМ ФАЙЛАМ, А НЕ ОДНОМУ. Линейке выше хватило бы самого свежего, но раздача,
 * у которой один файл «сегодня», а остальные «на прошлой неделе», врёт всякому, кто посмотрит
 * на неё глазами.
 *
 * Файл, которому время проставить не удалось (снесён параллельной сборкой, лежит только на
 * чтение), пропускается: половина обновлённой метки лучше, чем отказ посадки из-за одного
 * файла раздачи.
 *
 * @param {{cwd?: string, dir?: string, now?: number, list?: Function, touch?: Function}} [o]
 * @returns {{refreshed: number, note?: string, at?: number}}
 */
export function refreshBundleMark(o = {}) {
  const cwd = o.cwd || process.cwd()
  const dir = typeof o.dir === 'string' && o.dir ? o.dir : join(cwd, ...SPA_BUNDLE_PATH.split('/'))
  const at = Number.isFinite(o.now) ? Number(o.now) : Date.now()
  const list = typeof o.list === 'function' ? o.list : treeFiles
  const touch = typeof o.touch === 'function' ? o.touch : utimesSync
  const files = list(dir)
  if (files.length === 0) return { refreshed: 0, note: BUNDLE_ABSENT_NOTE }
  const seconds = at / 1000
  let refreshed = 0
  for (const file of files) {
    try {
      touch(file.path, seconds, seconds)
      refreshed += 1
    } catch {
      /* один непроставленный файл — не провал посадки */
    }
  }
  return { refreshed, at }
}
