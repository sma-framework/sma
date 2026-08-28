import type { SpendAccount } from '../../api/types'
import { WINDOW_UNKNOWN_HINT, clockLabel, windowWords } from '../../shell/format'

/**
 * WindowBars — the subscription windows, first on the screen and first for a reason.
 *
 * The work is paid for by the plans; the paid channel is the exception. So the windows come
 * before any money on this screen: a person who looks at costs is nearly always asking «how
 * much of the plan is left», and only rarely «what did the fallback bill me».
 *
 * ═══════════════ WHY THERE ARE NO BARS IN A COMPONENT CALLED WindowBars ═══════════════
 *
 * There used to be two percentage bars per account, and on a real machine they both read 0%
 * with a small grey «оценка» beside them. The number was this daemon's own token count against
 * an invented per-account capacity — it could only ever see the sessions the daemon itself had
 * spawned, never the ones a person ran in his own terminal, which on this machine is most of
 * them. So the bar sat near zero on a subscription that was nearly spent, and a zero bar is
 * read as «the quota is free»: a confident wrong answer to the one question this section
 * exists to answer.
 *
 * What the provider actually sends, on the work stream, is three facts: which window, whether
 * it is still allowing work, and when it resets. Those three are what stands here now, in
 * words. A window nothing has been heard about says «нет данных» — an empty place, not a zero.
 *
 * Nothing is computed here. Every word comes off the one reading.
 */

/** One window, in the words the whole window uses for it. */
function WindowCell({ label, fact }: { label: string; fact: SpendAccount['fiveHour'] }) {
  const words = windowWords(fact)
  const unknown = fact?.status !== 'open' && fact?.status !== 'exhausted'
  return (
    <span
      className="flex min-w-0 items-center gap-[7px]"
      title={unknown ? WINDOW_UNKNOWN_HINT : undefined}
      aria-label={`${label}: ${words.text}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${words.dot}`} />
      <span className={`truncate text-[12.5px] ${words.muted ? 'text-tx3' : 'text-tx2'}`}>{words.text}</span>
      {typeof fact?.pct === 'number' ? (
        <span className="flex-none text-[12px] text-tx3 tabular-nums">{Math.round(fact.pct)}%</span>
      ) : null}
    </span>
  )
}

export function WindowBars({ accounts }: { accounts: SpendAccount[] }) {
  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <h2 className="m-0 mb-1 text-[14px] font-semibold text-tx">Окна подписок</h2>
      <p className="m-0 mb-4 text-[11.5px] leading-[1.55] text-tx3">
        Поставщик сообщает: какое окно, принимает ли оно работу и когда сбросится. Процент
        израсходованного он присылает не всегда — где его не было, здесь не стоит цифры, а не
        стоит ноль.
      </p>

      {accounts.length === 0 ? (
        <p className="m-0 text-[12.5px] text-tx3">
          Ни одно окно пока не заведено. Аккаунты заводятся в настройках, на «Аккаунтах».
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)] gap-4 border-b border-bd pb-2.5">
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Аккаунт</span>
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Окно (5 ч)</span>
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Неделя</span>
          </div>

          {accounts.map((a) => (
            <div
              key={a.name}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)] items-center gap-4 border-b border-bd py-3.5 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-medium text-tx">{a.name}</span>
                {a.closedUntil ? (
                  <span className="flex-none rounded-full bg-warn-s px-2 py-0.5 text-[10.5px] whitespace-nowrap text-warn-tx">
                    отказ · до {clockLabel(a.closedUntil)}
                  </span>
                ) : null}
              </span>
              <WindowCell label={`${a.name}: окно пяти часов`} fact={a.fiveHour} />
              <WindowCell label={`${a.name}: неделя`} fact={a.week} />
            </div>
          ))}

          <p className="m-0 mt-3.5 text-[11.5px] leading-[1.55] text-tx3">
            Подписки включены в тариф и отдельно не тарифицируются — деньги ниже это только
            запасной канал. Токены ниже — наш собственный счёт: столько прошло через запуски
            этой машины. Окно подписки он не измеряет, потому что не видит того, что Вы
            потратили в своём терминале.
          </p>
        </>
      )}
    </section>
  )
}
