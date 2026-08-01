import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useEnqueue } from '../../api/queries'

/**
 * NewTaskForm — putting a task in the queue, in the four decisions the door actually takes.
 *
 * ════════════════════ THE TEXT BECOMES A TASK, NEVER A COMMAND ═══════════════════
 *
 * What is typed here travels as a task's TITLE. It is data from the first character to the
 * last: the door explicit-picks the fields below out of the body and refuses anything else,
 * and it is the door — not this form — that decides what a valid task is. The form asks for
 * the fields the door names and nothing more, so a field can never be smuggled in from the
 * window, and a green form is never mistaken for a green gate (T-9-20).
 *
 * The choices are the daemon's own closed vocabularies, written here as the words a person
 * uses for them. «Кузница» is deliberately absent: a forge task needs a draft brief the
 * queue validates separately, so it is asked for on «Агенты», where that brief exists.
 *
 * «Вперёд очереди» is the only knob over the order, and it is the daemon's own: priority is
 * a number the queue reads when it picks the next task, not a hint this screen invents.
 */

/** The lanes a person can send work to, in the daemon's own words. */
const LANES: readonly { value: string; label: string }[] = [
  { value: 'prod', label: 'прод-код' },
  { value: 'research', label: 'ресёрч' },
  { value: 'paperwork', label: 'бумага' },
] as const

/** Who does it. «Авто» sends no provider at all — the routing decides, as it does by default. */
const EXECUTORS: readonly { value: string | null; label: string }[] = [
  { value: null, label: 'Авто' },
  { value: 'claude', label: 'Клод' },
  { value: 'codex', label: 'Кодекс' },
] as const

/** Where in the queue it lands. Higher is fetched first; 0 is the daemon's own default. */
const ORDERS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'по очереди' },
  { value: 10, label: 'вперёд очереди' },
] as const

function Segmented<T>({
  label,
  options,
  current,
  onPick,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  current: T
  onPick: (value: T) => void
}) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">{label}</div>
      <div className="flex gap-1.5">
        {options.map((o) => {
          const on = o.value === current
          return (
            <button
              key={o.label}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o.value)}
              className={`flex-1 rounded-[8px] border py-1.5 text-[11.5px] ${
                on ? 'border-blue bg-blue-s text-tx' : 'border-bd2 text-tx2 hover:text-tx'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function NewTaskForm({ onClose }: { onClose: () => void }) {
  const enqueue = useEnqueue()

  const [title, setTitle] = useState('')
  const [lane, setLane] = useState<string>(LANES[0].value)
  const [provider, setProvider] = useState<string | null>(null)
  const [priority, setPriority] = useState<number>(0)
  const [problem, setProblem] = useState<string | null>(null)

  const submit = () => {
    const text = title.trim()
    if (text.length === 0) {
      setProblem('Напишите, что нужно сделать.')
      return
    }
    setProblem(null)
    enqueue.mutate(
      {
        title: text,
        lane,
        ...(provider ? { provider } : {}),
        ...(priority > 0 ? { priority } : {}),
      },
      {
        onSuccess: () => onClose(),
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Очередь пока не принимает задачи.'
              : 'Задача не поставлена. Проверьте название и попробуйте ещё раз.',
          ),
      },
    )
  }

  return (
    <div className="absolute top-[42px] right-0 z-30 flex w-[310px] flex-col gap-3 rounded-[13px] border border-bd2 bg-card p-4 shadow-menu">
      <input
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
        maxLength={200}
        placeholder="Название задачи"
        aria-label="Название задачи"
        className="w-full rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
      />

      <Segmented label="Направление" options={LANES} current={lane} onPick={setLane} />
      <Segmented label="Исполнитель" options={EXECUTORS} current={provider} onPick={setProvider} />
      <Segmented label="Очередь" options={ORDERS} current={priority} onPick={setPriority} />

      {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}

      <div className="mt-0.5 flex justify-end gap-2">
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
          disabled={enqueue.isPending}
          className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
        >
          Поставить
        </button>
      </div>
    </div>
  )
}
