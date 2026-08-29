/**
 * КОНЧИВШИЙСЯ КОНТЕКСТ — ПРОВОД ОТ КАДРА ПОТОКА ДО ЖУРНАЛА И КАРТОЧКИ ЗАДАЧИ.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Попытка тратит три вещи: деньги, ходы и МЕСТО. Первые две демон читал с
 * потока и называл своими словами; третьей он не видел вовсе. Когда окно контекста переполнялось,
 * CLI сжимал его в пересказ, сессия доигрывала на пересказе пересказа и заканчивалась без
 * квитанции и без записки — то есть приходила на выходной гейт в точности как плохая работа. На
 * карточке стояло «ошибка работника» или «нет квитанции», и человека посылали чинить код, автору
 * которого просто не хватило места. Починка у этой причины одна и другая: не потолок поднять, а
 * задачу разрезать, — и предложить её нельзя, пока причина не названа.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ И ЧЕГО НЕ ДОКАЗЫВАЕТ. Он не проверяет разбор кадра
 * (`contextExhaustedOf` и `classifyFailure` разобраны в `loop.test.ts`). Он проверяет ПРОВОД:
 * настоящий тик над настоящей очередью, кадр `compact_boundary` в потоке — и после него
 * (1) причина названа в журнале оператора, (2) она же стоит на строке задачи, которую читает
 * карточка, (3) человеку сказано его же словами, что делать. Рядом — контрольный прогон БЕЗ
 * кадра сжатия: он обязан читаться по-старому, иначе провод доказывал бы не то.
 *
 * И ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: возобновления сессий. Оно и есть источник раздувания контекста —
 * причина, ради которой этот провод понадобился, а не лекарство от неё.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue, FAIL_REASONS, REASON_LABELS, failureAwaitsAPerson } from '../src/queue/adapter.mjs'
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

// ── кадры потока ───────────────────────────────────────────────────────────────────────────

/** Окно наполнилось САМО — кадр, которым CLI объявляет автоматическое сжатие. */
const COMPACT_AUTO = JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
  compact_metadata: { trigger: 'auto', pre_tokens: 152_000 },
})

/** Работник прибрался у себя сам — его собственное решение, а не конец места. */
const COMPACT_MANUAL = JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual', pre_tokens: 60_000 },
})

/** Автоматическое сжатие у ДЕЛЕГИРОВАННОЙ сессии: чужое окно, не окно этой попытки. */
const COMPACT_SUBAGENT = JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  parent_tool_use_id: 'toolu_01delegated',
  compact_metadata: { trigger: 'auto', pre_tokens: 140_000 },
})

/** Обычный финальный кадр: сессия закончилась сама, ничего не сказав про исход. */
const RESULT_PLAIN = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 40,
  total_cost_usd: 1.4,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
})

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

/**
 * ПЕРЕПРОВЕРКА, КОТОРАЯ НИЧЕГО НЕ ЗАВЕРИЛА. Ровно тот случай, ради которого причина заводилась:
 * попытка не оставила квитанции — ни зелёной, ни красной, — то есть судить не о чем, и всё, что
 * можно честно сказать про такой конец, говорит поток.
 */
const NO_RECEIPT_REVERIFY = { code: 0, stdout: '{}' }
const RED_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'red', receiptRef: 'reverify:red', diffStat: '+1 -1' }) }

/** Какую дверь очереди позвал цикл — возвращаемую или терминальную. */
function recordDoors(adapter: any, doors: string[]) {
  return {
    ...adapter,
    async fail(taskId: string, reason: string, opts: any) {
      doors.push(`fail:${reason}`)
      return adapter.fail(taskId, reason, opts)
    },
    async parkForPerson(taskId: string, reason: string, opts: any) {
      doors.push(`park:${reason}`)
      return adapter.parkForPerson(taskId, reason, opts)
    },
  }
}

