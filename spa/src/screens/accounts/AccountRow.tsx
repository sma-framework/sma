import type { AccountEntry } from '../../api/types'
import { clockLabel } from '../../shell/format'

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
 * The bars are percentages of a window, never money. A plan is already paid for, so the
 * useful question is how much of it is left; the one euro figure on this screen belongs to
 * the paid channel, which is not a subscription at all.
 *
 * An ESTIMATED percentage says so. The daemon marks a window it had to work out from its own
 * spend records rather than read from a counter, and that mark is carried onto the glass
 * instead of being rounded away into false precision.
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
  if ((a.windows.pct5h ?? 0) >= 100) {
    return { text: 'окно исчерпано', dot: 'bg-warn', tone: 'bg-warn-s text-warn-tx' }
  }
  if (a.dayPriorityOwner) return { text: 'днём · Ваш', dot: 'bg-blue', tone: 'bg-blue-s text-blue' }
  return { text: 'принимает работу', dot: 'bg-green', tone: 'bg-ok-s text-ok-tx' }
}

function Bar({ label, pct, tone }: { label: string; pct: number; tone: string }) {
  const safe = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="w-[176px] flex-none">
      <div className="mb-[5px] flex justify-between">
        <span className="text-[10.5px] text-tx3">{label}</span>
        <span className="text-[10.5px] text-tx2 tabular-nums">{safe}%</span>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full rounded-full ${safe >= 90 ? 'bg-err' : tone}`} style={{ width: `${safe}%` }} />
      </div>
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
  const shut = !!account.windows.closedUntil
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
        {account.windows.estimated ? (
          <span
            className="flex-none rounded-full bg-idle-s px-2 py-0.5 text-[10.5px] text-idle-tx"
            title="Точных счётчиков окна нет — процент посчитан по нашим же записям расхода"
          >
            оценка
          </span>
        ) : null}

        <div className="flex-1" />

        <div className="flex flex-none items-center gap-6">
          {shut ? (
            <div className="w-[176px] flex-none text-[11px] whitespace-nowrap">
              <span className="text-tx3">Окно (5 ч): </span>
              <span className="text-tx2">откроется в {clockLabel(account.windows.closedUntil)}</span>
            </div>
          ) : (
            <Bar label="Окно (5 ч)" pct={account.windows.pct5h} tone="bg-blue" />
          )}
          <Bar label="Неделя" pct={account.windows.pctWeek} tone="bg-teal" />
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
