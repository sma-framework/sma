import { useMemo, useState } from 'react'
import { isNotReady } from '../../api/client'
import { useAddProject, useRenameProject, useSelectProject, useStateQuery } from '../../api/queries'
import type { AccountEntry, DoneRow, ProjectRow, ProjectTrunk, WorkerRow } from '../../api/types'
import { plural } from '../../shell/format'
import { AddMachineWizard } from './AddMachineWizard'
import { MachineRow } from './MachineRow'
import { StopParkZone } from './StopParkZone'

/**
 * «Машины и проекты» — the household in one window: what it runs on, what it works on, and
 * what all of it did today.
 *
 * ══════════════════════ A HOUSEHOLD, NOT A NETWORK ══════════════════════
 *
 * There is no map here, no diagram and no address. A person owns machines and projects,
 * and that is the whole vocabulary this screen speaks: a machine is a name with a state
 * beside it, a project is a name with work behind it. The reading carries no peer url by
 * construction, so this is not a filter applied at render time — there is nothing to
 * filter.
 *
 * ═════════════════ EVERY FIGURE COMES FROM THE ONE READING ═════════════════
 *
 * The screen asks the daemon nothing of its own. Machines, projects, accounts and the day's
 * work all come out of the same poll every other screen renders from, which is why a count
 * here can never disagree with the same count on «Сегодня».
 *
 * ═════════════════ WHAT IS ON THIS MACHINE, AND WHAT IS NOT ═════════════════
 *
 * The project register is NOT merged across machines — federation aggregates the work, and
 * a folder on another machine is that machine's own business. So the second block says
 * «на этой машине» and means it, while the third block counts the work itself, which does
 * travel. Saying which is which is the difference between a summary and a guess.
 *
 * ═════════════════ CONNECTING A PROJECT IS AN ACT, NOT AN INSTRUCTION ═════════════════
 *
 * Until now this screen's «Добавить проект» opened a sentence telling a person to install
 * SMA in another folder and wait — the project register could only be written through a
 * hand-made HTTP request, and nothing appeared by itself. It is a form now: a folder, an
 * optional name, and the project is taken into the register and selected in one act, through
 * the two doors that already exist.
 *
 * And a register entry that names a folder is a different thing from one that does not. The
 * default entry every install mints carries a name and no folder at all, so the screens used
 * to show a project whose notebook they could not read one line of. A row says «не подключён»
 * when that is the case — the honest of the three states.
 *
 * ═════════════════ ЧТО НЕ УЕХАЛО — СТОЛБЦОМ, А НЕ ПОХОДОМ В ТЕРМИНАЛ ═════════════════
 *
 * Замерено 28.08: в продукте лежало 108 коммитов, которых нет на origin, и ни один экран
 * этого не показывал — на вопрос «что мы можем выкатить прямо сейчас» из окна ответить было
 * нельзя. Столбец «Не отправлено» отвечает: сколько коммитов не уехало, когда удалённый ствол
 * двигался, есть ли незакоммиченное и сколько веток задач не слито.
 *
 * НОЛЬ ЗДЕСЬ НЕ РИСУЕТСЯ ЗРЯ. Проект без удалённого ствола, отсоединённая голова, нечитаемое
 * дерево — всё это СЛОВА из ответа двери, а не «0 не отправлено»: ноль читается как «всё
 * уехало», и это ложь противоположного знака. Экран не считает ничего сам — он показывает то,
 * что дверь спросила у git.
 */

/** Whether a moment falls on the day the reader is having. */
function isToday(iso: string | null): boolean {
  if (!iso) return false
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return false
  const now = new Date()
  return (
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  )
}

/** The last thing that finished in a project, in words a person reads off a row. */
function lastEventWords(rows: DoneRow[]): string {
  const latest = rows
    .filter((r) => r.finishedAt)
    .sort((a, b) => new Date(b.finishedAt as string).getTime() - new Date(a.finishedAt as string).getTime())[0]
  if (!latest) return 'тихо'
  const at = new Date(latest.finishedAt as string)
  const when = isToday(latest.finishedAt)
    ? `сегодня в ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  return latest.failed ? `${when} — не получилось` : `${when} — ${latest.title ?? 'работа принята'}`
}

/** Когда это было, в словах: сегодня — по часам, иначе датой (с годом, если год не этот). */
function whenWords(iso: string | null): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  if (isToday(iso)) return `сегодня в ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
}

