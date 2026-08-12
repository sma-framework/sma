import { useStateQuery } from '../../api/queries'
import type { AccountEntry, RulesWorker } from '../../api/types'
import { openScreen } from '../../shell/navigation'
import { AccountRow } from './AccountRow'
import { AddAccount } from './AddAccount'

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
 *
 * ═══════════ TWO LISTS, BECAUSE THERE ARE TWO QUESTIONS ═══════════
 *
 * Above: the subscriptions that are WORKING — deduped, with their windows and their machine.
 * That is the question a person has every day. Below: the spawn profiles as they are WRITTEN
 * DOWN — one row per profile, on or off, with the form that adds a new one. That is the
 * question a person has twice a year, when a subscription joins the household or stops
 * working. Folding them into one list would answer neither well: a profile that has never
 * been logged in has no window to show, and a window says nothing about whether the profile
 * behind it is switched on.
 *
 * Neither list carries a token. Neither carries the NAME of the variable holding one. That is
 * not a filter applied here — it is the shape of the reading: there is no field to render.
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
        Включается, когда все окна исчерпаны, и только пока месячный расход под потолком. Сам потолок
        задаётся на «Расходах», кнопкой «Изменить потолок», и виден среди правил.
      </div>
    </div>
  )
}

/** The lines of work, in the same words the rest of the window uses for them. */
const LANE_LABEL: Record<string, string> = {
  prod: 'прод-код',
  research: 'ресёрч',
  paperwork: 'бумага',
  forge: 'кузница',
}

/**
 * One spawn profile as the configuration holds it.
 *
 * What is NOT here is the point of the row: no token, and no name of the variable carrying
 * one. The reading does not contain either, so there is nothing on this screen to shoulder-surf
 * and nothing in the payload for a household network to leak. Whether that variable is
 * populated is a fact of the machine's own environment and is deliberately not answered from
 * a browser.
 */
function ProfileRow({ profile, first }: { profile: RulesWorker; first: boolean }) {
  const lane = profile.lane ? (LANE_LABEL[profile.lane] ?? profile.lane) : 'полоса не указана'
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-[18px] py-[13px] ${first ? '' : 'border-t border-bd'}`}>
      <span className="flex-none font-mono text-[12.5px] font-semibold text-tx">{profile.id}</span>
      <span className="flex-none rounded-full border border-bd2 px-2.5 py-[3px] text-[11px] whitespace-nowrap text-tx2">
        {lane}
      </span>
      <span
        className={`flex flex-none items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] whitespace-nowrap ${
          profile.enabled ? 'bg-ok-s text-ok-tx' : 'bg-idle-s text-idle-tx'
        }`}
      >
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${profile.enabled ? 'bg-green' : 'bg-tx3'}`} />
        {profile.enabled ? 'включён' : 'выключен'}
      </span>
      <div className="flex-1" />
      <span className="flex-none text-[11.5px] whitespace-nowrap text-tx3">
        {profile.model ? profile.model : 'модель по умолчанию'}
        {profile.effort ? ` · ${profile.effort}` : ''}
      </span>
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
  const open = accounts.filter(
    (a) =>
      !a.windows.closedUntil && a.windows.fiveHour?.status !== 'exhausted' && a.windows.week?.status !== 'exhausted',
  ).length

  /** The profiles as the configuration holds them — the same one reading, one key over. */
  const profiles = state.data?.rules.workers ?? []

  /**
   * The check behind step 2 of the login scenario: ask the daemon for the picture AGAIN and
   * say whether the profile is really in the pool. Not «did the request return 200» — a write
   * that landed on disk and not in the running process is the failure this looks for.
   */
  const verifyProfile = async (id: string): Promise<boolean> => {
    const fresh = await state.refetch()
    return (fresh.data?.rules.workers ?? []).some((w) => w.id === id)
  }

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

          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
              <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Профили спавна</span>
              <span className="text-[11px] text-tx3 tabular-nums">{profiles.length}</span>
              <span className="text-[11px] text-tx3">как они записаны в конфигурации</span>
            </div>

            {profiles.length === 0 ? (
              <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                Ни одного профиля не записано. Форма ниже добавляет первый — выключенным.
              </p>
            ) : (
              profiles.map((p, i) => <ProfileRow key={p.id} profile={p} first={i === 0} />)
            )}

            <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11px] leading-[1.6] text-tx3">
              Ни в одной строке нет токена и нет названия переменной, в которой он лежит: этих полей
              нет в самом ответе демона. Включаются и выключаются профили тумблером на «Агентах» —
              одна кнопка на одно действие.
            </p>
          </div>

          <AddAccount onVerify={verifyProfile} />

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
