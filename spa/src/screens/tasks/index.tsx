import { useMemo, useState } from 'react'
import { useApprove, useStateQuery } from '../../api/queries'
import type { DoneRow, QueueRow } from '../../api/types'
import { TaskPanel } from '../today/TaskPanel'
import { clockLabel } from '../today/format'
import { Board, COLUMNS, columnOfStatus } from './Board'
import type { BoardCard, ColumnKey } from './Board'
import { NewTaskForm } from './NewTaskForm'

/**
 * «Задачи» — the whole of the work in one look, each task standing in the stage it is
 * actually in.
 *
 * The board is a PROJECTION of the one reading and nothing else: the queue and the finished
 * rows the window already has, sorted into five columns by their own status. It asks the
 * daemon nothing of its own — a second question would be a second version of the truth, and
 * a board that disagrees with «Сегодня» is a board nobody trusts.
 *
 * Two filters narrow it, and both narrow rows the window ALREADY HOLDS. The project comes
 * from the selector in the shell; the machine appears as a control only when there is more
 * than one machine to tell apart.
 *
 * The panel on the right is the one from «Сегодня» — BORROWED, not copied, exactly as that
 * panel says it must be. A person meets one panel with one set of habits on every screen
 * that opens a task, and a change to it is a change everywhere on the same day.
 */

/** The quiet second line of a card while it is still ahead of us. */
function queueNote(row: QueueRow): string | null {
  if (row.status === 'queued') return `в очереди · ${row.position}`
  if (row.status === 'returned') return 'возвращена'
  return null
}

function KpiPill({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className={`text-[16px] font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

/** The figure over each column, in the words of the column it counts. */
const KPI_LABEL: Record<ColumnKey, string> = {
  wait: 'ждут',
  working: 'в работе',
  decision: 'ждут решения',
  done: 'готово',
  failed: 'не получилось',
}

export function Screen() {
  const state = useStateQuery()
  const approve = useApprove()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [machine, setMachine] = useState<string>('')

  const data = state.data
  const activeProject = data?.activeProject ?? null
  const machines = data?.machines ?? []
  const showMachine = machines.length > 1

  const cards: BoardCard[] = useMemo(() => {
    // Every row carries its project and its machine, so both filters are a sieve over the
    // reading in hand — never a narrower question asked of the daemon.
    const mine = <T extends { project: string; machine: string }>(rows: T[]): T[] =>
      rows.filter((r) => (!activeProject || r.project === activeProject) && (!machine || r.machine === machine))

    const queued: BoardCard[] = mine(data?.queue ?? []).map((r: QueueRow) => ({
      id: r.id,
      column: columnOfStatus(r.status),
      title: r.title ?? 'Без названия',
      role: r.lane,
      machine: r.machine,
      reason: null,
      agedForHours: r.agedForHours,
      note: queueNote(r),
      live: r.status === 'claimed' || r.status === 'running',
      decision: r.status === 'awaiting_approval',
      past: false,
    }))

    const finished: BoardCard[] = mine(data?.done ?? []).map((r: DoneRow) => ({
      id: r.id,
      column: (r.failed ? 'failed' : 'done') as ColumnKey,
      title: r.title ?? 'Без названия',
      role: r.workerId,
      machine: r.machine,
      reason: r.failed ? (r.failed.reasonLabel ?? 'причина не записана') : null,
      note: clockLabel(r.finishedAt),
      live: false,
      decision: false,
      past: true,
    }))

    return [...queued, ...finished]
  }, [data, activeProject, machine])

  const counts = (key: ColumnKey) => cards.filter((c) => c.column === key).length
  const nothingAtAll = cards.length === 0

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Задачи</h1>
        {COLUMNS.map((col) => (
          <KpiPill
            key={col.key}
            value={counts(col.key)}
            label={KPI_LABEL[col.key]}
            tone={col.key === 'wait' ? 'text-tx2' : col.signClass}
          />
        ))}
        <span className="flex-1" />

        {showMachine ? (
          <select
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            aria-label="Машина"
            className="flex-none rounded-[9px] border border-bd bg-card px-2.5 py-1.5 text-[12px] text-tx2 outline-none"
          >
            <option value="">Все машины</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        ) : null}

        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setNewOpen((v) => !v)}
            aria-expanded={newOpen}
            className="rounded-[9px] bg-blue px-[15px] py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
          >
            + Новая задача
          </button>
          {newOpen ? <NewTaskForm onClose={() => setNewOpen(false)} /> : null}
        </div>
      </header>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            Связь потеряна. Доска не обновляется, показано последнее, что было видно.
          </span>
        </div>
      ) : null}

      {nothingAtAll ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="m-0 text-[13px] text-tx2">Задач нет. Поставьте задачу.</p>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            className="rounded-[9px] bg-blue px-[15px] py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
          >
            + Новая задача
          </button>
        </div>
      ) : (
        <Board
          cards={cards}
          selectedId={selectedId}
          showMachine={showMachine}
          busyId={approve.isPending ? (approve.variables?.taskId ?? null) : null}
          onOpen={setSelectedId}
          onApprove={(taskId) => approve.mutate({ taskId })}
        />
      )}

      {selectedId ? <TaskPanel taskId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </section>
  )
}
