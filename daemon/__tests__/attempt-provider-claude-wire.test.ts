/**
 * ИМЯ ПОЛОСЫ — ПРОВОД ОТ МАРШРУТА ДО СТРОКИ ПОПЫТКИ НА ДИСКЕ.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ. Строка попытки в реестре несёт поле `provider` — им карточка
 * отвечает на вопрос «чем это шло», и по нему же считается, какой полосе сколько не удалось.
 * Здесь утверждается ровно одно: в поле стоит имя ТОЙ полосы, которой попытка правда шла, —
 * то самое, которое назвал маршрут и с которым был запущен работник, — а не значение по
 * умолчанию, случайно совпадающее с правдой на самой ходовой полосе.
 *
 * ПОЧЕМУ ОДНОЙ ПОЛОСЫ НЕ ХВАТИЛО БЫ. Провод, который всегда пишет «claude», зелёный на
 * claude-полосе и молча врёт на всех остальных: работа codex попадает в реестр под чужим
 * именем, и никакой поломки при этом не видно — поле заполнено, слово знакомое. Поэтому одна
 * и та же задача гоняется на ДВУХ полосах, и вторая строка обязана назвать вторую полосу.
 * Соседний сьют полос сторожит книгу трат — там читатель кадра; здесь предмет другой:
 * СТРОКА ПОПЫТКИ, которую человек откроет через месяц.
 *
 * ПРОВАЛ ТОЖЕ НАЗЫВАЕТ ПОЛОСУ, и это не симметрия ради симметрии: путь провала пишет строку
 * своим кодом, отдельным от пути успеха, и именно провалы читают, когда спрашивают «какая
 * полоса не тянет». Безымянный (или одинаково названный) провал делает этот ответ
 * структурно невозможным.
 *
 * ОБСТАНОВКА. Тик настоящий, маршрут настоящий, реестр — настоящий файл на диске, и читается
 * он настоящим `readAttempts` ПОСЛЕ тика, а не тем, что тик держал в руках. Подделаны только
 * процесс работника и стоки (книга трат, журнал, отчёт).
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'
import { laneAdapter } from '../src/runner/provider-adapter.mjs'

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

// ── кадры и ответы соседей ─────────────────────────────────────────────────────────────────

const TASK_ID = 'LANE-1'
const NOTE = 'APPROACH_NOTE: прямой путь'
const LESSON = 'LESSON_NONE: задача была чистым чтением'
const SESSION_ID = '3f2b1a0c-0000-4000-8000-abcdefabcdef'

const CLAUDE_INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID })
const CLAUDE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.42,
  session_id: SESSION_ID,
  modelUsage: { 'claude-opus-5': { inputTokens: 1234, outputTokens: 567, cacheReadInputTokens: 89, cacheCreationInputTokens: 12 } },
})
const CODEX_FINAL = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 4321, output_tokens: 765, cached_input_tokens: 98 },
})

/** Что говорит поток на каждой полосе — одна и та же работа, разные диалекты. */
const LINES: Record<Lane, string[]> = {
  claude: [CLAUDE_INIT, CLAUDE_RESULT, NOTE, LESSON],
  codex: [CODEX_FINAL, NOTE, LESSON],
}

/** Работник полосы: маршрут выбирает его сам, а сьют потом сверяет с ним строку на диске. */
const WORKER_OF: Record<Lane, string> = { claude: 'max-1', codex: 'pro-1' }

type Lane = 'claude' | 'codex'

