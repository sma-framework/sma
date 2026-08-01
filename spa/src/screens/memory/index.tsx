import { useStateQuery } from '../../api/queries'
import type { MemoryNotePointer } from '../../api/types'
import { plural } from '../../shell/format'
import { TagCloud } from './TagCloud'

/**
 * «Память» — the project's notebook, seen as a surface: how much there is, what it is
 * about, and what was written down recently.
 *
 * ═══════════════════ A SURFACE, NOT A FILE MANAGER, AND NOT A WINDOW ═══════════════════
 *
 * The reading carries a note's NAME and never its body, and this screen is built around
 * that on purpose. A row here is a pointer: it says a lesson exists and what it is called,
 * and it stops there. Clicking it opens nothing, because there is nothing to open — the
 * full text lives in the project's notebook, where a terminal reads it with the whole
 * loader behind it. The alternative would have been a payload that copies the memory tree
 * off the machine every few seconds so that one screen could show a paragraph nobody asked
 * for. The honest boundary is drawn in words under the list, not hidden behind a dead link.
 *
 * ═════════════════════════ WHAT THE CORPUS COSTS TO CARRY ═════════════════════════
 *
 * Two figures are worth a person's attention and both are here: how many lessons the team
 * has accumulated, and how big the always-loaded index is — the part every worker reads
 * before it starts. The second is the one that grows quietly and eventually has to be
 * pruned, so it is shown as a size, in the same place, every day.
 *
 * ══════════════════════════ NOTHING LEAVES THE HOUSEHOLD ══════════════════════════
 *
 * The corpus lives inside the project and travels with it to the owner's own machines. No
 * third-party service holds a copy, and the line at the bottom of the screen says so.
 */

/** A byte count in the words a person reads without translating. */
function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} Б`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`
  return `${(kb / 1024).toFixed(1)} МБ`
}

function Pill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className="text-[16px] font-bold text-tx tabular-nums">{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

function CardHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
      {note ? <span className="text-[11px] text-tx3 tabular-nums">{note}</span> : null}
    </div>
  )
}

/** One kind of thing the notebook holds: a figure, and what that figure means. */
function StoreRow({
  letter,
  tone,
  title,
  value,
  desc,
  first,
}: {
  letter: string
  tone: string
  title: string
  value: string
  desc: string
  first: boolean
}) {
  return (
    <div className={`flex flex-col gap-2 px-[18px] py-[15px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[13px] font-bold ${tone}`}
        >
          {letter}
        </span>
        <span className="flex-none text-[13.5px] font-semibold whitespace-nowrap text-tx">{title}</span>
        <div className="flex-1" />
        <span className="flex-none text-[15px] font-bold whitespace-nowrap text-tx tabular-nums">{value}</span>
      </div>
      <div className="ml-[46px] max-w-[720px] text-[11.5px] leading-[1.5] text-tx2">{desc}</div>
    </div>
  )
}

/**
 * A recent lesson, as a POINTER. There is no `onClick` here and that is the design: the row
 * carries a name and a quiet identifier, and the caption under the list says where the full
 * text lives.
 */
function NoteRow({ note, first }: { note: MemoryNotePointer; first: boolean }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-3 px-[18px] py-[11px] ${first ? '' : 'border-t border-bd'}`}>
      <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-blue" />
      <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">{note.title || note.id}</span>
      <span className="max-w-[220px] flex-none truncate text-[11px] text-tx3" title={note.id}>
        {note.id}
      </span>
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const memory = state.data?.memory
  const filled = memory && !memory.absent ? memory : null

  const noteCount = filled?.noteCount ?? 0
  const tags = filled?.tags ?? []
  const recent = filled?.recent ?? []

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Память</h1>
        {filled ? (
          <>
            <Pill value={String(noteCount)} label={plural(noteCount, 'запись', 'записи', 'записей')} />
            <Pill value={String(tags.length)} label={plural(tags.length, 'тема', 'темы', 'тем')} />
            <Pill value={sizeLabel(filled.coreSize)} label="всегда под рукой" />
          </>
        ) : null}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Записная книжка проекта: сколько уроков накоплено, о чём они и что записано недавно.
        </span>
      </div>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            Связь потеряна. Показана записная книжка на момент последнего чтения.
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[900px] flex-col gap-[22px]">
          {filled ? (
            <>
              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="Что хранится" />
                <StoreRow
                  first
                  letter="З"
                  tone="bg-blue-s text-blue"
                  title="Записи проекта"
                  value={String(noteCount)}
                  desc="уроки, решения и устройство проекта: лежат внутри проекта и едут с ним на каждую Вашу машину"
                />
                <StoreRow
                  first={false}
                  letter="О"
                  tone="bg-ok-s text-ok-tx"
                  title="Оглавление"
                  value={sizeLabel(filled.coreSize)}
                  desc="то, что команда читает перед каждой работой: короткая выжимка, а не весь корпус"
                />
              </div>

              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="О чём записи" note={String(tags.length)} />
                <TagCloud tags={tags} />
              </div>

              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="Записано недавно" note={String(recent.length)} />
                {recent.length === 0 ? (
                  <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                    Свежих записей нет — за последнее время команда ничего нового не заносила.
                  </p>
                ) : (
                  recent.map((note, i) => <NoteRow key={note.id} note={note} first={i === 0} />)
                )}
                <div className="border-t border-bd bg-surf px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-tx3">
                  Полный текст — в записной книжке проекта: окно показывает, что записано, и не
                  вычитывает содержимое.
                </div>
              </div>
            </>
          ) : (
            <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
              <CardHead title="Записная книжка" />
              <div className="flex flex-col gap-2 px-[18px] py-5">
                <span className="text-[13px] text-tx">
                  Записная книжка пока пустая — она будет наполняться Вашими уроками.
                </span>
                <span className="max-w-[640px] text-[11.5px] leading-[1.6] text-tx2">
                  Каждый разобранный случай команда записывает сама: ошибка превращается в урок,
                  урок видят все работники, и та же ошибка не повторяется.
                </span>
              </div>
            </div>
          )}

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Ничего не хранится у чужих сервисов. Всё у Вас: корпус лежит внутри проекта и едет с
            ним на Ваши машины.
          </p>
        </div>
      </div>
    </section>
  )
}
