import { useMemo, useState } from 'react'
import { useStateQuery } from '../../api/queries'
import type { CostPoint, MachineRow } from '../../api/types'
import { BudgetDialog } from './BudgetDialog'
import { SpendTable, formatEur, formatTokens } from './SpendTable'
import type { SpendRow } from './SpendTable'
import { WindowBars, accountWindows } from './WindowBars'

/**
 * «Расходы» — the one screen in the window where money is allowed to appear.
 *
 * Everywhere else the product speaks in windows and percentages, because that is what the
 * work actually costs: the plans are already paid for. Here, and only here, the paid
 * fallback is counted in euros — in one compact block, UNDER the windows, so the rare
 * question does not shout down the common one.
 *
 * ═══════════════ THE CONVERSATION PAYS FOR ITSELF, IN PUBLIC ═══════════════
 *
 * Talking to the team lead spends a real window. The daemon books that spend under a
 * reserved task id, and this screen groups by that prefix into a line of its own: «Разговор»
 * stands beside the working lanes on the day it happened. A conversation whose cost was
 * folded into the day's total would be a conversation a person cannot decide about — the
 * point of the line is that an evening of talking is visible the same evening.
 *
 * When nothing was said that day the line is simply absent. An empty «Разговор 0» would
 * teach a person to stop reading the table.
 *
 * Everything here comes from the ONE reading. The screen asks the daemon nothing of its own.
 */

/**
 * The reserved prefix a conversation's spend is booked under. It is the daemon's own
 * contract, written down here as the one thing this screen believes about an identifier.
 */
const CONVERSATION_PREFIX = 'chat-'

/** How many days back the history is drawn. */
const DAYS = 14

const isConversation = (p: CostPoint): boolean => (p.taskId ?? '').startsWith(CONVERSATION_PREFIX)

/** A day as the daemon names it, so a calendar day and a point find each other. */
function dayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/** The same day, as a person reads it off a chart. */
function dayLabel(key: string): string {
  const [, m, d] = key.split('-')
  return d && m ? `${d}.${m}` : key
}

/** The last N calendar days, oldest first — a day with no work is a real zero, not a gap. */
function lastDays(count: number): string[] {
  const today = new Date()
  const out: string[] = []
  for (let back = count - 1; back >= 0; back -= 1) {
    const at = new Date(today)
    at.setDate(today.getDate() - back)
    out.push(dayKey(at))
  }
  return out
}

