/**
 * `worktree remove` — убирая копию, нельзя провалиться в основное дерево.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Провизия подключает зависимости копии ССЫЛКОЙ на
 * каталоги основного дерева (junction на Windows, каталожный симлинк на POSIX) —
 * копия перестала стоить две-три минуты установки. Ровно этим она стала опасной для
 * уборки: измерено на этой машине, дважды, с `--force` и без него — `git worktree
 * remove`, встретив ссылку внутри копии, ИДЁТ ПО НЕЙ и опустошает КАТАЛОГ-ЦЕЛЬ.
 * То есть команда, которая должна убрать временную копию, вместо этого стирает
 * зависимости основного дерева разработчика. Node-овские `rmdirSync(ссылка)` и
 * `rmSync(копия, {recursive})` цель не трогают — они снимают саму ссылку.
 *
 * Отсюда единственный допустимый порядок уборки: СНЯТЬ ВСЕ ССЫЛКИ ВНУТРИ КОПИИ →
 * посмотреть, что будет стёрто (`git status --porcelain`) → и только потом отдать
 * копию git. Порядок здесь не вежливость: перевёрнутый, он уничтожает то, на что
 * копия ссылалась. Главный кейс файла (первый) утверждает ровно один факт — файл в
 * каталоге-цели существует ПОСЛЕ уборки.
 *
 * ПОЧЕМУ НАСТОЯЩИЙ GIT, А НЕ ПОДДЕЛКА. Соседний сьют (`worktree.test.ts`) гоняет
 * библиотеку через записывающую подделку и отвечает за порядок вызовов и явный cwd —
 * для тех вопросов это правильная форма. Для этих — неправильная: «прошёл ли git по
 * ссылке», «уцелела ли цель», «снялась ли ветка» — вопросы, на которые может ответить
 * только настоящий репозиторий. Подделка, отвечающая «да» на все три, — это и есть
 * зелёный сьют поверх мёртвого провода. Каждый кейс ниже делает `git init`, настоящий
 * `git worktree add` и запускает настоящий CLI во временном репозитории.
 *
 * ГДЕ ЭТО ВЫПОЛНЯЕТСЯ. Только в одноразовых песочницах `mkdtemp`, которые файл создаёт
 * сам и сам же уносит. Ни одна рабочая копия разработчика не участвует — негативный
 * контроль (кейс «сырой git») ПО ЗАМЫСЛУ разрушителен, и цель, которую он стирает,
 * он же и создал.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')
const IS_WIN = process.platform === 'win32'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Run the real CLI. A non-zero exit is captured, never thrown — the verdict is the output. */
function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SMA_ROOT_OVERRIDE // let the REAL root resolver run; nothing else is overridden
  env.SMA_DISABLE_SNAPSHOT_SPAWN = '1' // no detached reporter child out of a temp repository
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
      status: typeof err.status === 'number' ? err.status : 1,
    }
  }
}

/** The verb's answer: the LAST line of stdout that is a JSON object (the caller's contract). */
function lastJson(stdout: string): any {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  if (!line) return null
  return JSON.parse(line)
}

/** Path comparison that survives Windows' case-insensitive, backslash-separated paths. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '')
    return IS_WIN ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

function write(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

/**
 * A sandbox whose path is already in its LONG form. On Windows `os.tmpdir()` hands back
 * the 8.3 short name (`C:\Users\JUNISA~1\…`) while git records the long one; comparing
 * the two as strings would make a legitimate copy look like an unregistered path.
 */
function makeSandbox(tag: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), tag)))
}

/** A repository with a first commit — `git worktree add` needs one. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'fixture@example.invalid'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
}

/**
 * The project shape that makes this whole file necessary: the dependency tree lives
 * OUTSIDE git, so provisioning links it instead of installing it, and the link is what
 * the cleanup must not walk into.
 */
