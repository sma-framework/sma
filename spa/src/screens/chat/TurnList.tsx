import type { ChatAnswerLink, ChatAttachment, ChatDecision, ChatDraft, ChatSpendShare, ChatTaskRef } from '../../api/types'
import { statusTone, statusWord } from '../../shell/format'
import { DecisionProposal } from './DecisionProposal'
import { DraftCard } from './DraftCard'

/**
 * TurnList — the conversation as it was actually held, oldest first.
 *
 * ═══════════════════════ EVERY TURN IS A TEXT NODE ═══════════════════════
 *
 * The team lead's words come out of a language model, which makes them the least trusted
 * text in the whole window. They are rendered as CHILDREN, always — there is no
 * `dangerouslySetInnerHTML` in this folder and no path by which an answer could become
 * markup. What the model can influence is what a person READS, never what the page DOES.
 *
 * The structure around the words is not the model's either: a task card is drawn from the
 * daemon's own explicit-picked reference, a draft from a proposal the daemon validated
 * against the roster, a spend line from figures the spend book counted. The model supplies
 * prose; everything with a border around it was checked before it left the machine.
 */

/** One entry of the conversation, as this screen holds it. */
export interface ChatEntry {
  /** Stable within the session — the list is append-only, so the index is the identity. */
  key: string
  role: 'user' | 'assistant'
  text: string
  /** When it was said. Absent on a turn the transcript did not date. */
  ts: string | null
  taskRef?: ChatTaskRef
  draft?: ChatDraft
  /** A task the reply says is ready to be decided — the buttons are the person's. */
  decision?: ChatDecision
  /** Present only on the live answer — the transcript keeps figures nowhere. */
  spend?: ChatSpendShare[]
  link?: ChatAnswerLink
  /** Documents this reply named. The transcript DOES keep these — a reply still points. */
  attachments?: ChatAttachment[]
}

