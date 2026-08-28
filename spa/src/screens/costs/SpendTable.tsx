/**
 * SpendTable — where a day's work went, in one small table.
 *
 * It renders rows and nothing else: which lanes exist, and which of them is the
 * conversation, is decided once by the screen and handed here already grouped. A table that
 * re-derived its own rows would be a second opinion about the same day.
 *
 * ЧЕТЫРЕ ЧИСЛА, А НЕ ОДНА КОЛОНКА «ТОКЕНЫ». Поставщик называет за попытку четыре: вход,
 * выход, чтение кэша и запись кэша. Сложенные в одно число, они отвечают «много» и не
 * отвечают «почему»: день, где миллион прочитан из кэша, и день, где тот же миллион отправлен
 * заново, отличаются в цене в разы и в одной колонке выглядят одинаково.
 *
 * ДВЕ ДЕНЕЖНЫЕ КОЛОНКИ, И ИХ НЕЛЬЗЯ ПУТАТЬ. «Деньги» — настоящие евро платного канала: у
 * строки по подписке их нет, и она так и говорит — «по подписке», потому что ноль в денежной
 * колонке читается как «бесплатно», а план не бесплатен, он уже оплачен. «Как если бы по API»
 * — справочная оценка того же расхода по ценнику платформы: её никто не выставлял и никому не
 * платили. Поэтому она стоит со знаком ≈, приглушена, подписана словом «справочно» и НЕ
 * входит ни в одну сумму настоящих денег.
 */

import type { ReactNode } from 'react'

export interface SpendRow {
  key: string
  label: string
  /** A quiet second line — what the row is, when the label alone does not say it. */
  note?: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  eur: number
  /** «Как если бы по API» — справочная цена по ценнику платформы, не счёт. */
  apiEquivalentEur: number
  /** Токены, чью модель ценник не знает: справочная цена на них молчит, и это видно. */
  unpricedTokens?: number
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

/** Сумма всех четырёх чисел строки — то, чем строки сортируются и меряется день. */
export function rowTokens(r: SpendRow): number {
  return (r.tokensIn ?? 0) + (r.tokensOut ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0)
}

/** Одна колонка сетки на каждое число: источник, четыре счётчика, деньги, справочная цена. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_repeat(4,96px)_110px_128px] gap-3'

function Head({ children }: { children: ReactNode }) {
  return (
    <span className="text-right text-[10px] font-semibold tracking-[0.06em] text-tx3 uppercase">{children}</span>
  )
}

export function SpendTable({ title, rows, empty }: { title: string; rows: SpendRow[]; empty: string }) {
  const tokensIn = rows.reduce((sum, r) => sum + r.tokensIn, 0)
  const tokensOut = rows.reduce((sum, r) => sum + r.tokensOut, 0)
  const cacheRead = rows.reduce((sum, r) => sum + r.cacheRead, 0)
  const cacheWrite = rows.reduce((sum, r) => sum + r.cacheWrite, 0)
  const eur = rows.reduce((sum, r) => sum + r.eur, 0)
  const apiEquivalentEur = rows.reduce((sum, r) => sum + r.apiEquivalentEur, 0)
  const unpriced = rows.reduce((sum, r) => sum + (r.unpricedTokens ?? 0), 0)

  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <h2 className="m-0 mb-4 text-[14px] font-semibold text-tx">{title}</h2>

      {rows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-tx3">{empty}</p>
      ) : (
        <>
          <div className={`${GRID} border-b border-bd pb-2.5`}>
            <span className="text-[10px] font-semibold tracking-[0.06em] text-tx3 uppercase">Источник</span>
            <Head>Вход</Head>
            <Head>Выход</Head>
            <Head>Кэш · чт.</Head>
            <Head>Кэш · зап.</Head>
            <Head>Деньги</Head>
            <Head>Как по API</Head>
          </div>

          {rows.map((r) => (
            <div key={r.key} className={`${GRID} items-center border-b border-bd py-3`}>
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
              <span className="text-right text-[13px] text-tx tabular-nums">{formatTokens(r.tokensIn)}</span>
              <span className="text-right text-[13px] text-tx tabular-nums">{formatTokens(r.tokensOut)}</span>
              <span className="text-right text-[13px] text-tx tabular-nums">{formatTokens(r.cacheRead)}</span>
              <span className="text-right text-[13px] text-tx tabular-nums">{formatTokens(r.cacheWrite)}</span>
              <span className="text-right text-[13px] tabular-nums">
                {r.eur > 0 ? (
                  <span className="text-tx">{formatEur(r.eur)}</span>
                ) : (
                  <span className="text-tx3">по подписке</span>
                )}
              </span>
              <span
                className="text-right text-[13px] text-tx2 tabular-nums"
                title={
                  (r.unpricedTokens ?? 0) > 0
                    ? 'Часть токенов этой строки прошла через модель, которой нет в ценнике, — справочная цена их не считает'
                    : 'Справочно: столько стоил бы этот расход по ценнику платформы. По подписке за него не платили.'
                }
              >
                ≈ {formatEur(r.apiEquivalentEur)}
                {(r.unpricedTokens ?? 0) > 0 ? <span className="text-tx3"> +?</span> : null}
              </span>
            </div>
          ))}

          <div className={`${GRID} items-center pt-3`}>
            <span className="text-[12.5px] text-tx2">Всего за день</span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">{formatTokens(tokensIn)}</span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">{formatTokens(tokensOut)}</span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">{formatTokens(cacheRead)}</span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">
              {formatTokens(cacheWrite)}
            </span>
            <span className="text-right text-[13px] font-semibold text-tx tabular-nums">
              {eur > 0 ? formatEur(eur) : <span className="font-normal text-tx3">по подписке</span>}
            </span>
            <span className="text-right text-[13px] font-semibold text-tx2 tabular-nums">
              ≈ {formatEur(apiEquivalentEur)}
            </span>
          </div>

          {/* Подпись стоит под самой цифрой, а не в справке: колонка, которую можно принять за
              счёт, — это колонка, которую примут за счёт. */}
          <p className="m-0 mt-3 text-[11.5px] leading-[1.55] text-tx3">
            «Как по API» — справочно: столько этот расход стоил бы по ценнику платформы, если бы
            работа шла через API. Работа идёт по подписке, счёта на эти деньги нет, и складывать
            их с колонкой «Деньги» нельзя.
            {unpriced > 0
              ? ` Из них ${formatTokens(unpriced)} токенов прошли через модель вне ценника — на них справочная цена молчит (знак «+?»).`
              : ''}
          </p>
        </>
      )}
    </section>
  )
}
