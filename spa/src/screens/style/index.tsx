import { useState } from 'react'

import { useStateQuery } from '../../api/queries'
import type { StyleTraining } from '../../api/types'
import { plural } from '../../shell/format'
import { DecisionList } from './DecisionList'
import { ExamTable } from './ExamTable'

/**
 * «Мой стиль» — how closely the team decides the way the owner decides, and everything that
 * figure is made of.
 *
 * ══════════════════════════ FIDELITY IS MEASURED, NEVER ASSERTED ══════════════════════════
 *
 * The one number at the top comes from a graded exam kept in a ledger on the machine, and
 * from nowhere else. An install that has never been graded has no number here — it says so
 * in a sentence instead of showing a confident zero, because a zero would be a claim about
 * an exam that never happened. Everything on this screen behaves that way: a figure the
 * artifacts do not carry is missing, not invented.
 *
 * ═════════════════════ ONLY ALREADY-REDACTED MATERIAL REACHES THE GLASS ═════════════════════
 *
 * The decisions shown here are the distillation's own drafts, and only the contents of the
 * fenced blocks its scrubber wrote. The raw corpus — the hand-written notes, the session
 * material — never leaves the disk, and the exam's answer key is never opened by a read
 * model at all. That is why the per-situation breakdown is missing rather than approximated:
 * the blind exam is worth more than a table.
 *
 * ══════════════════════ THE SCREEN READS; THE TEACHING RUNS ELSEWHERE ══════════════════════
 *
 * Learning happens in a terminal, where the distillation and the exam have a whole toolchain
 * behind them. There is no door in the daemon that starts them, so the controls the design
 * draws for those actions are drawn in their true state and disabled, each under the quiet
 * line «запускается из терминала» — the same choice «Правила» made. A control that admits it
 * cannot act is honest in both directions; a control wired to an address that answers
 * nothing would not be.
 */

/** The line under a drawn-but-inert control. Written once so every one of them says it alike. */
const RUNS_IN_TERMINAL = 'запускается из терминала'

