/**
 * ПРОВОД: ЗАВЕРШЕНИЕ, ДОБЕЖАВШЕЕ ПОСЛЕ ПРИГОВОРА СТОРОЖА ЖИВОСТИ.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Между захватом задачи и её закрытием стоит сторож живости: он
 * объявляет замолчавшего работника мёртвым и возвращает задачу в очередь. Иногда работник не
 * молчал, а просто не успел сказать — и его завершение приезжает к строке, которой сторож уже
 * распорядился. До этого файла такое завершение падало наружу отказом очереди («complete: no
 * active task»), попадало в общий улов тика и заканчивалось ещё одним `runtime_offline`:
 * зелёная работа с квитанцией на руках оставалась похороненной под исходом, который сторож
 * РЕКОНСТРУИРОВАЛ по молчанию. Проверить это чтением кода было нечем — ни один случай не вёл
 * попытку от приговора сторожа до её собственного завершения.
 *
 * ТРИ УТВЕРЖДЕНИЯ:
 *
 *   (1) ИСХОД ПЕРЕЗАПИСЫВАЕТСЯ ПРАВДОЙ. Строка, закрытая сторожем, после позднего завершения
 *       читается как сделанная работа, ждущая слова человека, — и придуманная сторожем причина
 *       провала с неё уходит. Тик при этом отвечает «завершено», а не «провалено».
 *   (2) В ЖУРНАЛЕ ОБА СОБЫТИЯ. Приговор сторожа и поздняя правда стоят двумя строками, в том
 *       порядке, в каком случились. Это и есть разница между перезаписью и молчаливой
 *       подменой: читающий видит, что исход менялся, и почему.
 *   (3) ПОЗДНЯЯ ПРАВДА НЕ ПЕРЕБИВАЕТ ЖИВУЮ ПОПЫТКУ СОСЕДА. Если очередь отказывает и на
 *       названном завершении — строку уже держит другой работник, — отказ уходит наверх
 *       обычным провалом тика, а не проглатывается.
 *
 * ОЧЕРЕДЬ ЗДЕСЬ НАСТОЯЩАЯ, И СТОРОЖ ТОЖЕ. Обёртка поверх живой очереди делает ровно две вещи:
 * в нужный момент запускает НАСТОЯЩИЙ обход сторожа (он и закрывает строку), а затем
 * воспроизводит правило ДОЛГОВЕЧНОЙ очереди, которого у образцовой реализации нет, — завершение
 * адресуется АКТИВНОЙ строке (`state = 'active'` в pgboss-backend.mjs), а строке, отданной
 * сторожем обратно в очередь, — только названное завершение (`afterSweep`). Урок соседнего
 * провода: подделка, отдающая то, чего от неё ждут, зелена всегда.
 */

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue, UnknownTaskError, StaleAttemptError } from '../src/queue/adapter.mjs'
import { livenessSweep } from '../src/queue/liveness.mjs'

// ── время, которым распоряжается случай ────────────────────────────────────────────────────

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

/** Срок аренды у самой очереди — заведомо длиннее срока сторожа: собственный обход очереди
 *  не должен опередить тот, чью работу этот файл измеряет. */
const QUEUE_EXPIRE_MS = 3_600_000
/** Срок, по которому судит сторож живости. */
const SWEEP_EXPIRE_MS = 60_000

// ── очередь, у которой строку успевает забрать сторож ──────────────────────────────────────

/**
 * Живая очередь + сторож, срабатывающий РОВНО между работой и её закрытием — то есть в том
 * единственном окне, где авария и живёт. Часы двигаются за срок сторожа, обход настоящий:
 * он сам пишет приговор в журнал и сам возвращает задачу в очередь через `fail`.
 */
function queueSweptBeforeCompletion(c: ReturnType<typeof mkClock>, journal: (e: any) => void) {
  const inner = createMemoryQueue({ clock: c.clock, expireMs: QUEUE_EXPIRE_MS })
  const state = { swept: false }
  const adapter: any = {
    ...inner,
    async complete(taskId: string, result: any) {
      if (!state.swept) {
        state.swept = true
        c.advance(SWEEP_EXPIRE_MS + 1)
        await livenessSweep({ adapter: inner, clock: c.clock, expireMs: SWEEP_EXPIRE_MS, journal })
      }
      // Правило долговечной очереди: завершение адресуется АКТИВНОЙ строке. Строку, отданную
      // сторожем обратно в очередь, закрывает только завершение, назвавшее себя поздним.
      const row = (await inner.list({})).find((r: any) => r.id === taskId)
      if (row && row.status !== 'claimed' && result?.afterSweep !== true) {
        throw new UnknownTaskError(`complete: no active task "${taskId}"`)
      }
      return inner.complete(taskId, result)
    },
  }
  return { adapter, inner, state }
}

/** Та же обстановка, но строку уже держит ДРУГОЙ работник: очередь отказывает и позднему
 *  завершению — чужим жетоном, как отказала бы живая. */
