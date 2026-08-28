/**
 * ЧЕТЫРЕ ЧИСЛА ПОСТАВЩИКА — ПРОВОД ОТ КАДРА ПОТОКА ДО КВИТАНЦИИ ПОПЫТКИ.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ И ЧЕГО НЕ ДОКАЗЫВАЕТ. Он НЕ проверяет арифметику — сложение чисел
 * проверяется там, где оно живёт. Он проверяет ровно одно: числа, которые сказал финальный
 * кадр, ДОЕХАЛИ до файла на диске, который человек откроет через месяц. Ровно этот класс
 * дефекта — «посчитано, но не подключено» — уже случался в этом дереве: вердикт паритета
 * считался безупречно и писался в квитанцию `null`, потому что между расчётом и записью не
 * было провода. Поэтому здесь ничего не зовётся напрямую: гоняется НАСТОЯЩИЙ тик, и
 * утверждается `receipt.json` НА ДИСКЕ.
 *
 * ПЯТЬ СЛУЧАЕВ, И КАЖДЫЙ — ПРО ПРОВОД:
 *
 *   (1) известные числа в кадре → те же числа в квитанции успешной попытки;
 *   (2) те же числа — в строке книги трат, снятые с ТОГО ЖЕ кадра: один разбор на двух
 *       читателей, а не два читателя, которые согласны только в день написания;
 *   (3) ПРОВАЛИВШАЯСЯ попытка несёт их тоже. Она их потратила ровно так же, и запись, которая
 *       есть только у успешной, бесполезна именно тогда, когда нужна;
 *   (4) битый `usage` (кадр есть, счётчиков нет) → нули и записанный исход, а не падение;
 *   (5) финального кадра не было вовсе → честное отсутствие (`null`), а не выдуманные нули:
 *       книга в этом случае получает ОЦЕНКУ, и оценке не место в поле «поставщик сообщил».
 *
 * ОБА НАПИСАНИЯ ПОЛЕЙ проверяются в (1) и (4): внешняя командная строка писала счётчики и
 * camelCase, и snake_case, а читатель, знающий одно написание, молча отдаёт нули на потоке,
 * который всё сказал.
 *
 * ОБСТАНОВКА ТИКА — та же, что у соседнего сьюта провода: настоящая очередь, настоящий леджер,
 * настоящая копия на диске, и никаких заглушек, кроме стоков.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'

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

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ── кадры ──────────────────────────────────────────────────────────────────────────────────

/** ЧИСЛА, КОТОРЫЕ ИЩЕМ НА ДИСКЕ. Четыре разных — совпадение перепутанных полей исключено. */
const IN = 1234
const OUT = 567
const CACHE_READ = 89_012
const CACHE_WRITE = 3456

/** Финальный кадр в camelCase — так его пишет сегодняшняя командная строка. */
const RESULT_CAMEL = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.42,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
  modelUsage: {
    'claude-opus-5': {
      inputTokens: IN,
      outputTokens: OUT,
      cacheReadInputTokens: CACHE_READ,
      cacheCreationInputTokens: CACHE_WRITE,
    },
  },
})

/** Тот же кадр в snake_case — так его писали раньше и пишет часть сборок. */
const RESULT_SNAKE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.42,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
  model_usage: {
    'claude-opus-5': {
      input_tokens: IN,
      output_tokens: OUT,
      cache_read_input_tokens: CACHE_READ,
      cache_creation_input_tokens: CACHE_WRITE,
    },
  },
})

/** Кадр есть, счётчиков нет — ровно та форма, на которой читатель раньше падал бы. */
const RESULT_BROKEN = JSON.stringify({
  type: 'result',
  subtype: 'success',
  total_cost_usd: null,
  modelUsage: 'ерунда вместо объекта',
})

const NOTE = 'APPROACH_NOTE: прямой путь'
const LESSON = 'LESSON_NONE: задача была чистым чтением'
const PROMPT = 'сделай дело и оставь квитанцию'

const SPAWN_ENV = { CLAUDE_CONFIG_DIR: 'C:\\work\\.sma-accounts\\local-1', PATH: '/usr/bin' }
const WORKER_ID = 'max-2'

const backlogTask = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

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

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) }
const RED_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'red', receiptRef: 'reverify:red', diffStat: '+1 -1' }) }

/**
 * Один настоящий тик над временным проектом. Книга трат подключена НАСТОЯЩИМ сборщиком строк
 * (`deps.bookUsage`), потому что случай (2) — про то, что книга и квитанция читают один кадр.
 */