function Pill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className="text-[16px] font-bold text-tx tabular-nums">{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

function CardHead({ title, note, children }: { title: string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
      {note ? <span className="text-[11px] text-tx3 tabular-nums">{note}</span> : null}
      {children}
    </div>
  )
}

/** One training of the history: when, over how much, and what the grading said. */
function TrainingRow({ training, first }: { training: StyleTraining; first: boolean }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-3 px-[18px] py-3 ${first ? '' : 'border-t border-bd'}`}>
      <span className="w-[92px] flex-none text-[12px] whitespace-nowrap text-tx tabular-nums">
        {training.date || '—'}
      </span>
      <span className="w-[168px] flex-none text-[11.5px] whitespace-nowrap text-tx2 tabular-nums">
        {training.decisionsCount} {plural(training.decisionsCount, 'решение', 'решения', 'решений')} разобрано
      </span>
      <span className="min-w-0 flex-1 text-[11.5px] leading-[1.5] text-tx2">{training.summary}</span>
      {training.policyVersion != null ? (
        <span className="flex-none text-[11px] whitespace-nowrap text-tx3">версия {training.policyVersion}</span>
      ) : null}
    </div>
  )
}

export function Screen() {
  const state = useStateQuery()
  const style = state.data?.style
  const filled = style && !style.absent ? style : null

  const [tableOpen, setTableOpen] = useState(false)

  const decisions = filled?.decisions ?? []
  const trainings = filled?.trainings ?? []
  const examRows = filled?.examTable ?? []
  const matchRate = filled?.matchRate
  /** How many situations the latest grading covered. From the ledger — never a round number. */
  const situations = trainings.length > 0 ? trainings[0].decisionsCount : null
  const shownTrainings = trainings.slice(0, 3)
  const olderTrainings = trainings.length - shownTrainings.length

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Мой стиль</h1>
        {matchRate !== undefined ? <Pill value={`${matchRate}%`} label="совпадение" /> : null}
        {situations !== null ? (
          <Pill value={String(situations)} label={plural(situations, 'проверка', 'проверки', 'проверок')} />
        ) : null}
        {filled ? (
          <Pill
            value={String(decisions.length)}
            label={`${plural(decisions.length, 'решение', 'решения', 'решений')} разобрано`}
          />
        ) : null}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Помощник учится на Ваших решениях. Здесь видно, чему он научился и насколько точно.
        </span>
      </div>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Связь потеряна. Показан слепок на момент последнего чтения.</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[900px] flex-col gap-[22px]">
          {filled ? (
            <>
              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="Точность моего стиля">
                  {examRows.length > 0 ? (
                    <>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => setTableOpen((v) => !v)}
                        aria-expanded={tableOpen}
                        className="flex-none text-[11.5px] text-blue hover:text-teal"
                      >
                        {tableOpen ? 'Свернуть' : `Все ${examRows.length} ситуаций`}
                      </button>
                    </>
                  ) : null}
                </CardHead>

                <div className="flex flex-col gap-1.5 px-[18px] py-[18px]">
                  {matchRate === undefined ? (
                    <>
                      <span className="text-[13px] text-tx">
                        Точность ещё не измерена — экзамен не сдавался.
                      </span>
                      <span className="max-w-[640px] text-[11.5px] leading-[1.6] text-tx2">
                        Помощник учится на разобранных решениях; проверка ставит ему оценку по
                        Вашей же истории — и до неё честнее не показывать никакой процент.
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-[13.5px] leading-[1.6] text-tx">
                        Помощник решает как Вы в{' '}
                        <span className="text-[20px] font-bold text-tx tabular-nums">{matchRate}</span> случаях из
                        100
                      </span>
                      <span className="text-[11.5px] leading-[1.5] text-tx2">
                        {situations !== null
                          ? `по ${situations} ${plural(situations, 'проверочной ситуации', 'проверочным ситуациям', 'проверочным ситуациям')} из Вашей реальной истории`
                          : 'по проверочным ситуациям из Вашей реальной истории'}
                        {filled.policyVersion != null ? ` · версия стиля ${filled.policyVersion}` : ''}
                      </span>
                    </>
                  )}
                </div>

                {examRows.length > 0 ? (
                  tableOpen ? (
                    <ExamTable rows={examRows} />
                  ) : null
                ) : (
                  <ExamTable rows={[]} />
                )}
              </div>

              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="Проверьте меня" />
                <div className="flex flex-col gap-2.5 px-[18px] py-[18px]">
                  <span className="max-w-[640px] text-[12.5px] leading-[1.6] text-tx2">
                    Разбор новых ситуаций идёт в терминале: помощник показывает случай и свой ответ,
                    Вы соглашаетесь или поправляете. Окно показывает результат этой работы — оно её
                    не ведёт.
                  </span>
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-disabled="true"
                      title={RUNS_IN_TERMINAL}
                      className="flex-none rounded-[9px] border border-bd2 px-3.5 py-1.5 text-[12px] text-tx3 opacity-60"
                    >
                      Да, я бы так же
                    </span>
                    <span
                      aria-disabled="true"
                      title={RUNS_IN_TERMINAL}
                      className="flex-none rounded-[9px] border border-bd2 px-3.5 py-1.5 text-[12px] text-tx3 opacity-60"
                    >
                      Нет, я бы иначе
                    </span>
                    <span className="text-[11px] text-tx3">{RUNS_IN_TERMINAL}</span>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="История обучения" note={String(trainings.length)} />
                {shownTrainings.length === 0 ? (
                  <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                    Обучений ещё не было: помощник читает решения, но ни одной проверки пока не
                    прошёл.
                  </p>
                ) : (
                  shownTrainings.map((t, i) => (
                    <TrainingRow key={`${t.date}-${i}`} training={t} first={i === 0} />
                  ))
                )}
                <div className="flex items-center gap-3 border-t border-bd bg-surf px-[18px] py-2.5">
                  <button
                    type="button"
                    disabled
                    title={RUNS_IN_TERMINAL}
                    className="flex-none cursor-not-allowed rounded-[9px] border border-bd2 px-3.5 py-1.5 text-[12px] text-tx2 opacity-60"
                  >
                    Обновить мой стиль
                  </button>
                  <span className="text-[11px] text-tx3">{RUNS_IN_TERMINAL}</span>
                  <div className="flex-1" />
                  {olderTrainings > 0 ? (
                    <span className="flex-none text-[11px] whitespace-nowrap text-tx3 tabular-nums">
                      и ещё {olderTrainings} {plural(olderTrainings, 'обучение', 'обучения', 'обучений')} раньше
                    </span>
                  ) : null}
                </div>
              </div>

              <DecisionList decisions={decisions} />
            </>
          ) : (
            <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
              <CardHead title="Слепок" />
              <div className="flex flex-col gap-2 px-[18px] py-5">
                <span className="text-[13px] text-tx">
                  Помощник ещё не учился Вашему стилю — разбирать пока нечего.
                </span>
                <span className="max-w-[640px] text-[11.5px] leading-[1.6] text-tx2">
                  Стиль набирается из Ваших же решений: каждое разобранное решение становится
                  правилом, а проверка по Вашей истории показывает, насколько точно помощник его
                  усвоил. Разбор идёт в терминале.
                </span>
              </div>
            </div>
          )}

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Всё, на чём учится помощник, хранится только на Вашем компьютере и никуда не
            отправляется. Сюда попадают только выжимки, которые прошли очистку; сырые записи
            остаются на диске.
          </p>
        </div>
      </div>
    </section>
  )
}
