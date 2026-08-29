import { useMemo, useState } from 'react'
import { useCancelTask, useReturnTask, useStateQuery } from '../../api/queries'
import { openScreen } from '../../shell/navigation'
import type { DoneRow, QueueRow, WorkerRow } from '../../api/types'
import { DayFeed } from './DayFeed'
import type { OfferAct } from './offer'
import { KpiStrip } from './KpiStrip'
import { TaskPanel } from '../../shell/TaskPanel'
import { accentFor, initialOf, plural } from '../../shell/format'

/**
 * «Сегодня» — the screen a person opens in the morning to find out what happened while
 * they were away.
 *
 * It answers three questions in the order they are actually asked: what needs me, what
 * broke, what got done — and only then, what is queued for the day ahead. Everything on it
 * comes from the ONE reading of the picture, filtered to the project the window is looking
 * at. It asks the daemon nothing of its own: a second question would be a second version
 * of the truth, and two versions on one screen is how a dashboard starts lying.
 *
 * When the reading fails, the screen keeps showing the last one it had and says so out
 * loud. Stale figures a person knows are stale are useful; stale figures presented as
 * fresh are worse than a blank screen.
 */

function TeamStrip({ workers }: { workers: WorkerRow[] }) {
  if (workers.length === 0) return null
  return (
    <div className="flex flex-none items-center">
      {workers.slice(0, 6).map((w, i) => (
        <span
          key={w.id}
          title={`${w.lane ?? w.id} · ${w.presence}`}
          className={`flex h-8 w-8 flex-none items-center justify-center rounded-full border-2 border-bg text-[12px] font-bold ${accentFor(
            w.lane ?? w.id,
          )}`}
          style={{ marginLeft: i === 0 ? 0 : -9 }}
        >
          {initialOf(w.lane ?? w.id)}
        </span>
      ))}
    </div>
  )
}

function OfflineLine() {
  return (
    <div className="flex items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
      <span aria-hidden className="flex-none text-warn-tx">
        ●
      </span>
      <span className="text-[12.5px] text-tx">
        Связь потеряна. Ничего не обновляется, показано последнее, что было видно.
      </span>
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Двери трёх действий красной карточки. Ни одной НОВОЙ: работа, которой не хватило ходов,
  // ставится обратно той же дверью возврата, состав частей набирается той же формой батча,
  // отмена — той же терминальной дверью. Список маршрутов демона не изменился ни на строку.
  const putBack = useReturnTask()
  const cancel = useCancelTask(null)
  const [actProblem, setActProblem] = useState<string | null>(null)

  /**
   * ЧТО ДЕЛАЕТ НАЖАТИЕ НА КРАСНОЙ КАРТОЧКЕ. Три дела, и все три существовали до неё — не было
   * только пути к ним от той строки, где человек принимает решение.
   *
   * `requeue` — та же работа под ТЕМ ЖЕ номером едет в очередь снова. Потолок поднимает не это
   * нажатие: сгоревший записан на строке попытки, и следующий запуск обязан выдать строго
   * больший. Номер несущий — поставленная заново работа начинала бы со дна. Слов человека
   * здесь нет: он не поправляет работу, он даёт ей место, и выдуманный комментарий уехал бы
   * работнику как чужая поправка.
   *
   * `compose` — окно уходит на «Задачи» с развёрнутой формой состава. Ни одной части нажатие
   * не заводит: предложение и постановка — два действия, и второе принадлежит человеку.
   *
   * `cancel` — терминальная остановка. Вопрос-подтверждение задан на самой карточке, здесь
   * исполняется уже принятое решение.
   */
  const act = (taskId: string, what: OfferAct) => {
    setActProblem(null)
    if (what === 'compose') return openScreen({ screen: 'tasks', opens: 'new-batch' })
    const failed = () => setActProblem('Не вышло — работа осталась на месте.')
    if (what === 'requeue') {
      putBack.mutate({ taskId, note: '' }, { onError: failed })
      return
    }
    cancel.mutate({ taskId }, { onError: failed })
  }

  const data = state.data
  const activeProject = data?.activeProject ?? null

  // Every row already carries its project, so one project is a filter over the reading the
  // window already has — never a narrower question asked of the daemon.
  //
  // Строка без проекта (`null` — «неизвестен») этим ситом не проходит: этот экран о сегодняшнем
  // дне ОДНОГО проекта. Такая работа не пропадает — её показывает группой экран «Задачи».
  const mine = <T extends { project?: string | null }>(rows: T[]): T[] =>
    activeProject ? rows.filter((r) => r.project === activeProject) : rows

  const queue: QueueRow[] = useMemo(() => mine(data?.queue ?? []), [data, activeProject])
  const awaiting: QueueRow[] = useMemo(() => mine(data?.awaiting ?? []), [data, activeProject])
  const done: DoneRow[] = useMemo(() => mine(data?.done ?? []), [data, activeProject])

  // What needs a person comes from the list that actually carries it; what is waiting for
  // a worker comes from the queue. Two lists, two questions — neither is sifted out of the
  // other, so neither can quietly go empty.
  const decisions = awaiting
  const waiting = [...queue].sort((a, b) => a.position - b.position)
  const failed = done.filter((r) => r.failed)
  const finished = done.filter((r) => !r.failed)

  const parts: string[] = [
    `Пока вас не было, команда закрыла ${finished.length} ${plural(finished.length, 'задачу', 'задачи', 'задач')}`,
  ]
  if (failed.length > 0) parts.push(`${failed.length} не получилось`)
  if (decisions.length > 0) {
    parts.push(
      `${decisions.length} ${plural(decisions.length, 'ждёт', 'ждут', 'ждут')} вашего решения`,
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Сегодня</h1>
          <p className="m-0 mt-0.5 truncate text-[12px] text-tx2">{parts.join(' · ')}</p>
        </div>
        <TeamStrip workers={data?.workers ?? []} />
      </header>

      {state.isError ? <OfflineLine /> : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-6">
          <KpiStrip kpis={data?.kpis} accounts={data?.spend.accounts ?? []} />
          {actProblem ? <p className="m-0 px-0.5 text-[12px] text-err-tx">{actProblem}</p> : null}
          <DayFeed
            decisions={decisions}
            failed={failed}
            finished={finished}
            waiting={waiting}
            selectedId={selectedId}
            onOpen={setSelectedId}
            onAct={act}
          />
        </div>

        {selectedId ? <TaskPanel taskId={selectedId} onClose={() => setSelectedId(null)} /> : null}
      </div>
    </section>
  )
}