/**
 * ЧТО В ЭТОМ ПРОЕКТЕ НЕ УЕХАЛО. Всё до единого числа приходит из ответа двери; здесь только
 * слова вокруг них. Неизмеренный исход показывается СВОИМИ словами (`note`) — рисовать вместо
 * них ноль значило бы сказать «всё отправлено» там, где отправлять было некуда.
 */
function TrunkCell({ trunk }: { trunk: ProjectTrunk | undefined }) {
  if (!trunk || trunk.status !== 'measured') {
    return (
      <span className="truncate text-[12px] text-tx3" title={trunk?.note ?? undefined}>
        {trunk?.note ?? 'не измерено'}
      </span>
    )
  }

  const unpushed = trunk.unpushed ?? 0
  const marks: string[] = []
  if (trunk.dirty) marks.push('есть незакоммиченное')
  if ((trunk.unmergedBranches ?? 0) > 0) {
    const n = trunk.unmergedBranches as number
    marks.push(`${n} ${plural(n, 'ветка задачи', 'ветки задач', 'веток задач')} не слито`)
  }
  const moved = whenWords(trunk.remoteMovedAt)
  if (moved) marks.push(`${trunk.remote ?? 'удалённый ствол'} — ${moved}`)

  return (
    <span className="flex min-w-0 flex-col gap-[2px]">
      {unpushed > 0 ? (
        <span className="text-[12.5px] text-tx tabular-nums">
          <span className="font-semibold text-warn-tx">{unpushed}</span>{' '}
          {plural(unpushed, 'коммит', 'коммита', 'коммитов')} не отправлено
        </span>
      ) : (
        <span className="text-[12.5px] text-tx2">всё отправлено</span>
      )}
      <span className="truncate text-[11px] text-tx3" title={marks.join(' · ')}>
        {marks.join(' · ')}
      </span>
    </span>
  )
}

