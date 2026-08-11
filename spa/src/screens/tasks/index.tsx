import { useMemo, useState } from 'react'
import { useApprove, useStateQuery } from '../../api/queries'
import type { DoneRow, QueueRow } from '../../api/types'
import { TaskPanel } from '../../shell/TaskPanel'
import { clockLabel } from '../../shell/format'
import { Board, COLUMNS, columnOfStatus } from './Board'
import type { BoardCard, ColumnKey } from './Board'
import { NewTaskForm } from './NewTaskForm'

/**
 * «Задачи» — the whole of the work in one look, each task standing in the stage it is
 * actually in.
 *
 * The board is a PROJECTION of the one reading and nothing else: the rows the window already
 * has, sorted into five columns. It asks the daemon nothing of its own — a second question
 * would be a second version of the truth, and a board that disagrees with «Сегодня» is a
 * board nobody trusts.
 *
 * Each column is fed from the list that ACTUALLY carries its stage, because the payload
 * keeps the stages apart on purpose:
 *   - «ЖДУТ»          ← queue[]    — waiting for a WORKER;
 *   - «В РАБОТЕ»      ← workers[]  — the tasks the workers hold right now (taskId);
 *   - «ЖДУТ РЕШЕНИЯ»  ← awaiting[] — waiting for a PERSON;
 *   - «ГОТОВО»/«НЕ ПОЛУЧИЛОСЬ» ← done[].
 * Sifting one stage out of another's list is how a column goes quietly empty forever: the
 * queue never carried a claimed or an awaiting row, so asking it for one only ever answered
 * «пусто» — exactly the way this board used to lose both its middle columns.
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
  // A worker row is tagged with its machine only once the hub merges more than one; on a
  // single machine the reading says nothing, because there is nothing to tell apart.
  const selfMachine = machines.find((m) => m.role === 'self')?.id ?? ''

  const cards: BoardCard[] = useMemo(() => {
    // Why a queued card is NOT moving, in the founder's language. The daemon derives the
    // code from the same facts the tick runs on; this map only translates it to words.
    const IDLE_WORDS: Record<string, string> = {
      pipeline_off: 'Конвейер выключен — задача не начнётся, пока не включите тумблер',
      windows_closed: 'Все окна подписок закрыты — ждёт окна (платный канал не настроен)',
      budget_stop: 'Платный канал исчерпан на месяц — ждёт окна подписки',
    }
    // Every row carries its project and its machine, so both filters are a sieve over the
    // reading in hand — never a narrower question asked of the daemon.
    const mine = <T extends { project: string; machine: string }>(rows: T[]): T[] =>
      rows.filter((r) => (!activeProject || r.project === activeProject) && (!machine || r.machine === machine))

    // One task row, one card — the column comes from the row's OWN status, so a row lands
    // where the board says its stage lands and nowhere else.
    const toCard = (r: QueueRow): BoardCard => ({
      id: r.id,
      column: columnOfStatus(r.status),
      title: r.title ?? 'Без названия',
      role: r.lane,
      machine: r.machine,
      reason: null,
      idle: r.idleReason ? IDLE_WORDS[r.idleReason] : null,
      agedForHours: r.agedForHours,
      note: queueNote(r),
      live: false,
      decision: r.status === 'awaiting_approval' || r.status === 'approving',
      past: false,
    })

    const queued: BoardCard[] = mine(data?.queue ?? []).map(toCard)

    // The work that owes a person a word rides its own list — same row shape, longest wait
    // first. It is NOT in the queue and never was.
    const decisions: BoardCard[] = mine(data?.awaiting ?? []).map(toCard)

    // The work in flight has no list of its own in the reading: the one place a claimed task
    // is named is the worker holding it (workers[].taskId, with `wt/<id>` for its branch).
    // So «В РАБОТЕ» is built from the roster, and `live` — the pulse down the card's edge —
    // is exactly «a worker holds this task», which is the only in-progress signal the payload
    // has. The worker row names that task's own title and project beside its id, so a running
    // card is titled and sieved by exactly the same two facts as every other column's — the
    // sieve is `mine` written out, because a worker's machine is stated only once there is
    // more than one to tell apart.
    const running: BoardCard[] = (data?.workers ?? [])
      .filter(
        (w) =>
          !!w.taskId &&
          (!activeProject || w.project === activeProject) &&
          (!machine || (w.machine ?? selfMachine) === machine),
      )
      .map(
        (w): BoardCard => ({
          id: w.taskId as string,
          column: 'working',
          title: w.taskTitle ?? 'Без названия',
          role: w.id,
          machine: w.machine ?? selfMachine,
          reason: null,
          note: null,
          live: true,
          decision: false,
          past: false,
        }),
      )

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

    return [...queued, ...running, ...decisions, ...finished]
  }, [data, activeProject, machine, selfMachine])

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
