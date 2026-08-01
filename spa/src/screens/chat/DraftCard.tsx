import type { ChatDraft } from '../../api/types'

/**
 * DraftCard — a task the conversation OFFERS, and the two things a person can do with it.
 *
 * ═════════════════════ THE HANDS ARE TIED, AND IN PLAIN SIGHT ═════════════════════
 *
 * The conversation cannot put work in the queue. It has no path to it: the engine reads the
 * park and never writes, and the queue-writing verb does not appear in it at all. What it
 * can do is DRAFT — and a draft becomes a task at exactly one moment, when a person presses
 * «Создать» with their own hand.
 *
 * That is why the request behind this button is the ORDINARY one: the very same
 * POST /api/enqueue every other screen posts, sent from a click handler and from nowhere
 * else. There is no effect in this folder that enqueues, so nothing arriving in an answer —
 * however it is phrased, whoever phrased it — can cause work to start. The daemon holds its
 * own gate behind that anyway; this is the half a person can SEE.
 *
 * The line under the buttons says so out loud, in the founder's own words.
 */
export function DraftCard({
  draft,
  createdTaskId,
  creating,
  onCreate,
  onAmend,
  onOpenTask,
}: {
  draft: ChatDraft
  /** Set once the draft has become a real task — the card then points at it. */
  createdTaskId?: string
  creating: boolean
  onCreate: () => void
  onAmend: () => void
  onOpenTask: (taskId: string) => void
}) {
  const done = !!createdTaskId

  return (
    <div className="max-w-[480px] overflow-hidden rounded-[11px] border border-bd2 bg-card shadow-panel">
      <div className="flex items-center gap-2 border-b border-bd bg-surf px-3 py-2">
        <span className="text-[10.5px] tracking-[0.1em] text-tx3 uppercase">Черновик задачи</span>
      </div>

      <div className="p-3">
        <div className="mb-2.5 text-[13.5px] font-semibold text-tx">{draft.title}</div>

        <div className="mb-3 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
          <span className="text-[11.5px] text-tx3">Предлагаемый исполнитель</span>
          <span className="text-[11.5px] font-semibold text-tx">{draft.worker}</span>
          <span className="text-[11.5px] text-tx3">Режим</span>
          <span className="text-[11.5px] font-semibold text-tx">{draft.mode}</span>
          {draft.acceptance ? (
            <>
              <span className="text-[11.5px] text-tx3">Признак готовности</span>
              <span className="text-[11.5px] leading-[1.5] text-tx">{draft.acceptance}</span>
            </>
          ) : null}
        </div>

        {done ? (
          <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] font-semibold text-ok-tx">Задача поставлена.</span>
            <button
              type="button"
              onClick={() => onOpenTask(createdTaskId)}
              className="text-[12.5px] font-medium text-blue hover:text-teal"
            >
              Открыть
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={creating}
              onClick={onCreate}
              className="rounded-[8px] bg-blue-d px-3.5 py-[7px] text-[12.5px] font-semibold text-white disabled:opacity-60"
            >
              {creating ? 'Ставлю…' : 'Создать'}
            </button>
            <button
              type="button"
              onClick={onAmend}
              className="rounded-[8px] border border-bd2 px-3 py-[7px] text-[12.5px] text-tx2 hover:bg-row-hover hover:text-tx"
            >
              Поправить
            </button>
          </div>
        )}

        <div className="mt-2.5 text-[11px] text-tx3">Черновик. Уйдёт в работу только после Вашего решения.</div>
      </div>
    </div>
  )
}
