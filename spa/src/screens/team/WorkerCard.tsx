import type { Presence, WindowFact, WorkerRow } from '../../api/types'
import { WINDOW_UNKNOWN_HINT, accentFor, initialOf, windowWords } from '../../shell/format'

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
 * So there is no «if the window is this full and there is a task then…» anywhere on this
 * screen. The card renders a string and paints a dot for it.
 *
 * THE TWO FIGURES OBEY THE SAME LAW NOW. «Сделано / не получилось» used to be counted on the
 * screen out of the finished rows the reading still carried — a capped «за ночь» list — so they
 * answered «how much of what is still on screen belongs to this one», moved when the list moved,
 * and read as zero for a worker whose work had scrolled out of it. The daemon now counts them
 * from the attempt ledger over an explicit window (front/worker-stats.mjs) and this card prints
 * the answer with the period NAMED beside it: a number without its denominator is not a
 * statistic. Where the ledger could not be read the card says «нет данных» — a zero would be a
 * measurement, and no measurement was made.
 *
 * AND AN EMPTY PERIOD IS SAID IN WORDS TOO. A ledger that was read but holds nothing concluded
 * for this worker prints «завершённых попыток не было», not «сделано: 0 · не получилось: 0».
 * The pair of zeros is a confident-looking figure, and a person reads confidence into it — the
 * two states it would flatten together («ничего не завершилось» and «мы ничего не смогли
 * посчитать») are different answers, and the screen owes both of them their own words.
 *
 * THE WINDOW LINES ARE WORDS, NOT BARS. The provider says whether a window is still allowing
 * work and when it resets — it does not say how full it is. The two bars that used to stand
 * here were filled from this daemon's own token count against an invented capacity, so they
 * read near zero on a subscription a person had nearly spent in his own terminal, and a zero
 * bar is read as «free». A window nothing has been heard about now says «нет данных».
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

/** One window: its name, and what the provider last said about it. */
function WindowLine({ label, fact, override }: { label: string; fact: WindowFact | undefined; override?: string }) {
  const words = windowWords(fact)
  const text = override ?? words.text
  const unknown = !override && fact?.status !== 'open' && fact?.status !== 'exhausted'
  return (
    <div className="min-w-0 flex-1" title={unknown ? WINDOW_UNKNOWN_HINT : undefined}>
      <div className="mb-1 text-[10.5px] whitespace-nowrap text-tx3">{label}</div>
      <div className="flex items-center gap-[5px]">
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${override ? 'bg-warn' : words.dot}`} />
        <span className={`truncate text-[10.5px] ${!override && words.muted ? 'text-tx3' : 'text-tx2'}`}>{text}</span>
      </div>
    </div>
  )
}

export function WorkerCard({
  worker,
  laneLabel,
  taskTitle,
  stats,
  onOpenTask,
}: {
  worker: WorkerRow
  /** The worker's line of work, in the words the rest of the window uses for it. */
  laneLabel: string | null
  /** The title of the task in hand, when the reading still carries that row. */
  taskTitle: string | null
  /**
   * Что этот работник сделал ЗА ПЕРИОД — как посчитал демон, из леджера попыток. `null`, когда
   * леджер прочитать не удалось: тогда карточка говорит «нет данных» вместо нулей, потому что
   * ноль здесь читается как «этот ничего не сделал», а это утверждение, а не отсутствие ответа.
   */
  stats: { done: number; failed: number } | null
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
        <WindowLine
          label="Окно (5 ч)"
          fact={win.fiveHour}
          override={closed ? `откроется к ${clockOf(win.closedUntil as string)}` : undefined}
        />
        <WindowLine label="Неделя" fact={win.week} />
      </div>

      <div className="border-t border-bd pt-3 text-[11.5px] text-tx2">
        <div className="mb-1 text-[10.5px] text-tx3">за 30 дней</div>
        {stats === null ? (
          <div className="text-tx3">нет данных</div>
        ) : stats.done + stats.failed === 0 ? (
          <div className="text-tx3">завершённых попыток не было</div>
        ) : (
          <div className="tabular-nums">
            сделано: <span className="font-semibold text-ok-tx">{stats.done}</span> · не получилось:{' '}
            <span className={stats.failed > 0 ? 'font-semibold text-err-tx' : 'font-semibold text-tx2'}>
              {stats.failed}
            </span>
          </div>
        )}
      </div>

      <div className="text-[10.5px] text-tx3">
        {laneLabel ? `${laneLabel} · ` : ''}
        {worker.account}
      </div>
    </article>
  )
}
