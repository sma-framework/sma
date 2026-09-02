/**
 * close-tool-broken.test.ts — ОТКАЗ НАШЕГО ИНСТРУМЕНТА ЗАКРЫТИЯ ≠ МОЛЧАНИЕ РАБОТНИКА.
 *
 * Что было, замерено 01.09.2026. Попытка сделала ВСЮ работу — три коммита, чистый конец хода,
 * 77 минут и $40.24, — но команда, которой её закрывали, упала на разборе заголовка
 * (`TypeError: content.match is not a function`). Записки о подходе не осталось, гейт отказал
 * словом `no_journal` — «работник не объяснился», — и готовая работа была выброшена. Дальше
 * автоповтор выдал ту же задачу второй раз: та же стена за 90 секунд и ещё $1.27; третью
 * выдачу сняли рукой. Работу в итоге спас человек, приняв ветку глазами.
 *
 * ТРИ ЗАКОНА, КОТОРЫЕ ЭТОТ ФАЙЛ ДЕРЖИТ:
 *   1. ПАДЕНИЕ ИНСТРУМЕНТА ЗОВЁТСЯ СВОИМ ИМЕНЕМ. `close_tool_broken` вместо `no_journal` и
 *      `no_lesson` — но ТОЛЬКО там, где отказ уже есть: работу, прошедшую гейт, сломанный
 *      журнал не съедает, иначе починка повторила бы поломку.
 *   2. ЗАВЕРШЁННУЮ РАБОТУ БОЛЬШЕ НЕ ОТМЕНЯЕТ ЗАПИСЬ О НЕЙ. Реестр, бросивший исключение ПОСЛЕ
 *      `adapter.complete`, стоил задаче исхода: попытка объявлялась `runtime_offline` и уезжала
 *      на перевыдачу с зелёной квитанцией в руках.
 *   3. ОБ ТУ ЖЕ СТЕНУ — ОДИН РАЗ. Инструментальный отказ получает ровно один повтор (первое
 *      падение бывает случайным), после чего строка ждёт человека, а не третьей оплаченной
 *      попытки.
 */

import { describe, it, expect } from 'vitest'

import { tick, classifyFailure } from '../src/loop.mjs'
import {
  createMemoryQueue,
  FAIL_REASONS,
  REASON_LABELS,
  AWAITS_A_PERSON,
  AUTO_RETRY_LIMIT,
  INSTRUMENT_RETRY_LIMIT,
  autoRetryLimitFor,
  awaitsAutoRetry,
  endingAwaitsAPerson,
  failureAwaitsAPerson,
  failureIsInstrumental,
} from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const GREEN_RECEIPT = { verdict: 'green', ref: 'reverify:green' }
const BROKE = 'разбор заметки урока упал на .claude/memory/drafts/x.md: content.match is not a function'

describe('слово исхода: сломался инструмент, а не работник', () => {
  it('зелёная квитанция + пропавшая записка + упавший инструмент → close_tool_broken, не no_journal', () => {
    expect(classifyFailure({ receipt: GREEN_RECEIPT, journalComplete: false })).toBe('no_journal')
    expect(classifyFailure({ receipt: GREEN_RECEIPT, journalComplete: false, closeToolError: BROKE })).toBe(
      'close_tool_broken',
    )
  })

  it('то же для урока: close_tool_broken, не no_lesson', () => {
    expect(classifyFailure({ receipt: GREEN_RECEIPT, lessonComplete: false })).toBe('no_lesson')
    expect(classifyFailure({ receipt: GREEN_RECEIPT, lessonComplete: false, closeToolError: BROKE })).toBe(
      'close_tool_broken',
    )
  })

  it('не перебивает концов, названных ДО записки: обрыв, потолок, маркер и красное сильнее', () => {
    expect(classifyFailure({ providerAbort: { reason: 'api_error' }, receipt: GREEN_RECEIPT, closeToolError: BROKE })).toBe(
      'provider_error',
    )
    expect(classifyFailure({ turnCapHit: { turns: 40 }, receipt: GREEN_RECEIPT, closeToolError: BROKE })).toBe(
      'turns_exhausted',
    )
    expect(classifyFailure({ workerMarker: 'NEEDS_DECISION', receipt: GREEN_RECEIPT, closeToolError: BROKE })).toBe(
      'needs_decision',
    )
    expect(classifyFailure({ receipt: { verdict: 'red' }, closeToolError: BROKE })).toBe('tests_red')
  })

  it('закон пропавшей КВИТАНЦИИ не ослаблен: без неё судить нечего', () => {
    expect(classifyFailure({ receipt: null, exitCode: 0, closeToolError: BROKE })).toBe('no_receipt')
  })

  it('слово есть в словаре очереди и у него есть подпись человеку', () => {
    expect(FAIL_REASONS).toContain('close_tool_broken')
    expect(typeof REASON_LABELS.close_tool_broken).toBe('string')
    expect(REASON_LABELS.close_tool_broken.trim()).not.toBe('')
  })
})

