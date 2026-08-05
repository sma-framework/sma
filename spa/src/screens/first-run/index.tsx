import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { useAnswerOnboarding, useCompleteOnboarding, useOnboardingQuery } from '../../api/queries'
import type { OnboardingState, OnboardingStep, OnboardingTopic } from '../../api/types'
import { ReadyColumn } from './ReadyColumn'
import { StepPanel } from './StepPanel'
import type { AnsweredRow } from './StepPanel'
import { fromQuestion, fromTopic, wordCount } from './shared'
import type { Asked } from './shared'

/**
 * «Первый запуск» — the first thing a person ever sees, and the only time they see it.
 *
 * ═══════════════════════ A CONVERSATION THAT WRITES NOTHING BY ITSELF ════════════════
 *
 * Four steps, one question at a time, and three doors behind the whole screen: the state is
 * read (GET /api/onboarding), an answer is recorded (POST /api/onboarding/answer), and the
 * house is closed exactly once, from ONE button on the last panel (POST /api/onboarding/
 * complete). Nothing completes from an effect, a timer or a re-render: «Открыть Сегодня» is
 * the only path to the writer, and a person presses it.
 *
 * ═══════════════════════════ THE CURSOR IS THE DAEMON'S, NOT OURS ════════════════════
 *
 * Which question comes next is DERIVED by the interview from what has been visited — it is
 * never counted here. This screen holds only what a browser must: the text in the box, and
 * which already-answered question a person asked to go back to. So the interview survives
 * a reload, a crash and a second window, and the terminal footer stays true: `sma start`
 * continues the same conversation, from the same draft, because there is only one.
 *
 * ═══════════════════════════════ WITHOUT A SIDEBAR, ON PURPOSE ═══════════════════════
 *
 * The window has no navigation yet: a person meets the house after it is theirs. The shell
 * appears by itself when the interview is done, because `needed` turns false the moment the
 * profile exists — this screen does not switch anything; it simply stops being needed.
 */

/** The mark on a step: done, being asked, or still ahead. */
function StepMark({ step }: { step: OnboardingStep }) {
  const full = step.total > 0 && step.answered >= step.total
  const tone = full
    ? 'bg-ok-s text-ok-tx border-transparent'
    : step.current
      ? 'bg-blue-s text-blue border-transparent'
      : 'bg-surf text-tx3 border-bd'
  return (
    <span
      className={`flex h-5 w-5 flex-none items-center justify-center rounded-[6px] border text-[11px] font-semibold ${tone}`}
    >
      {full ? '✓' : step.step}
    </span>
  )
}

