import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useApprove, useDiffQuery, useRedirectTask, useReturnTask, useStateQuery, useTaskQuery } from '../../api/queries'
import type { TaskAttempt } from '../../api/types'
import {
  accentFor,
  attemptsLabel,
  clockLabel,
  hoursLabel,
  initialOf,
  receiptChecks,
  refusalWords,
  statusTone,
  statusWord,
} from '../../shell/format'
import { openScreen, useOpenedWith } from '../../shell/navigation'
import { AttemptTimeline } from './AttemptTimeline'
import { DiffSummary, DiffText } from './DiffView'
import { JournalSection } from './JournalSection'

/**
 * Steering — the composer that exists WHILE a worker holds the task (phase «Двигатель»,
 * the Hermes trio brought to the card). Text typed against live work has a DECLARED fate:
 * «Перебить сейчас» kills the run and the SAME session resumes with the correction —
 * done work stays in context; «После хода» lets the run finish and the correction rides
 * the continuation. No third, silent fate exists — that was the whole finding.
 */
function Steering({ taskId }: { taskId: string }) {
  const redirect = useRedirectTask()
  const [text, setText] = useState('')
  const [fate, setFate] = useState<string | null>(null)

  const send = (mode: 'interrupt' | 'queue') => {
    const said = text.trim()
    if (!said || redirect.isPending) return
    redirect.mutate(
      { taskId, text: said, mode },
      {
        onSuccess: (r) => {
          setText('')
          setFate(
            mode === 'interrupt'
              ? r.live
                ? 'Перебиваю ход — сессия продолжится с вашей поправкой.'
                : 'Поправка записана — ход уже не бежал, она встанет в ближайшее продолжение.'
              : 'Поправка встанет сразу после текущего хода, той же сессией.',
          )
        },
        onError: (err) => setFate(refusalWords(err)),
      },
    )
  }

  return (
    <div className="rounded-[14px] border border-bd bg-card px-6 py-[18px] shadow-panel">
      <div className="mb-2.5 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">
        Руль — работник сейчас в деле
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (fate) setFate(null)
        }}
        placeholder="Поправка к текущей работе: «нет, не так — сделай…»"
        rows={2}
        className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
      />
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => send('interrupt')}
          disabled={redirect.isPending || text.trim() === ''}
          className="rounded-[9px] bg-warn-tx px-3.5 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          ■ Перебить сейчас
        </button>
        <button
          type="button"
          onClick={() => send('queue')}
          disabled={redirect.isPending || text.trim() === ''}
          className="rounded-[9px] border border-bd2 px-3.5 py-2 text-[12px] text-tx2 hover:text-tx disabled:opacity-50"
        >
          После хода
        </button>
        {fate ? <span className="min-w-0 text-[11.5px] leading-[1.4] text-tx2">{fate}</span> : null}
      </div>
      <div className="mt-[7px] text-[11px] text-tx3">
        Сделанное не пропадёт: та же сессия продолжится с учётом поправки, без перезапуска с нуля.
      </div>
    </div>
  )
}

/**
 * «Карточка задачи» — one task in full: what was promised, what was checked, every run at
 * it, what changed, and the two decisions only a person can make.
 *
 * ═════════════════════ THE WHOLE STORY, ON ONE SCREEN ═════════════════════
 *
 * The panel that opens beside «Сегодня» is the short read; this is the long one. It is the
 * only place that shows the changes themselves and the journal — a person who wants to know
 * not just WHAT was done but WHY it went that way comes here and finds it, rather than
 * taking «готово» on trust.
 *
 * The card is opened FROM a task — from the feed, the board or the team — never from the
 * sidebar. The shell hands it the task it was opened with; opened with nothing, it says so
 * and points back at the board instead of inventing a task to show.
 *
 * Two readings feed it and no more: the task itself (which already carries the journal) and
 * its diff as plain text. The machine a task lives on is read from the picture the window
 * already holds and travels back with the decision, so approving a task that runs on another
 * machine works exactly like approving one that runs here.
 *
 * Everything on this screen is a text node. The diff and the worker's own notes are content
 * that came out of a model; they are read, never interpreted.
 */

