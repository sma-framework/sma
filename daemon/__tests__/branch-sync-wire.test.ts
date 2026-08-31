/**
 * ВЕТКА СДАЁТСЯ СВЕДЁННОЙ — ПРОВОД ОТ КОПИИ РАБОТНИКА ДО СТРОКИ, КОТОРУЮ ЧИТАЕТ ЧЕЛОВЕК.
 *
 * ЗАМЕР, РАДИ КОТОРОГО ЭТОТ ФАЙЛ ЕСТЬ (31.08.2026): за один вечер пять готовых работ из шести
 * не слились с первого раза. Причина всякий раз одна — ветка отведена от вершины, которая
 * устарела, пока работник работал. Цена каждой такой приёмки: либо возврат работнику (полная
 * стоимость подхода заново), либо ручной развод конфликта приёмщиком — а ручной развод и есть
 * тот способ тихо откатить чужую свежую починку, от которого дом уже пострадал.
 *
 * ПОЧЕМУ НАСТОЯЩИЙ GIT, А НЕ ПОДДЕЛКА. Рядом уже лежит сьют, который проверяет сам ритуал на
 * инъецированном шве. Он остался бы зелёным ровно в том случае, ради которого всё затевалось:
 * ритуал безупречен, а у двери сдачи его никто не зовёт. Здесь поэтому гоняется НАСТОЯЩИЙ тик
 * по НАСТОЯЩЕМУ временному репозиторию, а утверждается граф коммитов на диске и строка попытки,
 * прочитанная настоящим читателем реестра.
 *
 * ТРИ СЛУЧАЯ, И ВСЕ ТРИ — ПРО ПРОВОД:
 *   (1) вершина уехала, конфликта нет → ветка сдаётся УЖЕ сведённой: `main` становится её
 *       предком, и строка попытки говорит, на сколько она отставала;
 *   (2) абзац дописан обеими сторонами в один README → развелось БЕЗ человека, оба абзаца на
 *       месте, ветка сведена;
 *   (3) настоящий спор о содержании → ветка НЕ сведена, работа всё равно доезжает до человека,
 *       а строка называет ИМЯ файла. Готовую работу не выбрасывают за то, что вершина уехала.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'

const tmpDirs: string[] = []
const mkDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

/** НАСТОЯЩИЙ git — тот же вызов, что собирает production. */
const git = (args: string[], cwd: string) =>
  String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const FIXTURE_WORKDIR = 'C:\\work\\.sma-worktrees\\t-1000'
const framesOf = (file: string, workDir: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const frame = JSON.parse(line)
      for (const block of frame.message?.content ?? []) {
        if (block && typeof block.input?.file_path === 'string') {
          block.input.file_path = block.input.file_path.split(FIXTURE_WORKDIR).join(workDir)
        }
      }
      return JSON.stringify(frame)
    })

const NOTE = 'APPROACH_NOTE: работа сделана в копии'
const LESSON = 'LESSON_NONE: урока нет'
const WORKER_ID = 'max-2'

const backlogTask = () => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
})

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+1 -0' }) }

/**
 * Копия работника: НАСТОЯЩИЙ репозиторий с веткой `main`, ветка задачи отведена от вершины —
 * и после этого `main` УЕХАЛ ВПЕРЁД. Ровно то, что происходит за двадцать минут работы.
 *
 * `trunkEdit` — что вершина успела нажить, `branchEdit` — что написал работник. Совпадающий
 * путь в обоих делает конфликт; разные пути — обычное расхождение.
 */
const makeCopy = (trunkEdit: Record<string, string>, branchEdit: Record<string, string>, seed: Record<string, string>) => {
  const dir = mkDir('sma-sync-copy-')
  git(['init', '-q', '.'], dir)
  git(['config', 'user.email', 'wire@test'], dir)
  git(['config', 'user.name', 'wire'], dir)
  git(['config', 'core.autocrlf', 'false'], dir)

  for (const [path, body] of Object.entries(seed)) writeFileSync(join(dir, path), body, 'utf8')
  git(['add', ...Object.keys(seed)], dir)
  git(['commit', '-qm', 'база'], dir)
  git(['branch', '-M', 'main'], dir)
  const base = git(['rev-parse', 'HEAD'], dir).trim()

  // Работник отводит свою ветку и пишет в ней.
  git(['checkout', '-q', '-b', 'wt/BL-1'], dir)
  for (const [path, body] of Object.entries(branchEdit)) writeFileSync(join(dir, path), body, 'utf8')
  git(['add', ...Object.keys(branchEdit)], dir)
  git(['commit', '-qm', 'работа работника'], dir)

  // …а пока он работал, вершина уехала.
  git(['checkout', '-q', 'main'], dir)
  for (const [path, body] of Object.entries(trunkEdit)) writeFileSync(join(dir, path), body, 'utf8')
  git(['add', ...Object.keys(trunkEdit)], dir)
  git(['commit', '-qm', 'соседняя работа, принятая раньше'], dir)
  const trunkTip = git(['rev-parse', 'HEAD'], dir).trim()

  git(['checkout', '-q', 'wt/BL-1'], dir)
  return { dir, base, trunkTip }
}

