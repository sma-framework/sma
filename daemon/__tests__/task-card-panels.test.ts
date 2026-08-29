/**
 * ДВА СЧЁТА КАРТОЧКИ ЗАДАЧИ — РАСХОД И ЖИВОЙ ПОТОК — ПРОВЕРЕННЫЕ НЕ ГЛАЗОМ.
 *
 * ═══════════════ ЗАЧЕМ ЭТО ОТДЕЛЬНЫМ ПРОГОНОМ ═══════════════
 *
 * Обе панели показывают УТВЕРЖДЕНИЯ, а не украшения: «кэш · чтение — 1.2k» говорит человеку,
 * во что обошлась работа, а «Подход 2 оборвался» — что с ней случилось. Утверждение,
 * посчитанное внутри разметки, проверяется одним человеческим глазом на живом экране и
 * расходится с правдой молча — этот класс дефекта в дереве уже случался, поэтому счёт вынесен
 * в `spend.ts` и `flow.ts`, а вёрстка осталась показом.
 *
 * ═══════════════ ЧТО ИМЕННО СТОРОЖИТСЯ ═══════════════
 *
 *   РАСХОД: шесть строк ровно; измеренный ноль отличается от неизмеренного (ноль — ответ,
 *   прочерк — отсутствие ответа) И прочерк несёт причину словами; своих чисел панель не
 *   считает; нулевой потолок платного канала назван выключенным, а не «без ограничения».
 *
 *   ПОТОК: строки уровня ПОДХОДА и не мельче; свежие сверху даже когда подход с большим
 *   номером закрылся раньше соседа; не больше пяти (решение владельца — три-пять); подход,
 *   закрывшийся без названного исхода, не покрашен зелёным; «ждёт вас» приходит и от
 *   стоящего перед приёмкой подхода, и от стоящего опасного вызова.
 */

import { describe, it, expect } from 'vitest'

import { spendRows, spendReasons, paidApiRow, WHY_NO_TOKENS } from '../../spa/src/screens/task-card/spend'
import { approachEvents, FLOW_CAP } from '../../spa/src/screens/task-card/flow'
import { NOT_MEASURED } from '../../spa/src/shell/stats'
import type { TaskAttempt } from '../../spa/src/api/types'

const SUMS = { input: 1200, output: 340, cacheRead: 98000, cacheWrite: 7600 }

/** Попытка в той форме, в какой её отдаёт дверь задачи; названо только то, что читают панели. */
function attempt(o: Partial<TaskAttempt>): TaskAttempt {
  return {
    attempt: 1,
    workerId: null,
    provider: null,
    startedAt: null,
    endedAt: null,
    outcome: null,
    failureReason: null,
    reasonLabel: null,
    receipt: null,
    ...o,
  } as TaskAttempt
}

describe('расход карточки задачи', () => {
  it('шесть строк, и все четыре числа поставщика на месте', () => {
    const rows = spendRows({
      tokens: SUMS,
      session: '$0.42 · ходов: 17',
      spendSwitch: { mode: 'api', budgeted: true, capUsd: 30 } as never,
    })

    expect(rows.map((r) => r.key)).toEqual([
      'subscription',
      'tokensIn',
      'tokensOut',
      'cacheRead',
      'cacheWrite',
      'paidApi',
    ])
    expect(rows.every((r) => r.known)).toBe(true)
    expect(rows[0].value).toBe('$0.42 · ходов: 17')
    // Числа — те самые, что приехали; своей арифметики панель не заводит. Разделитель дробной
    // части оставлен на усмотрение локали окна: сторожится величина, а не запятая.
    expect(rows[1].value).toMatch(/^1[.,]2/)
    expect(rows[4].value).toMatch(/^7[.,]6/)
    expect(spendReasons(rows)).toEqual([])
  })

  it('измеренный ноль — это ответ, а неизмеренное — прочерк С ПРИЧИНОЙ', () => {
    const measuredZero = spendRows({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, session: 'x' })
    for (const key of ['tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite']) {
      const row = measuredZero.find((r) => r.key === key)!
      expect(row.known).toBe(true)
      expect(row.value).toBe('0')
    }

    const unmeasured = spendRows({ tokens: null, session: 'x' })
    for (const key of ['tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite']) {
      const row = unmeasured.find((r) => r.key === key)!
      expect(row.known).toBe(false)
      expect(row.value).toBe(NOT_MEASURED)
      expect(row.why).toBe(WHY_NO_TOKENS)
    }
    // Одна причина на четыре молчащие строки — честность не должна стать шумом.
    expect(spendReasons(unmeasured).filter((w) => w === WHY_NO_TOKENS)).toHaveLength(1)
  })

  it('подписка без итога сессии молчит прочерком, а не нулём', () => {
    const row = spendRows({ tokens: SUMS, session: null })[0]
    expect(row.value).toBe(NOT_MEASURED)
    expect(row.known).toBe(false)
    expect(row.why).toBeTruthy()
  })

  it('нулевой потолок платного канала назван выключенным, а не «без ограничения»', () => {
    const zero = paidApiRow({ mode: 'sub', budgeted: true, capUsd: 0 } as never)
    expect(zero.value).toBe('выключен')
    expect(zero.why).toContain('не «без ограничения»')

    expect(paidApiRow(null).value).toBe(NOT_MEASURED)
    expect(paidApiRow({ mode: 'api', budgeted: true, capUsd: 30 } as never).value).toBe('работа идёт за деньги')
  })
})

