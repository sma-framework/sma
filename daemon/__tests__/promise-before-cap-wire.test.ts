/**
 * ОБЕЩАНИЕ ПРИЕЗЖАЕТ РАНЬШЕ, ЧЕМ СЧИТАЕТСЯ ПОТОЛОК ХОДОВ, — ПРОВОД ОТ ДВЕРИ ДО КОМАНДНОЙ
 * СТРОКИ И ДО ЭКРАНА.
 *
 * ЧТО БЫЛО НЕ ТАК, И ЭТО ЗАМЕРЕНО (02.09.2026). Потолок ходов считается по ОБЪЯВЛЕННОМУ
 * размеру работы: сколько обещано пунктов, сколько в обещании знаков, какая стоит оценка. А
 * две двери, ставящие работу пачкой, обещания не принимали вовсе — только «что сделать».
 * Обещание приезжало ОТДЕЛЬНЫМ запросом, дверью правки слов, секундой позже; строка же
 * становится захватываемой в тот миг, когда она записана. Тик успевал взять её раньше слов —
 * и дальше вся попытка жила по объекту, отданному при захвате: работа, о которой на самом
 * деле было обещано пять пунктов, уходила в процесс объявленной ПУСТОЙ, то есть мелкой, и
 * получала базовый потолок вместо тройного. Соседние куски той же сборки, взятые ПОСЛЕ
 * прихода слов, получили втрое больше ходов на ту же работу. Взятый раньше — сгорел на ритуале
 * сдачи, перешагнув потолок на один ход. Разница между «сделана» и «сгорела» оказалась не в
 * работе, а в том, чей запрос успел первым.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ.
 *   1. Двери сборки и повышения строки кладут обещание на строку ТЕМ ЖЕ запросом — гонке
 *      нечему опаздывать.
 *   2. Слова, приехавшие ПОСЛЕ захвата, но до старта, догоняют попытку: настоящий тик над
 *      настоящей очередью, настоящий сборщик аргументов — и на командной строке стоит крупный
 *      потолок, а не базовый.
 *   3. Строка без обещания говорит об этом человеку, ПОКА он ещё может дописать: у ждущей
 *      работника строки едет число, которое она за молчание получит.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ: арифметики размера (она разобрана отдельно) и распознавания упора в
 * потолок. Здесь только провод.
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ: очередь-образец, двери фронта, тик, сборщик аргументов, чтение доски.
 * ПОДДЕЛАНЫ: процесс работника (кадры потока подаются списком), глаголы копии и перепроверки,
 * файл бэклога и файл настроек аккаунта.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState, deriveBacklog } from '../src/front/state.mjs'
import { DEFAULT_PIPELINE_MAX_TURNS, pipelineMaxTurns } from '../src/config.mjs'
import { TURN_SIZE_MULTIPLIER } from '../src/policy/turn-budget.mjs'
import { buildUnits } from '../../spa/src/screens/tasks/units'

const TOKEN = 'p'.repeat(64)
const NOW = 1_700_000_000_000
const PROJECT = '/proj'

/** Пять пунктов — обещание, которое любая из трёх границ читает как крупную работу. */
const FIVE_CRITERIA = [
  'дверь принимает обещание тем же запросом',
  'потолок пересчитывается по приехавшим словам',
  'на доске видно строку без обещания',
  'красный тест на молчаливый мелкий потолок',
  'оба README обновлены в том же изменении',
]

/** Базовый потолок и тот, что положен крупной работе, — от одного числа, а не от двух. */
const BASE = DEFAULT_PIPELINE_MAX_TURNS
const LARGE = BASE * TURN_SIZE_MULTIPLIER.large

const BACKLOG_FILE = [
  '## Backlog',
  '',
  '- [ ] **AB-205** · Вторая волна методологий очереди. `size:M` `added:2026-07-17`',
  '',
].join('\n')

// ── временный мир ──────────────────────────────────────────────────────────────────────────

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

