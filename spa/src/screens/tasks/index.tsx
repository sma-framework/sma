import { useMemo, useState } from 'react'
import { usePhaseIndexQuery, useStateQuery } from '../../api/queries'
import { TaskPanel } from '../../shell/TaskPanel'
import { clockLabel } from '../../shell/format'
import { openScreen } from '../../shell/navigation'
import { Inbox } from './Inbox'
import type { InboxItem } from './Inbox'
import { NewTaskForm } from './NewTaskForm'
import { UnitRow } from './UnitRow'
import { buildUnits, countUnits, waitWords } from './units'
import type { WorkUnit } from './units'

/**
 * «Задачи» — the whole of the work in one look, one line per unit of work.
 *
 * ═════════════════════ WHY A LIST AND NOT A BOARD ═════════════════════
 *
 * The board this screen used to be sorted tasks into five columns, which answered «в какой
 * стадии эта задача» and refused to answer the two questions a person actually arrives with:
 * what is stuck on ME, and what is the work made OF. A column cannot say that a phase is a
 * phase, that it has four stages, and that three of them are done — every unit was flattened
 * into the same card, so the shape of the work was invisible.
 *
 * The list says the shape. Each line carries the KIND of unit, its own state in a word and a
 * dot, what it is made of, how far its steps got, what happens next, and how long. What is
 * stuck on a person is lifted out of the list entirely into the band at the top, because a
 * question waiting 41 minutes should not have to be found by scrolling.
 *
 * ═════════════════════ NOTHING HERE IS DRAWN FROM NOTHING ═════════════════════
 *
 * Every figure and every sentence is a projection of a reading the window already holds — see
 * `units.ts`, which is where that translation lives and is the only place it lives. The kind
 * «БАТЧ» of the accepted design is absent for the plainest reason available: the engine has no
 * batches, and a kind painted out of whatever was nearest would read exactly like a measured
 * one.
 */

/** «41 МИН» / «6 Ч» — how long something has been on the person, in the band's own voice. */
function ageLabel(hours: number | undefined): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return ''
  if (hours < 1) return `${Math.round(hours * 60)} МИН`
  return `${Math.floor(hours)} Ч`
}

function Counter({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`text-[12px] font-semibold tabular-nums ${tone}`}>{n}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </span>
  )
}

