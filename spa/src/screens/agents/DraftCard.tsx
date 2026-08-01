import { useState } from 'react'
import { isNotReady, isRaceLost } from '../../api/client'
import { useApprove, useToggleAgent } from '../../api/queries'
import type { DraftCard as DraftRow, TaskStatus } from '../../api/types'

/**
 * DraftCard — a forged draft, and the TWO human steps that turn it into a worker.
 *
 * ══════════════════════ «ВКЛЮЧИТЬ» IS TWO ACTS, AND STAYS TWO ══════════════════════
 *
 * The daemon requires both, in this order, and this card does not pretend otherwise:
 *
 *   1. ОДОБРИТЬ — /api/approve lands the forged definition FILE in the tree. Until a file
 *      exists there is nothing to switch on: the toggle applier reads the worker's lane,
 *      provider and model OUT OF THAT FILE and refuses an id that has none.
 *   2. ВКЛЮЧИТЬ — /api/agent/toggle writes the roster entry from the file's own fields.
 *
 * The button says «Включить» because that is what a person means; underneath it makes TWO
 * requests, one after the other, and only starts the second when the first has plainly
 * succeeded (`ok` AND `merged` — a soft-denied approval merges nothing, so nothing follows).
 * Each step owns its error. If the merge lands and the switch does not, the card says
 * «одобрен, не включён» and offers to repeat THE SECOND STEP ALONE — it never re-approves
 * work that is already approved, and it never reports a half-done activation as done.
 *
 * This is not the front guarding the door: the daemon refuses an unapproved id regardless of
 * what this card does. It is the front refusing to LIE about which of the two steps a person
 * has actually taken (T-9-48).
 *
 * Every line here is a text node. The draft's title comes from a person's own description, so
 * it is rendered as text and never as markup: no escape hatch for raw HTML is used anywhere on
 * this screen, which is the whole of the answer to a description that tries to be markup
 * (T-9-49). React escapes a text child; a description that looks like a tag reads as one.
 */

/** What the harness calls each kind of draft, in the words the window uses. */
const KIND_WORD: Record<string, string> = {
  agent: 'работник',
  skill: 'навык',
  mcp: 'инструмент',
}

const STATUS_WORD: Partial<Record<TaskStatus, string>> = {
  awaiting_approval: 'ждёт решения',
  completed: 'собран',
}

/**
 * The worker's id is the NAME OF THE FILE the forge wrote — the same name the toggle applier
 * looks for in `.claude/agents/`. It is read off the path rather than guessed from the title,
 * and a path that does not yield a plain id yields nothing at all: better an honest «не могу
 * определить» than a request the daemon will refuse for a reason nobody can see.
 */
export function idFromDraftPath(draftPath: string | null): string | null {
  if (!draftPath) return null
  const file = draftPath.split(/[\\/]/).pop() ?? ''
  const bare = file.replace(/\.md$/i, '')
  return /^[A-Za-z0-9._-]{1,64}$/.test(bare) ? bare : null
}

