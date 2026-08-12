import type { TerminalWindows, WindowFact } from '../../api/types'
import { clockLabel } from '../../shell/format'

/**
 * TerminalWindow — the subscription window of the terminal this machine is worked from.
 *
 * ═══════════ WHY THIS BLOCK EXISTS BESIDE THE ACCOUNT WINDOWS AND NOT INSIDE THEM ═══════════
 *
 * The provider does not put a percentage on the work stream the daemon spawns — there, a window
 * has a name, a health and a reset, and nothing else. It DOES put one on the status line of a
 * person's own terminal, together with the moment that window turns over, and that reading
 * counts the sessions he ran himself, which on a real machine is most of them. It is therefore
 * the only true answer in the product to «how much of the plan is left», and the whole point of
 * this block is that the figure here is the same figure his terminal shows him — carried
 * through, not recomputed.
 *
 * It stands apart from the account rows because nothing in that reading names an account. The
 * terminal's subscription and a configured worker account may be the same login or may not, and
 * quietly drawing one on the other's row would be a guess of exactly the kind the window beside
 * it just stopped making.
 *
 * A READING EXPIRES. Past the reset it carried, that window has rolled over and the old
 * percentage is about a window that no longer exists — so the row says «нет свежих данных» and
 * names the moment of the last one. It never falls back to zero: a zero reads as «the quota is
 * free», which is the opposite of what an unknown means.
 *
 * Nothing is computed here except the time left, which is the reset moment minus now.
 */

/** «3 ч 12 мин», «5 д 2 ч», «14 мин» — the same information the terminal puts in brackets. */
function leftLabel(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / (60 * 24))
  const hours = Math.floor((minutes - days * 60 * 24) / 60)
  const mins = minutes - days * 60 * 24 - hours * 60
  if (days > 0) return `${days} д ${hours} ч`
  if (hours > 0) return `${hours} ч ${mins} мин`
  return `${mins} мин`
}

/**
 * When the window turns over. A clock time alone is what every other surface in the window
 * shows, and it is right for the five-hour window — but the weekly one resets days from now,
 * and «сбросится в 17:51» read as «tonight». The day is added the moment it is not today.
 */
function whenLabel(iso: string): string {
  const at = new Date(iso)
  const now = new Date()
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  if (sameDay) return `в ${clockLabel(iso)}`
  const day = String(at.getDate()).padStart(2, '0')
  const month = String(at.getMonth() + 1).padStart(2, '0')
  return `${day}.${month} в ${clockLabel(iso)}`
}

/** One window, in the words this block uses for it. */
function Row({ label, fact, observedAt }: { label: string; fact: WindowFact; observedAt: string | null }) {
  const known = fact.status === 'open' || fact.status === 'exhausted'
  const left = known ? leftLabel(fact.resetsAt) : null

  // The percentage is drawn once, in the column beside the bar — repeating it in the sentence
  // made the row read as two different figures at a glance.
  const parts: string[] = []
  if (known && fact.resetsAt) parts.push(`сбросится ${whenLabel(fact.resetsAt)}`)
  if (left) parts.push(`осталось ${left}`)

  const text = known
    ? parts.join(' · ')
    : observedAt
      ? `нет свежих данных, последнее наблюдение в ${clockLabel(observedAt)}`
      : 'данных ещё нет'

  const pct = known && typeof fact.pct === 'number' ? Math.max(0, Math.min(100, Math.round(fact.pct))) : null
  const tone = pct === null ? 'bg-track' : pct >= 90 ? 'bg-err' : pct >= 70 ? 'bg-warn' : 'bg-blue'

  return (
    <div className="grid grid-cols-[110px_minmax(0,180px)_minmax(0,1fr)] items-center gap-4 border-b border-bd py-3 last:border-b-0">
      <span className="text-[13px] font-medium text-tx">{label}</span>
      {pct === null ? (
        <span className="text-[12px] text-tx3">—</span>
      ) : (
        <span className="flex items-center gap-2.5">
          <span
            className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-track"
            role="progressbar"
            aria-label={`${label}: израсходовано`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="w-9 flex-none text-right text-[12px] text-tx2 tabular-nums">{pct}%</span>
        </span>
      )}
      <span className={`truncate text-[12.5px] ${known ? 'text-tx2' : 'text-tx3'}`}>{text}</span>
    </div>
  )
}

export function TerminalWindow({ terminal }: { terminal: TerminalWindows | null | undefined }) {
  const t = terminal ?? {
    observed: false,
    observedAt: null,
    fiveHour: { status: 'unknown' as const, resetsAt: null, pct: null },
    week: { status: 'unknown' as const, resetsAt: null, pct: null },
  }

  return (
    <section className="rounded-[14px] border border-bd bg-card px-6 py-[22px] shadow-panel">
      <h2 className="m-0 mb-1 text-[14px] font-semibold text-tx">Окно этого терминала</h2>
      <p className="m-0 mb-4 text-[11.5px] leading-[1.55] text-tx3">
        Те же цифры, что Claude Code показывает в строке состояния Вашего терминала: сколько
        процентов окна израсходовано, когда оно сбросится и сколько до этого осталось.
      </p>

      {t.observed ? (
        <>
          <Row label="5 часов" fact={t.fiveHour} observedAt={t.observedAt} />
          <Row label="Неделя" fact={t.week} observedAt={t.observedAt} />
          <p className="m-0 mt-3.5 text-[11.5px] leading-[1.55] text-tx3">
            {t.observedAt ? `Последнее наблюдение — в ${clockLabel(t.observedAt)}. ` : ''}
            Это окно той подписки, под которой открыт Ваш терминал. Аккаунтам выше оно не
            приписывается: в том, что приходит в строку состояния, имени аккаунта нет.
          </p>
        </>
      ) : (
        <>
          <p className="m-0 text-[12.5px] text-tx2">Данных ещё нет.</p>
          <p className="m-0 mt-2 text-[11.5px] leading-[1.55] text-tx3">
            Цифра появится после первой сессии в терминале: Claude Code передаёт остаток окна в
            строку состояния уже после первого ответа модели, и SMA запоминает то, что пришло.
          </p>
        </>
      )}
    </section>
  )
}
