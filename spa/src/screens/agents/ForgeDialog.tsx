import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useForge } from '../../api/queries'
import type { DraftKind } from '../../api/types'

/**
 * ForgeDialog — the one strip that asks the forge for something, written once and BORROWED.
 *
 * ═══════════════════ THE DESCRIPTION IS DATA, FROM FIRST CHARACTER TO LAST ═══════════════
 *
 * What is typed here becomes a forge task's `description` — a field the door explicit-picks
 * out of the body and refuses everything else beside. It is never a command, never a path,
 * never a config value: the daemon builds a DRAFT from it, and a draft is a file waiting for
 * a person to approve it. Nothing typed in this box can switch anything on, and that is not
 * a promise this component makes — it is the shape of the door it knocks on.
 *
 * Three screens knock on that same door for three kinds of thing: «Агенты» for a worker,
 * «Навыки» for a skill, «Подключения» for a tool request. They borrow this strip rather than
 * copy it, exactly as «Разговор» borrows the task panel: one composer, one set of habits, one
 * place to change the wording. The kind is the caller's, the manners are this file's.
 *
 * The cap below is the door's own (2000 characters). It is written here so a person is told
 * by the box, not by a refusal after the fact.
 */

/** The longest description /api/forge accepts. Anything past this is refused at the door. */
export const DESCRIPTION_CAP = 2000

export function ForgeDialog({
  kind,
  heading,
  placeholder,
  submitLabel,
  note,
  rows = 3,
}: {
  kind: DraftKind
  /** The line above the box, in the words of the screen that borrowed the strip. */
  heading: string
  placeholder: string
  submitLabel: string
  /** The sentence under the button that says who decides — never decoration. */
  note: string
  rows?: number
}) {
  const forge = useForge()
  const [description, setDescription] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = () => {
    const text = description.trim()
    if (text.length === 0) {
      setProblem('Опишите, что нужно, — по пустому описанию черновик не собрать.')
      return
    }
    setProblem(null)
    forge.mutate(
      { kind, description: text },
      {
        onSuccess: () => {
          setDescription('')
          setSent(true)
        },
        onError: (err) => {
          setSent(false)
          setProblem(
            isNotReady(err)
              ? 'Кузница пока не принимает заявки.'
              : 'Заявка не ушла. Проверьте описание и попробуйте ещё раз.',
          )
        },
      },
    )
  }

  return (
    <div className="flex max-w-[680px] flex-col gap-3 rounded-[14px] border border-bd bg-card p-[18px] shadow-panel">
      <div className="text-[13px] font-semibold text-tx">{heading}</div>

      <textarea
        value={description}
        rows={rows}
        maxLength={DESCRIPTION_CAP}
        placeholder={placeholder}
        aria-label={heading}
        onChange={(e) => {
          setDescription(e.target.value)
          if (sent) setSent(false)
        }}
        className="w-full resize-y rounded-[9px] border border-bd bg-input px-3 py-2.5 text-[12.5px] leading-[1.5] text-tx outline-none focus:border-blue"
      />

      {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
      {sent ? (
        <p className="m-0 text-[11.5px] text-ok-tx">
          Заявка ушла в кузницу. Черновик появится в списке ниже, когда она его соберёт.
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <span className="text-[10.5px] tabular-nums text-tx3">
          {description.length} / {DESCRIPTION_CAP}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={forge.isPending}
          className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
        >
          {forge.isPending ? 'Собираем…' : submitLabel}
        </button>
      </div>

      <p className="m-0 text-[11px] leading-[1.5] text-tx3">{note}</p>
    </div>
  )
}
