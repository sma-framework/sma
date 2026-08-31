import { useStateQuery } from '../../api/queries'
import type { BudgetStops, SubApiSwitch } from '../../api/types'
import { openScreen } from '../../shell/navigation'
import { formatCapUsd } from '../costs/money'
import { LaneTable } from './LaneTable'

/**
 * «Правила» — the policy the park actually obeys, put on the glass exactly as it is written.
 *
 * ═════════════════ A READING SURFACE, AND IT SAYS SO OUT LOUD ═════════════════
 *
 * Every fact here is a pure derive of the configuration on this machine. There is no door in
 * the daemon that edits it, and so there is no control here that pretends to. The accepted
 * design draws its rules as switches; those switches are drawn, faithfully, in the position
 * the real configuration puts them in — and they are DISABLED, each under the quiet line
 * «настраивается в конфигурации».
 *
 * That was a deliberate choice over the two alternatives. Deleting the switches would have
 * lost the design's whole point, which is that a person sees at a glance which way each rule
 * is set. Wiring them would have meant inventing an address the daemon does not answer at —
 * the one thing the api layer exists to make impossible. A switch that shows the truth and
 * admits it cannot change it is honest in both directions.
 *
 * ═══════════════════════ ONE LINE OF MONEY, AND ONLY ONE ═══════════════════════
 *
 * The park is paid for by the plans, so this screen speaks in lanes, profiles and windows.
 * The budget stop is the single exception: it is a MONEY ceiling — dollars, unconverted (see
 * screens/costs/money.ts) — it is a rule, and «Расходы»
 * itself sends a person here to read it. It gets one line, and the spending it limits stays
 * on the screen that owns money.
 */

/** The line under a drawn-but-disabled rule. Written once so every rule says it the same way. */
const CONFIGURED_ELSEWHERE = 'настраивается в конфигурации'

/**
 * A rule as the design draws it: a switch in its true position that cannot be moved. `on`
 * comes from the reading; there is deliberately no `onChange` for it to be wired to.
 */
function RuleSwitch({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      aria-disabled="true"
      aria-label={label}
      title={CONFIGURED_ELSEWHERE}
      className={`flex h-[18px] w-8 flex-none items-center rounded-full p-0.5 opacity-60 ${
        on ? 'bg-blue justify-end' : 'bg-bd2 justify-start'
      }`}
    >
      <span aria-hidden className="h-3.5 w-3.5 rounded-full bg-white shadow-panel" />
    </span>
  )
}

function RuleRow({
  label,
  on,
  caption,
  first,
  children,
}: {
  label: string
  on: boolean
  caption?: string
  first: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={`flex flex-col gap-1.5 px-5 py-[13px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 text-[13px] leading-[1.5] text-tx">{label}</span>
        <RuleSwitch on={on} label={label} />
      </div>
      {caption ? <span className="text-[11.5px] text-tx3">{caption}</span> : null}
      {children}
    </div>
  )
}

/** What the switch between the plans and the paid channel is doing, right now. */
function SwitchState({ sw }: { sw: SubApiSwitch }) {
  const onApi = sw.mode === 'api'
  return (
    <div className="flex items-center gap-[7px] border-t border-bd bg-surf px-5 py-2.5">
      <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${onApi ? 'bg-warn' : 'bg-green'}`} />
      <span className="text-[11.5px] leading-[1.5] text-tx2">
        {onApi
          ? 'Сейчас работа идёт по запасному каналу: окна подписок исчерпаны.'
          : 'Сейчас работа идёт по подпискам — запасной канал молчит.'}
      </span>
    </div>
  )
}

/**
 * The budget stop: the one money figure this screen is allowed to print.
 *
 * В ДОЛЛАРАХ, и это сказано знаком: потолок сравнивается с расходом поставщика как он
 * выставлен, без пересчёта курса. Знак евро здесь стоял ровно над теми же долларами.
 */
function budgetCaption(stops: BudgetStops | undefined, sw: SubApiSwitch): string {
  if (!sw.budgeted) return 'Потолок не задан — запасному каналу нечего разрешать, он не включится.'
  const cap = stops?.monthlyApiCapUsd ?? sw.capUsd
  const warn = stops?.warnPct
  return warn !== undefined
    ? `Потолок ${formatCapUsd(cap)} · предупреждение на ${warn}%`
    : `Потолок ${formatCapUsd(cap)}`
}

