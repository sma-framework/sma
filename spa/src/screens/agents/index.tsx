import { useState } from 'react'
import { isNotReady, STOCK_TEAM_TARGET } from '../../api/client'
import { useHarnessQuery, useToggleAgent } from '../../api/queries'
import type { AgentCard, StockTeamCard } from '../../api/types'
import { OPEN_SCREEN_EVENT } from '../../shell/navigation'
import type { OpenScreenDetail } from '../../shell/navigation'
import { accentFor, initialOf } from '../../shell/format'
import { DraftCard } from './DraftCard'
import { ForgeDialog } from './ForgeDialog'
import { ModelDialog } from './ModelDialog'

/**
 * «Агенты» — the forge, with its lid off: who is on the roster, what is still a draft, and
 * the one box that asks for somebody new.
 *
 * ════════════════════════ THE SCREEN RENDERS THE ROSTER, IT DOES NOT WRITE IT ═══════════
 *
 * Everything on the glass comes out of ONE reading — /api/harness — and every change goes
 * through a door that already exists: /api/forge to ask for a draft, /api/approve to land it,
 * /api/agent/toggle to switch a worker on or off, /api/agent/model to move the one field of a
 * session that is not decided by the project. There is no fifth door, so there is no fifth
 * thing this screen can do.
 *
 * A worker's PROVIDER is still shown and not edited: it is declared in the role file and no
 * route rewrites it, so an editor for it would be a control that quietly does nothing. Model
 * and effort used to be in that same sentence and are not any more — they live on the profile
 * in the settings, and a door that writes them now exists. They are edited behind a dialog,
 * because the value applies to the next spawn of a worker who may be running right now, and
 * because a model name typed by mistake is a worker that fails on its first task.
 *
 * «Привести своих» is a door to another screen, not another API: it asks the shell for the
 * import wizard, which owns bringing in helpers that already live in the project.
 *
 * ════════════════════════ «КОМАНДА SMA» — ЧТО ПРИЕХАЛО С УСТАНОВКОЙ ═════════════════════
 *
 * «Работники» above is the pipeline: whoever the roster config declares. «Команда SMA» is a
 * different question — what ARRIVED. Thirty-odd definitions came with the install and were
 * invisible here until now, which is the gap this section closes. It comes out of the SAME
 * reading — the harness payload gained a `stockTeam` key — so there is still one reading and
 * still no fourth door: the one switch below goes through /api/agent/toggle, addressed to a
 * reserved id that means «the whole team» instead of one helper.
 *
 * Three things are legible without a click: who came with SMA and who the user brought;
 * which of them are on; and which have been edited here, with a mark when a newer shipped
 * version exists. A definition that could not be read says so on its own card — an unreadable
 * file is a visible fact, not a missing row.
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

/** One worker on the roster: what they are, and the two acts that are really ours. */
function WorkerRow({ agent, roster }: { agent: AgentCard; roster: readonly AgentCard[] }) {
  const toggle = useToggleAgent()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
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
            <span>
              Модель:{' '}
              <span className="font-semibold text-tx">{agent.model ?? 'по умолчанию исполнителя'}</span>
            </span>
            <span>
              Усилие: <span className="font-semibold text-tx">{agent.effort ?? 'по умолчанию исполнителя'}</span>
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-[8px] border border-bd2 px-[13px] py-1 text-[11.5px] whitespace-nowrap text-tx2 hover:border-blue hover:text-blue"
            >
              Изменить модель
            </button>
          </div>
          <div className="text-[11px] text-tx3">
            Модель и усилие лежат в настройках работника и правятся отсюда — применяются со
            следующего запуска.{' '}
            {agent.roleFile
              ? `Остальное — границы, название, исполнитель — читается из файла роли ${agent.roleFile} и меняется там.`
              : 'Файла роли нет — остальные поля взяты из настроек работника.'}
          </div>
        </div>
      ) : null}

      {editing ? <ModelDialog agent={agent} roster={roster} onClose={() => setEditing(false)} /> : null}

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

