/**
 * Inbox — the band above the list: everything that is stuck on the PERSON, and nothing else.
 *
 * The band exists because the list alone answers «что происходит» but not «что ждёт меня»,
 * and the second question is the one a person opens this screen with. A row here is never a
 * copy of a list row's fate: it is the same unit, said in the one voice that matters — how
 * long it has been waiting, and what it wants.
 *
 * When nothing waits, the band is NOT drawn. An empty inbox that still occupies the top of
 * the screen teaches a person to look past that place, and then the day it fills, they
 * look past it too.
 *
 * НАД ПОЛОСОЙ — СЧЁТЧИК И ВОЗРАСТ САМОГО СТАРОГО ожидания: человек, у которого ждут четыре
 * вещи, спрашивает сначала «сколько и как давно», и только потом читает их по одной. Где
 * возраста нет ни у одной строки, там так и написано словами — счётчик от этого не врёт.
 */

export interface InboxItem {
  id: string
  /** «41 МИН» — how long it has been on the person. Empty when the reading does not carry it. */
  age: string
  text: string
  cta: string
  onOpen: () => void
}

export function Inbox({ items, headline }: { items: InboxItem[]; headline: string }) {
  if (items.length === 0) return null
  return (
    <div className="mb-4 flex flex-col gap-2">
      <span className="text-[11px] font-semibold tracking-[0.06em] text-warn-tx uppercase">{headline}</span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={item.onOpen}
          className="flex items-center gap-3 rounded-[10px] border border-warn/40 bg-warn-s px-3.5 py-2.5 text-left hover:border-warn"
        >
          {item.age ? (
            <span className="flex-none text-[10.5px] font-semibold tracking-[0.04em] text-warn-tx tabular-nums">
              {item.age}
            </span>
          ) : null}
          <span className="flex-1 text-[12.5px] leading-[1.4] text-tx">{item.text}</span>
          <span className="flex-none text-[11.5px] font-semibold text-warn-tx">{item.cta}</span>
        </button>
      ))}
    </div>
  )
}
