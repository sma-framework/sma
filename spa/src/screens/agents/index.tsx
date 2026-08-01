import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useHarnessQuery, useToggleAgent } from '../../api/queries'
import type { AgentCard } from '../../api/types'
import { OPEN_SCREEN_EVENT } from '../today/TaskPanel'
import type { OpenScreenDetail } from '../today/TaskPanel'
import { accentFor, initialOf } from '../today/format'
import { DraftCard } from './DraftCard'
import { ForgeDialog } from './ForgeDialog'

/**
 * «Агенты» — the forge, with its lid off: who is on the roster, what is still a draft, and
 * the one box that asks for somebody new.
 *
 * ════════════════════════ THE SCREEN RENDERS THE ROSTER, IT DOES NOT WRITE IT ═══════════
 *
 * Everything on the glass comes out of ONE reading — /api/harness — and every change goes
 * through a door that already exists: /api/forge to ask for a draft, /api/approve to land it,
 * /api/agent/toggle to switch a worker on or off. There is no fourth door, so there is no
 * fourth thing this screen can do.
 *
 * Which is why a worker's provider, model and effort are shown here and NOT edited here. Those
 * fields live in the role file, and the toggle applier reads them out of it; the daemon offers
 * no route that rewrites them, so an editor for them would be a control that quietly does
 * nothing. A fact a person cannot change is still worth seeing — it is shown as a fact, under
 * «Подробнее», with the file it came from named.
 *
 * «Привести своих» is a door to another screen, not another API: it asks the shell for the
 * import wizard, which owns bringing in helpers that already live in the project.
 */

/** The services that do the work, in the words the rest of the window uses for them. */
const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Клод',
  codex: 'Кодекс',
}

/** The lines of work, in the same words «Команда» and «Задачи» use. */
const LANE_LABEL: Record<string, string> = {
  prod: 'прод-код',
  research: 'ресёрч',
  paperwork: 'бумага',
  forge: 'кузница',
}

