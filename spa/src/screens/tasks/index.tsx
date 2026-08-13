import { useMemo, useState } from 'react'
import { usePhaseIndexQuery, useStateQuery } from '../../api/queries'
import { TaskPanel } from '../../shell/TaskPanel'
import { useTellConsoleContext } from '../../shell/console-context'
import { clockLabel, plural } from '../../shell/format'
import { PhaseCardView } from '../pipeline/PhaseCardView'
import { usePhaseBells } from '../pipeline/shared'
import { BatchView } from './BatchView'
import { Inbox } from './Inbox'
import type { InboxItem } from './Inbox'
import { NewBatchForm } from './NewBatchForm'
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
 *
 * ═════════════════════ ОДНО ОКНО, КРОШКИ ═════════════════════
 *
 * Единица работы РАСКРЫВАЕТСЯ ЗДЕСЬ ЖЕ, а не увозит человека на соседний экран: фаза
 * открывается своей карточкой прямо в этом окне, задача — панелью поверх него. Поэтому путь
 * входа известен, и крошка «Задачи» ведёт назад ровно туда, откуда пришли.
 *
 * Прежде клик по фазе звал экран конвейера фаз — и человек оказывался на СПИСКЕ всех фаз, то
 * есть не в той фазе, по которой кликнул, и без дороги назад к задачам. Это и есть «крошки
 * ведут не туда, откуда пришли», только в самой крупной своей форме.
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
  /** Открыта ли форма батча. Две формы одновременно — это два ответа на один вопрос. */
  const [batchOpen, setBatchOpen] = useState(false)
  const [machine, setMachine] = useState<string>('')
  /** Какая фаза раскрыта в этом же окне. `null` — на глазу список. */
  const [openPhase, setOpenPhase] = useState<string | null>(null)
  /** Какая сборка раскрыта в этом же окне — тем же способом и по той же причине. */
  const [openBatch, setOpenBatch] = useState<string | null>(null)

  // Карточка фазы живёт теперь и здесь, значит и два звонка фазового цикла нужны здесь: без
  // них раскрытая фаза осталась бы такой, какой её открыли, пока человек не ушёл и не вернулся.
  usePhaseBells()

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
        // Сборки приезжают тем же одним чтением состояния, что и всё остальное: третий вид
        // списка — проекция ряда движка, а не второй вопрос к нему.
        batches: data?.batches ?? [],
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
        onOpen: () => setOpenPhase(p.id),
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

  // ЧТО ОТКРЫТО — рассказано оболочке. Список и раскрытая фаза — это ОДИН экран, и снаружи
  // их не различить: без этого рассказа окно разговора говорило бы «Задачи», пока человек
  // читает стадию фазы, и отвечало бы не про то, на что он смотрит.
  useTellConsoleContext(
    openPhase !== null
      ? {
          kind: 'phase',
          line: `фаза ${(phaseIndex.data?.phases ?? []).find((p) => p.id === openPhase)?.name ?? openPhase}`,
          phase: openPhase,
        }
      : openBatch !== null
        ? {
            kind: 'screen',
            line: `батч «${(data?.batches ?? []).find((b) => b.id === openBatch)?.title ?? openBatch}»`,
          }
        : {
            kind: 'list',
            line: `Задачи · ${units.length} ${plural(units.length, 'единица', 'единицы', 'единиц')} работы`,
          },
  )

  const openUnit = (unit: WorkUnit) => {
    if (unit.target.screen === 'phase') setOpenPhase(unit.target.id)
    else if (unit.target.screen === 'batch') setOpenBatch(unit.target.id)
    else setSelectedId(unit.target.id)
  }

  // Фаза раскрыта — это тот же экран, просто вглубь. Крошка «Задачи» и кнопка возврата ведут
  // сюда же, в список, а не на конвейер фаз: человек пришёл отсюда.
  if (openPhase !== null) {
    return (
      <PhaseCardView
        id={openPhase}
        onBack={() => setOpenPhase(null)}
        backLabel="← К задачам"
        trail={[{ label: 'Задачи', onClick: () => setOpenPhase(null) }]}
      />
    )
  }

  // Сборка раскрывается здесь же и той же дорогой, что фаза: вход в элемент запомнится, потому
  // что элемент открывается ПОВЕРХ развилки, а не вместо неё.
  if (openBatch !== null) {
    return (
      <BatchView
        id={openBatch}
        onBack={() => setOpenBatch(null)}
        backLabel="← К задачам"
        trail={[{ label: 'Задачи', onClick: () => setOpenBatch(null) }]}
      />
    )
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

        {/*
          Второе действие рядом с первым, а не вместо него: инлайн и батч — РАЗНЫЕ виды работы
          с разными правилами (одна задача против фразы, разложенной на элементы), и общая
          форма с переключателем спрашивала бы половину полей впустую в каждом из двух случаев.
        */}
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => {
              setBatchOpen((v) => !v)
              setNewOpen(false)
            }}
            aria-expanded={batchOpen}
            className="rounded-[9px] border border-bd2 px-[13px] py-2 text-[12px] font-semibold text-tx2 hover:text-tx"
          >
            + Батч
          </button>
          {batchOpen ? (
            <NewBatchForm
              onClose={() => setBatchOpen(false)}
              onCreated={(id) => {
                // Сразу в развилку заведённой сборки: человек только что описал работу, и
                // список верхнего уровня ответил бы ему одной строкой о ней вместо состава.
                setBatchOpen(false)
                setOpenBatch(id)
              }}
            />
          ) : null}
        </div>

        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => {
              setNewOpen((v) => !v)
              setBatchOpen(false)
            }}
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
            {/* Слова владельца показываются, только когда они сказаны: счётчик «отменено 0»
                рассказывал бы о решении, которого никто не принимал. */}
            {counts.skip > 0 ? <Counter n={counts.skip} label="пропущено" tone="text-tx3" /> : null}
            {counts.off > 0 ? <Counter n={counts.off} label="отменено" tone="text-tx3" /> : null}
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
