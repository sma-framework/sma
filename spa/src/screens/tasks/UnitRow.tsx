import { KIND_TONE, Ribbon, TONE } from './tone'
import { KIND_WORD, STATE_WORD } from './units'
import type { WorkUnit } from './units'

/**
 * UnitRow — one unit of work as one line, in the shape the accepted design gives it:
 * what KIND it is, what it is called, how far it got, what happens next, how long it took.
 *
 * The line is read left to right the way a person asks about work: «что это» → «что это
 * такое» → «сколько пройдено» → «что дальше» → «сколько идёт». The one column that changes
 * colour is the one that carries a person's own name on it: a unit waiting for a decision
 * lifts the whole row into the warning tone, because a row that waits on you must not look
 * like a row that is quietly working.
 *
 * Colour is never the only carrier: every state also has its word (`STATE_WORD`), and the
 * dot before the title is a pulse only while the work actually moves.
 *
 * Пульс читается по отдельному признаку строки, а не по её слову: «Идёт» у фазы означает
 * «начата и не закончена», и пульсирующая точка на фазе, где сейчас не запущена ни одна
 * стадия, обещала бы движение, которого нет.
 */

export function UnitRow({
  unit,
  first,
  onOpen,
}: {
  unit: WorkUnit
  first: boolean
  onOpen: (unit: WorkUnit) => void
}) {
  const tone = TONE[unit.state]
  const waiting = unit.state === 'dec'
  return (
    <button
      type="button"
      onClick={() => onOpen(unit)}
      aria-label={`${KIND_WORD[unit.kind]} · ${unit.title} · ${STATE_WORD[unit.state]}`}
      className={`flex w-full items-center gap-0 px-4 py-3.5 text-left hover:bg-row-hover ${
        first ? '' : 'border-t border-bd'
      } ${waiting ? 'bg-warn-s' : ''}`}
    >
      <span className="w-[74px] flex-none">
        <span
          className={`inline-block rounded-[4px] border px-[7px] py-[2px] text-[10px] font-semibold tracking-[0.04em] ${KIND_TONE[unit.kind]}`}
        >
          {KIND_WORD[unit.kind]}
        </span>
      </span>

      <span className="min-w-[240px] flex-[1_1_300px] pr-4">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 flex-none rounded-full ${tone.dot} ${unit.live ? 'animate-pulse' : ''}`}
          />
          <span className="truncate text-[13.5px] font-semibold text-tx">{unit.title}</span>
          <span className={`flex-none text-[10.5px] font-semibold ${tone.word}`}>{STATE_WORD[unit.state]}</span>
        </span>
        <span className="mt-1 block text-[11.5px] text-tx2">{unit.inner}</span>
      </span>

      <span className="min-w-[92px] flex-[0_1_150px] pr-4">
        <Ribbon segs={unit.segs} />
      </span>

      <span
        className={`min-w-[200px] flex-[0_1_320px] text-[12px] leading-[1.4] ${waiting ? 'text-warn-tx' : 'text-tx2'}`}
      >
        {unit.next}
      </span>

      <span className="w-[70px] flex-none text-right text-[11.5px] font-medium text-tx2 tabular-nums">{unit.dur}</span>
    </button>
  )
}
