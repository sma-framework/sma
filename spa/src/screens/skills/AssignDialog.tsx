import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useAssignSkill } from '../../api/queries'
import type { AgentCard, SkillCard } from '../../api/types'
import { accentFor, initialOf } from '../today/format'

/**
 * AssignDialog — «Кому дать»: the whole of what a person decides about a skill.
 *
 * ═══════════════════ ASSIGNMENT IS A REPLACEMENT, AND IT SAYS SO ═══════════════════
 *
 * /api/skill/assign does not add and does not remove: it REPLACES the skill's assignment with
 * the list it is given. The workers ticked here get the skill; every worker not ticked loses
 * it. So the dialog opens with the current holders already ticked — untick one and the saved
 * list is genuinely «everyone except them», which is exactly what the door will write. An
 * empty list is a legitimate answer: it takes the skill away from everybody.
 *
 * The door accepts at most sixteen names. That limit is the daemon's, and it is checked here
 * so a person is told before they press, not refused after.
 *
 * The skill itself is a FILE the daemon found in the tree. This dialog cannot create one,
 * rename one or delete one — there is no route for that, and therefore no button.
 */

/** The most names /api/skill/assign accepts in one request. */
const MAX_WORKERS = 16

export function AssignDialog({
  skill,
  agents,
  onClose,
}: {
  skill: SkillCard
  /** Everyone on the roster — the skill can go to a switched-off worker too, and wait there. */
  agents: AgentCard[]
  onClose: () => void
}) {
  const assign = useAssignSkill()
  const [selected, setSelected] = useState<string[]>(() => skill.assignedTo.slice())
  const [problem, setProblem] = useState<string | null>(null)

  const flip = (id: string) => {
    setProblem(null)
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  const save = () => {
    if (selected.length > MAX_WORKERS) {
      setProblem(`За раз навык можно дать не более чем ${MAX_WORKERS} работникам.`)
      return
    }
    setProblem(null)
    assign.mutate(
      { skillId: skill.id, workerIds: selected },
      {
        onSuccess: () => onClose(),
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Раздача навыков пока не работает — дверь не отвечает.'
              : 'Не удалось сохранить. Навык остался у тех, у кого был.',
          ),
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Кому дать навык «${skill.title}»`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex max-h-[70vh] w-[400px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div>
          <div className="text-[13.5px] font-semibold text-tx">Кому дать: {skill.title}</div>
          <div className="mt-1 text-[11.5px] text-tx3">
            Отмеченные работники получат навык. С остальных он будет снят.
          </div>
        </div>

        {agents.length === 0 ? (
          <p className="m-0 text-[12.5px] text-tx2">
            Работников пока нет — навык некому дать. Заведите работника на «Агентах».
          </p>
        ) : (
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <div className="flex flex-col gap-0.5">
              {agents.map((a) => {
                const on = selected.includes(a.id)
                return (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 hover:bg-row-hover"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => flip(a.id)}
                      className="h-3.5 w-3.5 flex-none accent-blue"
                    />
                    <span
                      className={`flex h-[19px] w-[19px] flex-none items-center justify-center rounded-md text-[9.5px] font-bold ${accentFor(
                        a.lane ?? a.id,
                      )}`}
                    >
                      {initialOf(a.title || a.id)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">{a.title}</span>
                    {a.enabled ? null : <span className="flex-none text-[10.5px] text-tx3">выключен</span>}
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}

        <div className="flex items-center justify-between gap-3 border-t border-bd pt-3">
          <span className="text-[11px] tabular-nums text-tx3">
            выбрано: {selected.length} из {MAX_WORKERS}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={save}
              disabled={assign.isPending || agents.length === 0}
              className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {assign.isPending ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
