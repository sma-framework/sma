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
 *
 * …И ЧЕТВЁРТЫЙ, ДОСТРОЕННЫЙ ПОЗЖЕ, ПРО ПОСЛЕДНИЙ МЕТР ЭТОГО ПРОВОДА: строка попытки несла ответ
 * ЧЕСТНО, и на этом провод кончался — дверь карточки его не называла. Приёмщик узнавал о споре
 * ПОСЛЕ нажатия «принять», из отказа слияния, и шёл выяснять состав руками в копии, которую
 * вот-вот выметут. Поэтому (4) гоняет НАСТОЯЩУЮ дверь карточки и проверяет слова, которые из
 * поля получится прочесть, — вычислено и записано не то же самое, что предъявлено.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { tick } from '../src/loop.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { syncLine } from '../../spa/src/screens/task-card/branch-sync'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { buildClaudeArgs, buildTaskPrompt } from '../src/runner/args.mjs'
import { classifyForWorker } from '../../scripts/sma/lib/worker-danger.mjs'
import { HUMAN_ONLY_DENIALS } from '../src/queue/capability-envelope.mjs'

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

/**
 * ПОЛОВИНА ДОГОВОРА, КОТОРУЮ ИСПОЛНЯЕТ РАБОТНИК, А НЕ ДЕМОН — И ДВЕРЬ, КОТОРУЮ ОН МОЖЕТ ОТКРЫТЬ.
 *
 * Промпт требует сдать ветку СВЕДЁННОЙ и называет команду. До этого случая он называл
 * `git merge --no-ff --no-commit main` — команду, которой у работника НЕТ: конверт возможностей
 * отдаёт спавну отказ `Bash(git merge:*)` (слияние — решение человека, инвариант флота), а
 * мягкая охрана ставит тот же вызов на парковку, где он умирает по сроку ожидания. Обязанность,
 * которую нечем исполнить, — не обязанность, а текст, и выглядит она на экране точно так же.
 *
 * Здесь команды берутся ИЗ САМОГО ПРОМПТА (не переписаны сюда руками) и проверяются обеими
 * стенами, которые встанут у работника: списком отказов конверта и классификатором опасного.
 * Три файла, между которыми это может разъехаться, — `runner/args.mjs`,
 * `queue/capability-envelope.mjs` и `lib/worker-danger.mjs`; связывает их только этот случай.
 */
describe('договор сдачи — дверь, которую работник может ОТКРЫТЬ', () => {
  const promptLines = () =>
    buildTaskPrompt({ task: backlogTask() })
      .split('\n')
      .map((l) => l.trim())

  it('команды сведения из промпта не отказаны конвертом и не паркуются охраной', () => {
    const commands = promptLines().filter((l) => l.startsWith('node scripts/sma/cli.mjs sync-branch'))
    expect(commands.length).toBeGreaterThan(0)

    // `Bash(git push:*)` → префикс `git push`: команда, начинающаяся с него, отказана спавну.
    const prefixes = Object.values(HUMAN_ONLY_DENIALS)
      .flat()
      .map((p) => String(p).replace(/^Bash\(/, '').replace(/:\*\)$/, ''))
    for (const cmd of commands) {
      for (const prefix of prefixes) expect(cmd.startsWith(prefix)).toBe(false)
      expect(classifyForWorker('Bash', { command: cmd }).dangerous).toBe(false)
    }
  })

  it('промпт не диктует голый глагол слияния — он работнику закрыт', () => {
    expect(promptLines().some((l) => l.startsWith('git ' + 'merge'))).toBe(false)
  })

  it('верб, названный промптом, отвечает в таблице отправки CLI', () => {
    const cli = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'sma', 'cli.mjs'), 'utf8')
    // Промпт, называющий несуществующий верб, — та же невыполнимая обязанность другой формы.
    expect(cli).toContain("'sync-branch': cmdSyncBranch")
  })

  /**
   * ТА ЖЕ БОЛЕЗНЬ СЛОЕМ НИЖЕ. Промпт велит развести оставшийся спор САМОМУ — и до этого случая
   * не называл, ЧЕМ: отказ по умолчанию откатывает слияние целиком и уносит с собой разметку
   * конфликта, единственное, чем спор разводится, а голый глагол слияния работнику отказан
   * конвертом. Дверь для этого построена (`--keep` оставляет спор размеченным в дереве,
   * `--abort` из него выводит), но дверь, о которой молчит единственный читаемый работником
   * текст, для него не существует — ровно как поле, которого не называет дверь карточки.
   * Поэтому оба флага проверяются и в промпте, и в самом вербе: заявление о читателе стоит
   * одного грепа по тому, кто его исполняет.
   */
  it('промпт называет ДВЕРЬ развода — --keep и --abort, — и обе отвечают в вербе', () => {
    const lines = promptLines()
    expect(lines.some((l) => l.startsWith('node scripts/sma/cli.mjs sync-branch --keep'))).toBe(true)
    expect(lines.some((l) => l.startsWith('node scripts/sma/cli.mjs sync-branch --abort'))).toBe(true)

    const cli = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'sma', 'cli.mjs'), 'utf8')
    expect(cli).toContain('keepConflict: flags.keep === true')
    expect(cli).toContain('flags.abort === true')

    // …и то, чем промпт велит ДОВОДИТЬ оставленный спор, работнику разрешено: совет, который
    // нечем исполнить, — та же невыполнимая обязанность, только записанная прозой.
    for (const cmd of ['git add -- README.md', 'git commit --no-edit']) {
      expect(classifyForWorker('Bash', { command: cmd }).dangerous).toBe(false)
    }
  })
})