function seedProject(mainTree: string): void {
  initRepo(mainTree)
  write(join(mainTree, '.gitignore'), ['node_modules/', ''].join('\n'))
  write(join(mainTree, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  write(join(mainTree, 'README.md'), '# tracked\n')
  git(['add', '.gitignore', 'README.md'], mainTree)
  git(['commit', '-m', 'fixture: dependencies live outside git'], mainTree)
}

/**
 * Unhook every link inside a tree, depth-first, WITHOUT following any of them.
 * `rmdirSync` on a junction/symlink removes the LINK; the target is untouched.
 */
function dropLinks(dir: string): void {
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const it of items) {
    const p = join(dir, it.name)
    if (it.isSymbolicLink()) {
      try {
        rmdirSync(p)
      } catch {
        try {
          unlinkSync(p)
        } catch {
          /* a link we cannot drop: the sandbox is removed wholesale below */
        }
      }
    } else if (it.isDirectory()) {
      dropLinks(p)
    }
  }
}

/** Teardown in the only safe order: links first, then git, then the sandbox. */
function teardown(sandbox: string, mainTree: string, copyTree: string): void {
  try {
    dropLinks(copyTree)
  } catch {
    /* nothing linked */
  }
  try {
    git(['worktree', 'remove', '--force', copyTree], mainTree)
  } catch {
    /* the sandbox goes away wholesale below — a stale registration harms nobody */
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
}

/** The `unlinked[]` record for one link, or undefined. */
function unlinkedFor(json: any, path: string): any {
  const list = Array.isArray(json && json.unlinked) ? json.unlinked : []
  return list.find((r: any) => r && String(r.path).replace(/\\/g, '/') === path)
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The whole point: the link's target survives the cleanup, and the task branch
//    goes away with a trace of where it stood.
// ─────────────────────────────────────────────────────────────────────────────
describe('уборка копии со ссылкой не достаёт до основного дерева и снимает ветку задачи', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let json: any
  let out: { stdout: string; stderr: string; status: number }

  beforeAll(() => {
    sandbox = makeSandbox('sma-wt-clean-')
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    seedProject(mainTree)

    const prov = runCli(['worktree', 'provision', '--branch', 'wt/cleanup', '--path', copyTree, '--json'], mainTree)
    if (prov.status !== 0) throw new Error(`провизия упала: ${prov.stderr}`)
    if (!lstatSync(join(copyTree, 'node_modules')).isSymbolicLink()) {
      throw new Error('в копии нет ссылки — кейс потерял свой предмет')
    }

    out = runCli(['worktree', 'remove', copyTree, '--force', '--delete-branch', '--json'], mainTree)
    json = lastJson(out.stdout)
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('цель ссылки цела: зависимости основного дерева на месте после уборки', () => {
    expect(
      existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js')),
      'уборка копии прошла по ссылке и опустошила каталог основного дерева',
    ).toBe(true)
  })

  it('верб отвечает успехом и перечисляет снятые ссылки', () => {
    expect(out.status, `верб упал: ${out.stderr}`).toBe(0)
    expect(json, 'верб не напечатал JSON последней строкой').toBeTruthy()
    expect(json.ok).toBe(true)
    expect(samePath(json.removed, copyTree)).toBe(true)
    const deps = unlinkedFor(json, 'node_modules')
    expect(deps, `в ответе нет записи о снятой ссылке: ${JSON.stringify(json.unlinked)}`).toBeTruthy()
    expect(samePath(deps.target, join(mainTree, 'node_modules')), `цель: ${deps.target}`).toBe(true)
    expect(json.forced).toBe(true)
    expect(json.fallback).toBeFalsy()
  })

  it('копия исчезла с диска и из списка деревьев', () => {
    expect(existsSync(copyTree)).toBe(false)
    expect(git(['worktree', 'list', '--porcelain'], mainTree)).not.toContain('copy')
  })

  it('ветка задачи удалена, а её вершина записана — откат возможен по reflog', () => {
    expect(json.branch).toBe('wt/cleanup')
    expect(json.branchDeleted).toBe(true)
    expect(String(json.branchTip)).toMatch(/^[0-9a-f]{40}$/)
    expect(git(['branch', '--list', 'wt/cleanup'], mainTree).trim()).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. Negative control. Not a test of our code — a test of the PLATFORM, and the
//    reason the order above is mandatory. If a future git stops walking into the
//    link, this case goes red and says so; that is a fact worth being told about.
// ─────────────────────────────────────────────────────────────────────────────
describe('негативный контроль платформы', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let survived: boolean | null = null

  beforeAll(() => {
    if (!IS_WIN) return
    sandbox = makeSandbox('sma-wt-raw-')
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    seedProject(mainTree)

    const prov = runCli(['worktree', 'provision', '--branch', 'wt/control', '--path', copyTree, '--json'], mainTree)
    if (prov.status !== 0) throw new Error(`провизия упала: ${prov.stderr}`)

    // ДЕЛАЕМ ИМЕННО ТО, ЧТО ДЕЛАТЬ НЕЛЬЗЯ — без снятия ссылок. Разрушается только та
    // цель, которую этот же кейс минуту назад создал у себя в песочнице.
    try {
      git(['worktree', 'remove', '--force', copyTree], mainTree)
    } catch {
      /* даже отказ git — материал: тогда цель обязана уцелеть */
    }
    survived = existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js'))
  }, 60_000)

  afterAll(() => {
    if (sandbox) teardown(sandbox, mainTree, copyTree)
  })

  const itWin = IS_WIN ? it : it.skip
  itWin('сырой git worktree remove идёт по ссылке и опустошает каталог-цель', () => {
    expect(
      survived,
      'git на этой машине больше НЕ ходит по ссылке — порядок «снять ссылки → remove» можно пересмотреть, но не молча',
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. Грязная копия: git отказывается без `--force`, и это не должно превращаться
//    в скрытое удаление. Со `--force` — ответ обязан перечислить, что было стёрто.
// ─────────────────────────────────────────────────────────────────────────────
describe('грязная копия: отказ без --force, перечисленные потери с ним', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let soft: any
  let hard: any
  // Снято сразу после отказа: оба прогона идут в подготовке, и к моменту проверок
  // копии уже нет — вопрос «уцелела ли она при ОТКАЗЕ» отвечается только на месте.
  let survivedRefusal: boolean | null = null

  beforeAll(() => {
    sandbox = makeSandbox('sma-wt-dirty-')
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    seedProject(mainTree)

    const prov = runCli(['worktree', 'provision', '--branch', 'wt/dirty', '--path', copyTree, '--json'], mainTree)
    if (prov.status !== 0) throw new Error(`провизия упала: ${prov.stderr}`)

    // След установки, который работник оставляет в копии: git считает его потерей.
    write(join(copyTree, 'package-lock.json'), '{"lockfileVersion":3}\n')

    soft = lastJson(runCli(['worktree', 'remove', copyTree, '--json'], mainTree).stdout)
    survivedRefusal = existsSync(copyTree)
    hard = lastJson(runCli(['worktree', 'remove', copyTree, '--force', '--json'], mainTree).stdout)
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('без --force верб отказывает, но ссылки уже сняты — и он это говорит', () => {
    expect(soft.ok).toBe(false)
    expect(String(soft.message).length).toBeGreaterThan(0)
    expect(unlinkedFor(soft, 'node_modules'), 'отказ умолчал о снятых ссылках').toBeTruthy()
    expect(survivedRefusal, 'отказ всё-таки удалил копию').toBe(true)
  })

  it('со --force уборка проходит и называет, что было стёрто', () => {
    expect(hard.ok).toBe(true)
    expect(hard.forced).toBe(true)
    expect(
      (hard.dirtyFiles || []).some((f: string) => String(f).includes('package-lock.json')),
      `dirtyFiles: ${JSON.stringify(hard.dirtyFiles)}`,
    ).toBe(true)
    expect(existsSync(copyTree)).toBe(false)
  })

  it('и здесь цель ссылки цела', () => {
    expect(existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. Отказы. Ошибка в аргументе не должна стоить основного дерева, поэтому
//    проверка идёт ДО любого удаления — включая снятие ссылок.
// ─────────────────────────────────────────────────────────────────────────────
describe('верб отказывается убирать основное дерево и незарегистрированный путь', () => {
  let sandbox: string
  let mainTree: string
  let stranger: string
  let onMain: any
  let onStranger: any

  beforeAll(() => {
    sandbox = makeSandbox('sma-wt-refuse-')
    mainTree = join(sandbox, 'main')
    stranger = join(sandbox, 'not-a-worktree')
    seedProject(mainTree)
    write(join(stranger, 'важное.txt'), 'чужой каталог\n')

    onMain = lastJson(runCli(['worktree', 'remove', mainTree, '--force', '--json'], mainTree).stdout)
    onStranger = lastJson(runCli(['worktree', 'remove', stranger, '--force', '--json'], mainTree).stdout)
  }, 60_000)

  afterAll(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }))

  it('основное дерево не убирается и остаётся целым', () => {
    expect(onMain.ok).toBe(false)
    expect(String(onMain.message)).toMatch(/основно/i)
    expect(existsSync(join(mainTree, 'README.md'))).toBe(true)
    expect(existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })

  it('каталог, не зарегистрированный как копия этого репозитория, не трогается', () => {
    expect(onStranger.ok).toBe(false)
    expect(existsSync(join(stranger, 'важное.txt')), 'верб удалил чужой каталог').toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. Фолбэк. git отказал — копия всё равно обязана уйти, а список деревьев —
//    остаться честным. Подделка здесь ломает РОВНО одну команду и делегирует
//    остальные настоящему git: она беднее библиотеки, а не богаче.
// ─────────────────────────────────────────────────────────────────────────────
describe('git отказал — уборка доводится своими руками и список деревьев чистится', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let res: any

  beforeAll(async () => {
    sandbox = makeSandbox('sma-wt-fallback-')
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    seedProject(mainTree)

    const prov = runCli(['worktree', 'provision', '--branch', 'wt/fallback', '--path', copyTree, '--json'], mainTree)
    if (prov.status !== 0) throw new Error(`провизия упала: ${prov.stderr}`)

    const wt: any = await import('../lib/worktree.mjs')
    const brokenRemove = (args: string[], o: any = {}) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('git отказался убирать копию (подделка)')
      return wt.defaultExecGit(args, o)
    }
    res = wt.removeWorktreeSafely({
      path: copyTree,
      cwd: mainTree,
      execGit: brokenRemove,
      force: true,
      deleteBranch: false,
    })
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('копия удалена своими руками, и это видно в ответе', () => {
    expect(res.ok).toBe(true)
    expect(res.fallback).toBe('rm+prune')
    expect(existsSync(copyTree)).toBe(false)
  })

  it('список деревьев больше не показывает исчезнувшую копию', () => {
    expect(git(['worktree', 'list', '--porcelain'], mainTree)).not.toContain('copy')
  })

  it('цель ссылки цела и после фолбэка', () => {
    expect(existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. Что делает установщик пакетов, когда чистит зависимости. Открытый вопрос
//    разведки: `npm ci` начинает с рекурсивного удаления каталога зависимостей —
//    а в копии на его месте стоит ССЫЛКА. Настоящий `npm ci` здесь не запускается
//    (сеть и минуты); запускается ровно та файловая примитивная операция, которой он
//    чистит, — и её результат утверждается как факт. Красный этот кейс означает не
//    «ослабить проверку», а «запретить установку в копии словами и предупреждением».
// ─────────────────────────────────────────────────────────────────────────────
describe('рекурсивное удаление каталога зависимостей в копии не достаёт до основного дерева', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let targetSurvived: boolean | null = null
  let linkGone: boolean | null = null

  beforeAll(() => {
    sandbox = makeSandbox('sma-wt-primitive-')
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    seedProject(mainTree)

    const prov = runCli(['worktree', 'provision', '--branch', 'wt/primitive', '--path', copyTree, '--json'], mainTree)
    if (prov.status !== 0) throw new Error(`провизия упала: ${prov.stderr}`)

    rmSync(join(copyTree, 'node_modules'), { recursive: true, force: true })
    linkGone = !existsSync(join(copyTree, 'node_modules'))
    targetSurvived = existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js'))
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('ссылка в копии снята', () => {
    expect(linkGone).toBe(true)
  })

  it('зависимости основного дерева на месте', () => {
    expect(
      targetSurvived,
      'рекурсивное удаление в копии прошло по ссылке — установку пакетов в копии придётся запрещать явно',
    ).toBe(true)
  })
})
