/**
 * `sync-branch` — ДВЕРЬ СДАЮЩЕГО, ПРОВЕРЕННАЯ КАК ДВЕРЬ, А НЕ КАК ФУНКЦИЯ.
 *
 * Рядом уже лежит сьют самого ритуала (`branch-sync.test.ts`) — на инъецированных швах, без
 * настоящего git. Он остался бы зелёным ровно в том случае, ради которого верб и появился:
 * ритуал безупречен, а работнику его нечем позвать. Поэтому здесь запускается НАСТОЯЩИЙ CLI
 * по НАСТОЯЩЕМУ временному репозиторию, и утверждается то, что увидит работник: код выхода,
 * граф коммитов на диске и слова, которыми верб называет спор.
 *
 * ЗАЧЕМ ВЕРБ ВООБЩЕ. Работник спавнится с отказом `Bash(git merge:*)` в аргументах запуска —
 * слияние есть решение человека, инвариант флота. Пока договор сдачи требовал прогнать
 * `git merge --no-ff --no-commit main`, он требовал невозможного: жёсткая граница отказывала
 * вызову, мягкая ставила его на парковку, где он умирал по сроку ожидания человека. Верб зовёт
 * ритуал ВНУТРИ СЕБЯ: через оболочку `git merge` не проходит, и ни одна граница не ослаблена.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dirname, '..', 'cli.mjs')

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

const git = (args: string[], cwd: string) =>
  String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')

/** Запуск верба так, как его запустит работник: своей копией как рабочим каталогом. */
const runVerb = (args: string[], cwd: string) => {
  try {
    const stdout = String(execFileSync(process.execPath, [CLI, 'sync-branch', ...args], { cwd, encoding: 'utf8' }) || '')
    return { code: 0, stdout, stderr: '' }
  } catch (err: any) {
    return { code: err.status ?? 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
  }
}

/**
 * Копия работника: настоящий репозиторий, ветка задачи отведена от вершины — и вершина УЕХАЛА
 * вперёд, пока работник работал. Совпадающий путь в обеих правках даёт конфликт.
 */
const makeCopy = (trunkEdit: Record<string, string>, branchEdit: Record<string, string>, seed: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'sma-syncverb-'))
  tmpDirs.push(dir)
  git(['init', '-q', '.'], dir)
  git(['config', 'user.email', 'verb@test'], dir)
  git(['config', 'user.name', 'verb'], dir)
  git(['config', 'core.autocrlf', 'false'], dir)

  for (const [p, body] of Object.entries(seed)) writeFileSync(join(dir, p), body, 'utf8')
  git(['add', ...Object.keys(seed)], dir)
  git(['commit', '-qm', 'база'], dir)
  git(['branch', '-M', 'main'], dir)

  git(['checkout', '-q', '-b', 'wt/T-1'], dir)
  for (const [p, body] of Object.entries(branchEdit)) writeFileSync(join(dir, p), body, 'utf8')
  git(['add', ...Object.keys(branchEdit)], dir)
  git(['commit', '-qm', 'работа работника'], dir)

  git(['checkout', '-q', 'main'], dir)
  for (const [p, body] of Object.entries(trunkEdit)) writeFileSync(join(dir, p), body, 'utf8')
  git(['add', ...Object.keys(trunkEdit)], dir)
  git(['commit', '-qm', 'соседняя работа, принятая раньше'], dir)

  git(['checkout', '-q', 'wt/T-1'], dir)
  return dir
}

