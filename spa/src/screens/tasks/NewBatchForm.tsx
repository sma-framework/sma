import { useMemo, useState } from 'react'
import type { BreakdownQuestion } from '../../api/client'
import { ApiError, isNotReady } from '../../api/client'
import { useBacklogQuery, useCreateBatch, useStateQuery, useSuggestBatch } from '../../api/queries'
import { DecisionCard, EMPTY_DRAFT } from '../../shell/DecisionCard'
import type { DecisionDraft } from '../../shell/DecisionCard'
import { LANES, Segmented } from './NewTaskForm'

/**
 * NewBatchForm — одна фраза владельца превращается в состав работы, и оба пути к этому живут
 * в одной форме.
 *
 * ══════════════ ДВА ПУТИ СРАЗУ, И НИ ОДИН НЕ ОБЯЗАТЕЛЬНЫЙ ══════════════
 *
 * Решение основателя: он пишет формулировку — и ЛИБО отмечает элементы руками, ЛИБО жмёт
 * разбор, и тогда система подбирает подходящие записи бэклога и предлагает новые подзадачи,
 * разбив фразу. Поэтому здесь нет «сначала бэклог, потом остальное»: бэклог — не обязательный
 * трамплин, своя строка законна наравне с записью файла, и смешивать их в одном составе можно.
 *
 * ══════════════ ПРЕДЛОЖЕНИЕ — ЭТО ЧЕРНОВИК, А НЕ РЕШЕНИЕ СИСТЕМЫ ══════════════
 *
 * Дверь разбора не ставит НИЧЕГО. Что она вернула, ложится в состав отмеченным — и каждую
 * запись видно, у каждой написано, почему она здесь, и любую можно снять одним нажатием.
 * Снятая остаётся на глазах зачёркнутой: состав, из которого вещи исчезают бесследно, не
 * даёт себя проверить. В очередь уезжает только то, что отмечено, и только по кнопке внизу.
 *
 * ══════════════ ЕСЛИ СИСТЕМА НЕ ПОНЯЛА — ОНА СПРАШИВАЕТ ══════════════
 *
 * Постановка у нас — дискуссия, как в терминале. Когда фраза не разбирается и в бэклоге по её
 * словам ничего не нашлось, дверь отвечает ВОПРОСОМ, и он показывается той же карточкой, какой
 * показывается всякий вопрос системы в этом окне. Ответ своими словами уходит на новый разбор —
 * это круг дискуссии, а не форма с ошибкой. Формулировка батча при этом не меняется: ответ
 * говорит, ИЗ ЧЕГО состоит работа, а не как она называется.
 *
 * Макет эту форму не рисует — она построена по образцу «+ Новая задача» и в его стиле.
 */

/** Одна запись состава: что это, откуда взялось и отмечена ли она к постановке. */
interface Entry {
  kind: 'backlog' | 'subtask'
  /** Идентификатор строки бэклога — только у записи бэклога. */
  id?: string
  title: string
  why: string
  on: boolean
}

/** Одна запись — это её природа плюс её имя. Дважды одну и ту же в состав не кладём. */
function keyOf(e: { kind: string; id?: string; title: string }): string {
  return `${e.kind}:${e.id ?? e.title}`
}

/**
 * Что уезжает в дверь постановки. Запись бэклога едет ИДЕНТИФИКАТОРОМ (дверь сама возьмёт её
 * слова из файла — так строка очереди читается назад к строке бэклога), своя подзадача едет
 * текстом. Различает их дверь по форме, и здесь она не пересказывается: мы просто отдаём то,
 * что человек отметил.
 */
function wireValue(e: Entry): string {
  return e.kind === 'backlog' && e.id ? e.id : e.title
}

