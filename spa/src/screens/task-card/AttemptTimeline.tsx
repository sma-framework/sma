import { useState } from 'react'
import type { TaskAttempt } from '../../api/types'
import { clockLabel, receiptChecks } from '../../shell/format'

/**
 * AttemptTimeline — the whole history of one task, in the order it happened.
 *
 * Every run at the task is a row: when it started, how it ended, and — one click away — the
 * receipt it ended with. A retry is not a new story but the next row of the same one, which
 * is why the chain is read top to bottom and never re-sorted.
 *
 * ═══════════════ WHAT THE PERSON SAID SITS WHERE THEY SAID IT ═══════════════
 *
 * A returned task carries the comment that sent it back. The read model builds those
 * comments by walking the attempts that ended in «возвращена», in order — so the n-th
 * comment belongs to the n-th returned run, and this is where it is shown: under that run,
 * not in a pile at the bottom. If the two ever fall out of step, the row simply carries no
 * comment; nothing is guessed.
 *
 * Nothing on this timeline is markup. A failure reason, a receipt figure and a person's own
 * comment all reach the glass as text nodes.
 */

/** How a run ended, in words. A run still going says so; a run that failed says why. */
function outcomeWords(attempt: TaskAttempt): string {
  if (attempt.outcome === 'returned') return 'возвращена на доработку'
  if (attempt.outcome === 'completed' || attempt.outcome === 'approved') return 'готово'
  if (attempt.outcome === 'failed') return attempt.reasonLabel ?? 'не получилось, причина не записана'
  if (attempt.reasonLabel) return attempt.reasonLabel
  return attempt.endedAt ? 'завершён' : 'идёт сейчас'
}

/** The colour of the mark beside a row — the same three tones the rest of the window uses. */
function dotTone(attempt: TaskAttempt): string {
  if (attempt.outcome === 'failed') return 'bg-err'
  if (attempt.outcome === 'returned') return 'bg-warn'
  if (attempt.outcome === 'completed' || attempt.outcome === 'approved') return 'bg-green'
  return 'bg-blue'
}

function Checks({ attempt }: { attempt: TaskAttempt }) {
  const checks = receiptChecks(attempt.receipt)
  if (checks.length === 0) {
    return <p className="m-0 text-[12px] text-tx3">Квитанции нет — проверки не дошли до записи.</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {checks.map((c) => (
        <div key={c.text} className="flex justify-between gap-3.5 text-[12px]">
          <span className="text-tx2">{c.text}</span>
          <span className={c.ok ? 'flex-none text-ok-tx' : 'flex-none text-err-tx'}>{c.ok ? '✓' : '✗'}</span>
        </div>
      ))}
    </div>
  )
}

function Row({
  attempt,
  note,
  last,
}: {
  attempt: TaskAttempt
  /** The comment that sent this run back, when this run was sent back. */
  note: string | null
  last: boolean
}) {
  const [open, setOpen] = useState(false)
  const who = [attempt.workerId, attempt.provider].filter(Boolean).join(' · ')

  return (
    <div className="flex gap-3.5">
      <div className="w-[76px] flex-none pt-px text-right text-[11px] text-tx3 tabular-nums">
        {clockLabel(attempt.startedAt)}
      </div>
      <div className="relative flex w-4 flex-none justify-center">
        <div className={`absolute top-0 left-1/2 w-px bg-bd2 ${last ? 'h-3' : 'bottom-0'}`} />
        <div className={`relative z-10 mt-1 h-[7px] w-[7px] flex-none rounded-full ${dotTone(attempt)}`} />
      </div>
      <div className="min-w-0 flex-1 pb-6">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-baseline gap-2 text-left"
        >
          <span className="text-[12.5px] text-tx">
            Подход {attempt.attempt ?? '—'} · {outcomeWords(attempt)}
          </span>
          <span aria-hidden className="text-[9px] text-tx3">
            {open ? '▾' : '▸'}
          </span>
        </button>

        {who ? <div className="mt-1 text-[11px] text-tx3">{who}</div> : null}

        {open ? (
          <div className="mt-2.5 max-w-[440px] rounded-[9px] border border-bd bg-surf px-3.5 py-3">
            <div className="mb-2 flex justify-between gap-3.5 text-[11px] text-tx3 tabular-nums">
              <span>начат {clockLabel(attempt.startedAt)}</span>
              <span>завершён {clockLabel(attempt.endedAt)}</span>
            </div>
            <Checks attempt={attempt} />
          </div>
        ) : null}

        {note ? (
          <div className="mt-2.5 max-w-[440px] rounded-[10px] border border-bd bg-surf px-3.5 py-2.5">
            <div className="mb-1 text-[10.5px] text-tx3">Вы вернули с комментарием</div>
            <div className="text-[12.5px] leading-[1.5] text-tx">{note}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AttemptTimeline({
  attempts,
  returnedNotes,
}: {
  attempts: TaskAttempt[]
  returnedNotes: string[]
}) {
  if (attempts.length === 0) {
    return <p className="m-0 text-[12.5px] text-tx3">Работа ещё не начиналась — задача ждёт своей очереди.</p>
  }

  // The n-th comment belongs to the n-th run that was sent back — the order the read model
  // built them in. A run that is not a return takes no comment.
  let returned = 0

  return (
    <div className="flex flex-col">
      {attempts.map((a, i) => {
        const note = a.outcome === 'returned' ? (returnedNotes[returned++] ?? null) : null
        return (
          <Row
            key={`${a.attempt ?? i}-${a.startedAt ?? i}`}
            attempt={a}
            note={note}
            last={i === attempts.length - 1}
          />
        )
      })}
    </div>
  )
}
