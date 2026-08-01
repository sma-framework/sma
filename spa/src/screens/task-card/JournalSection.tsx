import type { ReactNode } from 'react'
import type { TaskAttempt, TaskDetail } from '../../api/types'
import { clockLabel } from '../../shell/format'

/**
 * JournalSection — «Как принимались решения»: why this task went the way it went.
 *
 * ═══════════════════════ THE PROMISE MADE VISIBLE ═══════════════════════════
 *
 * Everywhere else the card answers WHAT was done. This section answers WHY, in the three
 * layers the daemon writes at the moment each decision is made — never assembled afterwards:
 *
 *   1. why the work went to this worker, in this window — the router's own reason, chosen
 *      from a closed list, so the same reason always reads as the same sentence;
 *   2. how the worker approached it — its own note, one per run at the task;
 *   3. what was remembered — which notes were loaded and which reflexes fired, by name only.
 *
 * ═══════════════════════ AN OLD TASK IS NOT A BROKEN TASK ═══════════════════
 *
 * A task older than the journal has nothing in these layers, and that is a fact the section
 * states plainly instead of leaving three blank boxes. Each layer says its own empty thing,
 * so «nothing was written» is never confused with «nothing happened».
 *
 * ═══════════════════════ A NOTE IS DATA ═════════════════════════════════════
 *
 * The worker's note is text a model wrote. It reaches the glass as a text node and by no
 * other route — no markup, no interpretation, nothing clickable made out of its content.
 */

function Layer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-3 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">{title}</div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="m-0 text-[12px] leading-[1.55] text-tx3">{children}</p>
}

/** Layer one: the router's own reason, in the words of its closed list. */
function WhyThisWay({ decisions }: { decisions: NonNullable<TaskDetail['journal']>['dispatcher'] }) {
  if (decisions.length === 0) {
    return <Empty>Решение о маршруте не записано — задача старше журнала.</Empty>
  }
  return (
    <div className="flex flex-col gap-2.5">
      {decisions.map((d, i) => (
        <div key={`${d.code ?? 'без кода'}-${d.ts ?? i}`} className="flex items-baseline gap-2.5">
          <span className="w-[42px] flex-none text-[11px] text-tx3 tabular-nums">{clockLabel(d.ts)}</span>
          <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx2" title={d.code ?? undefined}>
            {d.label ?? 'подпись к этому решению не записана'}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Layer two: what the worker chose to do, once per run at the task. */
function HowItWasApproached({ attempts }: { attempts: TaskAttempt[] }) {
  const withNote = attempts.filter((a) => typeof a.approachNote === 'string' && a.approachNote.length > 0)
  if (withNote.length === 0) {
    return <Empty>Записка о подходе появится со следующей попытки.</Empty>
  }
  return (
    <div className="flex flex-col gap-3">
      {withNote.map((a, i) => (
        <div key={`${a.attempt ?? i}-${a.startedAt ?? i}`}>
          <div className="mb-1 text-[11px] text-tx3">Подход {a.attempt ?? '—'}</div>
          <p className="m-0 text-[12.5px] leading-[1.55] text-tx2">{a.approachNote}</p>
        </div>
      ))}
    </div>
  )
}

function Ids({ label, ids }: { label: string; ids: string[] }) {
  if (ids.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-tx3">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <span key={id} className="rounded-md bg-surf px-2 py-[3px] text-[11.5px] break-all text-tx2">
            {id}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Layer three: what was remembered. Names only — never the text of a lesson. */
function WhatWasRemembered({ trace }: { trace: NonNullable<TaskDetail['journal']>['memoryTrace'] }) {
  const notes = trace?.notes ?? []
  const reflexes = trace?.reflexes ?? []
  if (notes.length === 0 && reflexes.length === 0) {
    return <Empty>Из прошлого опыта ничего не понадобилось.</Empty>
  }
  return (
    <div className="flex flex-col gap-3">
      <Ids label="Заметки, которые взяли в работу" ids={notes} />
      <Ids label="Рефлексы, которые сработали" ids={reflexes} />
    </div>
  )
}

export function JournalSection({
  journal,
  attempts,
}: {
  journal: TaskDetail['journal']
  attempts: TaskAttempt[]
}) {
  const decisions = journal?.dispatcher ?? []
  const trace = journal?.memoryTrace ?? { notes: [], reflexes: [] }
  const notes = attempts.filter((a) => typeof a.approachNote === 'string' && a.approachNote.length > 0)
  const nothingAtAll =
    decisions.length === 0 && notes.length === 0 && trace.notes.length === 0 && trace.reflexes.length === 0

  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <div className="mb-1 text-[13px] font-semibold text-tx">Как принимались решения</div>
      <p className="m-0 mb-5 text-[12px] text-tx3">
        {nothingAtAll
          ? 'Эта задача старше журнала — записи появятся со следующей попытки.'
          : 'Почему задача пошла именно так, что выбрал работник и что вспомнили из прошлого опыта.'}
      </p>

      <div className="flex items-start gap-8">
        <Layer title="Почему задача пошла так">
          <WhyThisWay decisions={decisions} />
        </Layer>
        <div className="w-px flex-none self-stretch bg-bd" />
        <Layer title="Как работник взялся за дело">
          <HowItWasApproached attempts={attempts} />
        </Layer>
        <div className="w-px flex-none self-stretch bg-bd" />
        <Layer title="Что вспомнили из опыта">
          <WhatWasRemembered trace={trace} />
        </Layer>
      </div>
    </section>
  )
}
