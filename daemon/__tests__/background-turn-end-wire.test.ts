/**
 * ХОД, ЗАКОНЧЕННЫЙ ПРИ ЖИВОЙ ФОНОВОЙ ЗАДАЧЕ, — ПРОВОД ОТ КАДРА ПОТОКА ДО СЛОВА НА КАРТОЧКЕ.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Работник отправлял полный набор в фон (`Bash run_in_background`), чтобы
 * «не ждать», писал промежуточное слово («Tests are running in the background… Interim status
 * while it finishes») и заканчивал ход. Поток отдавал `result success`, следом шли кадры о
 * фоновых задачах — и на этом всё: блок журнала, который работник собирался написать ПОСЛЕ
 * прогона, не получал своего хода. Попытка закрывалась как «нет записки», то есть обвинением
 * работника, которому нечем было ответить. Замерено в ночь на 03.09.2026: 19 таких попыток,
 * каждая — час-два работы и повтор с нуля, одна из них с одиннадцатью коммитами на ветке.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ. Две вещи, и вторая важнее первой.
 *   (1) ТАКОЙ КОНЕЦ НАЗВАН СВОИМ ИМЕНЕМ: `background_turn_end` вместо `no_journal`, с подсказкой
 *       в тех же словах — передний план и журнал последним действием.
 *   (2) ПЕРВЫЙ `result` НЕ КОНЕЦ СЕССИИ. Попытку закрывает выход дочернего процесса, поэтому
 *       поток `result → background_tasks_changed → task_updated → ВТОРОЙ result` читается как
 *       обычный законченный ход: фоновая задача успела кончиться, и приписывать этой попытке
 *       живой фон было бы ложью. Без этой половины первая половина была бы огульным словом.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: подмена слова НЕ СОЗДАЁТ отказа. Попытка, оставившая записку, с тем
 * же самым живым фоном проходит гейт ровно как проходила, и это проверяется отдельно — иначе
 * распознаватель мог бы однажды начать хоронить работу, которую он должен только называть.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick, backgroundTurnEndOf, backgroundTurnEndDetail, classifyFailure } from '../src/loop.mjs'
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

// ── кадры потока, снятые с живого случая ───────────────────────────────────────────────────

const SESSION = '3f2b1a0c-0000-4000-8000-abcdefabcdef'

/** Промежуточное слово, которым работник заканчивает ход, пока набор ещё идёт. */
const RESULT_INTERIM = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 40,
  total_cost_usd: 0.9,
  session_id: SESSION,
  result: 'Tests are running in the background (full suite). Interim status while it finishes: …',
})

/** Тот же кадр после того, как фон закончился, — конец хода, который ход и правда закончил. */
const RESULT_SECOND = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 42,
  total_cost_usd: 1.1,
  session_id: SESSION,
})

/** Поставщик объявил: одна фоновая задача жива. */
const BG_RUNNING = JSON.stringify({
  type: 'system',
  subtype: 'background_tasks_changed',
  background_tasks: [{ id: 'bash_1', status: 'running', description: 'npm test' }],
})

/** …и он же объявил, что она кончилась — одной строкой, а не снимком. */
const BG_TASK_DONE = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'bash_1', status: 'completed' })

/** Запуск фоном НАШИМИ глазами: вызов оболочки, о конце которого поток не сказал ничего. */
const BG_LAUNCH = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test', run_in_background: true } }],
  },
})

/** Записка о подходе — то, чего у похороненных попыток как раз и не было. */
const APPROACH_SAID = JSON.stringify({
  type: 'assistant',
  message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'APPROACH_NOTE: сделано в лоб\nLESSON_NONE: нечему учить' }] },
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
 * ПЕРЕПРОВЕРКА В ДЕРЕВЕ БЕЗ РЕЦЕПТОВ — та самая, что выдаёт ВЫВЕДЕННУЮ зелёную квитанцию по
 * числу коммитов. Нужна здесь потому, что подмена слова живёт ровно над зелёной квитанцией:
 * попытка сделала работу, и спор идёт только о том, как назвать её незаконченный конец.
 */
const NO_RECIPES_REVERIFY = { code: 0, stdout: JSON.stringify({ records: [], appended: 0 }) }

