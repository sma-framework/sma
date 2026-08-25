import type { TaskAttempt, TaskStatus, WaitingTicket } from '../../api/types'

/**
 * «ЖИВОЙ ПОТОК» КАРТОЧКИ — последние события УРОВНЯ ПОДХОДА, и только они.
 *
 * ═══════════════ ЧТО ЗДЕСЬ РЕШЕНО ═══════════════
 *
 * Решение владельца 25.08, двумя запретами сразу: не дублировать на карточке целый экран
 * «Живого потока» (там колокола всего парка — про чужие задачи, машины, деньги) и не мельчить
 * до отдельных ходов (тогда поток превращается в журнал, а журнал на карточке уже есть, ниже).
 * Остаётся ровно один масштаб, на котором человек следит за СВОЕЙ задачей: подход начат,
 * подход готов, подход оборвался, задача ждёт вас.
 *
 * ═══════════════ ИСТОЧНИК — ТО, ЧТО КАРТОЧКА УЖЕ ПОЛУЧИЛА ═══════════════
 *
 * Ни одного нового чтения: события собираются из хронологии попыток и состояния задачи, то
 * есть из ответа двери, который карточка держит в руках. Своей ленты окно не копит — лента,
 * живущая в памяти экрана, пуста у только что открытой карточки, и человек прочёл бы это как
 * «ничего не происходило».
 *
 * ═══════════════ ЦВЕТ — ЭТО УТВЕРЖДЕНИЕ ═══════════════
 *
 * Синий — идёт, зелёный — произвело, красный — оборвалось, янтарный — стоит и ждёт человека.
 * Подход, закрывшийся БЕЗ названного исхода, красится нейтрально: покрасить его зелёным
 * значило бы отчитаться об успехе, о котором никто не отчитывался.
 */

export type FlowTone = 'run' | 'ok' | 'fail' | 'wait' | 'plain'

export interface FlowEvent {
  key: string
  /** Момент события в записи двери; `null` — момента никто не записал. */
  at: string | null
  text: string
  tone: FlowTone
}

/** Сколько строк потока помещается на карточке: решение владельца — три-пять, не больше. */
export const FLOW_CAP = 5

/** Чем кончился подход — словом уровня потока. `null` — сказать нечего, строки не будет. */
function endWords(a: TaskAttempt): { text: string; tone: FlowTone } | null {
  const n = a.attempt ?? '—'
  if (a.outcome === 'completed' || a.outcome === 'approved') return { text: `Подход ${n} — готово`, tone: 'ok' }
  if (a.outcome === 'failed') return { text: `Подход ${n} оборвался`, tone: 'fail' }
  if (a.outcome === 'returned') return { text: `Подход ${n} возвращён на доработку`, tone: 'wait' }
  if (a.endedAt) return { text: `Подход ${n} завершён`, tone: 'plain' }
  return null
}

/**
 * approachEvents(...) → последние события задачи, свежие сверху.
 *
 * Порядок — по времени, потому что «последние» считаются по нему, а не по месту в списке
 * попыток: подход с более поздним номером мог закрыться раньше соседа. Событие без момента
 * уходит в хвост — оно не имеет права вытеснить то, о котором известно, когда оно случилось.
 */
export function approachEvents(
  input: {
    attempts: TaskAttempt[]
    status: TaskStatus | null
    /** Стоящий опасный вызов, если он есть: «ждут вас» бывает и на живом подходе. */
    ticket?: WaitingTicket | null
  },
  cap: number = FLOW_CAP,
): FlowEvent[] {
  const events: FlowEvent[] = []

  for (const a of input.attempts) {
    const n = a.attempt ?? '—'
    if (a.startedAt) events.push({ key: `${n}-start`, at: a.startedAt, text: `Подход ${n} начат`, tone: 'run' })
    const end = endWords(a)
    if (end) events.push({ key: `${n}-end`, at: a.endedAt, ...end })
  }

  // ЖДЁТ ВАС — два разных ожидания, и оба про человека. Первое: работа кончилась и стоит перед
  // приёмкой. Второе: подход ЖИВ, но упёрся в опасный вызов и не двинется без решения.
  if (input.status === 'awaiting_approval') {
    const last = input.attempts.length > 0 ? input.attempts[input.attempts.length - 1] : null
    events.push({
      key: 'awaiting',
      at: last?.endedAt ?? null,
      text: 'Ждёт вас — работа стоит перед решением',
      tone: 'wait',
    })
  }
  if (input.ticket) {
    events.push({
      key: `ticket-${input.ticket.id}`,
      at: input.ticket.seenAt ?? null,
      text: 'Ждёт вас — опасный вызов стоит на месте',
      tone: 'wait',
    })
  }

  const timed = events.filter((e) => !!e.at).sort((a, b) => (a.at! < b.at! ? 1 : a.at! > b.at! ? -1 : 0))
  const untimed = events.filter((e) => !e.at)
  return [...timed, ...untimed].slice(0, cap)
}
