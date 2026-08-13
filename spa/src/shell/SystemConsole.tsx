import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useChatHistoryQuery,
  useDecisionAnswer,
  useEnqueue,
  usePhaseIndexQuery,
  usePhaseQuery,
  useHoldWave,
  useRedirectTask,
  useSendChat,
  useStateQuery,
} from '../api/queries'
import type { ChatDraft, PhaseCard, PhaseIndexRow, QueueRow, WaveRow, WaveTask } from '../api/types'
import { waitWords } from '../screens/tasks/units'
import { screenById } from '../screens/registry'
import type { ScreenId } from '../screens/registry'
import { DecisionCard, EMPTY_DRAFT, isOpen } from './DecisionCard'
import type { DecisionDraft } from './DecisionCard'
import { CONSOLE_CONTEXT_EVENT, CONSOLE_OPEN_EVENT, readConsoleContext } from './console-context'
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
  /**
   * Черновик предложен В ЭТОМ разговоре, только что.
   *
   * Кнопка «Создать» стоит ТОЛЬКО у такого. Книга разговора помнит и вчерашние предложения,
   * а окно теперь висит над каждым экраном — старый черновик с живой кнопкой означал бы, что
   * работа, о которой человек думал позавчера, ставится случайным нажатием, и он даже не
   * поймёт, откуда она взялась. Прочитанное предложение остаётся видимым текстом: сказать
   * его заново — секунда, а отменить поставленную задачу — нет.
   */
  fresh?: boolean
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

/** Сколько эшелонов одной фазы окно предлагает разом. Полка реплик, а не список фазы. */
const WAVE_CHIP_CAP = 4

/**
 * КАКИЕ ЭШЕЛОНЫ ЭТОЙ ФАЗЫ ОКНО ПРЕДЛАГАЕТ ОСТАНОВИТЬ — и в каком порядке.
 *
 * ТЕ, ЧТО В РАБОТЕ, ВПЕРЕДИ. Фаза может нести десяток волн в шапках своих планов, а идти будет
 * девятая — и полка реплик, начинающаяся с первой, предлагала бы остановить давно закрытое.
 * Поэтому сначала волны, о которых знает ОЧЕРЕДЬ (в них есть работа или на них стоит приказ), и
 * только потом остальные волны карточки фазы: там, где очередь ещё ничего не знает, остановить
 * заранее — законное желание, и приказ дождётся своих задач.
 *
 * Оба источника — данные. Ни одного номера волны в этом файле не написано.
 */
function wavesOfPhase(phase: string, card: PhaseCard | undefined, rows: WaveRow[]): string[] {
  const num = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
  const inWork = rows
    .filter((r) => r.phase === phase)
    .map((r) => r.wave)
    .sort(num)
  const known = new Set(inWork)
  const rest = (card?.waves ?? [])
    .map((w) => w.wave)
    .filter((w): w is number => w !== null)
    .map(String)
    .filter((w) => !known.has(w))
    .sort(num)
  return [...inWork, ...rest].slice(0, WAVE_CHIP_CAP)
}

