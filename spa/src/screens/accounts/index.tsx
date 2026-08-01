import { useStateQuery } from '../../api/queries'
import type { AccountEntry } from '../../api/types'
import { openScreen } from '../../shell/navigation'
import { AccountRow } from './AccountRow'

/**
 * «Аккаунты» — every subscription in the household, its windows, and the machine each one
 * lives on.
 *
 * ══════════════════ ONE ACCOUNT LIVES ON EXACTLY ONE MACHINE ══════════════════
 *
 * This is the screen that makes that law visible. Machines in this household share their
 * VIEWS of the work and never their credentials, so a subscription is logged in in one place
 * and one place only — and the machine binding is therefore not a technical footnote but the
 * answer to the commonest question a person has here: why did that account do nothing last
 * night. The line under every row says where it lives, before it is asked.
 *
 * ═══════════════════════ NO SECRET EVER REACHES THIS SCREEN ═══════════════════════
 *
 * An account travels by NAME. The reading carries no token, no name of the variable holding
 * one, and no local path — by construction, in the derive, not by a filter applied here. So
 * there is nothing on this screen for a person to hide from a shoulder, and nothing in the
 * payload for the household network to leak.
 *
 * ════════════════ WINDOWS ARE PERCENTAGES; MONEY GETS ONE LINE ════════════════
 *
 * The subscriptions are already paid for, so what matters is how much of each window is
 * left. The paid channel is the exception and it is not a subscription — it gets one line at
 * the bottom of the list, with a way through to «Расходы», which is the screen that owns
 * money.
 */

/** The paid channel: not a subscription, but it belongs in this list — last, and quietly. */
function FallbackRow({
  todayEur,
  capEur,
  onApi,
}: {
  todayEur: number
  capEur: number
  onApi: boolean
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-bd px-[18px] py-[15px]">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-idle-s text-[11px] font-bold text-idle-tx"
        >
          ЗК
        </span>
        <span className="flex-none text-[13.5px] font-semibold whitespace-nowrap text-tx">Запасной канал</span>
        <span className="flex flex-none items-center gap-1.5 rounded-full border border-bd2 px-2.5 py-[3px] text-[11px] whitespace-nowrap text-tx2">
          <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${onApi ? 'bg-warn' : 'bg-tx3'}`} />
          {onApi ? 'сейчас работает' : 'авто'}
        </span>

        <div className="flex-1" />

        <span className="flex-none text-[12px] whitespace-nowrap text-tx2 tabular-nums">
          {todayEur} € сегодня{capEur > 0 ? ` · потолок ${capEur} €/мес` : ' · потолок не задан'}
        </span>
        <button
          type="button"
          onClick={() => openScreen({ screen: 'costs' })}
          className="flex-none text-[12px] whitespace-nowrap text-blue hover:text-teal"
        >
          Расходы
        </button>
      </div>
      <div className="ml-[46px] max-w-[720px] text-[11.5px] leading-[1.5] text-tx2">
        Включается, когда все окна исчерпаны. Потолок — правило: он задаётся в конфигурации и виден на
        «Правилах».
      </div>
    </div>
  )
}

function Pill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className="text-[16px] font-bold text-tx tabular-nums">{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const accounts: AccountEntry[] = state.data?.accounts ?? []
  const machines = state.data?.machines ?? []
  const fallback = state.data?.spend.apiFallback
  const onApi = fallback?.switchMode === 'api'

  /** A machine's own name, when the household knows it; otherwise its identifier, unchanged. */
  const titleOf = new Map(machines.map((m) => [m.id, m.title]))
  const open = accounts.filter((a) => !a.windows.closedUntil && (a.windows.pct5h ?? 0) < 100).length

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Аккаунты</h1>
        <Pill value={String(accounts.length)} label={accounts.length === 1 ? 'подписка' : 'подписок'} />
        <Pill value={`${open} из ${accounts.length}`} label="окон принимает работу" />
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">Подписки, их окна и машины, на которых они живут.</span>
      </div>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Связь потеряна. Окна показаны на момент последнего чтения.</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[980px] flex-col gap-[22px]">
          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
              <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Аккаунты</span>
              <span className="text-[11px] text-tx3 tabular-nums">{accounts.length}</span>
            </div>

            {accounts.length === 0 ? (
              <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                Ни одной подписки не заведено. Аккаунты вписываются в конфигурацию демона на машине, где они
                залогинены — окно показывает то, что там написано.
              </p>
            ) : (
              accounts.map((a, i) => (
                <AccountRow
                  key={a.name}
                  account={a}
                  machineTitle={titleOf.get(a.machineId) ?? a.machineId}
                  first={i === 0}
                />
              ))
            )}

            {fallback ? (
              <FallbackRow todayEur={fallback.todayEur} capEur={fallback.capEur} onApi={onApi} />
            ) : null}
          </div>

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Подписка живёт ровно на одной машине: окно принадлежит машине, а не парку, и аккаунт нельзя
            «поделить» между двумя. Аккаунты других машин приходят их собственным ответом. Переключения между
            аккаунтами отдельным журналом пока не ведутся — как они происходили, видно в «Живом потоке».
          </p>
        </div>
      </div>
    </section>
  )
}
