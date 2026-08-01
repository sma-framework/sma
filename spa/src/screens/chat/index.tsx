import { useEffect, useRef, useState } from 'react'
import { isNotReady } from '../../api/client'
import { useChatHistoryQuery, useEnqueue, useSendChat, useStateQuery } from '../../api/queries'
import type { ChatTurn } from '../../api/types'
import { refusalWords } from '../../shell/format'
import { openScreen } from '../../shell/navigation'
import { TaskPanel } from '../../shell/TaskPanel'
import type { ScreenId } from '../registry'
import { Composer } from './Composer'
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
 * ═════════════════════════ NOTHING STARTS BY ITSELF ═════════════════════════
 *
 * The one mutating thing that can come out of a conversation is a DRAFT, and a draft
 * becomes work at exactly one moment: a person presses «Создать». That press posts the
 * ordinary task request every other screen posts. There is no effect on this screen that
 * enqueues, so an answer — whatever it says, and whoever caused it to say it — cannot put
 * work in the queue. The line under the input says this where the hand is.
 *
 * ═══════════════════ THE BOOK SEEDS IT; THE SESSION FILLS IT ═══════════════════
 *
 * The transcript is read ONCE, when the screen opens. It is a record of what was said — not
 * the truth about the park, which is always the reading. Every turn taken while the screen
 * is open is appended here as it happens, keeping the one thing the book does not keep: the
 * figures behind a spend answer.
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
  const enqueue = useEnqueue()

  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [text, setText] = useState('')
  const [conversationId, setConversationId] = useState<string | undefined>(undefined)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [createdTasks, setCreatedTasks] = useState<Record<string, string>>({})
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const seeded = useRef(false)
  const bottom = useRef<HTMLDivElement | null>(null)

  // The book is read once. Re-reading it during a live conversation would replay turns this
  // screen already holds — with less in them than it holds.
  useEffect(() => {
    if (seeded.current || !history.data) return
    seeded.current = true
    setEntries(history.data.turns.map(entryOf))
    const last = [...history.data.turns].reverse().find((t) => t.conversationId)
    if (last?.conversationId) setConversationId(last.conversationId)
  }, [history.data])

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

    send.mutate(
      { text: said, ...(conversationId ? { conversationId } : {}) },
      {
        onSuccess: (reply) => {
          setConversationId(reply.conversationId)
          const answer = reply.answer
          append({
            key: `heard-${Date.now()}`,
            role: 'assistant',
            text: answer.text,
            ts: new Date().toISOString(),
            ...(answer.taskRef ? { taskRef: answer.taskRef } : {}),
            ...(answer.draft ? { draft: answer.draft } : {}),
            ...(answer.spend ? { spend: answer.spend } : {}),
            ...(answer.link ? { link: answer.link } : {}),
          })
        },
        onError: (err) => {
          setProblem(isNotReady(err) ? 'Разговор на этой машине пока не включён.' : refusalWords(err))
        },
      },
    )
  }

  /**
   * «Создать» — the person's own hand, and the ONLY path from a conversation to the queue.
   *
   * The draft names a worker; the queue takes a LANE and routes within it, so the worker's
   * own lane is what travels. A worker with no lane cannot be routed to, and that is said
   * plainly rather than posted as a guess.
   */
  const createFromDraft = (entry: ChatEntry) => {
    const draft = entry.draft
    if (!draft || creatingKey) return
    const worker = state.data?.rules.workers.find((w) => w.id === draft.worker)
    const lane = worker?.lane ?? null
    if (!lane) {
      setProblem(`Не удалось поставить: у исполнителя «${draft.worker}» не назначена линия работы.`)
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
          {empty ? (
            <div className="flex flex-1 items-center justify-center p-10">
              <span className="text-[13.5px] text-tx2">Спросите о работе команды или продиктуйте задачу.</span>
            </div>
          ) : (
            <TurnList
              entries={entries}
              createdTasks={createdTasks}
              creatingKey={creatingKey}
              thinking={send.isPending}
              onOpenTask={setOpenTaskId}
              onFollowLink={followLink}
              onCreateDraft={createFromDraft}
              onAmendDraft={amendDraft}
            />
          )}
          <div ref={bottom} />
        </div>

        <Composer value={text} onChange={setText} onSend={onSend} busy={send.isPending} />
      </div>

      {/* The same panel «Сегодня» opens, borrowed from the shell — never a second copy of it. */}
      {openTaskId ? <TaskPanel taskId={openTaskId} onClose={() => setOpenTaskId(null)} /> : null}
    </section>
  )
}
