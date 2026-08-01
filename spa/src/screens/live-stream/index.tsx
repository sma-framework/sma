import { useEffect, useMemo, useState } from 'react'
import { onFrame } from '../../api/hints'
import { useStateQuery } from '../../api/queries'
import type { EventFrame, EventName, WorkerRow } from '../../api/types'
import { openScreen } from '../../shell/navigation'
import type { OpenScreenDetail } from '../../shell/navigation'
import { EVENT_LABEL, EventRow } from './EventRow'

/**
 * «Живой поток» — the pulse of the park: the bells as they ring, in the order they rang.
 *
 * ═══════════════ THE FEED IS NOT THE TRUTH. THE POLL IS THE TRUTH. ═══════════════
 *
 * Every row here is a hint: a name and an identifier, which is all the daemon puts on the
 * live channel. So the feed tells a person that something moved and where to look; the
 * looking is done by the screen the row opens, which reads the truth from the poll. The card
 * above the feed — who is working right now — comes from that same one reading, which is why
 * it is right even on a screen just opened, before a single bell has rung.
 *
 * ONE CHANNEL. The feed subscribes to the connection the live layer already holds; it opens
 * nothing of its own. A second EventSource on this screen would be a second copy of every
 * event in the window.
 *
 * The buffer is a RING. A window left open for a week must not grow until the tab dies, so
 * the feed keeps the last few hundred frames and forgets the rest — the poll remembers
 * everything that matters anyway.
 */

/** How many frames the feed keeps in hand. Older ones fall off the end. */
const FEED_CAP = 300

/** The order the filter offers the fourteen kinds in — the working ones first. */
const FILTER_ORDER: readonly EventName[] = [
  'task.queued',
  'task.claimed',
  'task.running',
  'task.awaiting_approval',
  'task.approved',
  'task.returned',
  'task.failed',
  'worker.presence',
  'machine.presence',
  'spend.updated',
  'harness.updated',
  'chat.reply',
  'project.updated',
  'import.updated',
] as const

/** Where a bell sends a person for the truth about it. */
function targetOf(frame: EventFrame): OpenScreenDetail | null {
  if (frame.taskId) return { screen: 'task-card', taskId: frame.taskId }
  switch (frame.event) {
    case 'worker.presence':
      return { screen: 'team' }
    case 'spend.updated':
      return { screen: 'costs' }
    case 'harness.updated':
      return { screen: 'agents' }
    case 'chat.reply':
      return { screen: 'chat' }
    case 'machine.presence':
    case 'project.updated':
      return { screen: 'machines' }
    case 'import.updated':
      return { screen: 'import-wizard' }
    default:
      return null
  }
}

/** Who is holding a task right now, straight out of the one reading. */
function NowWorking({ workers, onOpenTask }: { workers: WorkerRow[]; onOpenTask: (taskId: string) => void }) {
  const busy = workers.filter((w) => w.taskId)
  if (busy.length === 0) return null

  return (
    <section className="flex-none overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-3">
        <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-green" />
        <h2 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-tx uppercase">Сейчас в работе</h2>
        <span className="text-[11px] text-tx3 tabular-nums">{busy.length}</span>
      </div>
      {busy.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => (w.taskId ? onOpenTask(w.taskId) : undefined)}
          className="grid w-full cursor-pointer grid-cols-[170px_150px_minmax(0,1fr)] items-center gap-4 border-0 border-t border-bd bg-transparent px-[18px] py-2.5 text-left first:border-t-0 hover:bg-row-hover"
        >
          <span className="truncate text-[12.5px] text-tx">{w.lane ?? w.id}</span>
          <span className="truncate text-[12px] text-tx2">{w.presence}</span>
          <span className="truncate text-[12.5px] text-tx3">{w.taskId}</span>
        </button>
      ))}
    </section>
  )
}

