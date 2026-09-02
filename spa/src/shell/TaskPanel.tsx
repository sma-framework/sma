import { useEffect, useState } from 'react'
import { useApprove, useCloseTaskWithWords, useReturnTask, useTaskQuery } from '../api/queries'
import type { ClosingReason, TaskAttempt } from '../api/types'
import { CLOSING_OPTIONS, canCloseWithWords, closingNeedsWords } from '../screens/task-card/close'
import { AttemptLog } from './AttemptLog'
import {
  acceptanceList,
  approvalRefusal,
  attemptsLabel,
  clockLabel,
  refusalWords,
  statusTone,
  statusWord,
} from './format'
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
  const closeTask = useCloseTaskWithWords(taskId)

  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  /**
   * ЗАКРЫТЬ СЛОВАМИ — ЗДЕСЬ, А НЕ ТОЛЬКО НА КАРТОЧКЕ. Эта панель и есть то место, где человек
   * встречает строку, стоящую на нём: её открывают и «Сегодня», и доска, — и до сих пор она
   * предлагала ровно два выхода, оба из которых означают «эта работа будет сделана».
   */
  const [closingOpen, setClosingOpen] = useState(false)
  const [closeReason, setCloseReason] = useState<ClosingReason | null>(null)
  const [closeNote, setCloseNote] = useState('')

  // A new task in the panel starts a new conversation: nothing is carried over.
  useEffect(() => {
    setReturning(false)
    setNote('')
    setProblem(null)
    setClosingOpen(false)
    setCloseReason(null)
    setCloseNote('')
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
  // Правило одно на обе поверхности и живёт в одном месте: панель и карточка не имеют права
  // расходиться в том, какой строке выход предложен.
  const canClose = canCloseWithWords(status)

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
        // ЗАКРЫТЬСЯ МОЖНО ТОЛЬКО НА ПРИНЯТОЙ РАБОТЕ. Дверь отвечает 200 и на отказе, поэтому
        // панель раньше исчезала ровно в тот момент, когда работа НЕ принята, — человек видел
        // самый убедительный вид успеха и уходил с несделанной приёмкой. Отказ теперь держит
        // панель открытой и говорит словами, что помешало.
        onSuccess: (out) => {
          const refused = approvalRefusal(out)
          if (refused) {
            setProblem(refused)
            return
          }
          onClose()
        },
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

  /** Последнее слово о работе, которую делать не будут. Правило слов — то же, что у двери. */
  const doClose = () => {
    if (!closeReason) {
      setProblem('Выберите, чем эта работа кончается: устарело, предмета нет или сделано иначе.')
      return
    }
    const text = closeNote.trim()
    if (closingNeedsWords(closeReason) && text.length === 0) {
      setProblem('«Сделано иначе» без sha или причины нечем перепроверить — назовите их.')
      return
    }
    setProblem(null)
    closeTask.mutate(
      { taskId, reason: closeReason, ...(text === '' ? {} : { note: text }) },
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
            {/*
              ПО ОДНОМУ ПУНКТУ НА АБЗАЦ — обещанное приходит списком, а подставленное в текст как
              есть склеивалось вплотную и читалось одним предложением. Ровно так же панель уже
              показывает «что просили поправить», абзацем на замечание: одна привычка чтения на
              обе колонки.
            */}
            {acceptanceList(task?.acceptance).length === 0 ? (
              <p className="m-0 text-[12.5px] leading-[1.6] text-tx2">
                Ничего не обещано — задача поставлена без условий приёмки.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {acceptanceList(task?.acceptance).map((text, i) => (
                  <p key={`${i}-${text.slice(0, 16)}`} className="m-0 text-[12.5px] leading-[1.6] text-tx2">
                    {text}
                  </p>
                ))}
              </div>
            )}
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

        {canApprove || canReturn || canClose ? (
          // Нижний запас: подвал карточки заканчивается ВЫШЕ зоны плавающей плашки
          // разговора с системой (она висит в правом нижнем углу поверх всего окна:
          // 22px отступ + ~44px высота свёрнутой плашки + зазор). Без запаса плашка
          // накрывала кнопку «Одобрить» — кнопка была видима, но клик доставался плашке.
          // Прятать или опускать плашку нельзя: разговор обязан открываться поверх карточки.
          <div className="flex flex-none flex-col gap-2.5 border-t border-bd px-[22px] pt-4 pb-[88px]">
            {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
            {closingOpen ? (
              // ЗАКРЫТЬ СЛОВАМИ: исход из закрытого словаря двери и текст человека. Подпись
              // под каждым исходом объясняет, что он означает: три слова без объяснения — это
              // выбор наугад по работе, которую после него не вернуть нажатием.
              <>
                <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">
                  Чем эта работа кончается
                </div>
                {CLOSING_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setCloseReason(o.id)
                      setProblem(null)
                    }}
                    className={`rounded-[9px] border px-3 py-2 text-left text-[12px] ${
                      closeReason === o.id ? 'border-blue bg-blue-s text-tx' : 'border-bd bg-input text-tx2 hover:text-tx'
                    }`}
                  >
                    <span className="block font-semibold">{o.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-[1.4] text-tx3">{o.detail}</span>
                  </button>
                ))}
                <textarea
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  placeholder={
                    closingNeedsWords(closeReason)
                      ? 'Обязательно: sha коммита или причина'
                      : 'Не обязательно: чем это закрыто, одной строкой'
                  }
                  rows={2}
                  className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={doClose}
                    disabled={closeTask.isPending}
                    className="flex-1 rounded-[9px] bg-blue py-2.5 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                  >
                    {closeTask.isPending ? 'Закрываю…' : 'Закрыть работу словами'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setClosingOpen(false)
                      setProblem(null)
                    }}
                    className="rounded-[9px] border border-bd2 px-3.5 py-2.5 text-[12px] text-tx2 hover:text-tx"
                  >
                    Отмена
                  </button>
                </div>
              </>
            ) : returning ? (
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
                    {returnTask.isPending ? 'Возвращаю…' : 'Вернуть с комментарием'}
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
                    {/* Одна речь на всех поверхностях: пока приёмка идёт, кнопка говорит это. */}
                    {approve.isPending ? 'Принимаю…' : 'Одобрить'}
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
                {/* ТРЕТИЙ ВЫХОД, РЯДОМ С ДВУМЯ ПЕРВЫМИ. «Одобрить» и «Вернуть» оба означают,
                    что работа будет сделана; строке, чей предмет устарел, которой предмета
                    нет вовсе или которая сделана иначе, до сих пор нечем было сказать это
                    отсюда — и такие строки стояли в столбике ожидания сутками. */}
                {canClose ? (
                  <button
                    type="button"
                    onClick={() => {
                      setClosingOpen(true)
                      setProblem(null)
                    }}
                    disabled={busy || closeTask.isPending}
                    className="flex-1 rounded-[9px] border border-bd2 py-2.5 text-[12px] text-tx2 hover:text-tx disabled:opacity-60"
                  >
                    Закрыть словами
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
