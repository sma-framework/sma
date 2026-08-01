import type { OnboardingQuestion, OnboardingTopic } from '../../api/types'

/**
 * shared.ts — what the panel and the column both need to agree about.
 *
 * A question can reach the glass two ways: as the interview's own cursor, or because a
 * person pressed one of the optional-topic chips. Both are asked identically, so both are
 * reduced to ONE shape here — otherwise the panel would have to know where its question
 * came from, and that is exactly the kind of knowledge that grows into two behaviours.
 */

/** One question as the screen asks it — whichever way it got here. */
export interface Asked {
  key: string
  /** The short name of the topic, for the list of what has been said already. */
  title: string
  question: string
  hint: string
  step: number
  optional: boolean
}

/** The interview's own cursor. */
export function fromQuestion(q: OnboardingQuestion): Asked {
  return {
    key: q.key,
    title: q.title,
    question: q.question,
    hint: q.hint,
    step: q.step,
    optional: q.optional,
  }
}

/**
 * An optional topic a person pressed. It is asked exactly like any other question; the
 * daemon pulls it into the queue of its step the moment an answer for it arrives.
 */
export function fromTopic(t: OnboardingTopic): Asked {
  return { key: t.key, title: t.title, question: t.question, hint: t.hint, step: t.step, optional: true }
}

/**
 * How many words a person has actually written down. One counter for the panel and the
 * column, so the two never report different numbers about the same answer. An answer that
 * is only spaces is no words at all — which is precisely what the interview calls a skip.
 */
export function wordCount(text: string): number {
  const t = (text ?? '').trim()
  return t ? t.split(/\s+/).length : 0
}
