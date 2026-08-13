import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useEnqueue, useStateQuery, useSuggestWords } from '../../api/queries'

/**
 * NewTaskForm — putting a task in the queue, in the four decisions the door actually takes.
 *
 * ════════════════════ THE TEXT BECOMES A TASK, NEVER A COMMAND ═══════════════════
 *
 * What is typed here travels as a task's TITLE. It is data from the first character to the
 * last: the door explicit-picks the fields below out of the body and refuses anything else,
 * and it is the door — not this form — that decides what a valid task is. The form asks for
 * the fields the door names and nothing more, so a field can never be smuggled in from the
 * window, and a green form is never mistaken for a green gate.
 *
 * The choices are the daemon's own closed vocabularies, written here as the words a person
 * uses for them. «Кузница» is deliberately absent: a forge task needs a draft brief the
 * queue validates separately, so it is asked for on «Агенты», where that brief exists.
 *
 * «Вперёд очереди» is the only knob over the order, and it is the daemon's own: priority is
 * a number the queue reads when it picks the next task, not a hint this screen invents.
 *
 * ════════════ СЛОВА ЗАДАЧИ ВЫВОДИТ СИСТЕМА, А ВЛАДЕЛЕЦ ИХ ПРАВИТ ════════════
 *
 * Приказ, по которому это здесь стоит, дословно: «почему мы должны всё писать, если
 * SMA-фреймворк всё это делает?». Поэтому форма НЕ требует ни описания, ни признаков:
 * задача одним заголовком остаётся законной постановкой, как и была.
 *
 * Кнопка «Вывести признаки» спрашивает дверь, которая НИЧЕГО НЕ СТАВИТ — она отвечает
 * черновиком. Черновик подставляется в поля, и дальше это обычные поля: владелец правит
 * их или стирает, и «Поставить» отправляет то, что он оставил. Два нажатия, а не одно:
 * система, которая и вывела бы смысл работы, и запустила бы её, ответила бы на вопрос,
 * которого ей не задавали.
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

/** Признаки на экране — строка на признак; пустые строки не признаки и не едут. */
function criteriaOf(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.replace(/^[-•·]\s*/, '').trim())
    .filter((s) => s.length > 0)
}

export function NewTaskForm({ onClose }: { onClose: () => void }) {
  const enqueue = useEnqueue()
  const suggest = useSuggestWords()
  // The one fact worth saying BEFORE the button: a switched-off conveyor takes the task
  // and runs nothing. Saying it after was the recon's Multica lesson (warn pre-submit).
  const state = useStateQuery()
  const pipelineOff = state.data?.rules?.pipeline?.enabled === false

  const [title, setTitle] = useState('')
  const [lane, setLane] = useState<string>(LANES[0].value)
  const [provider, setProvider] = useState<string | null>(null)
  const [priority, setPriority] = useState<number>(0)
  const [description, setDescription] = useState('')
  const [criteria, setCriteria] = useState('')
  const [understood, setUnderstood] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const deriveWords = () => {
    const text = title.trim()
    if (text.length === 0) {
      setProblem('Сначала напишите формулировку — выводить признаки не из чего.')
      return
    }
    setProblem(null)
    suggest.mutate(text, {
      onSuccess: (answer) => {
        // Черновик КЛАДЁТСЯ В ПОЛЯ, а не показывается отдельной панелью: слова, которые
        // нельзя тронуть, читаются как решение системы, а это предложение.
        setDescription(answer.draft.description)
        setCriteria(answer.draft.acceptance.join('\n'))
        setUnderstood(answer.text)
      },
      onError: () => setProblem('Не вышло вывести слова. Напишите их сами или попробуйте ещё раз.'),
    })
  }

  const submit = () => {
    const text = title.trim()
    if (text.length === 0) {
      setProblem('Напишите, что нужно сделать.')
      return
    }
    setProblem(null)
    const said = description.trim()
    const promised = criteriaOf(criteria)
    enqueue.mutate(
      {
        title: text,
        lane,
        ...(provider ? { provider } : {}),
        ...(priority > 0 ? { priority } : {}),
        ...(said ? { description: said } : {}),
        ...(promised.length > 0 ? { acceptance: promised } : {}),
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

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Слова задачи</span>
          <button
            type="button"
            onClick={deriveWords}
            disabled={suggest.isPending}
            className="rounded-[7px] border border-bd2 px-2 py-1 text-[10.5px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            {suggest.isPending ? 'Вывожу…' : 'Вывести признаки'}
          </button>
        </div>
        {/*
          «завести», а не «поставить» — и это не вкусовщина. Слово главной кнопки не должно
          встречаться в подсказке над ней: живой прогон 13.08 нажал на ЭТУ строку вместо кнопки
          (текстовый поиск не различает регистра и берёт первое совпадение в разметке) — задача
          не поставилась, и ни одна проверка этого не заметила. Тот же промах ждёт человека,
          который ищет действие по слову глазами или читалкой.
        */}
        <p className="m-0 mb-1.5 text-[10.5px] leading-[1.35] text-tx3">
          Необязательно: задачу можно завести одним заголовком. Нажмёте — система выведет слова
          сама, и вы их поправите.
        </p>
        {understood ? (
          <p className="m-0 mb-1.5 rounded-[8px] bg-blue-s px-2.5 py-1.5 text-[11px] leading-[1.35] text-tx2">
            {understood}
          </p>
        ) : null}
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Что это за работа"
          aria-label="Описание задачи"
          className="mb-1.5 w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12px] text-tx outline-none focus:border-blue"
        />
        <textarea
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          rows={4}
          placeholder="Признаки успеха — по одному в строке"
          aria-label="Признаки успеха"
          className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12px] text-tx outline-none focus:border-blue"
        />
      </div>

      {pipelineOff ? (
        <p className="m-0 rounded-[8px] bg-warn-s px-2.5 py-2 text-[11.5px] leading-[1.4] text-warn-tx">
          Конвейер выключен: задача встанет в очередь, но никто её не начнёт, пока вы не
          включите тумблер («Дом системы»).
        </p>
      ) : null}

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
