import { useState } from 'react'
import { useMemoryApply, useMemoryDraftsQuery } from '../../api/queries'
import type { MemoryDraftRow } from '../../api/types'
import { plural } from '../../shell/format'
import { CardHead, corpusWords } from './shared'

/**
 * «Черновики» — the lessons the write pipeline staged and stopped on, and the «да» that belongs
 * to each one.
 *
 * ═══════════════ ONE DRAFT, ONE QUESTION, ONE ANSWER — AND NO «ПРИНЯТЬ ВСЁ» ══════════════
 *
 * The pipeline that writes a lesson into the corpus already refuses to do it unattended: it puts
 * the record in `drafts/` and stops. What it never had was a way to say the «да» anywhere but a
 * terminal. This panel is that way, and it is deliberately the SLOW one — the same shape the
 * migration list on this screen has used since V5.1, and the same shape the import wizard uses
 * for a foreign worker.
 *
 * There is no «принять всё» here, and there must never be one. That is not a control somebody
 * forgot to draw: the door in front of this list has no field that could ask for two — an array,
 * a glob and an «all» are each a refusal — so a bulk button could only be a LOOP over the rows,
 * pressed by one click nobody read. The whole cost of the guarantee is paid by the person
 * reading the change before agreeing to it, and a loop is exactly how that cost gets skipped.
 *
 * ═════════════════════ THE PREVIEW IS THE CHANGE, AS TEXT AND ONLY AS TEXT ════════════════
 *
 * A person agreeing to a lesson is agreeing to what it SAYS, not to its title — so the record
 * itself is on the glass, in a monospaced block, before the button is offered. It is rendered as
 * a text child of a `<pre>`: nothing on this screen reaches for a raw-HTML escape hatch, because
 * the text comes out of a file somebody else wrote and a corpus is not a place to start trusting
 * markup.
 *
 * ═══════════════════════ A ROW SAYS WHICH DOOR OWNS IT, RATHER THAN FAILING ═══════════════
 *
 * A corpus keeps drafts of more than one KIND and each kind has its own door. This apply door
 * owns the pipeline's own; a draft of another kind is refused by it, honestly and by name. So a
 * row the door does not own gets no button at all — it gets a sentence saying where its «да»
 * actually lives. On this machine that is not a hypothetical: every staged draft in the founder's
 * own corpus is a migration of an older note, whose door is «Записи старого образца» — the panel
 * directly below this one, built for it and live since V5.1.
 */

/**
 * Where a draft's «да» lives, when it does not live here.
 *
 * A vocabulary with a fallback, like the two beside it on this screen: an unknown kind SHOWS
 * ITSELF rather than being explained wrongly, because the kind is data out of a file this window
 * does not own and inventing a meaning for it is how a screen starts lying.
 */
const OTHER_DOOR: Record<string, string> = {
  'v2-migration':
    'Это перенос записи старого образца. Он делается ниже, в разделе «Записи старого образца» — тоже по одному файлу.',
}

function otherDoorWords(kind: string | undefined): string {
  const known = kind ? OTHER_DOOR[kind] : undefined
  if (known) return known
  return kind
    ? `Этот черновик заведён как «${kind}» — его принимает не эта кнопка.`
    : 'Этот черновик принимает не эта кнопка.'
}

/** One staged lesson: what would be written, and the one act that is a person's. */
function DraftCard({ draft, first }: { draft: MemoryDraftRow; first: boolean }) {
  const apply = useMemoryApply()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // A row the apply door does not own. `applicable` is absent on an older answer, and absent is
  // not «no»: the door is asked, and its refusal is shown, rather than the button being hidden
  // on a guess.
  const mine = draft.applicable !== false

  const confirm = () => {
    setProblem(null)
    apply.mutate(
      { draftId: draft.id },
      {
        onSuccess: () => {
          // The list is re-read by the action itself; the row disappears with the next reading.
          // Until it does, the card says what happened rather than going quiet.
          setAsking(false)
          setDone(true)
        },
        onError: (err) => {
          setAsking(false)
          setProblem(corpusWords(err, 'Не применилось. Черновик остался как был.'))
        },
      },
    )
  }

  return (
    <div className={`flex flex-col gap-2.5 px-[18px] py-[14px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-tx" title={draft.targetFile}>
          {draft.targetFile}
        </span>
        {draft.kind ? <span className="flex-none text-[11px] text-tx3">{draft.kind}</span> : null}
        <span className="flex-none text-[11px] text-tx3">{draft.age}</span>
      </div>

      <pre className="m-0 max-h-[280px] overflow-auto rounded-[9px] border border-bd bg-surf px-3 py-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-tx2">
        {draft.preview}
      </pre>

      {done ? (
        <span className="text-[11.5px] text-ok-tx">Записано в корпус.</span>
      ) : !mine ? (
        <span className="text-[11.5px] leading-[1.5] text-tx3">{otherDoorWords(draft.kind)}</span>
      ) : asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-tx">Записать именно этот урок в корпус?</span>
          <button
            type="button"
            onClick={confirm}
            disabled={apply.isPending}
            className="rounded-[8px] border border-bd bg-ok-s px-3 py-1 text-[11.5px] font-semibold text-ok-tx disabled:opacity-60"
          >
            {apply.isPending ? 'Записываю…' : 'Да, принять'}
          </button>
          <button
            type="button"
            onClick={() => setAsking(false)}
            className="rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] text-tx2"
          >
            Отмена
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="w-fit rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] font-semibold text-tx"
        >
          Принять
        </button>
      )}

      {problem ? <span className="text-[11.5px] leading-[1.5] text-warn-tx">{problem}</span> : null}
    </div>
  )
}

/**
 * The panel is MOUNTED only while a project is connected, so it takes no «enabled» of its own:
 * the read starts when the panel appears and stops when it goes, and there is no second place
 * where somebody could decide the same thing differently.
 */
export function DraftsPanel() {
  const drafts = useMemoryDraftsQuery()
  const rows = drafts.data?.drafts ?? []

  return (
    <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <CardHead
        title="Черновики"
        note={rows.length > 0 ? `${rows.length} ${plural(rows.length, 'урок', 'урока', 'уроков')}` : undefined}
      />
      <div className="flex flex-col gap-1.5 px-[18px] py-[13px]">
        <span className="text-[12.5px] leading-[1.5] text-tx">
          Уроки, которые команда записала, а система отложила до Вашего слова. Ниже — сам текст
          записи целиком.
        </span>
        <span className="text-[11.5px] leading-[1.5] text-tx2">
          Каждый принимается отдельно. Кнопки «принять всё» здесь нет намеренно — этого нельзя
          даже попросить.
        </span>
      </div>

      {drafts.isLoading ? (
        <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">Читаю черновики…</p>
      ) : drafts.isError ? (
        <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
          Черновики сейчас не читаются. Ни один из них при этом не потерян — они лежат файлами в
          проекте.
        </p>
      ) : rows.length === 0 ? (
        <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
          Ничего не ждёт решения — всё, что команда записала, уже в корпусе.
        </p>
      ) : (
        rows.map((row, i) => <DraftCard key={row.id} draft={row} first={i === 0} />)
      )}
    </div>
  )
}
