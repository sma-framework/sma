import { useState } from 'react'
import type { AccountEntry, MachineRow as Machine } from '../../api/types'
import { useRemoveMachine } from '../../api/queries'
import { hoursLabel, plural } from '../../shell/format'

/**
 * MachineRow — one machine of the household, as a person needs to see it.
 *
 * ═══════════════════════ PRESENCE, NOT PLUMBING ═══════════════════════
 *
 * A machine is shown by what it is DOING: whether it is answering, what it did today, and
 * how much of its windows is left. Its address is not here — not hidden behind a toggle,
 * not in a title attribute, not in the payload this row is given. The reading carries no
 * peer url by construction, so there is nothing on this screen to leak over a shoulder and
 * nothing for the household network to disclose. Neither is there a map or a network
 * diagram: a person owns machines, not a topology.
 *
 * ═════════════ ONE ACCOUNT LIVES ON EXACTLY ONE MACHINE ═════════════
 *
 * The quiet line under the name is that law, said before it is asked. Machines share their
 * VIEWS of the work and never their credentials, so a subscription is logged in in one
 * place — which is the answer to the commonest question here: why did that account do
 * nothing last night.
 */

/** The three states a machine can be in, in the words the design settled on. */
type Standing = 'online' | 'joining' | 'offline'

/**
 * What a machine's state IS. A peer that has never once answered is «настраивается»: it is
 * written down but has not yet spoken, which is a different thing from a machine that
 * spoke yesterday and is quiet now. The reading tells them apart honestly — a peer never
 * reached carries no last-seen moment at all.
 */
export function standingOf(machine: Machine): Standing {
  if (machine.online) return 'online'
  return machine.lastSeenSec === undefined ? 'joining' : 'offline'
}

const DOT: Record<Standing, string> = {
  online: 'bg-green',
  joining: 'bg-warn',
  offline: 'bg-tx3',
}

const STATE_WORD: Record<Standing, string> = {
  online: 'на связи',
  joining: 'настраивается',
  offline: 'нет связи',
}

/** How long ago a machine last spoke, in words. */
function lastSeenWords(sec: number): string {
  if (sec < 90) return 'был на связи только что'
  if (sec < 3600) {
    const m = Math.round(sec / 60)
    return `был на связи ${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`
  }
  return `был на связи ${hoursLabel(sec / 3600)} назад`
}

/** The accounts bound to this machine, said as the law that binds them. */
function accountsWords(count: number, self: boolean): string {
  if (count === 0) return 'Аккаунтов нет, привязок нет'
  const noun = plural(count, 'аккаунт', 'аккаунта', 'аккаунтов')
  return `${count} ${noun}, ${plural(count, 'привязан', 'привязаны', 'привязаны')} только ${self ? 'сюда' : 'к ней'}`
}

export function MachineRow({
  machine,
  accounts,
  finishedToday,
  busyNow,
  first,
}: {
  machine: Machine
  /** The subscriptions logged in ON this machine — never another machine's. */
  accounts: AccountEntry[]
  finishedToday: number
  busyNow: number
  first: boolean
}) {
  const standing = standingOf(machine)
  const self = machine.role === 'self'
  const reachable = standing === 'online'

  /**
   * The state of this machine's subscriptions, in one line. It used to be «the fullest window»
   * as a percentage — a figure nobody measured, worked out from this daemon's own token count.
   * The provider says whether a window is taking work, not how full it is, so the column
   * counts: how many are refused, and how many nothing has been heard about yet.
   */
  const refused = accounts.filter(
    (a) =>
      !!a.windows.closedUntil ||
      a.windows.fiveHour?.status === 'exhausted' ||
      a.windows.week?.status === 'exhausted',
  ).length
  const heard = accounts.filter(
    (a) => a.windows.fiveHour?.status === 'open' || a.windows.week?.status === 'open',
  ).length

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_150px_220px_190px_120px] items-start gap-4 px-[18px] py-[15px] ${
        first ? '' : 'border-t border-bd'
      }`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${DOT[standing]}`} />
          <span className="min-w-0 truncate text-[13.5px] font-semibold text-tx">{machine.title}</span>
          {self ? (
            <span className="flex-none rounded-full border border-bd2 px-2 py-[2px] text-[10.5px] whitespace-nowrap text-tx3">
              эта машина
            </span>
          ) : null}
        </div>
        <span className="text-[11.5px] text-tx3">{accountsWords(accounts.length, self)}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] text-tx2">{STATE_WORD[standing]}</span>
        {standing === 'joining' ? (
          <span className="text-[11.5px] text-tx3">заработает после подключения</span>
        ) : null}
        {standing === 'offline' && machine.lastSeenSec !== undefined ? (
          <span className="text-[11.5px] text-tx3">{lastSeenWords(machine.lastSeenSec)}</span>
        ) : null}
      </div>

      <div className="text-[12.5px] text-tx2 tabular-nums">
        {reachable ? (
          finishedToday + busyNow === 0 ? (
            <span className="text-tx3">тихо</span>
          ) : (
            <span>
              готово <span className="font-semibold text-tx">{finishedToday}</span> · в работе{' '}
              <span className="font-semibold text-tx">{busyNow}</span>
            </span>
          )
        ) : (
          <span className="text-tx3">связи с этой машиной нет</span>
        )}
      </div>

      <div className="text-[12.5px] text-tx2 tabular-nums">
        {accounts.length === 0 ? (
          <span className="text-tx3">аккаунтов нет</span>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="font-semibold text-tx">
              {refused > 0 ? `${refused} из ${accounts.length} исчерпано` : `${heard} из ${accounts.length} принимают`}
            </span>
            <span className="text-[11.5px] text-tx3">
              {heard === 0 && refused === 0 ? 'об окнах пока ничего не приходило' : 'по словам поставщика'}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-start justify-end">{self ? null : <UnlinkButton machine={machine} />}</div>
    </div>
  )
}

/**
 * ОТВЯЗАТЬ — the door that existed everywhere except on the glass.
 *
 * The route was live and auth-gated, the client function was written, the hook was written —
 * and no screen mounted any of it, so a mistyped or dead machine stayed in the household
 * list forever and the only way out was editing a config file by hand. That is the same
 * defect class as everything else fixed this evening: built, tested, never joined.
 *
 * TWO PRESSES, NEVER ONE. Removing a machine is not undoable from here, so the button asks
 * first and names what will happen. THIS machine has no button at all: a window cannot
 * remove the ground it is standing on.
 */
function UnlinkButton({ machine }: { machine: Machine }) {
  const remove = useRemoveMachine()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (problem) return <span className="text-[11.5px] text-err-tx">{problem}</span>

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="rounded-[8px] border border-bd px-2.5 py-1 text-[11.5px] text-tx3 hover:text-tx2"
      >
        Отвязать
      </button>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="text-[11.5px] text-tx2">Убрать «{machine.title}» из дома?</span>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { id: machine.id },
              {
                onError: () => setProblem('Не отвязалось. Машина осталась в списке.'),
              },
            )
          }
          className="rounded-[8px] border border-bd bg-err-s px-2.5 py-1 text-[11.5px] font-semibold text-err-tx disabled:opacity-60"
        >
          Отвязать
        </button>
        <button
          type="button"
          onClick={() => setAsking(false)}
          className="rounded-[8px] border border-bd px-2.5 py-1 text-[11.5px] text-tx3"
        >
          Отмена
        </button>
      </div>
    </div>
  )
}