export function Screen() {
  const state = useStateQuery()
  const phaseIndex = usePhaseIndexQuery()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [machine, setMachine] = useState<string>('')

  const data = state.data
  const activeProject = data?.activeProject ?? null
  const machines = data?.machines ?? []
  const showMachine = machines.length > 1
  const selfMachine = machines.find((m) => m.role === 'self')?.id ?? ''

  const units = useMemo(
    () =>
      buildUnits({
        queue: data?.queue ?? [],
        awaiting: data?.awaiting ?? [],
        workers: data?.workers ?? [],
        done: data?.done ?? [],
        phases: phaseIndex.data?.phases ?? [],
        activeProject,
        machine,
        selfMachine,
        clock: clockLabel,
        // Часы читаются ЗДЕСЬ, на каждом пересчёте проекции, а не внутри неё: опрос состояния
        // приносит новый признак жизни у каждой бегущей строки, поэтому пересчёт случается
        // ровно тогда, когда есть что пересчитывать. Проекция при этом остаётся сравнимой.
        now: Date.now(),
      }),
    [data, phaseIndex.data, activeProject, machine, selfMachine],
  )

  const counts = countUnits(units)

  /** The band: the awaiting tasks and the phases that parked a question, longest wait first. */
  const inbox: InboxItem[] = useMemo(() => {
    const waitingTasks = (data?.awaiting ?? []).filter(
      (r) => (!activeProject || r.project === activeProject) && (!machine || r.machine === machine),
    )
    const fromTasks: InboxItem[] = [...waitingTasks]
      // Дольше всех ждущее — первым. Строка без возраста уходит в конец: очередь кладёт возраст
      // только тем, кто ждёт дольше терпения, значит её ожидание короче любого названного.
      .sort((a, b) => (b.agedForHours ?? 0) - (a.agedForHours ?? 0))
      .map((r) => ({
        id: `task:${r.id}`,
        age: ageLabel(r.agedForHours),
        text: r.title ?? 'Без названия',
        cta: 'Решить →',
        onOpen: () => setSelectedId(r.id),
      }))

    const fromPhases: InboxItem[] = (phaseIndex.data?.phases ?? [])
      .filter((p) => p.open > 0)
      .map((p) => ({
        id: `phase:${p.id}`,
        // Возраст вопроса фазы дверь не называет — и здесь он поэтому не пишется вовсе.
        age: '',
        text: `${p.name}: ${p.open} ${p.open === 1 ? 'вопрос ждёт' : 'вопроса ждут'} вашего ответа`,
        cta: 'Ответить →',
        onOpen: () => openScreen({ screen: 'pipeline' }),
      }))

    return [...fromTasks, ...fromPhases]
  }, [data, phaseIndex.data, activeProject, machine])

  /**
   * «ЖДУТ ВАС: 3 · ДОЛЬШЕ ВСЕХ — 41 МИН» — счётчик и возраст самого старого ожидания.
   *
   * Возраст берётся из ожидающих задач, потому что только у них он измерен. Если ни у одной
   * строки его нет, полоса так и говорит — счётчик от этого не становится враньём, а число
   * минут не берётся из воздуха.
   */
  const inboxHeadline = useMemo(() => {
    const oldest = (data?.awaiting ?? [])
      .filter((r) => (!activeProject || r.project === activeProject) && (!machine || r.machine === machine))
      .reduce<number | undefined>((max, r) => (r.agedForHours != null && (max == null || r.agedForHours > max) ? r.agedForHours : max), undefined)
    const words = waitWords(oldest)
    return `Ждут вас: ${inbox.length} · ${words ? `дольше всех — ${words}` : 'сколько ждут — нет данных'}`
  }, [data, activeProject, machine, inbox.length])

  /** The roster in one sentence — who is on the work right now. */
  const workerLine = useMemo(() => {
    const rows = data?.workers ?? []
    if (rows.length === 0) return 'Работников нет'
    if (rows.length === 1) return `Работник: ${rows[0].id} · ${rows[0].presence}`
    const busy = rows.filter((w) => !!w.taskId).length
    return `Работников: ${rows.length} · занято ${busy}`
  }, [data])

  const openUnit = (unit: WorkUnit) => {
    if (unit.target.screen === 'phase') openScreen({ screen: 'pipeline' })
    else setSelectedId(unit.target.id)
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Задачи</h1>
        <span className="flex-1" />
        <span className="flex-none text-[11.5px] text-tx2">{workerLine}</span>

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
            Связь потеряна. Список не обновляется, показано последнее, что было видно.
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
        <Inbox items={inbox} headline={inboxHeadline} />

        <div className="mb-2.5 flex items-baseline gap-3">
          <span className="text-[13px] font-semibold text-tx">Задачи · верхний уровень</span>
          <div className="flex gap-3">
            <Counter n={counts.run} label="в работе" tone="text-blue" />
            <Counter n={counts.dec} label="ждут решения" tone="text-warn-tx" />
            <Counter n={counts.ok} label="готово" tone="text-ok-tx" />
            <Counter n={counts.wait} label="не начаты" tone="text-tx3" />
            {counts.fail > 0 ? <Counter n={counts.fail} label="не получилось" tone="text-err-tx" /> : null}
          </div>
        </div>

        {units.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-[10px] border border-bd bg-card py-16">
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
          <div className="overflow-hidden rounded-[10px] border border-bd bg-card shadow-panel">
            {units.map((unit, i) => (
              <UnitRow key={`${unit.kind}:${unit.id}`} unit={unit} first={i === 0} onOpen={openUnit} />
            ))}
          </div>
        )}

        {phaseIndex.isError ? (
          <p className="mt-3 text-[11.5px] text-tx3">
            Фазы не прочитались — в списке только задачи. Дверь конвейера фаз ответила ошибкой.
          </p>
        ) : null}
      </div>

      {selectedId ? <TaskPanel taskId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </section>
  )
}