/**
 * The three things the system never decides by itself. These are not settings that happen to
 * be switched off — they are the shape of the product, which is why they carry a lock instead
 * of a switch, and why the reading has no field for them to disagree with.
 */
const HUMAN_ONLY = ['Приём работы: только я', 'Публикация изменений: только я', 'Дизайн: только я'] as const

function LockIcon() {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="flex-none text-tx3"
    >
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" />
      <path d="M5.5 7V5A2.5 2.5 0 0 1 10.5 5V7" />
    </svg>
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

function CardHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-bd px-5 py-3">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
      {note ? <span className="text-[11px] text-tx3 tabular-nums">{note}</span> : null}
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const rules = state.data?.rules
  const lanes = rules?.lanes ?? []
  const workers = rules?.workers ?? []
  const budgetStops = rules?.budgetStops
  const subApiSwitch: SubApiSwitch = rules?.subApiSwitch ?? { mode: 'subscription', capUsd: 0, budgeted: false }
  /**
   * «РАБОТНИКОВ N» — ЭТО ПУЛ ОЧЕРЕДИ, А НЕ ДЛИНА СПИСКА. Здесь стояло `workers.length`, и полоса
   * говорила «работников 44» в дни, когда задачи разбирали шестеро: остальные — либо выключены,
   * либо специалисты, которых очередь не раздаёт вовсе. Признак приезжает считанным (`inQueue`),
   * тем же выражением, каким его считает маршрутизатор.
   */
  const inQueue = workers.filter((w) => w.inQueue).length

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Правила</h1>
        <Pill value={String(lanes.length)} label={lanes.length === 1 ? 'полоса' : 'полос'} />
        <Pill value={`${inQueue} из ${workers.length}`} label="работников разбирают очередь" />
        <Pill value={String(HUMAN_ONLY.length)} label="принципа защищены" />
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Политика парка так, как она записана. Окно её читает; меняется она в конфигурации — кроме
          потолка расходов, у которого есть своя дверь на «Расходах».
        </span>
      </div>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Связь потеряна. Показаны правила на момент последнего чтения.</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[900px] flex-col gap-[22px]">
          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <CardHead title="Как работает команда" />
            <RuleRow
              label="Если лимит подписок закончился, продолжать по запасному каналу"
              on={subApiSwitch.budgeted}
              // The cap is the ONE rule on this screen with a door in the window: «Расходы»
              // edits it. Sending a person to a config file for a number they can change two
              // clicks away is how a product teaches its owner that it needs a terminal.
              caption={`${budgetCaption(budgetStops, subApiSwitch)} · потолок меняется на «Расходах»`}
              first
            >
              <button
                type="button"
                onClick={() => openScreen({ screen: 'costs' })}
                className="self-start text-[11.5px] text-blue hover:text-teal"
              >
                Сколько уже потрачено — на «Расходах»
              </button>
            </RuleRow>
            <SwitchState sw={subApiSwitch} />
          </div>

          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <CardHead
              title="Кто что делает"
              note={`${inQueue} ${inQueue === 1 ? 'разбирает очередь' : 'разбирают очередь'} из ${workers.length}`}
            />
            <div className="pt-2.5">
              <LaneTable lanes={lanes} workers={workers} />
            </div>
            <div className="border-t border-bd bg-surf px-5 py-2.5 text-[11.5px] leading-[1.5] text-tx3">
              Задачу берёт ИСПОЛНИТЕЛЬ: специалист (исследователь, ревьюер) из очереди сам не берёт ничего — его
              зовут поимённо при постановке или поднимает фаза. Полоса решает поставщика и модель. Полосы и профили
              заданы в конфигурации демона.
            </div>
          </div>

          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <div className="flex items-center gap-2 border-b border-bd px-5 py-3">
              <LockIcon />
              <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Что решаю только я</span>
            </div>
            {HUMAN_ONLY.map((label, i) => (
              <div
                key={label}
                className={`flex items-center justify-between gap-4 px-5 py-[13px] ${
                  i === 0 ? '' : 'border-t border-bd'
                }`}
              >
                <span className="text-[13px] leading-[1.5] text-tx">{label}</span>
                <span className="flex flex-none items-center gap-[7px]">
                  <LockIcon />
                  <span className="text-[11px] whitespace-nowrap text-tx3">так устроена система</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
