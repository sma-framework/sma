import { useEffect, useState } from 'react'
import { useApprove, useReturnTask, useTaskQuery } from '../api/queries'
import type { TaskAttempt } from '../api/types'
import { AttemptLog } from './AttemptLog'
import { attemptsLabel, clockLabel, refusalWords, statusTone, statusWord } from './format'
import { openScreen } from './navigation'

/**
 * TaskPanel — one task, opened beside the day's work rather than in place of it.
 *
 * ═══════════════════════════ ONE PANEL, EVERY SCREEN ══════════════════════════
 *
 * This panel is written once and BORROWED, never copied. «Сегодня» opens it from a card in
 * the feed; «Задачи» opens the very same component from a card on the board. A person meets
 * one panel with one set of habits, and a change to it is a change everywhere on the same
 * day. It lives in the shell for the reason the registry gives: a thing two screens both
 * need is not a screen.
 *
 * It is a SHORT read: what was promised, what the checks said, how many runs at it were
 * taken, and the two decisions only a person can make. The full card — the three layers of
 * the journal and the changes themselves — is its own screen, one click away through
 * «Открыть карточку».
 *
 * The detail is read while the panel is open and not a moment before or after. Approving
 * and returning go through the same actions every other screen uses, so the picture is
 * re-read once, in the one place that knows something changed.
 *
 * Since the day the workers' transcripts became readable, the panel also shows the LATEST
 * attempt as it happens — the same short read, one layer deeper: what was promised, what the
 * runs said, and what the one still going is saying right now. It is the newest attempt and
 * only the newest: the older ones are finished work, and finished work is the card's job.
 */

/**
 * The run whose log is worth watching: the highest-numbered one. The list arrives in the
 * ledger's order and this does not depend on that order being what anybody assumes.
 */
function newestAttempt(attempts: TaskAttempt[]): TaskAttempt | null {
  let newest: TaskAttempt | null = null
  for (const a of attempts) {
    if (a.attempt === null) continue
    if (newest === null || (newest.attempt ?? -1) < a.attempt) newest = a
  }
  return newest
}

function AttemptLine({ attempt }: { attempt: TaskAttempt }) {
  const started = clockLabel(attempt.startedAt)
  const ended = clockLabel(attempt.endedAt)
  const outcome = attempt.reasonLabel ?? (attempt.endedAt ? 'завершён' : 'идёт')
  const checks = attempt.receipt
  const tests =
    checks && checks.testsTotal !== null && checks.testsPassed !== null
      ? `проверки ${checks.testsPassed} из ${checks.testsTotal}`
      : null

  return (
    <div className="flex flex-col gap-1 border-t border-bd px-3.5 py-2.5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-tx">
          Подход {attempt.attempt ?? '—'} · {outcome}
        </span>
        <span className="flex-none text-[11.5px] text-tx3 tabular-nums">
          {started} → {ended}
        </span>
      </div>
      {tests ? <span className="text-[11.5px] text-tx3">{tests}</span> : null}
      {attempt.approachNote ? (
        <span className="text-[11.5px] leading-[1.5] text-tx2">{attempt.approachNote}</span>
      ) : null}
    </div>
  )
}

