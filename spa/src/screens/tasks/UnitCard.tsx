import { KIND_TONE, Ribbon, TONE } from './tone'
import { KIND_WORD, STATE_WORD } from './units'
import type { WorkUnit } from './units'

/**
 * UnitCard — одна единица работы как карточка своего столбика.
 *
 * ═══════════════════════ ИМЯ ЗДЕСЬ МИНИАТЮРНОЕ, И ЭТО РЕШЕНИЕ ═══════════════════════
 *
 * Столбик — узкий, и шесть их. Имя, занявшее в карточке три строки, съедает ровно то, ради
 * чего человек на доску и смотрит: что это, где стоит и что дальше. Поэтому имя стоит одной
 * короткой строкой и обрывается многоточием, а ПОЛНОЕ живёт на странице самой сущности, куда
 * карточка и открывается. Обрыв виден глазом — это честнее, чем ужатый шрифт, по которому не
 * понять, всё ли имя показано. Сам текст при этом никто не режет: в разметке лежит имя
 * целиком, поэтому читалка экрана прочитает его до конца.
 *
 * КАРТОЧКА ОТКРЫВАЕТСЯ, А НЕ НАЖИМАЕТСЯ. Здесь нет ни одной кнопки решения: клик ведёт в
 * сущность, где решение принимают, видя, о чём оно. Столбик показывает, а действует карточка.
 *
 * Цвет и лента читаются из общей таблицы (`tone.tsx`) — той же, из которой их читает строка
 * списка: два вида одной работы не должны спорить о её цвете.
 */
export function UnitCard({ unit, onOpen }: { unit: WorkUnit; onOpen: (unit: WorkUnit) => void }) {
  const tone = TONE[unit.state]
  return (
    <button
      type="button"
      onClick={() => onOpen(unit)}
      aria-label={`${KIND_WORD[unit.kind]} · ${unit.title} · ${STATE_WORD[unit.state]}`}
      className="w-full rounded-[8px] border border-bd bg-card px-[11px] py-2.5 text-left hover:border-blue"
    >
      <span className="flex items-center gap-2">
        <span
          className={`inline-block rounded-[4px] border px-[7px] py-[2px] text-[10px] font-semibold tracking-[0.04em] ${KIND_TONE[unit.kind]}`}
        >
          {KIND_WORD[unit.kind]}
        </span>
        <span
          aria-hidden
          className={`h-1.5 w-1.5 flex-none rounded-full ${tone.dot} ${unit.live ? 'animate-pulse' : ''}`}
        />
        <span className={`flex-none text-[10.5px] font-semibold ${tone.word}`}>{STATE_WORD[unit.state]}</span>
      </span>

      <span className="mt-1.5 block truncate text-[12.5px] font-semibold leading-[1.3] text-tx">{unit.title}</span>
      {/* Длительность приписывается к составу, а не заводит себе колонку: в узком столбике
          колонки нет вовсе, а прочерк «мерить нечего» занял бы место, ничего не сказав. */}
      <span className="mt-0.5 block truncate text-[10.5px] text-tx2">
        {unit.dur === '—' ? unit.inner : `${unit.inner} · ${unit.dur}`}
      </span>

      {unit.segs.length > 0 ? (
        <span className="mt-2 block">
          <Ribbon segs={unit.segs} />
        </span>
      ) : null}

      <span className="mt-1.5 block text-[11px] leading-[1.4] text-tx2">{unit.next}</span>
    </button>
  )
}
