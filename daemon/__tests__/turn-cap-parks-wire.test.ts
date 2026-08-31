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

/** Записывает, с какими настройками тик позвал сборщик аргументов, и что тот вернул. */
function recordingBuildArgs(seen: any[]) {
  return (task: any, route: any, options: any) => {
    seen.push({ task, route, options })
    return { bin: 'claude', args: buildClaudeArgs({ maxTurns: 160 }), env: { ...SPAWN_ENV }, prompt: PROMPT }
  }
}

/** Один настоящий тик над временным проектом и настоящей очередью-образцом. */
async function runTick(over: any = {}) {
  const projectDir = mkDir('sma-cap-proj-')
  const ledgerDir = mkDir('sma-cap-ledger-')
  const workDir = mkDir('sma-cap-copy-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const lines: string[] = over.lines ?? [RESULT_MAX_TURNS]
  // Прошлые попытки ТОЙ ЖЕ работы, если дело о них: реестр переживает парковку, и именно из
  // него следующий заход узнаёт, обо что уже споткнулись.
  for (const row of over.seedLedger ?? []) recordAttempt(ledgerDir, row)
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
    buildArgs: over.buildArgs ?? (() => ({ bin: 'claude', args: buildClaudeArgs({ maxTurns: 80 }), env: { ...SPAWN_ENV }, prompt: PROMPT })),
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

// ═══════════ СЛЕДУЮЩАЯ ПОПЫТКА НЕ ИДЁТ С ТЕМ ЖЕ ПОТОЛКОМ ═══════════════════════════════════

describe('потолок следующей попытки берётся от того, что уже сгорело', () => {
  /**
   * ЧТО ИМЕННО ЗДЕСЬ ПРОВОД. Реестр попыток переживает парковку — это единственное место, где
   * записано, ПОД КАКИМ потолком работа уже споткнулась. Тик обязан его прочитать и передать
   * сборщику аргументов; сборщик обязан поднять. Здесь снимается первая половина (тик правда
   * читает и правда передаёт), вторая — в `build-args.test.ts`, где то же число становится
   * флагом командной строки.
   */
  it('тик приносит сборщику потолки, которые эта работа уже сожгла', async () => {
    const seen: any[] = []
    await runTick({
      buildArgs: recordingBuildArgs(seen),
      seedLedger: [
        { taskId: 'BL-1', attempt: 1, outcome: 'failed', failureReason: 'turns_exhausted', turnCap: 160, turnsUsed: 160 },
      ],
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].options.burnedTurnCaps).toEqual([160])
  })

  it('чужая авария щедрости не даёт — поднимают только те потолки, что сгорели ходами', async () => {
    const seen: any[] = []
    await runTick({
      buildArgs: recordingBuildArgs(seen),
      seedLedger: [
        { taskId: 'BL-1', attempt: 1, outcome: 'failed', failureReason: 'provider_error', turnCap: 240 },
      ],
    })
    expect(seen[0].options.burnedTurnCaps).toEqual([])
  })

  /**
   * И ПОТОЛОК ПОПЫТКИ ЛОЖИТСЯ НА ЕЁ СТРОКУ. Без записанного числа «следующая попытка идёт с
   * бóльшим запасом» осталось бы обещанием без арифметики: поднимать было бы не от чего.
   * Вместе с ним ложится разбивка по роду — то, чем человек выбирает между «поднять» и
   * «разрезать».
   */
  it('строка попытки несёт свой потолок, свои ходы и их разбивку по роду', async () => {
    const { ledgerDir } = await runTick({
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: { model: 'claude', content: [{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Edit' }] },
        }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude', content: [{ type: 'tool_use', name: 'Read' }] } }),
        RESULT_MAX_TURNS,
      ],
    })
    const rows = readAttempts(ledgerDir, 'BL-1')
    const row = rows.find((r: any) => r.failureReason === 'turns_exhausted')

    expect(row.turnCap).toBe(80) // то, что реально стояло на командной строке этого запуска
    expect(row.turnsUsed).toBe(80) // то, что CLI насчитал себе сам
    expect(row.turnKinds).toEqual({ edits: 1, runs: 1, reads: 1, other: 0 })
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
  it('человека ждут РОВНО три причины из всей таксономии — остальные сохраняют свой повтор', () => {
    // ВТОРОЕ СЛОВО, И РЕШЕНИЕ ЗА НИМ НАЗВАНО ЗДЕСЬ, как этот эталон и требует. Роли, которую
    // просит работа, не держит никто (или держит один выключенный) — и перевыдача сколько
    // угодно раз даст ровно тот же ответ: состав машины от ожидания не меняется. Чинит это
    // человек, одним из двух: включить работника с такой ролью или переставить роль на задаче.
    // ТРЕТЬЕ СЛОВО — единственное в списке, которое не про поломку. Работа завела каталог
    // верхнего уровня; из чего состоит продукт — не её решение, а перевыдача по построению
    // заведёт тот же каталог второй раз. Нужен ОДИН ответ человека, и строка стоит и ждёт его.
    expect([...AWAITS_A_PERSON]).toEqual(['turns_exhausted', 'role_unavailable', 'new_top_level_dir'])
    expect(failureAwaitsAPerson('turns_exhausted')).toBe(true)
    expect(failureAwaitsAPerson('role_unavailable')).toBe(true)
    expect(failureAwaitsAPerson('new_top_level_dir')).toBe(true)

    const stillRetried = FAIL_REASONS.filter((r: string) => !failureAwaitsAPerson(r))
    expect(stillRetried).toContain('provider_error')
    expect(stillRetried).toContain('liveness_killed')
    expect(stillRetried).toContain('runtime_offline')
    expect(stillRetried).toContain('tests_red')
    // Самозамкнутый тест повтор СОХРАНЯЕТ: это дефект работы, и следующая попытка,
    // прочитавшая причину на карточке, вполне может написать тест о продукте.
    expect(stillRetried).toContain('self_referential_test')
    expect(stillRetried).toHaveLength(FAIL_REASONS.length - 3)

    // Незнакомое слово повтор НЕ теряет: забыть причину в списке нельзя так, чтобы она молча
    // перестала повторяться.
    expect(failureAwaitsAPerson('a_word_nobody_has_written_yet')).toBe(false)
  })
})