export function TaskPanel({
  taskId,
  onClose,
  onOpenCard,
}: {
  taskId: string
  onClose: () => void
  /** Given by a screen that can move the window itself; otherwise the shell is asked. */
  onOpenCard?: (taskId: string) => void
}) {
  const detail = useTaskQuery(taskId)
  const approve = useApprove()
  const returnTask = useReturnTask()

  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  // A new task in the panel starts a new conversation: nothing is carried over.
  useEffect(() => {
    setReturning(false)
    setNote('')
    setProblem(null)
  }, [taskId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const task = detail.data?.task
  const status = task?.status ?? null
  const attempts = detail.data?.attempts ?? []
  const live = newestAttempt(attempts)
  const returnedNotes = detail.data?.returnedNotes ?? []
  const busy = approve.isPending || returnTask.isPending

  const canApprove = status === 'awaiting_approval'
  const canReturn = status === 'awaiting_approval' || status === 'failed' || status === 'completed'

  const openCard = () => {
    if (onOpenCard) {
      onOpenCard(taskId)
      return
    }
    openScreen({ screen: 'task-card', taskId })
  }

  const doApprove = () => {
    setProblem(null)
    approve.mutate(
      { taskId },
      {
        onSuccess: () => onClose(),
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  const doReturn = () => {
    const text = note.trim()
    if (text.length === 0) {
      setProblem('Напишите, что поправить — работник вернётся именно к этому.')
      return
    }
    setProblem(null)
    returnTask.mutate(
      { taskId, note: text },
      {
        onSuccess: () => onClose(),
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="Задача"
        className="fixed top-0 right-0 z-50 flex h-screen w-[380px] flex-col border-l border-bd bg-card shadow-menu"
      >
        <div className="flex-none border-b border-bd px-[22px] pt-[22px] pb-[18px]">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <span className={`rounded-full px-2.5 py-[3px] text-[11px] ${statusTone(status)}`}>
              {statusWord(status)}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="px-1.5 text-[15px] leading-none text-tx3 hover:text-tx"
            >
              ✕
            </button>
          </div>
          <div className="text-[14.5px] leading-[1.4] font-semibold text-tx">
            {task?.title ?? (detail.isLoading ? 'Открываю…' : 'Без названия')}
          </div>
          {task?.lane ? <div className="mt-1.5 text-[11.5px] text-tx3">{task.lane}</div> : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[22px] py-[18px]">
          {detail.isError ? (
            <p className="m-0 text-[12.5px] text-tx2">Не удалось открыть задачу. Она осталась на месте.</p>
          ) : null}

          <div>
            <div className="mb-2 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Обещано</div>
            <p className="m-0 text-[12.5px] leading-[1.6] text-tx2">
              {task?.acceptance ?? 'Ничего не обещано — задача поставлена без условий приёмки.'}
            </p>
          </div>

          {returnedNotes.length > 0 ? (
            <div>
              <div className="mb-2 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">
                Что просили поправить
              </div>
              <div className="flex flex-col gap-1.5">
                {returnedNotes.map((n, i) => (
                  <p key={`${i}-${n.slice(0, 12)}`} className="m-0 text-[12.5px] leading-[1.55] text-tx2">
                    {n}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <div className="mb-2 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">
              {attempts.length > 0 ? attemptsLabel(attempts.length) : 'Подходы'}
            </div>
            {attempts.length === 0 ? (
              <p className="m-0 text-[12.5px] text-tx3">Работа ещё не начиналась.</p>
            ) : (
              <div className="rounded-[10px] border border-bd bg-surf">
                {attempts.map((a, i) => (
                  <AttemptLine key={`${a.attempt ?? i}-${a.startedAt ?? i}`} attempt={a} />
                ))}
              </div>
            )}
          </div>

          {live ? <AttemptLog taskId={taskId} attempt={live} /> : null}

          <button
            type="button"
            onClick={openCard}
            className="self-start text-[12.5px] font-medium text-blue hover:text-blue-d"
          >
            Открыть карточку →
          </button>
        </div>

        {canApprove || canReturn ? (
          <div className="flex flex-none flex-col gap-2.5 border-t border-bd px-[22px] py-4">
            {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
            {returning ? (
              <>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Комментарий: что поправить"
                  rows={3}
                  className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={doReturn}
                    disabled={busy}
                    className="flex-1 rounded-[9px] bg-blue py-2.5 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                  >
                    Вернуть с комментарием
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReturning(false)
                      setProblem(null)
                    }}
                    className="rounded-[9px] border border-bd2 px-3.5 py-2.5 text-[12px] text-tx2 hover:text-tx"
                  >
                    Отмена
                  </button>
                </div>
              </>
            ) : (
              <div className="flex gap-2">
                {canApprove ? (
                  <button
                    type="button"
                    onClick={doApprove}
                    disabled={busy}
                    className="flex-1 rounded-[9px] bg-blue py-2.5 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                  >
                    Одобрить
                  </button>
                ) : null}
                {canReturn ? (
                  <button
                    type="button"
                    onClick={() => setReturning(true)}
                    disabled={busy}
                    className="flex-1 rounded-[9px] border border-bd2 py-2.5 text-[12px] text-tx2 hover:text-tx disabled:opacity-60"
                  >
                    Вернуть
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </>
  )
}
