import type { Kpis, SpendAccount, WindowFact } from '../../api/types'
import {
  WINDOW_STALE_HINT,
  WINDOW_UNKNOWN_HINT,
  plural,
  readingAgeWords,
  readingIsStale,
  windowWords,
} from '../../shell/format'
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
 * and when it resets, and — in the unified block of its own rate-limit frames — how much of it
 * is spent. The percentage that used to stand here was a different animal: it was worked out
 * from this daemon's own token count, near zero on a subscription a person had nearly spent in
 * his own terminal. This one is the provider's own number, and it never stands without the hour
 * it was measured at, because that is the difference between the two.
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

/**
 * One window, said in the words the whole product uses for it — WITH THE HOUR IT WAS MEASURED.
 *
 * «Сегодня» — первый экран, который человек открывает утром, и до сих пор он был единственным
 * местом, где окно говорило только состояние. Процент поставщика сюда не доезжал вовсе, а
 * состояние без даты читается как сегодняшнее: «принимает работу», снятое вчера вечером, стоит
 * здесь тем же тоном, что и снятое минуту назад. Число и его час приходят вместе или не
 * приходят вовсе — это одно утверждение, разорванное на два, и разрывать его нельзя.
 */
function WindowLine({ label, fact }: { label: string; fact: WindowFact | undefined }) {
  const words = windowWords(fact)
  const unknown = fact?.status !== 'open' && fact?.status !== 'exhausted'
  const age = unknown ? null : readingAgeWords(fact?.observedAt)
  const stale = !unknown && readingIsStale(fact?.observedAt)
  return (
    <div
      className="flex items-baseline justify-between gap-3"
      title={unknown ? WINDOW_UNKNOWN_HINT : stale ? WINDOW_STALE_HINT : undefined}
    >
      <span className="flex-none text-[12px] text-tx2">{label}</span>
      <span className="flex min-w-0 items-center gap-[6px]">
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${words.dot}`} />
        <span className={`truncate text-[12px] ${words.muted ? 'text-tx3' : 'text-tx'}`}>{words.text}</span>
        {typeof fact?.pct === 'number' ? (
          <span className="flex-none text-[11.5px] text-tx3 tabular-nums">{Math.round(fact.pct)}%</span>
        ) : null}
        {age ? (
          <span className={`flex-none text-[11px] whitespace-nowrap ${stale ? 'text-warn-tx' : 'text-tx3'}`}>
            · {age}
            {stale ? ' · устарело' : ''}
          </span>
        ) : null}
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
  /**
   * ОТВЕТИЛА ЛИ ДВЕРЬ ХОТЬ РАЗ — и до этого мгновения здесь не стоит ни одной цифры.
   *
   * `kpis === undefined` — это ровно «чтение ещё не вернулось». Пока его нет, каждое из пяти
   * чисел печаталось нулём: «Работают 0 / 0», «В очереди 0», «Ждут решения 0». Основатель
   * читал это при ЧЕТЫРЁХ работающих работниках и ТРИДЦАТИ ПЯТИ работах в очереди — дверь в
   * тот день отвечала 33 секунды, и все 33 секунды экран уверенно сообщал ему нули. Ноль —
   * это измерение; «не спрашивали» — молчание, и разница между ними здесь стоит человеку
   * доверия к экрану целиком.
   *
   * Прочерк, а не пустое место: пять клеток стоят на своих местах и не двигают соседей, когда
   * первый ответ наконец придёт.
   */
  const answered = kpis !== undefined
  const UNKNOWN = '—'
  const busy = kpis?.workersBusy ?? 0
  const total = kpis?.workersTotal ?? 0
  const queued = kpis?.queued ?? 0
  const awaiting = kpis?.awaitingApproval ?? 0
  // СБОРКА, ЖДУЩАЯ ВЫБОРА, — СВОЁ ЧИСЛО. Раньше её здесь не было вовсе: ждущее состояние
  // сборки не попадало ни в один счётчик и было видно только на её собственной карточке.
  const stalledBatches = kpis?.batchesAwaitingDecision ?? 0
  const longestStall = elapsedLabel(stalledSince, Date.now())
  const windowsOpen = kpis?.windowsOpen ?? 0
  const reading = answered ? undefined : 'читаю…'

  return (
    <section className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-[18px]">
      <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
        <div className="mb-4 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">День в цифрах</div>
        <div className="grid grid-cols-5 gap-4">
          <Figure
            label="Работают"
            value={answered ? `${busy} / ${total}` : UNKNOWN}
            note={answered ? (total > 0 ? `свободны ${Math.max(0, total - busy)}` : undefined) : reading}
          />
          <Figure label="В очереди" value={answered ? String(queued) : UNKNOWN} note={reading} />
          <Figure label="Ждут решения" value={answered ? String(awaiting) : UNKNOWN} note={reading} />
          <Figure
            label="Сборки встали"
            value={answered ? String(stalledBatches) : UNKNOWN}
            // ПРОСТОЙ ЧИСЛОМ И В СЧЁТЧИКАХ ТОЖЕ: «1» не отличает сборку, вставшую минуту назад,
            // от сборки, простоявшей ночь, а решение человек принимает как раз по этой разнице.
            note={
              answered
                ? stalledBatches > 0
                  ? (longestStall ? `дольше всех — ${longestStall}` : 'ждут вашего выбора')
                  : undefined
                : reading
            }
          />
          <Figure
            label="Открыты окна"
            value={answered ? String(windowsOpen) : UNKNOWN}
            note={
              answered
                ? `${windowsOpen} ${plural(windowsOpen, 'окно принимает работу', 'окна принимают работу', 'окон принимают работу')}`
                : reading
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-3.5 rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
        <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Окна подписок</div>
        {!answered ? (
          // «Ни одно окно не заведено» — приговор, и до первого ответа его выносить не из чего.
          <p className="m-0 text-[12.5px] text-tx3">Читаю окна подписок…</p>
        ) : accounts.length === 0 ? (
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