/** Один настоящий тик над временным проектом и настоящей очередью-образцом. */
async function runTick(over: any = {}) {
  const projectDir = mkDir('sma-ctx-proj-')
  const ledgerDir = mkDir('sma-ctx-ledger-')
  const workDir = mkDir('sma-ctx-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const lines: string[] = over.lines ?? [COMPACT_AUTO, RESULT_PLAIN]
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await queue.enqueue(backlogTask())
  const doors: string[] = []
  const entries: any[] = []
  const adapter = recordDoors(queue, doors)

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
    buildArgs: () => ({ bin: 'claude', args: buildClaudeArgs({ maxTurns: 80 }), env: { ...SPAWN_ENV }, prompt: PROMPT }),
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
      reverify: over.reverify ?? NO_RECEIPT_REVERIFY,
    }),
    spawnWorker: (spec: any) => {
      for (const l of lines) spec.onLine?.(l)
      spec.onExit?.({ code: over.exitCode ?? 1, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: () => {},
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => entries.push(e),
    execGit: gateGit,
  }

  const res = await tick(deps)
  return { res, queue, doors, entries, ledgerDir }
}

// ═══════════ ОКНО ПЕРЕПОЛНИЛОСЬ: ПРИЧИНА НАЗВАНА СВОИМ ИМЕНЕМ ══════════════════════════════

describe('попытка, у которой кончился контекст, называется этим, а не плохой работой', () => {
  it('причина доезжает до строки задачи — карточка читает её, а не «ошибку работника»', async () => {
    const { res, queue } = await runTick()

    expect(res.failed?.reason).toBe('context_exhausted')

    const row = (await queue.list({})).find((r: any) => r.id === 'BL-1')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('context_exhausted')
    expect(row.failure_reason).not.toBe('agent_error')
    expect(row.failure_reason).not.toBe('no_receipt')
  })

  it('причина названа в ЖУРНАЛЕ оператора, вместе с тем, сколько раз окно сжимали', async () => {
    const { entries } = await runTick({ lines: [COMPACT_AUTO, COMPACT_AUTO, RESULT_PLAIN] })

    const said = entries.find((e) => e.type === 'task.context_exhausted')
    expect(said).toBeTruthy()
    expect(said.taskId).toBe('BL-1')
    expect(said.reason).toBe('context_exhausted')
    expect(said.detail).toContain('сжатий=2')
    // Самое большое окно, а не последнее: человек выбирает размер задачи по верхней отметке.
    expect(said.detail).toContain('152000')
  })

  it('человеку сказана ЕГО починка — разрезать задачу, а не поднять потолок', () => {
    const label = REASON_LABELS.context_exhausted
    expect(FAIL_REASONS).toContain('context_exhausted')
    expect(label).toContain('контекст')
    expect(label).toContain('разбить задачу')
    // Потолок ходов здесь ни при чём: его подъём этой попытке места не добавит.
    expect(label).not.toContain('потолок')
  })

  /**
   * ПОВТОР У НЕЁ ОСТАЁТСЯ. Список ждущих человека — решение про чужую подписку, и эта правка
   * его не трогает: попытка уходит в ВОЗВРАЩАЕМУЮ дверь, как и была. Названо здесь вслух, чтобы
   * смена этого поведения стоила правки теста, а не просочилась соседним файлом.
   */
  it('уходит в возвращаемую дверь очереди — политика повторов не задета', async () => {
    const { doors } = await runTick()
    expect(doors).toEqual(['fail:context_exhausted'])
    expect(failureAwaitsAPerson('context_exhausted')).toBe(false)
  })
})

// ═══════════ КОНТРОЛЬ: БЕЗ КАДРА СЖАТИЯ ВСЁ ЧИТАЕТСЯ ПО-СТАРОМУ ════════════════════════════

describe('признак берётся из кадра — и только из него', () => {
  it('тот же самый прогон без кадра сжатия остаётся «ошибкой работника»', async () => {
    const { res } = await runTick({ lines: [RESULT_PLAIN] })
    expect(res.failed?.reason).toBe('agent_error')
  })

  it('РУЧНОЕ сжатие причиной не считается: это уборка работника, а не конец места', async () => {
    const { res, entries } = await runTick({ lines: [COMPACT_MANUAL, RESULT_PLAIN] })
    expect(res.failed?.reason).toBe('agent_error')
    expect(entries.some((e) => e.type === 'task.context_exhausted')).toBe(false)
  })

  it('сжатие у ДЕЛЕГИРОВАННОЙ сессии — чужое окно: попытке оно не приписывается', async () => {
    const { res } = await runTick({ lines: [COMPACT_SUBAGENT, RESULT_PLAIN] })
    expect(res.failed?.reason).toBe('agent_error')
  })

  /**
   * И НИЧЕГО НЕ ОСЛАБЛЕНО. Красная перепроверка — измеренный факт о ветке, а переполнившееся
   * окно — обстоятельство прогона; когда есть что судить, судят по сделанному.
   */
  it('красная квитанция сильнее переполненного окна — судить есть о чём', async () => {
    const { res } = await runTick({ reverify: RED_REVERIFY, exitCode: 0 })
    expect(res.failed?.reason).toBe('tests_red')
  })
})
