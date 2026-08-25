import type { TaskAttempt, TaskStatus, WaitingTicket } from '../../api/types'
import { clockLabel } from '../../shell/format'
import { approachEvents } from './flow'
import type { FlowTone } from './flow'

/**
 * Живой поток на экране. ЧТО показывать и в каком порядке — считает `flow.ts`, где это
 * проверяется прогоном; здесь только показ.
 */

const TONE_CLASS: Record<FlowTone, string> = {
  run: 'text-blue',
  ok: 'text-ok-tx',
  fail: 'text-err-tx',
  wait: 'text-warn-tx',
  plain: 'text-tx2',
}

export function LiveFlow({
  attempts,
  status,
  ticket,
}: {
  attempts: TaskAttempt[]
  status: TaskStatus | null
  ticket?: WaitingTicket | null
}) {
  const events = approachEvents({ attempts, status, ticket })
  const newest = events.find((e) => !!e.at)?.at ?? null

  return (
    <section data-testid="task-flow" className="rounded-[12px] border border-bd bg-card px-[15px] py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-tx">Живой поток</span>
        <span className="flex-none font-mono text-[10.5px] text-tx3">{newest ? clockLabel(newest) : 'нет данных'}</span>
      </div>
      {events.length === 0 ? (
        <p className="m-0 mt-2 text-[11.5px] leading-[1.45] text-tx3">
          Подходов ещё не было — рассказывать пока нечего.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {events.map((e) => (
            <div key={e.key} className="flex gap-2.5 font-mono text-[11px] leading-[1.45]">
              <span className="flex-none text-tx3">{e.at ? clockLabel(e.at) : '—'}</span>
              <span className={`min-w-0 ${TONE_CLASS[e.tone]}`}>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
