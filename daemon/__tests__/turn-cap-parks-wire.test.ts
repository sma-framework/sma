/**
 * ПОТОЛОК ХОДОВ — ПРОВОД ОТ КАДРА ПОТОКА ДО ЗАКРЫТОЙ СТРОКИ, КОТОРАЯ ЖДЁТ ЧЕЛОВЕКА.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Попытка, кончившаяся по потолку ходов, называлась провалом — а провал
 * в этом продукте ВОЗВРАЩАЕМЫЙ: очередь выдавала строку ещё дважды, и обе выдачи несли на
 * командной строке ТОТ ЖЕ потолок. Значит вторая и третья попытки упирались в ту же стену на том
 * же шаге: два оплаченных прогона с исходом, известным до старта. Чинить там нечего — ни работа,
 * ни среда не сломаны, — нужно РЕШЕНИЕ человека: поднять потолок, разбить задачу или отменить.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ И ЧЕГО НЕ ДОКАЗЫВАЕТ. Он не проверяет, как распознаётся потолок
 * (`turnCapHitOf` разобран в `loop.test.ts`) и не проверяет арифметику повторов. Он проверяет
 * ПРОВОД: настоящий тик над настоящей очередью, кадр `error_max_turns` в потоке — и после него
 * (1) новой попытки не создаётся, сколько ни проси, (2) строка закрыта с НАСТОЯЩЕЙ причиной, а
 * не с `manual` и не с пустотой, (3) человеку названы его варианты его же словами. Отдельным
 * делом — что прочие причины провала по-прежнему уходят в ВОЗВРАЩАЕМУЮ дверь: развилка, которая
 * тихо перестала бы повторять срыв провайдера, стоила бы дороже той, которую она чинит.
 *
 * ПОЧЕМУ ДВЕРЬ, А НЕ ФЛАГ. Повтор у долговременной очереди решается ВНУТРИ библиотеки, в самом
 * вызове отказа. Снаружи его не видно ничем, кроме того, какую дверь позвали, — поэтому провод
 * снимается по двери, а очередь-образец рядом утверждает результат: строку больше не выдают.
 * Долговременная половина того же провода — в `pgboss-backend.test.ts`.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import {
  createMemoryQueue,
  AWAITS_A_PERSON,
  failureAwaitsAPerson,
  FAIL_REASONS,
  REASON_LABELS,
} from '../src/queue/adapter.mjs'
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

/** Прогон, который ОСТАНОВИЛИ мы: командная строка сказала потолок, работник в него упёрся. */
const RESULT_MAX_TURNS = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  num_turns: 80,
  total_cost_usd: 0.9,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
})

