/**
 * ПОСАДКА: ПОСЛЕ КНОПКИ ВЕРШИНА ЗЕЛЁНАЯ, А ПОЛНЫЙ НАБОР ИДЁТ ОДИН РАЗ.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Кнопка приёмки сливала ветку — и на этом заканчивалась. Числа продукта (значок прогона в
 * обоих README, измеренная квитанция, числа карты) оставались снятыми на дереве работника, а
 * вершина после слияния становилась ДРУГИМ деревом. Сторож чисел краснел сразу после нажатия,
 * и человек доводил приёмку руками: свод, полный прогон, дозапись чисел, возврат маркера
 * версии, коммит явными путями. Пять команд после каждой кнопки.
 *
 * Вторая половина той же беды — цена. Полный набор шёл за жизнь одной карточки три-четыре
 * раза, и все разы над одним и тем же деревом.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. КРАСНОЕ БЕЗ ПОЧИНКИ. Сразу после слияния ветки с устаревшими числами оба сторожа —
 *      значка и карты — краснеют; после штампа оба зелёные. Обе половины утверждения стоят в
 *      одном случае, поэтому «зелено» здесь нельзя получить, не пройдя через «красно».
 *   2. НАБОР ИДЁТ ОДИН РАЗ, И РОВНО ТОГДА, КОГДА НУЖЕН. Вершина двигалась по коду — прогон
 *      ровно один; квитанция снята на том же коде — прогона нет вовсе, а числа карты всё равно
 *      догоняют квитанцию.
 *   3. МАРКЕР ВЕРСИИ ШТАМПОМ НЕ ДВИГАЕТСЯ: его нет в коммите штампа, и дерево после посадки
 *      чистое — то есть он не «оставлен незакоммиченным», а возвращён на место.
 *   4. КРАСНЫЙ ПРОГОН НЕ ПУСКАЕТ ВЕТКУ: вершина не двигается, штамповать нечего.
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ: git, файлы, ритуал слияния, штамп и оба сторожа. Подделан ровно один
 * шов — сам прогонятель набора (иначе каждый случай стоил бы десяти минут и тысяч тестов), и
 * подделка отвечает ТЕМ ЖЕ, чем отвечает настоящий: отчётом сьютера на диске.
 */

import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, it, expect, beforeAll } from 'vitest'

import {
  createLanding,
  receiptCoversTree,
  runFullSuiteAsync,
  STAMP_PATHS,
  summarizeVitestReport,
  versionMarkerIsCosmetic,
} from '../lib/landing.mjs'
import { runMerge } from '../lib/merge-gate.mjs'
import { checkBadge, readChangedSince, readHead } from '../lib/badge.mjs'
import { audit } from '../lib/doc-audit.mjs'

const GRAPH = 'docs/master-graph.html'

beforeAll(() => {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(
      `git недоступен на этой машине, поэтому посадка НЕ ПРОВЕРЕНА: ${String(err)}. ` +
        'Прогон, которого не было, никогда не считается проходом.',
    )
  }
})

