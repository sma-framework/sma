import type { Kpis, SpendAccount, WindowFact } from '../../api/types'
import { WINDOW_UNKNOWN_HINT, plural, windowWords } from '../../shell/format'
import { formatEur } from '../costs/SpendTable'

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
 * ONE money figure stands here, and it is the day's paid spend. The owner asks what today
 * cost regularly, and «Расходы» is not the screen he opens every morning — a number he has to
 * go looking for is a number he learns about late. The old rule that kept money off this
 * strip was really a rule against COUNTING it twice, and that rule is untouched: this figure
 * is `kpis.spentTodayEur` — the reading's own, the same euros «Расходы» prints in its header,
 * from one derive on the daemon's side. Nothing is added up here.
 *
 * What stays on «Расходы» is everything the day does not answer: the month, the ceiling, the
 * history, and where the work went. This strip says how much, not what of.
 */

/**
 * Одна цифра дня. Под подпись отведены ДВЕ строки всегда, даже когда она умещается в одну:
 * с пятью колонками в половине ширины длинная подпись переносится, и без этого запаса её
 * число уезжает вниз относительно соседних — читается это как разнобой, а не как перенос.
 */
function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="min-h-[26px] text-[11.5px] leading-[13px] text-tx3">{label}</span>
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

export function KpiStrip({ kpis, accounts }: { kpis: Kpis | undefined; accounts: SpendAccount[] }) {
  const busy = kpis?.workersBusy ?? 0
  const total = kpis?.workersTotal ?? 0
  const queued = kpis?.queued ?? 0
  const awaiting = kpis?.awaitingApproval ?? 0
  const windowsOpen = kpis?.windowsOpen ?? 0
  // Расход за сегодня — ЧИСЛО ЧТЕНИЯ, а не сумма, сложенная здесь: то же самое, что «Расходы»
  // печатают в своей шапке. Ноль тут — честное измерение («платный канал сегодня молчал»), а не
  // молчание: демон считает этот день всегда, даже когда за него не платили ни разу.
  const spentToday = kpis?.spentTodayEur ?? 0

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
            label="Открыты окна"
            value={String(windowsOpen)}
            note={`${windowsOpen} ${plural(windowsOpen, 'окно принимает работу', 'окна принимают работу', 'окон принимают работу')}`}
          />
          <Figure
            label="Расход за сегодня"
            value={formatEur(spentToday)}
            note={spentToday > 0 ? 'платный канал, сверх подписок' : 'платный канал молчал'}
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
