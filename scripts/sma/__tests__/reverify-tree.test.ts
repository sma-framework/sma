/**
 * `reverify --tree <path>` — re-verification measures the tree it was POINTED AT.
 *
 * WHY THIS FILE EXISTS. The exit gate of the worker loop re-verifies a worker's own
 * working copy: it takes one picture before the worker is spawned and one after, and
 * charges the attempt with the DIFFERENCE. That is worthless if both pictures are of
 * somebody else's tree — and that is exactly what happened. The gate handed the verb a
 * `cwd` inside the copy, but the verb derives the root of the recipe walk from the shared
 * `.git` (`git rev-parse --git-common-dir`), which in a linked worktree points at the MAIN
 * checkout. So both snapshots described the main tree, the difference was empty by
 * construction, and a worker who committed a knowingly divergent receipt still got a green
 * gate. Computed, but never wired.
 *
 * The shared root is NOT a bug — sessions, claims and the calibration ledger are supposed
 * to live in one place across worktrees. So the fix is an explicit mode, and this file
 * guards both halves of it:
 *   - Case 1: WITH the flag the walk covers the named tree — a receipt that exists only in
 *     the copy shows up in `records[]`.
 *   - Case 2: WITHOUT the flag today's contract is unchanged — that same receipt is
 *     invisible from inside the copy, because the root still travels through the shared
 *     `.git` to the main checkout. This is the behaviour sessions and claims stand on.
 *   - Case 3: the flag moves the RECIPE WALK, not the bookkeeping — no `.sma` appears
 *     inside the named tree; ledger writes still land in the shared root.
 *
 * NO FAKES OF THE ROOT RESOLVER. A fake that answers a question the library never asks is
 * how a green suite hides a dead wire, so this test builds a real repository with `git
 * init`, a real linked copy with `git worktree add`, and spawns the real CLI. The only env
 * touch is DELETING an override that a developer's shell may carry — the resolver runs for
 * real.
 *
 * The fixture recipes are deliberately OFF the safe-command allowlist: they score
 * 'skipped-unsafe' and nothing is ever executed. Their presence in `records[]` is the whole
 * measurement — it says which tree was walked, at zero cost and with zero side effects.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

/** A SUMMARY carrying exactly one receipt whose command is NOT on the allowlist. */
function summaryWith(id: string): string {
  return [
    '---',
    'phase: 1',
    'receipts:',
    `  - id: ${id}`,
    `    assertion: fixture receipt named ${id}`,
    '    check_command: echo which-tree-was-walked',
    '    expected_sha256: ' + 'a'.repeat(64),
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n')
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Run the real CLI. A non-zero exit is captured, never thrown — the verdict is the output. */
function runCli(args: string[], cwd: string): { stdout: string; status: number } {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SMA_ROOT_OVERRIDE // let the REAL resolver run; nothing else is touched
  try {
    const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: env as NodeJS.ProcessEnv })
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
  }
}

/** The receipt ids the verb reported, parsed from its --json line. */
function idsOf(stdout: string): string[] {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  if (!line) return []
  const parsed = JSON.parse(line)
  return (parsed.records ?? []).map((r: any) => r.id)
}

let sandbox: string
let mainTree: string
let copyTree: string
let withFlag: { stdout: string; status: number }
let withoutFlag: { stdout: string; status: number }

describe('перепроверка меряет НАЗВАННОЕ дерево, а общий корень остаётся общим', () => {
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sma-reverify-tree-'))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')

    // ── a real repository with a real receipt of its own
    mkdirSync(join(mainTree, '.planning', 'phases', '01-fixture'), { recursive: true })
    git(['init', '-b', 'main'], mainTree)
    git(['config', 'user.email', 'fixture@example.invalid'], mainTree)
    git(['config', 'user.name', 'Fixture'], mainTree)
    writeFileSync(join(mainTree, '.planning', 'phases', '01-fixture', '01-01-SUMMARY.md'), summaryWith('R-MAIN'))
    git(['add', '.planning'], mainTree)
    git(['commit', '-m', 'fixture: receipt that lives in the main checkout'], mainTree)

    // ── a real linked working copy, exactly the shape a worker gets
    git(['worktree', 'add', '-b', 'copy', copyTree], mainTree)
    writeFileSync(join(copyTree, '.planning', 'phases', '01-fixture', '01-02-SUMMARY.md'), summaryWith('R-COPY'))
    git(['add', '.planning'], copyTree)
    git(['commit', '-m', 'fixture: receipt that exists only in the copy'], copyTree)

    withFlag = runCli(['reverify', '--json', '--tree', copyTree], copyTree)
    withoutFlag = runCli(['reverify', '--json'], copyTree)
  }, 60_000)

  afterAll(() => {
    try {
      git(['worktree', 'remove', '--force', copyTree], mainTree)
    } catch {
      /* the sandbox is deleted wholesale below — a stale registration harms nobody */
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
  })

  it('с флагом --tree обход идёт по названному дереву: видна запись, которой есть только в копии', () => {
    const ids = idsOf(withFlag.stdout)
    expect(ids, 'верб не назвал ни одной записи — обход не состоялся').not.toEqual([])
    expect(ids).toContain('R-COPY')
    expect(ids).toContain('R-MAIN') // копия несёт и унаследованную запись — дерево целиком
  })

  it('без флага корень по-прежнему уезжает через общий .git в главный чекаут', () => {
    const ids = idsOf(withoutFlag.stdout)
    expect(ids).toContain('R-MAIN')
    expect(ids, 'старый контракт сломан: на нём стоят сессии и claim-ы').not.toContain('R-COPY')
  })

  it('флаг двигает обход рецептов, а не бухгалтерию: .sma не переезжает в названное дерево', () => {
    expect(existsSync(join(copyTree, '.sma')), 'служебный каталог завёлся внутри рабочей копии').toBe(false)
    expect(existsSync(join(mainTree, '.sma')), 'записи леджера не доехали до общего корня').toBe(true)
  })
})

