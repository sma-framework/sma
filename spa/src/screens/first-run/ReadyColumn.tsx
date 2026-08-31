import type { OnboardingReadyLine, OnboardingStep } from '../../api/types'
import { plural } from '../../shell/format'
import { wordCount } from './shared'

/**
 * ReadyColumn — the quiet column on the right: what the house already has, and how much of
 * the conversation is behind us.
 *
 * ═══════════════════════ IT REPORTS, IT NEVER ENCOURAGES ═══════════════════════
 *
 * Every line here is DERIVED by the daemon from what has actually accumulated. «Команда
 * собрана» is true from the first second because the team is installed, not earned; the
 * safety rules light up when the release habits are known; the notebook when the last step
 * has something in it. Nothing on this column congratulates anybody, and nothing here is a
 * progress bar racing a person to the end — it is a receipt for what is true so far.
 */

function Meter({ step }: { step: OnboardingStep }) {
  const pct = step.total > 0 ? Math.round((step.answered / step.total) * 100) : 0
  const full = step.answered >= step.total && step.total > 0

  return (
    <div className="flex flex-col gap-1.5 border-t border-bd py-2.5">
      <div className="flex items-baseline gap-2.5">
        <span
          className={`min-w-0 flex-1 truncate text-[12.5px] ${
            step.current ? 'font-semibold text-tx' : 'text-tx2'
          }`}
        >
          {step.label}
        </span>
        <span className="flex-none text-[11.5px] text-tx3">
          {step.answered} из {step.total}
        </span>
        <span
          className={`w-[34px] flex-none text-right text-[12px] font-semibold tabular-nums ${
            full ? 'text-ok-tx' : 'text-tx2'
          }`}
        >
          {pct}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-[2px] border border-bd bg-surf">
        <div
          className={`h-full rounded-[2px] ${full ? 'bg-green' : 'bg-blue'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function ReadyColumn({
  ready,
  steps,
  answers,
}: {
  ready: OnboardingReadyLine[]
  steps: OnboardingStep[]
  answers: Record<string, string>
}) {
  const readyDone = ready.filter((r) => r.done).length
  const answered = Object.keys(answers).length
  const total = steps.reduce((sum, s) => sum + s.total, 0)
  const words = Object.values(answers).reduce((sum, text) => sum + wordCount(text), 0)
  const toldPct = total > 0 ? Math.round((answered / total) * 100) : 0

  return (
    // Своя ширина — только там, где рядом с разговором для неё есть место; порог тот же, на
    // котором ряд в index.tsx разворачивается из столбца. Ниже колонка занимает всю ширину и
    // едет под разговор: 356px, оставленные безусловными, вынесли бы страницу вбок на телефоне.
    <div className="flex w-full flex-none flex-col gap-4 lg:w-[356px]">
      <section className="rounded-[14px] border border-bd bg-card px-5 pt-[18px] pb-1.5 shadow-panel">
        <div className="flex items-center justify-between gap-3 pb-3">
          <span className="text-[11.5px] font-semibold tracking-[0.09em] text-tx3 uppercase">
            Что уже готово
          </span>
          <span className="text-[12px] font-semibold text-tx2">
            {readyDone} из {ready.length}
          </span>
        </div>
        {ready.map((r) => (
          <div key={r.lead} className="flex items-baseline gap-2.5 border-t border-bd py-3">
            <span
              aria-hidden
              className={`w-3.5 flex-none text-center text-[12px] font-semibold ${
                r.done ? 'text-ok-tx' : 'text-tx3'
              }`}
            >
              {r.done ? '✓' : '·'}
            </span>
            <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-tx2">
              <span className={`font-semibold ${r.done ? 'text-tx' : 'text-tx2'}`}>{r.lead}: </span>
              {r.tail}
            </span>
          </div>
        ))}
      </section>

      <section className="rounded-[14px] border border-bd bg-card px-5 pt-[18px] pb-4 shadow-panel">
        <div className="flex items-center justify-between gap-3 pb-3.5">
          <span className="text-[11.5px] font-semibold tracking-[0.09em] text-tx3 uppercase">
            Что Вы рассказали
          </span>
          <span className="text-[12px] font-semibold text-tx2">{toldPct}%</span>
        </div>
        {steps.map((s) => (
          <Meter key={s.step} step={s} />
        ))}
        <div className="flex items-baseline justify-between gap-2.5 border-t border-bd pt-3">
          <span className="text-[12.5px] text-tx3">Слов записано</span>
          <span className="text-[12.5px] font-semibold text-tx2">
            {words} {plural(words, 'слово', 'слова', 'слов')}
          </span>
        </div>
      </section>
    </div>
  )
}
