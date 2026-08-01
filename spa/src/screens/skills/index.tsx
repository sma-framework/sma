import { useMemo, useState } from 'react'
import { isNotReady, isRaceLost } from '../../api/client'
import { useApprove, useHarnessQuery } from '../../api/queries'
import type { AgentCard, DraftCard as DraftRow, SkillCard } from '../../api/types'
import { ForgeDialog } from '../agents/ForgeDialog'
import { OPEN_SCREEN_EVENT } from '../../shell/navigation'
import type { OpenScreenDetail } from '../../shell/navigation'
import { accentFor, initialOf } from '../../shell/format'
import { AssignDialog } from './AssignDialog'

/**
 * «Навыки» — the abilities a worker can be given, and the one decision that gives them.
 *
 * ═══════════════════ A SKILL IS A FILE; ASSIGNMENT IS THE ONLY SWITCH ═══════════════════
 *
 * The daemon finds skills by walking the tree: each folder with a SKILL.md is one card here.
 * There is no route that creates, renames or deletes a skill from the window, so this screen
 * offers none of those. What it does offer is the single thing the daemon does accept —
 * WHO HAS IT — through «Кому дать».
 *
 * A new skill therefore takes the same two human steps as a new worker: the forge writes a
 * draft, a person approves it (that lands SKILL.md in the tree), and only then can it be given
 * to anybody — the assign applier refuses a skill whose file does not exist yet. The draft row
 * below says exactly that, and never shows a «дать» button before the file is real.
 *
 * The mirror draws an on/off switch on a card. «Off» on this screen means «нет ни у кого»: the
 * daemon keeps no per-skill enabled flag, and a switch pretending to be one would be a second,
 * invented state. So the card shows who holds the skill — in words and in faces — and the
 * dialog is where that changes.
 */

/** Who holds this skill, said in one line, out of the roster the window already has. */
function holdersLabel(skill: SkillCard, agents: AgentCard[], titleOf: Map<string, string>): string {
  if (skill.assignedTo.length === 0) return 'нет ни у кого'
  if (agents.length > 0 && skill.assignedTo.length >= agents.length) return 'у всей команды'
  return `у ${skill.assignedTo.map((id) => titleOf.get(id) ?? id).join(', ')}`
}