/**
 * Сквозной провод: настоящее расхождение структурной перепроверки рождает черновик урока,
 * а повтор его не удваивает.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ КЕЙСОВ НА СЧЁТЧИК ВЫЗОВОВ. Счётчик обращений к подделке сочинителя
 * доказывает решение — «на новое расхождение зовём, на повторное нет». Он не доказывает,
 * что настоящий верб настоящего продукта этот шаг зовёт, что каталог черновиков берётся
 * от измеряемого дерева и что путь появившегося файла виден в выводе. Ровно этот класс —
 * «вычислено, но не подключено» — стоил этому дереву дня работы, поэтому здесь запускается
 * НАСТОЯЩИЙ процесс над настоящим репозиторием, без единой подделки.
 *
 * Рецепт фикстуры НАРОЧНО на allowlist (`node scripts/sma/…`) и НАРОЧНО с заведомо чужим
 * ожидаемым хешем: команда печатает одну строку, расхождение получается настоящим, а цена
 * прогона — один короткий процесс.
 */
describe('расхождение перепроверки рождает черновик урока, и ровно один', () => {
  let tree: string
  let first: { stdout: string; status: number }
  let second: { stdout: string; status: number }

  const draftsDir = () => join(tree, '.claude', 'memory', 'drafts')
  const drafts = () => (existsSync(draftsDir()) ? readdirSync(draftsDir()) : [])

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'sma-draft-from-divergence-'))
    mkdirSync(join(tree, 'scripts', 'sma'), { recursive: true })
    writeFileSync(join(tree, 'scripts', 'sma', 'print-one.mjs'), "process.stdout.write('1\\n')\n")
    mkdirSync(join(tree, '.planning', 'phases', '01-fixture'), { recursive: true })
    writeFileSync(
      join(tree, '.planning', 'phases', '01-fixture', '01-01-SUMMARY.md'),
      [
        '---',
        'phase: 1',
        'receipts:',
        '  - id: R-DRIFT',
        '    assertion: the fixture command reproduces its pinned observation',
        '    check_command: node scripts/sma/print-one.mjs',
        '    expected_sha256: ' + 'a'.repeat(64),
        '    hash_stdout: true',
        '---',
        '',
        '# fixture',
        '',
      ].join('\n'),
    )
    git(['init', '-b', 'main'], tree)
    git(['config', 'user.email', 'fixture@example.invalid'], tree)
    git(['config', 'user.name', 'Fixture'], tree)
    git(['add', '.'], tree)
    git(['commit', '-m', 'fixture: a receipt whose pinned observation no longer holds'], tree)

    first = runCli(['reverify'], tree)
    second = runCli(['reverify'], tree)
  }, 120_000)

  afterAll(() => {
    rmSync(tree, { recursive: true, force: true, maxRetries: 3 })
  })

  it('первый прогон: расхождение названо, черновик рождён, путь напечатан', () => {
    expect(first.status, 'расхождение не сделало верб красным').toBe(1)
    expect(first.stdout).toContain('divergent')
    expect(drafts(), 'черновик не появился — обход не позвал сочинителя').toHaveLength(1)
    expect(drafts()[0]).toMatch(/^bug-lesson-.*R-DRIFT\.md$/)
    expect(first.stdout, 'путь черновика не напечатан — он потеряется для квитанции').toContain('черновик')
    expect(first.stdout).toContain(drafts()[0])
  })

  it('повтор того же расхождения не удваивает: ни второго файла, ни второго вызова', () => {
    expect(second.status).toBe(1)
    expect(drafts(), 'повторное расхождение размножило черновики').toHaveLength(1)
    expect(second.stdout, 'сочинитель позван повторно — залп по всему леджеру только вопрос времени').not.toContain('черновик')
  })

  it('черновик не в корпусе: он лежит в drafts/, откуда индекс его не берёт', () => {
    expect(existsSync(join(tree, '.claude', 'memory', 'MEMORY.md'))).toBe(false)
    expect(readdirSync(join(tree, '.claude', 'memory'))).toEqual(['drafts'])
  })
})
