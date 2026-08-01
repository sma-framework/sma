import type { MemoryTagCount } from '../../api/types'
import { plural } from '../../shell/format'

/**
 * TagCloud — what the corpus is ABOUT, and how much of it is about each thing.
 *
 * The tags are the only map of the corpus a person gets without opening a single note, so
 * they are drawn in the order the reading gives them (commonest first) and each one carries
 * its count. A tag with one note looks exactly like a tag with forty, minus the number: the
 * weight is in the figure, never in a font size a person has to compare by eye.
 */
export function TagCloud({ tags }: { tags: MemoryTagCount[] }) {
  if (tags.length === 0) {
    return (
      <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
        Ни одна запись пока не помечена темой. Темы появляются сами, когда заметок становится
        больше одной.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-2 px-[18px] py-4">
      {tags.map(({ tag, count }) => (
        <span
          key={tag}
          className="flex items-baseline gap-2 rounded-full border border-bd bg-surf px-3 py-[5px]"
          title={`${count} ${plural(count, 'запись', 'записи', 'записей')}`}
        >
          <span className="text-[12px] text-tx">{tag}</span>
          <span className="text-[11px] text-tx3 tabular-nums">{count}</span>
        </span>
      ))}
    </div>
  )
}
