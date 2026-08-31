/**
 * Tests for the attempt's RUN DIRECTORY — `<projectDir>/.sma/runs/<attemptId>/`.
 *
 * WHAT IS BEING PROVED HERE IS A WIRE, NOT A CALCULATION. Every piece of this record existed
 * already — the stream was parsed, the envelope was hashed, the transcript was written, the
 * gate reached a verdict — and not one of them was ever handed to the thing that has to read
 * them together. So the cases below drive a REAL tick over a REAL temporary project and then
 * open the four files on disk: run.json, guards.jsonl, transcript.jsonl, receipt.json. A test
 * that called the writer directly would pass with the wire cut, which is exactly the failure
 * this file exists to make impossible.
 *
 * THE STREAM IS NOT INVENTED. Both fixtures are frames lifted off real runs of this daemon —
 * the session's opening frame with its tool and skill lists, two hooks starting and two
 * answering, a Read of the memory index with the tool_result it really came back with, a call
 * of the memory pipeline with its real answer, a shell guard refusing a command, and a result
 * frame. Only the founder's paths, the session ids and the note names were replaced. A fake
 * richer than the library has already once shown a green suite over a broken wire.
 *
 * SECRETS ARE AN ASSERTION, NOT AN INTENTION. The spawn in these cases is handed a token and
 * an api key with recognisable values, and one case reads all four files as bytes and demands
 * that neither value appears in any of them.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { tick, rulesInCopy } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { pruneRunDirs, ledgerRef, runsDirOf, sanitizeRun, secretValuesOf, RUN_SCHEMA, RECEIPT_SCHEMA, RUN_FILES, RUN_DIR_TAKEN } from '../src/queue/run-dir.mjs'

// ── the temporary world ────────────────────────────────────────────────────────────────────

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
      /* best-effort */
    }
  }
})

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ── the fixtures: real frames, neutral names ───────────────────────────────────────────────

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

const NOTE = 'APPROACH_NOTE: прямой путь'
const LESSON = 'LESSON_NONE: задача была чистым чтением'

// The values a leak would look like. Recognisable on sight, long enough to be a needle.
const TOKEN_VALUE = 'sk-ant-oat01-THIS-IS-THE-TOKEN-VALUE-0123456789'
const API_KEY_VALUE = 'sk-ant-api03-THIS-IS-THE-API-KEY-VALUE-9876543210'
const PROMPT = 'сделай дело и оставь квитанцию'

const SPAWN_ENV = {
  CLAUDE_CONFIG_DIR: 'C:\\work\\.sma-accounts\\local-1',
  SMA_LOCAL_1_TOKEN: TOKEN_VALUE,
  ANTHROPIC_API_KEY: API_KEY_VALUE,
  PATH: '/usr/bin',
}

const backlogTask = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  // СНИМОК КОНТЕКСТА НЕСЁТ ИГОЛКУ НАМЕРЕННО. Шестой файл каталога — единственный, куда
  // попадает текст, который печатал ЧЕЛОВЕК, а человек вставляет в такие поля что угодно.
  // Пояс проверяется на нём тем же делом, что и на остальных пяти.
  taskContext: `снимок для работника\nслучайно вставлен ${TOKEN_VALUE}\nхвост снимка`,
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

/**
 * Тот же git, но отвечающий на НАСТОЯЩИЙ вопрос об изменённых файлах. `gateGit` смотрит на
 * первое слово, а вопрос об изменённых файлах начинается с `-c core.quotepath=false`, —
 * поэтому по умолчанию список пуст, и случай «нечего передать» получается сам собой.
 */
const gitWithChanges = (args: string[]) =>
  args.includes('diff') && args.includes('--name-status') ? 'M	daemon/src/loop.mjs' : gateGit(args)

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) }
const RED_REVERIFY = { code: 1, stdout: JSON.stringify({ verdict: 'red' }) }

/**
 * One full tick over a real temporary project, a real ledger and a real copy on disk.
 * Returns everything a case might want to open afterwards.
 */
