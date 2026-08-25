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
 * Здесь проверяется РОВНО ЭТО и ничего больше: исходник окна не должен быть новее самого
 * свежего файла `daemon/static/app`. Не «бандл собран правильно», не «бандл вообще есть» —
 * второе принадлежит проверке пакета (`package-check`), которая спрашивает про наличие окна
 * перед публикацией. Разделение намеренное: у одного дефекта один хозяин.
 *
 * ЧАСОВ ЗДЕСЬ НЕТ. Гейт сравнивает время двух деревьев между собой, а не с «сейчас».
 *
 * ЧЕМ МЕРИТЬ ВОЗРАСТ ИСХОДНИКА — двумя разными линейками, и выбор между ними не вкусовой.
 * Файловый mtime честен ровно тогда, когда файл правил человек. В свежеотрезанной рабочей
 * копии его штампует checkout временем «сейчас»: исходники выглядят новее любого бандла, и
 * гейт краснеет там, где `spa` никто не трогал. Поэтому:
 *   — `spa/src` по git чист → возраст исходника берётся у ПОСЛЕДНЕГО КОММИТА, тронувшего
 *     `spa/src` (`git log -1 --format=%ct`). Время коммита checkout не переписывает, и оно
 *     одинаково в любой копии дерева;
 *   — по `spa/src` есть незакоммиченные правки → mtime файлов честны, меряем как раньше.
 * Суть гейта от этого не слабеет: коммит в `spa/src` новее раздачи — такой же красный, как
 * и правка в рабочем дереве. Если git недоступен (распакованный тарбол, не репозиторий) —
 * остаётся файловая линейка: хуже, но не молча.
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

import { execFileSync } from 'node:child_process'
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
 * Что git знает про исходник окна: тронут ли он в рабочем дереве и когда его коммитили в
 * последний раз. `null` — git ничего не сказал (не репозиторий, нет git, нет коммитов по
 * этому пути); тогда зовущий остаётся на файловых mtime.
 */
type SourceHistory = { dirty: boolean; commitMs: number } | null

function sourceHistory(root: string, relative: string): SourceHistory {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    if (git(['status', '--porcelain', '--', relative]).trim()) return { dirty: true, commitMs: 0 }
    const seconds = git(['log', '-1', '--format=%ct', '--', relative]).trim()
    if (!/^\d+$/.test(seconds)) return null
    return { dirty: false, commitMs: Number(seconds) * 1000 }
  } catch {
    return null
  }
}

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
 * `basis` называет линейку, которой мерили возраст исходника, — чтобы красное сообщение не
 * врало про причину и чтобы сцены ниже проверяли не только исход, но и выбор линейки.
 */