async function runTick(over: any = {}) {
  const projectDir = mkDir('sma-tok-proj-')
  const ledgerDir = mkDir('sma-tok-ledger-')
  const workDir = mkDir('sma-tok-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const lines: string[] = over.lines ?? [RESULT_CAMEL, NOTE, LESSON]
  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const booked: any[] = []

  const workers = [{ id: WORKER_ID, lane: 'prod', provider: 'claude', account: { name: 'local-1', configDir: '/x' }, enabled: true }]

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: { workers, agingHours: 24, backlogScanMinutes: 60, repoDir: projectDir, pipeline: { enabled: true } },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: () => ({ bin: 'claude', args: buildClaudeArgs({}), env: { ...SPAWN_ENV }, prompt: PROMPT }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: workDir,
          branch: 'wt/BL-1',
          materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 812 }],
        }),
      },
      reverify: over.reverify ?? GREEN_REVERIFY,
    }),
    spawnWorker: (spec: any) => {
      for (const l of lines) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    // Книга трат — настоящий сток строки, а не запись на диск: сьюту нужна строка, а не файл.
    bookUsage: (row: any) => booked.push(row),
    report: async () => {},
    clock: c.clock,
    journal: () => {},
    execGit: gateGit,
  }

  const res = await tick(deps)
  return { res, projectDir, ledgerDir, workDir, booked, runDir: join(projectDir, '.sma', 'runs', 'BL-1_1') }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

// ═══════════ КАДР → КВИТАНЦИЯ ══════════════════════════════════════════════════════════════

describe('поток → квитанция попытки: четыре числа поставщика доезжают до диска', () => {
  it('известные числа кадра лежат в receipt.json попытки — все четыре', async () => {
    const { res, runDir } = await runTick()
    expect(res.completed).toBe('BL-1')

    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.tokens).toEqual({ input: IN, output: OUT, cacheRead: CACHE_READ, cacheWrite: CACHE_WRITE })
  })

  it('snake_case тех же полей читается так же — иначе провод молча отдаёт нули', async () => {
    const { runDir } = await runTick({ lines: [RESULT_SNAKE, NOTE, LESSON] })
    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.tokens).toEqual({ input: IN, output: OUT, cacheRead: CACHE_READ, cacheWrite: CACHE_WRITE })
  })

  it('книга трат и квитанция сняты с ОДНОГО кадра — все четыре числа совпадают', async () => {
    const { runDir, booked } = await runTick()
    const receipt = readJson(join(runDir, 'receipt.json'))

    expect(booked).toHaveLength(1)
    expect(booked[0].source).toBe('stream-result')
    expect(booked[0].inputTokens).toBe(receipt.tokens.input)
    expect(booked[0].outputTokens).toBe(receipt.tokens.output)
    // КЭШ ТОЖЕ, и это не педантизм: без него по книге не считается цена «как если бы по API» —
    // чтение и запись кэша стоят своих ставок, и строка без них занижает счёт молча.
    expect(booked[0].cacheReadTokens).toBe(receipt.tokens.cacheRead)
    expect(booked[0].cacheWriteTokens).toBe(receipt.tokens.cacheWrite)
  })

  it('ПРОВАЛИВШАЯСЯ попытка несёт те же числа — она их потратила ровно так же', async () => {
    const { res, runDir } = await runTick({ reverify: RED_REVERIFY })
    expect(res.failed?.taskId).toBe('BL-1')

    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.outcome).toBe('failed')
    expect(receipt.tokens).toEqual({ input: IN, output: OUT, cacheRead: CACHE_READ, cacheWrite: CACHE_WRITE })
  })
})

// ═══════════ БИТОЕ И ОТСУТСТВУЮЩЕЕ — ЗАПИСЬ ИСХОДА НЕ ПАДАЕТ ═══════════════════════════════

describe('битый и отсутствующий usage: исход записан, числа честны', () => {
  it('кадр есть, счётчиков нет → нули, а исход попытки записан', async () => {
    const { res, runDir } = await runTick({ lines: [RESULT_BROKEN, NOTE, LESSON] })
    expect(res.completed).toBe('BL-1')

    expect(existsSync(join(runDir, 'receipt.json'))).toBe(true)
    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('финального кадра не было вовсе → null, а не выдуманные нули; книга получает оценку', async () => {
    const { res, runDir, booked } = await runTick({ lines: [NOTE, LESSON] })
    expect(res.completed).toBe('BL-1')

    const receipt = readJson(join(runDir, 'receipt.json'))
    // «Поставщик ничего не сказал» и «поставщик сказал ноль» — разные предложения, и только
    // одно из них здесь правда. Оценка живёт в книге и честно называется оценкой.
    expect(receipt.tokens).toBe(null)
    expect(booked).toHaveLength(1)
    expect(booked[0].source).toBe('estimate')
  })
})
