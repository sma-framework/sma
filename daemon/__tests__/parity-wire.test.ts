/**
 * THE WIRE FROM THE STREAM TO THE TOOL — and back to the row a person reads.
 *
 * WHAT THIS FILE PROVES, AND WHY IT IS NOT THE SAME AS THE FILES BESIDE IT. One suite already
 * proves the daemon WRITES a run directory, and another proves the command READS one. Both
 * were green while the two halves had never met: the daemon wrote `parity: null` into every
 * receipt, the command was only ever pointed at a directory assembled by hand, and the row
 * the card renders carried nothing at all. Computed is not connected — so this suite drives a
 * REAL tick over a REAL temporary project, and then hands the directory that tick left to the
 * REAL entry point of the checking command. Nothing here is rehearsed: no writer is called
 * directly, no verdict is stubbed, and the command is invoked through `runCheck` — the same
 * function the CLI line at the bottom of the tool calls.
 *
 * THE THREE CLAIMS, EACH ASSERTED AS A WIRE RATHER THAN AS A CALCULATION:
 *
 *   (1) the tool reads what the daemon wrote — five receipts over a live attempt, with the
 *       rights receipt at its honest best (`warn`) and the skills receipt at its honest `n/a`;
 *   (2) the daemon's OWN verdict, computed before the row was written so a card can show it
 *       without running anything, is the SAME verdict the tool reaches — not «similar»,
 *       not «also five»: the same statuses and the same summary, compared object to object.
 *       A second implementation of «did the hooks fire» would agree on the day it was written
 *       and drift every day after, and this comparison is what makes that drift a red suite;
 *   (3) the verdict arrives in the ATTEMPT ROW — the durable record the card is built from.
 *       This is the assertion that would have caught the whole class: the parity could be
 *       computed perfectly, written into the receipt perfectly, and still never reach a
 *       person, because nothing put it on the row.
 *
 * A RED FIXTURE IS PART OF THE PROOF. A checker that cannot go red is not a checker: the same
 * tick is driven with the stream of a session whose read of the memory index FAILED, and the
 * suite demands a failed memory receipt, a four-out-of-five, an exit code of 1 — and the same
 * agreement between the daemon's own verdict and the tool's.
 *
 * THE STREAM IS NOT INVENTED. Both fixtures are frames lifted off real runs of this daemon;
 * only paths, session ids and note names were replaced.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { summarize, PARITY_RECEIPTS } from '../../scripts/sma/lib/parity-receipts.mjs'
import { runCheck } from '../../tools/terminal-parity-check.mjs'

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
const PROMPT = 'сделай дело и оставь квитанцию'

const SPAWN_ENV = {
  CLAUDE_CONFIG_DIR: 'C:\\work\\.sma-accounts\\local-1',
  ANTHROPIC_API_KEY: 'sk-ant-api03-THIS-IS-THE-API-KEY-VALUE-9876543210',
  PATH: '/usr/bin',
}

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

/**
 * One full tick over a real temporary project, a real ledger and a real copy on disk.
 *
 * THE COPY IS FURNISHED ON PURPOSE. `CLAUDE.md` is written into the working copy and the
 * provisioning verb reports it as materialized, because that is the state a real attempt runs
 * in and the state the rules receipt exists to observe. The copy is given NO `.claude`
 * directory, which is the other half of the point: a project that has no skills earns the
 * honest `n/a` rather than a pass, and a suite that never produced one would never notice if
 * `n/a` quietly turned into `ok`.
 *
 * THE COMMAND LINE IS BUILT THE WAY THE PRODUCT BUILDS IT — one `--allowedTools` argument
 * whose value is the envelope's tool names joined by spaces. The rights receipt compares the
 * envelope against the arguments, so an invented shape here would be a test agreeing with
 * itself instead of with the runner.
 */
