/**
 * SpendTable — where a day's work went, in one small table.
 *
 * It renders rows and nothing else: which lanes exist, and which of them is the
 * conversation, is decided once by the screen and handed here already grouped. A table that
 * re-derived its own rows would be a second opinion about the same day.
 *
 * Two figures per row, because two figures are true. Tokens are what every session books,
 * subscription or not — they are how work done on a plan is visible at all. Euros are the
 * paid fallback only, so a row that cost nothing says «по подписке» instead of «0 €»: a zero
 * in a money column reads as «free», and the plan is not free, it is already paid for.
 */

export interface SpendRow {
  key: string
  label: string
  /** A quiet second line — what the row is, when the label alone does not say it. */
  note?: string
  tokens: number
  eur: number
  /** The conversation's own line, which the screen sets apart from the working lanes. */
  conversation?: boolean
}

/** A count a person can read at a glance — thin spaces between thousands, as Russian sets them. */
export function formatTokens(n: number): string {
  return Math.round(Math.max(0, n)).toLocaleString('ru-RU')
}

/** Money, to the cent, with the sign a person expects after it. */
export function formatEur(n: number): string {
  return `${Math.max(0, n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

export function SpendTable({ title, rows, empty }: { title: string; rows: SpendRow[]; empty: string }) {
  const tokens = rows.reduce((sum, r) => sum + r.tokens, 0)
  const eur = rows.reduce((sum, r) => sum + r.eur, 0)

  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <h2 className="m-0 mb-4 text-[14px] font-semibold text-tx">{title}</h2>

      {rows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-tx3">{empty}</p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_160px_140px] gap-4 border-b border-bd pb-2.5">
            <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Источник</span>
            <span className="text-right text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Токены</span>
            <span className="text-right text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Деньги</span>
          </div>

          {rows.map((r) => (
            <div
              key={r.key}
              className="grid grid-cols-[minmax(0,1fr)_160px_140px] items-center gap-4 border-b border-bd py-3"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className={`truncate text-[13px] ${r.conversation ? 'font-semibold text-tx' : 'text-tx'}`}>
                    {r.label}
                  </span>
                  {r.conversation ? (
                    <span className="flex-none rounded-full bg-blue-s px-2 py-0.5 text-[10.5px] text-blue">
                      вне очереди
                    </span>
                  ) : null}
                </span>
                {r.note ? <span className="truncate text-[11.5px] text-tx3">{r.note}</span> : null}
              </span>
              <span className="text-right text-[13px] text-tx tabular-nums">{formatTokens(r.tokens)}</span>
              <span className="text-right text-[13px] tabular-nums">
                {r.eur > 0 ? (
                  <span className="text-tx">{formatEur(r.eur)}</span>
                ) : (
                  <span className="text-tx3">по подписке</span>
                )}
              </span>
            </div>
          ))}

          <div className="grid grid-cols-[minmax(0,1fr)_160px_140px] items-center gap-4 pt-3">
            <span className="text-[12.5px] text-tx2">Всего за день</span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">{formatTokens(tokens)}</span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">
              {eur > 0 ? formatEur(eur) : <span className="font-normal text-tx3">по подписке</span>}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