/** Один настоящий тик над временным проектом и настоящей очередью-образцом. */
async function runTick(over: any = {}) {
  const projectDir = mkDir('sma-bg-proj-')
  const ledgerDir = mkDir('sma-bg-ledger-')
  const workDir = mkDir('sma-bg-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const lines: string[] = over.lines ?? [BG_LAUNCH, BG_RUNNING, RESULT_INTERIM]
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await queue.enqueue(backlogTask())
  const entries: any[] = []

  const workers = [{ id: WORKER_ID, lane: 'prod', provider: 'claude', account: { name: 'local-1', configDir: '/x' }, enabled: true }]

  const deps: any = {
    adapter: queue,
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
      reverify: over.reverify ?? NO_RECIPES_REVERIFY,
    }),
    spawnWorker: (spec: any) => {
      for (const l of lines) spec.onLine?.(l)
      spec.onExit?.({ code: over.exitCode ?? 0, signal: null })
      return { pid: 4242, kill: () => {}, alive: () => false }
    },
    bookUsage: () => {},
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => entries.push(e),
    execGit: gateGit,
  }

  const res = await tick(deps)
  return { res, queue, entries }
}

// ═══════════ РАСПОЗНАВАТЕЛЬ: ЧТО ОСТАЛОСЬ ЖИВЫМ, КОГДА ПОТОК КОНЧИЛСЯ ══════════════════════

describe('backgroundTurnEndOf — читается КОНЕЦ потока, а не первый кадр результата', () => {
  it('фоновая задача жива на конце потока — ход закончен раньше своей работы', () => {
    const bg = backgroundTurnEndOf([BG_LAUNCH, BG_RUNNING, RESULT_INTERIM])
    expect(bg).toBeTruthy()
    expect(bg.live).toBe(1)
    expect(bg.tasks.join(' ')).toContain('npm test')
    expect(bg.source).toBe('frames')
  })

  /**
   * ГЛАВНАЯ ПРОВЕРКА ФАЙЛА. Ровно тот поток, из-за которого правка и делалась, но с ЧЕСТНЫМ
   * концом: фон объявлен, фон закончился, пришёл второй `result`. Первый `result` концом сессии
   * не был, и попытке этот фон не приписывается.
   */
  it('result → фон → фон закончился → ВТОРОЙ result: ход закончен по-настоящему', () => {
    expect(backgroundTurnEndOf([BG_LAUNCH, RESULT_INTERIM, BG_RUNNING, BG_TASK_DONE, RESULT_SECOND])).toBeNull()
  })

  it('снимок «список изменился» ЗАМЕНЯЕТ состояние, а не дописывается к нему', () => {
    const cleared = JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', background_tasks: [] })
    expect(backgroundTurnEndOf([BG_RUNNING, cleared, RESULT_SECOND])).toBeNull()
  })

  it('поставщик о фоне не сказал ничего — читается наш собственный вызов run_in_background', () => {
    const bg = backgroundTurnEndOf([BG_LAUNCH, RESULT_INTERIM])
    expect(bg?.source).toBe('tool_call')
    expect(bg?.commands.join(' ')).toContain('npm test')
  })

  it('прогон, не дошедший до своего конца, принадлежит другим распознавателям — здесь молчание', () => {
    expect(backgroundTurnEndOf([BG_LAUNCH, BG_RUNNING])).toBeNull()
    expect(backgroundTurnEndOf(null as any)).toBeNull()
    expect(backgroundTurnEndOf(['не json вовсе'])).toBeNull()
  })

  it('подсказка названа в тех же словах, которыми чинится: передний план и журнал последним', () => {
    const said = backgroundTurnEndDetail(backgroundTurnEndOf([BG_LAUNCH, BG_RUNNING, RESULT_INTERIM]))
    expect(said).toContain('ПЕРЕДНЕМ плане')
    expect(said).toContain('run_in_background')
    expect(said).toContain('последнее действие хода')
  })
})

// ═══════════ КЛАССИФИКАТОР: СЛОВО ПОДМЕНЯЕТСЯ, ОТКАЗ НЕ СОЗДАЁТСЯ ═════════════════════════