function StepsBar({ steps }: { steps: OnboardingStep[] }) {
  return (
    <div className="grid grid-cols-4 gap-3.5 pb-6">
      {steps.map((s) => {
        const pct = s.total > 0 ? Math.round((s.answered / s.total) * 100) : 0
        const full = s.total > 0 && s.answered >= s.total
        return (
          <div key={s.step} className="flex flex-col gap-2.5">
            <div className="flex min-h-[22px] items-center gap-2.5">
              <StepMark step={s} />
              <span
                className={`text-[13px] leading-[1.2] font-semibold whitespace-nowrap ${
                  s.current ? 'text-tx' : full ? 'text-tx2' : 'text-tx3'
                }`}
              >
                {s.label}
              </span>
              <span className="ml-auto text-[11.5px] whitespace-nowrap text-tx3">
                {s.answered} из {s.total}
              </span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-[2px] bg-bd2">
              <div
                className={`h-[3px] rounded-[2px] ${full ? 'bg-green' : 'bg-blue'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The house is set up. One button opens it; the other goes back to the answers. */
function DonePanel({
  steps,
  busy,
  problem,
  onOpen,
  onBack,
}: {
  steps: OnboardingStep[]
  busy: boolean
  problem: string | null
  onOpen: () => void
  onBack: (() => void) | null
}) {
  return (
    <div className="flex flex-1 flex-col px-[34px] pt-[52px] pb-11">
      <div className="text-[34px] leading-[1.2] font-bold tracking-[-0.02em] text-tx">Дом готов</div>
      <div className="mt-3 max-w-[52ch] text-[15px] leading-[1.6] text-tx2">
        Команда на связи, правила безопасности включены, записная книжка ждёт Ваших уроков.
      </div>

      <div className="mt-7 border-t border-bd">
        {steps.map((s) => {
          const full = s.total > 0 && s.answered >= s.total
          return (
            <div key={s.step} className="flex items-baseline gap-3.5 border-b border-bd py-2.5">
              <span
                aria-hidden
                className={`flex-none text-[12px] font-semibold ${full ? 'text-ok-tx' : 'text-tx3'}`}
              >
                {full ? '✓' : '·'}
              </span>
              <span className="w-[186px] flex-none text-[13px] font-semibold text-tx">{s.label}</span>
              <span className="flex-1 text-[13px] text-tx2">
                {s.answered} из {s.total} — записано
              </span>
            </div>
          )
        })}
      </div>

      {problem ? <p className="mt-4 mb-0 text-[12.5px] text-err-tx">{problem}</p> : null}

      <div className="mt-auto flex items-center gap-3.5 pt-[26px]">
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="rounded-[10px] bg-blue-d px-6 py-3 text-[14.5px] font-semibold text-white hover:bg-blue disabled:opacity-60"
        >
          {busy ? 'Открываю…' : 'Открыть Сегодня'}
        </button>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="rounded-[10px] border border-bd2 px-4 py-3 text-[13.5px] font-semibold text-tx2 hover:bg-surf hover:text-tx"
          >
            Вернуться к ответам
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function Screen() {
  const onboarding = useOnboardingQuery()
  const record = useAnswerOnboarding()
  const finish = useCompleteOnboarding()

  /** What is in the box right now. Null means «whatever is already recorded». */
  const [draft, setDraft] = useState<string | null>(null)
  /** A question a person asked to see instead of the cursor: a chip, or one they corrected. */
  const [asking, setAsking] = useState<Asked | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  /**
   * The questions this window has SHOWN, in the order it showed them. The read model names
   * only the current question, so this is the only way the screen knows the words of one
   * already answered. An answer recorded before this window opened is counted honestly
   * instead of being given a made-up label.
   */
  const seen = useRef<Map<string, Asked>>(new Map())

  const state: OnboardingState | undefined = onboarding.data
  const cursor = state?.question ? fromQuestion(state.question) : null
  const current = asking ?? cursor

  useEffect(() => {
    if (current) seen.current.set(current.key, current)
  }, [current])

  const answers = state?.answers ?? {}
  const steps = state?.steps ?? []
  const topics = state?.extraTopics ?? []

  const answered: AnsweredRow[] = useMemo(() => {
    const rows: AnsweredRow[] = []
    for (const [key, asked] of seen.current) {
      const text = answers[key]
      if (text && key !== current?.key) rows.push({ key, title: asked.title, text })
    }
    return rows
  }, [answers, current])

  const hiddenAnswers = Math.max(0, Object.keys(answers).length - answered.length - (current && answers[current.key] ? 1 : 0))

  /** «Назад» and «Вернуться к ответам» both mean: the last thing I said. */
  const lastSaid = answered.length > 0 ? answered[answered.length - 1] : null

  const goTo = (key: string) => {
    const asked = seen.current.get(key)
    if (!asked) return
    setProblem(null)
    setAsking(asked)
    setDraft(answers[key] ?? '')
  }

  const send = (text: string) => {
    if (!current) return
    setProblem(null)
    record.mutate(
      { step: current.step, key: current.key, text },
      {
        onSuccess: () => {
          setAsking(null)
          setDraft(null)
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Дверь первого запуска пока не отвечает. Ответ не записан.'
              : err instanceof ApiError && err.detail.includes('похож на секрет')
                ? 'Похоже, в ответе есть пароль или ключ. Такое мы не записываем — уберите его и повторите.'
                : 'Ответ не записан. Попробуйте ещё раз.',
          ),
      },
    )
  }

  const openHouse = () => {
    setProblem(null)
    finish.mutate(
      {},
      {
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Дверь первого запуска пока не отвечает. Ничего не записано.'
              : err instanceof ApiError && err.status === 409
                ? 'Этот дом уже настроен — окно откроется само.'
                : 'Не получилось закрыть первый запуск. Ваши ответы сохранены.',
          ),
      },
    )
  }

  /**
   * «Позже» — the exit that writes nothing.
   *
   * It goes through the SAME door «Открыть Сегодня» does, with one field set, and the two
   * outcomes are deliberately not alike: that one hands the answers to the profile writer and
   * seeds the first lessons INTO the project; this one records «спросите позже» on the
   * daemon's own side and leaves the project's files exactly as they were. The answers stay in
   * the draft, so the interview picks up where it stopped whenever a person comes back to it.
   */
  const askLater = () => {
    setProblem(null)
    finish.mutate(
      { later: true },
      {
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Дверь первого запуска пока не отвечает. Ничего не записано.'
              : err instanceof ApiError && err.status === 409
                ? 'Этот дом уже настроен — окно откроется само.'
                : 'Не получилось отложить знакомство. В проекте ничего не изменилось.',
          ),
      },
    )
  }

  const stepOf = (n: number) => steps.find((s) => s.step === n)
  const activeStep = current ? stepOf(current.step) : null
  const stepExtras = topics.filter((t) => t.step === (current?.step ?? 0))
  const chips = stepExtras.filter((t) => !t.added && t.key !== current?.key)
  const inTalk = stepExtras.filter((t) => t.added || t.key === current?.key)

  const askTopic = (t: OnboardingTopic) => {
    setProblem(null)
    setAsking(fromTopic(t))
    setDraft(answers[t.key] ?? '')
  }

  const told = Object.keys(answers).length
  const totalQuestions = state?.totalQuestions ?? 0
  const words = Object.values(answers).reduce((sum, t) => sum + wordCount(t), 0)

  const text = draft ?? (current ? (answers[current.key] ?? '') : '')

  return (
    <div className="flex min-h-screen flex-col">
      <div className="h-[3px] flex-none bg-gradient-to-r from-[#243B66] via-[#1B7E9C] to-[#74DBA0]" />

      <div className="mx-auto flex w-full max-w-[1520px] min-w-[1280px] flex-1 flex-col px-14 pt-6">
        <header className="flex items-center justify-between gap-6 pb-5">
          <div className="flex items-center gap-2.5">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
              <defs>
                <linearGradient id="smaMarkFirstRun" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#3B82F6" />
                  <stop offset=".52" stopColor="#1FA0A6" />
                  <stop offset="1" stopColor="#3CC0A0" />
                </linearGradient>
              </defs>
              <rect x="7.6" y="7.2" width="11.4" height="3" rx="1.5" fill="url(#smaMarkFirstRun)" />
              <rect x="3" y="11.2" width="18" height="3" rx="1.5" fill="url(#smaMarkFirstRun)" />
              <rect x="5.4" y="15.2" width="11.4" height="3" rx="1.5" fill="url(#smaMarkFirstRun)" />
              <path
                d="M20.4 1.6 21.1 3.4 22.9 4.1 21.1 4.8 20.4 6.6 19.7 4.8 17.9 4.1 19.7 3.4Z"
                fill="#74DBA0"
              />
            </svg>
            <span className="bg-gradient-to-r from-[#5B9BE8] via-[#1FA0A6] to-[#74DBA0] bg-clip-text text-[19px] font-extrabold tracking-[0.16em] text-transparent">
              SMA
            </span>
            <span aria-hidden className="mx-1 h-[18px] w-px bg-bd2" />
            <span className="text-[13px] font-medium text-tx2">Первый запуск</span>
          </div>
          {state ? (
            <div className="flex items-center gap-2.5">
              <span className="text-[12.5px] text-tx3">
                Рассказано {told} из {totalQuestions} · {words} сл.
              </span>
              <span className="rounded-[8px] border border-bd bg-card px-2.5 py-1.5 text-[12.5px] font-semibold text-tx2 shadow-panel">
                {current ? `Шаг ${current.step} из ${steps.length || 4}` : 'Все шаги пройдены'}
              </span>
              {/* The way out, on the glass from question one — see askLater. */}
              <button
                type="button"
                onClick={askLater}
                disabled={finish.isPending}
                title="Ничего не будет записано в Ваш проект — знакомство продолжится, когда Вы захотите"
                className="rounded-[8px] border border-bd2 bg-card px-3 py-1.5 text-[12.5px] font-semibold text-tx2 shadow-panel hover:bg-surf hover:text-tx disabled:opacity-60"
              >
                {finish.isPending ? '…' : 'Позже'}
              </button>
            </div>
          ) : null}
        </header>

        <StepsBar steps={steps} />

        <div className="flex items-start gap-[22px] pb-[26px]">
          <div className="flex min-h-[560px] min-w-0 flex-1 flex-col rounded-[14px] border border-bd bg-card shadow-panel">
            {onboarding.isLoading ? (
              <div className="p-[34px] text-[13px] text-tx2">Открываю первый запуск…</div>
            ) : current ? (
              <StepPanel
                question={current}
                subLabel={
                  activeStep
                    ? `Вопрос ${Math.min(activeStep.answered + 1, activeStep.total)} из ${activeStep.total}`
                    : ''
                }
                draft={text}
                answered={answered}
                hiddenAnswers={hiddenAnswers}
                extras={chips}
                added={inTalk}
                busy={record.isPending}
                problem={problem}
                onDraft={setDraft}
                onSubmit={() => send(text)}
                onSkip={() => send('')}
                onBack={lastSaid ? () => goTo(lastSaid.key) : null}
                onEdit={goTo}
                onTopic={askTopic}
              />
            ) : (
              <DonePanel
                steps={steps}
                busy={finish.isPending}
                problem={problem}
                onOpen={openHouse}
                onBack={lastSaid ? () => goTo(lastSaid.key) : null}
              />
            )}
          </div>

          <ReadyColumn ready={state?.ready ?? []} steps={steps} answers={answers} />
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-[7px] border-t border-bd pt-3.5 pb-[18px] text-[12.5px] leading-[1.5] text-tx3">
          <span>Не сейчас? Нажмите «Позже» наверху — в Вашем проекте ничего не появится, а окно откроется.</span>
          <span aria-hidden className="mx-1 h-[12px] w-px bg-bd2" />
          <span>Привычнее в терминале? Продолжите там:</span>
          <span className="rounded-[6px] border border-bd bg-surf px-2 py-0.5 font-mono text-[12px] text-tx2">
            sma start
          </span>
          <span>Всё сохранится.</span>
        </div>
      </div>
    </div>
  )
}
