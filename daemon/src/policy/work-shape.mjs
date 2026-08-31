/**
 * work-shape.mjs — ФОРМА РАБОТЫ: два вопроса к тому, что попытка положила на ветку.
 *
 * Оба гейта до сих пор спрашивали одно: ЕСТЬ ли доказательство (квитанция, документ, ответ).
 * Ни один не спрашивал, О ЧЁМ работа. Замерено 31.08.2026 на приёмке возвращённой пробы:
 * работнику досталась учебная карточка без предмета — жалоба, которую следовало проверить и,
 * если она мертва, закрыть словами. Предмета не нашлось. Работник создал заметку
 * `notes/proba-potolka.md` и тест из трёх дел: файл есть на диске, внутри есть нужное слово,
 * файл отслеживается git. Тест не может покраснеть НИ ОТ ОДНОЙ поломки продукта — он говорит
 * только о себе. Гейт при этом был ЗЕЛЁНЫЙ: сьют прошёл, квитанция честная, ветка слилась.
 * Отличить такую работу от настоящей можно было только глазами.
 *
 * ЭТО КЛАСС, А НЕ СЛУЧАЙ. У работника, не нашедшего предмета, нет дешёвого способа сдать
 * пустоту: «сделано, но коммитов нет» выглядит как провал, а файл с тестом выглядит как
 * работа. Давление устройства толкает ко второму, и держалось обратное только на
 * добросовестности — в тот же день другой работник на такой же карточке нашёл, что жалоба
 * закрыта, назвал коммит и три зелёных теста и не тронул ни строки. Поведение достижимо;
 * устройство его не требовало.
 *
 * ЗДЕСЬ ЖИВУТ ДВА РАСПОЗНАВАТЕЛЯ, оба ЧИСТЫЕ и оба FAIL-OPEN: они принимают список изменений
 * (`{status, path}` из `changedFilesOnBranch`) и две функции чтения, и НИКОГДА не бросают.
 * Молчание распознавателя означает «сказать нечего», а не «всё хорошо»: обвинить работу на
 * основании нечитаемого файла было бы хуже той дыры, которую они закрывают.
 */

