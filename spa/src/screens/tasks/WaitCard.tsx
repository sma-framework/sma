import { KIND_TONE } from './tone'
import { KIND_WORD } from './units'
import type { WorkUnit } from './units'

/**
 * WaitCard — единица, которая стоит на ЧЕЛОВЕКЕ, янтарной карточкой столбика «ЖДУТ ВАС».
 *
 * ═══════════════════ ПОЛОСА СТАЛА СТОЛБИКОМ, КАРТОЧКА ОСТАЛАСЬ ТОЙ ЖЕ ═══════════════════
 *
 * До 25.08.2026 это была ПОЛОСА над списком: список отвечал «что происходит», а «что ждёт
 * меня» приходилось выносить наверх, иначе вопрос, ждущий 41 минуту, находился прокруткой.
 * Владелец принял макет со столбиками — и у вопроса, ждущего человека, появилось СВОЁ МЕСТО на
 * доске. Полоса не нужна там, где есть столбик: две янтарные площадки об одном и том же учат
 * человека не читать ни одну. Карточка же осталась той самой — возраст, что случилось, что
 * сделать, — потому что менялось место, а не то, о чём она говорит.
 *
 * ═══════════════════════ АКТ ОТКРЫВАЕТСЯ, А НЕ НАЖИМАЕТСЯ ═══════════════════════
 *
 * Здесь НЕТ кнопок решения — ни «одобрить», ни «вернуть», ни «пропустить». Нижняя строка
 * называет, что предстоит решить, но клик по карточке ОТКРЫВАЕТ сущность, где решение видно
 * целиком. Решение, принятое из столбика, принималось бы по одной строке текста, а нажатие
 * клавиши согласием не является.
 *
 * Возраст пишется, только когда он измерен: чтение кладёт его строке, ждущей дольше
 * настроенного терпения, — и «0 мин» здесь был бы измерением, которого не делали.
 */
export function WaitCard({ unit, onOpen }: { unit: WorkUnit; onOpen: (unit: WorkUnit) => void }) {
  const wait = unit.wait
  return (
    <button
      type="button"
      onClick={() => onOpen(unit)}
      aria-label={`${KIND_WORD[unit.kind]} · ${unit.title} · ждёт вас`}
      className="w-full rounded-[8px] border border-warn/40 bg-warn-s px-[11px] py-2.5 text-left hover:border-warn"
    >
      <span className="flex items-center gap-2">
        {wait?.age ? (
          <span className="flex-none text-[10.5px] font-semibold tracking-[0.04em] text-warn-tx tabular-nums">
            {wait.age}
          </span>
        ) : null}
        <span
          className={`inline-block rounded-[4px] border px-[7px] py-[2px] text-[10px] font-semibold tracking-[0.04em] ${KIND_TONE[unit.kind]}`}
        >
          {KIND_WORD[unit.kind]}
        </span>
      </span>

      <span className="mt-1.5 block truncate text-[12.5px] font-semibold leading-[1.3] text-tx">{unit.title}</span>

      {/* ЧТО ждёт — предложением. Слова берутся из проекции единицы (`units.ts`), а там их
          строит то же чтение, что и всё остальное на экране: карточка ничего не досочиняет. */}
      <span className="mt-1 block text-[11px] leading-[1.45] text-tx">{wait?.what ?? unit.next}</span>

      <span className="mt-1.5 block text-[11.5px] font-semibold text-warn-tx">
        {wait?.cta ?? 'Открыть →'}
      </span>
    </button>
  )
}
