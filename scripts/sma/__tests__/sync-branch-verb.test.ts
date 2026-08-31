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