describe('живой поток карточки задачи', () => {
  it('свежие сверху — по времени, а не по номеру подхода', () => {
    const events = approachEvents({
      attempts: [
        attempt({ attempt: 1, startedAt: '2026-08-25T10:00:00Z', endedAt: '2026-08-25T12:00:00Z', outcome: 'failed' }),
        attempt({ attempt: 2, startedAt: '2026-08-25T10:30:00Z', endedAt: '2026-08-25T11:00:00Z', outcome: 'completed' }),
      ],
      status: 'running',
    })

    expect(events[0].text).toBe('Подход 1 оборвался')
    expect(events[0].tone).toBe('fail')
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort().reverse())
    expect(events.find((e) => e.text === 'Подход 2 — готово')!.tone).toBe('ok')
  })

  it('не больше пяти строк — решение владельца о трёх-пяти', () => {
    const attempts = Array.from({ length: 6 }, (_, i) =>
      attempt({
        attempt: i + 1,
        startedAt: `2026-08-25T1${i}:00:00Z`,
        endedAt: `2026-08-25T1${i}:30:00Z`,
        outcome: 'completed',
      }),
    )
    expect(approachEvents({ attempts, status: 'running' })).toHaveLength(FLOW_CAP)
    expect(FLOW_CAP).toBe(5)
  })

  it('подход, закрывшийся без названного исхода, не красится зелёным', () => {
    const events = approachEvents({
      attempts: [attempt({ attempt: 1, startedAt: '2026-08-25T10:00:00Z', endedAt: '2026-08-25T11:00:00Z' })],
      status: 'running',
    })
    const end = events.find((e) => e.text === 'Подход 1 завершён')!
    expect(end.tone).toBe('plain')
  })

  it('«ждёт вас» приходит и от приёмки, и от стоящего опасного вызова', () => {
    const waiting = approachEvents({
      attempts: [attempt({ attempt: 1, startedAt: '2026-08-25T10:00:00Z', endedAt: '2026-08-25T11:00:00Z' })],
      status: 'awaiting_approval',
    })
    expect(waiting.some((e) => e.text.startsWith('Ждёт вас — работа стоит'))).toBe(true)

    const ticket = approachEvents({
      attempts: [attempt({ attempt: 1, startedAt: '2026-08-25T10:00:00Z' })],
      status: 'running',
      ticket: { id: 't1', seenAt: '2026-08-25T10:30:00Z' } as never,
    })
    expect(ticket[0].text).toBe('Ждёт вас — опасный вызов стоит на месте')
    expect(ticket[0].tone).toBe('wait')
  })

  it('подходов не было — рассказывать нечего, и это пустой список, а не выдуманная строка', () => {
    expect(approachEvents({ attempts: [], status: 'queued' })).toEqual([])
  })
})
