import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useChatHistoryQuery,
  useDecisionAnswer,
  useEnqueue,
  usePhaseIndexQuery,
  usePhaseQuery,
  useRedirectTask,
  useSendChat,
  useStateQuery,
} from '../api/queries'
import type { ChatDraft, PhaseIndexRow, QueueRow } from '../api/types'
import { waitWords } from '../screens/tasks/units'
import { screenById } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import { DecisionCard, EMPTY_DRAFT, isOpen } from './DecisionCard'
import type { DecisionDraft } from './DecisionCard'
import { CONSOLE_CONTEXT_EVENT, readConsoleContext } from './console-context'
import type { ConsoleContext } from './console-context'
import { refusalWords } from './format'
import { openScreen } from './navigation'

/**
 * SystemConsole — «Разговор с системой»: окно, из которого владелец правит парком, не уходя
 * с того экрана, на который он смотрит.
 *
 * ═══════════════ ОДНА ДВЕРЬ РАЗГОВОРА, А НЕ ВТОРАЯ ═══════════════════════════════
 *
 * Окно не заводит своего протокола диалога. Оно зовёт ТЕ ЖЕ хуки, которыми живёт экран
 * «Разговор»: книга разговора читается один раз, ход отправляется той же дверью, ответ
 * приходит тем же ответом. Второй чат — это две памяти об одном разговоре, которые однажды
 * разойдутся, и человек не узнает, какая из них его.
 *
 * ═══════════════ ТРИ ИСХОДА СВОБОДНОГО ТЕКСТА, И НИ ОДНОГО САМОХОДНОГО ═════════════
 *
 *   РЕШЕНИЕ по ожидающему вопросу — кнопкой варианта на карточке вопроса. Карточка взята
 *     у оболочки (одна на все места, где система остановилась и спросила), ответ уезжает
 *     дверью решений, и остановленный круг просыпается, продолжая ТУ ЖЕ работу: возврат не
 *     начинает заново.
 *   ЗАДАНИЕ — свободный текст, из которого дверь разговора СОБИРАЕТ ЧЕРНОВИК. Черновик
 *     становится работой ровно в одну секунду: человек нажал «Создать». Никакой постановки
 *     из подсказки, из ответа или из намерения — иначе текст, попавший в окно, ставил бы
 *     задачи сам.
 *   ВОПРОС О СОСТОЯНИИ — ответ в контексте открытого экрана. Контекст едет ВМЕСТЕ с текстом
 *     и виден человеку под его же словами.
 *
 * ═══════════════ ПОЧЕМУ КОНТЕКСТ ЕДЕТ ВНУТРИ ТЕКСТА ══════════════════════════════
 *
 * Дверь разговора принимает три поля и отказывает четвёртому. Растить её словарь ради одной
 * строки — это правка замороженной таблицы дверей, и она стоит собственной работы с тестом
 * на форму. Поэтому строка контекста прибавляется К ТЕКСТУ вопроса — тем же способом, каким
 * человек дописал бы её рукой, — и окно показывает под своей репликой, что именно уехало.
 * Спрятанная приписка была бы враньём; названная — это просто часть вопроса.
 *
 * ═══════════════ КЛЮЧ ПРИНАДЛЕЖИТ РОВНО ОДНОМУ ═══════════════════════════════════
 *
 * Ctrl K — этого окна и только его; палитра поиска переехала на Ctrl P в том же изменении.
 * Обработчик — по образцу палитры: физический код клавиши (работает на кириллице), и он
 * молчит, пока человек печатает в поле ВНЕ окна: свой Ctrl K у текстового поля принадлежит
 * полю. Внутри окна комбинация закрывает то, что открыла.
 */

/** Пульс — то же дыхание, что у живой строки списка: окно не спит, пока работа идёт. */
function Pulse() {
  return <span aria-hidden className="h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-blue" />
}

/** Печатает ли человек прямо сейчас во что-то. Тот же гард, что у палитры. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/** Одна реплика ленты — сказанная человеком или системой. */
interface Line {
  key: string
  who: 'you' | 'system'
  text: string
  /** Что уехало вместе с вопросом, названное словами. Только у реплик человека. */
  rode?: string
  draft?: ChatDraft
}