/** One forged skill draft: step one only — the file has to land before anyone can be given it. */
function SkillDraftRow({ draft, onOpenTask }: { draft: DraftRow; onOpenTask: (taskId: string) => void }) {
  const approve = useApprove()
  const [approved, setApproved] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const land = () => {
    setProblem(null)
    approve.mutate(
      { taskId: draft.id },
      {
        onSuccess: (res) => {
          if (!res.ok || !res.merged) {
            setProblem(
              res.softDenied
                ? 'Одобрение не прошло проверки — навык не влит.'
                : 'Одобрение не завершилось слиянием — навык не влит.',
            )
            return
          }
          setApproved(true)
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Одобрение пока не работает — дверь не отвечает.'
              : isRaceLost(err)
                ? 'Черновик уже разобрали в другом окне. Обновите список.'
                : 'Одобрить не удалось. Черновик остался черновиком.',
          ),
      },
    )
  }

  return (
    <article className="flex flex-col gap-3 rounded-[12px] border border-bd border-l-[3px] border-l-teal bg-card p-4 shadow-panel">
      <div className="text-[12.5px] leading-[1.55] text-tx">
        <span className="font-semibold text-teal">Черновик навыка: </span>
        {draft.title ?? draft.id}
      </div>
      {draft.draftPath ? <div className="text-[11px] text-tx3">{draft.draftPath}</div> : null}

      <div className="flex flex-wrap items-center gap-2">
        {approved ? (
          <span className="rounded-[8px] bg-ok-s px-[13px] py-1.5 text-[11.5px] font-semibold text-ok-tx">
            Одобрен
          </span>
        ) : (
          <button
            type="button"
            onClick={land}
            disabled={approve.isPending}
            className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            {approve.isPending ? 'Одобряем…' : 'Одобрить'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpenTask(draft.id)}
          className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
        >
          Квитанция проверок
        </button>
      </div>

      {approved ? (
        <p className="m-0 text-[11.5px] text-tx2">
          Шаг 1 пройден. Навык появится в списке выше — там же кнопка «Кому дать»: это второй шаг,
          и он тоже Ваш.
        </p>
      ) : null}
      {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
    </article>
  )
}

export function Screen() {
  const harness = useHarnessQuery()
  const agents = harness.data?.agents ?? []
  const skills = harness.data?.skills ?? []
  const drafts = (harness.data?.drafts ?? []).filter((d) => d.kind === 'skill')

  const [assigning, setAssigning] = useState<string | null>(null)

  const titleOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of agents) map.set(a.id, a.title)
    return map
  }, [agents])

  const openScreen = (detail: OpenScreenDetail) => {
    window.dispatchEvent(new CustomEvent<OpenScreenDetail>(OPEN_SCREEN_EVENT, { detail }))
  }

  const held = skills.filter((s) => s.assignedTo.length > 0).length
  const openSkill = skills.find((s) => s.id === assigning) ?? null

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Навыки</h1>
        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className="text-[16px] font-bold text-tx tabular-nums">{skills.length}</span>
          <span className="text-[11.5px] text-tx2">всего</span>
        </div>
        <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
          <span className="text-[16px] font-bold text-ok-tx tabular-nums">{held}</span>
          <span className="text-[11.5px] text-tx2">розданы</span>
        </div>
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">Умения, которые можно дать любому работнику.</span>
      </div>

      {harness.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            {isNotReady(harness.error)
              ? 'Список навыков пока не отдаётся — дверь не отвечает.'
              : 'Связь потеряна. Навыки — на момент последнего, что было видно.'}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex flex-col gap-6">
          {skills.length === 0 ? (
            <p className="m-0 text-[13px] text-tx2">
              Навыков нет. Опишите нужный внизу — кузница соберёт черновик, одобрите его Вы.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
              {skills.map((skill) => (
                <article
                  key={skill.id}
                  className="flex flex-col gap-3 rounded-[13px] border border-bd bg-card px-[18px] py-4 shadow-panel"
                >
                  <div className="text-[13.5px] leading-[1.35] font-semibold text-tx">{skill.title}</div>

                  <div className="flex min-h-[19px] items-center gap-[7px]">
                    {skill.assignedTo.length > 0 ? (
                      <div className="flex flex-none gap-1">
                        {skill.assignedTo.slice(0, 4).map((id) => (
                          <span
                            key={id}
                            title={titleOf.get(id) ?? id}
                            className={`flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] text-[9px] font-bold ${accentFor(
                              id,
                            )}`}
                          >
                            {initialOf(titleOf.get(id) ?? id)}
                          </span>
                        ))}
                        {skill.assignedTo.length > 4 ? (
                          <span className="text-[10.5px] text-tx3">+{skill.assignedTo.length - 4}</span>
                        ) : null}
                      </div>
                    ) : null}
                    <span className="min-w-0 truncate text-[12px] text-tx2">
                      {holdersLabel(skill, agents, titleOf)}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setAssigning(skill.id)}
                    className="self-start rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                  >
                    Кому дать
                  </button>
                </article>
              ))}
            </div>
          )}

          {drafts.length > 0 ? (
            <div>
              <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">Черновики</div>
              <div className="flex max-w-[640px] flex-col gap-3">
                {drafts.map((d) => (
                  <SkillDraftRow
                    key={d.id}
                    draft={d}
                    onOpenTask={(taskId) => openScreen({ screen: 'task-card', taskId })}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <ForgeDialog
            kind="skill"
            heading="Собрать новый навык"
            placeholder="Опишите навык…"
            submitLabel="Собрать черновик"
            note="Черновик готовит кузница; решение одобрить его и кому дать навык остаётся за Вами."
            rows={2}
          />
        </div>
      </div>

      {openSkill ? (
        <AssignDialog skill={openSkill} agents={agents} onClose={() => setAssigning(null)} />
      ) : null}
    </section>
  )
}
