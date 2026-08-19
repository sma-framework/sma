import { useState } from 'react'

import { useApprove, useStateQuery } from '../../api/queries'
import type { TaskStatus } from '../../api/types'
import { waitWords } from '../../screens/tasks/units'
import { approvalRefusal, refusalWords, statusTone, statusWord } from '../format'

/**
 * NarrowTaskCard — одна задача на телефоне и единственное действие, которое телефон делает
 * сам: приёмка.
 *
 * ═══════════════ ТА ЖЕ ДВЕРЬ И ТОТ ЖЕ ГЕЙТ, ЧТО НА СТОЛЕ ═══════════════
 *
 * Кнопка «Одобрить» зовёт ТОТ ЖЕ хук приёмки, которым принимает широкое окно, — и потому
 * проходит те же проверки, оставляет тот же след и перечитывает картину тем же одним
 * перечитыванием. Своего обращения к сети в этом файле нет ни одного: до двери — только общий
 * слой окна.
 *
 * Второй путь приёмки был бы вторым местом, где можно разойтись: «быстрая приёмка без
 * вопросов» на телефоне означала бы, что одно и то же действие проходит разные проверки в
 * зависимости от того, с чего человек его нажал. Поэтому её здесь нет и не будет.
 *
 * ═══════════════ ЧЕСТНЫЙ ОТКАЗ И ЧЕСТНАЯ УДАЧА ═══════════════
 *
 * Дверь отвечает согласием и на отказ («запрос дошёл»), поэтому «не принято» приезжает не
 * ошибкой, а полем ответа — и раньше кнопка на широком окне выглядела нажавшейся впустую.
 * Здесь оба случая разделены: отказ показывается словами рядом с кнопкой и карточку не
 * закрывает, удача говорит «Принято» и ждёт нового слова состояния из следующего чтения.
 * Втихую ничего не повторяется: повтор приёмки — это решение человека, а не поведение окна.
 *
 * ═══════════════ ЧЕГО ЗДЕСЬ НЕТ — СКАЗАНО СЛОВАМИ ═══════════════
 *
 * Возврат с комментарием на телефон не вынесен: он начинается с написанного текста, а
 * набирать разбор работы пальцем на 375 px — способ отправить работника не туда. Состав
 * узкой полосы объявлен решением фазы: приёмка — единственное действие, и об этом сказано
 * строкой, а не умолчанием.
 */
export function NarrowTaskCard({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const state = useStateQuery()
  const approve = useApprove()

  /** Что помешало принять — словами двери, а не «попробуйте ещё раз» поверх её ответа. */
  const [problem, setProblem] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  const data = state.data
  /** То же правило, что в списке: пока чтение не ответило, о задаче не утверждается ничего. */
  const answered = data !== undefined

  const awaiting = (data?.awaiting ?? []).find((r) => r.id === taskId) ?? null
  const queued = (data?.queue ?? []).find((r) => r.id === taskId) ?? null
  const onWorker = (data?.workers ?? []).find((w) => w.taskId === taskId) ?? null
  const finished = (data?.done ?? []).find((r) => r.id === taskId) ?? null
  const found = awaiting ?? queued ?? onWorker ?? finished

  const title: string | null =
    awaiting?.title ?? queued?.title ?? onWorker?.taskTitle ?? finished?.title ?? null
  const project: string | null =
    awaiting?.project ?? queued?.project ?? onWorker?.project ?? finished?.project ?? null

  /**
   * СОСТОЯНИЕ — из того же одного чтения, по тому списку, в котором строка нашлась. Ростер —
   * единственный список, называющий взятую задачу; ждущие человека лежат отдельно от ждущих
   * работника, и это разделение и есть ответ на вопрос «что с ней сейчас».
   */
  const status: TaskStatus | null = awaiting
    ? 'awaiting_approval'
    : onWorker
      ? 'running'
      : queued
        ? queued.status
        : finished
          ? finished.failed
            ? 'failed'
            : 'completed'
          : null

  const waited = waitWords(awaiting?.agedForHours ?? queued?.agedForHours)
  const canApprove = status === 'awaiting_approval'
  const busy = approve.isPending

  const doApprove = () => {
    setProblem(null)
    approve.mutate(
      { taskId },
      {
        onSuccess: (out) => {
          const refused = approvalRefusal(out)
          if (refused) {
            setProblem(refused)
            return
          }
          setAccepted(true)
        },
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  return (
    <section className="flex flex-col gap-4 px-4 py-4">
      <button
        type="button"
        onClick={onBack}
        className="flex min-h-[44px] w-full items-center rounded-[10px] border border-bd2 px-3.5 text-left text-[13px] font-semibold text-tx2 focus-visible:outline-2 focus-visible:outline-blue"
      >
        ← К списку задач
      </button>

      {!answered ? (
        <p className="m-0 rounded-[10px] border border-bd bg-card px-3.5 py-4 text-[13px] leading-[1.5] text-tx2">
          Читаю задачу… Что с ней — пока неизвестно: об этом скажет первый ответ.
        </p>
      ) : !found ? (
        <p className="m-0 rounded-[10px] border border-bd bg-card px-3.5 py-4 text-[13px] leading-[1.5] text-tx2">
          Этой задачи в текущем чтении нет. Она могла закрыться или уехать в другой проект —
          вернитесь к списку и посмотрите снова.
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-[10px] border border-bd bg-card px-4 py-4">
          <span className={`self-start rounded-full px-2.5 py-[3px] text-[13px] ${statusTone(status)}`}>
            {statusWord(status)}
          </span>
          <span className="text-[15px] leading-[1.35] font-semibold text-tx">{title ?? 'Без названия'}</span>
          <span className="text-[13px] leading-[1.5] text-tx2">
            Проект: {project ?? 'неизвестен — задача поставлена раньше, чем задачи стали знать свой проект'}
          </span>
          {waited ? (
            <span className="text-[13px] leading-[1.5] text-tx2">Ждёт {waited}</span>
          ) : (
            <span className="text-[13px] leading-[1.5] text-tx3">Сколько ждёт — очередь не назвала</span>
          )}
        </div>
      )}

      {problem ? (
        <p className="m-0 rounded-[10px] border border-err-s bg-err-s px-3.5 py-2.5 text-[13px] leading-[1.5] text-err-tx">
          {problem}
        </p>
      ) : null}

      {accepted ? (
        <p className="m-0 rounded-[10px] border border-ok-s bg-ok-s px-3.5 py-2.5 text-[13px] leading-[1.5] text-ok-tx">
          Принято — работа принята, сейчас: {statusWord(status, 'перечитываю')}
        </p>
      ) : null}

      {canApprove ? (
        <button
          type="button"
          onClick={doApprove}
          disabled={busy}
          className="flex min-h-[44px] w-full items-center justify-center rounded-[10px] bg-blue px-4 text-[14px] font-semibold text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-blue"
        >
          {busy ? 'Принимаю…' : 'Одобрить'}
        </button>
      ) : null}

      <p className="m-0 text-[13px] leading-[1.5] text-tx3">
        Вернуть с комментарием — с компьютера: замечание работнику начинается с написанного
        текста, и набирать его пальцем значит отправить работника не туда. На телефоне вы
        принимаете сделанное.
      </p>
    </section>
  )
}
