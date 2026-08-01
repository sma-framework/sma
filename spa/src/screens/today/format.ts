/**
 * format.ts — the words and the numbers this screen puts on the glass.
 *
 * It lives beside the screen it serves, and nowhere else: none of it is general enough to
 * belong to the shell, and a screen that keeps its own wording keeps it consistent.
 *
 * Nothing here invents a fact. Every helper takes what the reading already said and puts
 * it into Russian a person reads without translating: hours, attempts, a clock time. A
 * value that is not there stays a dash — an empty place is never dressed up as a zero.
 */

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