export function NewBatchForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const suggest = useSuggestBatch()
  const create = useCreateBatch()
  const backlog = useBacklogQuery()
  // Тот же единственный факт, который стоит сказать ДО кнопки и в форме задачи: выключенный
  // конвейер примет работу и не начнёт её.
  const state = useStateQuery()
  const pipelineOff = state.data?.rules?.pipeline?.enabled === false

  const [phrase, setPhrase] = useState('')
  const [lane, setLane] = useState<string>(LANES[0].value)
  const [entries, setEntries] = useState<Entry[]>([])
  const [typed, setTyped] = useState('')
  const [understood, setUnderstood] = useState<string | null>(null)
  const [question, setQuestion] = useState<BreakdownQuestion | null>(null)
  const [answer, setAnswer] = useState<DecisionDraft>(EMPTY_DRAFT)
  const [problem, setProblem] = useState<string | null>(null)

  /** Строки бэклога, которых в составе ещё нет: панель отметки — это выбор, а не второй состав. */
  const unpicked = useMemo(() => {
    const taken = new Set(entries.filter((e) => e.kind === 'backlog').map((e) => e.id))
    return (backlog.data?.rows ?? []).filter((r) => !taken.has(r.id))
  }, [backlog.data, entries])

  const chosen = entries.filter((e) => e.on)

  /** Кладёт предложенное в состав, не трогая того, что человек уже отметил или снял сам. */
  const merge = (items: { kind: 'backlog' | 'subtask'; id?: string; title: string; why: string }[]) => {
    setEntries((prev) => {
      const known = new Set(prev.map(keyOf))
      const added = items.filter((i) => !known.has(keyOf(i))).map((i) => ({ ...i, on: true }))
      return [...prev, ...added]
    })
  }

  const askBreakdown = (text: string) => {
    const said = text.trim()
    if (said.length === 0) {
      setProblem('Сначала напишите формулировку — разбирать нечего.')
      return
    }
    if (said.length > 200) {
      setProblem('Длиннее 200 символов дверь разбора не берёт — сократите или отметьте элементы руками.')
      return
    }
    setProblem(null)
    suggest.mutate(said, {
      onSuccess: (out) => {
        setUnderstood(out.text)
        setQuestion(out.question)
        setAnswer(EMPTY_DRAFT)
        merge(out.draft.items)
      },
      onError: () =>
        setProblem('Разбор не ответил. Отметьте элементы руками или попробуйте ещё раз.'),
    })
  }

  const addTyped = () => {
    const line = typed.trim()
    if (line.length === 0) return
    merge([{ kind: 'subtask', title: line, why: 'ваша строка' }])
    setTyped('')
  }

  const submit = () => {
    const title = phrase.trim()
    if (title.length === 0) {
      setProblem('Напишите формулировку — по ней батч и будет называться.')
      return
    }
    if (chosen.length === 0) {
      setProblem('Состав пуст, а батч из нуля — не батч. Отметьте записи бэклога или допишите свою строку.')
      return
    }
    setProblem(null)
    create.mutate(
      { title, items: chosen.map(wireValue), lane },
      {
        onSuccess: (out) => onCreated(out.id),
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Очередь пока не принимает работу.'
              : // Слова отказа — двери, а не наши: она одна знает, что именно не приняла.
                `Батч не заведён. ${err instanceof ApiError && err.detail ? err.detail : 'Проверьте состав и попробуйте ещё раз.'}`,
          ),
      },
    )
  }

  return (
    <div className="absolute top-[42px] right-0 z-30 flex max-h-[74vh] w-[430px] flex-col gap-3 overflow-auto rounded-[13px] border border-bd2 bg-card p-4 shadow-menu">
      <input
        value={phrase}
        autoFocus
        onChange={(e) => setPhrase(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        maxLength={200}
        placeholder="Одной фразой: что нужно разгрести"
        aria-label="Формулировка батча"
        className="w-full rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
      />

      <Segmented label="Направление" options={LANES} current={lane} onPick={setLane} />

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Состав</span>
          <button
            type="button"
            onClick={() => askBreakdown(phrase)}
            disabled={suggest.isPending}
            className="rounded-[7px] border border-bd2 px-2 py-1 text-[10.5px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            {suggest.isPending ? 'Разбираю…' : 'Предложить разбор'}
          </button>
        </div>
        {/*
          Ни слова «создать», ни слова «предложить» в подсказке над кнопками: живой прогон уже
          нажимал на подсказку вместо кнопки, потому что поиск по видимому тексту берёт первое
          совпадение. Тот же промах ждёт человека, который ищет действие глазами или читалкой.
        */}
        <p className="m-0 mb-2 text-[10.5px] leading-[1.35] text-tx3">
          Элементы можно отметить руками, а можно попросить разбор: система подберёт записи
          бэклога и разложит фразу на подзадачи. Она только предлагает — в очередь ничего не
          уходит, пока вы не подтвердите состав кнопкой внизу.
        </p>

        {understood ? (
          <p className="m-0 mb-2 rounded-[8px] bg-blue-s px-2.5 py-1.5 text-[11px] leading-[1.4] text-tx2">
            {understood}
          </p>
        ) : null}

        {entries.length === 0 ? (
          <p className="m-0 mb-2 rounded-[8px] border border-dashed border-bd2 px-2.5 py-2 text-[11px] leading-[1.4] text-tx3">
            Пока пусто. Отметьте записи бэклога ниже, допишите свою строку — или попросите разбор.
          </p>
        ) : (
          <ul className="m-0 mb-2 flex list-none flex-col gap-1 p-0">
            {entries.map((e) => (
              <li
                key={keyOf(e)}
                className={`flex items-start gap-2 rounded-[9px] border px-2.5 py-1.5 ${
                  e.on ? 'border-bd2 bg-surf' : 'border-bd bg-transparent opacity-60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={e.on}
                  aria-label={`Элемент: ${e.title}`}
                  onChange={() =>
                    setEntries((prev) =>
                      prev.map((x) => (keyOf(x) === keyOf(e) ? { ...x, on: !x.on } : x)),
                    )
                  }
                  className="mt-[3px] flex-none accent-blue-d"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[12px] leading-[1.4] text-tx ${e.on ? '' : 'line-through'}`}>
                    {e.kind === 'backlog' && e.id ? `${e.id} · ${e.title}` : e.title}
                  </span>
                  <span className="block text-[10.5px] leading-[1.35] text-tx3">{e.why}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-2 flex gap-1.5">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTyped()
              }
            }}
            maxLength={200}
            placeholder="Своя подзадача строкой"
            aria-label="Своя подзадача"
            className="min-w-0 flex-1 rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12px] text-tx outline-none focus:border-blue"
          />
          <button
            type="button"
            onClick={addTyped}
            className="flex-none rounded-[8px] border border-bd2 px-2.5 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
          >
            Дописать
          </button>
        </div>

        <details>
          <summary className="cursor-pointer list-none text-[11px] text-tx2 hover:text-tx">
            Записи бэклога · {unpicked.length}
          </summary>
          {backlog.isError ? (
            <p className="m-0 mt-1.5 text-[11px] text-tx3">Бэклог не прочитался — отмечать нечего, но своя строка работает.</p>
          ) : unpicked.length === 0 ? (
            <p className="m-0 mt-1.5 text-[11px] text-tx3">Открытых записей нет.</p>
          ) : (
            <ul className="m-0 mt-1.5 flex max-h-[180px] list-none flex-col gap-1 overflow-auto p-0">
              {unpicked.map((r) => (
                <li key={r.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-[9px] border border-bd2 px-2.5 py-1.5 hover:border-blue">
                    <input
                      type="checkbox"
                      checked={false}
                      aria-label={`Запись бэклога ${r.id}`}
                      onChange={() =>
                        merge([{ kind: 'backlog', id: r.id, title: r.title, why: 'отмечено вами' }])
                      }
                      className="mt-[3px] flex-none accent-blue-d"
                    />
                    <span className="min-w-0">
                      <span className="block text-[12px] leading-[1.4] text-tx">
                        {r.id} · {r.title}
                      </span>
                      {r.ageLine ? (
                        <span className="block text-[10.5px] text-tx3">{r.ageLine}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>

      {question ? (
        <DecisionCard
          question={question}
          draft={answer}
          busy={suggest.isPending}
          onDraft={setAnswer}
          onAnswer={(said) => {
            // Ответ — это перечисление кусков, значит он и есть новая фраза для РАЗБОРА.
            // Формулировка батча остаётся той, что владелец написал наверху: она про то, как
            // работа называется, а ответ — про то, из чего она состоит.
            if (said.freeText) askBreakdown(said.freeText)
          }}
        />
      ) : null}

      {pipelineOff ? (
        <p className="m-0 rounded-[8px] bg-warn-s px-2.5 py-2 text-[11.5px] leading-[1.4] text-warn-tx">
          Конвейер выключен: элементы встанут в очередь, но никто их не начнёт, пока вы не
          включите тумблер («Дом системы»).
        </p>
      ) : null}

      {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}

      <div className="mt-0.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-tx3">Отмечено: {chosen.length}</span>
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
          disabled={create.isPending || chosen.length === 0}
          title={chosen.length === 0 ? 'Состав пуст — батч из нуля не батч' : undefined}
          className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
        >
          Создать батч
        </button>
      </div>
      {chosen.length === 0 ? (
        <p className="m-0 text-[10.5px] leading-[1.35] text-tx3">
          Кнопка молчит, пока состав пуст: батч из нуля элементов — не батч, а пустая запись,
          которая закроется, ничего не сделав.
        </p>
      ) : null}
    </div>
  )
}
