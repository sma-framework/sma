import type { SpendAccount, WorkerRow } from '../../api/types'
import { clockLabel } from '../../shell/format'

/**
 * WindowBars — the subscription windows, first on the screen and first for a reason.
 *
 * The work is paid for by the plans; the paid channel is the exception. So the windows come
 * before any money on this screen: a person who looks at costs is nearly always asking «how
 * much of the plan is left», and only rarely «what did the fallback bill me». Putting the
 * euros first would answer the rarer question loudly and the common one in small print.
 *
 * A percentage that was ESTIMATED says so. The daemon marks a window it had to guess at, and
 * that mark is carried onto the glass instead of being quietly rounded away — a figure a
 * person knows is approximate is useful; an approximate figure presented as exact is not.
 *
 * Nothing is computed here. The percentages come from the one reading, and the shut-until
 * moment comes from the window the reading already carries.
 */

/** How the reading describes one account's window, once the two halves are put together. */
interface AccountWindow {
  name: string
  pct5h: number
  pctWeek: number
  estimated: boolean
  closedUntil: string | null
}

/**
 * The window figures live on the spend strip; whether they were estimated, and until when a
 * shut window stays shut, live on the worker riding that account. Both halves come from the
 * SAME reading, so putting them side by side adds no second opinion.
 */
export function accountWindows(accounts: SpendAccount[], workers: WorkerRow[]): AccountWindow[] {
  return accounts.map((a) => {
    const rider = workers.find((w) => w.account === a.name)
    return {
      name: a.name,
      pct5h: a.pct5h,
      pctWeek: a.pctWeek,
      estimated: rider?.window.estimated ?? true,
      closedUntil: rider?.window.closedUntil ?? null,
    }
  })
}

function Bar({ label, pct }: { label: string; pct: number }) {
  const safe = Math.max(0, Math.min(100, Math.round(pct)))
  const tone = safe >= 90 ? 'bg-err' : safe >= 70 ? 'bg-warn' : 'bg-blue'
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${safe}%` }} />
      </div>
      <span className="w-9 flex-none text-right text-[12px] text-tx2 tabular-nums">{safe}%</span>
    </div>
  )
}

/** What a window is doing, said in the words the rest of the window uses. */
function statusOf(w: AccountWindow): { text: string; dot: string } {
  if (w.closedUntil) return { text: `откроется в ${clockLabel(w.closedUntil)}`, dot: 'bg-warn' }
  if (w.pct5h >= 100) return { text: 'окно исчерпано', dot: 'bg-warn' }
  return { text: 'принимает работу', dot: 'bg-green' }
}

export function WindowBars({ windows }: { windows: AccountWindow[] }) {
  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <h2 className="m-0 mb-4 text-[14px] font-semibold text-tx">Окна подписок</h2>

      {windows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-tx3">
          Ни одно окно пока не заведено. Аккаунты заводятся в настройках, на «Аккаунтах».
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_210px_210px_170px] gap-4 border-b border-bd pb-2.5">
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Аккаунт</span>
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Окно (5 ч)</span>
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Неделя</span>
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Статус</span>
          </div>

          {windows.map((w) => {
            const status = statusOf(w)
            return (
              <div
                key={w.name}
                className="grid grid-cols-[minmax(0,1fr)_210px_210px_170px] items-center gap-4 border-b border-bd py-3.5 last:border-b-0"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-tx">{w.name}</span>
                  {w.estimated ? (
                    <span
                      className="flex-none rounded-full bg-idle-s px-2 py-0.5 text-[10.5px] text-idle-tx"
                      title="Точных счётчиков окна нет — процент посчитан по нашим же записям расхода"
                    >
                      оценка
                    </span>
                  ) : null}
                </span>
                <Bar label={`${w.name}: окно пяти часов`} pct={w.pct5h} />
                <Bar label={`${w.name}: неделя`} pct={w.pctWeek} />
                <span className="flex items-center gap-[7px]">
                  <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${status.dot}`} />
                  <span className="text-[12.5px] text-tx2">{status.text}</span>
                </span>
              </div>
            )
          })}

          <p className="m-0 mt-3.5 text-[11.5px] text-tx3">
            Подписки включены в тариф и отдельно не тарифицируются — деньги ниже это только запасной канал.
          </p>
        </>
      )}
    </section>
  )
}
