import { useEffect, useRef } from 'react'
import type { OnboardingTopic } from '../../api/types'
import { wordCount } from './shared'
import type { Asked } from './shared'

/**
 * StepPanel — one question at a time, the way a person is asked something by a colleague.
 *
 * ═════════════════════════ A CONVERSATION, NOT A FORM ═════════════════════════
 *
 * There is exactly ONE question on the glass. It has a box under it, an example in grey
 * beside it, and no asterisk, no red frame and no validator: an empty answer is a SKIP the
 * interview accepts, so «Пропустить вопрос» is a real button and not a way of giving up.
 * Ctrl+Enter sends, because a person who is typing should not have to find the mouse.
 *
 * The chips are the interview's own optional topics. Pressing one does not «unlock» a
 * feature — it asks that question next, and the daemon pulls the topic into the queue the
 * moment it is answered. Nothing here invents a question: every word of every question, and
 * every example under it, comes from the interview engine.
 *
 * What has already been said stays visible above the question, with «Изменить» beside each
 * line, because an interview a person cannot correct is a form with extra steps.
 */

export interface AnsweredRow {
  key: string
  title: string
  text: string
}

export function StepPanel({
  question,
  subLabel,
  draft,
  answered,
  hiddenAnswers,
  extras,
  added,
  busy,
  problem,
  onDraft,
  onSubmit,
  onSkip,
  onBack,
  onEdit,
  onTopic,
}: {
  question: Asked
  subLabel: string
  draft: string
  answered: AnsweredRow[]
  /** Answers recorded before this window was opened — counted, never guessed at. */
  hiddenAnswers: number
  extras: OnboardingTopic[]
  added: OnboardingTopic[]
  busy: boolean
  problem: string | null
  onDraft: (value: string) => void
  onSubmit: () => void
  onSkip: () => void
  onBack: (() => void) | null
  onEdit: (key: string) => void
  onTopic: (topic: OnboardingTopic) => void
}) {
  const box = useRef<HTMLTextAreaElement>(null)

  // The cursor belongs in the box: a person opens this screen to say something.
  useEffect(() => {
    box.current?.focus()
  }, [question.key])

  const words = wordCount(draft)

  return (
    <div className="flex flex-1 flex-col px-5 pt-[26px] pb-[30px] sm:px-[34px]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-bd pb-[18px]">
        <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-green" />
        <span className="text-[11.5px] font-semibold tracking-[0.09em] text-tx3 uppercase">
          Руководитель команды · на связи
        </span>
        <div className="flex-1" />
        <span className="text-[11.5px] font-semibold whitespace-nowrap text-tx2">{subLabel}</span>
      </div>

      {answered.length > 0 || hiddenAnswers > 0 ? (
        <div className="my-1 max-h-[184px] overflow-y-auto">
          {answered.map((a) => (
            <div
              key={a.key}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-bd px-0.5 py-2.5"
            >
              <span aria-hidden className="flex-none text-[12px] font-semibold text-ok-tx">
                ✓
              </span>
              <span className="w-[176px] flex-none text-[12px] text-tx3">{a.title}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-tx2">{a.text}</span>
              <span className="flex-none text-[11.5px] whitespace-nowrap text-tx3">
                {wordCount(a.text)} сл.
              </span>
              <button
                type="button"
                onClick={() => onEdit(a.key)}
                className="flex-none text-[12px] font-semibold text-blue-d hover:text-teal"
              >
                Изменить
              </button>
            </div>
          ))}
          {hiddenAnswers > 0 ? (
            <div className="px-0.5 py-2.5 text-[11.5px] text-tx3">
              Ещё {hiddenAnswers} записано раньше — они сохранены и никуда не делись.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-baseline gap-2.5 pt-3.5">
        <span className="max-w-[44ch] text-[27px] leading-[1.32] font-semibold tracking-[-0.012em] text-tx">
          {question.question}
        </span>
        {question.optional ? (
          <span className="flex-none rounded-[6px] border border-bd2 px-2 py-[3px] text-[10.5px] font-semibold tracking-[0.06em] text-tx3 uppercase">
            по желанию
          </span>
        ) : null}
      </div>

      <textarea
        ref={box}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onSubmit()
          }
        }}
        rows={6}
        className="mt-[18px] min-h-[158px] w-full resize-y rounded-[10px] border border-bd2 bg-surf px-4 py-3.5 text-[15px] leading-[1.6] text-tx outline-none focus:border-blue focus:bg-card"
      />

      <div className="mt-2.5 flex items-baseline gap-3.5">
        <span className="flex-1 text-[13px] leading-[1.5] text-tx3">{question.hint}</span>
        <span className="flex-none text-[12px] whitespace-nowrap text-tx3">{words} сл.</span>
      </div>

      <div className="mt-[22px] border-t border-bd pt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[12.5px] whitespace-nowrap text-tx2">
            Хотите рассказать подробнее?
          </span>
          {extras.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTopic(t)}
              className="rounded-[8px] border border-bd2 px-[11px] py-1.5 text-[12.5px] font-semibold text-tx2 hover:border-blue hover:text-blue-d"
            >
              + {t.title}
            </button>
          ))}
          {added.map((t) => (
            <span
              key={t.key}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-teal/40 bg-blue-s px-[11px] py-1.5 text-[12.5px] font-semibold text-teal"
            >
              {t.title}
              <span className="font-medium text-tx3">· в разговоре</span>
            </span>
          ))}
          {extras.length === 0 && added.length === 0 ? (
            <span className="text-[12.5px] text-tx3">все темы этого шага уже в разговоре</span>
          ) : null}
        </div>
      </div>

      {problem ? <p className="mt-3.5 mb-0 text-[12.5px] text-err-tx">{problem}</p> : null}

      {/*
        Кнопки и подсказка переносятся: «Назад», «Пропустить вопрос», строка про Ctrl+Enter и
        «Дальше» в один ряд на телефоне не помещаются, а ряд без переноса растянул бы панель,
        панель — страницу.
      */}
      <div className="mt-auto flex flex-wrap items-center gap-2.5 pt-[22px]">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="rounded-[10px] border border-bd2 px-4 py-2.5 text-[13.5px] font-semibold text-tx2 hover:bg-surf hover:text-tx"
          >
            Назад
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="rounded-[10px] px-3.5 py-2.5 text-[13px] font-semibold text-tx3 hover:bg-surf hover:text-tx2 disabled:opacity-60"
        >
          Пропустить вопрос
        </button>
        <span className="text-[12.5px] leading-[1.4] text-tx3">
          Можно писать длинно, лишнее мы уложим сами. Ctrl+Enter — отправить.
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="rounded-[10px] bg-blue-d px-5 py-[11px] text-[13.5px] font-semibold text-white hover:bg-blue disabled:opacity-60"
        >
          {busy ? 'Записываю…' : 'Дальше'}
        </button>
      </div>
    </div>
  )
}
