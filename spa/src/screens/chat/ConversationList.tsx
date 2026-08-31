import { useEffect, useRef, useState } from 'react'
import type { ChatConversation } from '../../api/types'
import { conversationName } from './thread'

/**
 * СПИСОК РАЗГОВОРОВ — то, чего у «Разговора» не было вовсе.
 *
 * ═══════════════════ ПОЧЕМУ ОН ПОЯВИЛСЯ ═══════════════════
 *
 * Слово владельца 31.08: «почему разговор когда открываю у него нет истории? через раз
 * появляется, может нам разбить разговор на разные чаты? И те которые в процессе условно
 * выполняют что-то, тогда они активные как и в chatgpt». Замер объяснил «через раз» числом:
 * в книге лежало 50 реплик, разложенных по ПЯТНАДЦАТИ беседам. Окно заводило новую почти при
 * каждом открытии, показывало все ходы проекта одной сплошной лентой — и выбрать прошлую
 * беседу было нечем, потому что списка не существовало. Всё, что не попало в текущую нить,
 * было написано в никуда.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ ═══════════════
 *
 * Есть ровно то, чем список пользуются в любом привычном чате: ИМЯ (первые слова разговора
 * или данное рукой), ВРЕМЯ последней реплики, ПЕРЕХОД кликом — и живая точка у той беседы, в
 * которой прямо сейчас идёт ход. Точка приходит от двери, а не рисуется по догадке окна:
 * занятой беседа бывает и от хода, начатого с телефона.
 *
 * Нет — ни поиска, ни папок, ни удаления. Книга поворачивается по числу ходов и живёт сама;
 * кнопка «удалить разговор» была бы единственным разрушающим действием на всём экране,
 * который во всём остальном ничего не ломает, и заводить её ради симметрии с чужими чатами
 * не за чем. Имя правится (догадка по первым словам бывает неудачной) — этого хватает.
 */

/** Когда в беседе говорили в последний раз, словами строки списка. */
function whenLabel(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const hh = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(at, now)) return hh
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(at, yesterday)) return `вчера ${hh}`
  return `${String(at.getDate()).padStart(2, '0')}.${String(at.getMonth() + 1).padStart(2, '0')}`
}

function Row({
  conversation,
  selected,
  live,
  onOpen,
  onRename,
}: {
  conversation: ChatConversation
  selected: boolean
  /** Ход, идущий В ЭТОМ окне: своя точка загорается без сети, чужая — приезжает от двери. */
  live: boolean
  onOpen: () => void
  onRename: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const active = live || conversation.active
  const name = conversationName(conversation)

  const startEdit = () => {
    setDraft(conversation.title ?? '')
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    if (draft.trim() !== (conversation.title ?? '').trim()) onRename(draft.trim())
  }

  if (editing) {
    return (
      <div className="rounded-[10px] border border-bd2 bg-surf px-2.5 py-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
            // Escape — уйти, ничего не переименовав: правка имени не должна быть ловушкой.
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
          }}
          placeholder="Название разговора"
          aria-label="Название разговора"
          className="w-full border-none bg-transparent text-[12.5px] text-tx outline-none placeholder:text-tx3"
        />
        <span className="text-[10.5px] text-tx3">Enter — сохранить, пусто — вернуть первые слова</span>
      </div>
    )
  }

  return (
    <div
      className={`group flex items-center gap-2 rounded-[10px] px-2.5 py-2 ${
        selected ? 'bg-surf' : 'hover:bg-surf'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        onDoubleClick={startEdit}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 border-none bg-transparent p-0 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {/* ЖИВАЯ ТОЧКА — у беседы, в которой прямо сейчас идёт ход. Закончившаяся беседа
              обычная: отсутствие точки здесь и означает «уже ничего не происходит». */}
          {active ? (
            <span aria-hidden className="h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-green" />
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate text-[12.5px] ${
              selected ? 'font-semibold text-tx' : 'text-tx'
            }`}
          >
            {name}
          </span>
        </span>
        <span className="flex w-full items-center gap-1.5 text-[10.5px] text-tx3">
          <span>{whenLabel(conversation.lastTs)}</span>
          {active ? <span className="text-ok-tx">идёт ход</span> : null}
        </span>
      </button>
      <button
        type="button"
        onClick={startEdit}
        aria-label={`Переименовать разговор «${name}»`}
        title="Переименовать"
        className="flex-none border-none bg-transparent p-0 text-[11px] text-tx3 opacity-0 group-hover:opacity-100"
      >
        ✎
      </button>
    </div>
  )
}

export function ConversationList({
  conversations,
  selected,
  liveId,
  loading,
  onOpen,
  onNew,
  onRename,
}: {
  conversations: ChatConversation[]
  selected: string | undefined
  /** Беседа, в которой ход идёт из ЭТОГО окна — точка загорается сразу, без ожидания двери. */
  liveId: string | null
  loading: boolean
  onOpen: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
}) {
  return (
    <aside className="flex w-[236px] flex-none flex-col border-r border-bd bg-card">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2 border-b border-bd bg-head px-3.5 backdrop-blur-[10px]">
        <h2 className="m-0 flex-1 text-[12.5px] font-semibold text-tx2">Разговоры</h2>
        {/* НОВЫЙ РАЗГОВОР ЗАВОДИТ ТОЛЬКО РУКА. Это единственная кнопка экрана, после которой
            следующий ход начинает новую беседу; открытие окна больше её не начинает никогда. */}
        <button
          type="button"
          onClick={onNew}
          aria-label="Новый разговор"
          className="flex-none rounded-[9px] border border-bd2 bg-surf px-2.5 py-1.5 text-[11.5px] text-tx"
        >
          + Новый
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="m-0 px-2.5 py-3 text-[11.5px] leading-[1.6] text-tx3">
            {loading ? 'Читаю книгу разговоров…' : 'Разговоров ещё не было. Напишите — первый заведётся сам.'}
          </p>
        ) : (
          conversations.map((c) => (
            <Row
              key={c.id}
              conversation={c}
              selected={c.id === selected}
              live={liveId === c.id}
              onOpen={() => onOpen(c.id)}
              onRename={(title) => onRename(c.id, title)}
            />
          ))
        )}
      </div>
    </aside>
  )
}
