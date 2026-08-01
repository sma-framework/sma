import { useState } from 'react'
import type { DoneRow, QueueRow, ReceiptSummary } from '../../api/types'
import {
  accentFor,
  attemptsLabel,
  clockLabel,
  hoursLabel,
  initialOf,
  plural,
  receiptChecks,
} from '../../shell/format'

/**
 * DayFeed — what happened while nobody was watching, in the order a person needs it.
 *
 * First what waits for a decision, because that is the only thing that cannot move without
 * the person. Then what did not work out, because that is the thing to know before making
 * plans. Then what was finished — each one saying what was promised and what the checks
 * said, so «готово» is never a word taken on trust. The queue comes last: it is the only
 * part of the screen that is about the future rather than the night.
 *
 * Every row on this screen came out of the one reading. Nothing here asks the daemon
 * anything of its own, and nothing here is rendered as anything but text.
 */

function LaneBadge({ lane, title }: { lane: string | null; title: string | null }) {
  const accent = accentFor(lane ?? title)
  return (
    <span
      title={lane ?? 'без направления'}
      className={`flex h-6 w-6 flex-none items-center justify-center rounded-[7px] text-[11px] font-bold ${accent}`}
    >
      {initialOf(lane ?? title)}
    </span>
  )
}

function AgedPill({ hours }: { hours: number }) {
  return (
    <span className="flex-none rounded-full bg-warn-s px-2.5 py-0.5 text-[10.5px] whitespace-nowrap text-warn-tx">
      застряла · ждёт {hoursLabel(hours)}
    </span>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">{children}</div>
}

function CheckPills({ receipt }: { receipt: ReceiptSummary }) {
  // The wording of a check belongs to the whole window, not to this feed: the card says
  // «Проверки 34 из 34» in exactly the same words.
  const pills = receiptChecks(receipt)
  if (pills.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {pills.map((p) => (
        <span
          key={p.text}
          className={
            p.ok
              ? 'rounded-full bg-ok-s px-2.5 py-[3px] text-[11px] whitespace-nowrap text-ok-tx'
              : 'rounded-full bg-err-s px-2.5 py-[3px] text-[11px] whitespace-nowrap text-err-tx'
          }
        >
          {p.text} {p.ok ? '✓' : '✗'}
        </span>
      ))}
    </div>
  )
}

function cardClass(selected: boolean): string {
  return `w-full rounded-[13px] border bg-card px-[18px] py-4 text-left shadow-panel hover:bg-card-hov ${
    selected ? 'border-blue' : 'border-bd'
  }`
}

function DecisionCard({
  row,
  selected,
  onOpen,
}: {
  row: QueueRow
  selected: boolean
  onOpen: (id: string) => void
}) {
  return (
    <button type="button" onClick={() => onOpen(row.id)} className={cardClass(selected)}>
      <div className="flex items-center gap-2.5">
        <LaneBadge lane={row.lane} title={row.title} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-tx">
          {row.title ?? 'Без названия'}
        </span>
        {row.agedForHours ? <AgedPill hours={row.agedForHours} /> : null}
      </div>
      <div className="mt-2 text-[11.5px] text-tx3">
        {row.lane ?? 'без направления'} · проверено, ждёт вашего решения
      </div>
    </button>
  )
}

function FailedCard({ row, selected, onOpen }: { row: DoneRow; selected: boolean; onOpen: (id: string) => void }) {
  const failed = row.failed
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      className={`w-full rounded-[13px] border bg-err-s px-[18px] py-4 text-left ${
        selected ? 'border-blue' : 'border-err-bd'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <LaneBadge lane={row.workerId} title={row.title} />
        <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-tx">
          <span className="font-semibold">{row.title ?? 'Без названия'}</span>
          {failed?.reasonLabel ? ` — ${failed.reasonLabel}` : ' — причина не записана'}
        </span>
      </div>
      <div className="mt-2 text-[11.5px] text-tx2">
        {attemptsLabel(failed?.attemptsCount ?? row.attempts)}, дальше не пробую, чтобы не жечь ресурс.
      </div>
    </button>
  )
}

function DoneCard({ row, selected, onOpen }: { row: DoneRow; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(row.id)} className={cardClass(selected)}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex-none text-[12px] text-ok-tx">
          ✓
        </span>
        <LaneBadge lane={row.workerId} title={row.title} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-tx">
          {row.title ?? 'Без названия'}
        </span>
        <span className="flex-none text-[11.5px] text-tx3 tabular-nums">{clockLabel(row.finishedAt)}</span>
      </div>
      {row.acceptance ? (
        <div className="mt-2.5 text-[12.5px] leading-[1.55] text-tx2">
          <span className="font-semibold text-tx">Обещано: </span>
          {row.acceptance}
        </div>
      ) : null}
      <div className="mt-2.5">
        <CheckPills receipt={row.receipt} />
      </div>
      <div className="mt-2.5 text-[11.5px] text-tx3">
        {attemptsLabel(row.attempts)}
        {row.diffStat ? ` · ${row.diffStat}` : ''}
      </div>
    </button>
  )
}

function QueueLine({ row, selected, onOpen }: { row: QueueRow; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      className={`flex w-full items-center gap-2.5 border-t border-bd px-5 py-2.5 text-left hover:bg-row-hover ${
        selected ? 'bg-row-hover' : ''
      }`}
    >
      <span className="w-5 flex-none text-[11.5px] text-tx3 tabular-nums">{row.position}</span>
      <LaneBadge lane={row.lane} title={row.title} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">{row.title ?? 'Без названия'}</span>
      {row.agedForHours ? (
        <AgedPill hours={row.agedForHours} />
      ) : (
        <span className="flex-none text-[11.5px] whitespace-nowrap text-tx3">по очереди</span>
      )}
    </button>
  )
}

export function DayFeed({
  decisions,
  failed,
  finished,
  waiting,
  selectedId,
  onOpen,
}: {
  decisions: QueueRow[]
  failed: DoneRow[]
  finished: DoneRow[]
  waiting: QueueRow[]
  selectedId: string | null
  onOpen: (id: string) => void
}) {
  const [doneOpen, setDoneOpen] = useState(true)

  const nothingAtAll =
    decisions.length === 0 && failed.length === 0 && finished.length === 0 && waiting.length === 0

  if (nothingAtAll) {
    return (
      <section className="flex flex-1 items-center justify-center rounded-[14px] border border-bd bg-card py-16 shadow-panel">
        <p className="m-0 text-[13px] text-tx2">Пока тихо — команда ждёт задач.</p>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {decisions.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionTitle>Ждут вашего решения</SectionTitle>
          {decisions.map((row) => (
            <DecisionCard key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionTitle>Не получилось</SectionTitle>
        {failed.length === 0 ? (
          <p className="m-0 px-0.5 text-[12px] text-tx3">Ничего не сломалось.</p>
        ) : (
          failed.map((row) => (
            <FailedCard key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setDoneOpen((v) => !v)}
          aria-expanded={doneOpen}
          className="flex w-full items-center gap-2.5 text-left"
        >
          <SectionTitle>{`Готово (${finished.length})`}</SectionTitle>
          <span aria-hidden className="text-[11px] text-tx3">
            {doneOpen ? '▾' : '▸'}
          </span>
        </button>
        {doneOpen ? (
          finished.length === 0 ? (
            <p className="m-0 px-0.5 text-[12px] text-tx3">Пока ничего не закрыто.</p>
          ) : (
            finished.map((row) => (
              <DoneCard key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
            ))
          )
        ) : null}
      </section>

      {waiting.length > 0 ? (
        <section className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
          <div className="px-5 py-3.5 text-[13px] font-semibold text-tx">
            {`В очереди: ${waiting.length} ${plural(waiting.length, 'задача', 'задачи', 'задач')}`}
          </div>
          {waiting.map((row) => (
            <QueueLine key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
          ))}
        </section>
      ) : null}
    </div>
  )
}
