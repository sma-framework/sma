import { useState } from 'react'
import { usePhaseIndexQuery } from '../../api/queries'
import type { PhaseIndexRow } from '../../api/types'
import { PhaseCardView } from './PhaseCardView'
import { STAGE_LABEL, STAGE_ORDER, STATUS_TONE, STATUS_WORD, usePhaseBells } from './shared'

/**
 * «Конвейер фаз» — every phase of the project, where each one stands, and which of them is
 * waiting on a word from the founder.
 *
 * ═════════════════════ THE INDEX IS A PROJECTION, NOT A SECOND TRUTH ═══════════════════
 *
 * The list below is one reading of the phase index and nothing else. Each row's stages and its
 * «N открыто / M отвечено» are worked out by the daemon off the phase's own directory — the
 * documents that exist ARE the state — so the row survives a restart of everything and cannot
 * disagree with the card it opens.
 *
 * The badge is on the index for the reason it is on the card: a phase that has stopped to ask
 * something looks exactly like a phase quietly working, unless the window says otherwise. That
 * is the difference between a person noticing today and noticing on Thursday.
 *
 * One screen, one folder: this work touches nothing outside it. The shared vocabulary — the
 * card that renders a question, the words for a refusal — is BORROWED from the shell, because
 * a thing several screens need is not a screen.
 */

/** The four stage chips of one row, in the order a phase goes through them. */
function StageChips({ row }: { row: PhaseIndexRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGE_ORDER.map((stage) => (
        <span
          key={stage}
          className={`rounded-full px-2.5 py-[3px] text-[10.5px] whitespace-nowrap ${STATUS_TONE[row.stages[stage]]}`}
        >
          {STAGE_LABEL[stage]} · {STATUS_WORD[row.stages[stage]]}
        </span>
      ))}
    </div>
  )
}

function PhaseRow({ row, onOpen }: { row: PhaseIndexRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2.5 rounded-[12px] border border-bd bg-card p-4 text-left shadow-panel hover:border-blue"
    >
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-tx">
          {row.name}
        </span>
        {row.open > 0 ? (
          <span className="flex-none rounded-full bg-warn-s px-2.5 py-[3px] text-[10.5px] whitespace-nowrap text-warn-tx">
            {row.open} открыто / {row.answered} отвечено
          </span>
        ) : row.answered > 0 ? (
          <span className="flex-none rounded-full bg-ok-s px-2.5 py-[3px] text-[10.5px] whitespace-nowrap text-ok-tx">
            0 открыто / {row.answered} отвечено
          </span>
        ) : null}
      </div>
      <StageChips row={row} />
    </button>
  )
}

export function Screen() {
  const [openId, setOpenId] = useState<string | null>(null)
  const index = usePhaseIndexQuery(openId === null)

  // The two bells of the phase cycle refresh whichever of the two views is on the glass.
  usePhaseBells()

  if (openId !== null) {
    return <PhaseCardView id={openId} onBack={() => setOpenId(null)} />
  }

  const rows = index.data?.phases ?? []
  const waiting = rows.reduce((sum, row) => sum + row.open, 0)

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Конвейер фаз</h1>
        <span className="flex-1" />
        {waiting > 0 ? (
          <span className="flex-none rounded-[9px] border border-bd bg-card px-3 py-1.5 text-[11.5px] text-warn-tx">
            ждут вашего ответа: {waiting}
          </span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
        {index.isLoading ? <p className="m-0 text-[13px] text-tx2">Читаю фазы…</p> : null}

        {index.isError ? (
          <p className="m-0 text-[13px] text-tx2">
            Список фаз сейчас не читается. Работа при этом идёт своим чередом — на неё это не
            влияет.
          </p>
        ) : null}

        {!index.isLoading && !index.isError && rows.length === 0 ? (
          <p className="m-0 text-[13px] text-tx2">
            Фаз пока нет. Первая появится, когда работа будет разложена по фазам.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <div className="flex max-w-[860px] flex-col gap-2.5">
            {rows.map((row) => (
              <PhaseRow key={row.id} row={row} onOpen={() => setOpenId(row.id)} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
