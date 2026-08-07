import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, isRaceLost } from '../../api/client'
import { onFrame } from '../../api/hints'
import { PHASE_KEY } from '../../api/queries'
import type { PhaseQuestion, PhaseStage, PhaseStageStatus } from '../../api/types'
import { isOpen } from '../../shell/DecisionCard'
import { refusalWords, STAGE_LABEL } from '../../shell/format'

/**
 * shared.ts — the words this screen uses, and the ONE place it touches anything but a hook.
 *
 * ═════════════════ THE SCREEN CALLS NO DOOR. IT MOUNTS HOOKS. ═════════════════
 *
 * Every request this screen makes goes through `api/queries`, which is where this product
 * decided how often a thing is asked and what is re-read after an act. Not one door function
 * is called from anywhere in this folder.
 *
 * What IS imported from `api/client` here, and only here, are two things that ask nothing of
 * the daemon: the class of a refusal, and the predicate for «somebody got there first». They
 * live in client.ts because that is where this product decides what a status MEANS, and a
 * second copy of that decision is a second thing to remember to change — the shell's own
 * `refusalWords` reaches for exactly the same two, for exactly that reason.
 */

/** The four stages, in the order a phase goes through them. The card never invents a fifth. */
export const STAGE_ORDER: readonly PhaseStage[] = ['discuss', 'plan', 'execute', 'verify'] as const

/**
 * What each stage is called on the glass. The words MOVED to the shell the day a second
 * screen needed them — the conversation now drafts a stage of its own — and are re-exported
 * here so this folder's readers still find them where they expect. One spelling, two screens.
 */
export { STAGE_LABEL }

/** What a stage leaves behind — the thing that makes it «готово», said in words. */
export const STAGE_WHAT: Record<PhaseStage, string> = {
  discuss: 'разговор о том, что делаем и почему',
  plan: 'планы работ по этой фазе',
  execute: 'работа по планам и итоги',
  verify: 'проверка сделанного',
}

/** Where a stage stands. The daemon derives this off the documents on disk, never remembers it. */
export const STATUS_WORD: Record<PhaseStageStatus, string> = {
  none: 'не начата',
  'in-progress': 'идёт',
  done: 'готово',
}

export const STATUS_TONE: Record<PhaseStageStatus, string> = {
  none: 'bg-idle-s text-idle-tx',
  'in-progress': 'bg-blue-s text-blue-d',
  done: 'bg-ok-s text-ok-tx',
}

/**
 * An OPEN question is a record with no answer — absent, null or blank. That is the whole of
 * the convention, and it is the daemon's, not this screen's.
 *
 * The definition MOVED to the shell, beside the card that renders one, the day a second
 * screen needed it — the registry's own rule for a thing two screens both need. It is
 * re-exported here so this folder's readers still find it where they expect, and so there is
 * still exactly ONE function: a second definition of «open» is a count on a screen that
 * drifts from the count the daemon acts on.
 */
export { isOpen }

/** «N открыто / M отвечено», counted off the questions in hand. */
export function progressOf(questions: PhaseQuestion[]): { open: number; answered: number } {
  let open = 0
  for (const q of questions) if (isOpen(q)) open += 1
  return { open, answered: questions.length - open }
}

/** True when the text was written for a person rather than for a log. */
function saidToAPerson(text: string): boolean {
  return /[А-Яа-яЁё]/.test(text)
}

/**
 * What a refused act should say.
 *
 * A door that refuses an ANSWER refuses it in sentences — the caps, the one-of-two rule, the
 * «this looks like a key» screen are all written for the person who typed. Those are shown
 * exactly as they were said, because rephrasing somebody else's refusal is how a person is
 * told something the machine did not mean. A refusal written for a log (an English token off
 * a shape check) is not shown raw; the shell's own words carry that case.
 */
export function doorWords(err: unknown): string {
  if (err instanceof ApiError && err.status === 400 && saidToAPerson(err.detail)) return err.detail
  return refusalWords(err)
}

/** The same, for the stage door — where «somebody got there first» has its own plain meaning. */
export function stageWords(err: unknown): string {
  if (isRaceLost(err)) return 'Эта стадия уже идёт — дождитесь, пока она закончится.'
  return doorWords(err)
}

/**
 * The two bells that move this screen, and what they cost.
 *
 * The phase family is NOT on the steady rhythm — a phase card is read when it is opened and
 * then left alone, because a document on disk does not move under the eye. Which means a bell
 * is the only way this screen learns that a stage was queued or that an answer landed from
 * somewhere else. So exactly these two names order exactly one re-read of the phase family,
 * and every other bell in the window is ignored here: this is not «re-fetch on every event»,
 * it is the one channel that would otherwise leave a card stale until a person clicked away
 * and back.
 *
 * The connection is the live layer's own. Nothing here opens a second one.
 */
export function usePhaseBells(): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      onFrame((evt) => {
        if (evt.event === 'phase.stage' || evt.event === 'discussion.updated') {
          void queryClient.invalidateQueries({ queryKey: PHASE_KEY })
        }
      }),
    [queryClient],
  )
}
