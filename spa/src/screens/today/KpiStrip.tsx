import type { Kpis, SpendAccount } from '../../api/types'
import { plural } from './format'

/**
 * KpiStrip — the day in figures, and how much of each subscription window is spent.
 *
 * Two panels, side by side, exactly as the accepted screen puts them: the counts of the
 * work on the left, the windows on the right. The counts are the ones the reading already
 * carries — nothing is added up here, because a number computed twice is a number two
 * screens can disagree about.
 *
 * Money is deliberately absent. Sums belong to «Расходы» and are shown there once; a
 * figure repeated in two places is a figure that will one day contradict itself.
 */

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11.5px] text-tx3">{label}</span>
      <span className="text-[19px] leading-none font-semibold text-tx tabular-nums">{value}</span>
      {note ? <span className="text-[11px] text-tx3">{note}</span> : null}
    </div>
  )
}

function Bar({ label, pct }: { label: string; pct: number }) {
  const safe = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-tx2">{label}</span>
        <span className="text-[12px] text-tx tabular-nums">{safe}%</span>
      </div>
      <div
        className="h-[5px] w-full overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={safe >= 90 ? 'h-full rounded-full bg-warn' : 'h-full rounded-full bg-blue'}
          style={{ width: `${safe}%` }}
        />
      </div>
    </div>
  )
}

export function KpiStrip({ kpis, accounts }: { kpis: Kpis | undefined; accounts: SpendAccount[] }) {
  const busy = kpis?.workersBusy ?? 0
  const total = kpis?.workersTotal ?? 0
  const queued = kpis?.queued ?? 0
  const awaiting = kpis?.awaitingApproval ?? 0
  const windowsOpen = kpis?.windowsOpen ?? 0

  return (
    <section className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-[18px]">
      <div className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
        <div className="mb-4 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">День в цифрах</div>
        <div className="grid grid-cols-4 gap-4">
          <Figure
            label="Работают"
            value={`${busy} / ${total}`}
            note={total > 0 ? `свободны ${Math.max(0, total - busy)}` : undefined}
          />
          <Figure label="В очереди" value={String(queued)} />
          <Figure label="Ждут решения" value={String(awaiting)} />
          <Figure
            label="Открыты окна"
            value={String(windowsOpen)}
            note={`${windowsOpen} ${plural(windowsOpen, 'окно принимает работу', 'окна принимают работу', 'окон принимают работу')}`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3.5 rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
        <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Окна подписок</div>
        {accounts.length === 0 ? (
          <p className="m-0 text-[12.5px] text-tx3">Ни одно окно пока не заведено.</p>
        ) : (
          accounts.map((a) => (
            <div key={a.name} className="flex flex-col gap-2">
              <div className="text-[12.5px] font-semibold text-tx">{a.name}</div>
              <Bar label="Пять часов" pct={a.pct5h} />
              <Bar label="Неделя" pct={a.pctWeek} />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