// ── двери фронта ───────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkReq(url: string, body?: unknown): any {
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(): any {
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) {
      res.statusCode = code
      res.headersSent = true
      return res
    },
    setHeader() {},
    getHeader() {
      return undefined
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(front: any, url: string, body: unknown): Promise<any> {
  const res = mkRes()
  await front.handle(mkReq(url, body), res)
  return res
}

/** Файл бэклога как рука, а не хранилище: дверь повышения строки читает его этим швом. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backlogFs = (): any => ({
  readdirSync() {
    throw new Error('ENOENT')
  },
  readFileSync(p: string) {
    if (String(p).replace(/\\/g, '/') === `${PROJECT}/.planning/BACKLOG.md`) return BACKLOG_FILE
    throw new Error(`ENOENT: ${p}`)
  },
  statSync() {
    throw new Error('ENOENT')
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function frontWith(adapter: any): any {
  return createFrontServer({
    config: {
      token: TOKEN,
      projects: [{ id: 'p1', name: 'мастерская', path: PROJECT }],
      activeProject: 'p1',
      workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      repoDir: PROJECT,
      agingHours: 24,
      backlogScanMinutes: 60,
      pipeline: { enabled: true },
    },
    deps: { adapter, clock: () => NOW, fsImpl: backlogFs(), deriveBacklog },
  })
}

// ═══════════ 1 · ОДНО ОБЕЩАНИЕ — ОДИН ЗАПРОС ═══════════════════════════════════════════════

describe('двери, ставящие работу пачкой, принимают обещание тем же запросом', () => {
  it('кусок сборки со своими словами кладёт обещание на строку сразу, а не вторым нажатием', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    const front = frontWith(queue)

    const res = await post(front, '/api/batch', {
      title: 'разгрести мелочь перед показом',
      lane: 'prod',
      items: [
        { title: 'починить дверь сборки', description: 'слова едут вместе со строкой', acceptance: FIVE_CRITERIA },
        'кусок без своих слов',
      ],
    })
    expect(res.statusCode).toBe(200)

    const rows = await queue.list({})
    const withWords = rows.find((r: any) => r.title === 'починить дверь сборки')
    const bare = rows.find((r: any) => r.title === 'кусок без своих слов')

    // ОБЕЩАНИЕ НА СТРОКЕ С ПЕРВОГО МИГА — до того, как её вообще можно взять.
    expect(withWords.acceptance).toEqual(FIVE_CRITERIA)
    expect(withWords.description).toBe('слова едут вместе со строкой')
    // …А У СОСЕДА ЕГО НЕТ, и дверь ничего ему не приписала: голая строка осталась голой.
    expect(bare.acceptance).toBeUndefined()
    // Обе — куски ОДНОЙ сборки: слова не увели кусок из-под общего идентификатора.
    expect(withWords.batchId).toBe(bare.batchId)
  })

  it('строка запроса сборки обещания не носит — она не работа, и её никто не берёт', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    const front = frontWith(queue)
    await post(front, '/api/batch', {
      title: 'разгрести мелочь',
      lane: 'prod',
      items: [{ title: 'кусок', acceptance: FIVE_CRITERIA }],
    })
    const rows = await queue.list({})
    const request = rows.find((r: any) => r.title === 'разгрести мелочь')
    expect(request.acceptance).toBeUndefined()
  })

  it('незнакомый ключ ВНУТРИ элемента — тот же отказ до всего, и в очередь не попадает ничего', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    const front = frontWith(queue)
    const res = await post(front, '/api/batch', {
      title: 'разгрести мелочь',
      lane: 'prod',
      items: [{ title: 'кусок', promise: 'не то имя поля' }],
    })
    expect(res.statusCode).toBe(400)
    expect(await queue.list({})).toHaveLength(0)
  })

  it('элемент не строкой и не объектом — отказ, а не задача с названием «null»', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    const front = frontWith(queue)
    for (const item of [null, 42, ['вложенный список'], { description: 'без названия' }]) {
      const res = await post(front, '/api/batch', { title: 'сборка', lane: 'prod', items: [item] })
      expect(res.statusCode, JSON.stringify(item)).toBe(400)
    }
    expect(await queue.list({})).toHaveLength(0)
  })

  it('строка бэклога, повышенная в работу, несёт своё обещание тем же запросом', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    const front = frontWith(queue)

    const res = await post(front, '/api/backlog/promote', {
      id: 'AB-205',
      lane: 'prod',
      description: 'что именно чинить',
      acceptance: FIVE_CRITERIA,
      taskContext: 'данные лежат в соседнем дереве',
    })
    expect(res.statusCode).toBe(200)

    const row = (await queue.list({})).find((r: any) => r.title.includes('AB-205'))
    expect(row.acceptance).toEqual(FIVE_CRITERIA)
    expect(row.description).toBe('что именно чинить')
    // Снимок контекста строка списка не носит нарочно — он едет на ВЫДАЧЕ, и там его и видно.
    const claimed = await queue.claimNext('w-1', {})
    expect(claimed.taskContext).toBe('данные лежат в соседнем дереве')
  })
})

// ═══════════ 2 · СЛОВА, ОПОЗДАВШИЕ К ЗАХВАТУ, ДОГОНЯЮТ ПОТОЛОК ═════════════════════════════

const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 12,
  total_cost_usd: 0.1,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
})

const SPAWN_ENV = { SMA_TEST_TOKEN: 'oauth-token-value', PATH: '/usr/bin' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsFs = (): any => ({
  readFileSync: (p: string) => {
    // Зеркало настроек аккаунта, как его пишет демон: без выключенных внешних коннекторов
    // сборщик аргументов честно отказывается собирать сессию, и до потолка дело не дойдёт.
    if (String(p).replace(/\\/g, '/').endsWith('settings.json')) return JSON.stringify({ disableClaudeAiConnectors: true })
    throw new Error(`ENOENT ${p}`)
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeVerbRunner = (responses: Record<string, any>) => async (_bin: string, argsArray: string[]) => {
  const verb = argsArray[1]
  const r = responses[verb] ?? { code: 0, stdout: '{}' }
  return typeof r === 'function' ? r() : r
}

const gateGit = (args: string[]) => {
  const verb = args[0]
  if (verb === 'rev-parse') return 'base0000'
  if (verb === 'rev-list') return '1'
  if (verb === 'diff') return 'M\tdaemon/src/loop.mjs'
  return ''
}

/** Число сразу за своим флагом: аргумент, отставший на шаг, — это другая командная строка. */
const capAt = (args: string[]) => {
  const at = args.indexOf('--max-turns')
  return at < 0 ? null : args[at + 1]
}

/**
 * Один настоящий тик над настоящей очередью — и, если дело о том, СЛОВА, ПРИЕЗЖАЮЩИЕ ДВЕРЬЮ
 * РОВНО МЕЖДУ ЗАХВАТОМ И СТАРТОМ. Это и есть та гонка: строка уже у работника, а обещание к
 * ней только сейчас доехало.
 */
async function runTick(over: { lateWords?: string[]; born?: Record<string, unknown> } = {}) {
  const projectDir = mkDir('sma-promise-proj-')
  const ledgerDir = mkDir('sma-promise-ledger-')
  const workDir = mkDir('sma-promise-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const queue = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
  await queue.enqueue({
    id: 'R-1',
    source: 'roster',
    title: 'починить дверь',
    lane: 'prod',
    ...(over.born ?? {}),
  })

  const front = frontWith(queue)
  const wordsAnswers: number[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = {
    ...queue,
    async claimNext(workerId: string, opts: any) {
      const claimed = await queue.claimNext(workerId, opts)
      if (claimed && over.lateWords) {
        const res = await post(front, '/api/task/words', { taskId: claimed.id, acceptance: over.lateWords })
        wordsAnswers.push(res.statusCode)
      }
      return claimed
    },
  }

  const config = {
    workers: [
      {
        id: 'max-2',
        lane: 'prod',
        provider: 'claude',
        enabled: true,
        account: { name: 'local-1', configDir: '/accounts/local-1', oauthTokenEnv: 'SMA_TEST_TOKEN' },
      },
    ],
    agingHours: 24,
    backlogScanMinutes: 60,
    repoDir: projectDir,
    pipeline: { enabled: true },
  }

  // НАСТОЯЩИЙ СБОРЩИК АРГУМЕНТОВ, а не запись о том, что его позвали: число обязано оказаться
  // на командной строке запускаемого процесса, и проверяется именно она.
  const realBuildArgs = createBuildArgs({ config, env: SPAWN_ENV, fsImpl: settingsFs() })
  const specs: any[] = []
  const journal: any[] = []

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config,
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: (task: any, route: any, options: any) => {
      const spec = realBuildArgs(task, route, options)
      specs.push({ task, options, spec })
      return spec
    },
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: workDir,
          branch: 'wt/R-1',
          materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 812 }],
        }),
      },
      reverify: { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) },
    }),
    spawnWorker: (spec: any) => {
      spec.onLine?.(RESULT_OK)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: () => {},
    report: async () => {},
    clock: () => NOW,
    journal: (entry: any) => journal.push(entry),
    execGit: gateGit,
  }

  const res = await tick(deps)
  return { res, specs, journal, queue, wordsAnswers, config }
}