function freshnessVerdict(sourceDir: string, bundleDir: string, history: SourceHistory): {
  applicable: boolean
  stale: boolean
  basis: 'commit' | 'files'
  sourceMs: number
  source: Newest
  bundle: Newest
} {
  const source = newestFile(sourceDir)
  const bundle = newestFile(bundleDir)
  if (!source || !bundle) {
    return { applicable: false, stale: false, basis: 'files', sourceMs: 0, source, bundle }
  }
  const byCommit = history !== null && !history.dirty
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

describe('раздаваемая сборка окна не старше исходников', () => {
  it('в этом дереве бандл не старше исходника spa/src', () => {
    const verdict = freshnessVerdict(SOURCE_DIR, BUNDLE_DIR, sourceHistory(ROOT, 'spa/src'))
    if (!verdict.applicable) return // часовой: нет исходника окна или нет собранного бандла
    const cause =
      verdict.basis === 'commit'
        ? 'последний коммит в spa/src'
        : `незакоммиченная правка ${verdict.source?.path}`
    expect(
      verdict.stale
        ? `${cause} новее, чем ${verdict.bundle?.path} — окно раздаёт старый код. ` +
          'Пересоберите: npm run build:spa'
        : 'ok',
    ).toBe('ok')
  })

  /**
   * Поддельная сцена: дерево-двойник с настоящим git-репозиторием внутри и каталогом сборки
   * рядом с исходником. Время расставляется руками — и файловое, и коммитов. Так у гейта
   * появляется собственный красный и собственный зелёный, не зависящие от того, что сейчас
   * лежит на диске проекта.
   */
  function scene(): { dir: string; root: string; source: string; bundle: string } {
    const dir = mkdtempSync(join(tmpdir(), 'spa-freshness-'))
    const root = join(dir, 'tree')
    const source = join(root, 'spa', 'src')
    const bundle = join(root, 'daemon', 'static', 'app')
    mkdirSync(source, { recursive: true })
    mkdirSync(join(bundle, 'assets'), { recursive: true })
    writeFileSync(join(source, 'main.tsx'), 'export const x = 1\n')
    writeFileSync(join(bundle, 'assets', 'index-abc.js'), 'var x=1\n')
    writeFileSync(join(root, '.gitignore'), 'daemon/static/app/\n')
    return { dir, root, source, bundle }
  }

  /** Репозиторий сцены и коммит с назначенным временем — чтобы `git log -1 --format=%ct` врал по нашей команде. */
  function initRepo(root: string): void {
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'gate@example.invalid'])
    run(['config', 'user.name', 'gate'])
  }

  function commitAll(root: string, seconds: number): void {
    const date = `@${seconds} +0000`
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'spa'], { cwd: root, stdio: 'ignore', env })
  }

  function stamp(file: string, seconds: number): void {
    utimesSync(file, seconds, seconds)
  }

  it('молчит в чистой копии, где checkout проштамповал исходники временем «сейчас»', () => {
    const { dir, root, source, bundle } = scene()
    try {
      initRepo(root)
      commitAll(root, 1_000_000) // spa коммитили давно
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_500_000) // сборка сделана после того коммита
      stamp(join(source, 'main.tsx'), 2_000_000) // а checkout проштамповал исходник «сейчас»

      const history = sourceHistory(root, 'spa/src')
      expect(history).toEqual({ dirty: false, commitMs: 1_000_000_000 })

      const verdict = freshnessVerdict(source, bundle, history)
      expect(verdict.applicable).toBe(true)
      expect(verdict.basis).toBe('commit')
      expect(verdict.stale).toBe(false)
      // и та самая ловушка, ради которой всё это: файловая линейка здесь соврала бы красным
      expect(freshnessVerdict(source, bundle, null).stale).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('краснеет на незакоммиченной правке spa новее сборки', () => {
    const { dir, root, source, bundle } = scene()
    try {
      initRepo(root)
      commitAll(root, 1_000_000)
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_500_000)
      writeFileSync(join(source, 'main.tsx'), 'export const x = 2\n') // правка живёт только в дереве
      stamp(join(source, 'main.tsx'), 2_000_000)

      const history = sourceHistory(root, 'spa/src')
      expect(history?.dirty).toBe(true)

      const verdict = freshnessVerdict(source, bundle, history)
      expect(verdict.applicable).toBe(true)
      expect(verdict.basis).toBe('files') // грязно — значит mtime честны
      expect(verdict.stale).toBe(true)
      expect(verdict.source?.path).toContain('main.tsx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('краснеет на коммите в spa новее сборки', () => {
    const { dir, root, source, bundle } = scene()
    try {
      initRepo(root)
      commitAll(root, 2_000_000) // spa закоммитили после сборки
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_500_000)
      stamp(join(source, 'main.tsx'), 1_000_000) // а mtime исходника — старый, как после checkout

      const history = sourceHistory(root, 'spa/src')
      expect(history).toEqual({ dirty: false, commitMs: 2_000_000_000 })

      const verdict = freshnessVerdict(source, bundle, history)
      expect(verdict.applicable).toBe(true)
      expect(verdict.basis).toBe('commit')
      expect(verdict.stale).toBe(true)
      // файловая линейка этот случай проспала бы — потому линейка и выбирается по git
      expect(freshnessVerdict(source, bundle, null).stale).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('без git остаётся на файловых mtime: и красный, и зелёный', () => {
    const { dir, source, bundle } = scene()
    try {
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_000_000)
      stamp(join(source, 'main.tsx'), 1_000_100)
      expect(sourceHistory(join(dir, 'tree'), 'spa/src')).toBe(null) // не репозиторий — git молчит
      expect(freshnessVerdict(source, bundle, null).stale).toBe(true)

      stamp(join(source, 'main.tsx'), 1_000_000)
      stamp(join(bundle, 'assets', 'index-abc.js'), 1_000_100)
      expect(freshnessVerdict(source, bundle, null).stale).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('молчит там, где нет исходника окна или нет собранного бандла', () => {
    const { dir, source, bundle } = scene()
    try {
      expect(freshnessVerdict(join(dir, 'нет-такого'), bundle, null).applicable).toBe(false)
      expect(freshnessVerdict(source, join(dir, 'нет-такого'), null).applicable).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