/** Стала ли вершина предком ветки — сведена ли она ПО-НАСТОЯЩЕМУ, а не на словах. */
const trunkIsAncestor = (dir: string) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'wt/T-1'], { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('sync-branch — вершина входит в ветку в копии сдающего', () => {
  it('вершина уехала, конфликта нет → ветка сведена, вершина стала предком', () => {
    const dir = makeCopy({ 'neighbour.txt': 'работа соседа\n' }, { 'mine.txt': 'моя работа\n' }, {
      'neighbour.txt': 'пусто\n',
      'mine.txt': 'пусто\n',
    })
    expect(trunkIsAncestor(dir)).toBe(false)

    const res = runVerb(['--json'], dir)
    expect(res.code).toBe(0)
    const said = JSON.parse(res.stdout)
    expect(said).toMatchObject({ trunk: 'main', ok: true, synced: true, behind: 1 })
    expect(trunkIsAncestor(dir)).toBe(true)
    // работа соседа приехала в копию вместе с вершиной
    expect(readFileSync(join(dir, 'neighbour.txt'), 'utf8')).toContain('работа соседа')
  })

  it('абзац дописан обеими сторонами в один README → развелось БЕЗ человека, оба абзаца целы', () => {
    const dir = makeCopy(
      { 'README.md': '# README\n\nабзац соседней работы\n' },
      { 'README.md': '# README\n\nабзац моей работы\n' },
      { 'README.md': '# README\n' },
    )
    const res = runVerb([], dir)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('README.md (union)')
    expect(trunkIsAncestor(dir)).toBe(true)

    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('абзац моей работы')
    expect(readme).toContain('абзац соседней работы')
    expect(readme).not.toContain('<<<<<<<')
  })

  /**
   * САМЫЙ ЧАСТЫЙ КОНФЛИКТ ЭТОГО ДОМА, И ДО ЭТОГО ЗАМКА ОН УЕЗЖАЛ ЧЕЛОВЕКУ ВСЕГДА.
   *
   * Всякая работа перед сдачей перештамповывает бейдж прогона: одну строку в каждом README и
   * всю квитанцию. Это правка СУЩЕСТВУЮЩЕЙ строки, то есть непустая база, а склейка на непустой
   * базе отказывала НА ВЕСЬ ФАЙЛ — вместе с честно дописанными абзацами, ради которых класс
   * `union` и заведён. Здесь оба спора лежат в одном README, и оба обязаны развестись сами:
   * абзацы — оставшись обоими, число — взятым со стороны ВЕРШИНЫ и НАЗВАННЫМ устаревшим.
   *
   * ПОЧЕМУ СТОРОНА ВЕРШИНЫ, А НЕ СВОЯ. Здесь main въезжает В ВЕТКУ, и «своя» сторона — это
   * сторона ветки. Пока бралась она, число в ветке оставалось своим, вершина уезжала дальше, и
   * ТА ЖЕ строка конфликтовала снова на каждом следующем движении main — замерено 02.09.2026
   * двумя отказанными посадками подряд. Сторона вершины разрывает круг: после сведения строка
   * равна строке в main, спорить ей не с чем, а свежее число появится от перештамповки.
   */
  it('обе стороны перештамповали бейдж прогона → README сведён целиком, а устаревшее число названо', () => {
    const badge = (n: number) =>
      `  <img src="https://img.shields.io/badge/tests-${n}%2F${n}-3CC0A0" alt="tests ${n}/${n}">`
    // Между бейджем и разделом абзацев — рукописная проза: git разводит их РАЗНЫМИ секциями,
    // как в живом README, а не одной на весь файл.
    const readme = (n: number, tail: string[]) =>
      ['# README', '', badge(n), '', 'Раздел про установку.', '', 'Раздел про запуск.', '',
        'Раздел про приёмку.', '', 'Раздел про память.', '', '## Что нового', '', ...tail, ''].join('\n')
    const receipt = (n: number) => `${JSON.stringify({ tests: n, files: 277, commit: 'aaaaaaa' }, null, 2)}\n`

    const dir = makeCopy(
      { 'README.md': readme(6100, ['- абзац соседней работы']), 'test-receipt.json': receipt(6100) },
      { 'README.md': readme(6156, ['- абзац моей работы']), 'test-receipt.json': receipt(6156) },
      { 'README.md': readme(6054, []), 'test-receipt.json': receipt(6054) },
    )

    const res = runVerb([], dir)
    expect(res.code).toBe(0)
    expect(trunkIsAncestor(dir)).toBe(true)

    const out = readFileSync(join(dir, 'README.md'), 'utf8')
    expect(out).toContain('- абзац моей работы')
    expect(out).toContain('- абзац соседней работы')
    expect(out).not.toContain('<<<<<<<')
    // Сторона вершины — не как правая, а как одна из двух одинаково устаревших: та из двух,
    // с которой этой строке больше не с чем спорить на следующем движении main.
    expect(out).toContain('tests-6100')
    // Квитанция и её проекция взяты С ОДНОЙ стороны: разойдясь, они соврали бы `badge --check`.
    expect(readFileSync(join(dir, 'test-receipt.json'), 'utf8')).toContain('6100')
    // И ГЛАВНОЕ: устаревшее число не выдано за свежее — перештамповка названа человеку.
    expect(res.stdout).toContain('npm run badge')
    expect(res.stdout).toContain('test-receipt.json (measured)')
  })

  it('настоящий спор → отказ, ФАЙЛ НАЗВАН, и дерево не осталось в половинчатом слиянии', () => {
    const dir = makeCopy({ 'engine.txt': 'строка вершины\n' }, { 'engine.txt': 'строка работника\n' }, {
      'engine.txt': 'исходная строка\n',
    })
    const res = runVerb([], dir)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('engine.txt')
    expect(trunkIsAncestor(dir)).toBe(false)
    // Половинчатое слияние опаснее несведённой ветки: оно выглядит готовым.
    expect(git(['status', '--porcelain'], dir).includes('UU ')).toBe(false)
  })

  it('--check ничего не меняет и говорит, на сколько ветка отстала', () => {
    const dir = makeCopy({ 'neighbour.txt': 'работа соседа\n' }, { 'mine.txt': 'моя работа\n' }, {
      'neighbour.txt': 'пусто\n',
      'mine.txt': 'пусто\n',
    })
    const before = git(['rev-parse', 'HEAD'], dir).trim()

    const behind = runVerb(['--check', '--json'], dir)
    expect(behind.code).toBe(1) // сводить есть что
    expect(JSON.parse(behind.stdout)).toMatchObject({ trunk: 'main', behind: 1, synced: false, checked: true })
    expect(git(['rev-parse', 'HEAD'], dir).trim()).toBe(before) // проверка НЕ сводит

    expect(runVerb([], dir).code).toBe(0)
    const after = runVerb(['--check'], dir)
    expect(after.code).toBe(0)
    expect(after.stdout).toContain('сводить нечего')
  })
})

/**
 * `--keep` И `--abort` — ОБЯЗАННОСТЬ, У КОТОРОЙ ПОЯВИЛОСЬ ЧЕМ ЕЁ ИСПОЛНИТЬ.
 *
 * Отказ выше говорит верно: «разведите спор САМИ — вы знаете, что писали». Но откат уносил
 * разметку конфликта, а `git merge` работнику отказан конвертом возможностей — то есть
 * развести было НЕЧЕМ, и договор сдачи снова становился текстом. Здесь запирается вся дорога
 * целиком, настоящим CLI по настоящему репозиторию: спор остаётся размеченным, работник
 * доводит его разрешёнными глаголами, вершина оказывается в родителях — и из того же
 * состояния есть выход, если он передумал.
 */
describe('sync-branch --keep / --abort — развести спор своими руками, не выходя из конверта', () => {
  it('--keep оставляет спор в дереве, называет файл, и работник доводит слияние сам', () => {
    const dir = makeCopy(
      { 'engine.txt': 'строка вершины\n', 'README.md': '# README\n\nабзац соседней работы\n' },
      { 'engine.txt': 'строка работника\n', 'README.md': '# README\n\nабзац моей работы\n' },
      { 'engine.txt': 'исходная строка\n', 'README.md': '# README\n' },
    )

    const res = runVerb(['--keep'], dir)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('engine.txt')
    expect(res.stderr).toContain('спор ОСТАВЛЕН')
    // Спор действительно РАЗМЕЧЕН в дереве — иначе разводить было бы нечего.
    expect(git(['status', '--porcelain'], dir)).toContain('U engine.txt')
    expect(readFileSync(join(dir, 'engine.txt'), 'utf8')).toContain('<<<<<<<')
    // …а механическая половина уже разведена и лежит в индексе: доводить остаётся спорное.
    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('абзац моей работы')
    expect(readme).toContain('абзац соседней работы')
    expect(readme).not.toContain('<<<<<<<')

    // Работник разводит спор ТЕМИ ГЛАГОЛАМИ, которые ему разрешены, и слияние закрывается.
    writeFileSync(join(dir, 'engine.txt'), 'строка вершины и работника\n', 'utf8')
    git(['add', '--', 'engine.txt'], dir)
    git(['commit', '--no-edit'], dir)
    expect(trunkIsAncestor(dir)).toBe(true)
    expect(runVerb(['--check'], dir).stdout).toContain('сводить нечего')
  })

  it('--abort выходит из оставленного слияния: вершина не приехала, дерево целое', () => {
    const dir = makeCopy({ 'engine.txt': 'строка вершины\n' }, { 'engine.txt': 'строка работника\n' }, {
      'engine.txt': 'исходная строка\n',
    })
    const before = git(['rev-parse', 'HEAD'], dir).trim()
    expect(runVerb(['--keep'], dir).code).toBe(1)
    expect(git(['status', '--porcelain'], dir)).toContain('U engine.txt')

    const out = runVerb(['--abort'], dir)
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('отменено')
    expect(git(['status', '--porcelain'], dir)).not.toContain('U engine.txt')
    expect(git(['rev-parse', 'HEAD'], dir).trim()).toBe(before)
    expect(trunkIsAncestor(dir)).toBe(false)
    expect(readFileSync(join(dir, 'engine.txt'), 'utf8')).toBe('строка работника\n')
  })

  it('отменять нечего → это факт о дереве, а не отказ', () => {
    const dir = makeCopy({ 'neighbour.txt': 'работа соседа\n' }, { 'mine.txt': 'моя работа\n' }, {
      'neighbour.txt': 'пусто\n',
      'mine.txt': 'пусто\n',
    })
    const out = runVerb(['--abort'], dir)
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('отменять нечего')
  })

  it('обычный отказ НАЗЫВАЕТ дверь, которой спор разводят, — совет исполним', () => {
    const dir = makeCopy({ 'engine.txt': 'строка вершины\n' }, { 'engine.txt': 'строка работника\n' }, {
      'engine.txt': 'исходная строка\n',
    })
    const res = runVerb([], dir)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('sync-branch --keep')
  })
})
