import { STATE_WORD } from './units'
import type { UnitState, WorkUnit } from './units'

/**
 * tone — цвет и лента единицы работы, записанные ОДИН раз на весь экран задач.
 *
 * Строка списка и карточка столбика показывают одну и ту же единицу двумя способами. Пока
 * таблица цветов стояла внутри строки, у карточки был только один путь — завести свою копию,
 * и первый же правленый оттенок разошёлся бы между двумя видами одной работы. Расхождение
 * цвета читается как расхождение состояния, а его никто не измерял.
 *
 * Цвет здесь никогда не единственный носитель: у каждого состояния есть своё слово
 * (`STATE_WORD`), и лента подписана им же.
 */

/** Тон каждого состояния — точка, отрезок ленты и слово читают его отсюда. */
export const TONE: Record<UnitState, { dot: string; seg: string; word: string }> = {
  run: { dot: 'bg-blue', seg: 'bg-blue', word: 'text-blue' },
  dec: { dot: 'bg-warn', seg: 'bg-warn', word: 'text-warn-tx' },
  ok: { dot: 'bg-green', seg: 'bg-green', word: 'text-ok-tx' },
  wait: { dot: 'bg-tx3', seg: '', word: 'text-tx3' },
  fail: { dot: 'bg-err', seg: 'bg-err', word: 'text-err-tx' },
  // Два слова владельца — приглушённые: решение человека закрывает кусок или сборку, но не
  // объявляет их ни сделанными, ни сломанными. Цвет здесь молчит, а слово говорит.
  skip: { dot: 'bg-tx3', seg: 'bg-bd2', word: 'text-tx3' },
  off: { dot: 'bg-tx3', seg: 'bg-bd2', word: 'text-tx3' },
}

export const KIND_TONE: Record<WorkUnit['kind'], string> = {
  inline: 'border-blue/25 bg-blue-s text-blue',
  batch: 'border-violet/25 bg-violet-s text-violet',
  phase: 'border-bd2 bg-surf text-teal',
}

/** The step ribbon. A segment nothing measured is an outline, never a filled block. */
export function Ribbon({ segs }: { segs: UnitState[] }) {
  if (segs.length === 0) return null
  return (
    <div className="flex h-2 items-stretch gap-[3px]">
      {segs.map((s, i) => (
        <div
          key={i}
          title={STATE_WORD[s]}
          className={`flex-1 rounded-[2px] ${s === 'wait' ? 'border border-dashed border-bd2' : TONE[s].seg}`}
        />
      ))}
    </div>
  )
}