function Pill({ value, label, tone = 'text-tx' }: { value: string; label: string; tone?: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className={`text-[16px] font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

/**
 * The paid channel in one block: what today cost, what the month has cost, and how much of
 * the ceiling is gone. The ceiling bar changes colour before it is reached, not after.
 *
 * The ceiling is also the one number on this screen a person may MOVE — the money boundary is
 * the founder's own to draw, and it is drawn here, where the spending it governs is visible,
 * behind a dialog. It is machine-wide: there is exactly one budget stop in this product and it
 * is the one the fallback rule reads.
 */
function FallbackCard({
  todayEur,
  monthEur,
  capEur,
  switchMode,
}: {
  todayEur: number
  monthEur: number
  capEur: number
  switchMode: 'subscription' | 'api'
}) {
  const [editing, setEditing] = useState(false)
  const pct = capEur > 0 ? Math.max(0, Math.min(100, (monthEur / capEur) * 100)) : 0
  const tone = pct >= 90 ? 'bg-err' : pct >= 70 ? 'bg-warn' : 'bg-green'

  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="m-0 text-[14px] font-semibold text-tx">
          Запасной канал <span className="text-[12px] font-medium text-tx3">(платный)</span>
        </h2>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex-none rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] whitespace-nowrap text-tx2 hover:border-blue hover:text-blue"
        >
          Изменить потолок
        </button>
      </div>

      <div className="mb-5 flex gap-3.5">
        <div className="flex-1 rounded-[10px] border border-bd bg-surf px-4 py-3">
          <div className="mb-1 text-[10.5px] text-tx3">Сегодня</div>
          <div className="text-[18px] font-bold text-tx tabular-nums">{formatEur(todayEur)}</div>
        </div>
        <div className="flex-1 rounded-[10px] border border-bd bg-surf px-4 py-3">
          <div className="mb-1 text-[10.5px] text-tx3">Месяц</div>
          <div className="text-[18px] font-bold text-tx tabular-nums">
            {formatEur(monthEur)}
            {capEur > 0 ? <span className="text-[12.5px] font-medium text-tx3"> из {formatEur(capEur)}</span> : null}
          </div>
        </div>
      </div>

      {capEur > 0 ? (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-track"
          role="progressbar"
          aria-label="Месячный потолок расходов"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <p className="m-0 text-[12.5px] text-tx3">
          Потолок — ноль. Это не «без ограничения»: платный канал не используется вовсе, и при
          закрытых окнах работа ждёт их открытия, а не уходит за деньги. Это состояние, в котором
          SMA приезжает.
        </p>
      )}

      <p className="m-0 mt-4 text-[12.5px] text-tx2">
        {switchMode === 'api'
          ? 'Сейчас включён платный канал: окна подписок исчерпаны, работа идёт за деньги.'
          : 'Сейчас работа идёт по подпискам — платный канал молчит.'}
      </p>

      <p className="m-0 mt-2 text-[11.5px] leading-[1.55] text-tx3">
        Бюджет-стоп один на всю машину: пока месячные расходы под потолком, машина может уходить
        на платный канал; как только дошли — перестаёт. Тот же потолок виден среди правил.
      </p>

      {editing ? <BudgetDialog current={capEur} onClose={() => setEditing(false)} /> : null}
    </section>
  )
}

/**
 * The history, and the day the table below is about. Height is TOKENS — the figure every
 * session books, subscription or not. A chart drawn in euros would show a fortnight of real
 * work on the plans as fourteen empty columns.
 */
function DayChart({
  days,
  totals,
  selected,
  onSelect,
}: {
  days: string[]
  totals: Map<string, { tokens: number; eur: number }>
  selected: string
  onSelect: (day: string) => void
}) {
  const peak = Math.max(1, ...days.map((d) => totals.get(d)?.tokens ?? 0))

  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <h2 className="m-0 mb-1 text-[14px] font-semibold text-tx">Последние {DAYS} дней</h2>
      <p className="m-0 mb-4 text-[11.5px] text-tx3">
        Высота столбца — токены за день. Выберите день, чтобы увидеть, куда он ушёл.
      </p>
      <div className="flex h-[92px] items-end gap-1.5">
        {days.map((day) => {
          const total = totals.get(day) ?? { tokens: 0, eur: 0 }
          const height = Math.max(3, Math.round((total.tokens / peak) * 88))
          const active = day === selected
          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelect(day)}
              aria-pressed={active}
              aria-label={`${dayLabel(day)}: ${formatTokens(total.tokens)} токенов${
                total.eur > 0 ? `, ${formatEur(total.eur)}` : ', по подписке'
              }`}
              title={`${dayLabel(day)} · ${formatTokens(total.tokens)} токенов${
                total.eur > 0 ? ` · ${formatEur(total.eur)}` : ''
              }`}
              className="flex h-full min-w-0 flex-1 cursor-pointer flex-col justify-end border-0 bg-transparent p-0"
            >
              <span
                aria-hidden
                className={`w-full rounded-t-[3px] ${active ? 'bg-teal' : 'bg-teal/40'}`}
                style={{ height: `${height}px` }}
              />
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex gap-1.5">
        {days.map((day) => (
          <span key={day} className="min-w-0 flex-1 text-center text-[10px] text-tx3 tabular-nums">
            {dayLabel(day)}
          </span>
        ))}
      </div>
    </section>
  )
}

export function Screen() {
  const state = useStateQuery()
  const data = state.data
  const [pickedDay, setPickedDay] = useState<string | null>(null)

  const series: CostPoint[] = data?.costs.series ?? []
  const machines: MachineRow[] = data?.machines ?? []
  const fallback = data?.costs.apiFallback ?? {
    todayEur: 0,
    monthEur: 0,
    capEur: 0,
    switchMode: 'subscription' as const,
  }

  const days = useMemo(() => lastDays(DAYS), [])
  const selected = pickedDay && days.includes(pickedDay) ? pickedDay : days[days.length - 1]

  /** What each day of the window came to — one pass over the points, shared by chart and pills. */
  const totals = useMemo(() => {
    const out = new Map<string, { tokens: number; eur: number }>()
    for (const p of series) {
      const cur = out.get(p.day) ?? { tokens: 0, eur: 0 }
      cur.tokens += (p.tokensIn ?? 0) + (p.tokensOut ?? 0)
      cur.eur += p.eur ?? 0
      out.set(p.day, cur)
    }
    return out
  }, [series])

  const ofDay = useMemo(() => series.filter((p) => p.day === selected), [series, selected])

  /**
   * The day's lanes: one row per account for the ordinary work, and — only when something
   * was actually said — one row for the conversation, grouped by the reserved prefix.
   */
  const laneRows = useMemo((): SpendRow[] => {
    const byAccount = new Map<string, SpendRow>()
    let chat: SpendRow | null = null

    for (const p of ofDay) {
      const tokens = (p.tokensIn ?? 0) + (p.tokensOut ?? 0)
      if (isConversation(p)) {
        chat = chat ?? {
          key: CONVERSATION_PREFIX,
          label: 'Разговор',
          note: 'вопросы команде — считаются отдельно от задач',
          tokens: 0,
          eur: 0,
          conversation: true,
        }
        chat.tokens += tokens
        chat.eur += p.eur ?? 0
        continue
      }
      const row = byAccount.get(p.account) ?? { key: p.account, label: p.account, tokens: 0, eur: 0 }
      row.tokens += tokens
      row.eur += p.eur ?? 0
      byAccount.set(p.account, row)
    }

    const lanes = [...byAccount.values()].sort((a, b) => b.tokens - a.tokens)
    return chat ? [...lanes, chat] : lanes
  }, [ofDay])

  /** The same day by machine — drawn only when there is more than one machine to tell apart. */
  const machineRows = useMemo((): SpendRow[] => {
    if (machines.length < 2) return []
    const titleOf = new Map(machines.map((m) => [m.id, m.title]))
    const out = new Map<string, SpendRow>()
    for (const p of ofDay) {
      const id = p.machine ?? machines[0].id
      const row = out.get(id) ?? { key: id, label: titleOf.get(id) ?? id, tokens: 0, eur: 0 }
      row.tokens += (p.tokensIn ?? 0) + (p.tokensOut ?? 0)
      row.eur += p.eur ?? 0
      out.set(id, row)
    }
    return [...out.values()].sort((a, b) => b.tokens - a.tokens)
  }, [ofDay, machines])

  const windows = useMemo(() => accountWindows(data?.spend.accounts ?? [], data?.workers ?? []), [data])

  const todayTokens = totals.get(days[days.length - 1])?.tokens ?? 0
  const capShare = fallback.capEur > 0 ? fallback.monthEur / fallback.capEur : 0

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Расходы</h1>
        <Pill value={formatEur(fallback.todayEur)} label="платный канал сегодня" />
        <Pill
          value={formatEur(fallback.monthEur)}
          label={fallback.capEur > 0 ? `из ${formatEur(fallback.capEur)} в месяц` : 'за месяц'}
          tone={capShare >= 0.9 ? 'text-err-tx' : capShare >= 0.7 ? 'text-warn-tx' : 'text-tx'}
        />
        <Pill value={formatTokens(todayTokens)} label="токенов сегодня" />
      </header>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Связь потеряна. Показан последний расход, который был виден.</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-7 pt-6 pb-8">
        <WindowBars windows={windows} />
        <FallbackCard
          todayEur={fallback.todayEur}
          monthEur={fallback.monthEur}
          capEur={fallback.capEur}
          switchMode={fallback.switchMode}
        />
        <DayChart days={days} totals={totals} selected={selected} onSelect={setPickedDay} />
        <SpendTable
          title={`Куда ушла работа · ${dayLabel(selected)}`}
          rows={laneRows}
          empty="В этот день ничего не тратилось."
        />
        {machineRows.length > 0 ? (
          <SpendTable
            title={`По машинам · ${dayLabel(selected)}`}
            rows={machineRows}
            empty="В этот день ни одна машина ничего не потратила."
          />
        ) : null}
      </div>
    </section>
  )
}