async function runTick(over: any = {}) {
  const projectDir = over.projectDir ?? mkDir('sma-run-proj-')
  const ledgerDir = mkDir('sma-run-ledger-')
  const workDir = over.workDir ?? mkDir('sma-run-copy-')
  const lines: string[] = over.lines ?? [...framesOf('claude-stream-parity-green.ndjson', workDir), NOTE, LESSON]
  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(over.task ?? backlogTask())
  const logged: any[] = []

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: projectDir,
      pipeline: { enabled: true },
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-', '--allowedTools', 'Read,Bash'], env: { ...SPAWN_ENV }, prompt: PROMPT }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: workDir, branch: 'wt/BL-1' }) },
      reverify: over.reverify ?? GREEN_REVERIFY,
    }),
    spawnWorker: (spec: any) => {
      for (const l of lines) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => logged.push(e),
    execGit: gateGit,
    ...over.deps,
  }

  const res = await tick(deps)
  const attempt = Number((over.task && over.task.attempt) || 1)
  return { res, projectDir, ledgerDir, workDir, logged, runDir: join(projectDir, '.sma', 'runs', `BL-1_${attempt}`) }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const readLines = (path: string) =>
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

// ═══════════ THE DIRECTORY ITSELF ══════════════════════════════════════════════════════════