describe('обещание, приехавшее после захвата и до старта, считается потолком этой же попытки', () => {
  it('КРАСНЫЙ: взятая до слов работа НЕ уходит в процесс с мелким потолком', async () => {
    const { specs, wordsAnswers } = await runTick({ lateWords: FIVE_CRITERIA })

    // Дверь правки слов действительно сработала на уже ВЗЯТОЙ строке — иначе дело было бы
    // не о гонке, а о задаче, которой обещания так и не написали.
    expect(wordsAnswers).toEqual([200])
    expect(specs).toHaveLength(1)

    // И вот оно, число на командной строке запускаемого процесса.
    expect(capAt(specs[0].spec.args)).toBe(String(LARGE))
    expect(capAt(specs[0].spec.args)).not.toBe(String(BASE))
    // Работник получил и сами слова, а не только их число ходов.
    expect(specs[0].task.acceptance).toEqual(FIVE_CRITERIA)
  })

  it('и приход слов назван вслух — молча потолок не меняется', async () => {
    const { journal } = await runTick({ lateWords: FIVE_CRITERIA })
    const said = journal.find((e) => e.type === 'task.promise_arrived')
    expect(said).toBeTruthy()
    expect(said.taskId).toBe('R-1')
    expect(said.detail).toContain('acceptance')
  })

  it('слов никто не написал — потолок остаётся базовым, и никакого запаса не выдумано', async () => {
    const { specs, journal } = await runTick()
    expect(capAt(specs[0].spec.args)).toBe(String(BASE))
    expect(journal.some((e) => e.type === 'task.promise_arrived')).toBe(false)
  })

  it('обещание, написанное ПРИ постановке, доезжает тем же числом — путь не раздвоился', async () => {
    const { specs, journal } = await runTick({ born: { acceptance: FIVE_CRITERIA } })
    expect(capAt(specs[0].spec.args)).toBe(String(LARGE))
    // Ничего не «приезжало»: строка и так всё сказала о себе.
    expect(journal.some((e) => e.type === 'task.promise_arrived')).toBe(false)
  })
})

