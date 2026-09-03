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
 * САМА ЛИНЕЙКА ЖИВЁТ НЕ ЗДЕСЬ, а в `scripts/sma/lib/spa-freshness.mjs`, и это не переезд ради
 * порядка. Второй её читатель — посадка: собрав окно и зафиксировав слияние, она обновляет
 * метку свежести раздачи и обязана мерить ТЕМ ЖЕ, чем её потом измерят здесь. Две линейки в
 * двух файлах разошлись бы молча — а расходятся такие вещи всегда в сторону ложного красного,
 * которое чинят руками в три часа ночи. Шапка модуля объясняет обе линейки и обоих часовых;
 * ниже — сцены, на которых у гейта есть собственный красный.
 *
 * ЧАСОВ ЗДЕСЬ НЕТ. Гейт сравнивает время двух деревьев между собой, а не с «сейчас».
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  freshnessVerdict,
  refreshBundleMark,
  sourceHistory,
  SPA_BUNDLE_PATH,
  SPA_SOURCE_PATH,
} from '../../scripts/sma/lib/spa-freshness.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE_DIR = join(ROOT, ...SPA_SOURCE_PATH.split('/'))
const BUNDLE_DIR = join(ROOT, ...SPA_BUNDLE_PATH.split('/'))

describe('раздаваемая сборка окна не старше исходников', () => {
  it('в этом дереве бандл не старше исходника spa/src', () => {
    const verdict = freshnessVerdict(SOURCE_DIR, BUNDLE_DIR, sourceHistory({ cwd: ROOT }))
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
    const source = join(root, ...SPA_SOURCE_PATH.split('/'))
    const bundle = join(root, ...SPA_BUNDLE_PATH.split('/'))
    mkdirSync(source, { recursive: true })
    mkdirSync(join(bundle, 'assets'), { recursive: true })
    writeFileSync(join(source, 'main.tsx'), 'export const x = 1\n')
    writeFileSync(join(bundle, 'assets', 'index-abc.js'), 'var x=1\n')
    writeFileSync(join(root, '.gitignore'), `${SPA_BUNDLE_PATH}/\n`)
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

      const history = sourceHistory({ cwd: root })
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

      const history = sourceHistory({ cwd: root })
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

      const history = sourceHistory({ cwd: root })
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
      expect(sourceHistory({ cwd: join(dir, 'tree') })).toBe(null) // не репозиторий — git молчит
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

  /**
   * ВТОРОЙ ЧИТАТЕЛЬ ЛИНЕЙКИ — обновление метки. Проверяется здесь, у самой линейки, потому что
   * утверждение у них общее: после обновления метки тот же вердикт обязан позеленеть, и ни один
   * байт раздачи при этом не изменился.
   */
  it('обновление метки лечит ровно то красное, которое даёт коммит, созданный после сборки', () => {
    const { dir, root, source, bundle } = scene()
    try {
      initRepo(root)
      commitAll(root, 2_000_000) // коммит слияния лёг ПОСЛЕ сборки — так и бывает на посадке
      stamp(join(source, 'main.tsx'), 1_000_000)
      const asset = join(bundle, 'assets', 'index-abc.js')
      stamp(asset, 1_500_000)
      const bytesBefore = readFileSync(asset, 'utf8')

      const history = sourceHistory({ cwd: root })
      expect(freshnessVerdict(source, bundle, history).stale, 'без метки гейт краснеет — ради этого всё').toBe(true)

      const mark = refreshBundleMark({ cwd: root, now: 2_500_000_000 })
      expect(mark.refreshed, 'метку получает каждый файл раздачи, а не один').toBe(1)

      expect(freshnessVerdict(source, bundle, history).stale).toBe(false)
      expect(readFileSync(asset, 'utf8'), 'метка двигает время, а не содержимое раздачи').toBe(bytesBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('раздачи нет вовсе — метку двигать не на чем, и об этом сказано словами', () => {
    const { dir, root } = scene()
    try {
      const mark = refreshBundleMark({ cwd: root, dir: join(dir, 'нет-такого') })
      expect(mark.refreshed).toBe(0)
      expect(mark.note).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