const makeVerbRunner = (responses: Record<string, unknown>) => async (_bin: string, argsArray: string[]) => {
  const verb = argsArray[1]
  const r = responses[verb] ?? { code: 0, stdout: '{}' }
  return typeof r === 'function' ? (r as () => unknown)() : r
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

// ── один настоящий тик на названной полосе ─────────────────────────────────────────────────

/**
 * Полоса задаётся ПОЛЕМ ЗАДАЧИ, поэтому работника выбирает настоящее правило маршрутизации, а
 * не подставленный ответ: провод проверяется от того же места, откуда он начинается у человека.
 * Каждый прогон получает свои временные каталоги — два работника в этом сьюте пишут два разных
 * реестра и не спорят за один файл.
 */
async function runTick(opts: { lane: Lane; reverify?: unknown }) {
  const projectDir = mkDir('sma-lane-attempt-proj-')
  const ledgerDir = mkDir('sma-lane-attempt-ledger-')
  const workDir = mkDir('sma-lane-attempt-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue({
    id: TASK_ID,
    source: 'backlog',
    title: 'одна и та же работа на обеих полосах',
    lane: 'prod',
    priority: 0,
    storyPoints: 3,
    provider: opts.lane,
    acceptance: 'зелёные узкие тесты и квитанция',
  })

  const workers = [
    { id: WORKER_OF.claude, lane: 'prod', provider: 'claude', account: { name: 'local-1', configDir: '/x' }, enabled: true },
    { id: WORKER_OF.codex, lane: 'prod', provider: 'codex', account: { name: 'codex-1', configDir: '/y' }, enabled: true },
  ]

  /**
   * Чем работника ПРАВДА запустили. До процесса доезжает не имя полосы, а двоичный файл — по
   * нему сьют и опознаёт полосу, которой попытка шла: имя со строки на диске обязано вести
   * обратно ровно к этому файлу.
   */
  const spawned: { bin?: string }[] = []

  const deps: Record<string, unknown> = {
    adapter,
    ledger: {
      recordAttempt: (row: unknown) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: { attemptId: string }) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: { workers, agingHours: 24, backlogScanMinutes: 60, repoDir: projectDir, pipeline: { enabled: true } },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    // Платформа названа явно, чтобы песочница codex не делала ход разным на разных машинах:
    // её сторожит свой сьют, здесь предмет — имя полосы в строке попытки.
    platform: 'linux',
    buildArgs: () => ({
      bin: laneAdapter(opts.lane).bin,
      args: buildClaudeArgs({}),
      env: { PATH: '/usr/bin' },
      prompt: 'сделай дело и оставь квитанцию',
      provider: opts.lane,
      workerId: WORKER_OF[opts.lane],
    }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: workDir,
          branch: `wt/${TASK_ID}`,
          materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 812 }],
        }),
      },
      reverify: opts.reverify ?? GREEN_REVERIFY,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnWorker: (spec: any) => {
      spawned.push({ bin: spec.bin })
      for (const l of LINES[opts.lane]) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: () => {},
    report: async () => {},
    clock: c.clock,
    journal: () => {},
    execGit: gateGit,
  }

  const res = await tick(deps)
  // Реестр перечитывается С ДИСКА настоящим читателем: предмет — файл, который переживёт тик.
  return { res, spawned, rows: readAttempts(ledgerDir, TASK_ID) }
}

// ═══════════ ЗАВЕРШЁННАЯ ПОПЫТКА НАЗЫВАЕТ СВОЮ ПОЛОСУ ══════════════════════════════════════

describe('строка попытки на диске несёт имя полосы, которой попытка шла', () => {
  it('полоса Claude: в строке стоит её имя, её работник и её двоичный файл', async () => {
    const { res, spawned, rows } = await runTick({ lane: 'claude' })
    expect(res.completed).toBe(TASK_ID)

    expect(spawned).toHaveLength(1)
    expect(spawned[0].bin).toBe(laneAdapter('claude').bin)

    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('completed')
    expect(rows[0].provider).toBe('claude')
    // Имя со строки ведёт обратно к тому файлу, которым работника правда запустили, — это и
    // значит «полоса, которой попытка шла», а не «слово, совпавшее с правдой».
    expect(laneAdapter(rows[0].provider).bin).toBe(spawned[0].bin)
  })

  it('полоса codex: та же задача, и строка называет ВТОРУЮ полосу, а не значение по умолчанию', async () => {
    const { res, spawned, rows } = await runTick({ lane: 'codex' })
    expect(res.completed).toBe(TASK_ID)

    expect(spawned[0].bin).toBe(laneAdapter('codex').bin)
    expect(spawned[0].bin).not.toBe(laneAdapter('claude').bin)

    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('completed')
    // Ровно эта строка ловит провод, прибитый к одной полосе: он был бы зелёным выше и врал бы здесь.
    expect(rows[0].provider).toBe('codex')
    expect(laneAdapter(rows[0].provider).bin).toBe(spawned[0].bin)
  })
})

// ═══════════ ПРОВАЛ НАЗЫВАЕТ ПОЛОСУ ТОЧНО ТАК ЖЕ ═══════════════════════════════════════════

describe('провалившаяся попытка называет полосу так же — по провалам и судят о полосе', () => {
  it('красная приёмка на полосе codex: строка провала несёт codex, а не имя соседней полосы', async () => {
    const { res, rows } = await runTick({ lane: 'codex', reverify: RED_REVERIFY })
    expect(res.failed?.taskId).toBe(TASK_ID)

    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].provider).toBe('codex')
    expect(rows[0].workerId).toBe(WORKER_OF.codex)
  })

  it('красная приёмка на полосе Claude: та же строка, своё имя полосы', async () => {
    const { res, rows } = await runTick({ lane: 'claude', reverify: RED_REVERIFY })
    expect(res.failed?.taskId).toBe(TASK_ID)

    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].provider).toBe('claude')
    expect(rows[0].workerId).toBe(WORKER_OF.claude)
  })
})