function KpiPill({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className={`text-[16px] font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

/** One worker on the roster: what they are, and the single switch that is really ours. */
function WorkerRow({ agent }: { agent: AgentCard }) {
  const toggle = useToggleAgent()
  const [open, setOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const laneLabel = agent.lane ? (LANE_LABEL[agent.lane] ?? agent.lane) : null
  const providerLabel = agent.provider ? (PROVIDER_LABEL[agent.provider] ?? agent.provider) : '—'

  const flip = () => {
    setProblem(null)
    toggle.mutate(
      { id: agent.id, enabled: !agent.enabled },
      {
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Переключение пока не работает — дверь не отвечает.'
              : agent.enabled
                ? 'Выключить не удалось. Работник остался включённым.'
                : 'Включить не удалось. Работник остался выключенным.',
          ),
      },
    )
  }

  return (
    <article
      className={`flex flex-col gap-[11px] rounded-[14px] border border-bd bg-card px-[18px] py-3.5 shadow-panel ${
        agent.enabled ? '' : 'opacity-65'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-8 w-8 flex-none items-center justify-center rounded-[9px] text-[13px] font-bold ${accentFor(
            agent.lane ?? agent.id,
          )}`}
        >
          {initialOf(agent.title || agent.id)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[13.5px] font-semibold text-tx">{agent.title}</span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[10.5px] ${
                agent.enabled ? 'bg-ok-s text-ok-tx' : 'bg-idle-s text-idle-tx'
              }`}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${agent.enabled ? 'bg-green' : 'bg-tx3'}`}
              />
              {agent.enabled ? 'включён' : 'выключен'}
            </span>
          </div>
          <div className="mt-[3px] text-[12px] text-tx2">
            {laneLabel ? `Направление: ${laneLabel}` : 'Направление не указано в файле роли'}
          </div>
        </div>

        <div className="flex flex-none gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
          >
            Подробнее
          </button>
          <button
            type="button"
            onClick={flip}
            disabled={toggle.isPending}
            className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] whitespace-nowrap text-tx2 hover:text-tx disabled:opacity-60"
          >
            {toggle.isPending ? '…' : agent.enabled ? 'Выключить' : 'Включить'}
          </button>
        </div>
      </div>

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-bd pt-2.5 pl-11">
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 text-[12px] text-tx2">
            <span>
              Исполнитель: <span className="font-semibold text-tx">{providerLabel}</span>
            </span>
            {agent.model ? (
              <span>
                Модель: <span className="font-semibold text-tx">{agent.model}</span>
              </span>
            ) : null}
            {agent.effort ? (
              <span>
                Режим: <span className="font-semibold text-tx">{agent.effort}</span>
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-tx3">
            {agent.roleFile
              ? `Эти поля читаются из файла роли ${agent.roleFile} — меняются там, не отсюда.`
              : 'Файла роли нет — поля взяты из настроек работника.'}
          </div>
        </div>
      ) : null}

      <div className="pl-11 text-[11.5px] leading-[1.5] text-tx3">
        {agent.can.length > 0 || agent.cannot.length > 0 ? (
          <>
            Можно: {agent.can.length > 0 ? agent.can.join(', ') : '—'} · Нельзя:{' '}
            {agent.cannot.length > 0 ? agent.cannot.join(', ') : '—'}
          </>
        ) : (
          'Границы не описаны в файле роли.'
        )}
      </div>

      {problem ? <p className="m-0 pl-11 text-[11.5px] text-err-tx">{problem}</p> : null}
    </article>
  )
}

export function Screen() {
  const harness = useHarnessQuery()
  const agents = harness.data?.agents ?? []
  /** A draft with no kind is a worker's draft: this screen is where the forge lands by default. */
  const drafts = (harness.data?.drafts ?? []).filter((d) => d.kind === 'agent' || d.kind === null)

  const enabled = agents.filter((a) => a.enabled).length

  const openScreen = (detail: OpenScreenDetail) => {
    window.dispatchEvent(new CustomEvent<OpenScreenDetail>(OPEN_SCREEN_EVENT, { detail }))
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Агенты</h1>
        <KpiPill value={agents.length} label="всего" tone="text-tx" />
        <KpiPill value={enabled} label="включены" tone="text-ok-tx" />
        <KpiPill value={agents.length - enabled} label="выключены" tone="text-tx3" />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => openScreen({ screen: 'import-wizard' })}
          className="flex-none rounded-[9px] border border-bd2 px-[15px] py-2 text-[12px] whitespace-nowrap text-tx2 hover:text-tx"
        >
          Привести своих
        </button>
      </header>

      {harness.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            {isNotReady(harness.error)
              ? 'Кузница пока не отвечает — список работников появится, когда она заработает.'
              : 'Связь потеряна. Работники — на момент последнего, что было видно.'}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[980px] flex-col gap-[30px]">
          <div>
            <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Работники</div>
            <div className="mb-3.5 text-[11.5px] text-tx3">
              Исполнитель показывает, какой сервис выполняет работу: Клод или Кодекс.
            </div>

            {agents.length === 0 ? (
              <p className="m-0 text-[13px] text-tx2">
                Работников пока нет. Опишите нужного внизу — кузница соберёт черновик, включите его Вы.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {agents.map((a) => (
                  <WorkerRow key={a.id} agent={a} />
                ))}
              </div>
            )}
          </div>

          {drafts.length > 0 ? (
            <div>
              <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Черновики</div>
              <div className="mb-3.5 text-[11.5px] text-tx3">
                Собраны кузницей и ждут Вашего решения. Ничего не включается само.
              </div>
              <div className="flex max-w-[680px] flex-col gap-3">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} onOpenTask={(taskId) => openScreen({ screen: 'task-card', taskId })} />
                ))}
              </div>
            </div>
          ) : null}

          <ForgeDialog
            kind="agent"
            heading="Собрать нового работника"
            placeholder="Опишите, какой работник нужен…"
            submitLabel="Собрать черновик"
            note="Черновик собирает кузница, зная Ваш продукт. Ничего не включается без Вашего решения."
          />
        </div>
      </div>
    </section>
  )
}