describe('classifyFailure — живая фоновая задача переименовывает пропажу, но не рождает её', () => {
  const bg = { live: 1, tasks: ['npm test'], commands: ['npm test'], source: 'frames' }

  it('зелёная квитанция без записки при живом фоне — «ход закончен», а не «нет записки»', () => {
    expect(classifyFailure({ receipt: { verdict: 'green' }, journalComplete: false, backgroundTurnEnd: bg })).toBe('background_turn_end')
  })

  it('и то же самое для пропавшего урока — причина у обеих пропаж одна', () => {
    expect(classifyFailure({ receipt: { verdict: 'green' }, journalComplete: true, lessonComplete: false, backgroundTurnEnd: bg })).toBe(
      'background_turn_end',
    )
  })

  it('записка и урок на месте — фон ничего не решает: попытка не отказана этим словом', () => {
    expect(classifyFailure({ receipt: { verdict: 'green' }, journalComplete: true, lessonComplete: true, backgroundTurnEnd: bg })).toBe(
      'agent_error',
    )
  })

  it('без фона всё читается по-старому', () => {
    expect(classifyFailure({ receipt: { verdict: 'green' }, journalComplete: false })).toBe('no_journal')
  })

  it('отказ нашего инструмента сильнее: там записку нечем было записать вовсе', () => {
    expect(
      classifyFailure({ receipt: { verdict: 'green' }, journalComplete: false, backgroundTurnEnd: bg, closeToolError: 'журнал упал' }),
    ).toBe('close_tool_broken')
  })

  it('обрыв поставщика и потолок ходов остаются выше — их концы названы раньше', () => {
    expect(classifyFailure({ providerAbort: { reason: 'api_error' }, receipt: { verdict: 'green' }, journalComplete: false, backgroundTurnEnd: bg })).toBe(
      'provider_error',
    )
    expect(classifyFailure({ turnCapHit: { turns: 80 }, receipt: { verdict: 'green' }, journalComplete: false, backgroundTurnEnd: bg })).toBe(
      'turns_exhausted',
    )
  })
})

// ═══════════ ПРОВОД: ТИК, ОЧЕРЕДЬ, ЖУРНАЛ ОПЕРАТОРА, СТРОКА ЗАДАЧИ ════════════════════════

describe('провод: слово доезжает до строки задачи и до журнала оператора', () => {
  it('попытка закрыта словом «ход закончен при живой фоновой задаче», а не «нет записки»', async () => {
    const { res, queue } = await runTick()

    expect(res.failed?.reason).toBe('background_turn_end')
    const row = (await queue.list({})).find((r: any) => r.id === 'BL-1')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('background_turn_end')
    expect(row.failure_reason).not.toBe('no_journal')
  })

  it('на карточку едет ПОДСКАЗКА, а не только диагноз', async () => {
    const { res } = await runTick()
    expect(res.failed?.detail).toContain('ПЕРЕДНЕМ плане')
    expect(res.failed?.detail).toContain('журнал не дописан')
  })

  it('причина названа в журнале оператора вместе с тем, чем она распознана', async () => {
    const { entries } = await runTick()
    const said = entries.find((e) => e.type === 'task.background_turn_end')
    expect(said).toBeTruthy()
    expect(said.taskId).toBe('BL-1')
    expect(said.detail).toContain('кадры поставщика')
  })

  /**
   * ПРОВОД-ТЕСТ ИЗ ТРЕБОВАНИЯ: первый `result` не закрывает сессию. Попытку закрывает выход
   * ребёнка, поэтому кадры ПОСЛЕ первого результата — и второй результат — судятся вместе с
   * остальным потоком, и этот ход остаётся обычной пропажей записки.
   */
  it('result → фон → фон закончился → второй result: слово о фоне не приписывается', async () => {
    const { res, entries } = await runTick({ lines: [BG_LAUNCH, RESULT_INTERIM, BG_RUNNING, BG_TASK_DONE, RESULT_SECOND] })
    expect(res.failed?.reason).toBe('no_journal')
    expect(entries.some((e) => e.type === 'task.background_turn_end')).toBe(false)
  })

  it('попытка с запиской и уроком при том же живом фоне этим словом не отказана', async () => {
    const { res } = await runTick({ lines: [BG_LAUNCH, BG_RUNNING, APPROACH_SAID, RESULT_INTERIM] })
    expect(res.failed?.reason).not.toBe('background_turn_end')
    expect(res.completed).toBe('BL-1')
  })
})

// ═══════════ СЛОВАРЬ: ЧЕЛОВЕКУ СКАЗАНО ЕГО ЖЕ СЛОВАМИ ═════════════════════════════════════

describe('слово живёт в словаре причин и называет починку', () => {
  it('подпись называет передний план и порядок хода, а не вину работника', () => {
    expect(FAIL_REASONS).toContain('background_turn_end')
    const label = REASON_LABELS.background_turn_end
    expect(label).toContain('фоновой задаче')
    expect(label).toContain('переднем плане')
  })

  it('конец перевыдаваемый — следующая попытка может сделать ту же работу правильным ходом', () => {
    expect(failureAwaitsAPerson('background_turn_end')).toBe(false)
  })
})