/** «10.8 и 10.9» — перечисление словами, как их произносит человек. */
function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`
}

/** Имя задачи так, как её называют в разговоре: словами, а если их нет — идентификатором. */
const taskWords = (t: WaveTask) => t.title ?? t.id

/**
 * ОТВЕТ СИСТЕМЫ НА «ОСТАНОВИ ВОЛНУ N» — СОБРАННЫЙ ИЗ ДАННЫХ, а не напечатанный с числами.
 *
 * Тон — макета основателя: кто доведёт текущий шаг и встанет, кто уже стоит, что будет с
 * незакрытыми шагами, и вопрос подтверждения. Каждое имя в этой фразе приезжает из ряда
 * эшелонов, который движок посчитал по своей же очереди. Когда называть некого — так и
 * сказано: выдуманный список хуже честного «задач этой волны в очереди сейчас нет».
 */
function stopWords(wave: string, row: WaveRow | undefined): string {
  const running = (row?.running ?? []).map(taskWords)
  const waiting = (row?.waiting ?? []).map(taskWords)
  const parts: string[] = []
  if (running.length) parts.push(`${listWords(running)} ${running.length > 1 ? 'доведут' : 'доведёт'} текущий шаг и ${running.length > 1 ? 'встанут' : 'встанет'}`)
  if (waiting.length) parts.push(`${listWords(waiting)} ${waiting.length > 1 ? 'уже стоят' : 'уже стоит'}`)
  const who = parts.length
    ? `Могу остановить: ${parts.join(', ')}.`
    : `Задач волны ${wave} в очереди сейчас нет — останов запишется и удержит их, когда они появятся.`
  return `${who} Незакрытые шаги останутся в сессиях, продолжат с того же места. Подтвердить остановку?`
}

/** То же для снятия: что именно пойдёт дальше, если останов убрать. */
function resumeWords(wave: string, row: WaveRow | undefined): string {
  const waiting = (row?.waiting ?? []).map(taskWords)
  const who = waiting.length
    ? `Сниму останов: ${listWords(waiting)} снова ${waiting.length > 1 ? 'пойдут' : 'пойдёт'} работникам.`
    : `Сниму останов с волны ${wave}. Ждущих задач у неё сейчас нет — выдача просто перестанет удерживаться.`
  return `${who} Вставшие продолжат с того же места, а не начнут заново. Подтвердить снятие?`
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
  /**
   * ПРИКАЗ, КОТОРЫЙ ЖДЁТ ВТОРОГО НАЖАТИЯ.
   *
   * Останов волны глушит чужую работу, поэтому он не случается от одного касания: реплика
   * рассказывает, кого именно это заденет, и только потом появляется кнопка. Механический обход
   * (и рука, промахнувшаяся по полке реплик) в худшем случае получит вопрос, а не тишину в
   * парке. `null` — ничего не ждёт.
   */
  const [pendingWave, setPendingWave] = useState<{ phase: string; wave: string; action: 'hold' | 'release' } | null>(
    null,
  )

  const state = useStateQuery()
  const phaseIndex = usePhaseIndexQuery()
  // Книга читается ТОЛЬКО когда окно открыто: закрытое окно не спрашивает дверь ни о чём.
  const history = useChatHistoryQuery(open)
  const send = useSendChat()
  const enqueue = useEnqueue()
  const redirect = useRedirectTask()
  const holdWave = useHoldWave()

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

  // «Обсудить с системой» с баннера остановленной задачи — это просьба ПОКАЗАТЬСЯ, а не
  // второй разговор: контекст этой задачи окно уже знает от самого экрана.
  useEffect(() => {
    const onAsked = () => setOpen(true)
    window.addEventListener(CONSOLE_OPEN_EVENT, onAsked)
    return () => window.removeEventListener(CONSOLE_OPEN_EVENT, onAsked)
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

  // ── эшелоны открытой фазы: и предложение остановить, и слова ответа берутся ОТСЮДА ──
  const waveRows: WaveRow[] = state.data?.waves ?? []
  const phaseCard = usePhaseQuery(context.kind === 'phase' && context.phase ? context.phase : null)
  const waveChips = useMemo(
    () => (context.kind === 'phase' && context.phase ? wavesOfPhase(context.phase, phaseCard.data, waveRows) : []),
    [context.kind, context.phase, phaseCard.data, waveRows],
  )
  const heldWaves = useMemo(
    () => new Set(waveRows.filter((r) => r.held && r.phase === context.phase).map((r) => r.wave)),
    [waveRows, context.phase],
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
            ...(reply.answer.draft ? { draft: reply.answer.draft, fresh: true } : {}),
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
   * «Останови волну N» — ПЕРВОЕ нажатие. Ничего не происходит: окно рассказывает из данных,
   * кого именно это заденет, и оставляет вопрос. Приказ уезжает только со второго нажатия.
   */
  const askWave = (wave: string, action: 'hold' | 'release') => {
    const phase = context.phase
    if (!phase || holdWave.isPending) return
    setProblem(null)
    const row = waveRows.find((r) => r.phase === phase && r.wave === wave)
    append({
      key: `wave-said-${Date.now()}`,
      who: 'you',
      text: action === 'hold' ? `Останови волну ${wave}` : `Сними останов с волны ${wave}`,
      rode: `фаза ${phase}`,
    })
    append({
      key: `wave-asked-${Date.now()}`,
      who: 'system',
      text: action === 'hold' ? stopWords(wave, row) : resumeWords(wave, row),
    })
    setPendingWave({ phase, wave, action })
  }

  /** ВТОРОЕ нажатие — и только оно зовёт дверь. Отказ не делает ровно ничего. */
  const confirmWave = () => {
    if (!pendingWave || holdWave.isPending) return
    const { phase, wave, action } = pendingWave
    holdWave.mutate(
      { phase, wave, action },
      {
        onSuccess: (res) => {
          setPendingWave(null)
          append({
            key: `wave-done-${Date.now()}`,
            who: 'system',
            text: res.already
              ? `Волна ${wave} фазы ${phase} и так ${action === 'hold' ? 'остановлена' : 'идёт'} — в реестре ничего не изменилось.`
              : action === 'hold'
                ? `Остановил волну ${wave} фазы ${phase}. Новых задач этой волны никто не получит; живые доведут текущий шаг и встанут. Останов записан — он переживёт перезапуск.`
                : `Снял останов с волны ${wave} фазы ${phase}. Выдача пошла, вставшие продолжают с того же места.`,
          })
        },
        onError: (err) => {
          setPendingWave(null)
          setProblem(refusalWords(err))
        },
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

  const draftLines = lines.filter((l) => l.draft && l.fresh)

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
                ) : line.fresh ? (
                  <button
                    type="button"
                    disabled={enqueue.isPending}
                    onClick={() => createFromDraft(line.key, line.draft as ChatDraft)}
                    className="mt-2 rounded-[7px] bg-blue-d px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-60"
                  >
                    {enqueue.isPending ? 'Ставлю…' : 'Создать'}
                  </button>
                ) : (
                  <div className="mt-2 text-[11px] leading-[1.45] text-tx3">
                    Предложение из прошлого разговора — кнопки у него нет. Скажите его заново, если
                    оно ещё нужно.
                  </div>
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

        {/* Второе нажатие приказа об эшелоне. Стоит НАД полем ввода и ниже реплики, которая
            только что назвала, кого это заденет: кнопка без своей причины рядом — это кнопка,
            которую нажимают не глядя. */}
        {pendingWave ? (
          <div className="rounded-[9px] border border-warn/40 bg-warn-s px-3 py-2.5">
            <div className="font-mono text-[11px] font-semibold text-warn-tx uppercase">
              {pendingWave.action === 'hold' ? 'останов волны' : 'снятие останова'} · фаза {pendingWave.phase} ·
              волна {pendingWave.wave}
            </div>
            <p className="m-0 mt-1 text-[11px] leading-[1.45] text-tx2">
              {pendingWave.action === 'hold'
                ? 'Ничего не убивается: работа доводит текущий шаг и встаёт, сессии остаются.'
                : 'Выдача пойдёт снова, вставшие продолжат с того же места.'}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={holdWave.isPending}
                onClick={confirmWave}
                className="rounded-[5px] border border-warn-tx px-[11px] py-1.5 text-[11.5px] font-semibold text-warn-tx disabled:opacity-60"
              >
                {/* Кнопка ОТВЕЧАЕТ на вопрос, а не повторяет его. Слова «подтвердить остановку»
                    уже стоят в реплике системы четырьмя строками выше — кнопка с тем же текстом
                    неотличима от вопроса ни для машинного обхода, ни для читалки, ни для
                    человека, который ищет глазами, куда нажать. Поэтому здесь ответ и адрес. */}
                {holdWave.isPending
                  ? 'Передаю…'
                  : pendingWave.action === 'hold'
                    ? `Да, остановить волну ${pendingWave.wave}`
                    : `Да, снять останов с волны ${pendingWave.wave}`}
              </button>
              <button
                type="button"
                disabled={holdWave.isPending}
                onClick={() => {
                  setPendingWave(null)
                  append({
                    key: `wave-no-${Date.now()}`,
                    who: 'system',
                    text: 'Не трогаю. Ничего не изменилось — волна идёт как шла.',
                  })
                }}
                className="rounded-[5px] border border-bd2 px-[11px] py-1.5 text-[11.5px] font-semibold text-tx2 disabled:opacity-60"
              >
                Отмена
              </button>
            </div>
          </div>
        ) : null}

        {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
        <div ref={bottomRef} />
      </div>

      <div className="flex-none border-t border-bd bg-card px-3 pt-2.5 pb-3">
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {/* Реплики об эшелонах — только там, где эшелоны есть: на виде фазы с волнами. Номер
              берётся с открытого экрана, а не печатается здесь. Уже остановленная волна
              предлагает обратное действие — второй кнопки «остановить остановленное» не бывает. */}
          {waveChips.map((w) => {
            const held = heldWaves.has(w)
            const label = held ? `Сними останов с волны ${w}` : `Останови волну ${w}`
            return (
              <button
                key={`wave-${w}`}
                type="button"
                disabled={holdWave.isPending}
                onClick={() => askWave(w, held ? 'release' : 'hold')}
                className={`rounded-[14px] border px-2.5 py-[5px] text-[11px] disabled:opacity-60 ${
                  held ? 'border-warn/50 bg-warn-s text-warn-tx' : 'border-bd2 bg-card text-tx2 hover:border-blue hover:text-blue'
                }`}
              >
                {label}
              </button>
            )
          })}
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
