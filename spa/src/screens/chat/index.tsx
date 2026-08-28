import { useEffect, useRef, useState } from 'react'
import { isNotReady } from '../../api/client'
import { useApprove, useChatHistoryQuery, useEnqueue, usePhaseStage, useReturnTask, useSendChat, useStateQuery, useStopChat } from '../../api/queries'
import type { ChatTurn } from '../../api/types'
import { approvalRefusal, refusalWords } from '../../shell/format'
import { openScreen } from '../../shell/navigation'
import { TaskPanel } from '../../shell/TaskPanel'
import { useComposerDraft } from '../../shell/useComposerDraft'
import type { ScreenId } from '../registry'
import { AttachmentViewer } from './AttachmentViewer'
import { Awaiting } from './Awaiting'
import { Composer } from './Composer'
import { bookOf, threadOf } from './thread'
import { TurnList } from './TurnList'
import type { ChatEntry } from './TurnList'

/**
 * «Разговор» — the screen where the founder asks the team a question in their own words.
 *
 * ═════════════════════════ IT READS AND IT SUGGESTS ═════════════════════════
 *
 * Three of the four kinds of question are answered from the READ MODELS the rest of the
 * window already renders: why a task failed, what the window went on, where a task stands.
 * Those answers cost nothing and cannot disagree with the screens — they come from the same
 * figures. Only an open question wakes a session, on a lane outside the queue, and that turn
 * pays for itself in public on «Расходы».
 *
 * ═════════════════════ НИЧЕГО НЕ НАЧИНАЕТСЯ БЕЗ СОГЛАСИЯ ═════════════════════
 *
 * The one mutating thing that can come out of a conversation is a DRAFT, и задачей он
 * становится ровно тогда, когда человек согласился: нажал «Создать» — или ответил «да» в
 * самом разговоре. Нажатие по-прежнему шлёт обычный запрос очереди, как и любой другой экран;
 * слово уходит обычным ходом разговора, и ставит задачу демон своей дверью. На этом экране
 * эффекта, который ставит задачу сам, нет ни для одного из двух путей — ответ, что бы в нём
 * ни было сказано и кто бы его ни надиктовал, работу отсюда не начинает.
 *
 * Приёмка не делается ни словом, ни с телефона: «Одобрить» и «Вернуть» — рука человека здесь.
 * Строка под полем ввода говорит обе половины границы там, где эта рука.
 *
 * ═══════════════════ THE BOOK SEEDS IT; THE SESSION FILLS IT ═══════════════════
 *
 * The transcript is read ONCE, when the screen opens. It is a record of what was said — not
 * the truth about the park, which is always the reading. Every turn taken while the screen
 * is open is appended here as it happens, keeping the one thing the book does not keep: the
 * figures behind a spend answer.
 *
 * ═════════════ A WORKPLACE: THE QUESTIONS, THE DOCUMENTS, THE WORK ═════════════
 *
 * Above the feed sit the questions the machine stopped on, on the shell's own card — the same
 * card the phase screen mounts, because answering is the same act wherever it is done. Beside
 * a reply sit the documents it named, opened here as plain text instead of in a terminal. And
 * a sentence that puts work becomes a draft with a lane, or — for a stage of a phase — a
 * draft whose button is the phase cycle's own door, never a second way in.
 */

/** Where an answer's link is allowed to send the reader — its name for a screen, and ours. */
const LINK_SCREENS: Record<string, ScreenId> = {
  spend: 'costs',
  costs: 'costs',
  today: 'today',
  tasks: 'tasks',
}

/** A turn of the stored book, in the shape this screen holds turns. */
function entryOf(turn: ChatTurn, index: number): ChatEntry {
  return {
    key: `book-${index}`,
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    text: turn.text,
    ts: turn.ts,
    ...(turn.taskRef ? { taskRef: turn.taskRef } : {}),
    ...(turn.draft ? { draft: turn.draft } : {}),
    ...(turn.decision ? { decision: turn.decision } : {}),
    ...(turn.attachments ? { attachments: turn.attachments } : {}),
  }
}