/**
 * ЧТО ЖДЁТ ЧЕЛОВЕКА — счётчик и возраст самого старого ожидания.
 *
 * Считается из тех же двух источников, что и полоса «ждут вас» над списком задач: строки,
 * которые ждут решения человека, и фазы, которые припарковали вопрос. Возраст называется
 * только там, где он измерен, — у ждущих задач; у вопроса фазы дверь возраста не отдаёт, и
 * выдумывать минуты окно не станет.
 *
 * Фильтр по машине, который есть у полосы, здесь не применяется: выбор машины — это ручка
 * ЭКРАНА задач, а у оболочки её нет. При одной машине числа совпадают; при нескольких окно
 * считает по всему дому, и это больше, а не меньше правды.
 */
function pendingOf(
  awaiting: QueueRow[],
  phases: PhaseIndexRow[],
  activeProject: string | null,
): { count: number; oldest: string | null; rows: QueueRow[]; phases: PhaseIndexRow[] } {
  const rows = awaiting.filter((r) => !activeProject || r.project === activeProject)
  const asking = phases.filter((p) => p.open > 0)
  const oldestHours = rows.reduce<number | undefined>(
    (max, r) => (r.agedForHours != null && (max == null || r.agedForHours > max) ? r.agedForHours : max),
    undefined,
  )
  const questions = asking.reduce((sum, p) => sum + p.open, 0)
  return { count: rows.length + questions, oldest: waitWords(oldestHours), rows, phases: asking }
}

/** Быстрые реплики места, на которое человек смотрит. Ничего, чего система ещё не умеет. */
function quickOf(context: ConsoleContext): string[] {
  if (context.kind === 'task') return ['Что тут решать?', 'Чем это доказано?', 'Что дальше по этой задаче?']
  if (context.kind === 'phase') return ['Статус этой фазы', 'Что дальше по фазе?', 'Что тормозит?']
  return ['Что тормозит?', 'Что ждёт меня?', 'Что идёт прямо сейчас?']
}

