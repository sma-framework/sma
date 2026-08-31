import type { Kpis, SpendAccount, WindowFact } from '../../api/types'
import { WINDOW_UNKNOWN_HINT, plural, windowWords } from '../../shell/format'
import { elapsedLabel } from '../../shell/stats'

/**
 * KpiStrip — the day in figures, and what each subscription window is doing.
 *
 * Two panels, side by side, exactly as the accepted screen puts them: the counts of the
 * work on the left, the windows on the right. The counts are the ones the reading already
 * carries — nothing is added up here, because a number computed twice is a number two
 * screens can disagree about.
 *
 * The windows are words, not bars. The provider says whether a window is still allowing work
 * and when it resets; it does not say how full it is, and the percentage that used to stand
 * here was worked out from this daemon's own token count — near zero on a subscription a
 * person had nearly spent in his own terminal.
 *
 * Money is deliberately absent. Sums belong to «Расходы» and are shown there once; a
 * figure repeated in two places is a figure that will one day contradict itself.
 */

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] text-tx3">{label}</span>
      <span className="text-[19px] leading-none font-semibold text-tx tabular-nums">{value}</span>
      {note ? <span className="text-[11px] text-tx3">{note}</span> : null}
    </div>
  )
}

/** One window, said in the words the whole product uses for it. */
function WindowLine({ label, fact }: { label: string; fact: WindowFact | undefined }) {
  const words = windowWords(fact)
  const unknown = fact?.status !== 'open' && fact?.status !== 'exhausted'
  return (
    <div className="flex items-baseline justify-between gap-3" title={unknown ? WINDOW_UNKNOWN_HINT : undefined}>
      <span className="flex-none text-[12px] text-tx2">{label}</span>
      <span className="flex min-w-0 items-center gap-[6px]">
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${words.dot}`} />
        <span className={`truncate text-[12px] ${words.muted ? 'text-tx3' : 'text-tx'}`}>{words.text}</span>
      </span>
    </div>
  )
}

export function KpiStrip({
  kpis,
  accounts,
  stalledSince,
}: {
  kpis: Kpis | undefined
  accounts: SpendAccount[]
  /**
   * С КАКОГО МОМЕНТА СТОИТ ТА СБОРКА, ЧТО СТОИТ ДОЛЬШЕ ВСЕХ. `null` — не стоит ни одна (или
   * очередь не поставила отметку, и тогда цифра честно молчит вместо бодрого нуля).
   *
   * Приходит ПРОПОМ, а не считается здесь: это та же отметка, по которой лента рисует свои
   * карточки вставших сборок, и второе её вычисление рядом стало бы вторым ответом на вопрос
   * «сколько стоит» — на одном экране, в двадцати сантиметрах друг от друга.
   */
  stalledSince: number | null
}) {
  const busy = kpis?.workersBusy ?? 0
  const total = kpis?.workersTotal ?? 0
  const queued = kpis?.queued ?? 0
  const awaiting = kpis?.awaitingApproval ?? 0
  // СБОРКА, ЖДУЩАЯ ВЫБОРА, — СВОЁ ЧИСЛО. Раньше её здесь не было вовсе: ждущее состояние
  // сборки не попадало ни в один счётчик и было видно только на её собственной карточке.
  const stalledBatches = kpis?.batchesAwaitingDecision ?? 0
  const longestStall = elapsedLabel(stalledSince, Date.now())
  const windowsOpen = kpis?.windowsOpen ?? 0

  return (
    <section className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-[18px]">
      <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
        <div className="mb-4 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">День в цифрах</div>
        <div className="grid grid-cols-5 gap-4">
          <Figure
            label="Работают"
            value={`${busy} / ${total}`}
            note={total > 0 ? `свободны ${Math.max(0, total - busy)}` : undefined}
          />
          <Figure label="В очереди" value={String(queued)} />
          <Figure label="Ждут решения" value={String(awaiting)} />
          <Figure
            label="Сборки встали"
            value={String(stalledBatches)}
            // ПРОСТОЙ ЧИСЛОМ И В СЧЁТЧИКАХ ТОЖЕ: «1» не отличает сборку, вставшую минуту назад,
            // от сборки, простоявшей ночь, а решение человек принимает как раз по этой разнице.
            note={
              stalledBatches > 0
                ? (longestStall ? `дольше всех — ${longestStall}` : 'ждут вашего выбора')
                : undefined
            }
          />
          <Figure
            label="Открыты окна"
            value={String(windowsOpen)}
            note={`${windowsOpen} ${plural(windowsOpen, 'окно принимает работу', 'окна принимают работу', 'окон принимают работу')}`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3.5 rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
        <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Окна подписок</div>
        {accounts.length === 0 ? (
          <p className="m-0 text-[12.5px] text-tx3">Ни одно окно пока не заведено.</p>
        ) : (
          accounts.map((a) => (
            <div key={a.name} className="flex flex-col gap-2">
              <div className="text-[12.5px] font-semibold text-tx">{a.name}</div>
              <WindowLine label="Пять часов" fact={a.fiveHour} />
              <WindowLine label="Неделя" fact={a.week} />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
