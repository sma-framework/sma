import type { Presence, WorkerRow } from '../../api/types'
import { accentFor, initialOf } from '../../shell/format'

/**
 * WorkerCard — one worker, and the honest answer to «can this one take work right now».
 *
 * ══════════════════════ PRESENCE IS READ, NEVER WORKED OUT ═════════════════════
 *
 * The word under the dot comes off the wire exactly as the daemon wrote it. This card does
 * NOT look at the window and the task and decide for itself whether somebody is working:
 * that derivation lives in one place, on the daemon's side, and a second copy of it here
 * would be a second opinion — the two would drift, and a roster that argues with itself
 * about who is busy is worse than no roster.
 *
 * So there is no `window.pct5h > 0 && task ? …` anywhere on this screen. The card renders a
 * string and paints a dot for it.
 *
 * The window bars say «оценка» when the reading says the figure is estimated. A percentage
 * that might be a guess and does not say so is the most expensive kind of small lie on an
 * operator's screen.
 */

/** A colour for each of the three words. The word itself always comes from the payload. */
const PRESENCE_DOT: Record<Presence, string> = {
  работает: 'bg-green',
  'ждёт окно': 'bg-warn',
  свободен: 'bg-tx3',
}

/** How long ago the running task last showed a sign of life. */
function pulseLabel(sec: number | undefined): string {
  if (sec === undefined) return ''
  if (sec < 90) return `${sec} с`
  if (sec < 3600) return `${Math.round(sec / 60)} мин`
  return `${Math.round(sec / 3600)} ч`
}

/** The clock face of a moment, in the reader's own time. */
function clockOf(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function Bar({ label, pct, value, color }: { label: string; pct: number; value: string; color: string }) {
  const safe = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex justify-between gap-1.5">
        <span className="text-[10.5px] whitespace-nowrap text-tx3">{label}</span>
        <span className="truncate text-[10.5px] text-tx2 tabular-nums">{value}</span>
      </div>
      <div
        className="h-1 rounded-sm bg-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-1 rounded-sm ${color}`} style={{ width: `${safe}%` }} />
      </div>
    </div>
  )
}

export function WorkerCard({
  worker,
  laneLabel,
  taskTitle,
  doneCount,
  failedCount,
  onOpenTask,
}: {
  worker: WorkerRow
  /** The worker's line of work, in the words the rest of the window uses for it. */
  laneLabel: string | null
  /** The title of the task in hand, when the reading still carries that row. */
  taskTitle: string | null
  doneCount: number
  failedCount: number
  onOpenTask: (taskId: string) => void
}) {
  const win = worker.window
  const closed = !!win.closedUntil
  const pulse = pulseLabel(worker.pulseAgeSec)

  return (
    <article className="flex flex-col gap-3.5 rounded-[13px] border border-bd bg-card p-[18px] shadow-panel">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`flex h-[19px] w-[19px] flex-none items-center justify-center rounded-md text-[9.5px] font-bold ${accentFor(
              worker.lane ?? worker.id,
            )}`}
          >
            {initialOf(worker.id)}
          </span>
          <span className="truncate text-[13.5px] font-semibold text-tx">{worker.id}</span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <span aria-hidden className={`h-[7px] w-[7px] flex-none rounded-full ${PRESENCE_DOT[worker.presence]}`} />
          <span className="text-[11px] whitespace-nowrap text-tx2">{worker.presence}</span>
          {pulse ? <span className="text-[10.5px] whitespace-nowrap text-tx3 tabular-nums">{pulse}</span> : null}
        </div>
      </header>

      <div className="min-h-[36px] text-[12.5px] leading-[1.45]">
        {worker.taskId ? (
          <button
            type="button"
            onClick={() => onOpenTask(worker.taskId as string)}
            className="text-left text-tx hover:text-blue"
          >
            {taskTitle ?? worker.taskId}
          </button>
        ) : (
          <span className="text-tx2">Задачи в работе нет.</span>
        )}
      </div>

      <div className="flex items-start gap-4">
        <Bar
          label="Окно"
          pct={closed ? 0 : win.pct5h}
          value={closed ? `откроется к ${clockOf(win.closedUntil as string)}` : `${Math.round(win.pct5h)}%`}
          color="bg-blue"
        />
        <Bar label="Неделя" pct={win.pctWeek} value={`${Math.round(win.pctWeek)}%`} color="bg-teal" />
      </div>

      {win.estimated ? (
        <p className="m-0 -mt-1 text-[10.5px] text-tx3">
          <span className="rounded-full bg-idle-s px-2 py-px text-idle-tx">оценка</span> — окна считаются по расходу,
          точную цифру даёт подписка.
        </p>
      ) : null}

      <div className="border-t border-bd pt-3 text-[11.5px] text-tx2 tabular-nums">
        сделано: <span className="font-semibold text-ok-tx">{doneCount}</span> · не получилось:{' '}
        <span className={failedCount > 0 ? 'font-semibold text-err-tx' : 'font-semibold text-tx2'}>{failedCount}</span>
      </div>

      <div className="text-[10.5px] text-tx3">
        {laneLabel ? `${laneLabel} · ` : ''}
        {worker.account}
      </div>
    </article>
  )
}
