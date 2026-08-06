import { useRef } from 'react'
import type { PhaseQuestion } from '../api/types'

/**
 * DecisionCard — one question the machine stopped to ask, and the two ways a person may
 * answer it.
 *
 * ═══════════════════ ONE CARD FOR EVERY QUESTION THE SYSTEM ASKS ═══════════════════
 *
 * A discussion round asks; an executor stops at a decision and asks; the conversation will
 * ask. To the person answering, those are the same act — a question, some variants somebody
 * thought about beforehand, and the right to say something nobody offered. So there is ONE
 * card, and it lives in the shell for the reason the registry gives: a thing several screens
 * both need is not a screen. It is BORROWED, never copied.
 *
 * ═════════════════════════ THE SHAPE IS THE ARTEFACT'S, 1:1 ═══════════════════════
 *
 * The props below are not a view invented for the window: they are the shape the daemon
 * already answers with, field for field, so a screen hands a parked question straight to this
 * card with no adapter in between. An adapter is where two spellings of one thing are born,
 * and the phase cycle spent a commit killing exactly that. `_PhaseQuestionFitsTheCard` at the
 * bottom of this file is that promise made to the compiler rather than to the reader.
 *
 * `pros` and `cons` are optional because TODAY's parked question has neither: a checkpoint
 * file carries `options_presented` — a flat list of labels — and a shape that DEMANDED a
 * pro and a con would be a shape no door in this product can fill. The reasoning belongs to
 * the richer checkpoint an executor writes, and on the day a door carries it across, the
 * card already knows how to show it and nothing here changes.
 *
 * ══════════════════════ EXACTLY ONE OF TWO, AND THE CARD SAYS SO ═══════════════════
 *
 * The daemon's rule is «either a chosen option or your own words, exactly one of the two» —
 * both is a contradiction and neither is not an answer. This card MIRRORS that rule instead
 * of hiding it: a person may well click a variant and then start typing, and when that
 * happens the button goes quiet and says why, rather than silently throwing one of the two
 * away. The daemon remains the authority — it re-checks everything below and refuses in its
 * own words, which the screen shows as it was said.
 *
 * Nothing is sent from here. The card collects an answer and hands it up; who posts it,
 * where to, and what to re-read afterwards is the business of the screen that mounted it.
 */

/** One variant, as the artefact offers it — with the reasoning when the artefact has any. */
export interface DecisionOption {
  id: string
  label: string
  pros?: string
  cons?: string
}

/**
 * A question this card can render. Deliberately structural rather than a named import: the
 * card serves the phase cycle today and an executor's checkpoint tomorrow, and both of those
 * are «id, question, options» whatever else they carry beside it.
 */
export interface DecisionQuestion {
  id: string
  question: string
  /** Which part of the phase this was asked about, when the asker said. */
  area?: string
  /** What the asker wanted the person to know before choosing. */
  context?: string
  options: DecisionOption[]
}

/** The daemon's own ceiling on a written answer. Longer than this is a file, not a decision. */
export const MAX_FREE_TEXT = 2000

/** What the person has said so far on one card — a chosen option, some words, or both. */
export interface DecisionDraft {
  optionId: string | null
  freeText: string
}

/** An untouched card: nothing chosen and nothing written. */
export const EMPTY_DRAFT: DecisionDraft = { optionId: null, freeText: '' }

/**
 * Whether this draft can be sent, and — when it cannot — why, in words a person can act on.
 *
 * Exported because the screen owns the draft and may want to say the same thing somewhere
 * else; the rule is written once and both of them read it.
 */
export function draftProblem(draft: DecisionDraft): string | null {
  const text = draft.freeText.trim()
  const hasOption = draft.optionId !== null
  const hasText = text !== ''
  if (hasOption && hasText) {
    return 'Выбран вариант и написан свой ответ — оставьте что-то одно.'
  }
  if (!hasOption && !hasText) return null
  if (hasText && draft.freeText.length > MAX_FREE_TEXT) {
    return `Свой ответ длиннее ${MAX_FREE_TEXT} символов — это уже файл, а файлу место в проекте.`
  }
  return null
}

/** The answer this draft amounts to, or null while it is not an answer yet. */
export function draftAnswer(draft: DecisionDraft): { optionId?: string; freeText?: string } | null {
  if (draftProblem(draft)) return null
  const text = draft.freeText.trim()
  if (draft.optionId !== null) return { optionId: draft.optionId }
  if (text !== '') return { freeText: draft.freeText }
  return null
}

function Reasoning({ option }: { option: DecisionOption }) {
  if (!option.pros && !option.cons) return null
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-[11.5px] leading-[1.5] text-tx3">
      {option.pros ? (
        <div>
          <span className="font-semibold text-ok-tx">За: </span>
          {option.pros}
        </div>
      ) : null}
      {option.cons ? (
        <div>
          <span className="font-semibold text-warn-tx">Против: </span>
          {option.cons}
        </div>
      ) : null}
    </div>
  )
}

