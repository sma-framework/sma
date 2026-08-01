import type { EventFrame, EventName } from '../../api/types'
import { clockLabel } from '../../shell/format'

/**
 * EventRow — one bell, in Russian.
 *
 * A frame carries a NAME and identifiers, never a title and never a message: that is the
 * daemon's own rule about what may travel on the live channel, and this row is where it
 * shows. So a row says what KIND of thing happened and points at where the truth about it
 * is; it never pretends to know the thing itself. Clicking a row opens the screen that reads
 * that truth from the poll.
 *
 * Every value on the glass is a text node in JSX. A frame is data from a socket, and data
 * from a socket is printed, never interpreted.
 */

/**
 * The fourteen bells, in the words a person reads. The type of this table is the daemon's
 * own list of names, so a new kind of bell cannot be added on that side without this side
 * being made to name it — an unnamed event would otherwise arrive as a silent blank row.
 */
export const EVENT_LABEL: Record<EventName, string> = {
  'task.queued': 'Задача поставлена',
  'task.claimed': 'Задачу взяли в работу',
  'task.running': 'Работа пошла',
  'task.awaiting_approval': 'Работа ждёт вашего решения',
  'task.approved': 'Работа принята',
  'task.returned': 'Работу вернули на доработку',
  'task.failed': 'Не получилось',
  'worker.presence': 'Работник сменил занятость',
  'spend.updated': 'Расход обновился',
  'harness.updated': 'Состав помощников изменился',
  'chat.reply': 'Команда ответила в разговоре',
  'machine.presence': 'Машина сменила состояние',
  'project.updated': 'Проект изменился',
  'import.updated': 'Разбор своих помощников продвинулся',
}

/** The mark in the margin: what kind of news this is, at a glance. */
const SIGN: Partial<Record<EventName, { mark: string; tone: string }>> = {
  'task.approved': { mark: '✓', tone: 'text-ok-tx' },
  'task.failed': { mark: '✗', tone: 'text-err-tx' },
  'task.returned': { mark: '↩', tone: 'text-warn-tx' },
  'task.awaiting_approval': { mark: '●', tone: 'text-blue' },
}

export function EventRow({ frame, onOpen }: { frame: EventFrame; onOpen: (frame: EventFrame) => void }) {
  const sign = SIGN[frame.event] ?? { mark: '·', tone: 'text-tx3' }

  // What the frame is ALLOWED to say beyond its name: identifiers and one boolean. Nothing
  // here is a title, a message or an address — the daemon does not put those on the wire.
  const meta: string[] = []
  if (frame.taskId) meta.push(frame.taskId)
  if (frame.workerId) meta.push(frame.workerId)
  if (frame.machineId) meta.push(frame.machineId)
  if (frame.projectId) meta.push(frame.projectId)
  if (typeof frame.online === 'boolean') meta.push(frame.online ? 'на связи' : 'выключена')
  if (typeof frame.count === 'number') meta.push(`${frame.count}`)

  return (
    <button
      type="button"
      onClick={() => onOpen(frame)}
      className="grid w-full cursor-pointer grid-cols-[54px_18px_minmax(0,1fr)] items-baseline gap-3 border-0 border-t border-bd bg-transparent px-[18px] py-2 text-left hover:bg-row-hover"
    >
      <span className="text-[11.5px] text-tx3 tabular-nums">{clockLabel(frame.ts)}</span>
      <span aria-hidden className={`text-[12px] ${sign.tone}`}>
        {sign.mark}
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">{EVENT_LABEL[frame.event]}</span>
        {meta.length > 0 ? (
          <span className="flex-none truncate text-[11.5px] text-tx3">{meta.join(' · ')}</span>
        ) : null}
      </span>
    </button>
  )
}