/** Пути, добавленные ЭТОЙ работой. `A` — новый файл, `C` — копия: обоих в базе не было. */
function addedPaths(entries) {
  const out = []
  if (!Array.isArray(entries)) return out
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const status = String(e.status ?? '')
    const path = normalize(e.path)
    // Переименование (`R`) сюда НЕ попадает намеренно: файл существовал до работы под другим
    // именем, и тест о нём говорит о продукте, а не о себе.
    if (!path || (status[0] !== 'A' && status[0] !== 'C')) continue
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/** Один вид пути на всю проверку: прямые слэши, без ведущего `./`, без кавычек. */
function normalize(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  return s.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Тестовый ли это файл — по тем двум признакам, которыми их именует само дерево. */
function isTestFile(path) {
  return path.includes('/__tests__/') || path.startsWith('__tests__/') || /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(path)
}

/**
 * Спецификаторы модулей, которые файл ПОДКЛЮЧАЕТ. Три формы, которыми их пишут:
 * `from '...'`, `require('...')` и голый `import '...'` (он же динамический `import('...')`).
 */
const IMPORT_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g

/** Строковые литералы файла — сырьё для вопроса «о каких файлах этот тест говорит». */
const LITERAL_RE = /(['"`])((?:[^'"`\\\r\n]|\\.)*)\1/g

/**
 * Похоже ли на путь в дереве. Намеренно узко: имя с расширением, возможно с каталогами.
 * `node:fs` отсекается двоеточием, `vitest` — отсутствием расширения, `utf8` — им же.
 */
const PATHISH_RE = /^(?:[\w.@~-]+\/)*[\w.@~-]+\.[A-Za-z0-9]{1,8}$/

/** Ссылается ли литерал на этот добавленный путь — с любой стороны, целиком или хвостом. */
function refersTo(literal, path) {
  return literal === path || literal.endsWith(`/${path}`) || path.endsWith(`/${literal}`)
}

/**
 * selfReferentialTests({entries, readFile, pathExists}) → {files, detail} | null
 *
 * ТЕСТ, КОТОРЫЙ ГОВОРИТ ТОЛЬКО О СЕБЕ. Добавленный этой же работой тестовый файл называется
 * самозамкнутым, когда ВСЕ ТРИ верны:
 *   1. он не подключает НИ ОДНОГО модуля продукта — только пакеты и встроенные модули. Это
 *      первое условие спасает нормальную работу: новый модуль со своим тестом — самый обычный
 *      вид правки, и его тест импортирует то, что проверяет. Проверка поведения — разговор о
 *      продукте, чем бы файл ни был помечен в diff;
 *   2. он называет хотя бы один путь. Тест, не назвавший ни одного файла и ничего не
 *      подключивший, распознаватель не судит вовсе — обвинять по молчанию нечем;
 *   3. КАЖДЫЙ названный им путь — путь, добавленный ЭТОЙ ЖЕ работой. Тест, который читает
 *      README или существующий рецепт, говорит о продукте: такой файл был до работы, и
 *      сломать его можно чем-то, кроме самого теста.
 *
 * ЧТО СЧИТАЕТСЯ НАЗВАННЫМ ПУТЁМ, и здесь проходит вся граница честности: литерал, который
 * либо совпал с добавленным путём, либо РЕАЛЬНО СУЩЕСТВУЕТ в копии. Строка вроде `'1.0'`
 * формально похожа на имя файла, но ничему на диске не соответствует — и она не считается
 * ни за, ни против. Иначе случайная версия в строке разоружала бы весь распознаватель.
 *
 * FAIL-OPEN на каждом шаге: нечитаемый файл пропускается молча, отсутствие читателя даёт
 * пустой ответ. Никогда не бросает.
 *
 * @param {{entries?:Array<{status:string,path:string}>, readFile?:(p:string)=>string|null, pathExists?:(p:string)=>boolean}} o
 * @returns {{files:string[], detail:string}|null}
 */
export function selfReferentialTests({ entries, readFile, pathExists } = {}) {
  const added = addedPaths(entries)
  if (!added.length || typeof readFile !== 'function') return null
  const exists = typeof pathExists === 'function' ? pathExists : () => false

  const files = []
  const reasons = []
  for (const path of added) {
    if (!isTestFile(path)) continue

    let text
    try {
      text = readFile(path)
    } catch {
      continue // нечитаемый файл — не улика
    }
    if (typeof text !== 'string' || !text) continue

    // (1) подключает ли он продукт. Относительный или абсолютный спецификатор — это код
    // дерева; голое имя пакета и `node:` — это чужой код, о продукте он ничего не говорит.
    let importsProduct = false
    IMPORT_RE.lastIndex = 0
    for (let m = IMPORT_RE.exec(text); m; m = IMPORT_RE.exec(text)) {
      const spec = String(m[2] || '')
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) {
        importsProduct = true
        break
      }
    }
    if (importsProduct) continue

    // (2)+(3) о каких файлах он говорит.
    const selfRefs = []
    let speaksOfProduct = false
    LITERAL_RE.lastIndex = 0
    for (let m = LITERAL_RE.exec(text); m; m = LITERAL_RE.exec(text)) {
      const lit = normalize(m[2])
      if (!lit || !PATHISH_RE.test(lit)) continue
      const own = added.find((a) => refersTo(lit, a))
      if (own) {
        if (!selfRefs.includes(own)) selfRefs.push(own)
        continue
      }
      let there = false
      try {
        there = exists(lit) === true
      } catch {
        there = false
      }
      if (there) {
        speaksOfProduct = true
        break
      }
    }
    if (speaksOfProduct || !selfRefs.length) continue

    files.push(path)
    reasons.push(`${path} → ${selfRefs.join(', ')}`)
  }

  if (!files.length) return null
  return {
    files,
    detail:
      `тест говорит только о файлах, добавленных этой же работой, и не подключает ни одного модуля продукта ` +
      `(${reasons.join(' · ')}) — покраснеть он может лишь от самого себя`,
  }
}

/** Каталоги, которые в копию кладёт САМ демон: личный слой, состояние, ссылки, снимок задачи. */
const FURNISHED_TOP_LEVEL = Object.freeze(['.claude', '.sma', 'node_modules', '.git'])

/**
 * newTopLevelDirs({entries, baseTopLevel}) → string[] — каталоги ВЕРХНЕГО уровня, которых в
 * базе не было, а после работы они есть.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ВОПРОС, А НЕ ПОБОЧНЫЙ ЭФФЕКТ. Новый каталог верхнего уровня — это
 * заявление о том, из чего состоит продукт: он попадает в README, в упаковку, в чужие
 * относительные пути и в привычку всех следующих работников. Ни одна задача не выдаёт на него
 * мандата попутно, и в замеренном случае `notes/` завёлся именно так — чтобы было куда
 * положить файл, оправдывающий попытку.
 *
 * FAIL-OPEN: пустой или неизвестный список верхнего уровня базы даёт пустой ответ. Пока не
 * известно, чего в базе НЕ БЫЛО, обвинять нечем — молчание здесь не «всё хорошо», а «нечем
 * судить», и вызывающий говорит об этом вслух.
 *
 * @param {{entries?:Array<{status:string,path:string}>, baseTopLevel?:string[]}} o
 * @returns {string[]}
 */
export function newTopLevelDirs({ entries, baseTopLevel } = {}) {
  if (!Array.isArray(baseTopLevel) || !baseTopLevel.length) return []
  const known = baseTopLevel.map((n) => normalize(n).replace(/\/$/, '')).filter(Boolean)
  const out = []
  for (const path of addedPaths(entries)) {
    const slash = path.indexOf('/')
    if (slash <= 0) continue // файл в корне — это не новый каталог
    const top = path.slice(0, slash)
    if (known.includes(top) || FURNISHED_TOP_LEVEL.includes(top) || out.includes(top)) continue
    out.push(top)
  }
  return out.sort()
}
