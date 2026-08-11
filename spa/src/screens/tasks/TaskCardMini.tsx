import { accentFor, initialOf } from '../../shell/format'
import type { BoardCard } from './Board'

/**
 * TaskCardMini — one task, as small as it can be while still being worth reading.
 *
 * A card carries only what decides whether a person looks closer: the name, who is on it,
 * whether it has been waiting too long, and — on a card that did not make it — the
 * daemon's own words for why. Everything else is one click away in the panel.
 *
 * Every value on it is a TEXT node. The reading's strings are put on the glass as text and
 * never as markup: a title is a title, not a small program.
 *
 * The card is a button in everything but the tag — it cannot BE a button, because the two
 * decisions live inside it and a button inside a button is not a thing. So it carries the
 * role and the keys of one instead, and the inner buttons stop the click from reaching it.
 */

function RoleChip({ role, title }: { role: string | null; title: string }) {
  return (
    <span
      title={role ?? 'без направления'}
      className={`flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] text-[9px] font-bold ${accentFor(
        role ?? title,
      )}`}
    >
      {initialOf(role ?? title)}
    </span>
  )
}

/** How long it has been stuck. Hours all the way — past a day the minutes stop mattering. */
function stuckLabel(hours: number): string {
  const whole = Math.max(1, Math.round(hours))
  return `застряла · ${whole} ч`
}

export function TaskCardMini({
  card,
  selected,
  showMachine,
  busy,
  onOpen,
  onApprove,
}: {
  card: BoardCard
  selected: boolean
  showMachine: boolean
  /** An accept is in flight for this card — the buttons stop asking twice. */
  busy: boolean
  onOpen: (id: string) => void
  onApprove: (id: string) => void
}) {
  const tone = selected
    ? 'border-blue bg-blue-s'
    : card.reason
      ? 'border-err-bd bg-err-s'
      : 'border-bd bg-card hover:bg-card-hov'

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={card.title}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(card.id)
        }
      }}
      className={`relative flex-none cursor-pointer overflow-hidden rounded-[11px] border px-3.5 py-3 shadow-panel ${tone}`}
    >
      {card.live ? (
        <span aria-hidden className="absolute top-0 bottom-0 left-0 w-[3px] animate-pulse bg-teal" />
      ) : null}

      <div className={`text-[13px] leading-[1.4] ${card.past ? 'text-tx2' : 'text-tx'}`}>{card.title}</div>

      {card.reason ? <div className="mt-1.5 text-[11.5px] text-err-tx">{card.reason}</div> : null}

      {/* Простой без причины — анти-паттерн, снятый разведкой 11.08: карточка, которую
          никто не заберёт, говорит почему, тем же тоном, что «застряла». */}
      {card.idle ? <div className="mt-1.5 text-[11.5px] leading-[1.35] text-warn-tx">{card.idle}</div> : null}

      <div className="mt-2.5 flex items-center gap-2">
        <RoleChip role={card.role} title={card.title} />
        <span className="min-w-0 truncate text-[11.5px] text-tx2">{card.role ?? 'без направления'}</span>
        <span className="flex-1" />
        {card.agedForHours ? (
          <span className="flex-none rounded-full bg-warn-s px-2 py-px text-[10px] whitespace-nowrap text-warn-tx">
            {stuckLabel(card.agedForHours)}
          </span>
        ) : card.note ? (
          <span className="flex-none text-[11px] whitespace-nowrap text-tx3 tabular-nums">{card.note}</span>
        ) : null}
        {showMachine ? (
          <span className="flex-none rounded-full border border-bd2 px-[7px] py-px text-[10px] whitespace-nowrap text-tx2">
            {card.machine}
          </span>
        ) : null}
      </div>

      {card.decision ? (
        <div className="mt-2.5 flex gap-[7px]">
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              onApprove(card.id)
            }}
            className="rounded-[7px] bg-blue px-[11px] py-1 text-[11px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            Принять
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(card.id)
            }}
            className="rounded-[7px] border border-bd2 px-[11px] py-1 text-[11px] text-tx2 hover:text-tx"
          >
            Вернуть
          </button>
        </div>
      ) : null}
    </div>
  )
}