describe('перевыдача: об ту же стену — один раз', () => {
  const failedRow = (attempt: number) => ({ status: 'failed', failure_reason: 'close_tool_broken', attempt })

  it('первый отказ инструмента повторяется сам, второй — ждёт человека', () => {
    expect(awaitsAutoRetry(failedRow(1))).toBe(true)
    expect(awaitsAutoRetry(failedRow(2))).toBe(false)
    expect(awaitsAutoRetry(failedRow(3))).toBe(false)
  })

  it('дверь срыва отправляет вторую такую строку на паркующую дверь', () => {
    expect(endingAwaitsAPerson('close_tool_broken', failedRow(1))).toBe(false)
    expect(endingAwaitsAPerson('close_tool_broken', failedRow(2))).toBe(true)
  })

  it('обычные концы своих двух повторов не теряют', () => {
    expect(awaitsAutoRetry({ status: 'failed', failure_reason: 'provider_error', attempt: 2 })).toBe(true)
    expect(awaitsAutoRetry({ status: 'failed', failure_reason: 'provider_error', attempt: 3 })).toBe(false)
    expect(endingAwaitsAPerson('provider_error', { attempt: 9 })).toBe(false)
    expect(autoRetryLimitFor('provider_error')).toBe(AUTO_RETRY_LIMIT)
    expect(autoRetryLimitFor('close_tool_broken')).toBe(INSTRUMENT_RETRY_LIMIT)
  })

  it('и концы, у которых повтора нет вовсе, отвечают как прежде — с ЛЮБОЙ строкой', () => {
    for (const reason of AWAITS_A_PERSON) {
      expect(failureAwaitsAPerson(reason)).toBe(true)
      expect(endingAwaitsAPerson(reason, { attempt: 1 })).toBe(true)
    }
    expect(failureIsInstrumental('close_tool_broken')).toBe(true)
    expect(failureIsInstrumental('agent_error')).toBe(false)
  })
})

// ── ЖИВОЙ ТИК: настоящая очередь, настоящая маршрутизация, подделан только работник ────────

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const WORKERS = [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/claude' }, enabled: true }]

const NOT_BUILT = { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
const GREEN = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:green' }) }
const WORKTREE = { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/close', branch: 'wt/close' }) }

function makeSpawnWorker(lines: string[]) {
  return (spec: any) => {
    for (const l of lines) spec.onLine?.(l)
    spec.onExit?.({ code: 0, signal: null })
    return { pid: 1, kill: () => {} }
  }
}

function makeDeps({ adapter, clock, ledger, decisionJournal, lines }: any) {
  const attempts: any[] = []
  const logs: any[] = []
  return {
    logs,
    attempts,
    deps: {
      adapter,
      ledger: ledger ?? {
        recordAttempt: (a: any) => (attempts.push(a), a),
        readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
      },
      config: { workers: WORKERS, agingHours: 24, backlogScanMinutes: 60, repoDir: '/repo', pipeline: { enabled: true } },
      routing: { resolveRoute },
      windows: () => true,
      platform: 'linux',
      buildArgs: () => ({ bin: 'exec', args: ['-'], env: {}, prompt: 'p' }),
      verbRunner: async (_bin: string, argsArray: string[]) =>
        ({ preflight: NOT_BUILT, worktree: WORKTREE, reverify: GREEN } as any)[argsArray[1]] ?? { code: 0, stdout: '{}' },
      spawnWorker: makeSpawnWorker(lines ?? ['working', 'APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник']),
      report: async () => {},
      clock,
      journal: (e: any) => logs.push(e),
      ...(decisionJournal ? { decisionJournal } : {}),
    },
  }
}

const TASK = { id: 'BL-CT', source: 'backlog', title: 't', lane: 'prod', storyPoints: 2, acceptance: 'a' }

describe('готовую работу больше не съедает её собственная запись', () => {
  it('реестр, бросающий на ЗАВЕРШЕНИИ, не превращает принятую работу в runtime_offline', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(TASK)
    const ledger = {
      recordAttempt: (a: any) => {
        if (a && a.outcome === 'completed') throw new Error('recordAttempt requires a ledgerDir')
        return a
      },
      readAttempts: () => [],
    }
    const { deps, logs } = makeDeps({ adapter, clock: c.clock, ledger })
    const res = await tick(deps)

    expect(res.failed).toBeUndefined()
    expect(res.completed).toBe(TASK.id)
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval') // работа дошла до человека, а не в перевыдачу
    // NEVER SILENT: потерянная строка реестра названа вслух и названа своим классом
    const said = logs.find((e) => e.type === 'ledger-error')
    expect(said).toBeTruthy()
    expect(said.reason).toBe('close_tool_broken')
  })

  it('журнал, бросающий на слое записки, тоже не съедает прошедшую гейт работу', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(TASK)
    const { deps, logs } = makeDeps({
      adapter,
      clock: c.clock,
      decisionJournal: () => {
        throw new Error('EACCES: permission denied, open journal.jsonl')
      },
    })
    const res = await tick(deps)

    expect(res.completed).toBe(TASK.id)
    expect(logs.some((e) => e.type === 'journal-error')).toBe(true)
    expect(logs.some((e) => e.type === 'close-tool-broken')).toBe(true)
  })

  it('а когда отказ ЕСТЬ, он называется инструментом: нет урока + упавший журнал → close_tool_broken', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(TASK)
    const { deps } = makeDeps({
      adapter,
      clock: c.clock,
      lines: ['working', 'APPROACH_NOTE: прямой путь'], // записка есть, слова об уроке нет
      decisionJournal: () => {
        throw new Error('EACCES: permission denied, open journal.jsonl')
      },
    })
    const res = await tick(deps)

    expect(res.failed).toEqual({ taskId: TASK.id, reason: 'close_tool_broken' })
    const [row] = await adapter.list({})
    expect(row.failure_reason).toBe('close_tool_broken')
  })
})
