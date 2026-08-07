/**
 * format.ts — the words and the numbers the window puts on the glass.
 *
 * It began beside «Сегодня», the first screen that needed it. Six screens borrow it now,
 * so it lives in the shell — where the registry says anything two screens both need
 * belongs. The move is that decision made out loud; not a word of the wording changed, so
 * every screen still says a count, a clock face and a colour exactly as before.
 *
 * Nothing here invents a fact. Every helper takes what the reading already said and puts
 * it into Russian a person reads without translating: hours, attempts, a clock time. A
 * value that is not there stays a dash — an empty place is never dressed up as a zero.
 */

import { isNotReady, isRaceLost } from '../api/client'
import type { PhaseStage, ReceiptSummary, TaskStatus } from '../api/types'

/**
 * What each of the four stages is called on the glass.
 *
 * It began beside «Конвейер фаз», the first screen with stages on it, and moved here the day
 * the conversation grew a stage draft of its own — the registry's rule for a thing two
 * screens both need, applied rather than quietly copied. Two spellings of «Приёмка» would be
 * two screens naming one stage differently, which is exactly how a person learns to check
 * which screen they are on before believing it.
 */
export const STAGE_LABEL: Record<PhaseStage, string> = {
  discuss: 'Обсуждение',
  plan: 'План',
  execute: 'Исполнение',
  verify: 'Приёмка',
}

/** Russian counts three ways. This is that rule, written once. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m100 >= 11 && m100 <= 14) return many
  if (m10 === 1) return one
  if (m10 >= 2 && m10 <= 4) return few
  return many
}

/** How long something has been waiting. Past a day the minutes stop meaning anything. */
export function hoursLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'меньше часа'
  if (hours >= 24) {
    const whole = Math.round(hours)
    return `${whole} ${plural(whole, 'час', 'часа', 'часов')}`
  }
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m} м`
  return m > 0 ? `${h} ч ${m} м` : `${h} ч`
}

/** How many runs at it were taken. */
export function attemptsLabel(n: number): string {
  return `${n} ${plural(n, 'подход', 'подхода', 'подходов')}`
}

/** The clock face of a moment, in the reader's own time. A missing moment stays a dash. */
export function clockLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** The one letter that stands for a worker's line of work in a small square. */
export function initialOf(text: string | null | undefined, fallback = '·'): string {
  const s = (text ?? '').trim()
  return s.length > 0 ? s[0].toUpperCase() : fallback
}

/**
 * A colour for a square, decided by the name on it. The palette is the accepted one, so a
 * new line of work gets a colour that already belongs to the screen instead of a new hex.
 * The same name always draws the same colour — the eye learns it in a day.
 */
const ACCENTS = [
  'bg-blue-s text-blue',
  'bg-ok-s text-ok-tx',
  'bg-warn-s text-warn-tx',
  'bg-idle-s text-idle-tx',
] as const

export function accentFor(name: string | null | undefined): string {
  const s = (name ?? '').trim()
  let hash = 0
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) % 9973
  return ACCENTS[hash % ACCENTS.length]
}

/**
 * What a status is CALLED, and what colour it wears. One vocabulary for the whole window:
 * the panel and the card must never call the same state two different things, or a person
 * learns two words for one fact.
 */
const STATUS_WORDS: Record<TaskStatus, string> = {
  queued: 'в очереди',
  claimed: 'взята в работу',
  running: 'в работе',
  awaiting_approval: 'ждёт решения',
  approving: 'принимается',
  approved: 'принято',
  returned: 'возвращена',
  completed: 'готово',
  failed: 'не получилось',
}

const STATUS_TONE: Record<TaskStatus, string> = {
  queued: 'bg-idle-s text-idle-tx',
  claimed: 'bg-blue-s text-blue',
  running: 'bg-blue-s text-blue',
  awaiting_approval: 'bg-blue-s text-blue',
  approving: 'bg-blue-s text-blue',
  approved: 'bg-ok-s text-ok-tx',
  returned: 'bg-warn-s text-warn-tx',
  completed: 'bg-ok-s text-ok-tx',
  failed: 'bg-err-s text-err-tx',
}

export function statusWord(status: TaskStatus | null | undefined, unknown = 'открываю'): string {
  return status ? STATUS_WORDS[status] : unknown
}

export function statusTone(status: TaskStatus | null | undefined): string {
  return status ? STATUS_TONE[status] : 'bg-idle-s text-idle-tx'
}

/**
 * What the checks said, in the words of the person who has to trust them. A check that was
 * never read is not listed — an unread receipt is never dressed up as a pass.
 */
export function receiptChecks(receipt: ReceiptSummary | null | undefined): { text: string; ok: boolean }[] {
  if (!receipt) return []
  const checks: { text: string; ok: boolean }[] = []
  if (receipt.testsTotal !== null && receipt.testsPassed !== null) {
    checks.push({
      text: `Проверки ${receipt.testsPassed} из ${receipt.testsTotal}`,
      ok: receipt.testsPassed === receipt.testsTotal,
    })
  }
  if (receipt.tscClean !== null) checks.push({ text: 'Сборка без ошибок', ok: receipt.tscClean })
  if (receipt.guardClean !== null) checks.push({ text: 'Правила соблюдены', ok: receipt.guardClean })
  return checks
}

/** A refusal, said in the words of the person it happened to. */
export function refusalWords(err: unknown): string {
  if (isNotReady(err)) return 'Это действие пока недоступно.'
  if (isRaceLost(err)) return 'За эту задачу уже ответили с другой стороны.'
  return 'Не получилось отправить. Попробуйте ещё раз.'
}