async function runTick(over: any = {}) {
  const projectDir = over.projectDir ?? mkDir('sma-wire-proj-')
  const ledgerDir = mkDir('sma-wire-ledger-')
  const workDir = over.workDir ?? mkDir('sma-wire-copy-')
  // The project's rules, in the copy — put there by the provisioning verb, as the manifest says.
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const lines: string[] = over.lines ?? [...framesOf('claude-stream-parity-green.ndjson', workDir), NOTE, LESSON]
  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const logged: any[] = []

  const workers = [{ id: WORKER_ID, lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }]
  // The config as a FILE, so the checking command can be pointed at the same worker list the
  // daemon routed with: both sides then name the worker in the rights receipt, and the two
  // verdicts can be compared string for string rather than only status for status.
  const configPath = join(mkDir('sma-wire-config-'), 'sma.json')
  writeFileSync(configPath, JSON.stringify({ workers }, null, 2), 'utf8')

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: {
      workers,
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: projectDir,
      pipeline: { enabled: true },
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: (_task: any, _route: any, opts: any = {}) => ({
      bin: 'claude',
      args: [
        '--print',
        '-',
        ...(Array.isArray(opts.allowedTools) && opts.allowedTools.length > 0
          ? ['--allowedTools', opts.allowedTools.map((t: any) => String(t)).join(' ')]
          : []),
      ],
      env: { ...SPAWN_ENV },
      prompt: PROMPT,
    }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: workDir,
          branch: 'wt/BL-1',
          // THE SHAPE THE PROVISIONING VERB REALLY REPORTS — `{path, mode, files, …}`, the mode
          // out of its own vocabulary (absent | copy | tracked | link | skipped). This fixture
          // used to invent `{item, how}`, a shape nothing in this product produces, and it passed
          // only because the reader stringified the whole entry and matched a filename anywhere
          // inside it. A fixture the library could not have produced proves nothing about it.
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
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => logged.push(e),
    execGit: gateGit,
    ...over.deps,
  }

  const res = await tick(deps)
  return { res, projectDir, ledgerDir, workDir, configPath, logged, runDir: join(projectDir, '.sma', 'runs', 'BL-1_1') }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

/** The real entry point of the command, over a real directory. Nothing is stubbed but the sinks. */
function check(argv: string[]) {
  const out: string[] = []
  const errs: string[] = []
  const code = runCheck(argv, { log: (l: any) => out.push(String(l)), err: (l: any) => errs.push(String(l)) })
  return { code, out, errs }
}

/** The same command in `--json` mode — the machine-readable half of the same run. */
function checkJson(argv: string[]) {
  const { code, out, errs } = check([...argv, '--json'])
  return { code, errs, body: JSON.parse(out[0]), tail: out[out.length - 1] }
}

// ═══════════ THE WIRE: A LIVE TICK, THEN THE REAL COMMAND OVER WHAT IT LEFT ═════════════════

describe('поток → каталог прогона → настоящая команда: пять квитанций живой попытки', () => {
  it('зелёная фикстура: 5/5 — хуки, память, правила, навыки n/a, права warn — и код 0', async () => {
    const { res, projectDir, configPath } = await runTick()
    expect(res.completed).toBe('BL-1')

    const { code, out } = check(['--project', projectDir, '--config', configPath])

    expect(out).toHaveLength(6) // пять квитанций и число последней строкой
    expect(out[0]).toMatch(/^OK — хуки/)
    expect(out[1]).toMatch(/^OK — память/)
    expect(out[2]).toMatch(/^OK — правила/)
    // «в проекте нет навыков» — честное n/a, а не пропуск и не зелёное
    expect(out[3]).toMatch(/^n\/a — навыки/)
    // права не бывают зелёными: до процесса доезжает только половина конверта
    expect(out[4]).toMatch(/^WARN — права/)
    expect(out[4]).toContain('humanOnlyActions')
    expect(out[5]).toBe('5')
    expect(code).toBe(0)
  })

  it('правила прочитаны как materialized — копию обставил верб провизии, и это видно', async () => {
    const { projectDir, configPath } = await runTick()
    const { out } = check(['--project', projectDir, '--config', configPath])
    expect(out[2]).toContain('materialized')
  })
})

// ═══════════ ПРЕДРАСЧЁТ ДЕМОНА == ВЕРДИКТ ИНСТРУМЕНТА ══════════════════════════════════════

describe('демон считает ту же пятёрку тем же модулем — карточке не нужно запускать команду', () => {
  it('receipt.json.parity равен вердикту инструмента: статусы, детали и сводка', async () => {
    const { projectDir, runDir, configPath } = await runTick()

    const { body, code } = checkJson(['--project', projectDir, '--config', configPath])
    const receipt = readJson(join(runDir, 'receipt.json'))

    // Предрасчёт есть и он не заглушка
    expect(receipt.parity).not.toBe(null)
    expect(receipt.parity.results.map((r: any) => r.id)).toEqual(PARITY_RECEIPTS.map((r) => r.id))

    // Побайтовое равенство пяти квитанций — не «тоже пять», а ТЕ ЖЕ
    expect(receipt.parity.results).toEqual(body.receipts)
    // И сводка равна сводке инструмента, посчитанной из его же вывода
    expect(receipt.parity.summary).toEqual(summarize(body.receipts))
    expect(receipt.parity.summary).toEqual({ fulfilled: 5, total: 5, warn: 1, ok: 3, failed: [] })
    expect(code).toBe(0)
  })

  it('строка попытки в леджере несёт сводку и путь каталога — карточке есть что показать', async () => {
    const { projectDir, ledgerDir, runDir, configPath } = await runTick()

    const rows = readAttempts(ledgerDir, 'BL-1')
    const row = rows[rows.length - 1]
    const { body } = checkJson(['--project', projectDir, '--config', configPath])

    expect(row.runDir).toBe(runDir)
    expect(row.parity).toEqual(summarize(body.receipts))
    expect(row.parity.fulfilled).toBe(5)
    expect(row.parity.failed).toEqual([])
  })
})

// ═══════════ КРАСНАЯ ФИКСТУРА: ПРОВЕРКА, КОТОРАЯ УМЕЕТ КРАСНЕТЬ ════════════════════════════

describe('красная фикстура: чтение индекса памяти провалилось — и это видно с обеих сторон', () => {
  it('память FAIL, 4/5, код 1 — и предрасчёт демона говорит ровно то же', async () => {
    const workDir = mkDir('sma-wire-copy-red-')
    const { projectDir, runDir, ledgerDir, configPath } = await runTick({
      workDir,
      lines: [...framesOf('claude-stream-parity-red-memory.ndjson', workDir), NOTE, LESSON],
    })

    const { code, out } = check(['--project', projectDir, '--config', configPath])
    expect(out[1]).toMatch(/^FAIL — память/)
    expect(out[5]).toBe('4')
    expect(code).toBe(1)

    const receipt = readJson(join(runDir, 'receipt.json'))
    expect(receipt.parity.summary.failed).toEqual(['memory'])
    expect(receipt.parity.summary.fulfilled).toBe(4)

    const { body } = checkJson(['--project', projectDir, '--config', configPath])
    expect(receipt.parity.results).toEqual(body.receipts)
    expect(body.exitCode).toBe(1)

    // и красный вердикт тоже доезжает до строки попытки — а не только до файла
    const rows = readAttempts(ledgerDir, 'BL-1')
    expect(rows[rows.length - 1].parity.failed).toEqual(['memory'])
  })
})