/**
 * ПОСЛЕДНИЙ МЕТР ПРОВОДА: ОТ ДОЛГОВЕЧНОЙ СТРОКИ ДО ГЛАЗ ПРИЁМЩИКА.
 *
 * Три случая выше доказывают, что ответ о сведении ЕСТЬ на строке попытки. Этого мало, и мало
 * ровно так же, как было мало паритета, посчитанного идеально и не доехавшего ни до кого: копию
 * работника после приёмки выметают, а вопрос «почему приёмка не прошла» задают именно ПОСЛЕ.
 * Поле, которое дверь карточки не называет, для человека не существует.
 *
 * Здесь гоняется НАСТОЯЩАЯ дверь (`createFrontServer`, тот же `handle`, что и в production) над
 * подделанным реестром — а слова, которые из поля прочтёт глаз, проверяются тем же модулем,
 * который зовёт разметка. Между полем на строке и строкой на экране стоят три файла
 * (`front/server.mjs`, `api/types.ts`, `task-card/branch-sync.ts`); связывает их только этот
 * случай.
 */

const CARD_TOKEN = 'tkn-sync-wire'

function mkReq(url: string) {
  const req: any = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = { authorization: `Bearer ${CARD_TOKEN}` }
  req.socket = { remoteAddress: '10.0.0.9' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function cardOf({ rows, attempts }: { rows: any[]; attempts: any[] }) {
  const projectDir = mkDir('sma-sync-card-')
  const front = createFrontServer({
    config: { token: CARD_TOKEN, repoDir: projectDir },
    deps: {
      repoDir: projectDir,
      clock: () => 1_770_000_000_000,
      adapter: { list: async () => rows },
      ledger: {
        readAttempts: () => attempts,
        readAttemptLog: () => ({ entries: [], truncated: false, roles: [], rolesMore: 0, digest: null }),
        readJournalEntries: () => [],
      },
    },
  })
  const res = mkRes()
  await front.handle(mkReq(`/api/task/${rows[0].id}`), res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

/** Ровно та форма, которую кладёт на строку `syncBeforeHandoff` при неразведённом споре. */
const UNMERGED = {
  trunk: 'main',
  behind: 29,
  synced: false,
  resolved: [{ file: 'README.md', how: 'union' }],
  unmerged: { count: 2, files: ['daemon/src/loop.mjs', 'docs/master-graph.html'], detail: 'конфликт в 2 файл(ах)' },
}

describe('сведение ветки доезжает до человека, а не только до реестра', () => {
  it('дверь карточки НАЗЫВАЕТ состав спора — до того, как человек нажмёт «принять»', async () => {
    const { status, body } = await cardOf({
      rows: [{ id: 'BL-7', status: 'awaiting_approval', lane: 'prod', title: 'дело', attempt: 1, priority: 0 }],
      attempts: [{ attempt: 1, outcome: 'completed', workerId: 'max-1', sync: UNMERGED }],
    })
    expect(status).toBe(200)
    expect(body.attempts[0].sync).toEqual(UNMERGED)
  })

  it('попытка, молчащая о сведении, приезжает нулём — а не «сведена»', async () => {
    const { body } = await cardOf({
      rows: [{ id: 'BL-8', status: 'awaiting_approval', lane: 'prod', title: 'дело', attempt: 1, priority: 0 }],
      attempts: [{ attempt: 1, outcome: 'completed', workerId: 'max-1' }],
    })
    expect(body.attempts[0].sync).toBe(null)
  })

  it('у ИДУЩЕЙ попытки сведения ещё не было — ключ есть и он нулевой', async () => {
    const { body } = await cardOf({
      rows: [{ id: 'BL-9', status: 'claimed', lane: 'prod', title: 'дело', attempt: 1, priority: 0, workerId: 'max-1' }],
      attempts: [],
    })
    const running = body.attempts.find((a: any) => a.outcome === 'running')
    expect(running).toBeTruthy()
    expect('sync' in running).toBe(true)
    expect(running.sync).toBe(null)
  })

  it('слова называют ЧИСЛО и ИМЕНА — та самая строка, которую приёмщик выяснял руками', () => {
    const said = syncLine({ sync: UNMERGED } as any)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('НЕ сведена')
    expect(said[0]).toContain('2 файл(ах)')
    expect(said[0]).toContain('daemon/src/loop.mjs')
    expect(said[0]).toContain('docs/master-graph.html')
    // …и механический развод НЕ молчит: развод, о котором никто не узнал, неотличим от
    // слияния, где спора не было вовсе.
    expect(said[0]).toContain('README.md (union)')
  })

  it('сведённая ветка говорит об этом, а молчащая попытка не говорит ничего', () => {
    expect(syncLine({ sync: { trunk: 'main', behind: 4, synced: true } } as any)).toEqual([
      'Ветка сведена с main — отставала на 4 коммит(ов)',
    ])
    expect(syncLine({ sync: null } as any)).toEqual([])
    expect(syncLine({} as any)).toEqual([])
  })
})
