import type { StyleExamRow } from '../../api/types'

/**
 * ExamTable — the per-situation breakdown behind the one figure at the top of the screen.
 *
 * ═══════════════════════ NO PERCENTAGES IN THE ROWS ═══════════════════════
 *
 * A row answers one question — did the assistant decide the way the owner decided — and it
 * answers it with a tick or a cross. The arithmetic belongs at the top of the screen and in
 * the summary line under the table; a figure repeated in every row would invite a person to
 * average by eye something that was already counted for them.
 *
 * ═══════════════════ THE BREAKDOWN IS NOT PUBLISHED YET, AND SAYS SO ═══════════════════
 *
 * The exam is sat BLIND: the answer key lives on the machine and no read model opens it, so
 * today the reading carries the score and not the situations behind it. The table therefore
 * has two honest states, and the empty one is not an error — it is the shape of the
 * invariant that protects the exam. When a durable artifact starts carrying the graded
 * pairs, this component draws them without changing a line.
 */
export function ExamTable({ rows }: { rows: StyleExamRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-t border-bd bg-surf px-[18px] py-3.5 text-[11.5px] leading-[1.6] text-tx2">
        Построчный разбор ситуаций окно пока не получает: экзамен сдаётся вслепую — ключ с
        Вашими ответами лежит на машине, и читающая модель его не открывает. Видна оценка, а
        не то, по чему она выставлена.
      </div>
    )
  }

  const matched = rows.filter((r) => r.matched).length

  return (
    <div className="border-t border-bd">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-surf">
            <th className="px-[18px] py-2.5 text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">
              Ситуация
            </th>
            <th className="px-3 py-2.5 text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">
              Ответ помощника
            </th>
            <th className="px-3 py-2.5 text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">
              Ваш ответ
            </th>
            <th className="px-[18px] py-2.5 text-right text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">
              Совпало
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.situation}-${i}`} className="border-t border-bd align-top">
              <td className="px-[18px] py-2.5 text-[12px] leading-[1.5] text-tx">{row.situation}</td>
              <td className="px-3 py-2.5 text-[12px] leading-[1.5] text-tx2">{row.assistant}</td>
              <td className="px-3 py-2.5 text-[12px] leading-[1.5] text-tx2">{row.owner}</td>
              <td className="px-[18px] py-2.5 text-right">
                <span
                  aria-label={row.matched ? 'совпало' : 'разошлось'}
                  className={`inline-flex h-[20px] w-[20px] items-center justify-center rounded-full text-[12px] font-bold ${
                    row.matched ? 'bg-ok-s text-ok-tx' : 'bg-err-s text-err-tx'
                  }`}
                >
                  {row.matched ? '✓' : '✗'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-bd bg-surf px-[18px] py-2.5 text-[11.5px] text-tx2 tabular-nums">
        Совпало {matched} из {rows.length} · расхождений {rows.length - matched}
      </div>
    </div>
  )
}