async function runTick(copy: { dir: string; base: string }) {
  const projectDir = mkDir('sma-sync-proj-')
  const ledgerDir = mkDir('sma-sync-ledger-')
  const workDir = copy.dir
  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const logged: any[] = []
  const lines = [...framesOf('claude-stream-parity-green.ndjson', workDir), NOTE, LESSON]

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: {
      workers: [{ id: WORKER_ID, lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: projectDir,
      pipeline: { enabled: true },
    },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: () => ({ bin: 'claude', args: buildClaudeArgs({}), env: { PATH: '/usr/bin' }, prompt: 'сделай дело' }),
    verbRunner: async (_bin: string, argsArray: string[]) => {
      const verb = argsArray[1]
      if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
      if (verb === 'worktree') {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, path: workDir, branch: 'wt/BL-1', expectedBase: copy.base, materialized: [] }),
        }
      }
      if (verb === 'reverify') return GREEN_REVERIFY
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: any) => {
      for (const l of lines) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => logged.push(e),
    execGit: (args: string[], opts: any = {}) => git(args, opts.cwd || workDir),
  }

  const res = await tick(deps)
  const rows = readAttempts(ledgerDir, 'BL-1')
  return { res, row: rows[rows.length - 1], logged, workDir }
}

/** Стал ли `main` предком ветки задачи — то есть сведена ли она ПО-НАСТОЯЩЕМУ, а не на словах. */
const trunkIsAncestor = (dir: string) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'main', 'wt/BL-1'], { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('сведение ветки с вершиной у двери сдачи', () => {
  it('вершина уехала, конфликта нет → ветка сдаётся УЖЕ сведённой', async () => {
    const copy = makeCopy(
      { 'neighbour.txt': 'работа соседа\n' },
      { 'mine.txt': 'моя работа\n' },
      { 'CLAUDE.md': '# правила\n', 'neighbour.txt': 'пусто\n', 'mine.txt': 'пусто\n' },
    )
    expect(trunkIsAncestor(copy.dir)).toBe(false) // до тика — не сведена

    const { res, row, workDir } = await runTick(copy)
    expect(res.completed).toBe('BL-1')
    expect(trunkIsAncestor(workDir)).toBe(true)
    expect(row.sync).toMatchObject({ trunk: 'main', synced: true, behind: 1 })
    // работа соседа приехала в копию вместе с вершиной
    expect(readFileSync(join(workDir, 'neighbour.txt'), 'utf8')).toContain('работа соседа')
  })

  it('абзац дописан обеими сторонами в один README → развелось без человека, оба абзаца целы', async () => {
    const copy = makeCopy(
      { 'README.md': '# README\n\nабзац соседней работы\n' },
      { 'README.md': '# README\n\nабзац моей работы\n' },
      { 'CLAUDE.md': '# правила\n', 'README.md': '# README\n' },
    )
    const { res, row, workDir } = await runTick(copy)
    expect(res.completed).toBe('BL-1')
    expect(trunkIsAncestor(workDir)).toBe(true)
    expect(row.sync.synced).toBe(true)
    expect(row.sync.resolved).toEqual([{ file: 'README.md', how: 'union' }])

    const readme = readFileSync(join(workDir, 'README.md'), 'utf8')
    expect(readme).toContain('абзац моей работы')
    expect(readme).toContain('абзац соседней работы')
    expect(readme).not.toContain('<<<<<<<')
  })

  it('настоящий спор → ветка не сведена, работа всё равно доезжает, а файл НАЗВАН', async () => {
    const copy = makeCopy(
      { 'engine.txt': 'строка вершины\n' },
      { 'engine.txt': 'строка работника\n' },
      { 'CLAUDE.md': '# правила\n', 'engine.txt': 'исходная строка\n' },
    )
    const { res, row, logged, workDir } = await runTick(copy)
    // ГОТОВУЮ РАБОТУ НЕ ВЫБРАСЫВАЮТ за то, что вершина уехала.
    expect(res.completed).toBe('BL-1')
    expect(trunkIsAncestor(workDir)).toBe(false)
    expect(row.sync.synced).toBe(false)
    expect(row.sync.unmerged.files).toEqual(['engine.txt'])
    expect(row.sync.unmerged.detail).toContain('engine.txt')
    // …и дерево копии НЕ осталось в половинчатом слиянии
    expect(git(['status', '--porcelain'], workDir).includes('UU ')).toBe(false)
    const said = logged.filter((e) => e.type === 'task.branch_unmerged')
    expect(said.length).toBe(1)
    expect(said[0].detail).toContain('engine.txt')
  })
})
