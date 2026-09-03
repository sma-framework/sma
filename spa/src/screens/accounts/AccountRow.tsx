import type { AccountEntry, WindowFact } from '../../api/types'
import {
  WINDOW_STALE_HINT,
  WINDOW_UNKNOWN_HINT,
  clockLabel,
  readingAgeWords,
  readingIsStale,
  windowWords,
} from '../../shell/format'

/**
 * AccountRow — one subscription: its windows, the workers riding it, and the machine it
 * lives on.
 *
 * ═══════════════════ THE MACHINE IS PART OF THE ACCOUNT, NOT A DETAIL ═══════════════════
 *
 * A subscription belongs to exactly one machine. That is not a convention this screen
 * enforces after the fact — it is how the household is built: machines aggregate each other's
 * VIEWS and never each other's credentials, so an account can only ever be logged in in one
 * place. The rule used to live in people's heads; here it is a line under every row, which is
 * what makes «why did that account not pick anything up» answerable without asking anyone.
 *
 * The windows are stated in words, never in money. A plan is already paid for, so the useful
 * question is whether it is still taking work and when it turns over — and those two are
 * exactly what the provider tells us. The percentage beside them is its number too, out of the
 * unified block of its own rate-limit frames; the bar that used to stand here was something
 * else entirely — the daemon's own token count against an invented capacity, near zero on a
 * subscription that was nearly spent. A window nothing has been heard about says «нет данных»,
 * and every number that IS shown carries the hour it was measured at.
 */

/** The two letters in the square. Two words give two initials; one word gives its first two. */
function badgeOf(name: string): string {
  const words = name.split(/[\s·—-]+/u).filter(Boolean)
  if (words.length === 0) return '··'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** A colour for the square, decided by the name, so the same account is always the same colour. */
const SQUARES = ['bg-blue-s text-blue', 'bg-ok-s text-ok-tx', 'bg-warn-s text-warn-tx', 'bg-idle-s text-idle-tx']

function squareFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 9973
  return SQUARES[hash % SQUARES.length]
}

/** What the window is doing, in the words the rest of the product uses for the same fact. */
function statusOf(a: AccountEntry): { text: string; dot: string; tone: string } {
  if (a.windows.closedUntil) {
    return { text: `откроется в ${clockLabel(a.windows.closedUntil)}`, dot: 'bg-warn', tone: 'bg-warn-s text-warn-tx' }
  }
  if (a.windows.fiveHour?.status === 'exhausted' || a.windows.week?.status === 'exhausted') {
    return { text: 'окно исчерпано', dot: 'bg-warn', tone: 'bg-warn-s text-warn-tx' }
  }
  if (a.dayPriorityOwner) return { text: 'днём · Ваш', dot: 'bg-blue', tone: 'bg-blue-s text-blue' }
  if (a.windows.fiveHour?.status === 'open') {
    return { text: 'принимает работу', dot: 'bg-green', tone: 'bg-ok-s text-ok-tx' }
  }
  // Nothing has been heard. The row says so rather than showing the green dot of an account
  // nobody has actually confirmed is taking work.
  return { text: 'состояние неизвестно', dot: 'bg-tx3', tone: 'bg-idle-s text-idle-tx' }
}

/**
 * One window, named and said — with the provider's own percentage and the hour it was taken.
 *
 * No bar still: a bar is a shape, and the shape is what made the old zero look like a
 * measurement. What stands here is the number the provider itself sent, and it never stands
 * alone — «этот счёт исчерпан» без даты не отличить от «был исчерпан вчера», а это и есть
 * вопрос, ради которого на строку счёта смотрят.
 */
function WindowCell({ label, fact }: { label: string; fact: WindowFact | undefined }) {
  const words = windowWords(fact)
  const unknown = fact?.status !== 'open' && fact?.status !== 'exhausted'
  const age = unknown ? null : readingAgeWords(fact?.observedAt)
  const stale = !unknown && readingIsStale(fact?.observedAt)
  return (
    <div
      className="w-[196px] flex-none"
      title={unknown ? WINDOW_UNKNOWN_HINT : stale ? WINDOW_STALE_HINT : undefined}
    >
      <div className="mb-[5px] text-[10.5px] text-tx3">{label}</div>
      <div className="flex items-center gap-[6px]">
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${words.dot}`} />
        <span className={`truncate text-[11.5px] ${words.muted ? 'text-tx3' : 'text-tx2'}`}>{words.text}</span>
        {typeof fact?.pct === 'number' ? (
          <span className="flex-none text-[11px] text-tx3 tabular-nums">{Math.round(fact.pct)}%</span>
        ) : null}
      </div>
      {age ? (
        <div className={`mt-[3px] text-[10.5px] whitespace-nowrap ${stale ? 'text-warn-tx' : 'text-tx3'}`}>
          чтение {age}
          {stale ? ' · устарело' : ''}
        </div>
      ) : null}
    </div>
  )
}

export function AccountRow({
  account,
  machineTitle,
  first,
}: {
  account: AccountEntry
  /** The machine's own name when the household knows it; its identifier when it does not. */
  machineTitle: string
  first: boolean
}) {
  const status = statusOf(account)
  const riders = account.workers

  return (
    <div className={`flex flex-col gap-2 px-[18px] py-[15px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[11px] font-bold ${squareFor(
            account.name,
          )}`}
        >
          {badgeOf(account.name)}
        </span>
        <span className="flex-none text-[13.5px] font-semibold whitespace-nowrap text-tx">{account.name}</span>
        <span
          className={`flex flex-none items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] whitespace-nowrap ${status.tone}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${status.dot}`} />
          {status.text}
        </span>

        <div className="flex-1" />

        <div className="flex flex-none items-center gap-6">
          <WindowCell label="Окно (5 ч)" fact={account.windows.fiveHour} />
          <WindowCell label="Неделя" fact={account.windows.week} />
        </div>
      </div>

      <div className="ml-[46px] max-w-[720px] text-[11.5px] leading-[1.5] text-tx2">
        Живёт на машине «{machineTitle}»
        {riders.length > 0 ? ` · работники: ${riders.join(', ')}` : ' · пока ни один работник его не занимает'}
        {account.dayPriorityOwner ? ' · днём работники его не трогают' : ''}
      </div>
    </div>
  )
}
