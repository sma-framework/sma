import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, isNotReady } from '../../api/client'
import { onFrame } from '../../api/hints'
import { MEMORY_DRAFTS_KEY, MEMORY_LINT_KEY } from '../../api/queries'

/**
 * shared.tsx — what more than one panel of «Память» needs, written once.
 *
 * The screen grew a workbench: the notebook is still shown rather than edited, but three acts
 * over the CONNECTED project's corpus now belong here — agreeing to a staged lesson, reading
 * what the corpus's own checker says, and regenerating the index. Each is its own panel in its
 * own file; this is the small vocabulary all of them speak.
 *
 * Nothing here calls a door. The one import from `api/client` is the class of a refusal and the
 * predicate for «not filled in yet», for the same reason the phase screen imports exactly those
 * two: client.ts is where this product decides what a status MEANS, and a second copy of that
 * decision is a second thing to remember to change.
 */

/** The frame every panel of this screen sits in. */
export function CardHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
      {note ? <span className="text-[11px] text-tx3 tabular-nums">{note}</span> : null}
    </div>
  )
}

/**
 * What a refused act on the corpus should say.
 *
 * A 409 here is the WRITE PIPELINE refusing — a secret class, a taken identity, a draft of a
 * kind this door does not own. That is a decision of the mechanism, not a mistake in a field,
 * and it travels with the mechanism's own sentence. It is shown as it was said, behind a lead
 * that names who said it: rephrasing somebody else's refusal is how a person gets told
 * something the machine did not mean. A refusal with nothing to quote falls back to plain
 * words, and the last sentence of every branch is the same fact — nothing was written.
 */
export function corpusWords(err: unknown, fallback: string): string {
  if (isNotReady(err)) return 'Эта дверь пока не отвечает. Ничего не изменилось.'
  if (err instanceof ApiError && err.status === 404) {
    return 'Этого черновика уже нет — возможно, его приняли из терминала.'
  }
  if (err instanceof ApiError && (err.status === 409 || err.status === 400) && err.detail) {
    return `Отказано: ${err.detail}`
  }
  return fallback
}

/**
 * The one bell of the workbench, and why it is heard rather than polled.
 *
 * `memory.drafts` is an empty ring — it says «черновики или оглавление сдвинулись» and carries
 * no field, exactly as the event vocabulary promises. The two reads it moves are deliberately
 * NOT on the steady rhythm (a corpus does not change under the eye, and re-reading it every
 * three seconds would spawn the project's own linter every three seconds), so without this the
 * panel would go stale the moment a lesson is accepted from a terminal — and stay stale until
 * a person clicked away and back. One invalidation on one name is the whole of it; every other
 * bell in the window is ignored here.
 *
 * The connection is the live layer's own. Nothing here opens a second one.
 */
export function useMemoryBells(): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      onFrame((evt) => {
        if (evt.event !== 'memory.drafts') return
        void queryClient.invalidateQueries({ queryKey: MEMORY_DRAFTS_KEY })
        void queryClient.invalidateQueries({ queryKey: MEMORY_LINT_KEY })
      }),
    [queryClient],
  )
}
