/**
 * Уборка копии задачи демоном: после приёмки — сразу, у закрытых — суточным обходом.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Копия работника создаётся под каждую задачу и не убиралась
 * никогда: приёмка сливала ветку и уходила, обхода не было вовсе, поэтому на машине
 * основателя копии закрытых задач лежали неделями вместе с их ветками. Уборка — действие
 * разрушительное, и потому она проверяется тремя разными вопросами, а не одним:
 *
 *   (1) ЧТО ИМЕННО ЗОВЁТСЯ. Демон не удаляет ничего сам: он зовёт верб проекта
 *       (`scripts/sma/cli.mjs worktree remove … --force --delete-branch --json`), потому что
 *       порядок «снять ссылки → git → ветка» живёт в вербе и измерен на настоящем git.
 *       Кейсы ниже утверждают argv буква в букву — провод, а не намерение.
 *   (2) ЧТО ОСТАЁТСЯ В ЖУРНАЛЕ. Каждая уборка — отдельная строка той же попытки: что
 *       удалено, кем, когда и какой была вершина ветки. «Откатить можно» и «видно, к чему
 *       откатывать» — разные вещи; вторая живёт только в этой строке.
 *   (3) КОГО ОБХОД НЕ ТРОГАЕТ. Копия задачи, ждущей приёмки или возвращённой, — рабочее
 *       место человека; обход, убравший её, стирает незаслуженно. Поэтому он берёт только
 *       закрытые задачи старше суток и только ветки `wt/*`.
 *
 * ПОДДЕЛКА ВЕРБА НЕ БОГАЧЕ НАСТОЯЩЕГО. Ответы верба здесь подделаны — иначе сьют гонял бы
 * настоящий git на каждый кейс, — и ровно поэтому в конце файла стоят ДВА МОСТА на
 * настоящем временном репозитории: ключи подделки обязаны быть подмножеством ключей живого
 * ответа. Подделка, умеющая больше библиотеки, однажды уже держала зелёным вызов
 * несуществующего метода.
 *
 * ГДЕ ЭТО ВЫПОЛНЯЕТСЯ. Мосты работают только в одноразовых песочницах `mkdtemp`, которые
 * файл создаёт сам и сам уносит. Ни одна рабочая копия разработчика не участвует: остальные
 * кейсы вообще не касаются диска — их «путь копии» это строка.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { cleanupTaskWorktree, createWorktreeSweeper } from '../src/queue/worktree-cleanup.mjs'

const PROJECT = '/projects/app'
const COPY = '/projects/.sma-worktrees/R-77'
const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-08-18T12:00:00.000Z')

/**
 * Ответ настоящего верба `worktree remove --json` на успешной уборке — РОВНО его ключи.
 * Мост в конце файла сверяет это множество с живым прогоном.
 */
