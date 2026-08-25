import type { Stat } from './stats'
import { missingWords } from './stats'

/**
 * EntitySummary — ПАРА КАРТОЧЕК ПОД ЗАГОЛОВКОМ СУЩНОСТИ: слева «о чём это», справа «во что
 * обошлось».
 *
 * ═══════════ ПОЧЕМУ ОДНА ПАРА НА ФАЗУ И НА БАТЧ, А НЕ ДВЕ ПОХОЖИЕ ═══════════
 *
 * Владелец принял (25.08) один и тот же вид для обеих сущностей: описание словами и окошко
 * показателей рядом с ним. Две копии этой вёрстки разошлись бы первой же правкой — и разошлись
 * бы молча, потому что человек видит за раз только один из двух экранов. Отличается у них
 * ровно то, что и должно отличаться: слова описания и состав показателей.
 *
 * ═══════════ СТРОКИ-ДУБЛЯ ПОД ЗАГОЛОВКОМ БОЛЬШЕ НЕТ ═══════════
 *
 * Те же числа, написанные и в строке под названием, и в окошке, — это два места, где их
 * придётся править, и одно место, где они однажды разойдутся. Владелец вычеркнул строку
 * (25.08, красным): числа живут в окошке, и только там.
 *
 * ЧИСЛО, КОТОРОГО НЕТ, СТОИТ ПРОЧЕРКОМ И ГОВОРИТ ПОЧЕМУ. Причины собраны из самих показателей
 * (`missingWords`) и напечатаны одной строкой под ними: «—» без объяснения человек читает как
 * поломку экрана, а не как честность.
 */
export function EntitySummary({
  describeTitle,
  text,
  source,
  note,
  stats,
}: {
  /** «Описание фазы» / «Описание батча» — заголовок левой карточки. */
  describeTitle: string
  /** Слова описания — или честное «описания нет», но никогда пустое место. */
  text: string
  /** Откуда эти слова взяты. Отсутствует, когда источник очевиден из самих слов. */
  source?: string | null
  /** Что ещё сказано о состоянии сущности — строка под показателями. */
  note?: string | null
  stats: Stat[]
}) {
  const dashes = missingWords(stats)
  return (
    <div className="flex flex-wrap items-stretch gap-3.5">
      <section className="min-w-[280px] flex-1 rounded-[12px] border border-bd bg-card px-4 py-3 shadow-panel">
        <h2 className="m-0 text-[12px] font-semibold text-tx">{describeTitle}</h2>
        <p className="m-0 mt-1.5 text-[11.5px] leading-[1.55] text-tx2">{text}</p>
        {source ? <p className="m-0 mt-1.5 text-[10.5px] text-tx3">{source}</p> : null}
      </section>

      <section className="w-[420px] min-w-[280px] flex-none rounded-[12px] border border-bd bg-card px-4 py-3 shadow-panel">
        <h2 className="m-0 text-[12px] font-semibold text-tx">Показатели</h2>
        <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5">
          {stats.map((s) => (
            <span
              key={s.key}
              className="flex items-baseline gap-1.5"
              title={s.known ? undefined : (s.why ?? undefined)}
              aria-label={`${s.label}: ${s.known ? s.value : 'не измеряли'}`}
            >
              <span
                className={`font-mono text-[12px] font-semibold tabular-nums ${
                  s.known ? 'text-tx' : 'text-tx3'
                }`}
              >
                {s.value}
              </span>
              <span className="text-[10.5px] text-tx3">{s.label}</span>
            </span>
          ))}
        </div>
        {note ? <p className="m-0 mt-2 text-[10.5px] leading-[1.45] text-tx3">{note}</p> : null}
        {dashes ? <p className="m-0 mt-1.5 text-[10.5px] leading-[1.45] text-tx3">{dashes}</p> : null}
      </section>
    </div>
  )
}
