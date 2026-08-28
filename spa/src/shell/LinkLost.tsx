import { useStateQuery } from '../api/queries'
import { linkLost, linkWords } from './link-state'

/**
 * LinkLost — полоса, которая говорит человеку, что окно перед ним больше не живое.
 *
 * ═══════════════ ПОЧЕМУ ЭТО ПОЛОСА, А НЕ ЭКРАН ═══════════════
 *
 * Страница остаётся целой: последняя картина на месте, кнопки нажимаются, таймеры идут. Гасить
 * всё это было бы честно, но дорого — человек теряет и то, что успел прочитать. Поэтому окно не
 * прячет прошлое, а НАЗЫВАЕТ его прошлым: полоса стоит над всем содержимым, до первого экрана, и
 * несёт четыре предложения, включая то, которого на экране нет, — что бот молчит по той же
 * причине.
 *
 * ═══════════════ ОНА ЧИТАЕТ ТУ ЖЕ ОДНУ КАРТИНУ ═══════════════
 *
 * Никакого своего опроса и никакой своей двери: та же `useStateQuery`, что и у всех остальных.
 * Второй опрос «а живы ли мы» был бы вторым мнением о связи — и разошёлся бы с первым ровно в
 * тот момент, ради которого писался. Решение и слова живут в `link-state.ts` чистыми функциями,
 * потому что доказывать их приходится сьютом, а не глазами.
 *
 * `role="alert"` — не украшение: человек, читающий экран голосом, узнаёт о потере связи в тот же
 * момент, что и человек, смотрящий на него.
 */
export function LinkLost({ pad = 'px-7' }: { pad?: string } = {}) {
  const state = useStateQuery()
  const reading = { isError: state.isError, error: state.error, dataUpdatedAt: state.dataUpdatedAt }
  if (!linkLost(reading)) return null

  const [headline, ...rest] = linkWords(reading)
  return (
    /*
      Отступ приходит ОТ РАМЫ, а не из точки перелома внутри полосы: у стола свои поля, у узкой
      работы свои, и полоса, которая знала бы обе, была бы третьим мнением о ширине экрана.
    */
    <div role="alert" className={`border-b border-err-bd bg-err-s py-3 ${pad}`}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-[1px] text-err-tx">
          ●
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-err-tx">{headline}</div>
          {rest.map((line) => (
            <div key={line} className="mt-1 text-[12.5px] leading-[1.45] text-tx2">
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
