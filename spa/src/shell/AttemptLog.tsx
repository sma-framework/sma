import { useEffect, useRef } from 'react'
import { useAttemptQuery } from '../api/queries'
import type { AttemptLogLine, AttemptLogSummaryPart, TaskAttempt } from '../api/types'
import { clockLabel } from './format'

/**
 * AttemptLog — what the worker is saying, while it is saying it.
 *
 * ═════════════════════ A LINE OF THIS LOG IS TEXT. FULL STOP. ═══════════════════════
 *
 * Every line here is output of a program that was told to do something by a person and then
 * left alone with a project. It is untrusted in the strictest sense — the daemon says so in
 * four places on the way out — and it arrives at a screen where the temptation to render it
 * «nicely» would be a way for a worker to write markup into the window of the person watching
 * it. So a line is a TEXT CHILD of `<pre>` and nothing else: no markup is parsed, no link is
 * made, nothing is highlighted. Monospaced, wrapped, exactly as written.
 *
 * ═════════════════════ THE NOTE IS READ OFF THE WHOLE LOG ═══════════════════════════
 *
 * What the worker said about its approach is stated in the first minutes and would fall off
 * the tail of any long attempt. The reader on the other side takes it off the whole file, not
 * off the tail it returns — so it is shown here as a block ABOVE the log rather than as
 * whichever line happens to be in view.
 *
 * ═════════════════════ THE EYE KEEPS ITS PLACE ══════════════════════════════════════
 *
 * New lines scroll into view only while the reader is already at the bottom. A person who has
 * scrolled up is READING something, and yanking them back down every three seconds is how a
 * live log becomes a thing people close.
 */

/** How close to the bottom still counts as «watching the end». */
const AT_BOTTOM_SLACK_PX = 24

/**
 * What each kind of summarised part is called on screen. A kind this build does not know is
 * shown WITHOUT a label rather than under a guessed one — the detail beside it is the thing
 * a person came to read, and an invented word above it would be the only lie on the row.
 */
const KIND_LABEL: Record<string, string> = {
  tool: 'инструмент',
  handoff: 'передал агенту',
  tool_result: 'ответ',
  text: 'сказал',
  thinking: 'думал',
  result: 'сессия',
  limit: 'окно',
}

/** One part of a frame, as a person reads it. Every value is a TEXT CHILD — see the header. */
function SummaryPart({ part }: { part: AttemptLogSummaryPart }) {
  const label = KIND_LABEL[part.kind]
  const bad = part.ok === false
  return (
    <div className="flex items-baseline gap-1.5">
      {label ? (
        <span
          className={`flex-none rounded px-1 py-[1px] text-[10px] ${bad ? 'bg-err-s text-err-tx' : 'bg-idle-s text-idle-tx'}`}
        >
          {label}
        </span>
      ) : null}
      {part.tool ? <span className="flex-none text-[11px] font-medium text-tx2">{part.tool}</span> : null}
      {part.subagent ? <span className="flex-none text-[11px] text-tx3">→ {part.subagent}</span> : null}
      {part.detail ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-tx3" title={part.detail}>
          {part.detail}
        </span>
      ) : null}
    </div>
  )
}

/**
 * ONE ROW. When the daemon could read the frame, the row IS the summary — that is the whole
 * point of the change: «Ход попытки» stops being timestamped machine JSON and starts saying
 * which tool ran and what was handed to whom. When it could not, the raw line is shown, which
 * is what this log has always shown and what a person can still copy out.
 */
function LogLine({ line }: { line: AttemptLogLine }) {
  const parts = line.summary ?? []
  return (
    <div className={`flex items-start gap-2 px-2.5 py-[3px] ${line.subagent ? 'border-l-2 border-idle-s pl-3' : ''}`}>
      <span className="flex-none pt-[1px] font-mono text-[10.5px] text-tx3 tabular-nums">{clockLabel(line.ts)}</span>
      {line.subagent ? (
        <span className="flex-none rounded-full bg-idle-s px-1.5 py-[1px] text-[10px] text-idle-tx">
          {line.group ? `субагент ${line.group}` : 'субагент'}
        </span>
      ) : null}
      {parts.length ? (
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          {parts.map((part, i) => (
            <SummaryPart key={i} part={part} />
          ))}
        </div>
      ) : (
        <pre className="m-0 min-w-0 flex-1 font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap text-tx2">
          {line.line}
        </pre>
      )}
    </div>
  )
}

/**
 * The tail of one attempt's log, kept fresh while the panel showing it is open.
 *
 * The rhythm is the api layer's: the read that this window already uses for a running attempt.
 * It stops when this component goes away, which is when the panel closes — a log nobody has
 * open costs nothing.
 */
export function AttemptLog({ taskId, attempt }: { taskId: string; attempt: TaskAttempt }) {
  // The identity of an attempt as the ledger mints it: the task, a «#», the run's number. The
  // client encodes it; a bare «#» would never reach the door.
  const attemptId = attempt.attempt === null ? null : `${taskId}#${attempt.attempt}`
  const log = useAttemptQuery(attemptId)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const watchingEnd = useRef(true)

  const lines = log.data?.lines ?? []

  useEffect(() => {
    const box = boxRef.current
    if (!box || !watchingEnd.current) return
    box.scrollTop = box.scrollHeight
  }, [lines.length])

  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    watchingEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_SLACK_PX
  }

  // The note also rides each attempt's own row above; showing the same sentence twice in one
  // panel reads as two different facts that happen to match.
  const note = log.data?.note && log.data.note !== attempt.approachNote ? log.data.note : null

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Ход попытки</span>
        <span className="text-[11px] text-tx3">подход {attempt.attempt ?? '—'}</span>
      </div>

      {note ? (
        <p className="mt-0 mb-2 rounded-[9px] border border-bd bg-surf px-2.5 py-2 text-[11.5px] leading-[1.55] text-tx2">
          {note}
        </p>
      ) : null}

      {log.isError ? (
        <p className="m-0 text-[12px] leading-[1.55] text-tx3">
          Стенограмма сейчас не читается. На саму работу это не влияет — она пишется на диск.
        </p>
      ) : null}

      {!log.isError && lines.length === 0 ? (
        <p className="m-0 text-[12px] text-tx3">
          {log.isLoading ? 'Открываю стенограмму…' : 'Работник пока ничего не сказал.'}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <>
          {log.data?.truncated ? (
            <p className="mt-0 mb-1.5 text-[11px] text-tx3">Начало обрезано — показан хвост.</p>
          ) : null}
          <div
            ref={boxRef}
            onScroll={onScroll}
            className="max-h-[220px] overflow-y-auto rounded-[10px] border border-bd bg-surf py-1.5"
          >
            {lines.map((line, i) => (
              <LogLine key={`${line.ts}-${i}`} line={line} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
