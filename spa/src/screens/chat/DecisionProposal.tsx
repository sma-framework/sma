import { useState } from 'react'
import type { ChatDecision } from '../../api/types'

/**
 * DecisionProposal — a task the conversation says is READY TO BE DECIDED, and the two
 * things a person can do about it, without leaving the thread.
 *
 * ═════════════════════ THE HANDS STAY TIED — SAME AS THE DRAFT ═════════════════════
 *
 * The conversation cannot approve work. What it can do is point: «этой задаче пора
 * решиться» — a proposal the daemon validated against its own registry before it left
 * (the task really awaits a decision; the title is the registry's, never the model's).
 * The buttons below press the ORDINARY approve/return doors — the very ones the task
 * panel presses — from a click handler and from nowhere else. Nothing arriving in an
 * answer, however phrased, can accept work: only the hand on this card can.
 *
 * ═══════════════════════════ ONE SPEECH ON EVERY SURFACE ═══════════════════════════
 *
 * The words are the task panel's words: «Принимаю…» while it runs, «Вернуть с
 * комментарием» with the same required note. A person who learned the card learned
 * this thread, and the other way round.
 */
export function DecisionProposal({
  decision,
  outcome,
  busy,
  returning,
  onApprove,
  onReturn,
  onOpenTask,
}: {
  decision: ChatDecision
  /** Set once the human has decided — the card then states the outcome and points at the task. */
  outcome?: 'approved' | 'returned'
  busy: boolean
  /** Which act is in flight while busy — so the pressed button speaks, not both. */
  returning: boolean
  onApprove: () => void
  onReturn: (note: string) => void
  onOpenTask: (taskId: string) => void
}) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState(decision.note ?? '')

  const openLink = decision.taskId ? (
    <button
      type="button"
      onClick={() => onOpenTask(decision.taskId!)}
      className="text-[12.5px] font-medium text-blue hover:text-teal"
    >
      Открыть
    </button>
  ) : null

  return (
    <div className="max-w-[480px] overflow-hidden rounded-[11px] border border-bd2 bg-card shadow-panel">
      <div className="flex items-center gap-2 border-b border-bd bg-surf px-3 py-2">
        <span className="text-[10.5px] tracking-[0.1em] text-tx3 uppercase">Приёмка задачи</span>
      </div>

      <div className="p-3">
        <div className="mb-2.5 text-[13.5px] font-semibold text-tx">
          {decision.title ?? 'Задача без названия'}
        </div>

        {outcome ? (
          <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] font-semibold text-ok-tx">
              {outcome === 'approved' ? 'Принято.' : 'Возвращена в работу.'}
            </span>
            {openLink}
          </div>
        ) : asking ? (
          <div className="flex flex-col gap-2">
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
                onClick={() => onReturn(note)}
                disabled={busy}
                className="flex-1 rounded-[9px] bg-blue py-2.5 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
              >
                {busy && returning ? 'Возвращаю…' : 'Вернуть с комментарием'}
              </button>
              <button
                type="button"
                onClick={() => setAsking(false)}
                className="rounded-[9px] border border-bd2 px-3.5 py-2.5 text-[12px] text-tx2 hover:text-tx"
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="rounded-[9px] bg-blue px-3.5 py-[7px] text-[12.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {/* Одна речь на всех поверхностях: пока приёмка идёт, кнопка говорит это. */}
              {busy && !returning ? 'Принимаю…' : 'Одобрить'}
            </button>
            <button
              type="button"
              onClick={() => setAsking(true)}
              disabled={busy}
              className="rounded-[9px] border border-bd2 px-3 py-[7px] text-[12.5px] text-tx2 hover:bg-row-hover hover:text-tx"
            >
              Вернуть
            </button>
            {openLink}
          </div>
        )}

        <div className="mt-2.5 text-[11px] text-tx3">
          Решение принимаете Вы — кнопки бьют в те же двери, что карточка задачи.
        </div>
      </div>
    </div>
  )
}
