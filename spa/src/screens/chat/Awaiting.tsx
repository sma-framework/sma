import { useState } from 'react'
import { useDecisionAnswer, usePhaseIndexQuery, usePhaseQuery } from '../../api/queries'
import type { PhaseIndexRow } from '../../api/types'
import { DecisionCard, EMPTY_DRAFT, isOpen } from '../../shell/DecisionCard'
import type { DecisionDraft } from '../../shell/DecisionCard'
import { refusalWords } from '../../shell/format'

/**
 * Awaiting — «Ждут ответа»: the questions the machine stopped on, above the conversation.
 *
 * ═══════════════ THE SAME CARD, BECAUSE IT IS THE SAME ACT ═══════════════
 *
 * A discussion round asks; an executor stops at a decision and asks. To the person answering
 * those are one act, so the card is the shell's `DecisionCard` — BORROWED, not copied. This
 * file owns where the questions are found and what happens after an answer; how a question
 * looks and what counts as an answer belong to the card, in one place, for every screen.
 *
 * ═══════════════ WHY THE QUESTIONS ARE FOUND IN TWO STEPS ═══════════════
 *
 * The index says which phases have open questions and how many; only a phase's own card
 * carries the questions themselves. So the index is read once for everybody, and one child is
 * mounted per phase that actually has something open — a hook per phase, at the only place
 * where React lets a hook be per-phase. Phases with nothing open cost one row of the index
 * and no request at all.
 *
 * ═══════════════════════ IT IS SILENT WHEN IT IS EMPTY ═══════════════════════
 *
 * With nothing open this renders NOTHING — not a card that says «вопросов нет». The
 * conversation is the founder's main window; a permanent empty box at the top of it is a
 * thing to scroll past every day. It appears when there is something to answer and leaves
 * when there is not.
 */
export function Awaiting({ onOpenAttachment }: { onOpenAttachment?: (rel: string) => void }) {
  const index = usePhaseIndexQuery()
  const waiting = (index.data?.phases ?? []).filter((p) => p.open > 0)

  if (waiting.length === 0) return null

  const total = waiting.reduce((sum, p) => sum + p.open, 0)

  return (
    <section className="mx-auto flex w-full max-w-[800px] flex-col gap-3 px-7 pt-5">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-[11px] font-semibold tracking-[0.09em] text-tx3 uppercase">
          Ждут ответа
        </h2>
        <span className="text-[11.5px] text-tx3">
          {total === 1 ? 'один вопрос' : `вопросов: ${total}`} — работа стоит, пока Вы не ответите
        </span>
      </div>

      {waiting.map((row) => (
        <PhaseQuestions key={row.id} row={row} onOpenAttachment={onOpenAttachment} />
      ))}
    </section>
  )
}

/**
 * The open questions of ONE phase.
 *
 * The index said this phase has some; the card is what carries them. When the card disagrees
 * — it was read a moment later and the last one has just been answered — this renders nothing
 * rather than an empty frame, and the index catches up on its own rhythm.
 */
function PhaseQuestions({
  row,
  onOpenAttachment,
}: {
  row: PhaseIndexRow
  onOpenAttachment?: (rel: string) => void
}) {
  const card = usePhaseQuery(row.id)
  const answer = useDecisionAnswer()

  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({})
  const [problem, setProblem] = useState<Record<string, string>>({})

  const open = (card.data?.questions ?? []).filter(isOpen)
  if (open.length === 0) return null

  const send = (questionId: string, taskId: string | undefined, input: { optionId?: string; freeText?: string }) => {
    setProblem((was) => ({ ...was, [questionId]: '' }))
    answer.mutate(
      { phase: row.id, questionId, ...(taskId ? { taskId } : {}), ...input },
      {
        // The phase family is re-read by the action itself. Clearing the draft only on a
        // success means a refused answer keeps every word the person typed.
        onSuccess: () => setDrafts((was) => ({ ...was, [questionId]: EMPTY_DRAFT })),
        onError: (err) => setProblem((was) => ({ ...was, [questionId]: refusalWords(err) })),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-tx">{card.data?.name ?? row.name}</span>
        {card.data?.uatDocument && onOpenAttachment ? (
          <button
            type="button"
            onClick={() => onOpenAttachment(card.data!.uatDocument!.path)}
            className="text-[11.5px] font-medium text-blue hover:text-teal"
          >
            приёмка фазы
          </button>
        ) : null}
      </div>

      {open.map((q) => (
        <DecisionCard
          key={q.id}
          question={q}
          draft={drafts[q.id] ?? EMPTY_DRAFT}
          busy={answer.isPending && answer.variables?.questionId === q.id}
          problem={problem[q.id] || null}
          onDraft={(draft) => setDrafts((was) => ({ ...was, [q.id]: draft }))}
          onAnswer={(input) => send(q.id, q.taskId, input)}
        />
      ))}
    </div>
  )
}
