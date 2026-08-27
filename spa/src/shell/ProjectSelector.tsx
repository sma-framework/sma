import { useEffect, useRef, useState } from 'react'
import { isNotReady } from '../api/client'
import { useSelectProject, useStateQuery } from '../api/queries'

/**
 * ProjectSelector — which project the window is looking at.
 *
 * It sits under the mark, at the top of the sidebar, because it governs everything
 * below it. With one project it is simply a label: nothing to choose, nothing to set up,
 * nothing to learn. A second project turns the same label into a list, on its own.
 *
 * «Добавить проект» does not ask for a path. A project appears by installing into its
 * folder, so the answer here is a sentence, not a form.
 */
export function ProjectSelector() {
  const state = useStateQuery()
  const select = useSelectProject()
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const projects = state.data?.projects ?? []
  const activeId = state.data?.activeProject ?? null
  const active = projects.find((p) => p.id === activeId) ?? projects[0] ?? null
  const many = projects.length > 1

  useEffect(() => {
    if (!open && !hint) return
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
        setHint(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open, hint])

  /*
    ПЕРЕКЛЮЧЕНИЕ ВИДНО, ПОКА ОНО ИДЁТ.

    Смена проекта — не мгновенное дело: демон переподписывает наблюдателя на другое дерево,
    и окно перечитывает всё, что от проекта зависит. Раньше об этом не говорилось ничего:
    человек нажимал имя, список закрывался, и окно на несколько секунд просто замирало на
    старых числах (жалоба владельца 27.08 — «переключение занимает время и просто висит, не
    хочу чтобы окно висело 10 секунд»). Теперь сам переключатель на это время называет, куда
    он идёт, и не принимает второго нажатия: ожидание с именем — это работа, а без имени —
    поломка.
  */
  const switchingTo = select.isPending ? (projects.find((p) => p.id === select.variables?.id) ?? null) : null
  const label = switchingTo ? `${switchingTo.name} — открываю…` : active ? active.name : 'Проект не выбран'

  const pick = (id: string) => {
    if (select.isPending) return
    setOpen(false)
    select.mutate(
      { id },
      {
        onError: (err) => {
          // The door is declared but not filled in yet — stay where we are, quietly.
          if (!isNotReady(err)) setHint(false)
        },
      },
    )
  }

  return (
    <div ref={boxRef} className="relative px-3 pb-3.5">
      <button
        type="button"
        onClick={() => many && !select.isPending && setOpen((v) => !v)}
        aria-haspopup={many ? 'listbox' : undefined}
        aria-expanded={many ? open : undefined}
        aria-busy={select.isPending || undefined}
        className={`flex h-10 w-full items-center gap-2.5 rounded-[10px] border border-side-bd bg-side-surf px-[11px] text-left ${
          many && !select.isPending ? 'cursor-pointer hover:border-side-tx3' : 'cursor-default'
        }`}
      >
        <span className="text-[10px] font-semibold tracking-[0.09em] text-side-tx3 uppercase">Проект</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-white">{label}</span>
        {select.isPending ? (
          <span aria-hidden className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-side-tx3 border-t-transparent" />
        ) : many ? (
          <span className="text-[9px] text-side-tx2">▼</span>
        ) : null}
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-3 left-3 top-[46px] z-60 rounded-[10px] border border-side-bd bg-side-menu p-[5px] shadow-menu"
        >
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === active?.id}
              onClick={() => pick(p.id)}
              className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px] font-medium text-side-tx hover:bg-side-hover"
            >
              <span className="w-3 text-[11px] text-green">{p.id === active?.id ? '✓' : ''}</span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-[11px] text-side-tx3">{p.taskCounts.total}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setHint(true)
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px] font-medium text-side-tx2 hover:bg-side-hover"
          >
            <span className="w-3 text-[12px]">+</span>
            <span className="flex-1">Добавить проект</span>
          </button>
        </div>
      ) : null}

      {hint ? (
        <div className="absolute right-3 left-3 top-[46px] z-60 rounded-[10px] border border-side-bd bg-side-menu p-3 text-[12px] leading-relaxed text-side-tx2 shadow-menu">
          Установите SMA в папке нового проекта — он появится здесь сам.
        </div>
      ) : null}
    </div>
  )
}