function Pill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className="text-[16px] font-bold text-tx tabular-nums">{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const history = useChatHistoryQuery()
  const send = useSendChat()
  const stop = useStopChat()
  const enqueue = useEnqueue()
  const startStage = usePhaseStage()

  const [entries, setEntries] = useState<ChatEntry[]>([])
  // Разговор назван РАНЬШЕ поля ввода, потому что черновик набора привязан к разговору: пока
  // разговора нет, набирают «в новый», а после первого ответа у него появляется собственное
  // имя, и поверхность набора вместе с ним. Смену имени хук улаживает сам.
  const [conversationId, setConversationId] = useState<string | undefined>(undefined)
  const [text, setText] = useComposerDraft(`chat.${conversationId ?? 'new'}`)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [createdTasks, setCreatedTasks] = useState<Record<string, string>>({})
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  const [decided, setDecided] = useState<Record<string, 'approved' | 'returned'>>({})
  const [decidingKey, setDecidingKey] = useState<string | null>(null)
  const [decidingReturn, setDecidingReturn] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // ЧЕЙ РАЗГОВОР СЕЙЧАС НА ЭКРАНЕ. Не «прочитана ли книга», а «книга КАКОГО проекта прочитана»:
  // после переключения это разные вопросы, и первый из них отвечал «да» на чужую беседу.
  // `undefined` — не читали ещё ничего; `null` — читали при невыбранном проекте.
  const seededFor = useRef<string | null | undefined>(undefined)
  const bottom = useRef<HTMLDivElement | null>(null)

  // ── the live turn: its client-minted id (for Стоп) and a per-second tick (for the
  // «Думает · Ns» line). The tick is pure presentation — the truth is send.isPending. ──
  const liveTurnId = useRef<string | null>(null)
  const [thinkingSec, setThinkingSec] = useState(0)
  useEffect(() => {
    if (!send.isPending) {
      setThinkingSec(0)
      return
    }
    const t = window.setInterval(() => setThinkingSec((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [send.isPending])

  // ── КНИГА ЧИТАЕТСЯ ОДИН РАЗ НА ПРОЕКТ ────────────────────────────────────────────────
  //
  // Перечитывание посреди живой беседы повторило бы ходы, которые экран уже держит, — и с
  // меньшим в них, чем он держит. Но «один раз» означает «один раз на ПРОЕКТ»: переключение
  // проекта — это другая книга, другая нить и пустая лента, а не продолжение прежнего
  // разговора под новой доской. Пока новая книга едет, засев не трогается: старые ходы,
  // положенные в ленту на секунду, — это ровно та чужая беседа, от которой всё затевалось.
  const project = state.data?.activeProject ?? null
  useEffect(() => {
    if (!history.data || history.isFetching) return
    if (seededFor.current === project) return
    seededFor.current = project
    const book = bookOf(history.data.turns, project)
    setEntries(book.map(entryOf))
    // Нити у этого проекта может не быть вовсе — тогда следующий ход начинает новую.
    setConversationId(threadOf(book))
  }, [history.data, history.isFetching, project])

  // A new turn belongs at the bottom of the eye, like every messenger a person already uses.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, send.isPending])

  const append = (entry: ChatEntry) => setEntries((prev) => [...prev, entry])

  const onSend = () => {
    const said = text.trim()
    if (!said || send.isPending) return
    setText('')
    setProblem(null)
    append({ key: `said-${Date.now()}`, role: 'user', text: said, ts: new Date().toISOString() })

    // The turn id is minted HERE, before the request leaves: Стоп needs a name for the
    // turn while it is still running, and only the client has one that early.
    const turnId = `ct-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    liveTurnId.current = turnId

    send.mutate(
      { text: said, turnId, ...(conversationId ? { conversationId } : {}) },
      {
        onSuccess: (reply) => {
          liveTurnId.current = null
          setConversationId(reply.conversationId)
          const answer = reply.answer
          // A turn the founder ENDED: the words they sent come back into the composer for
          // editing — their Стоп is a redirect, not a loss (recon 11.08, Multica idea 3).
          if (answer.kind === 'stopped') {
            setText(said)
            append({ key: `stopped-${Date.now()}`, role: 'assistant', text: answer.text, ts: new Date().toISOString() })
            return
          }
          append({
            key: `heard-${Date.now()}`,
            role: 'assistant',
            text: answer.text,
            ts: new Date().toISOString(),
            ...(answer.taskRef ? { taskRef: answer.taskRef } : {}),
            ...(answer.draft ? { draft: answer.draft } : {}),
            ...(answer.decision ? { decision: answer.decision } : {}),
            ...(answer.spend ? { spend: answer.spend } : {}),
            ...(answer.link ? { link: answer.link } : {}),
            ...(answer.attachments ? { attachments: answer.attachments } : {}),
          })
        },
        onError: (err) => {
          liveTurnId.current = null
          setProblem(isNotReady(err) ? 'Разговор на этой машине пока не включён.' : refusalWords(err))
        },
      },
    )
  }

  /** Стоп: pull the trigger; the send request itself answers kind:'stopped' and returns the text. */
  const onStop = () => {
    const id = liveTurnId.current
    if (id) stop.mutate({ turnId: id })
  }

  /**
   * The person's own hand — the ONLY path from a conversation to work of any kind.
   *
   * A STAGE goes to the phase cycle's door, the very same one «Конвейер фаз» presses. It does
   * NOT go to the queue directly: which lane a stage runs on and what command it carries are
   * that door's business, and a second author of either would be a second way to start a
   * stage — which is precisely the thing the frozen dictionary behind that door exists to
   * prevent. This screen sends a phase and a stage name and nothing else.
   *
   * A TASK goes to the ordinary queue door every other screen posts to. Its lane comes from
   * the draft when the draft named one; otherwise from the proposed worker's own lane, since
   * the queue takes a lane and routes within it. A worker with no lane cannot be routed to,
   * and that is said plainly rather than posted as a guess.
   */
  const createFromDraft = (entry: ChatEntry) => {
    const draft = entry.draft
    if (!draft || creatingKey) return

    if (draft.data && draft.data.kind === 'stage') {
      const { phase, stage } = draft.data
      setProblem(null)
      setCreatingKey(entry.key)
      startStage.mutate(
        { phase, stage },
        {
          onSuccess: (result) => {
            setCreatingKey(null)
            setCreatedTasks((prev) => ({ ...prev, [entry.key]: result.taskId }))
          },
          onError: (err) => {
            setCreatingKey(null)
            setProblem(refusalWords(err))
          },
        },
      )
      return
    }

    const worker = draft.worker ? state.data?.rules.workers.find((w) => w.id === draft.worker) : undefined
    const lane = draft.lane ?? worker?.lane ?? null
    if (!lane) {
      setProblem(
        draft.worker
          ? `Не удалось поставить: у исполнителя «${draft.worker}» не назначена линия работы.`
          : 'Не удалось поставить: в черновике не названа линия работы.',
      )
      return
    }
    setProblem(null)
    setCreatingKey(entry.key)
    enqueue.mutate(
      { title: draft.title, lane },
      {
        onSuccess: (result) => {
          setCreatingKey(null)
          setCreatedTasks((prev) => ({ ...prev, [entry.key]: result.id }))
        },
        onError: (err) => {
          setCreatingKey(null)
          setProblem(refusalWords(err))
        },
      },
    )
  }

  /** «Поправить» — the draft's words go back into the input, to be said differently. */
  const amendDraft = (entry: ChatEntry) => {
    if (!entry.draft) return
    setText(entry.draft.title)
  }

  const approve = useApprove()
  const returnTask = useReturnTask()

  /**
   * The person's hand on a DECISION the conversation proposed. Both handlers press the very
   * doors the task panel presses — approve with its refusal words kept on screen, return
   * with its required comment — and mark the entry so the card states the outcome. There is
   * no effect here that decides: a click, a door, an answer.
   */
  const approveDecision = (entry: ChatEntry) => {
    const taskId = entry.decision?.taskId
    if (!taskId || decidingKey) return
    setProblem(null)
    setDecidingKey(entry.key)
    setDecidingReturn(false)
    approve.mutate(
      { taskId },
      {
        // Отказ приёмки — не успех: карточка остаётся с кнопками, слова отказа — на экране.
        onSuccess: (out) => {
          setDecidingKey(null)
          const refused = approvalRefusal(out)
          if (refused) {
            setProblem(refused)
            return
          }
          setDecided((prev) => ({ ...prev, [entry.key]: 'approved' }))
        },
        onError: (err) => {
          setDecidingKey(null)
          setProblem(refusalWords(err))
        },
      },
    )
  }

  const returnDecision = (entry: ChatEntry, note: string) => {
    const taskId = entry.decision?.taskId
    if (!taskId || decidingKey) return
    const said = note.trim()
    if (said.length === 0) {
      setProblem('Напишите, что поправить — работник вернётся именно к этому.')
      return
    }
    setProblem(null)
    setDecidingKey(entry.key)
    setDecidingReturn(true)
    returnTask.mutate(
      { taskId, note: said },
      {
        onSuccess: () => {
          setDecidingKey(null)
          setDecided((prev) => ({ ...prev, [entry.key]: 'returned' }))
        },
        onError: (err) => {
          setDecidingKey(null)
          setProblem(refusalWords(err))
        },
      },
    )
  }

  const followLink = (screen: string) => {
    const known = LINK_SCREENS[screen]
    if (known) openScreen({ screen: known })
  }

  const kpis = state.data?.kpis
  const empty = entries.length === 0 && !send.isPending

  return (
    <section className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
          <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Разговор</h1>
          {kpis ? (
            <>
              <Pill value={String(kpis.workersBusy)} label="в работе" />
              <Pill value={String(kpis.awaitingApproval)} label="ждут Вашего решения" />
            </>
          ) : null}
        </header>

        {problem ? (
          <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
            <span aria-hidden className="flex-none text-warn-tx">
              ●
            </span>
            <span className="text-[12.5px] text-tx">{problem}</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Questions first: work is standing still while they wait, and a thing to answer
              belongs above the thing to read. It renders nothing at all when nothing is open. */}
          <Awaiting onOpenAttachment={setReading} />

          {empty ? (
            <div className="flex flex-1 items-center justify-center p-10">
              <span className="text-[13.5px] text-tx2">Спросите о работе команды или продиктуйте задачу.</span>
            </div>
          ) : (
            <TurnList
              entries={entries}
              createdTasks={createdTasks}
              creatingKey={creatingKey}
              decided={decided}
              decidingKey={decidingKey}
              decidingReturn={decidingReturn}
              thinking={send.isPending}
              thinkingSec={thinkingSec}
              onOpenTask={setOpenTaskId}
              onFollowLink={followLink}
              onCreateDraft={createFromDraft}
              onAmendDraft={amendDraft}
              onApproveDecision={approveDecision}
              onReturnDecision={returnDecision}
              onOpenAttachment={setReading}
            />
          )}
          {/* Запас под прилипшим полем ввода: прокрутка к концу ленты останавливается так,
              чтобы последняя реплика осталась НАД ним, а не спряталась под ним. */}
          <div ref={bottom} className="scroll-mb-[92px]" />
        </div>

        <Composer value={text} onChange={setText} onSend={onSend} onStop={onStop} busy={send.isPending} />
      </div>

      {/* The same panel «Сегодня» opens, borrowed from the shell — never a second copy of it. */}
      {openTaskId ? <TaskPanel taskId={openTaskId} onClose={() => setOpenTaskId(null)} /> : null}
      {reading ? <AttachmentViewer rel={reading} onClose={() => setReading(null)} /> : null}
    </section>
  )
}
