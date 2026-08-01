import type { ImportCandidate } from '../../api/types'

/**
 * shared.ts — the handful of words and keys the three steps of the wizard both use.
 *
 * It exists so a candidate is identified the SAME way on every step: a thing is chosen on
 * «Что нашлось», renamed on «Что взять» and reported on «Черновики», and if those three
 * steps disagreed about what identifies it, a person could tick one row and enrol another.
 * The key is the pair the daemon itself accepts in a selection — a kind and a name.
 */

/** The two kinds the import door can carry by itself. Everything else is moved by hand. */
export const ENROLLABLE_KINDS = ['agent', 'skill'] as const

/** The groups a person reads on the first step. */
export const KIND_GROUP: Record<string, string> = {
  agent: 'Помощники',
  skill: 'Навыки',
}

/** One found thing, in the singular. */
export const KIND_WORD: Record<string, string> = {
  agent: 'Помощник',
  skill: 'Навык',
}

/** Can this candidate travel through the import door at all? */
export function isEnrollable(c: ImportCandidate): boolean {
  return !!c.slug && (ENROLLABLE_KINDS as readonly string[]).includes(c.kind)
}

/** The one identity of a candidate, used by every step and by the selection itself. */
export function candidateKey(c: ImportCandidate): string {
  return `${c.kind}:${c.slug ?? ''}`
}

/** The same key, built from what came back from the enrolment. */
export function resultKey(kind: string | null, slug: string | null): string {
  return `${kind ?? ''}:${slug ?? ''}`
}