const REMOVE_OK = {
  ok: true,
  removed: COPY,
  unlinked: [{ path: 'node_modules', target: '/projects/app/node_modules' }],
  dirtyFiles: ['notes.txt'],
  forced: true,
  fallback: null,
  branch: 'wt/R-77',
  branchDeleted: true,
  branchTip: '9f3c1d2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}

/** И его же отказ — тоже сверяется мостом (у отказа ключей МЕНЬШЕ, и это часть контракта). */
const REMOVE_REFUSED = {
  ok: false,
  message: 'уборка отменена: /projects/app — основное дерево репозитория, а не копия',
}

/** Подделка списка деревьев: форма `printJson({worktrees})` верба `worktree list --json`. */
const treeList = (worktrees: any[]) => ({ worktrees })

type Call = { bin: string; args: string[]; opts: any }

/**
 * Подделка раннера вербов формы, которую собирает композиционный корень:
 * `(bin, args, {cwd}) → {code, stdout, stderr}`. Пишет каждый вызов, чтобы кейс мог
 * утверждать argv, а не «что-то было вызвано».
 */
function makeVerbRunner(answers: { remove?: any; list?: any; throws?: boolean } = {}) {
  const calls: Call[] = []
  const runner = async (bin: string, args: string[], opts: any = {}) => {
    calls.push({ bin, args, opts })
    if (answers.throws) throw new Error('CLI недоступен')
    const sub = args[2]
    const answer = sub === 'remove' ? (answers.remove ?? REMOVE_OK) : (answers.list ?? treeList([]))
    return { code: answer && answer.ok === false ? 1 : 0, stdout: `SMA worktree: болтовня\n${JSON.stringify(answer)}\n`, stderr: '' }
  }
  return { runner, calls }
}

/** Леджер как массив: readAttempts фильтрует, recordAttempt копит. */
function makeLedger(rows: any[] = []) {
  const recorded: any[] = []
  const ledger = {
    readAttempts: (taskId: string) => rows.filter((r) => r.taskId === taskId),
    recordAttempt: (row: any) => {
      recorded.push(row)
      return row
    },
  }
  return { ledger, recorded, rows }
}

const logged: any[] = []
const log = (e: any) => logged.push(e)

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Уборка одной задачи: что зовётся, что записывается, чего не делается
// ═══════════════════════════════════════════════════════════════════════════════

describe('уборка одной задачи зовёт верб проекта и оставляет след в строке попытки', () => {
  it('путь берётся из строки попытки, argv — контракт верба буква в букву', async () => {
    const { ledger } = makeLedger([
      { taskId: 'R-77', attempt: 1, outcome: 'failed' },
      { taskId: 'R-77', attempt: 2, outcome: 'completed', worktreePath: COPY, branch: 'wt/R-77' },
    ])
    const { runner, calls } = makeVerbRunner()

    const res = await cleanupTaskWorktree({
      taskId: 'R-77',
      by: 'approve',
      projectDir: PROJECT,
      ledger,
      verbRunner: runner,
      clock: () => NOW,
      log,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('node')
    expect(calls[0].args).toEqual([
      'scripts/sma/cli.mjs',
      'worktree',
      'remove',
      COPY,
      '--force',
      '--delete-branch',
      '--json',
    ])
    expect(calls[0].opts.cwd).toBe(PROJECT)
    expect(res).toMatchObject({ ok: true, removed: true, removedPath: COPY, removedBranch: 'wt/R-77' })
    expect(res.branchTip).toBe(REMOVE_OK.branchTip)
  })

  it('строка cleanup — отдельная строка ТОЙ ЖЕ попытки, без endedAt и outcome', async () => {
    const { ledger, recorded } = makeLedger([
      { taskId: 'R-77', attempt: 1, outcome: 'failed' },
      { taskId: 'R-77', attempt: 2, outcome: 'completed', worktreePath: COPY },
    ])
    const { runner } = makeVerbRunner()

    await cleanupTaskWorktree({ taskId: 'R-77', by: 'approve', projectDir: PROJECT, ledger, verbRunner: runner, clock: () => NOW, log })

    expect(recorded).toHaveLength(1)
    const row = recorded[0]
    // номер — последняя попытка, а не первая: убирается копия того подхода, что был последним
    expect(row).toMatchObject({ taskId: 'R-77', attempt: 2 })
    // строка уборки НЕ несёт исхода: свёртка строк одной попытки не должна ни растягивать
    // её длительность до момента обхода, ни переписывать, чем попытка кончилась
    expect(Object.hasOwn(row, 'endedAt')).toBe(false)
    expect(Object.hasOwn(row, 'outcome')).toBe(false)
    expect(row.cleanup).toMatchObject({
      at: new Date(NOW).toISOString(),
      by: 'approve',
      removedPath: COPY,
      removedBranch: 'wt/R-77',
      branchTip: REMOVE_OK.branchTip,
      unlinked: REMOVE_OK.unlinked,
      dirtyFiles: REMOVE_OK.dirtyFiles,
      forced: true,
      ok: true,
    })
    expect(Object.hasOwn(row.cleanup, 'error')).toBe(false)
  })

  it('пути в строке нет — копия ищется в списке деревьев по ветке задачи', async () => {
    const { ledger } = makeLedger([{ taskId: 'R-77', attempt: 1, outcome: 'completed' }])
    const { runner, calls } = makeVerbRunner({
      list: treeList([
        { path: '/projects/app', head: 'aaa', branch: 'refs/heads/main' },
        { path: '/projects/.sma-worktrees/other', head: 'bbb', branch: 'refs/heads/wt/R-12' },
        { path: COPY, head: 'ccc', branch: 'refs/heads/wt/R-77' },
      ]),
    })

    const res = await cleanupTaskWorktree({ taskId: 'R-77', by: 'sweep', projectDir: PROJECT, ledger, verbRunner: runner, clock: () => NOW, log })

    expect(calls[0].args).toEqual(['scripts/sma/cli.mjs', 'worktree', 'list', '--json'])
    expect(calls[1].args[3]).toBe(COPY)
    expect(res.removedPath).toBe(COPY)
  })

  it('копии нет вовсе: честное «нечего убирать», ни верба remove, ни строки в журнале', async () => {
    const { ledger, recorded } = makeLedger([{ taskId: 'R-90', attempt: 1, outcome: 'completed' }])
    const { runner, calls } = makeVerbRunner({ list: treeList([{ path: '/projects/app', branch: 'refs/heads/main' }]) })

    const res = await cleanupTaskWorktree({ taskId: 'R-90', by: 'approve', projectDir: PROJECT, ledger, verbRunner: runner, clock: () => NOW, log })

    expect(res).toEqual({ ok: true, removed: false, removedPath: null, removedBranch: null, branchTip: null, reason: 'no-worktree' })
    expect(calls.filter((c) => c.args[2] === 'remove')).toHaveLength(0)
    // нечего убирать — нечего и записывать: строка уборки означала бы удаление, которого не было
    expect(recorded).toHaveLength(0)
  })

  it('путь вне каталога копий — отказ ДО первого вызова: удалять чужое некому', async () => {
    const { ledger, recorded } = makeLedger([{ taskId: 'R-77', attempt: 1, outcome: 'completed', worktreePath: '/projects/app' }])
    const { runner, calls } = makeVerbRunner()

    const res = await cleanupTaskWorktree({ taskId: 'R-77', by: 'approve', projectDir: PROJECT, ledger, verbRunner: runner, clock: () => NOW, log })

    expect(res).toMatchObject({ ok: false, removed: false, reason: 'refused-path' })
    expect(calls).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  it('верб отказал — приёмку это не отменяет, но отказ записан строкой cleanup ok:false', async () => {
    const { ledger, recorded } = makeLedger([{ taskId: 'R-77', attempt: 4, outcome: 'completed', worktreePath: COPY }])
    const { runner } = makeVerbRunner({ remove: REMOVE_REFUSED })

    const res = await cleanupTaskWorktree({ taskId: 'R-77', by: 'approve', projectDir: PROJECT, ledger, verbRunner: runner, clock: () => NOW, log })

    expect(res.ok).toBe(false)
    expect(res.removed).toBe(false)
    expect(res.reason).toContain('основное дерево')
    expect(recorded).toHaveLength(1)
    expect(recorded[0].attempt).toBe(4)
    expect(recorded[0].cleanup.ok).toBe(false)
    expect(recorded[0].cleanup.error).toContain('основное дерево')
  })

  it('раннер бросил — уборка отвечает отказом и НИКОГДА не бросает сама', async () => {
    const { ledger } = makeLedger([{ taskId: 'R-77', attempt: 1, outcome: 'completed', worktreePath: COPY }])
    const { runner } = makeVerbRunner({ throws: true })

    const res = await cleanupTaskWorktree({ taskId: 'R-77', by: 'approve', projectDir: PROJECT, ledger, verbRunner: runner, clock: () => NOW, log })

    expect(res.ok).toBe(false)
    expect(String(res.reason)).toContain('CLI недоступен')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Суточный обход: кого он берёт и, важнее, кого не берёт никогда
// ═══════════════════════════════════════════════════════════════════════════════

describe('суточный обход убирает только закрытые копии старше суток', () => {
  const sweeperFor = (over: any = {}) => {
    const { ledger, recorded } = makeLedger(over.ledgerRows ?? [])
    const { runner, calls } = makeVerbRunner({ list: treeList(over.trees ?? []) })
    const sweeper = createWorktreeSweeper({
      projectsOf: () => over.projects ?? [PROJECT],
      adapter: { list: async () => over.rows ?? [] },
      ledger,
      verbRunner: runner,
      clock: () => NOW,
      log,
      fsImpl: { existsSync: () => true },
      ...over.opts,
    })
    return { sweeper, calls, recorded }
  }

  const wt = (id: string) => ({ path: `/projects/.sma-worktrees/${id}`, head: 'aaa', branch: `refs/heads/wt/${id}` })

  it('закрытая позавчера — убрана; закрытая час назад и ждущая приёмки — нет', async () => {
    const { sweeper, calls } = sweeperFor({
      trees: [wt('R-old'), wt('R-fresh'), wt('R-waiting')],
      rows: [
        { id: 'R-old', status: 'completed', attempt: 1, completedAt: NOW - 2 * DAY },
        { id: 'R-fresh', status: 'completed', attempt: 1, completedAt: NOW - HOUR },
        { id: 'R-waiting', status: 'awaiting_approval', attempt: 1, claimedAt: NOW - 5 * DAY },
      ],
    })

    const out = await sweeper.run({ force: true })

    expect(out).toMatchObject({ scanned: 3, removed: 1, errors: 0 })
    expect(out.skipped).toBe(2)
    const removals = calls.filter((c) => c.args[2] === 'remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].args[3]).toBe('/projects/.sma-worktrees/R-old')
  })

  it('провал старше суток убирается тоже — повтор задачи решает очередь, не обход', async () => {
    const { sweeper, calls, recorded } = sweeperFor({
      trees: [wt('R-dead')],
      rows: [{ id: 'R-dead', status: 'failed', attempt: 2, completedAt: NOW - 3 * DAY }],
      ledgerRows: [{ taskId: 'R-dead', attempt: 2, outcome: 'failed', endedAt: new Date(NOW - 3 * DAY).toISOString(), worktreePath: '/projects/.sma-worktrees/R-dead' }],
    })

    const out = await sweeper.run({ force: true })

    expect(out.removed).toBe(1)
    expect(calls.some((c) => c.args[2] === 'remove')).toBe(true)
    expect(recorded[0].cleanup.by).toBe('sweep')
  })

  it('задача, которой очередь не знает, пропускается и говорит об этом в логе', async () => {
    logged.length = 0
    const { sweeper, calls } = sweeperFor({ trees: [wt('R-ghost')], rows: [] })

    const out = await sweeper.run({ force: true })

    expect(out).toMatchObject({ scanned: 1, removed: 0, skipped: 1 })
    expect(calls.filter((c) => c.args[2] === 'remove')).toHaveLength(0)
    expect(logged.some((e) => e.type === 'worktree-sweep-skip' && e.reason === 'unknown-task')).toBe(true)
  })

  it('копии терминалов и ветки-долгожители не считаются вовсе — обход о них не знает', async () => {
    const { sweeper, calls } = sweeperFor({
      trees: [
        { path: '/projects/app', branch: 'refs/heads/main' },
        { path: '/projects/.sma-worktrees/terminal-7', branch: 'refs/heads/sma-wt/terminal-7' },
        { path: '/projects/.sma-worktrees/compare', branch: 'refs/heads/compare/two-runtimes' },
        wt('R-old'),
      ],
      rows: [{ id: 'R-old', status: 'completed', attempt: 1, completedAt: NOW - 2 * DAY }],
    })

    const out = await sweeper.run({ force: true })

    expect(out.scanned).toBe(1) // только ветка задачи — остальные три даже не рассматривались
    expect(calls.filter((c) => c.args[2] === 'remove')).toHaveLength(1)
  })

  it('раз в сутки: второй запуск подряд пропущен, принудительный — нет', async () => {
    const { sweeper, calls } = sweeperFor({
      trees: [wt('R-old')],
      rows: [{ id: 'R-old', status: 'completed', attempt: 1, completedAt: NOW - 2 * DAY }],
    })

    const first = await sweeper.run({})
    const second = await sweeper.run({})
    const forced = await sweeper.run({ force: true })

    expect(first.skipped).toBe(0)
    expect(second).toEqual({ skipped: true })
    expect(forced.scanned).toBe(1)
    // список деревьев спрошен ровно дважды — по разу на каждый НЕпропущенный обход
    expect(calls.filter((c) => c.args[2] === 'list')).toHaveLength(2)
  })

  it('убирается та копия, о которой обход вынес решение, а не другая из старой строки', async () => {
    const { sweeper, calls } = sweeperFor({
      trees: [wt('R-old')],
      rows: [{ id: 'R-old', status: 'completed', attempt: 2, completedAt: NOW - 2 * DAY }],
      // журнал помнит ПРЕЖНЮЮ копию той же задачи (первая попытка стояла в другом каталоге)
      ledgerRows: [
        { taskId: 'R-old', attempt: 1, outcome: 'failed', worktreePath: '/projects/.sma-worktrees/R-old-previous' },
        { taskId: 'R-old', attempt: 2, outcome: 'completed', endedAt: new Date(NOW - 2 * DAY).toISOString() },
      ],
    })

    await sweeper.run({ force: true })

    const removals = calls.filter((c) => c.args[2] === 'remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].args[3]).toBe('/projects/.sma-worktrees/R-old')
  })

  it('копия закрытой задачи без единой метки времени не трогается — доказать возраст нечем', async () => {
    const { sweeper, calls } = sweeperFor({
      trees: [wt('R-nomark')],
      rows: [{ id: 'R-nomark', status: 'completed', attempt: 1 }],
    })

    const out = await sweeper.run({ force: true })

    expect(out).toMatchObject({ scanned: 1, removed: 0, skipped: 1 })
    expect(calls.filter((c) => c.args[2] === 'remove')).toHaveLength(0)
  })

  it('проект без CLI пропускается целиком, обход продолжается', async () => {
    const { ledger } = makeLedger([])
    const { runner, calls } = makeVerbRunner({ list: treeList([wt('R-old')]) })
    const sweeper = createWorktreeSweeper({
      projectsOf: () => ['/projects/no-cli', PROJECT],
      adapter: { list: async () => [{ id: 'R-old', status: 'completed', attempt: 1, completedAt: NOW - 2 * DAY }] },
      ledger,
      verbRunner: runner,
      clock: () => NOW,
      log,
      fsImpl: { existsSync: (p: string) => String(p).includes('app') },
    })

    const out = await sweeper.run({ force: true })

    expect(out.removed).toBe(1)
    // список деревьев спрошен ОДИН раз — только у того проекта, где верб вообще есть
    expect(calls.filter((c) => c.args[2] === 'list')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Мосты: подделка не богаче настоящего верба (живой git, живой CLI)
// ═══════════════════════════════════════════════════════════════════════════════

const CLI = join(import.meta.dirname, '..', '..', 'scripts', 'sma', 'cli.mjs')
const FIXTURE_PROVISION = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'worktree-provision-answer.json'), 'utf8'),
)

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function runCli(args: string[], cwd: string): { stdout: string; status: number } {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SMA_ROOT_OVERRIDE
  env.SMA_DISABLE_SNAPSHOT_SPAWN = '1'
  try {
    return { stdout: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: env as NodeJS.ProcessEnv }), status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
  }
}

function lastJson(stdout: string): any {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
  return line ? JSON.parse(line) : null
}

function write(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

describe('мосты: ответы, которыми отвечают подделки этого файла, — подмножество настоящих', () => {
  let sandbox = ''
  let mainTree = ''
  let copyTree = ''
  let liveProvision: any = null
  let liveRemove: any = null
  let liveRefusal: any = null

  beforeAll(() => {
    // Длинная форма пути: на Windows tmpdir() отдаёт короткое имя, а git пишет длинное —
    // сравнение строк объявило бы законную копию чужим каталогом.
    sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'sma-wt-cleanup-')))
    mainTree = join(sandbox, 'main')
    copyTree = join(sandbox, 'copy')
    mkdirSync(mainTree, { recursive: true })
    git(['init', '-b', 'main'], mainTree)
    git(['config', 'user.email', 'fixture@example.invalid'], mainTree)
    git(['config', 'user.name', 'Fixture'], mainTree)
    // Проект, который держит слой правил и зависимости вне git — та самая форма, ради
    // которой провизия вообще что-то материализует.
    write(join(mainTree, '.gitignore'), ['.claude/', 'CLAUDE.md', 'node_modules/', ''].join('\n'))
    write(join(mainTree, '.claude', 'settings.json'), '{"hooks":{}}\n')
    write(join(mainTree, 'CLAUDE.md'), '# правила проекта\n')
    write(join(mainTree, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    write(join(mainTree, 'README.md'), '# tracked\n')
    git(['add', '.gitignore', 'README.md'], mainTree)
    git(['commit', '-m', 'fixture: a project whose agent layer is out of git'], mainTree)

    liveProvision = lastJson(runCli(['worktree', 'provision', '--branch', 'wt/copy', '--path', copyTree, '--json'], mainTree).stdout)
    // Отказ спрашивается ДО уборки: после неё копии уже нет, и вопрос был бы о пустоте.
    liveRefusal = lastJson(runCli(['worktree', 'remove', mainTree, '--force', '--json'], mainTree).stdout)
    liveRemove = lastJson(runCli(['worktree', 'remove', copyTree, '--force', '--delete-branch', '--json'], mainTree).stdout)
  })

  afterAll(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* песочница одноразовая — остаток в tmp безвреден */
    }
  })

  it('успешный ответ уборки: ключи подделки ⊆ ключей живого верба', () => {
    expect(liveRemove, 'живой верб не ответил JSON').toBeTruthy()
    expect(liveRemove.ok).toBe(true)
    const live = new Set(Object.keys(liveRemove))
    const missing = Object.keys(REMOVE_OK).filter((k) => !live.has(k))
    expect(missing, `подделка знает ключи, которых у верба нет: ${missing.join(', ')}`).toEqual([])
    // и копия действительно исчезла, а цель ссылки в основном дереве — нет
    expect(existsSync(copyTree)).toBe(false)
    expect(existsSync(join(mainTree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })

  it('отказ уборки: ключи подделки ⊆ ключей живого отказа', () => {
    expect(liveRefusal, 'живой верб не ответил JSON на отказе').toBeTruthy()
    expect(liveRefusal.ok).toBe(false)
    const live = new Set(Object.keys(liveRefusal))
    const missing = Object.keys(REMOVE_REFUSED).filter((k) => !live.has(k))
    expect(missing, `подделка отказа богаче верба: ${missing.join(', ')}`).toEqual([])
  })

  it('фикстура провизии (её читает сьют тика): ключи ⊆ ключей живого верба, и по каждому режиму', () => {
    expect(liveProvision, 'живой верб провизии не ответил JSON').toBeTruthy()
    expect(liveProvision.ok).not.toBe(false)
    const live = new Set(Object.keys(liveProvision))
    const missing = Object.keys(FIXTURE_PROVISION).filter((k) => !live.has(k))
    expect(missing, `фикстура знает ключи, которых у верба нет: ${missing.join(', ')}`).toEqual([])

    // …и то же самое на один уровень глубже: запись списка материализованного сверяется с
    // записью ТОГО ЖЕ режима живого ответа. Ключи режимов разные (у ссылки нет счётчика
    // файлов), поэтому сверять их вперемешку было бы сверкой ни с чем.
    for (const entry of FIXTURE_PROVISION.materialized) {
      const liveEntry = (liveProvision.materialized || []).find((m: any) => m.mode === entry.mode)
      expect(liveEntry, `живой верб не дал ни одной записи режима ${entry.mode}`).toBeTruthy()
      const liveKeys = new Set(Object.keys(liveEntry))
      const extra = Object.keys(entry).filter((k) => !liveKeys.has(k))
      expect(extra, `запись фикстуры (${entry.mode}) богаче настоящей: ${extra.join(', ')}`).toEqual([])
    }
  })
})