/** The clock face of a turn. A turn with no moment shows nothing rather than a guess. */
function timeOf(ts: string | null): string {
  if (!ts) return ''
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** The mark beside the team lead's name — the same gradient the window wears at the top. */
function LeadMark() {
  return (
    <span
      aria-hidden
      className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[8px] bg-gradient-to-br from-blue-d via-teal to-green"
    >
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <rect x="3.4" y="2.6" width="7" height="1.7" rx=".85" fill="#fff" opacity=".95" />
        <rect x="1.9" y="5.6" width="9.2" height="1.7" rx=".85" fill="#fff" opacity=".95" />
        <rect x="1.1" y="8.6" width="6.8" height="1.7" rx=".85" fill="#fff" opacity=".95" />
      </svg>
    </span>
  )
}

/**
 * The grey card an answer puts under its sentence when it was about one task. It opens the
 * same panel the day's feed opens — one task, one panel, one set of habits.
 */
function TaskLink({ taskRef, onOpen }: { taskRef: ChatTaskRef; onOpen: (taskId: string) => void }) {
  const id = taskRef.id
  const label = taskRef.statusLabel ?? statusWord(taskRef.status)
  return (
    <button
      type="button"
      disabled={!id}
      onClick={() => id && onOpen(id)}
      className={`flex w-full max-w-[640px] items-center gap-2.5 rounded-[10px] border border-bd bg-surf px-[11px] py-[9px] text-left ${
        id ? 'cursor-pointer hover:border-bd2' : 'cursor-default'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-tx">
        {taskRef.title ?? 'Задача без названия'}
      </span>
      <span className={`flex-none rounded-full px-2 py-[3px] text-[11px] font-semibold whitespace-nowrap ${statusTone(taskRef.status)}`}>
        {label}
      </span>
      {id ? (
        <span aria-hidden className="flex-none text-[12px] text-tx3">
          ›
        </span>
      ) : null}
    </button>
  )
}

/**
 * The spend answer: one bar per share, and the way through to the screen that owns money.
 * The percentages are the ones the spend book counted, never re-derived here.
 */
function SpendLines({
  spend,
  link,
  onFollow,
}: {
  spend: ChatSpendShare[]
  link?: ChatAnswerLink
  onFollow: (screen: string) => void
}) {
  return (
    <div className="flex max-w-[480px] flex-col gap-1.5">
      {spend.map((share) => (
        <div key={share.id} className="grid grid-cols-[120px_1fr_46px] items-center gap-3">
          <span className="truncate text-[12.5px] text-tx2">{share.label}</span>
          <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-track">
            <span
              className="block h-1 rounded-full bg-green"
              style={{ width: `${Math.max(0, Math.min(100, share.percent))}%` }}
            />
          </span>
          <span className="text-right text-[12.5px] font-semibold text-tx tabular-nums">{share.percent} %</span>
        </div>
      ))}
      {link ? (
        <button
          type="button"
          onClick={() => onFollow(link.screen)}
          className="mt-1 flex items-center gap-1.5 self-start text-[12px] font-medium text-blue hover:text-teal"
        >
          <span>{link.label}</span>
          <span aria-hidden>›</span>
        </button>
      ) : null}
    </div>
  )
}

/**
 * The documents a reply named, as buttons.
 *
 * The path is shown as it arrived and handed to the viewer untouched: a person can see WHICH
 * file they are about to open, and the door — not this row — decides whether it may be. The
 * label is the file's own name, because that is what a person recognises; the path underneath
 * is there so a button never opens something other than what it says.
 */
function Attachments({
  attachments,
  onOpen,
}: {
  attachments: ChatAttachment[]
  onOpen: (rel: string) => void
}) {
  return (
    <div className="flex max-w-[640px] flex-col gap-1">
      {attachments.map((a) => (
        <button
          key={a.rel}
          type="button"
          onClick={() => onOpen(a.rel)}
          className="flex w-full items-center gap-2.5 rounded-[10px] border border-bd bg-surf px-[11px] py-[9px] text-left hover:border-bd2"
        >
          <span aria-hidden className="flex-none text-[12px] text-tx3">
            ▤
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-tx">
              {a.rel.split('/').filter(Boolean).pop() ?? a.rel}
            </span>
            <span className="block truncate font-mono text-[10.5px] text-tx3">{a.rel}</span>
          </span>
          <span className="flex-none text-[11.5px] font-medium text-blue">Открыть</span>
        </button>
      ))}
    </div>
  )
}

function HumanTurn({ entry }: { entry: ChatEntry }) {
  const time = timeOf(entry.ts)
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[70%] flex-col items-end gap-1">
        <div className="rounded-[12px_12px_4px_12px] border border-bd bg-blue-s px-3 py-2.5 text-[13px] whitespace-pre-wrap text-tx">
          {entry.text}
        </div>
        <span className="pr-0.5 text-[10.5px] text-tx3">{time ? `Вы · ${time}` : 'Вы'}</span>
      </div>
    </div>
  )
}

function LeadTurn({
  entry,
  createdTaskId,
  creating,
  decidedOutcome,
  deciding,
  returning,
  onOpenTask,
  onFollowLink,
  onCreateDraft,
  onAmendDraft,
  onApproveDecision,
  onReturnDecision,
  onOpenAttachment,
}: {
  entry: ChatEntry
  createdTaskId?: string
  creating: boolean
  decidedOutcome?: 'approved' | 'returned'
  deciding: boolean
  returning: boolean
  onOpenTask: (taskId: string) => void
  onFollowLink: (screen: string) => void
  onCreateDraft: (entry: ChatEntry) => void
  onAmendDraft: (entry: ChatEntry) => void
  onApproveDecision: (entry: ChatEntry) => void
  onReturnDecision: (entry: ChatEntry, note: string) => void
  onOpenAttachment: (rel: string) => void
}) {
  return (
    <div className="flex items-start gap-2.5">
      <LeadMark />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-tx">Руководитель команды</span>
          <span className="text-[10.5px] text-tx3">{timeOf(entry.ts)}</span>
        </div>
        {entry.text ? (
          <div className="max-w-[76%] text-[13px] whitespace-pre-wrap text-tx">{entry.text}</div>
        ) : null}
        {entry.spend && entry.spend.length > 0 ? (
          <SpendLines spend={entry.spend} link={entry.link} onFollow={onFollowLink} />
        ) : null}
        {entry.taskRef ? <TaskLink taskRef={entry.taskRef} onOpen={onOpenTask} /> : null}
        {entry.attachments && entry.attachments.length > 0 ? (
          <Attachments attachments={entry.attachments} onOpen={onOpenAttachment} />
        ) : null}
        {entry.draft ? (
          <DraftCard
            draft={entry.draft}
            createdTaskId={createdTaskId}
            creating={creating}
            onCreate={() => onCreateDraft(entry)}
            onAmend={() => onAmendDraft(entry)}
            onOpenTask={onOpenTask}
          />
        ) : null}
        {entry.decision ? (
          <DecisionProposal
            decision={entry.decision}
            outcome={decidedOutcome}
            busy={deciding}
            returning={returning}
            onApprove={() => onApproveDecision(entry)}
            onReturn={(note) => onReturnDecision(entry, note)}
            onOpenTask={onOpenTask}
          />
        ) : null}
      </div>
    </div>
  )
}

export function TurnList({
  entries,
  createdTasks,
  creatingKey,
  decided,
  decidingKey,
  decidingReturn = false,
  thinking,
  thinkingSec = 0,
  onOpenTask,
  onFollowLink,
  onCreateDraft,
  onAmendDraft,
  onApproveDecision,
  onReturnDecision,
  onOpenAttachment,
}: {
  entries: ChatEntry[]
  /** Which drafts have already become tasks, and which task each one became. */
  createdTasks: Record<string, string>
  /** The draft whose «Создать» is in flight, if any. */
  creatingKey: string | null
  /** Which decision proposals the person has decided, and how each one ended. */
  decided: Record<string, 'approved' | 'returned'>
  /** The decision whose button is in flight, if any. */
  decidingKey: string | null
  /** Whether the in-flight decision is a return — so the pressed button speaks, not both. */
  decidingReturn?: boolean
  thinking: boolean
  /** Секунды текущего хода — цифра тикает в самом статусе: живую систему видно по движению
   *  (разведка 11.08, урок Multica «Thinking · 40s»). */
  thinkingSec?: number
  onOpenTask: (taskId: string) => void
  onFollowLink: (screen: string) => void
  onCreateDraft: (entry: ChatEntry) => void
  onAmendDraft: (entry: ChatEntry) => void
  onApproveDecision: (entry: ChatEntry) => void
  onReturnDecision: (entry: ChatEntry, note: string) => void
  onOpenAttachment: (rel: string) => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-[800px] flex-col gap-[18px] px-7 pt-5 pb-6">
      {entries.map((entry) =>
        entry.role === 'user' ? (
          <HumanTurn key={entry.key} entry={entry} />
        ) : (
          <LeadTurn
            key={entry.key}
            entry={entry}
            createdTaskId={createdTasks[entry.key]}
            creating={creatingKey === entry.key}
            decidedOutcome={decided[entry.key]}
            deciding={decidingKey === entry.key}
            returning={decidingKey === entry.key && decidingReturn}
            onOpenTask={onOpenTask}
            onFollowLink={onFollowLink}
            onCreateDraft={onCreateDraft}
            onAmendDraft={onAmendDraft}
            onApproveDecision={onApproveDecision}
            onReturnDecision={onReturnDecision}
            onOpenAttachment={onOpenAttachment}
          />
        ),
      )}

      {/* The wait, said once and quietly. A conversation that flashes while it thinks is a
          conversation a person watches instead of works beside. */}
      {thinking ? (
        <div className="flex items-center gap-2.5">
          <LeadMark />
          <span className="text-[12.5px] text-tx3 tabular-nums">
            {thinkingSec > 0 ? `Думает · ${thinkingSec} с` : 'думает…'}
          </span>
        </div>
      ) : null}
    </div>
  )
}