/** Открытые вопросы ОДНОЙ фазы, карточкой оболочки — тем же способом, что и на экране разговора. */
function PhaseQuestions({ row }: { row: PhaseIndexRow }) {
  const card = usePhaseQuery(row.id)
  const answer = useDecisionAnswer()
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({})
  const [problem, setProblem] = useState<Record<string, string>>({})

  const open = (card.data?.questions ?? []).filter(isOpen)
  if (open.length === 0) return null

  const send = (questionId: string, taskId: string | undefined, input: { optionId?: string; freeText?: string }) => {
    setProblem((was) => ({ ...was, [questionId]: '' }))
    answer.mutate(
      { phase: row.id, questionId, ...(taskId ? { taskId } : {}), ...input },
      {
        onSuccess: () => setDrafts((was) => ({ ...was, [questionId]: EMPTY_DRAFT })),
        onError: (err) => setProblem((was) => ({ ...was, [questionId]: refusalWords(err) })),
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-semibold text-tx2">{card.data?.name ?? row.name}</div>
      {open.map((q) => (
        <DecisionCard
          key={q.id}
          question={q}
          draft={drafts[q.id] ?? EMPTY_DRAFT}
          busy={answer.isPending && answer.variables?.questionId === q.id}
          problem={problem[q.id] || null}
          onDraft={(draft) => setDrafts((was) => ({ ...was, [q.id]: draft }))}
          onAnswer={(input) => send(q.id, q.taskId, input)}
        />
      ))}
      <p className="m-0 text-[11px] leading-[1.45] text-tx3">
        Возврат не начинает заново — исполнитель продолжает ту же сессию.
      </p>
    </div>
  )
}

export function SystemConsole({ screen }: { screen: ScreenId }) {
  const [open, setOpen] = useState(false)
  const [told, setTold] = useState<ConsoleContext | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [text, setText] = useState('')
  const [conversationId, setConversationId] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | null>(null)
  const [created, setCreated] = useState<Record<string, string>>({})

  const state = useStateQuery()
  const phaseIndex = usePhaseIndexQuery()
  // Книга читается ТОЛЬКО когда окно открыто: закрытое окно не спрашивает дверь ни о чём.
  const history = useChatHistoryQuery(open)
  const send = useSendChat()
  const enqueue = useEnqueue()
  const redirect = useRedirectTask()

  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const seeded = useRef(false)

  // ── контекст: что рассказал экран, а если он промолчал — имя экрана из реестра ──
  useEffect(() => {
    const onTold = (e: Event) => setTold(readConsoleContext(e))
    window.addEventListener(CONSOLE_CONTEXT_EVENT, onTold)
    return () => window.removeEventListener(CONSOLE_CONTEXT_EVENT, onTold)
  }, [])

  const context: ConsoleContext = useMemo(
    () => told ?? { kind: 'screen', line: screenById(screen).title },
    [told, screen],
  )

  // ── ключ окна. Ровно один владелец Ctrl K во всей оболочке ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isK = e.code === 'KeyK' || e.key === 'k' || e.key === 'K'
      if ((e.ctrlKey || e.metaKey) && isK) {
        const inside = panelRef.current?.contains(e.target as Node) ?? false
        if (isTypingTarget(e.target) && !inside) return
        e.preventDefault()
        setOpen((was) => !was)
        return
      }
      if (e.key === 'Escape' && open) {
        const inside = panelRef.current?.contains(e.target as Node) ?? false
        if (!inside && isTypingTarget(e.target)) return
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Книга разговора читается ОДИН раз: она — запись сказанного, а не правда о парке.
  useEffect(() => {
    if (seeded.current || !history.data) return
    seeded.current = true
    setLines(
      history.data.turns.map((t, i) => ({
        key: `book-${i}`,
        who: t.role === 'assistant' ? 'system' : 'you',
        text: t.text,
        ...(t.draft ? { draft: t.draft } : {}),
      })),
    )
    const last = [...history.data.turns].reverse().find((t) => t.conversationId)
    if (last?.conversationId) setConversationId(last.conversationId)
  }, [history.data])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines.length, send.isPending, open])

  const pending = useMemo(
    () => pendingOf(state.data?.awaiting ?? [], phaseIndex.data?.phases ?? [], state.data?.activeProject ?? null),
    [state.data, phaseIndex.data],
  )

  const append = (line: Line) => setLines((was) => [...was, line])

  /**
   * Отправить вопрос. Контекст открытого экрана прибавляется к тексту и НАЗЫВАЕТСЯ под
   * репликой — человек видит ровно то, что уехало.
   */
  const ask = (said: string) => {
    const body = said.trim()
    if (!body || send.isPending) return
    setText('')
    setProblem(null)
    const rode = `контекст: ${context.line}`
    append({ key: `said-${Date.now()}`, who: 'you', text: body, rode })
    send.mutate(
      { text: `${body}\n\n(${rode})`, ...(conversationId ? { conversationId } : {}) },
      {
        onSuccess: (reply) => {
          setConversationId(reply.conversationId)
          append({
            key: `heard-${Date.now()}`,
            who: 'system',
            text: reply.answer.text,
            ...(reply.answer.draft ? { draft: reply.answer.draft } : {}),
          })
        },
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  /** Черновик становится задачей ТОЛЬКО здесь — по нажатию человека, и никак иначе. */
  const createFromDraft = (key: string, draft: ChatDraft) => {
    const worker = draft.worker ? state.data?.rules.workers.find((w) => w.id === draft.worker) : undefined
    const lane = draft.lane ?? worker?.lane ?? null
    if (!lane) {
      setProblem('Не удалось поставить: в черновике не названа линия работы.')
      return
    }
    setProblem(null)
    enqueue.mutate(
      { title: draft.title, lane },
      {
        onSuccess: (result) => {
          setCreated((was) => ({ ...was, [key]: result.id }))
          append({
            key: `made-${Date.now()}`,
            who: 'system',
            text: `Завёл задачу «${draft.title}» (${result.id}). Она уже в списке «Задачи» — строкой, как всё остальное.`,
          })
        },
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  /**
   * Поправка живой задаче — тем же каналом, что «Руль» на её карточке: работник получает её
   * и ПРОДОЛЖАЕТ ту же сессию, а не начинает заново. «После хода» — потому что окно правит
   * работу, а не рвёт её: перебить сейчас — это отдельное решение, и принимается оно на
   * карточке задачи, где видно, что именно перебивают.
   */
  const steer = (said: string) => {
    const body = said.trim()
    const taskId = context.taskId
    if (!body || !taskId || redirect.isPending) return
    setText('')
    setProblem(null)
    append({ key: `steer-${Date.now()}`, who: 'you', text: body, rode: `исполнителю задачи ${taskId}` })
    redirect.mutate(
      { taskId, text: body, mode: 'queue' },
      {
        onSuccess: () =>
          append({
            key: `steered-${Date.now()}`,
            who: 'system',
            text: 'Передал исполнителю. Он учтёт поправку после текущего хода и продолжит ту же сессию — не начнёт заново.',
          }),
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  // ── свёрнутое окно: счётчик ожидающих решений и возраст самого старого ──
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-[22px] bottom-[22px] z-50 flex items-center gap-2.5 rounded-full border border-bd2 bg-card px-[15px] py-[11px] shadow-menu"
      >
        <Pulse />
        <span className="text-[12.5px] font-semibold text-tx">Разговор с системой</span>
        {pending.count > 0 ? (
          <span className="rounded-[10px] border border-warn/40 bg-warn-s px-[7px] py-[2px] font-mono text-[10.5px] font-semibold text-warn-tx">
            {pending.count}
          </span>
        ) : null}
        {pending.count > 0 ? (
          <span className="font-mono text-[10px] text-tx3">
            {pending.oldest ? `ждут ${pending.oldest}` : 'сколько ждут — нет данных'}
          </span>
        ) : null}
        <span className="font-mono text-[10px] font-medium text-tx3">Ctrl K</span>
      </button>
    )
  }

  const draftLines = lines.filter((l) => l.draft)

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Разговор с системой"
      className="fixed right-[22px] bottom-[22px] z-50 flex h-[588px] max-h-[calc(100vh-44px)] w-[436px] flex-col overflow-hidden rounded-[11px] border border-bd2 bg-card shadow-menu"
    >
      <div className="flex flex-none items-center gap-2.5 border-b border-bd px-3.5 py-3">
        <Pulse />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-tx">Разговор с системой</div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-tx2">контекст: {context.line}</div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Закрыть разговор"
          className="h-[26px] w-[26px] flex-none rounded-[6px] border border-bd2 bg-card text-[14px] text-tx2"
        >
          ×
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-surf p-3.5">
        {lines.length === 0 && !send.isPending ? (
          <p className="m-0 text-[12px] leading-[1.55] text-tx2">
            Спросите о работе или скажите, что делать. Отвечаю в контексте того, что у вас открыто.
          </p>
        ) : null}

        {lines.map((line) => (
          <div
            key={line.key}
            className={`flex flex-col gap-[3px] ${line.who === 'you' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[86%] rounded-[10px] border px-3 py-2.5 text-[12px] leading-[1.55] whitespace-pre-wrap text-tx ${
                line.who === 'you' ? 'border-blue/40 bg-blue-s' : 'border-bd bg-card'
              }`}
            >
              {line.text}
            </div>
            <span className="font-mono text-[9.5px] text-tx3">
              {line.who === 'you' ? (line.rode ? `вы · ${line.rode}` : 'вы') : 'система'}
            </span>
            {line.draft ? (
              <div className="mt-1 w-full rounded-[9px] border border-bd2 bg-card px-3 py-2.5">
                <div className="text-[12px] leading-[1.45] font-semibold text-tx">{line.draft.title}</div>
                <div className="mt-0.5 text-[11px] text-tx3">
                  {line.draft.lane ?? line.draft.worker ?? 'линия работы не названа'}
                </div>
                {created[line.key] ? (
                  <div className="mt-2 text-[11.5px] text-ok-tx">
                    Задача {created[line.key]} стоит в списке «Задачи».
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={enqueue.isPending}
                    onClick={() => createFromDraft(line.key, line.draft as ChatDraft)}
                    className="mt-2 rounded-[7px] bg-blue-d px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-60"
                  >
                    {enqueue.isPending ? 'Ставлю…' : 'Создать'}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ))}

        {send.isPending ? <span className="text-[11.5px] text-tx3">Думаю…</span> : null}

        {/* Вопросы, на которых система остановилась, — ниже ленты, там, где до них дотягивается
            рука, и над полем ввода, потому что работа стоит, пока на них не ответят. */}
        {pending.phases.map((p) => (
          <PhaseQuestions key={p.id} row={p} />
        ))}

        {pending.rows.map((r) => (
          <div key={r.id} className="rounded-[9px] border border-warn/40 bg-warn-s px-3 py-2.5">
            <div className="font-mono text-[11px] font-semibold text-warn-tx uppercase">
              {r.agedForHours != null && waitWords(r.agedForHours)
                ? `ждёт вас ${waitWords(r.agedForHours)}`
                : 'ждёт вас · сколько — нет данных'}
            </div>
            <div className="mt-1 text-[12px] leading-[1.5] text-tx">{r.title ?? 'Без названия'}</div>
            <p className="m-0 mt-1 text-[11px] leading-[1.45] text-tx2">
              Исполнитель остановился и ждёт вашего решения. Он не додумывает за вас.
            </p>
            <button
              type="button"
              onClick={() => openScreen({ screen: 'task-card', taskId: r.id })}
              className="mt-2 rounded-[5px] border border-warn-tx px-[11px] py-1.5 text-[11.5px] font-semibold text-warn-tx"
            >
              Открыть карточку
            </button>
          </div>
        ))}

        {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
        <div ref={bottomRef} />
      </div>

      <div className="flex-none border-t border-bd bg-card px-3 pt-2.5 pb-3">
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {quickOf(context).map((q) => (
            <button
              key={q}
              type="button"
              disabled={send.isPending}
              onClick={() => ask(q)}
              className="rounded-[14px] border border-bd2 bg-card px-2.5 py-[5px] text-[11px] text-tx2 hover:border-blue hover:text-blue disabled:opacity-60"
            >
              {q}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ask(text)
              }
            }}
            placeholder="Спросите или скажите, что делать"
            aria-label="Спросите или скажите, что делать"
            className="min-w-0 flex-1 rounded-[7px] border border-bd2 bg-surf px-[11px] py-2.5 text-[12px] text-tx outline-none focus:border-blue focus:bg-card"
          />
          {context.taskId && context.live ? (
            <button
              type="button"
              disabled={redirect.isPending || text.trim() === ''}
              onClick={() => steer(text)}
              className="flex-none rounded-[7px] border border-bd2 bg-card px-3 py-2.5 text-[12px] font-semibold text-tx2 disabled:opacity-60"
            >
              {redirect.isPending ? 'Передаю…' : 'Исполнителю'}
            </button>
          ) : null}
          <button
            type="button"
            disabled={send.isPending || text.trim() === ''}
            onClick={() => ask(text)}
            className="flex-none rounded-[7px] bg-blue-d px-[13px] py-2.5 text-[12px] font-semibold text-white disabled:opacity-60"
          >
            Отправить
          </button>
        </div>

        <div className="mt-[7px] text-[10px] text-tx3">
          Ctrl K открывает и закрывает окно · система отвечает в контексте открытого экрана
        </div>
        {draftLines.length > 0 ? (
          <div className="mt-1 text-[10px] text-tx3">
            Задача заводится только нажатием «Создать» — из разговора сама не ставится.
          </div>
        ) : null}
      </div>
    </div>
  )
}