// ═══════════ 3 · ДОСКА НАЗЫВАЕТ ЧИСЛО, ПОКА ЕГО ЕЩЁ МОЖНО ИЗМЕНИТЬ ═════════════════════════

describe('строка без обещания говорит человеку, какой потолок она за это получит', () => {
  const boardOf = async (queue: any, config: any) =>
    deriveState({
      adapter: queue,
      windows: () => ({ fiveHour: { status: 'open' }, week: { status: 'open' } }),
      config,
      clock: () => NOW,
    })

  it('у ждущей работника строки без обещания едет настоящее число, а у обещавшей — ничего', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    await queue.enqueue({ id: 'R-2', source: 'roster', title: 'молчаливая', lane: 'prod' })
    await queue.enqueue({ id: 'R-3', source: 'roster', title: 'обещавшая', lane: 'prod', acceptance: FIVE_CRITERIA })

    const config = { workers: [], agingHours: 24, pipeline: { enabled: true, maxTurns: 160 } }
    const payload: any = await boardOf(queue, config)
    const mute = payload.queue.find((q: any) => q.id === 'R-2')
    const spoken = payload.queue.find((q: any) => q.id === 'R-3')

    expect(mute.noPromise).toEqual({ cap: 160 })
    expect(mute.noPromise.cap).toBe(pipelineMaxTurns(config))
    expect(spoken.noPromise).toBeUndefined()
  })

  it('оценка числом — тоже объявленный размер: над крупной работой слова «без обещания» нет', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    await queue.enqueue({ id: 'BL-9', source: 'backlog', title: 'крупная по оценке', lane: 'prod', storyPoints: 8, acceptance: 'зелёные тесты' })
    const payload: any = await boardOf(queue, { workers: [], agingHours: 24, pipeline: { enabled: true } })
    expect(payload.queue.find((q: any) => q.id === 'BL-9').noPromise).toBeUndefined()
  })

  it('и это доезжает СЛОВОМ до строки на доске, а не остаётся полем в ответе двери', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    await queue.enqueue({ id: 'R-5', source: 'roster', title: 'молчаливая', lane: 'prod' })
    await queue.enqueue({ id: 'R-6', source: 'roster', title: 'обещавшая', lane: 'prod', acceptance: FIVE_CRITERIA })
    const payload: any = await boardOf(queue, { workers: [], agingHours: 24, pipeline: { enabled: true, maxTurns: 160 } })

    // Единицы строятся ТЕМ ЖЕ путём, каким их строит экран, и из ТЕХ ЖЕ рядов, что отдала дверь.
    const board: any = buildUnits({
      queue: payload.queue,
      awaiting: [],
      workers: [],
      done: [],
      batches: [],
      phases: [],
      activeProject: null,
      machine: '',
      selfMachine: payload.queue[0].machine,
      clock: () => '12:00',
      now: NOW,
    } as any)
    const all: any[] = Array.isArray(board) ? board : [...(board.units ?? [])]
    const mute = all.find((u: any) => u.id === 'R-5')
    const spoken = all.find((u: any) => u.id === 'R-6')

    expect(mute.inner).toContain('без обещания: потолок 160')
    expect(spoken.inner).not.toContain('без обещания')
  })

  it('взятая строка молчит: число уже уехало, и совет «допишите» ничего бы не изменил', async () => {
    const queue = createMemoryQueue({ clock: () => NOW })
    await queue.enqueue({ id: 'R-4', source: 'roster', title: 'уже у работника', lane: 'prod' })
    await queue.claimNext('w-1', {})
    const payload: any = await boardOf(queue, { workers: [], agingHours: 24, pipeline: { enabled: true } })
    expect(payload.queue.find((q: any) => q.id === 'R-4')).toBeUndefined()
    expect((payload.tasks ?? []).every((t: any) => t.noPromise === undefined)).toBe(true)
  })
})