describe('каждая попытка оставляет каталог прогона в подключённом проекте', () => {
  it('все файлы замороженного списка на месте, и они про ЭТУ попытку', async () => {
    const { res, runDir } = await runTick()

    expect(res.completed).toBe('BL-1')
    for (const name of RUN_FILES) {
      expect(existsSync(join(runDir, name))).toBe(true)
    }

    const run = readJson(join(runDir, 'run.json'))
    expect(run.schema).toBe(RUN_SCHEMA)
    expect(run.attemptId).toBe('BL-1#1')
    expect(run.taskId).toBe('BL-1')
    expect(run.attempt).toBe(1)
    expect(run.workerId).toBe('max-2')
    expect(run.provider).toBe('claude')
    expect(run.lane).toBe('prod')
    expect(typeof run.startedAt).toBe('string')
    expect(typeof run.endedAt).toBe('string')
    expect(run.bin).toBe('claude')
    expect(run.args).toContain('--allowedTools')
  })

  it('в run.json — ИМЕНА переменных среды, отсортированные, и хэш промпта вместо промпта', async () => {
    const { runDir } = await runTick()
    const run = readJson(join(runDir, 'run.json'))

    expect(run.envNames).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'PATH', 'SMA_LOCAL_1_TOKEN'])
    expect(run.prompt).toEqual({
      sha256: createHash('sha256').update(PROMPT, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(PROMPT, 'utf8'),
    })
    expect(run.prompt.text).toBeUndefined()
  })

  it('ни одно значение токена или ключа из spec.env не встречается НИ В ОДНОМ файле каталога', async () => {
    const { runDir } = await runTick()

    for (const name of RUN_FILES) {
      const bytes = readFileSync(join(runDir, name), 'utf8')
      expect(bytes).not.toContain(TOKEN_VALUE)
      expect(bytes).not.toContain(API_KEY_VALUE)
      // и ни одного значения любой переменной, чьё ИМЯ говорит «секрет»
      for (const value of secretValuesOf(SPAWN_ENV)) expect(bytes).not.toContain(value)
    }
  })

  it('в run.json — конверт, копия и то, что сессия сказала о себе в открывающем кадре', async () => {
    const { runDir, workDir } = await runTick()
    const run = readJson(join(runDir, 'run.json'))

    expect(run.envelope.allowedTools).toBeInstanceOf(Array)
    expect(typeof run.envelope.hash).toBe('string')
    expect(run.copy.worktreePath).toBe(workDir)
    expect(run.copy.branch).toBe('wt/BL-1')
    // открывающий кадр живой сессии: инструменты, навыки, агенты, режим прав
    expect(run.init.tools).toContain('Read')
    expect(run.init.permissionMode).toBe('default')
    expect(run.init.skills.length).toBeGreaterThan(0)
    expect(run.init.agents.length).toBeGreaterThan(0)
    expect(typeof run.init.memoryPathsAuto).toBe('string')
  })

  it('guards.jsonl — строка на каждый хук живого потока: два старта и два ответа', async () => {
    const { runDir } = await runTick()
    const guards = readLines(join(runDir, 'guards.jsonl'))

    expect(guards.filter((g) => g.kind === 'hook_started')).toHaveLength(2)
    const answered = guards.filter((g) => g.kind === 'hook_response')
    expect(answered).toHaveLength(2)
    expect(answered[0].hookName).toBe('SessionStart:startup')
    expect(answered[0].hookEvent).toBe('SessionStart')
    expect(answered[0].exitCode).toBe(0)
    expect(answered[0].outcome).toBe('success')
    for (const g of guards) expect(typeof g.ts).toBe('string')
  })

  it('transcript.jsonl — ССЫЛКА на стенограмму в леджере с её настоящим sha256, а не копия', async () => {
    const { runDir, ledgerDir } = await runTick()
    const [ref] = readLines(join(runDir, 'transcript.jsonl'))

    expect(ref.kind).toBe('ledger-ref')
    const raw = readFileSync(ref.ledgerPath, 'utf8')
    expect(ref.sha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'))
    expect(ref.lines).toBeGreaterThan(0)
    expect(ref.bytes).toBe(Buffer.byteLength(raw, 'utf8'))
    expect(ref.truncatedLines).toBe(0)
    expect(ref.ledgerPath.startsWith(ledgerDir)).toBe(true)
    // ссылка, а не копия: файл маленький, кадров в нём нет
    expect(readFileSync(join(runDir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('receipt.json — исход, гейт, вердикт и честный слой памяти', async () => {
    const { runDir } = await runTick()
    const receipt = readJson(join(runDir, 'receipt.json'))

    expect(receipt.schema).toBe(RECEIPT_SCHEMA)
    expect(receipt.outcome).toBe('completed')
    expect(receipt.gate).toBe('reverify')
    expect(receipt.verdict).toBe('green')
    expect(receipt.ref).toBe('reverify:abc')
    expect(receipt.memoryLayer.index).toBe(true)
    expect(receipt.memoryLayer.loadCalls).toBe(1)
    expect(receipt.lesson).toEqual({ none: 'задача была чистым чтением' })
    // ВЕРДИКТ ПАРИТЕТА ЛЕЖИТ РЯДОМ С ИСХОДОМ, а не ждёт, пока кто-то запустит команду.
    // Копия этого случая — голая: правил проекта в ней нет, а список инструментов спавна
    // собран здешней заглушкой и конверту не равен. Шестёрка обязана сказать об этом ИМЕНАМИ
    // и остаться неполной: проверка, которая на голой копии показывает зелёное, не проверка.
    // Профиль здесь зелёный по делу: работнику этого конфига ни модель, ни усилие не
    // назначены, спавн не несёт ни одного такого флага — назначенного не подменяли.
    expect(receipt.parity.results.map((r: any) => r.id)).toEqual(['hooks', 'memory', 'rules', 'skills', 'rights', 'profile'])
    expect(receipt.parity.summary.failed).toEqual(['rules', 'rights'])
    expect(receipt.parity.summary.fulfilled).toBe(4)
    expect(receipt.parity.summary.total).toBe(6)
  })
})

// ═══════════ ЧЕСТНАЯ ПАМЯТЬ И ОТКАЗЫ СТРАЖЕЙ ═══════════════════════════════════════════════

describe('красная фикстура: провалившееся чтение индекса и отказ стража — на записи', () => {
  it('Read индекса упал → memoryLayer.index:false, и провал назван', async () => {
    const workDir = mkDir('sma-run-copy-red-')
    const { runDir } = await runTick({
      workDir,
      lines: [...framesOf('claude-stream-parity-red-memory.ndjson', workDir), NOTE, LESSON],
    })

    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.memoryLayer.index).toBe(false)
    const run = readJson(join(runDir, 'run.json'))
    expect(run.memory.index).toBe(false)
    expect(run.memory.failed.some((f: any) => f.kind === 'index')).toBe(true)
  })

  it('отказ инструмента стражем — строка guards.jsonl, а не молчание', async () => {
    const workDir = mkDir('sma-run-copy-den-')
    const { runDir } = await runTick({
      workDir,
      lines: [...framesOf('claude-stream-parity-red-memory.ndjson', workDir), NOTE, LESSON],
    })

    const denied = readLines(join(runDir, 'guards.jsonl')).filter((g) => g.kind === 'denied')
    expect(denied).toHaveLength(1)
    expect(denied[0].tool).toBe('PowerShell')
    expect(denied[0].reason).toContain('subexpressions')
  })
})

// ═══════════ ОБА ИСХОДА ════════════════════════════════════════════════════════════════════

describe('каталог есть у КАЖДОГО исхода, а не только у принятого', () => {
  it('проваленная попытка тоже оставляет весь список файлов и квитанцию с причиной', async () => {
    const { res, runDir } = await runTick({ reverify: RED_REVERIFY })

    expect(res.failed?.taskId).toBe('BL-1')
    for (const name of RUN_FILES) {
      expect(existsSync(join(runDir, name))).toBe(true)
    }
    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.outcome).toBe('failed')
    expect(receipt.failureReason).toBe(res.failed.reason)
    expect(receipt.verdict).toBe('red')
  })

  it('путь каталога и вердикт уезжают на строку попытки — runDir и parity', async () => {
    const { ledgerDir, runDir } = await runTick()
    const [row] = readAttempts(ledgerDir, 'BL-1')

    expect(row.runDir).toBe(runDir)
    // Строка попытки — та самая запись, из которой строится карточка: вердикт, доехавший
    // только до файла в каталоге, для человека не существует. И это ТА ЖЕ сводка, что в
    // квитанции, а не вторая, посчитанная по дороге.
    expect(row.parity).toEqual(readJson(join(runDir, 'receipt.json')).parity.summary)
    expect(row.parity.fulfilled).toBe(4)
  })
})

// ═══════════ ПЯТЫЙ ФАЙЛ: КОНСПЕКТ ПЕРЕДАЧИ ═════════════════════════════════════════════════

/**
 * КОНСПЕКТ ПЕРЕДАЧИ — то, что попытка оставляет следующей попытке и человеку.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Не сборка текста, а ФАЙЛ, оказавшийся в каталоге ИМЕННО ЭТОЙ
 * попытки после настоящего тика: писатель и оба читателя сходятся только на пути, и путь —
 * единственное, что нельзя проверить вызовом писателя напрямую.
 *
 * ПОЧЕМУ ПОТОЛОК ПРОВЕРЯЕТСЯ ЧИСЛОМ, А НЕ КОНСТАНТОЙ. Восемь тысяч знаков — это ДОГОВОР, а
 * не деталь реализации: у файла два читателя, и если завтра константу подвинут, обрезка у
 * промпта и у окна разъедутся молча. Число написано здесь буквами ровно затем, чтобы такая
 * правка была видна как правка договора.
 *
 * ОБРЕЗКА ПРОВЕРЯЕТСЯ ИСКУССТВЕННО ДЛИННЫМ ВХОДОМ, потому что конспект настоящей попытки в
 * потолок не упирается — и это ожидаемо: путь обрезки иначе не был бы пройден ни разу.
 */
describe('пятый файл каталога прогона — конспект передачи', () => {
  it('конспект назван в замороженном списке ровно один раз', () => {
    expect(RUN_FILES.filter((n: string) => n === 'continuation.md')).toHaveLength(1)
  })

  it('конспект лежит в каталоге ЭТОЙ попытки и собран из того, что попытка уже записала', async () => {
    const { runDir } = await runTick({ deps: { execGit: gitWithChanges } })
    const text = readFileSync(join(runDir, 'continuation.md'), 'utf8')

    expect(text).toContain('BL-1')
    expect(text).toContain('прямой путь') // записка о подходе — уже разобранная, не пересобранная
    expect(text).toContain('completed') // исход, как его записала квитанция
    expect(text).toContain('daemon/src/loop.mjs') // тронутые файлы — ответ git, уже полученный
  })

  it('короткий конспект пишется целиком и пометки обрезки не несёт', async () => {
    const { runDir } = await runTick({ deps: { execGit: gitWithChanges } })
    const text = readFileSync(join(runDir, 'continuation.md'), 'utf8')

    expect(text.length).toBeLessThan(8000)
    expect(text).not.toContain('обрезан')
  })

  it('конспект длиннее потолка обрезан ПРИ ЗАПИСИ, с пометкой в тексте; файл не длиннее 8000 знаков', async () => {
    const long = 'ц'.repeat(20000)
    const { runDir } = await runTick({ lines: [`APPROACH_NOTE: ${long}`, LESSON] })
    const text = readFileSync(join(runDir, 'continuation.md'), 'utf8')

    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).toContain('обрезан')
    expect(text).toContain('цццццццццц') // обрезан, а не выброшен целиком
  })

  it('передавать нечего — так и написано, а не пустой файл и не отсутствие файла', async () => {
    const { runDir } = await runTick({ lines: [] })

    expect(existsSync(join(runDir, 'continuation.md'))).toBe(true)
    const text = readFileSync(join(runDir, 'continuation.md'), 'utf8')
    expect(text).toContain('нечего передать')
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('секрет из записки о подходе не доезжает до конспекта — тот же пояс, что у остальных файлов', async () => {
    const { runDir } = await runTick({ lines: [`APPROACH_NOTE: подход с ключом ${TOKEN_VALUE} внутри`, LESSON] })
    const text = readFileSync(join(runDir, 'continuation.md'), 'utf8')

    expect(text).not.toContain(TOKEN_VALUE)
    expect(text).toContain('[redacted]')
  })
})

// ═══════════ РОТАЦИЯ СО СЛЕДОМ ═════════════════════════════════════════════════════════════

describe('каталог прогонов ограничен, и каждое удаление оставляет след', () => {
  it('205 каталогов при keep=200 → остаётся 200, и пять строк run-dir-pruned', () => {
    const projectDir = mkDir('sma-run-prune-')
    const runsDir = runsDirOf(projectDir) as string
    mkdirSync(runsDir, { recursive: true })
    for (let i = 0; i < 205; i += 1) {
      const dir = join(runsDir, `R-${1000 + i}_1`)
      mkdirSync(dir, { recursive: true })
      // возраст читается из run.json — самые старые пять уходят
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ startedAt: new Date(1_700_000_000_000 + i * 1000).toISOString() }), 'utf8')
    }

    const logged: any[] = []
    const out = pruneRunDirs({ runsDir, keep: 200, log: (e: any) => logged.push(e) })

    expect(out.removed).toHaveLength(5)
    expect(out.kept).toBe(200)
    expect(readdirSync(runsDir)).toHaveLength(200)
    const pruned = logged.filter((e) => e.type === 'run-dir-pruned')
    expect(pruned).toHaveLength(5)
    expect(pruned.map((e) => e.attemptId).sort()).toEqual(['R-1000_1', 'R-1001_1', 'R-1002_1', 'R-1003_1', 'R-1004_1'])
    // остались самые НОВЫЕ
    expect(existsSync(join(runsDir, 'R-1204_1'))).toBe(true)
    expect(existsSync(join(runsDir, 'R-1000_1'))).toBe(false)
  })

  it('ротация fail-open: отсутствующего каталога достаточно, чтобы не делать ничего', () => {
    expect(pruneRunDirs({ runsDir: join(mkDir('sma-run-none-'), 'nope') })).toEqual({ removed: [], kept: 0 })
  })
})

// ═══════════ ВТОРОЙ ПОЯС ═══════════════════════════════════════════════════════════════════

describe('пояса, на которые опирается запись', () => {
  it('sanitizeRun вырезает значение секрета, где бы оно ни лежало', () => {
    const out: any = sanitizeRun(
      { envNames: ['SMA_LOCAL_1_TOKEN'], nested: { deep: [`prefix ${TOKEN_VALUE} suffix`] }, plain: 'ничего' },
      { secretValues: [TOKEN_VALUE] },
    )
    expect(out.envNames).toEqual(['SMA_LOCAL_1_TOKEN']) // ИМЯ остаётся — имя не секрет
    expect(out.nested.deep[0]).toBe('[redacted]')
    expect(out.plain).toBe('ничего')
  })

  it('ledgerRef на нечитаемом пути честно говорит об этом, а не бросает', () => {
    const ref = ledgerRef({ ledgerPath: join(mkDir('sma-run-ref-'), 'нет-такого.ndjson') })
    expect(ref.kind).toBe('ledger-ref')
    expect(ref.unreadable).toBe(true)
    expect(ref.sha256).toBe(null)
  })
})

describe('the rules receipt says which of two different things happened', () => {
  // A furnishing list carries one entry per thing the provisioning verb was asked about, and an
  // entry whose mode is 'absent' is the verb reporting that there was NOTHING there to take.
  // Reading such an entry as evidence of a carry states the opposite of what it says.
  const io = (present: boolean) => ({ existsSync: () => present })

  it('an entry that says nothing was carried is not evidence that something was', () => {
    const list = [{ path: 'CLAUDE.md', mode: 'absent', files: 0 }]
    expect(rulesInCopy(io(true), '/copy', { materialized: list }).claudeMd).toBe('tracked')
  })

  it('a copied rules directory is a carry, and says so', () => {
    const list = [{ path: '.claude/', mode: 'copy', files: 28 }]
    expect(rulesInCopy(io(true), '/copy', { materialized: list }).claudeMd).toBe('materialized')
  })

  it('a copied rules file is a carry too', () => {
    const list = [{ path: 'CLAUDE.md', mode: 'copy', files: 1 }]
    expect(rulesInCopy(io(true), '/copy', { materialized: list }).claudeMd).toBe('materialized')
  })

  it('a linked path is the project own tree, not something carried into the copy', () => {
    const list = [{ path: '.claude', mode: 'link', target: '/elsewhere/.claude' }]
    expect(rulesInCopy(io(true), '/copy', { materialized: list }).claudeMd).toBe('tracked')
  })

  it('an unrelated carry does not make the rules look carried', () => {
    const list = [{ path: 'node_modules', mode: 'copy', files: 900 }]
    expect(rulesInCopy(io(true), '/copy', { materialized: list }).claudeMd).toBe('tracked')
  })

  it('no rules in the copy at all is absent, whatever the list says', () => {
    const list = [{ path: '.claude/', mode: 'copy', files: 28 }]
    expect(rulesInCopy(io(false), '/copy', { materialized: list }).claudeMd).toBe('absent')
  })

  it('the real shape from a live attempt: root file absent, rules directory copied', () => {
    const list = [
      { path: '.claude/', mode: 'copy', files: 28, bytes: 43773 },
      { path: 'CLAUDE.md', mode: 'absent', files: 0 },
      { path: '.claude/settings.local.json', mode: 'absent', files: 0 },
      { path: 'node_modules', mode: 'link', target: '/elsewhere' },
    ]
    // materialized — but because the directory was copied, not because an 'absent' line matched.
    expect(rulesInCopy(io(true), '/copy', { materialized: list }).claudeMd).toBe('materialized')
  })
})

/**
 * ═══ ШЕСТОЙ ФАЙЛ КАТАЛОГА ПРОГОНА — СВИДЕТЕЛЬ СНИМКА КОНТЕКСТА ══════════════════
 *
 * ЗАЧЕМ ВТОРОЙ ЭКЗЕМПЛЯР ОДНОГО ДОКУМЕНТА. Снимок уже лежит в рабочей копии — там его
 * читает работник. Но копию убирают, а строку очереди человек правит: через месяц ни одна
 * из них не ответит на вопрос «а что этой попытке вообще дали». Отвечает на него каталог
 * прогона, и отвечает по каждой попытке отдельно — у второй попытки своя правда о том, с
 * каким снимком её запускали, и правда эта не обязана совпадать с сегодняшней строкой.
 *
 * ИМЯ ОДНО НА ОБА МЕСТА — НАМЕРЕННО. Это ОДИН документ в двух экземплярах для двух
 * читателей: работник открывает копию, человек и дверь карточки открывают каталог попытки.
 * Разные имена разорвали бы очевидность тождества.
 *
 * ВТОРОГО ПОТОЛКА ЗДЕСЬ НЕТ. Потолок применён у единственного входа — двери постановки, — и
 * там он ОТКАЗЫВАЕТ, а не режет. Вторая правда о длине разъехалась бы с первой молча.
 */
describe('шестой файл каталога прогона — свидетель снимка контекста', () => {
  it('замороженный список имён стал ШЕСТЫМ по счёту, и новое имя названо в нём ровно один раз', () => {
    expect(RUN_FILES).toHaveLength(6)
    expect(RUN_FILES.filter((n: string) => n === 'task_context.md')).toHaveLength(1)
    expect([...RUN_FILES]).toEqual([
      'run.json',
      'guards.jsonl',
      'transcript.jsonl',
      'receipt.json',
      'continuation.md',
      'task_context.md',
    ])
  })

  it('свидетель лежит в каталоге ЭТОЙ попытки и несёт снимок со строки — с вырезанными секретами', async () => {
    const { runDir } = await runTick()
    const text = readFileSync(join(runDir, 'task_context.md'), 'utf8')

    expect(text).toContain('хвост снимка')
    expect(text, 'секрет уехал в файл, который человек откроет через месяц').not.toContain(TOKEN_VALUE)
  })

  it('задача БЕЗ снимка — файла-свидетеля нет вовсе (отсутствие = отсутствие)', async () => {
    const { runDir } = await runTick({ task: backlogTask({ taskContext: undefined }) })

    expect(existsSync(join(runDir, 'run.json')), 'каталог попытки не написан — дело ничего не значит').toBe(true)
    expect(existsSync(join(runDir, 'task_context.md')), 'пустой файл соврал бы, что человеку было что сказать').toBe(false)
  })

  it('у КАЖДОЙ попытки свой свидетель: вторая несёт снимок, каким он был К НЕЙ', async () => {
    const projectDir = mkDir('sma-run-two-')
    await runTick({ projectDir, task: backlogTask({ attempt: 1, taskContext: 'снимок первой попытки' }) })
    await runTick({ projectDir, task: backlogTask({ attempt: 2, taskContext: 'снимок ВТОРОЙ попытки' }) })

    const first = readFileSync(join(projectDir, '.sma', 'runs', 'BL-1_1', 'task_context.md'), 'utf8')
    const second = readFileSync(join(projectDir, '.sma', 'runs', 'BL-1_2', 'task_context.md'), 'utf8')

    expect(first).toContain('снимок первой попытки')
    expect(second).toContain('снимок ВТОРОЙ попытки')
    expect(second, 'вторая попытка судится по снимку, которого ей не давали').not.toContain('первой попытки')
  })
})

/**
 * ═══ ОДИН КАТАЛОГ — ОДНА ПОПЫТКА: ВТОРОЙ ПИСАТЕЛЬ ПОЛУЧАЕТ ОТКАЗ ════════════════
 *
 * ЭТО ДЕЛО НАПИСАНО ПО ОТПЕЧАТКАМ, А НЕ ПО РАССУЖДЕНИЮ. У живой задачи в каталоге «попытка 2»
 * лежал промпт, побайтно равный промпту попытки 1, тогда как промпт второй попытки наблюдали
 * живьём и он был другим. Значит в каталог попытки 2 писала ТРЕТЬЯ попытка, стартовавшая через
 * четыре секунды после второй: номер подхода повторился, каталог назван номером — и запись
 * первого писателя молча ушла под запись второго.
 *
 * ЧЕМ ЭТО ПЛОХО, ОДНОЙ ФРАЗОЙ: разбор «что работник видел в ЭТОЙ попытке» после такой
 * перезаписи врёт — отпечаток промпта, снимок контекста и квитанция принадлежат чужому
 * подходу, а закон о журнале попытки как точке возврата держится ровно на том, что они
 * принадлежат своему.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ — ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ. Гоняются два НАСТОЯЩИХ тика над одним и
 * тем же проектом под одним и тем же номером подхода, и после второго открываются файлы
 * первого. Дело, звавшее писателя напрямую, прошло бы и с перерезанным проводом.
 *
 * И ОТКАЗ ОБЯЗАН БЫТЬ НАЗВАН ВСЛУХ. Молчаливый отказ — такая же потеря следа, как молчаливая
 * перезапись: человек, у которого каталога нет, должен уметь узнать, что каталога нет ПОТОМУ
 * ЧТО номер повторился, а не потому что попытка ничего не оставила.
 */
describe('каталог прогона принадлежит ОДНОЙ попытке', () => {
  const promptOf = (text: string) => ({
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-', '--allowedTools', 'Read,Bash'], env: { ...SPAWN_ENV }, prompt: text }),
  })

  it('второй писатель в каталог того же номера получает отказ — правда первой попытки цела', async () => {
    const projectDir = mkDir('sma-run-taken-')
    const first = await runTick({
      projectDir,
      task: backlogTask({ attempt: 1, taskContext: 'снимок ПЕРВОЙ попытки' }),
      deps: promptOf('промпт первой попытки'),
    })
    const before = readJson(join(first.runDir, 'run.json'))

    // ТРЕТЬЯ попытка, пришедшая под номером второй: другой промпт, другой снимок, тот же номер.
    const second = await runTick({
      projectDir,
      task: backlogTask({ attempt: 1, taskContext: 'снимок, которого первой попытке не давали' }),
      deps: promptOf('промпт попытки, пришедшей под чужим номером'),
    })

    const after = readJson(join(first.runDir, 'run.json'))
    expect(after.prompt.sha256, 'запись первой попытки переписана чужим подходом').toEqual(before.prompt.sha256)
    expect(after.startedAt).toBe(before.startedAt)
    const witness = readFileSync(join(first.runDir, 'task_context.md'), 'utf8')
    expect(witness).toContain('снимок ПЕРВОЙ попытки')
    expect(witness).not.toContain('которого первой попытке не давали')

    const said = second.logged.filter((e: any) => e.type === 'run_dir.taken')
    expect(said, 'отказ, о котором никто не сказал, неотличим от потерянной записи').toHaveLength(1)
    expect(said[0].attemptId).toBe('BL-1#1')
    expect(said[0].reason).toBe(RUN_DIR_TAKEN)
  })

  it('попытка, которой каталог не дали, не несёт чужой путь на строке реестра', async () => {
    const projectDir = mkDir('sma-run-taken-row-')
    await runTick({ projectDir, task: backlogTask({ attempt: 1 }), deps: promptOf('первая') })
    const second = await runTick({ projectDir, task: backlogTask({ attempt: 1 }), deps: promptOf('вторая') })

    // Строка попытки — это то, из чего строится карточка. Путь чужого каталога на ней означал бы,
    // что человек откроет запись СОСЕДНЕЙ попытки, считая её своей.
    const rows = readAttempts(second.ledgerDir, 'BL-1')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.runDir ?? null).toBe(null)
  })
})
