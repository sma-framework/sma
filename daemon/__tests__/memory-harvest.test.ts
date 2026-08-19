/**
 * СБОР ПАМЯТИ ПОПЫТКИ В МОМЕНТ ПРИЁМКИ — на настоящих репозиториях и настоящем конвейере.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Работник пишет урок в СВОЮ копию: у копии своя ветка, свой
 * корпус, своя приёмка — в этом и смысл писать там, а не в общем дереве. Дальше расходятся
 * два мира, и разница между ними — не деталь установки, а разница между «урок доехал» и
 * «урок стёрли»:
 *
 *   (1) Корпус проекта ОТСЛЕЖИВАЕТСЯ git — черновик приезжает слиянием ветки, и переносить
 *       нечего.
 *   (2) Корпус проекта в `.gitignore` (так живёт этот продукт) — слияние не несёт ничего, а
 *       уборка копии сносит каталог вместе с уроком. Между слиянием и уборкой обязан стоять
 *       перенос, и порядок здесь не вопрос вкуса: копия — не мусор, пока урок не спасён.
 *
 * ПОЧЕМУ ЗДЕСЬ НАСТОЯЩИЙ CLI, А НЕ ПОДДЕЛКА КОНВЕЙЕРА. Вопрос «доехал ли урок до корпуса»
 * решает конвейер записи: он валидирует запись, вычищает секреты, отказывается класть в
 * корпус то, что не проходит проверку, и пересобирает индекс. Подделка отвечала бы на этот
 * вопрос из того самого допущения, которое и проверяется. Поэтому каждый кейс ниже гоняет
 * настоящий `memory write` в одноразовом `mkdtemp`-репозитории и смотрит на файлы.
 *
 * ГДЕ ЭТО ВЫПОЛНЯЕТСЯ. Только в песочницах, которые файл создаёт сам и сам уносит. Ни одна
 * рабочая копия разработчика, ни один настоящий корпус не участвуют.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { harvestTaskMemory } from '../src/queue/memory-harvest.mjs'

const CLI = join(import.meta.dirname, '..', '..', 'scripts', 'sma', 'cli.mjs')

/** Задача, копия которой участвует во всех кейсах, и имена её записей. */
const TASK = 'R-77'
const LESSON_ID = 'lesson-r-77-alpha'
const APPROACH_ID = 'approach-r-77-1'
const APPROACH_TEXT = 'Правка в одном модуле вместо переписывания общего слоя'

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Тот же газ, что у демона: бросает на ненулевом коде — на нём и держится ответ про игнор. */
function execGit(args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function envForCli(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SMA_ROOT_OVERRIDE // резолвер путей под проверкой — закреплять его значило бы стереть предмет
  env.SMA_DISABLE_SNAPSHOT_SPAWN = '1' // из одноразового каталога не нужен отдельный отчётный процесс
  return env as NodeJS.ProcessEnv
}

/**
 * Раннер вербов, каким его получает модуль. Аргументы — РОВНО те, что строит модуль
 * (`node scripts/sma/cli.mjs …`); подменяется только путь к самому файлу верба: во временном
 * проекте продукт не установлен, а предмет проверки — не место файла, а состав аргументов и
 * то, что настоящий конвейер с ними делает.
 */
async function verbRunner(bin: string, args: string[], opts: { cwd?: string } = {}) {
  const rest = args[0] && args[0].endsWith('cli.mjs') ? args.slice(1) : args
  try {
    const stdout = execFileSync(bin, [CLI, ...rest], { cwd: opts.cwd, encoding: 'utf8', env: envForCli() })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (err: any) {
    return { code: typeof err?.status === 'number' ? err.status : 1, stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? '') }
  }
}

/** Прямой прогон верба для ПОДГОТОВКИ фикстуры (черновик, который потом пишет работник). */
function runCli(args: string[], cwd: string): { stdout: string; status: number } {
  try {
    return { stdout: String(execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: envForCli() })), status: 0 }
  } catch (err: any) {
    return { stdout: String(err?.stdout ?? ''), status: typeof err?.status === 'number' ? err.status : 1 }
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

/** Леджер-шов: строки попытки, строки журнала и всё, что модуль в них дописал. */
function makeLedger(attempts: any[], journal: any[]) {
  const recorded: any[] = []
  return {
    recorded,
    readAttempts: () => attempts,
    readJournalEntries: () => journal,
    recordAttempt: (row: any) => {
      recorded.push(row)
      return row
    },
  }
}

/** Слой подхода и слой памяти одной попытки — та же форма, что пишет тик. */
function journalRows(lessonDraftPath: string | null, task: string = TASK) {
  const rows: any[] = [
    { taskId: task, attempt: 1, layer: 'approach', payload: { approach: APPROACH_TEXT, rejected: ['переписать общий слой'], influences: ['правило минимальной правки'] } },
  ]
  if (lessonDraftPath) {
    rows.push({ taskId: task, attempt: 1, layer: 'memory', payload: { notes: [], reflexes: [], lesson: { written: lessonDraftPath } } })
  }
  return rows
}

/** Настоящий репозиторий-проект: main + копия задачи в каталоге копий. */
function makeProject(prefix: string, { ignoreAgentDir }: { ignoreAgentDir: boolean }, task: string = TASK) {
  const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  const mainTree = join(sandbox, 'main')
  const copyTree = join(sandbox, '.sma-worktrees', task)
  mkdirSync(mainTree, { recursive: true })
  git(['init', '-b', 'main'], mainTree)
  git(['config', 'user.email', 'fixture@example.invalid'], mainTree)
  git(['config', 'user.name', 'Fixture'], mainTree)
  write(join(mainTree, '.gitignore'), ignoreAgentDir ? '.claude/\n' : 'node_modules/\n')
  write(join(mainTree, 'README.md'), '# fixture\n')
  git(['add', '.gitignore', 'README.md'], mainTree)
  git(['commit', '-m', 'fixture: a project'], mainTree)
  git(['worktree', 'add', '-b', `wt/${task}`, copyTree], mainTree)
  return { sandbox, mainTree, copyTree }
}

/** Урок, который работник оставил в СВОЕЙ копии: настоящий черновик настоящего конвейера. */
function writeLessonDraftInCopy(copyTree: string): string {
  const res = runCli(
    [
      'memory', 'write',
      '--corpus', join(copyTree, '.claude', 'memory'),
      '--type', 'procedural',
      '--truth', 'observed',
      '--authority', 'self-observed',
      '--evidence', `attempt:${TASK}#1`,
      '--product-version', 'fixture-0.0.1',
      '--id', LESSON_ID,
      '--claim', 'Сначала прогнать, потом объявлять сделанным',
      '--body', 'Тело урока фикстуры.',
      '--areas', 'approach',
      '--language', 'ru',
      '--json',
    ],
    copyTree,
  )
  const out = lastJson(res.stdout)
  expect(out?.outcome, `конвейер не отложил черновик урока: ${res.stdout.slice(-400)}`).toBe('staged-draft')
  return join(copyTree, '.claude', 'memory', 'drafts', `${LESSON_ID}.md`)
}

function drop(sandbox: string): void {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* песочница одноразовая — остаток в tmp безвреден */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Корпус вне git: урок обязан ПЕРЕЕХАТЬ из копии, иначе уборка его сотрёт
// ═══════════════════════════════════════════════════════════════════════════════

describe('корпус проекта вне git: урок и записка доезжают из копии в корпус', () => {
  let sandbox = ''
  let mainTree = ''
  let copyTree = ''
  let first: any = null
  let second: any = null
  let ledger: any = null

  beforeAll(async () => {
    ;({ sandbox, mainTree, copyTree } = makeProject('sma-harvest-untracked-', { ignoreAgentDir: true }))
    const draftPath = writeLessonDraftInCopy(copyTree)
    ledger = makeLedger([{ taskId: TASK, attempt: 1, worktreePath: copyTree }], journalRows(draftPath))
    const call = () => harvestTaskMemory({ taskId: TASK, projectDir: mainTree, ledger, verbRunner, execGit })
    first = await call()
    second = await call()
  })

  afterAll(() => drop(sandbox))

  it('режим прочитан у git, а не заявлен: `.claude/` в игноре — значит переносить надо', () => {
    expect(first.mode).toBe('untracked')
  })

  it('черновик урока скопирован в корпус проекта и ПРИМЕНЁН конвейером', () => {
    expect(first.copied).toContain(join('drafts', `${LESSON_ID}.md`))
    expect(first.applied).toEqual([LESSON_ID])
    expect(existsSync(join(mainTree, '.claude', 'memory', `${LESSON_ID}.md`))).toBe(true)
  })

  it('индекс пересобран самим конвейером — заметку можно найти, а не только открыть по имени', () => {
    const memoryIndex = readFileSync(join(mainTree, '.claude', 'memory', 'MEMORY.md'), 'utf8')
    expect(memoryIndex).toContain('заметок: 1')
    const area = readFileSync(join(mainTree, '.claude', 'memory', 'INDEX-misc.md'), 'utf8')
    expect(area).toContain(`${LESSON_ID}.md`)
  })

  it('записка о подходе стала черновиком в корпусе проекта — через конвейер, не копированием', () => {
    expect(first.drafted).toEqual([APPROACH_ID])
    const draft = join(mainTree, '.claude', 'memory', 'drafts', `${APPROACH_ID}.md`)
    expect(existsSync(draft)).toBe(true)
    expect(readFileSync(draft, 'utf8')).toContain('draft_kind: pipeline-write')
  })

  it('след записан строкой попытки: что перенесено, что применено, что отложено', () => {
    const row = ledger.recorded[0]
    expect(row.taskId).toBe(TASK)
    expect(row.attempt).toBe(1)
    expect(row.memoryHarvest.by).toBe('approve')
    expect(row.memoryHarvest.mode).toBe('untracked')
    expect(row.memoryHarvest.applied).toEqual([LESSON_ID])
    expect(row.memoryHarvest.ok).toBe(true)
    expect(typeof row.memoryHarvest.at).toBe('string')
  })

  it('повтор идемпотентен: ничего не переписано, отказ назван причиной, уборка не блокируется', () => {
    expect(second.ok).toBe(true)
    expect(second.applied).toEqual([])
    expect(second.refused.map((r: any) => r.id)).toEqual([LESSON_ID])
    expect(String(second.refused[0].reason)).toMatch(/корпус/)
    expect(second.drafted).toEqual([APPROACH_ID])
    expect(second.skipCleanup).toBe(false)
  })

  it('уборка разрешена: урок спасён', () => {
    expect(first.skipCleanup).toBe(false)
    expect(first.ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// B. Корпус в git: переносить нечего — черновик приезжает слиянием
// ═══════════════════════════════════════════════════════════════════════════════

describe('корпус проекта в git: черновик приходит слиянием, применяется тем же конвейером', () => {
  let sandbox = ''
  let mainTree = ''
  let copyTree = ''
  let res: any = null

  beforeAll(async () => {
    ;({ sandbox, mainTree, copyTree } = makeProject('sma-harvest-tracked-', { ignoreAgentDir: false }))
    writeLessonDraftInCopy(copyTree)
    git(['add', '.claude'], copyTree)
    git(['commit', '-m', 'the worker leaves its lesson'], copyTree)
    git(['merge', '--no-ff', '-m', 'accepted', `wt/${TASK}`], mainTree)
    const merged = join(mainTree, '.claude', 'memory', 'drafts', `${LESSON_ID}.md`)
    expect(existsSync(merged), 'слияние не принесло черновик — фикстура собрана неверно').toBe(true)
    const ledger = makeLedger([{ taskId: TASK, attempt: 1, worktreePath: copyTree }], journalRows(merged))
    res = await harvestTaskMemory({ taskId: TASK, projectDir: mainTree, ledger, verbRunner, execGit })
  })

  afterAll(() => drop(sandbox))

  it('режим tracked, переносить нечего, урок в корпусе', () => {
    expect(res.mode).toBe('tracked')
    expect(res.copied).toEqual([])
    expect(res.applied).toEqual([LESSON_ID])
    expect(existsSync(join(mainTree, '.claude', 'memory', `${LESSON_ID}.md`))).toBe(true)
    expect(res.skipCleanup).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// C и D: пустая попытка и недостижимая копия
// ═══════════════════════════════════════════════════════════════════════════════

describe('край: нечего собирать, и копию не найти', () => {
  let sandbox = ''
  let mainTree = ''

  beforeAll(() => {
    ;({ sandbox, mainTree } = makeProject('sma-harvest-edge-', { ignoreAgentDir: true }))
  })

  afterAll(() => drop(sandbox))

  it('ни записки, ни урока — строка следа всё равно записана: «ничего не было» тоже факт', async () => {
    const ledger = makeLedger([{ taskId: TASK, attempt: 1, worktreePath: null }], [])
    const res = await harvestTaskMemory({ taskId: TASK, projectDir: mainTree, ledger, verbRunner, execGit })
    expect(res.ok).toBe(true)
    expect(res.copied).toEqual([])
    expect(res.applied).toEqual([])
    expect(res.drafted).toEqual([])
    expect(res.skipCleanup).toBe(false)
    expect(ledger.recorded).toHaveLength(1)
    expect(ledger.recorded[0].memoryHarvest.ok).toBe(true)
  })

  it('урок объявлен, а копии по строке попытки нет — уборка ПРОПУСКАЕТСЯ с названной причиной', async () => {
    const ledger = makeLedger(
      [{ taskId: TASK, attempt: 2 }],
      [{ taskId: TASK, attempt: 2, layer: 'memory', payload: { lesson: { written: 'drafts/lesson-r-77-beta.md' } } }],
    )
    const res = await harvestTaskMemory({ taskId: TASK, projectDir: mainTree, ledger, verbRunner, execGit })
    expect(res.mode).toBe('untracked')
    expect(res.skipCleanup).toBe(true)
    expect(res.ok).toBe(false)
    expect(String(res.reason ?? res.refused[0]?.reason)).toMatch(/копи/)
    expect(ledger.recorded[0].memoryHarvest.ok).toBe(false)
  })

  it('путь копии не из каталога копий — модуль в него не заглядывает вовсе', async () => {
    const ledger = makeLedger([{ taskId: TASK, attempt: 3, worktreePath: mainTree }], journalRows('drafts/lesson-r-77-gamma.md'))
    const res = await harvestTaskMemory({ taskId: TASK, projectDir: mainTree, ledger, verbRunner, execGit })
    expect(res.copied).toEqual([])
    expect(res.skipCleanup).toBe(true)
    expect(String(res.reason)).toMatch(/refused-path|копи/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// E. Урок, написанный РОВНО ПО ИНСТРУКЦИИ промпта — три законные формы
//
// Живой прогон показал класс, который прошлые кейсы этого файла не ловили: фикстура
// писала черновик С отпечатком (`--product-version`), а промпт работника о таком флаге
// не говорит вовсе. Подделка была богаче инструкции — и зелёный сьют молчал, пока
// приёмка отказывала каждому настоящему уроку подряд. Поэтому здесь черновик пишется
// ТЕМИ ЖЕ флагами, которые видит работник, и вопрос ставится ровно один: принимает ли
// приёмка то, что сама же продиктовала.
// ═══════════════════════════════════════════════════════════════════════════════

const TASK_E = 'R-100'

/** Черновик урока в копии — набором флагов, который называет промпт (плюс заданные сверху). */
function writeInstructedDraft(copyTree: string, task: string, id: string, extra: string[]): string {
  const res = runCli(
    [
      'memory', 'write',
      '--corpus', join(copyTree, '.claude', 'memory'),
      '--type', 'procedural',
      '--authority', 'self-observed',
      '--evidence', `attempt:${task}#1`,
      ...extra,
      '--id', id,
      '--claim', 'Демон на Windows поднимается обвязкой планировщика, а не одной командой',
      '--body', 'Тело урока: что было, что сделано, чего избегать дальше.',
      '--areas', 'approach',
      '--language', 'ru',
      '--json',
    ],
    copyTree,
  )
  const out = lastJson(res.stdout)
  expect(out?.outcome, `конвейер не отложил черновик: ${res.stdout.slice(-500)}`).toBe('staged-draft')
  return join(copyTree, '.claude', 'memory', 'drafts', `${id}.md`)
}

/** Один прогон сбора на своём одноразовом проекте. */
async function harvestInstructed(prefix: string, id: string, extra: string[]) {
  const project = makeProject(prefix, { ignoreAgentDir: true }, TASK_E)
  const draftPath = writeInstructedDraft(project.copyTree, TASK_E, id, extra)
  const ledger = makeLedger([{ taskId: TASK_E, attempt: 1, worktreePath: project.copyTree }], journalRows(draftPath, TASK_E))
  const res = await harvestTaskMemory({ taskId: TASK_E, projectDir: project.mainTree, ledger, verbRunner, execGit })
  return { ...project, res, ledger }
}

describe('урок по инструкции доезжает до корпуса: приёмка принимает то, что продиктовала', () => {
  const sandboxes: string[] = []
  afterAll(() => sandboxes.forEach(drop))

  it('кейс живого прогона: наблюдение без отпечатка — приёмка ставит отпечаток сама и применяет', async () => {
    const id = 'lesson-r-100-win-start'
    const { sandbox, mainTree, res } = await harvestInstructed('sma-harvest-instructed-', id, ['--truth', 'observed'])
    sandboxes.push(sandbox)
    expect(res.refused.map((r: any) => `${r.id}: ${r.reason}`)).toEqual([])
    expect(res.applied).toEqual([id])
    expect(res.ok).toBe(true)
    const note = readFileSync(join(mainTree, '.claude', 'memory', `${id}.md`), 'utf8')
    expect(note).toMatch(/product_version:/)
  }, 60_000)

  it('урок, проверяемый командой: --verification вместо отпечатка — применён как есть', async () => {
    const id = 'lesson-r-100-verified'
    const { sandbox, mainTree, res } = await harvestInstructed('sma-harvest-verified-', id, [
      '--truth', 'observed',
      '--verification', 'node -e 1',
    ])
    sandboxes.push(sandbox)
    expect(res.refused.map((r: any) => `${r.id}: ${r.reason}`)).toEqual([])
    expect(res.applied).toEqual([id])
    const note = readFileSync(join(mainTree, '.claude', 'memory', `${id}.md`), 'utf8')
    expect(note).toMatch(/verification:/)
    expect(note).toMatch(/command: node -e 1/)
  }, 60_000)

  it('наблюдение без команды: --truth inferred с провенансом — применён, отпечаток не навязан', async () => {
    const id = 'lesson-r-100-inferred'
    const { sandbox, mainTree, res } = await harvestInstructed('sma-harvest-inferred-', id, ['--truth', 'inferred'])
    sandboxes.push(sandbox)
    expect(res.refused.map((r: any) => `${r.id}: ${r.reason}`)).toEqual([])
    expect(res.applied).toEqual([id])
    const note = readFileSync(join(mainTree, '.claude', 'memory', `${id}.md`), 'utf8')
    expect(note).toMatch(/truth_mode: inferred/)
  }, 60_000)
})