function queueTakenByNeighbour(c: ReturnType<typeof mkClock>, journal: (e: any) => void) {
  const { adapter, inner, state } = queueSweptBeforeCompletion(c, journal)
  const guarded: any = {
    ...adapter,
    async complete(taskId: string, result: any) {
      if (result?.afterSweep === true) {
        throw new StaleAttemptError(`complete("${taskId}") refused: stale attempt token`)
      }
      return adapter.complete(taskId, result)
    },
  }
  return { adapter: guarded, inner, state }
}

// ── мир одного тика ────────────────────────────────────────────────────────────────────────

const task = (over: any = {}) => ({
  id: 'BL-late',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

const CODE_RESPONSES: Record<string, any> = {
  preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
  worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
  reverify: { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) },
}

/** Работник, который делает работу и объясняется — то есть проходит в дверь «сделано». */
function greenWorker() {
  return (spec: any) => {
    spec.onLine?.('APPROACH_NOTE: прямой путь')
    spec.onLine?.('LESSON_NONE: тестовый работник')
    spec.onExit?.({ code: 0, signal: null })
    return { pid: 4242, kill: () => {} }
  }
}

function makeDeps(over: any) {
  const attempts: any[] = []
  const deps: any = {
    adapter: over.adapter,
    ledger: {
      recordAttempt: (a: any) => {
        attempts.push(a)
        return a
      },
      readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
      attemptLog: () => ({ append: () => {} }),
    },
    config: {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: '/repo',
      pipeline: { enabled: true },
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: async (_bin: string, argsArray: string[]) => CODE_RESPONSES[argsArray[1]] ?? { code: 0, stdout: '{}' },
    spawnWorker: greenWorker(),
    report: async () => {},
    clock: over.clock,
    journal: over.journal,
  }
  return { deps, attempts }
}

const settle = () => new Promise((r) => setImmediate(r))

// ── случаи ─────────────────────────────────────────────────────────────────────────────────

describe('ПРОВОД: поздний настоящий результат перезаписывает приговор сторожа', () => {
  it('строка, закрытая сторожем, становится завершённой по квитанции — и обоих событий в журнале не теряет', async () => {
    const c = mkClock()
    const journalled: any[] = []
    const { adapter, inner, state } = queueSweptBeforeCompletion(c, (e) => journalled.push(e))
    await adapter.enqueue(task())

    const { deps, attempts } = makeDeps({ adapter, clock: c.clock, journal: (e: any) => journalled.push(e) })

    const res = await tick(deps)
    await settle()

    // ЗАМОК ОТ ВАКАНСИИ: сторож действительно сработал, и его приговор действительно закрыл
    // строку. Без этого утверждения случай, в котором обход не случился, прошёл бы всё
    // остальное по вакансии и перестал бы сторожить молча.
    expect(state.swept).toBe(true)
    const verdict = journalled.filter((e) => e.type === 'liveness.attempt_dead' && e.taskId === 'BL-late')
    expect(verdict).toHaveLength(1)

    // (1) ИСХОД ПЕРЕЗАПИСАН ПРАВДОЙ ЗАВЕРШЕНИЯ.
    expect(res.completed).toBe('BL-late')
    expect(res.failed).toBeUndefined()
    const row: any = (await inner.list({})).find((r: any) => r.id === 'BL-late')
    expect(row.status).toBe('awaiting_approval')
    // Придуманная по молчанию причина ушла со строки: «сделано и провалено» одновременно на
    // одной карточке не читается.
    expect(row.failure_reason).toBeNull()

    // (2) В ЖУРНАЛЕ ОБА СОБЫТИЯ, В ПОРЯДКЕ СЛУЧИВШЕГОСЯ.
    const late = journalled.filter((e) => e.type === 'attempt.late_complete' && e.taskId === 'BL-late')
    expect(late).toHaveLength(1)
    expect(late[0].receiptRef).toBe('reverify:abc')
    expect(journalled.indexOf(verdict[0])).toBeLessThan(journalled.indexOf(late[0]))

    // И в реестре попыток лежит завершение с квитанцией, а не второй `runtime_offline`.
    const rows = attempts.filter((a) => a.taskId === 'BL-late')
    expect(rows.map((a) => a.outcome)).toEqual(['completed'])
    expect(rows[0].receiptRef).toBe('reverify:abc')
  })

  it('поздняя правда не перебивает живую попытку соседа: отказ очереди остаётся отказом', async () => {
    const c = mkClock()
    const journalled: any[] = []
    const { adapter, inner } = queueTakenByNeighbour(c, (e) => journalled.push(e))
    await adapter.enqueue(task({ id: 'BL-taken' }))

    const { deps } = makeDeps({ adapter, clock: c.clock, journal: (e: any) => journalled.push(e) })

    const res = await tick(deps)
    await settle()

    // Дверь «сделано» закрыта: чужую строку это завершение не переписало.
    expect(res.completed).toBeUndefined()
    expect(res.failed?.taskId).toBe('BL-taken')
    const row: any = (await inner.list({})).find((r: any) => r.id === 'BL-taken')
    expect(row.status).not.toBe('awaiting_approval')
    // И отказ не проглочен молча — он назван в журнале тика.
    expect(journalled.some((e) => e.type === 'task-error' && e.taskId === 'BL-taken')).toBe(true)
  })
})