/** When the work started and when it stopped moving — the ends of the whole story. */
function span(attempts: TaskAttempt[]): { from: string | null; to: string | null; ms: number | null } {
  const starts = attempts.map((a) => a.startedAt).filter((v): v is string => !!v)
  const ends = attempts.map((a) => a.endedAt).filter((v): v is string => !!v)
  const from = starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null
  const to = ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null
  if (!from || !to) return { from, to, ms: null }
  const ms = new Date(to).getTime() - new Date(from).getTime()
  return { from, to, ms: Number.isFinite(ms) && ms > 0 ? ms : null }
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
      <div className="mb-3 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">{title}</div>
      {children}
    </section>
  )
}

function NoTask() {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Карточка задачи</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="m-0 text-[13px] text-tx2">Карточка открывается из задачи — выберите её на доске.</p>
        <button
          type="button"
          onClick={() => openScreen({ screen: 'tasks' })}
          className="rounded-[9px] bg-blue px-[15px] py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
        >
          К задачам
        </button>
      </div>
    </section>
  )
}

export function Screen() {
  const opened = useOpenedWith()
  const taskId = opened?.taskId ?? null

  const detail = useTaskQuery(taskId)
  const diff = useDiffQuery(taskId)
  const state = useStateQuery()
  const approve = useApprove()
  const returnTask = useReturnTask()

  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)

  // The machine the task lives on comes from the reading the window already has. It is
  // passed straight back with the decision — the card never decides where a task runs.
  const machine = useMemo(() => {
    if (!taskId) return undefined
    const rows = [...(state.data?.queue ?? []), ...(state.data?.done ?? [])]
    return rows.find((r) => r.id === taskId)?.machine
  }, [state.data, taskId])

  if (!taskId) return <NoTask />

  const task = detail.data?.task
  const attempts = detail.data?.attempts ?? []
  const status = task?.status ?? null
  const busy = approve.isPending || returnTask.isPending
  const canApprove = status === 'awaiting_approval'
  const canReturn = status === 'awaiting_approval' || status === 'failed' || status === 'completed'

  const lastWithReceipt = [...attempts].reverse().find((a) => a.receipt) ?? null
  const checks = receiptChecks(lastWithReceipt?.receipt)
  const worked = span(attempts)

  const doApprove = () => {
    setProblem(null)
    approve.mutate({ taskId, machine }, { onError: (err) => setProblem(refusalWords(err)) })
  }

  const doReturn = () => {
    const text = note.trim()
    if (text.length === 0) {
      setProblem('Напишите, что поправить — работник вернётся именно к этому.')
      return
    }
    setProblem(null)
    returnTask.mutate(
      { taskId, note: text, machine },
      {
        onSuccess: () => {
          setReturning(false)
          setNote('')
        },
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <button
          type="button"
          onClick={() => openScreen({ screen: 'tasks' })}
          className="flex-none text-[12px] text-tx3 hover:text-tx2"
        >
          ← Задачи
        </button>
        <span className="flex-1" />
        {problem ? <span className="flex-none text-[11.5px] text-err-tx">{problem}</span> : null}
        {canApprove ? (
          <button
            type="button"
            onClick={doApprove}
            disabled={busy}
            className="flex-none rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            Одобрить
          </button>
        ) : null}
        {canReturn ? (
          <button
            type="button"
            onClick={() => {
              setReturning(true)
              setProblem(null)
            }}
            disabled={busy}
            className="flex-none rounded-[9px] border border-bd2 px-4 py-2 text-[12px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            Вернуть
          </button>
        ) : null}
      </header>

      {detail.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Не удалось открыть задачу. Она осталась на месте.</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-9 py-7">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-7">
          <div className="min-w-0">
            <span className={`rounded-full px-2.5 py-[3px] text-[11px] ${statusTone(status)}`}>
              {statusWord(status)}
            </span>
            <h1 className="m-0 mt-3 text-[21px] leading-[1.3] font-semibold text-tx">
              {task?.title ?? (detail.isLoading ? 'Открываю…' : 'Без названия')}
            </h1>
            <div className="mt-3 flex items-center gap-2">
              <span
                className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] text-[9.5px] font-bold ${accentFor(
                  task?.lane ?? task?.title,
                )}`}
              >
                {initialOf(task?.lane ?? task?.title)}
              </span>
              <span className="text-[12.5px] text-tx2">
                {[
                  task?.lane ?? 'без направления',
                  attempts.length > 0 ? attemptsLabel(attempts.length) : 'подходов ещё не было',
                  worked.ms !== null ? hoursLabel(worked.ms / 3600000) : null,
                  worked.to ? clockLabel(worked.to) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
            <div>
              <div className="mb-2.5 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Обещано</div>
              <p className="m-0 text-[13px] leading-[1.65] text-tx2">
                {task?.acceptance ?? 'Ничего не обещано — задача поставлена без условий приёмки.'}
              </p>
            </div>
            <div className="border-l border-bd pl-8">
              <div className="mb-2.5 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Проверено</div>
              {checks.length === 0 ? (
                <p className="m-0 text-[13px] text-tx3">Квитанции пока нет — проверять ещё нечего.</p>
              ) : (
                <div className="flex flex-wrap gap-x-2.5 gap-y-1.5 text-[13px] leading-[1.8]">
                  {checks.map((c) => (
                    <span key={c.text} className="whitespace-nowrap">
                      <span className="text-tx">{c.text}</span>{' '}
                      <span className={c.ok ? 'text-ok-tx' : 'text-err-tx'}>{c.ok ? '✓' : '✗'}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {status === 'claimed' && taskId ? <Steering taskId={taskId} /> : null}

          <div className="flex items-start gap-7">
            <div className="min-w-0 flex-1 rounded-[14px] border border-bd bg-card px-6 pt-[22px] pb-2 shadow-panel">
              <div className="mb-4 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Хронология</div>
              <AttemptTimeline attempts={attempts} returnedNotes={detail.data?.returnedNotes ?? []} taskId={taskId} />

              {returning ? (
                <div className="mb-5 flex flex-col gap-2.5 rounded-[11px] border border-bd2 bg-surf p-3.5">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Комментарий: что поправить"
                    rows={3}
                    className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setReturning(false)
                        setProblem(null)
                      }}
                      className="rounded-lg border border-bd2 px-3.5 py-2 text-[11.5px] text-tx2 hover:text-tx"
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      onClick={doReturn}
                      disabled={busy}
                      className="rounded-lg bg-blue px-4 py-2 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                    >
                      Вернуть с комментарием
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex w-[336px] flex-none flex-col gap-4">
              <DiffSummary
                text={diff.data ?? null}
                loading={diff.isLoading}
                failed={diff.isError}
                expanded={diffOpen}
                onToggle={() => setDiffOpen((v) => !v)}
              />

              <Panel title="Сколько заняло">
                <div className="text-[15px] font-semibold text-tx tabular-nums">
                  {worked.ms !== null ? hoursLabel(worked.ms / 3600000) : '—'}
                </div>
                <p className="m-0 mt-1.5 text-[11.5px] leading-[1.5] text-tx3">
                  {worked.from
                    ? `${attemptsLabel(attempts.length)} · с ${clockLabel(worked.from)} до ${clockLabel(worked.to)}`
                    : 'Работа ещё не начиналась.'}
                </p>
              </Panel>

              <Panel title="Ветка и коммиты">
                <div className="font-mono text-[11.5px] break-all text-tx2">{detail.data?.branch ?? '—'}</div>
                {(detail.data?.commits ?? []).length === 0 ? (
                  <p className="m-0 mt-2 text-[12px] text-tx3">Коммитов пока нет.</p>
                ) : (
                  <div className="mt-2.5 flex flex-col gap-1.5">
                    {(detail.data?.commits ?? []).map((c) => (
                      <div key={c} className="truncate font-mono text-[11.5px] text-tx2" title={c}>
                        {c}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          </div>

          <JournalSection journal={detail.data?.journal} attempts={attempts} />

          {diffOpen && diff.data ? <DiffText text={diff.data} /> : null}
        </div>
      </div>
    </section>
  )
}