export function DecisionCard({
  question,
  draft,
  busy,
  problem,
  onDraft,
  onAnswer,
}: {
  question: DecisionQuestion
  draft: DecisionDraft
  busy: boolean
  /** What the daemon said when it refused this answer — shown in its own words. */
  problem?: string | null
  onDraft: (draft: DecisionDraft) => void
  onAnswer: (input: { optionId?: string; freeText?: string }) => void
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  const group = `decision-${question.id}`

  const trouble = draftProblem(draft)
  const answer = draftAnswer(draft)
  const overCap = draft.freeText.length > MAX_FREE_TEXT

  const send = () => {
    if (!answer || busy) return
    onAnswer(answer)
  }

  return (
    <article className="flex flex-col gap-3.5 rounded-[12px] border border-bd border-l-[3px] border-l-teal bg-card p-4 shadow-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {question.area ? (
            <div className="text-[10.5px] font-semibold tracking-[0.09em] text-tx3 uppercase">
              {question.area}
            </div>
          ) : null}
          <h3 className="m-0 mt-1 text-[14.5px] leading-[1.45] font-semibold text-tx">
            {question.question}
          </h3>
        </div>
        <span className="flex-none rounded-full bg-idle-s px-2.5 py-1 text-[10.5px] whitespace-nowrap text-idle-tx">
          решение за Вами
        </span>
      </div>

      {question.context ? (
        <p className="m-0 text-[12.5px] leading-[1.6] text-tx2">{question.context}</p>
      ) : null}

      {question.options.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {question.options.map((option) => {
            const chosen = draft.optionId === option.id
            return (
              <label
                key={option.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 ${
                  chosen ? 'border-blue bg-blue-s' : 'border-bd2 hover:border-blue'
                }`}
              >
                <input
                  type="radio"
                  name={group}
                  checked={chosen}
                  disabled={busy}
                  onChange={() => onDraft({ ...draft, optionId: option.id })}
                  className="mt-[3px] flex-none accent-blue-d"
                />
                <span className="min-w-0">
                  <span className="block text-[12.5px] leading-[1.5] text-tx">{option.label}</span>
                  <Reasoning option={option} />
                </span>
              </label>
            )
          })}

          {/*
            The way BACK out of a choice. A radio cannot be un-clicked, so without this row a
            person who picked a variant and then thought of something better would have no way
            to say the something better — and «no way back» is how a screen answers on somebody's
            behalf.
          */}
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 ${
              draft.optionId === null ? 'border-blue bg-blue-s' : 'border-bd2 hover:border-blue'
            }`}
          >
            <input
              type="radio"
              name={group}
              checked={draft.optionId === null}
              disabled={busy}
              onChange={() => {
                onDraft({ ...draft, optionId: null })
                box.current?.focus()
              }}
              className="mt-[3px] flex-none accent-blue-d"
            />
            <span className="text-[12.5px] leading-[1.5] text-tx2">
              Ни один из вариантов — отвечу своими словами
            </span>
          </label>
        </div>
      ) : (
        <p className="m-0 text-[12px] leading-[1.5] text-tx3">
          Вариантов не предложено — ответ своими словами.
        </p>
      )}

      <div>
        <div className="mb-1.5 text-[11.5px] font-semibold text-tx2">Свой ответ</div>
        <textarea
          ref={box}
          value={draft.freeText}
          disabled={busy}
          onChange={(e) => onDraft({ ...draft, freeText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              send()
            }
          }}
          rows={4}
          placeholder="Если ни один вариант не подходит — напишите, как правильно."
          className="min-h-[92px] w-full resize-y rounded-[10px] border border-bd2 bg-surf px-3.5 py-2.5 text-[13px] leading-[1.6] text-tx outline-none focus:border-blue focus:bg-card disabled:opacity-60"
        />
        <div className="mt-1 flex items-baseline gap-3">
          <span className="flex-1 text-[11px] leading-[1.5] text-tx3">
            Либо вариант, либо свои слова — что-то одно. Ctrl+Enter — отправить.
          </span>
          <span
            className={`flex-none text-[11px] tabular-nums ${overCap ? 'text-err-tx' : 'text-tx3'}`}
          >
            {draft.freeText.length} / {MAX_FREE_TEXT}
          </span>
        </div>
      </div>

      {trouble ? <p className="m-0 text-[12px] text-warn-tx">{trouble}</p> : null}
      {problem ? <p className="m-0 text-[12px] text-err-tx">{problem}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={busy || !answer}
          className="rounded-[9px] bg-blue-d px-[17px] py-2 text-[12.5px] font-semibold text-white hover:bg-blue disabled:opacity-60"
        >
          {busy ? 'Записываю…' : 'Ответить'}
        </button>
        {!answer && !trouble ? (
          <span className="text-[11.5px] text-tx3">Выберите вариант или напишите свой ответ.</span>
        ) : null}
      </div>
    </article>
  )
}

/**
 * The promise at the top of this file, made to the compiler.
 *
 * A parked question, exactly as the daemon answers with it, must be renderable by this card
 * WITHOUT an adapter. If either shape ever drifts from the other, this line stops compiling
 * and names the day it happened — which is the whole point of writing it down: an adapter
 * that appears quietly is two spellings of one question, and the second spelling is the one
 * that routes an answer into somebody else's decision.
 */
type Assert<T extends true> = T
export type _PhaseQuestionFitsTheCard = Assert<PhaseQuestion extends DecisionQuestion ? true : false>