/** One member of the team that arrived — or one the user brought. Read only; the switch is one, and it is below. */
function StockRow({ member }: { member: StockTeamCard }) {
  return (
    <article
      className={`flex items-start gap-3 rounded-[12px] border border-bd bg-card px-[15px] py-2.5 shadow-panel ${
        member.enabled ? '' : 'opacity-65'
      }`}
    >
      <span
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-[8px] text-[12px] font-bold ${accentFor(
          member.id,
        )}`}
      >
        {initialOf(member.title || member.id)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-semibold text-tx">{member.title}</span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[10px] ${
              member.enabled ? 'bg-ok-s text-ok-tx' : 'bg-idle-s text-idle-tx'
            }`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${member.enabled ? 'bg-green' : 'bg-tx3'}`} />
            {member.enabled ? 'включён' : 'выключен'}
          </span>
          {member.forked ? (
            <span className="rounded-full bg-warn-s px-2 py-[2px] text-[10px] text-warn-tx">изменён Вами</span>
          ) : null}
          {member.stockUpdate === 'available' ? (
            <span className="rounded-full border border-bd2 px-2 py-[2px] text-[10px] text-tx2">есть новая версия</span>
          ) : null}
        </div>

        {member.description ? (
          <div className="mt-[3px] text-[11.5px] leading-[1.5] text-tx2">{member.description}</div>
        ) : null}

        {member.problem ? (
          <p className="m-0 mt-1 text-[11px] text-err-tx">Файл не прочитался: {member.problem}</p>
        ) : null}

        {member.tools.length > 0 ? (
          <div className="mt-[3px] text-[11px] text-tx3">Инструменты: {member.tools.join(', ')}</div>
        ) : null}
      </div>
    </article>
  )
}

/**
 * «Команда SMA» — the roster that arrived, and the one act that switches it on. The switch
 * goes through the helper toggle already wired above, addressed to the reserved team id.
 *
 * ══════════════ THE SWITCH IS THE POINT OF THIS SECTION, SO IT LOOKS LIKE ONE ═══════════
 *
 * It used to be a thin bordered word to the right of a small heading, below the fold. The
 * founder, at the live proof on 05.08, in his own words: «переключатель конвеера не вижу
 * вообще», and the verdict «нужно более понятно чтобы все было». So it is a panel now, at
 * the top of the section and before the roster it acts on: it says how many arrived and how
 * many are on, it says what pressing it will do BEFORE it is pressed, and the button carries
 * the count it will act on.
 *
 * ══════════════ AND AN ACTION THAT DID NOTHING HAS TO SAY SO ════════════════════════════
 *
 * The same proof: «нажал включить команду, но ничего не произошло» — no effect and no error.
 * The cause was on the daemon's side (the roster was written to disk and the next read still
 * served the pre-toggle one) and it is fixed there. What is fixed HERE is the second half,
 * which is a defect in its own right: a silent no-op. The outcome is stated either way now —
 * a refusal in red, and a plain confirmation of what moved when there was none.
 */
function StockTeamSection({ team, notReady }: { team: StockTeamCard[]; notReady: boolean }) {
  const toggle = useToggleAgent()
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)

  const shipped = team.filter((m) => m.origin === 'sma')
  const own = team.filter((m) => m.origin === 'yours')
  const on = shipped.filter((m) => m.enabled).length
  const allOn = shipped.length > 0 && on === shipped.length
  const forked = shipped.filter((m) => m.forked).length
  const updates = shipped.filter((m) => m.stockUpdate === 'available').length

  const flipTeam = () => {
    setProblem(null)
    setOutcome(null)
    const turningOn = !allOn
    toggle.mutate(
      { id: STOCK_TEAM_TARGET, enabled: turningOn },
      {
        onSuccess: (result) => {
          const touched = result?.stockTeam?.agents
          const many = typeof touched === 'number' ? ` Затронуто работников: ${touched}.` : ''
          setOutcome(turningOn ? `Команда включена.${many}` : `Команда выключена.${many}`)
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Переключение пока не работает — дверь не отвечает.'
              : turningOn
                ? 'Включить команду не удалось. Всё осталось как было.'
                : 'Выключить команду не удалось. Всё осталось как было.',
          ),
      },
    )
  }

  if (team.length === 0) {
    return (
      <div>
        <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Команда SMA</div>
        <p className="m-0 text-[13px] text-tx2">
          {notReady
            ? 'Список появится, когда кузница заработает.'
            : 'Определений агентов на диске не найдено — команда приезжает вместе с установкой SMA.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Команда SMA</div>

      {/* The switch, as a panel and not as a word in a corner — see the note above. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-[14px] border border-bd2 bg-surf px-[18px] py-4 shadow-panel">
        <div className="min-w-[260px] flex-1">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className="text-[15px] font-semibold text-tx">
              {allOn ? 'Команда включена' : on > 0 ? 'Команда включена не вся' : 'Команда выключена'}
            </span>
            <span className="text-[12.5px] text-tx2 tabular-nums">
              включено {on} из {shipped.length}
            </span>
          </div>
          <div className="mt-1 max-w-[620px] text-[12px] leading-[1.6] text-tx2">
            {allOn
              ? 'Все работники, приехавшие вместе с SMA, включены и могут брать задачи.'
              : 'Одно нажатие включает их всех сразу. Ничего не скачивается — включаются те файлы, что уже лежат на диске.'}
          </div>
        </div>
        <button
          type="button"
          onClick={flipTeam}
          disabled={toggle.isPending || shipped.length === 0}
          className={`h-[42px] flex-none rounded-[10px] px-6 text-[14px] font-semibold whitespace-nowrap disabled:opacity-60 ${
            allOn ? 'border border-bd2 bg-card text-tx hover:bg-row-hover' : 'bg-blue-d text-white hover:bg-blue'
          }`}
        >
          {toggle.isPending
            ? 'Минуту…'
            : allOn
              ? `Выключить команду (${shipped.length})`
              : `Включить команду (${shipped.length})`}
        </button>
      </div>

      {problem ? (
        <p className="m-0 mb-2.5 rounded-[10px] border border-err-tx bg-err-s px-3.5 py-2.5 text-[12.5px] font-semibold text-err-tx">
          {problem}
        </p>
      ) : null}
      {outcome ? (
        <p className="m-0 mb-2.5 rounded-[10px] border border-bd2 bg-ok-s px-3.5 py-2.5 text-[12.5px] text-ok-tx">
          {outcome}
        </p>
      ) : null}

      <div className="mb-3.5 text-[11.5px] leading-[1.6] text-tx3">
        Это те, кто приехал вместе с SMA: {shipped.length}.
        {forked > 0 ? ` Изменено Вами: ${forked}.` : ''}
        {updates > 0 ? ` Есть новая версия у: ${updates}.` : ''}
      </div>

      <div className="flex flex-col gap-2.5">
        {shipped.map((m) => (
          <StockRow key={m.id} member={m} />
        ))}
      </div>

      {own.length > 0 ? (
        <>
          <div className="mt-5 mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Ваши агенты</div>
          <div className="mb-3.5 text-[11.5px] text-tx3">
            Эти определения лежат рядом, но с SMA не приезжали — обновлений для них у нас нет, и кнопка выше их не
            трогает.
          </div>
          <div className="flex flex-col gap-2.5">
            {own.map((m) => (
              <StockRow key={m.id} member={m} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function Screen() {
  const harness = useHarnessQuery()
  const agents = harness.data?.agents ?? []
  /** The whole roster that arrived with the install — the same reading, one key over. */
  const stockTeam = harness.data?.stockTeam ?? []
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
                  <WorkerRow key={a.id} agent={a} roster={agents} />
                ))}
              </div>
            )}
          </div>

          <StockTeamSection team={stockTeam} notReady={harness.isError && isNotReady(harness.error)} />

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
