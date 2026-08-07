import { useState } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { useAgentModel } from '../../api/queries'
import type { AgentCard } from '../../api/types'

/**
 * «Изменить модель» — the one part of a worker's session that does not come from the project
 * checkout, and the only place in the window where it may be moved.
 *
 * ══════════════════ THE VALUE SHOWN AFTERWARDS IS THE RE-READ ONE ══════════════════
 *
 * The door answers with what it actually wrote, and this dialog deliberately does NOT keep
 * that answer to render from. The change asks for the roster again — one re-read, at the one
 * moment we know something moved — and the row behind this dialog redraws from it. A screen
 * that showed its own hopeful copy would keep showing it after a write that silently landed
 * only on disk, which is the exact failure this product has already paid for once.
 *
 * ══════════════════════ AN EMPTY FIELD MEANS «LEAVE IT» ══════════════════════
 *
 * Clearing a model back to the lane's default is not an act that exists yet: the door takes
 * a value or nothing at all, and there is no way to say «forget the one you have». So an
 * empty field here means the field is not touched, and the dialog says that rather than
 * looking like a way to erase.
 *
 * The list of models offered is what the roster ALREADY uses — not an enumeration of what the
 * vendor sells. A list of legal models written into a window refuses the newest one on the day
 * it ships; free text with the same grammar the door holds does not.
 */

/**
 * The shape a model or an effort may have. A LOCAL copy of the grammar the door holds, so a
 * person is refused where they are standing instead of by a request they cannot see. It is
 * not the authority — the door and the applier are, and both may still say no.
 *
 * What it forbids that matters: a leading dash. These values become one element of a spawn's
 * argument array, so «looks like the next flag» is the only shape that could mean something
 * other than itself.
 */
const PROFILE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/

function modelWords(err: unknown): string {
  if (isNotReady(err)) return 'Эта дверь пока не отвечает. Профиль остался прежним.'
  if (err instanceof ApiError && err.detail) return `Отказано: ${err.detail}`
  return 'Не применилось. Профиль остался прежним.'
}

/** The values already in use on the roster — the only honest list a window can offer. */
function knownValues(agents: readonly AgentCard[], pick: (a: AgentCard) => string | undefined): string[] {
  const seen = new Set<string>()
  for (const a of agents) {
    const v = pick(a)
    if (typeof v === 'string' && v !== '') seen.add(v)
  }
  return [...seen].sort()
}

function Field({
  id,
  label,
  hint,
  value,
  current,
  options,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  current: string | null
  options: string[]
  onChange: (v: string) => void
}) {
  const bad = value.trim() !== '' && !PROFILE_VALUE_RE.test(value.trim())
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[11.5px] text-tx2">
        {label}
        {current ? (
          <>
            {' — сейчас '}
            <span className="font-mono text-tx">{current}</span>
          </>
        ) : (
          ' — сейчас не задано'
        )}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={current ?? 'оставить как есть'}
        autoComplete="off"
        spellCheck={false}
        className={`w-full rounded-[9px] border bg-input px-[11px] py-2 font-mono text-[12.5px] text-tx outline-none ${
          bad ? 'border-err-tx' : 'border-bd focus:border-blue'
        }`}
      />
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => onChange(o)}
              className="rounded-[7px] border border-bd2 px-2.5 py-1 font-mono text-[11px] text-tx2 hover:border-blue hover:text-blue"
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      <span className="text-[11px] leading-[1.5] text-tx3">{hint}</span>
      {bad ? (
        <span className="text-[11.5px] leading-[1.5] text-err-tx">
          Такое значение дверь не примет: без пробелов и кавычек, и не может начинаться с дефиса.
        </span>
      ) : null}
    </div>
  )
}

export function ModelDialog({
  agent,
  roster,
  onClose,
}: {
  agent: AgentCard
  roster: readonly AgentCard[]
  onClose: () => void
}) {
  const apply = useAgentModel()
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const nextModel = model.trim()
  const nextEffort = effort.trim()
  const shapesOk =
    (nextModel === '' || PROFILE_VALUE_RE.test(nextModel)) && (nextEffort === '' || PROFILE_VALUE_RE.test(nextEffort))
  const changesModel = nextModel !== '' && nextModel !== (agent.model ?? '')
  const changesEffort = nextEffort !== '' && nextEffort !== (agent.effort ?? '')
  const ready = shapesOk && (changesModel || changesEffort)

  const submit = () => {
    if (!ready) return
    setProblem(null)
    apply.mutate(
      {
        agent: agent.id,
        ...(changesModel ? { model: nextModel } : {}),
        ...(changesEffort ? { effort: nextEffort } : {}),
      },
      {
        // The answer is deliberately not kept: the roster is re-read by the action itself, and
        // the row behind this dialog draws the value the machine reports, not the one we sent.
        onSuccess: () => onClose(),
        onError: (err) => setProblem(modelWords(err)),
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
        aria-label={`Модель работника ${agent.title}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex w-[470px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div className="text-[13.5px] font-semibold text-tx">Модель работника «{agent.title}»</div>

        <p className="m-0 text-[12px] leading-[1.6] text-tx2">
          Это единственное поле сессии работника, которое не приходит из проекта, — оно живёт в
          настройках и применяется со следующего запуска. Пустое поле означает «оставить как
          есть»: вернуть значение к умолчанию полосы этой дверью нельзя.
        </p>

        <Field
          id="agent-model"
          label="Модель"
          hint="Пишется как в конфигурации — точной строкой, которую понимает исполнитель. Кнопки ниже — модели, которые уже используются на роспиcи."
          value={model}
          current={agent.model ?? null}
          options={knownValues(roster, (a) => a.model)}
          onChange={setModel}
        />

        <Field
          id="agent-effort"
          label="Усилие"
          hint="Насколько глубоко работник думает. Тоже строкой, как в конфигурации."
          value={effort}
          current={agent.effort ?? null}
          options={knownValues(roster, (a) => a.effort)}
          onChange={setEffort}
        />

        {problem ? <p className="m-0 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p> : null}

        <div className="flex items-center justify-between gap-3 border-t border-bd pt-3">
          <span className="text-[11px] text-tx3">
            {ready ? 'Применится к следующему запуску работника' : 'Измените хотя бы одно значение'}
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
              onClick={submit}
              disabled={!ready || apply.isPending}
              className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {apply.isPending ? 'Применяю…' : 'Применить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
