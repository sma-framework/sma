import type { TaskStatus } from '../../api/types'
import { TaskCardMini } from './TaskCardMini'

/**
 * Board — the five stages of the day, side by side.
 *
 * ═════════════════════ THE BOARD IS A MIRROR, NOT A LEVER ═════════════════════
 *
 * Nothing here is dragged. A card sits in the column its STATUS puts it in, and it moves
 * when the daemon says it moved — never because a hand pulled it. Dragging a card would
 * be a person telling the board a story the queue does not know; the whole point of this
 * screen is that the board cannot tell a story the queue does not know.
 *
 * So there is no drag library here and there never will be. The only actions on a card are
 * the two that genuinely belong to a person: open it, and accept the work that is waiting
 * on a decision.
 *
 * Every column is a filter over the ONE reading. Nothing on this screen asks the daemon a
 * question of its own.
 */

export type ColumnKey = 'wait' | 'working' | 'decision' | 'done' | 'failed'

/**
 * Where each status stands on the board. EVERY status a task row can carry is named here,
 * exhaustively — `Record<TaskStatus, …>` makes that a compile error rather than a card
 * that quietly falls off the board when the daemon learns a new word.
 */
const COLUMN_OF: Record<TaskStatus, ColumnKey> = {
  queued: 'wait',
  returned: 'wait',
  claimed: 'working',
  running: 'working',
  awaiting_approval: 'decision',
  approving: 'decision',
  approved: 'done',
  completed: 'done',
  failed: 'failed',
}

export function columnOfStatus(status: TaskStatus): ColumnKey {
  return COLUMN_OF[status]
}

/**
 * One card on the board — a task row already projected into what the card draws. The
 * projection happens once, in the screen, so a card never reads a payload field itself and
 * two cards can never disagree about what a row meant.
 */
export interface BoardCard {
  id: string
  column: ColumnKey
  title: string
  /** The line of work, as the reading names it. */
  role: string | null
  machine: string
  /** Why it did not make it, in the daemon's own words. Only ever set on a failed card. */
  reason: string | null
  /** Set only when the task has waited longer than the configured patience. */
  agedForHours?: number
  /** A quiet second line: the place in the queue, or the hour it finished. */
  note: string | null
  /** The work is running right now. */
  live: boolean
  /** It is waiting on a person. */
  decision: boolean
  /** It is behind us — drawn quieter than the work still in front. */
  past: boolean
}

interface ColumnSpec {
  key: ColumnKey
  label: string
  sign: string
  signClass: string
}

/**
 * The five columns, in the order of the accepted screen. The «ГОТОВО» column deliberately
 * does not claim a week: `done[]` is what the daemon still holds, and a heading that
 * promises a period the reading cannot back is exactly the kind of small lie that makes a
 * dashboard untrustworthy.
 */
export const COLUMNS: readonly ColumnSpec[] = [
  { key: 'wait', label: 'ЖДУТ', sign: '•', signClass: 'text-tx3' },
  { key: 'working', label: 'В РАБОТЕ', sign: '▸', signClass: 'text-teal' },
  { key: 'decision', label: 'ЖДУТ РЕШЕНИЯ', sign: '•', signClass: 'text-blue' },
  { key: 'done', label: 'ГОТОВО', sign: '✓', signClass: 'text-green' },
  { key: 'failed', label: 'НЕ ПОЛУЧИЛОСЬ', sign: '✗', signClass: 'text-err' },
] as const

export function Board({
  cards,
  selectedId,
  showMachine,
  busyId,
  onOpen,
  onApprove,
}: {
  cards: BoardCard[]
  selectedId: string | null
  /** Only worth the room it takes when there is more than one machine to tell apart. */
  showMachine: boolean
  busyId: string | null
  onOpen: (id: string) => void
  onApprove: (id: string) => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-x-auto px-7 pt-6 pb-7">
      <div className="grid h-full min-w-[1400px] grid-cols-5 gap-4">
        {COLUMNS.map((col) => {
          const rows = cards.filter((c) => c.column === col.key)
          return (
            <section
              key={col.key}
              className="flex min-h-0 flex-col rounded-[14px] border border-bd bg-card/55 backdrop-blur-[8px]"
            >
              <header className="flex flex-none items-baseline gap-2.5 border-b border-bd px-4 py-3.5">
                <span aria-hidden className={`text-[12px] ${col.signClass}`}>
                  {col.sign}
                </span>
                <span className="text-[11px] font-semibold tracking-[0.08em] text-tx">{col.label}</span>
                <span className="text-[11px] text-tx3 tabular-nums">{rows.length}</span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
                {rows.length === 0 ? (
                  <p className="m-0 py-[18px] text-center text-[11.5px] text-tx3">Пусто</p>
                ) : (
                  rows.map((card) => (
                    <TaskCardMini
                      key={card.id}
                      card={card}
                      selected={card.id === selectedId}
                      showMachine={showMachine}
                      busy={busyId === card.id}
                      onOpen={onOpen}
                      onApprove={onApprove}
                    />
                  ))
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