function Pill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className="text-[16px] font-bold text-tx tabular-nums">{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

function Figure({ mark, label, value, tone }: { mark: string; label: string; value: number; tone: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span aria-hidden className={`text-[12px] font-semibold ${tone}`}>
        {mark}
      </span>
      <span className="text-[12.5px] font-semibold text-tx2">{label}</span>
      <span className="text-[19px] font-semibold text-tx tabular-nums">{value}</span>
    </div>
  )
}

/** One project of this machine: its work, its last event, and its name — editable in place. */
function ProjectLine({
  project,
  active,
  lastEvent,
  onSelect,
  onRename,
  first,
}: {
  project: ProjectRow
  active: boolean
  lastEvent: string
  onSelect: () => void
  onRename: (name: string) => void
  first: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)

  const commit = () => {
    setEditing(false)
    const next = name.trim()
    if (next && next !== project.name) onRename(next)
    else setName(project.name)
  }

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_150px_minmax(0,240px)_minmax(0,1fr)_130px] items-center gap-4 px-[18px] py-3 ${
        first ? '' : 'border-t border-bd'
      } ${active ? 'bg-surf' : ''}`}
    >
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(project.name)
              setEditing(false)
            }
          }}
          aria-label="Название проекта"
          className="h-8 min-w-0 rounded-[7px] border border-bd2 bg-input px-2.5 text-[13px] text-tx outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 items-center gap-2 text-left text-[13px] font-semibold text-tx hover:text-blue"
        >
          <span className="truncate">{project.name}</span>
          {active ? (
            <span className="flex-none rounded-full border border-bd2 px-2 py-[2px] text-[10.5px] whitespace-nowrap text-tx3">
              выбран
            </span>
          ) : null}
          {/* A register entry with no folder is a label for grouping tasks, not a connection. */}
          {project.connected ? null : (
            <span
              title="У этой записи нет папки на этой машине — записную книжку проекта окно прочитать не может"
              className="flex-none rounded-full bg-warn-s px-2 py-[2px] text-[10.5px] whitespace-nowrap text-warn-tx"
            >
              не подключён
            </span>
          )}
        </button>
      )}

      <span className="text-[12.5px] text-tx2 tabular-nums">
        {project.taskCounts.total} {plural(project.taskCounts.total, 'задача', 'задачи', 'задач')}
        {project.taskCounts.claimed > 0 ? ` · в работе ${project.taskCounts.claimed}` : ''}
      </span>

      <TrunkCell trunk={project.trunk} />

      <span className="truncate text-[12.5px] text-tx3">{lastEvent}</span>

      <button
        type="button"
        onClick={() => setEditing(true)}
        className="justify-self-start text-[12px] text-tx3 hover:text-blue"
      >
        Переименовать
      </button>
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const select = useSelectProject()
  const rename = useRenameProject()

  const add = useAddProject()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [byMachine, setByMachine] = useState(false)
  const [byProject, setByProject] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addPath, setAddPath] = useState('')
  const [addName, setAddName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const data = state.data
  const machines = useMemo(() => data?.machines ?? [], [data])
  const projects: ProjectRow[] = data?.projects ?? []
  const accounts: AccountEntry[] = data?.accounts ?? []
  const done: DoneRow[] = useMemo(() => data?.done ?? [], [data])
  const workers: WorkerRow[] = useMemo(() => data?.workers ?? [], [data])
  const activeProject = data?.activeProject ?? null

  /** This machine's own id — the one a row that carries no machine belongs to. */
  const selfId = machines[0]?.id ?? 'self'
  const machineOf = (row: { machine?: string }) => row.machine ?? selfId

  /** Today's work, per machine: what was finished, and what is in hand right now. */
  const perMachine = useMemo(() => {
    const out = new Map<string, { finished: number; busy: number }>()
    for (const m of machines) out.set(m.id, { finished: 0, busy: 0 })
    for (const row of done) {
      if (row.failed || !isToday(row.finishedAt)) continue
      const cell = out.get(machineOf(row))
      if (cell) cell.finished += 1
    }
    for (const w of workers) {
      if (!w.taskId) continue
      const cell = out.get(machineOf(w))
      if (cell) cell.busy += 1
    }
    return out
  }, [machines, done, workers, selfId])

  const finishedToday = done.filter((r) => !r.failed && isToday(r.finishedAt)).length
  const busyNow = data?.kpis.workersBusy ?? 0
  const awaiting = data?.kpis.awaitingApproval ?? 0
  const online = machines.filter((m) => m.online).length

  const pickProject = (id: string) => {
    setProblem(null)
    select.mutate({ id }, { onError: (err) => setProblem(isNotReady(err) ? null : 'Не получилось переключить проект.') })
  }

  /**
   * Take a folder into the register and look at it — two existing doors, one act, because
   * adding a project a person then has to go and select is a control that half works.
   */
  const connectProject = () => {
    const path = addPath.trim()
    if (path === '') return
    setProblem(null)
    add.mutate(
      { path, ...(addName.trim() ? { name: addName.trim() } : {}) },
      {
        onSuccess: (result) => {
          const id = result?.project?.id
          setAddPath('')
          setAddName('')
          setAddOpen(false)
          if (id) select.mutate({ id }, { onError: () => setProblem('Проект добавлен, но выбрать его не получилось.') })
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Подключение проектов пока недоступно — дверь не отвечает.'
              : 'Не получилось подключить папку. В списке ничего не изменилось.',
          ),
      },
    )
  }

  const renameProject = (id: string, name: string) => {
    setProblem(null)
    rename.mutate(
      { id, name },
      { onError: (err) => setProblem(isNotReady(err) ? 'Переименование пока недоступно.' : 'Не получилось переименовать проект.') },
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Машины и проекты</h1>
        <Pill value={`${online} из ${machines.length}`} label="на связи" />
        <Pill value={String(projects.length)} label={plural(projects.length, 'проект', 'проекта', 'проектов')} />
        <Pill value={String(awaiting)} label="ждут Вашего решения" />
      </header>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Связь потеряна. Показано последнее, что было видно.</span>
        </div>
      ) : null}

      {problem ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">{problem}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[1120px] flex-col gap-[22px]">
          {/* ── 1 ── the machines themselves */}
          <section>
            <div className="mb-2.5 flex items-baseline gap-2.5">
              <h2 className="m-0 text-[13.5px] font-semibold text-tx">Ваши машины</h2>
              <span className="text-[11px] text-tx3 tabular-nums">{machines.length}</span>
              <span className="text-[11.5px] text-tx3">Один аккаунт живёт ровно на одной машине</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className="rounded-[8px] border border-bd2 bg-card px-3 py-[6px] text-[12.5px] font-medium text-tx hover:bg-surf"
              >
                Добавить машину
              </button>
            </div>

            <div className="overflow-hidden rounded-[12px] border border-bd bg-card shadow-panel">
              <div className="grid grid-cols-[minmax(0,1fr)_150px_220px_190px_120px] gap-4 border-b border-bd bg-surf px-[18px] py-2.5 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
                <span>Машина</span>
                <span>Состояние</span>
                <span>Сегодня</span>
                <span>Окна подписки</span>
                <span />{/* «Отвязать» стоит без заголовка: столбец действия, а не данных */}
              </div>
              {machines.map((m, i) => {
                const cell = perMachine.get(m.id) ?? { finished: 0, busy: 0 }
                return (
                  <MachineRow
                    key={m.id}
                    machine={m}
                    accounts={accounts.filter((a) => a.machineId === m.id)}
                    finishedToday={cell.finished}
                    busyNow={cell.busy}
                    first={i === 0}
                  />
                )
              })}
            </div>
          </section>

          {/* ── 2 ── the projects of THIS machine */}
          <section>
            <h2 className="m-0 mb-2.5 text-[13.5px] font-semibold text-tx">Проекты на этой машине</h2>
            <div className="overflow-hidden rounded-[12px] border border-bd bg-card shadow-panel">
              <div className="grid grid-cols-[minmax(0,1fr)_150px_minmax(0,240px)_minmax(0,1fr)_130px] gap-4 border-b border-bd bg-surf px-[18px] py-2.5 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
                <span>Проект</span>
                <span>Задачи</span>
                <span>Не отправлено</span>
                <span>Последнее событие</span>
                <span />
              </div>

              {projects.length === 0 ? (
                <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">На этой машине проектов пока нет.</p>
              ) : (
                projects.map((p, i) => (
                  <ProjectLine
                    key={p.id}
                    project={p}
                    active={p.id === activeProject}
                    lastEvent={lastEventWords(done.filter((r) => r.project === p.id))}
                    onSelect={() => pickProject(p.id)}
                    onRename={(name) => renameProject(p.id, name)}
                    first={i === 0}
                  />
                ))
              )}

              <button
                type="button"
                onClick={() => setAddOpen((v) => !v)}
                aria-expanded={addOpen}
                className="flex w-full items-center gap-2.5 border-t border-bd px-[18px] py-3 text-left text-[12.5px] font-medium text-tx2 hover:bg-row-hover hover:text-tx"
              >
                <span aria-hidden className="text-[13px] text-blue-d">
                  +
                </span>
                <span>Добавить проект</span>
              </button>
              {addOpen ? (
                <div className="flex flex-col gap-2.5 border-t border-bd bg-surf px-[18px] py-3.5 pl-10">
                  <span className="text-[12.5px] text-tx2">
                    Укажите папку проекта на этой машине. Окно будет показывать её записную книжку —
                    только показывать, ничего в ней не меняя.
                  </span>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <input
                      value={addPath}
                      onChange={(e) => setAddPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') connectProject()
                      }}
                      placeholder="C:\Users\Вы\projects\мой-проект"
                      aria-label="Папка проекта"
                      className="h-8 min-w-[320px] flex-1 rounded-[7px] border border-bd2 bg-input px-2.5 text-[12.5px] text-tx outline-none"
                    />
                    <input
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') connectProject()
                      }}
                      placeholder="Название (необязательно)"
                      aria-label="Название проекта"
                      className="h-8 w-[240px] rounded-[7px] border border-bd2 bg-input px-2.5 text-[12.5px] text-tx outline-none"
                    />
                    <button
                      type="button"
                      onClick={connectProject}
                      disabled={add.isPending || addPath.trim() === ''}
                      className="h-8 rounded-[8px] bg-blue-d px-4 text-[12.5px] font-semibold text-white hover:bg-blue disabled:opacity-60"
                    >
                      {add.isPending ? 'Подключаю…' : 'Подключить'}
                    </button>
                  </div>
                  <span className="text-[11.5px] text-tx3">
                    Ничего не устанавливается и ничего не записывается в папку — проект просто попадает
                    в список и становится выбранным.
                  </span>
                </div>
              ) : null}
            </div>
          </section>

          {/* ── 3 ── the day, across everything */}
          <section>
            <h2 className="m-0 mb-2.5 text-[13.5px] font-semibold text-tx">Сегодня по всем проектам</h2>
            <div className="overflow-hidden rounded-[12px] border border-bd bg-card shadow-panel">
              <div className="flex items-center gap-6 px-[18px] py-[15px]">
                <button
                  type="button"
                  onClick={() => setByMachine((v) => !v)}
                  aria-expanded={byMachine}
                  className="flex flex-1 items-center gap-6 text-left"
                >
                  <Figure mark="✓" label="Готово" value={finishedToday} tone="text-ok-tx" />
                  <span aria-hidden className="h-[22px] w-px bg-bd" />
                  <Figure mark="▸" label="В работе" value={busyNow} tone="text-blue-d" />
                  <span aria-hidden className="h-[22px] w-px bg-bd" />
                  <Figure mark="•" label="Ждут Вашего решения" value={awaiting} tone="text-warn-tx" />
                  <span aria-hidden className="text-[10px] text-tx3">
                    {byMachine ? '▲' : '▼'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setByProject((v) => !v)}
                  aria-expanded={byProject}
                  className="h-[30px] flex-none rounded-[8px] border border-bd2 bg-card px-3 text-[12.5px] font-medium text-tx hover:bg-surf"
                >
                  Показать всё вместе
                </button>
              </div>

              {/* The federation does aggregate the WORK, so the day can be told apart by
                  machine. Only what the reading actually carries per machine is shown. */}
              {byMachine
                ? machines.map((m) => {
                    const cell = perMachine.get(m.id) ?? { finished: 0, busy: 0 }
                    return (
                      <div
                        key={m.id}
                        className="grid grid-cols-[300px_1fr] items-center gap-4 border-t border-bd bg-surf px-[18px] py-2.5 text-[12.5px] text-tx2 tabular-nums"
                      >
                        <span className="truncate font-semibold text-tx">{m.title}</span>
                        <span>
                          Готово <span className="font-semibold text-tx">{cell.finished}</span> · В работе{' '}
                          <span className="font-semibold text-tx">{cell.busy}</span>
                        </span>
                      </div>
                    )
                  })
                : null}

              {byProject ? (
                <>
                  <div className="border-t border-bd bg-surf px-[18px] pt-2.5 text-[11px] text-tx3">
                    Проекты этой машины целиком, за всё время
                  </div>
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      className="grid grid-cols-[300px_1fr] items-center gap-4 bg-surf px-[18px] py-2.5 text-[12.5px] text-tx2 tabular-nums"
                    >
                      <span className="truncate font-semibold text-tx">{p.name}</span>
                      <span>
                        Готово <span className="font-semibold text-tx">{p.taskCounts.completed}</span> · В работе{' '}
                        <span className="font-semibold text-tx">{p.taskCounts.claimed}</span> · Ждут{' '}
                        <span className="font-semibold text-tx">{p.taskCounts.awaiting_approval}</span>
                      </span>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          </section>

          <StopParkZone />
        </div>
      </div>

      {wizardOpen ? <AddMachineWizard machines={machines} onClose={() => setWizardOpen(false)} /> : null}
    </section>
  )
}
