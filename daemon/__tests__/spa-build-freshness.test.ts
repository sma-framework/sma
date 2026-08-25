/**
 * ОТДАВАЕМАЯ СБОРКА ОКНА НЕ СТАРШЕ ЕГО ИСХОДНИКОВ.
 *
 * Демон отдаёт окно НЕ из `spa/src`, а из каталога `daemon/static/app` — готового бандла,
 * который кладёт туда `npm run build:spa`. Каталог гитом не отслеживается (полмегабайта
 * минифицированного кода в каждом диффе хуже, чем пересборка), а значит между исходником и
 * тем, что видит человек в браузере, стоит шаг, о котором ничто не напоминает. Забыть его
 * ничего не стоит: правка едет в коммит, тесты зелёные, ревью пройдено — и окно продолжает
 * показывать код прошлой недели. Это уже случилось: раздавалась сборка от 20-го числа при
 * исходниках, правленных до 22-го, и увидеть это можно было только сравнив время файлов
 * руками.
 *
 * Здесь проверяется РОВНО ЭТО и ничего больше: самый свежий файл `spa/src` не должен быть
 * новее самого свежего файла `daemon/static/app`. Не «бандл собран правильно», не «бандл
 * вообще есть» — второе принадлежит проверке пакета (`package-check`), которая спрашивает
 * про наличие окна перед публикацией. Разделение намеренное: у одного дефекта один хозяин.
 *
 * ЧАСОВ ЗДЕСЬ НЕТ. Гейт сравнивает время двух деревьев между собой, а не с «сейчас»: копия
 * рабочего дерева получает свои mtime в момент checkout, и любая привязка к текущему времени
 * сделала бы гейт зелёным или красным по причине, к делу не относящейся.
 *
 * ДВА ЧАСОВЫХ (оба со своим случаем ниже, иначе они молча превращали бы гейт в пустой):
 *   — нет `spa/src` — это установленная копия, у неё нет исходника окна, и спрашивать с неё
 *     свежесть бандла не за что;
 *   — нет ни одного файла в `daemon/static/app` — сравнивать не с чем. «Окна нет вовсе» —
 *     вопрос проверки пакета, а не этого гейта; молчать здесь честнее, чем краснеть чужим
 *     красным на свежем клоне, где бандл ещё не собирали.
 *
 * Сама сверка вынесена в чистую функцию и прогоняется на ПОДДЕЛЬНОЙ сцене во временном
 * каталоге — на протухшей и на свежей. Гейт, у которого нет своего красного, зелен ровно
 * потому, что ничего не искал.
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE_DIR = join(ROOT, 'spa', 'src')
const BUNDLE_DIR = join(ROOT, 'daemon', 'static', 'app')

type Newest = { path: string; mtimeMs: number } | null

/**
 * Самый свежий файл дерева — рекурсивно, по фактическому времени изменения.
 *
 * `withFileTypes` не годится: в рабочей копии каталог сборки — ссылка на дерево, где собирают,
 * и `isDirectory()` на записи каталога сказал бы «нет». Поэтому тип спрашивается у `statSync`,
 * который по ссылке проходит. Отсутствующее дерево — не ошибка, а `null`: у часовых выше это
 * законный ответ.
 */
function newestFile(dir: string): Newest {
  let best: Newest = null
  const walk = (current: string) => {
    let entries: string[]
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
      else if (!best || info.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: info.mtimeMs }
    }
  }
  walk(dir)
  return best
}

/**
 * Вердикт гейта. `applicable: false` — это часовой, а не зелёный: сравнивать было нечего.
 */
function freshnessVerdict(sourceDir: string, bundleDir: string): {
  applicable: boolean
  stale: boolean
  source: Newest
  bundle: Newest
} {
  const source = newestFile(sourceDir)
  const bundle = newestFile(bundleDir)
  if (!source || !bundle) return { applicable: false, stale: false, source, bundle }
  return { applicable: true, stale: source.mtimeMs > bundle.mtimeMs, source, bundle }
}

describe('раздаваемая сборка окна не старше исходников', () => {
  it('в этом дереве бандл не старше самого свежего файла spa/src', () => {
    const verdict = freshnessVerdict(SOURCE_DIR, BUNDLE_DIR)
    if (!verdict.applicable) return // часовой: нет исходника окна или нет собранного бандла
    expect(
      verdict.stale
        ? `${verdict.source?.path} новее, чем ${verdict.bundle?.path} — окно раздаёт старый код. ` +
          'Пересоберите: npm run build:spa'
        : 'ok',
    ).toBe('ok')
  })

  /**
   * Поддельная сцена: два каталога, время которых расставлено руками. Так у гейта появляется
   * собственный красный, не зависящий от того, что сейчас лежит на диске проекта.
   */
  function scene(): { dir: string; source: string; bundle: string } {
    const dir = mkdtempSync(join(tmpdir(), 'spa-freshness-'))
    const source = join(dir, 'src')
    const bundle = join(dir, 'app', 'assets')
    mkdirSync(source, { recursive: true })
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(source, 'main.tsx'), 'export const x = 1\n')
    writeFileSync(join(bundle, 'index-abc.js'), 'var x=1\n')
    return { dir, source, bundle: join(dir, 'app') }
  }

  function stamp(file: string, seconds: number): void {
    utimesSync(file, seconds, seconds)
  }

  it('краснеет, когда исходник новее сборки', () => {
    const { dir, source, bundle } = scene()
    try {
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_000_000)
      stamp(join(source, 'main.tsx'), 1_000_100)
      const verdict = freshnessVerdict(source, bundle)
      expect(verdict.applicable).toBe(true)
      expect(verdict.stale).toBe(true)
      expect(verdict.source?.path).toContain('main.tsx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('зеленеет, когда сборка сделана после правки', () => {
    const { dir, source, bundle } = scene()
    try {
      stamp(join(source, 'main.tsx'), 1_000_000)
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_000_100)
      const verdict = freshnessVerdict(source, bundle)
      expect(verdict.applicable).toBe(true)
      expect(verdict.stale).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('молчит там, где нет исходника окна или нет собранного бандла', () => {
    const { dir, source, bundle } = scene()
    try {
      expect(freshnessVerdict(join(dir, 'нет-такого'), bundle).applicable).toBe(false)
      expect(freshnessVerdict(source, join(dir, 'нет-такого')).applicable).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