export function Screen() {
  const state = useStateQuery()
  const data = state.data

  const [feed, setFeed] = useState<EventFrame[]>([])
  const [kind, setKind] = useState<EventName | 'all'>('all')
  const [mineOnly, setMineOnly] = useState(false)

  // The one channel, watched. The ring is kept here because it is this screen's memory: a
  // person who never opens the feed pays nothing for it.
  useEffect(() => {
    return onFrame((frame) => {
      setFeed((old) => [frame, ...old].slice(0, FEED_CAP))
    })
  }, [])

  const activeProject = data?.activeProject ?? null

  /** Which project a task belongs to — from the rows the window already holds. */
  const projectOfTask = useMemo(() => {
    const out = new Map<string, string>()
    for (const row of data?.queue ?? []) out.set(row.id, row.project)
    for (const row of data?.done ?? []) out.set(row.id, row.project)
    return out
  }, [data])

  const shown = useMemo(() => {
    return feed.filter((frame) => {
      if (kind !== 'all' && frame.event !== kind) return false
      if (!mineOnly || !activeProject) return true
      if (frame.projectId) return frame.projectId === activeProject
      if (frame.taskId) return projectOfTask.get(frame.taskId) === activeProject
      return false
    })
  }, [feed, kind, mineOnly, activeProject, projectOfTask])

  const failedCount = shown.filter((f) => f.event === 'task.failed').length
  const busyCount = (data?.workers ?? []).filter((w) => w.taskId).length

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Живой поток</h1>

        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className="text-[16px] font-bold text-tx tabular-nums">{busyCount}</span>
          <span className="text-[11.5px] text-tx2">в работе</span>
        </div>
        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className="text-[16px] font-bold text-tx tabular-nums">{shown.length}</span>
          <span className="text-[11.5px] text-tx2">событий в ленте</span>
        </div>
        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className={`text-[16px] font-bold tabular-nums ${failedCount > 0 ? 'text-err-tx' : 'text-tx2'}`}>
            {failedCount}
          </span>
          <span className="text-[11.5px] text-tx2">не получилось</span>
        </div>

        <div className="flex-1" />

        <label className="flex flex-none items-center gap-2 text-[12px] text-tx2">
          Показывать
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as EventName | 'all')}
            className="rounded-[8px] border border-bd bg-input px-2.5 py-1.5 text-[12px] text-tx outline-none"
          >
            <option value="all">все события</option>
            {FILTER_ORDER.map((name) => (
              <option key={name} value={name}>
                {EVENT_LABEL[name]}
              </option>
            ))}
          </select>
        </label>

        {activeProject ? (
          <label className="flex flex-none items-center gap-2 text-[12px] text-tx2">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            только этот проект
          </label>
        ) : null}
      </header>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            Связь потеряна. Лента молчит, пока связь не вернётся — и наверстает опросом.
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pt-5 pb-7">
        <NowWorking
          workers={data?.workers ?? []}
          onOpenTask={(taskId) => openScreen({ screen: 'task-card', taskId })}
        />

        <section className="flex-none overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
          <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-3">
            <h2 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-tx uppercase">Последние события</h2>
            <span className="text-[11px] text-tx3 tabular-nums">{shown.length}</span>
          </div>

          {shown.length === 0 ? (
            <div className="px-[18px] py-8 text-center">
              <p className="m-0 text-[13px] text-tx2">Пока тихо.</p>
              <p className="m-0 mt-1.5 text-[11.5px] text-tx3">
                {feed.length === 0
                  ? 'Лента наполняется с момента, как экран открыт. Что было раньше — на «Сегодня».'
                  : 'Под этот фильтр пока ничего не попало.'}
              </p>
            </div>
          ) : (
            shown.map((frame, i) => (
              <EventRow
                key={`${frame.id}-${frame.ts}-${i}`}
                frame={frame}
                onOpen={(f) => {
                  const target = targetOf(f)
                  if (target) openScreen(target)
                }}
              />
            ))
          )}
        </section>

        <p className="m-0 px-1 text-[11.5px] text-tx3">
          Лента — это подсказки: она говорит, что что-то сдвинулось. Точную картину показывает экран, который
          открывается по строке.
        </p>
      </div>
    </section>
  )
}