/** Записать файл, заведя каталоги по дороге. */
function put(root: string, rel: string, text: string) {
  const path = join(root, ...rel.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function read(root: string, rel: string) {
  return readFileSync(join(root, ...rel.split('/')), 'utf8')
}

/**
 * Карта замера — ровно те места, которые сторож чисел стережёт: три помеченных пролёта и
 * четыре предложения о точке рабочего дерева. Числа в фикстуре заведомо старые: их и должен
 * догнать штамп.
 */
function graphHtml({ tests, files, date, commit }: { tests: number; files: number; date: string; commit: string }) {
  return [
    '<!doctype html><html><body>',
    `<!-- sma:num-meta:start -->v1.0.0 · ${tests} tests · ${files} files<!-- sma:num-meta:end -->`,
    `<!-- sma:num-hero:start -->v1.0.0 · ${tests} tests · ${files} files<!-- sma:num-hero:end -->`,
    `<!-- sma:num-footer:start -->v1.0.0 · ${tests} tests · ${files} files<!-- sma:num-footer:end -->`,
    `<svg viewBox="0 0 460 212" role="img" aria-label="Test suite growth from 532 tests at v0.1.0, and ${tests} tests across ${files} files on the working tree, ${date}. Six measured points only.">`,
    '<line class="tip" x1="342" y1="148.53" x2="410" y2="160.00" stroke="#8B5CF6"/>',
    `<circle class="tip" cx="410" cy="160.00" r="5"><title>main — ${tests} tests, ${files} files. NOT a release point: this is a working-tree measurement — the run receipt of ${date} at commit ${commit}.</title></circle>`,
    `<text class="val tip" x="410" y="150.00" text-anchor="middle">${tests}</text>`,
    `<text class="ax tip" x="410" y="176.00" text-anchor="middle">${files} files</text>`,
    '</svg>',
    `<figcaption>Tests in the suite: it is the run receipt of the suite on main, ${date} (${tests} tests / ${files} files).</figcaption>`,
    '</body></html>',
  ].join('\n')
}

function readmeText({ tests, lang }: { tests: number; lang: 'en' | 'ru' }) {
  const alt = lang === 'en' ? 'tests' : 'тесты'
  return [
    '# fixture',
    `<img src="https://img.shields.io/badge/tests-${tests}%2F${tests}-brightgreen" alt="${alt} ${tests}/${tests}">`,
    '',
    'Ordinary prose that nobody measures.',
    '',
  ].join('\n')
}

function receiptJson({ tests, files, commit, at }: { tests: number; files: number; commit: string; at: string }) {
  return `${JSON.stringify(
    { tests, files, measuredAt: at, source: 'vitest', commit, dirty: false, runStartedAt: at },
    null,
    2,
  )}\n`
}

/** Отчёт сьютера в его собственном формате — то, из чего штамп берёт числа. */
function vitestReport({ tests, files }: { tests: number; files: number }) {
  return JSON.stringify({
    success: true,
    numTotalTests: tests,
    numPassedTests: tests,
    numFailedTests: 0,
    startTime: Date.now(),
    testResults: Array.from({ length: files }, (_, i) => ({ name: `f${i}.test.ts`, status: 'passed' })),
  })
}

type Repo = {
  home: string
  dir: string
  git: (args: string[]) => string
  trunk: string
  claimsDir: string
  journalDir: string
}

/**
 * Одноразовый репозиторий, похожий на продукт ровно теми местами, которые стережёт замер.
 *
 * БРОНЬ И ЖУРНАЛ ЛЕЖАТ СНАРУЖИ РЕПОЗИТОРИЯ, и это не вкус: посадка спрашивает git, чисто ли
 * дерево, и записывает ответ в квитанцию. Служебный каталог, заведённый ВНУТРИ копии, делает
 * дерево грязным — то есть подделывает ровно тот факт, который проверяется.
 */
function makeRepo(name: string): Repo {
  const home = mkdtempSync(join(tmpdir(), `sma-landing-${name}-`))
  const dir = join(home, 'repo')
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) => String(execFileSync('git', args, { cwd: dir, encoding: 'utf8' }))
  git(['init', '-q'])
  git(['config', 'user.email', 'suite@example.invalid'])
  git(['config', 'user.name', 'suite'])
  git(['config', 'commit.gpgsign', 'false'])
  // Концы строк ЭТОГО дерева задаёт случай, а не машина: маркер версии здесь — предмет
  // проверки, и настройка соседа не имеет права его переписать по дороге в индекс.
  git(['config', 'core.autocrlf', 'false'])
  put(dir, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2)}\n`)
  put(dir, 'src/first.mjs', 'export const first = 1\n')
  // Маркер установки лежит с ЧУЖИМ концом строки — ровно так, как он лежит в живом дереве.
  // Дозапись чисел из-за этого переписывает его каждый раз, а сторож такой разницы не видит.
  put(dir, 'sma-core/VERSION', '1.0.0\r\n')
  put(dir, 'README.md', readmeText({ tests: 10, lang: 'en' }))
  put(dir, 'README.ru.md', readmeText({ tests: 10, lang: 'ru' }))
  put(dir, GRAPH, graphHtml({ tests: 10, files: 3, date: '01.09.2026', commit: '0000000' }))
  git(['add', '-A'])
  git(['commit', '-q', '--no-verify', '-m', 'fixture'])
  const base = git(['rev-parse', 'HEAD']).trim()
  // Квитанция замера называет коммит, на котором мерили, — как её пишет сам значок.
  put(dir, 'test-receipt.json', receiptJson({ tests: 10, files: 3, commit: base, at: '2026-09-01T10:00:00.000Z' }))
  put(dir, GRAPH, graphHtml({ tests: 10, files: 3, date: '01.09.2026', commit: base.slice(0, 7) }))
  git(['add', '--', 'test-receipt.json', GRAPH])
  git(['commit', '-q', '--no-verify', '-m', 'stamp'])
  const trunk = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const claimsDir = join(home, 'claims')
  const journalDir = join(home, 'journal')
  mkdirSync(claimsDir, { recursive: true })
  mkdirSync(journalDir, { recursive: true })
  return { home, dir, git, trunk, claimsDir, journalDir }
}

/** Оба сторожа, которыми человек проверял вершину руками. */
function guards(dir: string) {
  const head = readHead({ cwd: dir })
  let commit: string | null = null
  try {
    commit = JSON.parse(read(dir, 'test-receipt.json')).commit
  } catch {
    commit = null
  }
  const changedSince = readChangedSince({ cwd: dir, commit })
  const badge = checkBadge({ pkgRoot: dir, head, changedSince })
  const numbers = audit({ target: 'numbers', rootDir: dir })
  return {
    badge: badge.violations as any[],
    // Фикстура — не продукт: у неё нет ни таблицы дверей, ни списка вербов, и замечания о них
    // к посадке не относятся. Спрашивается ровно то, что посадка обязана была починить.
    graph: (numbers.violations as any[]).filter((v) => v.file === GRAPH),
  }
}

/** Файлы одного коммита, как их называет сам git. */
function filesOf(repo: Repo, rev = 'HEAD') {
  return repo
    .git(['show', '--name-only', '--pretty=format:', rev])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

describe('посадка: после кнопки вершина зелёная, а набор гоняется один раз', () => {
  it('вершина двигалась по коду: набор идёт РОВНО один раз, и штамп доводит числа до зелёного', async () => {
    const repo = makeRepo('moved')
    try {
      // Работник отвёл ветку, дописал код и снял СВОЮ квитанцию на своей вершине.
      repo.git(['checkout', '-q', '-b', 'wt/x'])
      put(repo.dir, 'src/worker.mjs', 'export const worker = 2\n')
      repo.git(['add', '--', 'src/worker.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'work'])
      const workerTip = repo.git(['rev-parse', 'HEAD']).trim()
      put(repo.dir, 'test-receipt.json', receiptJson({ tests: 12, files: 4, commit: workerTip, at: '2026-09-01T12:00:00.000Z' }))
      put(repo.dir, 'README.md', readmeText({ tests: 12, lang: 'en' }))
      put(repo.dir, 'README.ru.md', readmeText({ tests: 12, lang: 'ru' }))
      repo.git(['add', '--', 'test-receipt.json', 'README.md', 'README.ru.md'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'worker stamp'])
      repo.git(['checkout', '-q', repo.trunk])

      // …а вершина за это время уехала: на ней появился ЧУЖОЙ код.
      put(repo.dir, 'src/other.mjs', 'export const other = 3\n')
      repo.git(['add', '--', 'src/other.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'someone else'])

      let runs = 0
      const landing = createLanding({
        cwd: repo.dir,
        runSuite: async ({ reportPath }: any) => {
          runs += 1
          writeFileSync(reportPath, vitestReport({ tests: 14, files: 5 }), 'utf8')
          return { passed: true, ran: true, reportPath }
        },
      })

      const merged: any = await runMerge({
        branch: 'wt/x',
        by: 'landing-case',
        cwd: repo.dir,
        claimsDir: repo.claimsDir,
        journalDir: repo.journalDir,
        runTests: landing.runTests,
      })
      expect(merged.merged, `слияние не прошло: ${JSON.stringify(merged)}`).toBe(true)
      expect(runs, 'полный набор обязан пойти ровно один раз на посадку').toBe(1)

      // ── КРАСНОЕ БЕЗ ПОЧИНКИ. Ветка в дереве, числа — старые: оба сторожа краснеют.
      const before = guards(repo.dir)
      expect(before.badge.length, 'сторож значка обязан краснеть на слитой ветке с устаревшими числами').toBeGreaterThan(0)
      expect(before.graph.length, 'сторож чисел карты обязан краснеть на слитой ветке').toBeGreaterThan(0)

      // ── ЗЕЛЁНОЕ ПОСЛЕ ШТАМПА, и без единой команды человека.
      const stamp: any = landing.stamp({ cwd: repo.dir })
      expect(stamp.stamped, `штамп не встал: ${JSON.stringify(stamp)}`).toBe(true)
      expect(stamp.committed).toBe(true)
      expect(stamp.tests).toBe(14)
      expect(stamp.files).toBe(5)

      const after = guards(repo.dir)
      expect(after.badge, `значок остался расходиться: ${JSON.stringify(after.badge)}`).toEqual([])
      expect(after.graph, `числа карты остались расходиться: ${JSON.stringify(after.graph)}`).toEqual([])
      expect(stamp.badgeViolations).toBe(0)

      // Числа доехали до всех производных мест, а не только до квитанции.
      expect(read(repo.dir, 'README.md')).toContain('tests-14%2F14')
      expect(read(repo.dir, 'README.ru.md')).toContain('alt="тесты 14/14"')
      expect(read(repo.dir, GRAPH)).toContain('14 tests · 5 files')
      expect(JSON.parse(read(repo.dir, 'test-receipt.json')).commit).toBe(merged.resultSha)

      // ── МАРКЕР ВЕРСИИ ШТАМПОМ НЕ ДВИГАЕТСЯ.
      const stampFiles = filesOf(repo)
      expect(stampFiles).not.toContain('sma-core/VERSION')
      for (const f of stampFiles) expect(STAMP_PATHS as readonly string[]).toContain(f)
      expect(repo.git(['status', '--porcelain', '--', 'sma-core/VERSION']).trim()).toBe('')
      expect(read(repo.dir, 'sma-core/VERSION')).toBe('1.0.0\r\n')
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  }, 120000)

  it('вершина не двигалась: набора НЕТ вовсе, а карта всё равно догоняет квитанцию работника', async () => {
    const repo = makeRepo('still')
    try {
      // Работник снял квитанцию и поправил значок — но карту не тронул: ровно тот случай,
      // ради которого дверь обязана уметь штамповать БЕЗ прогона.
      repo.git(['checkout', '-q', '-b', 'wt/y'])
      put(repo.dir, 'src/worker.mjs', 'export const worker = 2\n')
      repo.git(['add', '--', 'src/worker.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'work'])
      const workerTip = repo.git(['rev-parse', 'HEAD']).trim()
      put(repo.dir, 'test-receipt.json', receiptJson({ tests: 12, files: 4, commit: workerTip, at: '2026-09-01T12:00:00.000Z' }))
      put(repo.dir, 'README.md', readmeText({ tests: 12, lang: 'en' }))
      put(repo.dir, 'README.ru.md', readmeText({ tests: 12, lang: 'ru' }))
      repo.git(['add', '--', 'test-receipt.json', 'README.md', 'README.ru.md'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'worker stamp'])
      repo.git(['checkout', '-q', repo.trunk])

      let runs = 0
      const landing = createLanding({
        cwd: repo.dir,
        runSuite: async () => {
          runs += 1
          return { passed: true, ran: true }
        },
      })

      const merged: any = await runMerge({
        branch: 'wt/y',
        by: 'landing-case',
        cwd: repo.dir,
        claimsDir: repo.claimsDir,
        journalDir: repo.journalDir,
        runTests: landing.runTests,
      })
      expect(merged.merged, `слияние не прошло: ${JSON.stringify(merged)}`).toBe(true)
      expect(runs, 'квитанция снята на том же коде — второй прогон здесь незачем').toBe(0)
      expect(landing.state.decided).toBe('reused')

      const before = guards(repo.dir)
      expect(before.graph.length, 'карта работника осталась старой — сторож обязан краснеть').toBeGreaterThan(0)

      const stamp: any = landing.stamp({ cwd: repo.dir })
      expect(stamp.stamped).toBe(true)
      expect(stamp.reusedReceipt).toBe(true)
      expect(stamp.ran).toBe(false)
      expect(stamp.tests, 'числа взяты у квитанции работника, а не выдуманы').toBe(12)

      const after = guards(repo.dir)
      expect(after.badge, JSON.stringify(after.badge)).toEqual([])
      expect(after.graph, JSON.stringify(after.graph)).toEqual([])
      expect(read(repo.dir, GRAPH)).toContain('12 tests · 4 files')
      // Квитанция работника не переписана: её никто не перемерял, и подменять в ней коммит
      // значило бы сказать, что мерили здесь.
      expect(JSON.parse(read(repo.dir, 'test-receipt.json')).commit).toBe(workerTip)
      expect(filesOf(repo)).toEqual([GRAPH])
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  }, 120000)

  it('красный полный прогон не пускает ветку: вершина на месте, штамповать нечего', async () => {
    const repo = makeRepo('red')
    try {
      repo.git(['checkout', '-q', '-b', 'wt/z'])
      put(repo.dir, 'src/worker.mjs', 'export const worker = 2\n')
      repo.git(['add', '--', 'src/worker.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'work'])
      repo.git(['checkout', '-q', repo.trunk])
      put(repo.dir, 'src/other.mjs', 'export const other = 3\n')
      repo.git(['add', '--', 'src/other.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'someone else'])
      const tipBefore = repo.git(['rev-parse', 'HEAD']).trim()

      const landing = createLanding({
        cwd: repo.dir,
        runSuite: async () => ({ passed: false, ran: true, failedTest: 'src/worker.test.ts > it falls' }),
      })
      const merged: any = await runMerge({
        branch: 'wt/z',
        by: 'landing-case',
        cwd: repo.dir,
        claimsDir: repo.claimsDir,
        journalDir: repo.journalDir,
        runTests: landing.runTests,
      })
      expect(merged.merged).toBe(false)
      expect(merged.testsPassed).toBe(false)
      expect(repo.git(['rev-parse', 'HEAD']).trim(), 'вершина двинулась на красном прогоне').toBe(tipBefore)
      expect(repo.git(['status', '--porcelain']).trim()).toBe('')
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  }, 120000)
})

describe('честна ли квитанция для сведённого дерева — по одному вопросу за раз', () => {
  it('квитанция, снятая на грязном дереве, не покрывает НИЧЕГО', () => {
    const repo = makeRepo('dirty')
    try {
      const tip = repo.git(['rev-parse', 'HEAD']).trim()
      put(repo.dir, 'test-receipt.json', receiptJson({ tests: 10, files: 3, commit: tip, at: '2026-09-01T10:00:00.000Z' }).replace('"dirty": false', '"dirty": true'))
      const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim()
      const v: any = receiptCoversTree({ cwd: repo.dir, mergedTree: tree })
      expect(v.covers).toBe(false)
      expect(v.reason).toContain('грязном')
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  })

  it('квитанция без коммита не покрывает ничего — сверять не с чем', () => {
    const repo = makeRepo('nocommit')
    try {
      put(repo.dir, 'test-receipt.json', `${JSON.stringify({ tests: 10, files: 3, dirty: false }, null, 2)}\n`)
      const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim()
      const v: any = receiptCoversTree({ cwd: repo.dir, mergedTree: tree })
      expect(v.covers).toBe(false)
      expect(v.reason).toContain('коммита')
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  })

  it('квитанция, отставшая только на производных местах, покрывает дерево — иначе набор гонялся бы всегда', () => {
    const repo = makeRepo('derived')
    try {
      const measured = repo.git(['rev-parse', 'HEAD~1']).trim() // до коммита штампа
      put(repo.dir, 'test-receipt.json', receiptJson({ tests: 10, files: 3, commit: measured, at: '2026-09-01T10:00:00.000Z' }))
      const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim()
      const v: any = receiptCoversTree({ cwd: repo.dir, mergedTree: tree })
      expect(v.covers, `посадка сочла бы честную квитанцию устаревшей: ${v.reason}`).toBe(true)
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  })

  it('квитанция, отставшая на КОДЕ, дерево не покрывает', () => {
    const repo = makeRepo('code')
    try {
      const measured = repo.git(['rev-parse', 'HEAD']).trim()
      put(repo.dir, 'src/late.mjs', 'export const late = 4\n')
      repo.git(['add', '--', 'src/late.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'code moved'])
      put(repo.dir, 'test-receipt.json', receiptJson({ tests: 10, files: 3, commit: measured, at: '2026-09-01T10:00:00.000Z' }))
      const tree = repo.git(['rev-parse', 'HEAD^{tree}']).trim()
      const v: any = receiptCoversTree({ cwd: repo.dir, mergedTree: tree })
      expect(v.covers).toBe(false)
      expect(v.reason).toContain('src/late.mjs')
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  })
})

/**
 * ОТЧЁТ КРАСНОЙ ПОСАДКИ — ЛЕЖИТ ТАМ, ГДЕ ЕГО МОЖНО ОТКРЫТЬ ПОСЛЕ ОТКАЗА.
 *
 * Дверь приёмки вернула «тесты красные», имени упавшего теста не назвала и отослала к выводу
 * прогона — а вывода не было нигде: отчёт полного набора писался во временный каталог и
 * умирал вместе с отказом. Полный прогон при живых соседних сессиях умеет краснеть ложно, и
 * отличить такой красный от настоящего можно ТОЛЬКО по отчёту.
 *
 * Подделан ровно один шов — запуск дочернего процесса, — и подделка отвечает ТЕМ ЖЕ, чем
 * отвечает настоящий сьютер: отчётом на диске и ненулевым кодом выхода.
 */
function redReport() {
  return JSON.stringify({
    success: false,
    numTotalTests: 4,
    numPassedTests: 2,
    numFailedTests: 2,
    startTime: Date.now(),
    testResults: [
      { name: 'scripts/sma/__tests__/green.test.ts', status: 'passed', assertionResults: [] },
      {
        name: 'scripts/sma/__tests__/landing.test.ts',
        status: 'failed',
        assertionResults: [
          { status: 'passed', fullName: 'посадка > зелёный случай' },
          {
            status: 'failed',
            fullName: 'посадка > красный прогон не пускает ветку',
            failureMessages: ['AssertionError: expected false to be true\n  at landing.test.ts:260:24'],
          },
        ],
      },
      {
        name: 'daemon/__tests__/broken-import.test.ts',
        status: 'failed',
        message: 'Error: Cannot find module ./nowhere.mjs',
        assertionResults: [],
      },
    ],
  })
}

/** Дочерний процесс сьютера: пишет отчёт в названный файл, печатает пару строк и падает. */
function fakeSuiteSpawn(report: string, said: string) {
  return (_bin: string, args: string[]) => {
    const flag = args.find((a) => String(a).startsWith('--outputFile='))
    const target = flag ? String(flag).slice('--outputFile='.length) : null
    const child: any = new EventEmitter()
    for (const name of ['stdout', 'stderr']) {
      const stream: any = new EventEmitter()
      stream.setEncoding = () => {}
      child[name] = stream
    }
    child.kill = () => {}
    setTimeout(() => {
      if (target) writeFileSync(target, report, 'utf8')
      child.stdout.emit('data', said)
      child.emit('exit', 1, null)
    }, 0)
    return child
  }
}

describe('красный полный прогон: имена берутся из отчёта, а сам отчёт переживает отказ', () => {
  it('имена и файлы читаются из ОТЧЁТА — печати на экране у полного прогона почти нет', () => {
    const said: any = summarizeVitestReport(redReport())
    expect(said.failedTest).toContain('landing.test.ts')
    expect(said.failedTest).toContain('красный прогон не пускает ветку')
    // Файл, упавший на сборке, назван САМИМ ФАЙЛОМ: имени теста там не существует.
    expect(said.failedTests.join('\n')).toContain('daemon/__tests__/broken-import.test.ts')
    expect(said.failureDetail).toContain('AssertionError')
  })

  it('отчёт, который не разобрался, НЕ выдумывает ни одного имени', () => {
    const said: any = summarizeVitestReport('не отчёт вовсе')
    expect(said.failedTest).toBe(null)
    expect(said.failedTests).toEqual([])
  })

  it('прогонятель кладёт отчёт и хвост вывода в названный дом данных и называет пути', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sma-landing-keep-'))
    try {
      const keepDir = join(home, 'landing')
      const answer: any = await runFullSuiteAsync({
        cwd: home,
        keepDir,
        label: 'R-42',
        reportPath: join(home, 'tmp-report.json'),
        exists: () => true,
        resolveEntry: () => join(home, 'suite-entry.mjs'),
        spawn: fakeSuiteSpawn(redReport(), 'печать сьютера, которой у полного прогона почти нет\n'),
      })

      expect(answer.passed).toBe(false)
      expect(answer.ran).toBe(true)
      // (а) ПУТИ НАЗВАНЫ И ФАЙЛЫ ЛЕЖАТ.
      expect(answer.savedReport, JSON.stringify(answer)).toBeTruthy()
      expect(existsSync(answer.savedReport), 'отчёт назван, но его нет на диске').toBe(true)
      expect(existsSync(answer.savedLog), 'хвоста вывода нет на диске').toBe(true)
      expect(String(answer.savedReport)).toContain('R-42')
      expect(JSON.parse(readFileSync(answer.savedReport, 'utf8')).numFailedTests).toBe(2)
      expect(readFileSync(answer.savedLog, 'utf8')).toContain('печать сьютера')
      // (б) ИМЕНА ЗАПОЛНЕНЫ ВСЕГДА, КОГДА ЕСТЬ ОТЧЁТ.
      expect(answer.failedTest).toContain('landing.test.ts')
      expect(answer.failedTests.length).toBeGreaterThan(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60000)

  it('квитанция отказа несёт имена и путь, и путь ОТКРЫВАЕТСЯ после отката слияния', async () => {
    const repo = makeRepo('kept')
    try {
      repo.git(['checkout', '-q', '-b', 'wt/R-red'])
      put(repo.dir, 'src/worker.mjs', 'export const worker = 2\n')
      repo.git(['add', '--', 'src/worker.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'work'])
      repo.git(['checkout', '-q', repo.trunk])
      put(repo.dir, 'src/other.mjs', 'export const other = 3\n')
      repo.git(['add', '--', 'src/other.mjs'])
      repo.git(['commit', '-q', '--no-verify', '-m', 'someone else'])
      const tipBefore = repo.git(['rev-parse', 'HEAD']).trim()

      // Дом данных демона — там же, где он лежит у живого демона: СНАРУЖИ репозитория.
      const dataDir = join(repo.home, 'data')
      const landing = createLanding({
        cwd: repo.dir,
        dataDir,
        // Настоящий прогонятель посадки; подделан только запуск дочернего процесса.
        runSuite: (call: any) =>
          runFullSuiteAsync({
            ...call,
            exists: () => true,
            resolveEntry: () => join(repo.home, 'suite-entry.mjs'),
            spawn: fakeSuiteSpawn(redReport(), 'вывод красного прогона\n'),
          }),
      })

      const merged: any = await runMerge({
        branch: 'wt/R-red',
        by: 'landing-case',
        cwd: repo.dir,
        claimsDir: repo.claimsDir,
        journalDir: repo.journalDir,
        runTests: landing.runTests,
      })

      expect(merged.merged).toBe(false)
      expect(merged.testsPassed).toBe(false)
      expect(repo.git(['rev-parse', 'HEAD']).trim(), 'вершина двинулась на красном прогоне').toBe(tipBefore)

      // (г) КВИТАНЦИЯ НЕСЁТ ПУТЬ И ИМЕНА…
      const receipt = merged.receipt
      expect(receipt.savedReport, JSON.stringify(receipt)).toBeTruthy()
      expect(String(receipt.savedReport)).toContain('R-red')
      expect(receipt.failedTest).toContain('landing.test.ts')
      expect(receipt.failedTests.length).toBeGreaterThan(1)
      expect(receipt.reason, 'путь к отчёту сказан словами отказа').toContain(receipt.savedReport)

      // …И ПУТЬ СУЩЕСТВУЕТ ПОСЛЕ ОТКАЗА. Слияние откачено, дерево вернулось на место —
      // а объяснение отказа лежит снаружи и открывается.
      expect(repo.git(['status', '--porcelain']).trim()).toBe('')
      expect(existsSync(receipt.savedReport), 'отчёт отказанной посадки исчез вместе с отказом').toBe(true)
      expect(existsSync(receipt.savedLog)).toBe(true)
      expect(JSON.parse(readFileSync(receipt.savedReport, 'utf8')).numFailedTests).toBe(2)
    } finally {
      rmSync(repo.home, { recursive: true, force: true })
    }
  }, 120000)
})

describe('маркер версии: косметика возвращается, настоящая смена — нет', () => {
  it('разница только в конце строки названа косметикой', () => {
    expect(versionMarkerIsCosmetic('1.0.0\r\n', '1.0.0\n')).toBe(true)
  })

  it('разница в самой версии косметикой НЕ названа — это выпуск, а не замер', () => {
    expect(versionMarkerIsCosmetic('1.0.0\n', '1.1.0\n')).toBe(false)
  })

  it('одинаковые байты не считаются правкой вовсе', () => {
    expect(versionMarkerIsCosmetic('1.0.0\n', '1.0.0\n')).toBe(false)
  })
})
