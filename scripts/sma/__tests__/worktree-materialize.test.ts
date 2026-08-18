/**
 * `worktree provision` — the working copy must be COMPLETE, not merely checked out.
 *
 * WHY THIS FILE EXISTS. `git worktree add` materializes exactly one thing: what git
 * tracks. Every project that keeps its agent layer OUT of git — the rules file, the
 * hooks, the memory notes, the local settings — hands an autonomous worker a copy with
 * none of it. The worker then reads no rules, remembers nothing, and installs its own
 * dependency tree from scratch because `node_modules` is ignored too. The copy looks
 * like the project and behaves like a stranger.
 *
 * So provisioning gets two more duties beyond `worktree add`: COPY the untracked project
 * layer named by a manifest, and LINK the dependency tree instead of reinstalling it.
 * Both duties are dangerous in the obvious way — a copy step that walks a manifest can be
 * pointed at a secret, and a link step can be pointed outside the tree — so the verb
 * carries a blacklist that the manifest cannot override, and it reports every decision it
 * made in `materialized[]` so the caller can write it into the attempt record.
 *
 * NO FAKE GIT HERE. The sibling suite (`worktree.test.ts`) drives the library over a
 * recording double and proves the call ORDER and the explicit-cwd invariant; that is the
 * right shape for those questions. It is the wrong shape for these: whether a file lands
 * in the copy, whether a junction points where it should, and whether git considers a
 * path tracked are questions only a real repository can answer. A double that says "yes"
 * to all three is how a green suite hides a dead wire. Every case below runs `git init`,
 * a real `git worktree add`, and spawns the real CLI in a throwaway temp repository.
 *
 * THE TEARDOWN ORDER IS PART OF THE SUBJECT. On this platform `git worktree remove`
 * FOLLOWS a junction and deletes the TARGET's contents — the main tree's dependency
 * directory, not the link. Measured, twice, with and without `--force`. So every teardown
 * here unhooks the links itself (`rmdirSync` on the link removes the link only, never the
 * target) and only THEN lets git remove the copy. The order is not politeness; reversed,
 * it destroys the thing the copy was linked to.
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
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  statSync,
  utimesSync,
  readlinkSync,
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

/** The `materialized[]` record for one manifest entry, or undefined. */
function pick(json: any, path: string): any {
  const list = Array.isArray(json && json.materialized) ? json.materialized : []
  return list.find((r: any) => r && r.path === path)
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

/** A repository with a first commit — `git worktree add` needs one. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'fixture@example.invalid'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
}

/**
 * Unhook every link inside a tree, depth-first, WITHOUT following any of them.
 * `rmdirSync` on a junction/symlink removes the LINK; the target is untouched. This must
 * run before `git worktree remove`, which on this platform walks INTO a junction and
 * empties the target instead.
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. The default manifest: copy the untracked layer, link the dependencies,
//    and let no secret through.
// ─────────────────────────────────────────────────────────────────────────────
describe('provision несёт в копию неотслеживаемый слой проекта, подключает зависимости ссылкой и не пускает секреты', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let json: any
  let out: { stdout: string; stderr: string; status: number }

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sma-wt-copy-'))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    initRepo(mainTree)

    // Everything the worker actually needs is OUT of git in this project — the shape
    // that makes today's copy useless.
    write(join(mainTree, '.gitignore'), ['.claude/', 'CLAUDE.md', 'node_modules/', '.env', ''].join('\n'))
    write(join(mainTree, '.claude', 'settings.json'), '{"hooks":{}}\n')
    write(join(mainTree, '.claude', 'memory', 'MEMORY.md'), '# память проекта\n')
    write(join(mainTree, '.claude', 'CLAUDE.md'), '# правила проекта\n')
    write(join(mainTree, 'CLAUDE.md'), '# правила в корне\n')
    write(join(mainTree, '.env'), 'API_TOKEN=не-должен-уехать-в-копию\n')
    write(join(mainTree, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    write(join(mainTree, 'README.md'), '# tracked\n')
    git(['add', '.gitignore', 'README.md'], mainTree)
    git(['commit', '-m', 'fixture: a project that keeps its agent layer out of git'], mainTree)

    out = runCli(['worktree', 'provision', '--branch', 'wt/copy', '--path', copyTree, '--json'], mainTree)
    json = lastJson(out.stdout)
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('верб отвечает успехом и свежесозданной копией', () => {
    expect(out.status, `верб упал: ${out.stderr}`).toBe(0)
    expect(json, 'верб не напечатал JSON последней строкой').toBeTruthy()
    expect(json.ok).toBe(true)
    expect(json.reused).toBe(false)
  })

  it('правила, память и настройки лежат в копии, хотя git их не отслеживает', () => {
    expect(existsSync(join(copyTree, '.claude', 'settings.json'))).toBe(true)
    expect(existsSync(join(copyTree, '.claude', 'memory', 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(copyTree, '.claude', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(copyTree, 'CLAUDE.md'))).toBe(true)
    expect(readFileSync(join(copyTree, '.claude', 'memory', 'MEMORY.md'), 'utf8')).toContain('память проекта')
  })

  it('секрет в копию не попал', () => {
    expect(existsSync(join(copyTree, '.env')), 'секрет основного дерева оказался в копии работника').toBe(false)
  })

  it('зависимости подключены ссылкой, а не переустановлены', () => {
    const link = join(copyTree, 'node_modules')
    expect(existsSync(link), 'зависимостей в копии нет вовсе').toBe(true)
    expect(lstatSync(link).isSymbolicLink(), 'вместо ссылки в копии настоящий каталог').toBe(true)
    expect(existsSync(join(link, 'pkg', 'index.js')), 'ссылка ведёт в пустоту').toBe(true)
    expect(existsSync(join(copyTree, 'package-lock.json')), 'провизия оставила след установки').toBe(false)
  })

  it('верб перечисляет, что именно он материализовал, и сколько это заняло', () => {
    const claude = pick(json, '.claude/')
    expect(claude, 'в ответе нет записи о слое правил').toBeTruthy()
    expect(claude.mode).toBe('copy')
    expect(claude.files).toBeGreaterThanOrEqual(3)

    const rules = pick(json, 'CLAUDE.md')
    expect(rules, 'в ответе нет записи о файле правил').toBeTruthy()
    expect(rules.mode).toBe('copy')

    const deps = pick(json, 'node_modules')
    expect(deps, 'в ответе нет записи о зависимостях').toBeTruthy()
    expect(deps.mode).toBe('link')
    expect(samePath(deps.target, join(mainTree, 'node_modules')), `цель ссылки: ${deps.target}`).toBe(true)

    const local = pick(json, '.claude/settings.local.json')
    expect(local, 'в ответе нет записи о локальных настройках').toBeTruthy()
    expect(local.mode).toBe('absent')

    expect(Number.isFinite(json.provisionMs)).toBe(true)
    expect(json.provisionMs).toBeGreaterThanOrEqual(0)
    expect(json.manifest && json.manifest.source).toBe('default')
  })

  it('тип ссылки соответствует платформе: junction с абсолютной целью на Windows, каталожный симлинк на POSIX', () => {
    const link = join(copyTree, 'node_modules')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    const target = readlinkSync(link)
    if (IS_WIN) {
      // junction физически хранит АБСОЛЮТНУЮ цель — относительной он не бывает
      expect(/^[A-Za-z]:[\\/]|^\\\\/.test(String(target).replace(/^\\\\\?\\/, '')), `цель: ${target}`).toBe(true)
    }
    expect(samePath(target, join(mainTree, 'node_modules'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tracked: git already put the layer in the copy — the verb must say so and
//    keep its hands off the files.
// ─────────────────────────────────────────────────────────────────────────────
describe('когда слой правил отслеживается git, верб ничего не копирует и говорит об этом', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let first: any
  let second: any
  let mtimeAfterFirst: number

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sma-wt-tracked-'))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    initRepo(mainTree)

    write(join(mainTree, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[]}}\n')
    write(join(mainTree, 'CLAUDE.md'), '# правила, живущие в git\n')
    git(['add', '.claude', 'CLAUDE.md'], mainTree)
    git(['commit', '-m', 'fixture: a project that keeps its agent layer IN git'], mainTree)

    first = lastJson(
      runCli(['worktree', 'provision', '--branch', 'wt/tracked', '--path', copyTree, '--json'], mainTree).stdout,
    )
    mtimeAfterFirst = statSync(join(copyTree, '.claude', 'settings.json')).mtimeMs
    second = lastJson(
      runCli(['worktree', 'provision', '--branch', 'wt/tracked', '--path', copyTree, '--json'], mainTree).stdout,
    )
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('режим записи — «уже в git», а не «скопировано»', () => {
    const claude = pick(first, '.claude/')
    expect(claude, 'в ответе нет записи о слое правил').toBeTruthy()
    expect(claude.mode).toBe('tracked')
    expect(claude.files ?? 0).toBe(0)
  })

  it('повторная провизия не переписывает отслеживаемые файлы', () => {
    expect(second.reused).toBe(true)
    const mtimeAfterSecond = statSync(join(copyTree, '.claude', 'settings.json')).mtimeMs
    expect(mtimeAfterSecond, 'файл в копии перезаписан поверх того, что дал git').toBe(mtimeAfterFirst)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reused: the second visit refreshes what got older and keeps what the worker
//    wrote itself.
// ─────────────────────────────────────────────────────────────────────────────
describe('повторная провизия обновляет устаревшее и не трогает написанное работником', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let second: any
  const workerNote = ['.claude', 'memory', 'notes', 'worker.md']

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sma-wt-reused-'))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    initRepo(mainTree)

    write(join(mainTree, '.gitignore'), ['.claude/', ''].join('\n'))
    write(join(mainTree, '.claude', 'memory', 'MEMORY.md'), '# первая редакция\n')
    write(join(mainTree, 'README.md'), '# tracked\n')
    git(['add', '.gitignore', 'README.md'], mainTree)
    git(['commit', '-m', 'fixture: a project whose memory lives outside git'], mainTree)

    runCli(['worktree', 'provision', '--branch', 'wt/reused', '--path', copyTree, '--json'], mainTree)

    // The worker's own lesson — it exists ONLY in the copy and must survive.
    write(join(copyTree, ...workerNote), '# урок работника\n')
    // The project moved on: same file, newer content, unambiguously newer clock.
    const ahead = Date.now() / 1000 + 60
    write(join(mainTree, '.claude', 'memory', 'MEMORY.md'), '# вторая редакция\n')
    utimesSync(join(mainTree, '.claude', 'memory', 'MEMORY.md'), ahead, ahead)

    second = lastJson(
      runCli(['worktree', 'provision', '--branch', 'wt/reused', '--path', copyTree, '--json'], mainTree).stdout,
    )
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('копия переиспользована и всё равно описана', () => {
    expect(second.reused).toBe(true)
    expect(Array.isArray(second.materialized), 'переиспользованную копию верб не описал вовсе').toBe(true)
    expect(second.materialized.length).toBeGreaterThan(0)
  })

  it('файл, существующий только в копии, остался на месте', () => {
    expect(existsSync(join(copyTree, ...workerNote)), 'урок работника затёрт провизией').toBe(true)
    expect(readFileSync(join(copyTree, ...workerNote), 'utf8')).toContain('урок работника')
  })

  it('файл, обновившийся в основном дереве, обновился и в копии', () => {
    expect(readFileSync(join(copyTree, '.claude', 'memory', 'MEMORY.md'), 'utf8')).toContain('вторая редакция')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. The manifest: the project names what to carry — and still cannot name a
//    secret or a path outside itself.
// ─────────────────────────────────────────────────────────────────────────────
describe('манифест проекта решает, что нести, но не может назвать секрет или путь наружу', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let json: any

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sma-wt-manifest-'))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    initRepo(mainTree)

    write(join(mainTree, '.gitignore'), ['notes/', 'node_modules/', '.env', ''].join('\n'))
    write(join(mainTree, 'notes', 'a.md'), '# заметка проекта\n')
    write(join(mainTree, 'daemon', 'node_modules', 'x.js'), 'module.exports = 2\n')
    write(join(mainTree, '.env'), 'SECRET=1\n')
    write(join(mainTree, 'README.md'), '# tracked\n')
    write(
      join(mainTree, '.sma', 'worktree-include'),
      JSON.stringify({ copy: ['notes/', '.env', '../outside'], link: ['daemon/node_modules'] }, null, 2),
    )
    git(['add', '.gitignore', 'README.md', 'daemon'], mainTree)
    git(['commit', '-m', 'fixture: a project that names its own extra baggage'], mainTree)

    json = lastJson(
      runCli(['worktree', 'provision', '--branch', 'wt/manifest', '--path', copyTree, '--json'], mainTree).stdout,
    )
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('названный каталог скопирован, названные зависимости подключены ссылкой', () => {
    expect(json.manifest && json.manifest.source).toBe('file')
    const notes = pick(json, 'notes/')
    expect(notes, 'манифестный путь не обработан').toBeTruthy()
    expect(notes.mode).toBe('copy')
    expect(existsSync(join(copyTree, 'notes', 'a.md'))).toBe(true)

    const deps = pick(json, 'daemon/node_modules')
    expect(deps, 'манифестная ссылка не обработана').toBeTruthy()
    expect(deps.mode).toBe('link')
    expect(lstatSync(join(copyTree, 'daemon', 'node_modules')).isSymbolicLink()).toBe(true)
  })

  it('секрет, названный в манифесте, всё равно пропущен — и пропуск виден в ответе', () => {
    const secret = pick(json, '.env')
    expect(secret, 'верб промолчал о секрете в манифесте').toBeTruthy()
    expect(secret.mode).toBe('skipped')
    expect(secret.reason).toBe('secret')
    expect(existsSync(join(copyTree, '.env')), 'манифест перевесил чёрный список').toBe(false)
  })

  it('путь наружу отброшен с предупреждением', () => {
    expect(pick(json, '../outside'), 'путь наружу дошёл до обработки').toBeFalsy()
    expect(Array.isArray(json.manifest.warnings)).toBe(true)
    expect(json.manifest.warnings.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(sandbox, 'outside'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. A broken manifest is not a broken provision.
// ─────────────────────────────────────────────────────────────────────────────
describe('битый манифест не валит провизию — действуют умолчания', () => {
  let sandbox: string
  let mainTree: string
  let copyTree: string
  let out: { stdout: string; stderr: string; status: number }
  let json: any

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sma-wt-broken-'))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    initRepo(mainTree)

    write(join(mainTree, '.gitignore'), ['.claude/', ''].join('\n'))
    write(join(mainTree, '.claude', 'settings.json'), '{"hooks":{}}\n')
    write(join(mainTree, 'README.md'), '# tracked\n')
    write(join(mainTree, '.sma', 'worktree-include'), '{ это не JSON')
    git(['add', '.gitignore', 'README.md'], mainTree)
    git(['commit', '-m', 'fixture: a project with an unreadable include list'], mainTree)

    out = runCli(['worktree', 'provision', '--branch', 'wt/broken', '--path', copyTree, '--json'], mainTree)
    json = lastJson(out.stdout)
  }, 60_000)

  afterAll(() => teardown(sandbox, mainTree, copyTree))

  it('провизия прошла, источник манифеста назван честно', () => {
    expect(out.status, `верб упал на битом манифесте: ${out.stderr}`).toBe(0)
    expect(json.ok).toBe(true)
    expect(json.manifest && json.manifest.source).toBe('invalid')
  })

  it('умолчания всё равно принесли слой правил в копию', () => {
    expect(existsSync(join(copyTree, '.claude', 'settings.json'))).toBe(true)
    const claude = pick(json, '.claude/')
    expect(claude && claude.mode).toBe('copy')
  })
})