/** Обычный успешный финальный кадр — для дела про прочие причины. */
const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 12,
  total_cost_usd: 0.1,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
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
 * КАКУЮ ДВЕРЬ ОЧЕРЕДИ ПОЗВАЛ ЦИКЛ. Разница между двумя концами неудавшейся попытки — это и есть
 * выбор двери: одна возвращаемая, вторая терминальная. Обёртка ничего не меняет и ничего не
 * решает, она только записывает, кого позвали, — а результат утверждается по самой очереди.
 */
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
  const projectDir = mkDir('sma-cap-proj-')
  const ledgerDir = mkDir('sma-cap-ledger-')
  const workDir = mkDir('sma-cap-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const lines: string[] = over.lines ?? [RESULT_MAX_TURNS]
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await queue.enqueue(backlogTask())
  const doors: string[] = []
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
      spec.onExit?.({ code: over.exitCode ?? 1, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: () => {},
    report: async () => {},
    clock: c.clock,
    journal: () => {},
    execGit: gateGit,
  }

  const res = await tick(deps)
  return { res, queue, doors, advance: c.advance, ledgerDir }
}

// ═══════════ УПОР В ПОТОЛОК: ЧЕЛОВЕК, А НЕ ДВА ОБРЕЧЁННЫХ ПОВТОРА ══════════════════════════

describe('попытка, кончившаяся по потолку ходов, ждёт человека', () => {
  it('после turns_exhausted новой попытки НЕ создаётся — сколько ни проси и как ни двигай часы', async () => {
    const { res, queue, advance } = await runTick()
    expect(res.failed?.reason).toBe('turns_exhausted')

    // ТРИ ПОПЫТКИ ВЗЯТЬ РАБОТУ, с ходом часов между ними: отложенный повтор — это задержка, а
    // не отмена, и на любой из этих трёх он бы себя показал.
    const handed = []
    for (let i = 0; i < 3; i += 1) {
      handed.push(await queue.claimNext('w2', {}))
      advance(300000)
    }
    expect(handed).toEqual([null, null, null])

    // И счёт попыток стоит: за отказом он растёт, потому что за отказом стоит следующая
    // попытка. За этим концом стоит человек.
    const row = (await queue.list({})).find((r: any) => r.id === 'BL-1')
    expect(row.attempt).toBe(1)
  })

  it('карточка стоит в ожидании человека с названной причиной — не «manual» и не пустота', async () => {
    const { queue } = await runTick()

    const row = (await queue.list({})).find((r: any) => r.id === 'BL-1')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('turns_exhausted')
    expect(row.failure_reason).not.toBe('manual')

    // ПРИЧИНА СВОИМИ СЛОВАМИ, и в ней названы все три выхода: за этой строкой повтора нет,
    // поэтому она обязана назвать человеку его выбор целиком.
    const label = REASON_LABELS[row.failure_reason]
    expect(label).toContain('ждёт человека')
    expect(label).toContain('поднять потолок ходов')
    expect(label).toContain('разбить')
    expect(label).toContain('отменить')
  })

  it('цикл зовёт ТЕРМИНАЛЬНУЮ дверь очереди, а не возвращаемую', async () => {
    const { doors } = await runTick()
    expect(doors).toEqual(['park:turns_exhausted'])
    expect(doors.some((d) => d.startsWith('fail:'))).toBe(false)
  })
})

// ═══════════ ПРОЧИЕ ПРИЧИНЫ — КАК БЫЛО ═════════════════════════════════════════════════════

describe('прочие причины неудачи повторяются как раньше', () => {
  it('красные тесты уходят в ВОЗВРАЩАЕМУЮ дверь — поведение не задето', async () => {
    const { res, doors, queue } = await runTick({ lines: [RESULT_OK, NOTE, LESSON], reverify: RED_REVERIFY, exitCode: 0 })

    expect(res.failed?.reason).toBe('tests_red')
    expect(doors).toEqual(['fail:tests_red'])
    expect(doors.some((d) => d.startsWith('park:'))).toBe(false)

    const row = (await queue.list({})).find((r: any) => r.id === 'BL-1')
    expect(row.failure_reason).toBe('tests_red')
  })

  /**
   * СПИСОК ВЫПИСАН, А НЕ ВЫВЕДЕН, — второй эталон. Расширение списка обязано стоить правки
   * здесь: «эта причина больше не повторяется» — решение про чужую подписку, и оно должно быть
   * принято человеком, а не просочиться правкой соседнего файла.
   */
  it('человека ждёт РОВНО одна причина из всей таксономии — остальные сохраняют свой повтор', () => {
    expect([...AWAITS_A_PERSON]).toEqual(['turns_exhausted'])
    expect(failureAwaitsAPerson('turns_exhausted')).toBe(true)

    const stillRetried = FAIL_REASONS.filter((r: string) => !failureAwaitsAPerson(r))
    expect(stillRetried).toContain('provider_error')
    expect(stillRetried).toContain('liveness_killed')
    expect(stillRetried).toContain('runtime_offline')
    expect(stillRetried).toContain('tests_red')
    expect(stillRetried).toHaveLength(FAIL_REASONS.length - 1)

    // Незнакомое слово повтор НЕ теряет: забыть причину в списке нельзя так, чтобы она молча
    // перестала повторяться.
    expect(failureAwaitsAPerson('a_word_nobody_has_written_yet')).toBe(false)
  })
})