export function DraftCard({
  draft,
  onOpenTask,
}: {
  draft: DraftRow
  /** Opens the draft's own task card, where the forge's checks are written down. */
  onOpenTask: (taskId: string) => void
}) {
  const approve = useApprove()
  const toggle = useToggleAgent()

  /** Step one is behind us — set only after a merge the daemon confirmed. */
  const [approved, setApproved] = useState(false)
  /** Step two is behind us. */
  const [enabled, setEnabled] = useState(false)
  const [approveProblem, setApproveProblem] = useState<string | null>(null)
  const [toggleProblem, setToggleProblem] = useState<string | null>(null)

  const agentId = idFromDraftPath(draft.draftPath)
  const kindWord = draft.kind ? (KIND_WORD[draft.kind] ?? draft.kind) : 'черновик'
  const statusWord = STATUS_WORD[draft.status] ?? draft.status

  /** STEP TWO, alone. Called after a confirmed merge, and again by hand if it did not take. */
  const runToggle = () => {
    if (!agentId) {
      setToggleProblem(
        'Одобрен, но включить не могу: у черновика нет файла, по имени которого заводится работник.',
      )
      return
    }
    setToggleProblem(null)
    toggle.mutate(
      { id: agentId, enabled: true },
      {
        onSuccess: (res) => {
          if (res.agent && res.agent.enabled === false) {
            setToggleProblem('Одобрен, но остался выключенным — попробуйте включить ещё раз.')
            return
          }
          setEnabled(true)
        },
        onError: (err) =>
          setToggleProblem(
            isNotReady(err)
              ? 'Одобрен. Включение пока не работает — дверь не отвечает.'
              : 'Одобрен, но НЕ включён: включение не прошло. Можно повторить только этот шаг.',
          ),
      },
    )
  }

  /** STEP ONE, then — only on a confirmed merge — step two. */
  const activate = () => {
    setApproveProblem(null)
    setToggleProblem(null)
    approve.mutate(
      { taskId: draft.id },
      {
        onSuccess: (res) => {
          if (!res.ok || !res.merged) {
            setApproveProblem(
              res.softDenied
                ? 'Одобрение не прошло проверки — черновик не влит, включать нечего.'
                : 'Одобрение не завершилось слиянием — черновик не влит, включать нечего.',
            )
            return
          }
          setApproved(true)
          runToggle()
        },
        onError: (err) =>
          setApproveProblem(
            isNotReady(err)
              ? 'Одобрение пока не работает — дверь не отвечает.'
              : isRaceLost(err)
                ? 'Черновик уже разобрали в другом окне. Обновите список.'
                : 'Одобрить не удалось. Черновик остался черновиком.',
          ),
      },
    )
  }

  const busy = approve.isPending || toggle.isPending
  const step = approve.isPending
    ? 'Шаг 1 из 2: одобряем…'
    : toggle.isPending
      ? 'Шаг 2 из 2: включаем…'
      : null

  return (
    <article className="flex flex-col gap-3 rounded-[12px] border border-bd border-l-[3px] border-l-teal bg-card p-4 shadow-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] leading-[1.55] text-tx">
            <span className="font-semibold text-teal">Черновик: </span>
            {draft.title ?? draft.id}
          </div>
          <div className="mt-1 text-[11px] text-tx3">
            {kindWord} · {statusWord}
            {draft.draftPath ? ` · ${draft.draftPath}` : ''}
          </div>
        </div>
        <span className="flex-none rounded-full bg-idle-s px-2.5 py-1 text-[10.5px] whitespace-nowrap text-idle-tx">
          решение за Вами
        </span>
      </div>

      {/* Where the forge's own checks are written down: the draft is a task, and a task has a card. */}
      <div className="flex flex-wrap items-center gap-2">
        {enabled ? (
          <span className="rounded-[8px] bg-ok-s px-[13px] py-1.5 text-[11.5px] font-semibold text-ok-tx">
            Одобрен и включён
          </span>
        ) : (
          <button
            type="button"
            onClick={approved ? runToggle : activate}
            disabled={busy}
            className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            {approved ? 'Повторить включение' : 'Включить'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpenTask(draft.id)}
          className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
        >
          Квитанция проверок
        </button>
        {step ? <span className="text-[11.5px] text-tx2">{step}</span> : null}
      </div>

      {approved && !enabled ? (
        <p className="m-0 text-[11.5px] text-warn-tx">
          Шаг 1 пройден: черновик одобрен и влит. Шаг 2 — включение — ещё не сделан.
        </p>
      ) : null}
      {approveProblem ? <p className="m-0 text-[11.5px] text-err-tx">{approveProblem}</p> : null}
      {toggleProblem ? <p className="m-0 text-[11.5px] text-err-tx">{toggleProblem}</p> : null}

      <p className="m-0 text-[11px] leading-[1.5] text-tx3">
        Включение — это два действия: одобрить черновик и включить работника. Кнопка делает их
        по очереди и показывает каждое.
      </p>
    </article>
  )
}
