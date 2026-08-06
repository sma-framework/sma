import { useState } from 'react'
import { useDecisionAnswer, usePhaseQuery, usePhaseStage, usePhaseUat } from '../../api/queries'
import type { PhaseArtifact, PhaseStage, PhaseUatItem } from '../../api/types'
import { DecisionCard, EMPTY_DRAFT } from '../../shell/DecisionCard'
import type { DecisionDraft } from '../../shell/DecisionCard'
import { ArtifactViewer } from './ArtifactViewer'
import {
  doorWords,
  isOpen,
  progressOf,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_WHAT,
  STATUS_TONE,
  STATUS_WORD,
  stageWords,
} from './shared'

/**
 * PhaseCardView — one phase in full, and the four buttons that move it.
 *
 * ═══════════════════════ ONE READING, FIVE BLOCKS OVER IT ═══════════════════════
 *
 * Everything on this card — where each stage stands, what was asked, which documents exist,
 * what a person said about each line of acceptance — comes out of ONE reading of the phase.
 * The screen asks nothing else and derives nothing on its own: the daemon works all of it out
 * off the directory at read time, with the same map its own exit gate closes a stage on. A
 * second opinion computed here is exactly how a screen ends up calling a stage finished while
 * the machine is still failing it.
 *
 * ═══════════════════════════ NOTHING STARTS BY ITSELF ═══════════════════════════
 *
 * Every act on this card is a click: starting a stage, answering a question, recording a
 * verdict. There is no effect that acts, nothing retries an act, and nothing chooses an option
 * on a person's behalf. A stage is started as a TASK in the queue — the same queue as every
 * other piece of work — so what changes on screen is the picture of the work, not this card.
 */

/** One stage, where it stands, and the one act available on it. */
function StageRow({
  stage,
  status,
  busy,
  onStart,
}: {
  stage: PhaseStage
  status: 'none' | 'in-progress' | 'done'
  busy: boolean
  onStart: () => void
}) {
  const live = status === 'in-progress'
  return (
    <div className="flex items-center gap-3.5 border-t border-bd px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[13px] font-semibold text-tx">{STAGE_LABEL[stage]}</span>
          <span className={`rounded-full px-2.5 py-[3px] text-[10.5px] ${STATUS_TONE[status]}`}>
            {STATUS_WORD[status]}
          </span>
        </div>
        <div className="mt-1 text-[11.5px] leading-[1.5] text-tx3">{STAGE_WHAT[stage]}</div>
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={live || busy}
        className="flex-none rounded-[9px] border border-bd2 px-[15px] py-2 text-[12px] font-semibold text-tx2 hover:border-blue hover:text-blue-d disabled:opacity-50"
      >
        {live ? 'Идёт' : status === 'done' ? 'Пройти заново' : 'Запустить'}
      </button>
    </div>
  )
}

/** One document, by its name — the reading of it happens in the viewer, one click away. */
function ArtifactRow({ artifact, onOpen }: { artifact: PhaseArtifact; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-baseline gap-3 border-t border-bd px-4 py-2.5 text-left first:border-t-0 hover:bg-surf"
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">{artifact.name}</span>
      <span className="flex-none text-[11.5px] text-blue-d">Открыть</span>
    </button>
  )
}

/** One line of acceptance: what it was, what a person said, and the note they left. */
function UatRow({
  item,
  busy,
  problem,
  onVerdict,
}: {
  item: PhaseUatItem
  busy: boolean
  problem: string | null
  onVerdict: (verdict: 'pass' | 'fail', note: string) => void
}) {
  const [note, setNote] = useState(item.note ?? '')

  return (
    <div className="flex flex-col gap-2 border-t border-bd px-4 py-3 first:border-t-0">
      <div className="flex items-baseline gap-3">
        <span className="flex-none text-[11.5px] text-tx3 tabular-nums">{item.item}</span>
        <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">
          {item.name ?? 'Пункт приёмки'}
        </span>
        {item.verdict ? (
          <span
            className={`flex-none rounded-full px-2.5 py-[3px] text-[10.5px] ${
              item.verdict === 'pass' ? 'bg-ok-s text-ok-tx' : 'bg-err-s text-err-tx'
            }`}
          >
            {item.verdict === 'pass' ? 'работает' : 'не работает'}
          </span>
        ) : (
          <span className="flex-none rounded-full bg-idle-s px-2.5 py-[3px] text-[10.5px] text-idle-tx">
            не проверено
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Заметка — что именно увидели"
          className="min-w-0 flex-1 rounded-[8px] border border-bd2 bg-surf px-3 py-1.5 text-[12px] text-tx outline-none focus:border-blue focus:bg-card disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => onVerdict('pass', note)}
          disabled={busy}
          className="flex-none rounded-[8px] border border-bd2 px-3 py-1.5 text-[11.5px] font-semibold text-ok-tx hover:border-blue disabled:opacity-50"
        >
          Работает
        </button>
        <button
          type="button"
          onClick={() => onVerdict('fail', note)}
          disabled={busy}
          className="flex-none rounded-[8px] border border-bd2 px-3 py-1.5 text-[11.5px] font-semibold text-err-tx hover:border-blue disabled:opacity-50"
        >
          Не работает
        </button>
      </div>

      {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}
    </div>
  )
}

function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[12px] border border-bd bg-card shadow-panel">
      <div className="flex items-baseline gap-3 border-b border-bd px-4 py-2.5">
        <h2 className="m-0 text-[11px] font-semibold tracking-[0.09em] text-tx3 uppercase">
          {title}
        </h2>
        {note ? <span className="text-[11.5px] text-tx3">{note}</span> : null}
      </div>
      {children}
    </section>
  )
}

export function PhaseCardView({ id, onBack }: { id: string; onBack: () => void }) {
  const card = usePhaseQuery(id)
  const startStage = usePhaseStage()
  const answer = useDecisionAnswer()
  const uat = usePhaseUat()

  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({})
  const [viewing, setViewing] = useState<PhaseArtifact | null>(null)
  const [stageProblem, setStageProblem] = useState<string | null>(null)
  const [answerProblem, setAnswerProblem] = useState<Record<string, string>>({})
  const [uatProblem, setUatProblem] = useState<Record<string, string>>({})

  const phase = card.data
  const questions = phase?.questions ?? []
  const open = questions.filter(isOpen)
  const counts = progressOf(questions)

  const start = (stage: PhaseStage) => {
    setStageProblem(null)
    startStage.mutate(
      { phase: id, stage },
      { onError: (err) => setStageProblem(stageWords(err)) },
    )
  }

  const send = (questionId: string, input: { optionId?: string; freeText?: string }) => {
    setAnswerProblem((was) => ({ ...was, [questionId]: '' }))
    answer.mutate(
      { phase: id, questionId, ...input },
      {
        // The card is re-read by the action itself. Clearing the draft here — and only on a
        // success — means a refused answer keeps every word the person typed.
        onSuccess: () => setDrafts((was) => ({ ...was, [questionId]: EMPTY_DRAFT })),
        onError: (err) => setAnswerProblem((was) => ({ ...was, [questionId]: doorWords(err) })),
      },
    )
  }

  const verdict = (item: string, value: 'pass' | 'fail', note: string) => {
    setUatProblem((was) => ({ ...was, [item]: '' }))
    uat.mutate(
      { phase: id, item, verdict: value, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      { onError: (err) => setUatProblem((was) => ({ ...was, [item]: doorWords(err) })) },
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <button
          type="button"
          onClick={onBack}
          className="flex-none rounded-[8px] border border-bd2 px-3 py-1.5 text-[12px] text-tx2 hover:text-tx"
        >
          ← Все фазы
        </button>
        <h1 className="m-0 min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-tx">
          {phase?.name ?? 'Открываю…'}
        </h1>
        <span className="flex-1" />
        {questions.length > 0 ? (
          <span className="flex-none rounded-[9px] border border-bd bg-card px-3 py-1.5 text-[11.5px] text-tx2">
            {counts.open} открыто / {counts.answered} отвечено
          </span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
        {card.isLoading ? <p className="m-0 text-[13px] text-tx2">Открываю фазу…</p> : null}
        {card.isError ? (
          <p className="m-0 text-[13px] text-err-tx">
            Фаза не открылась. Ничего с ней не случилось — попробуйте ещё раз.
          </p>
        ) : null}

        {phase ? (
          <div className="flex max-w-[860px] flex-col gap-5">
            <Block title="Стадии" note="каждая — задача в очереди, как любая другая работа">
              {STAGE_ORDER.map((stage) => (
                <StageRow
                  key={stage}
                  stage={stage}
                  status={phase.stages[stage]}
                  busy={startStage.isPending}
                  onStart={() => start(stage)}
                />
              ))}
              {stageProblem ? (
                <p className="m-0 border-t border-bd px-4 py-2.5 text-[12px] text-err-tx">
                  {stageProblem}
                </p>
              ) : null}
            </Block>

            <Block
              title="Вопросы"
              note={
                open.length > 0
                  ? `${counts.open} открыто / ${counts.answered} отвечено`
                  : 'открытых вопросов нет'
              }
            >
              <div className="flex flex-col gap-3 p-4">
                {open.length === 0 ? (
                  <p className="m-0 text-[12.5px] text-tx2">
                    Сейчас никто ничего не спрашивает. Вопрос появится здесь, как только стадия до
                    него дойдёт.
                  </p>
                ) : (
                  open.map((q) => (
                    <DecisionCard
                      key={q.id}
                      question={q}
                      draft={drafts[q.id] ?? EMPTY_DRAFT}
                      busy={answer.isPending && answer.variables?.questionId === q.id}
                      problem={answerProblem[q.id] || null}
                      onDraft={(draft) => setDrafts((was) => ({ ...was, [q.id]: draft }))}
                      onAnswer={(input) => send(q.id, input)}
                    />
                  ))
                )}
              </div>
            </Block>

            <Block title="Планы и итоги" note="открываются здесь же, читать в терминале не нужно">
              {phase.plans.length === 0 && phase.summaries.length === 0 ? (
                <p className="m-0 px-4 py-3 text-[12.5px] text-tx2">
                  Документов пока нет — их пишут стадии.
                </p>
              ) : (
                <>
                  {phase.plans.map((a) => (
                    <ArtifactRow key={a.path} artifact={a} onOpen={() => setViewing(a)} />
                  ))}
                  {phase.summaries.map((a) => (
                    <ArtifactRow key={a.path} artifact={a} onOpen={() => setViewing(a)} />
                  ))}
                </>
              )}
            </Block>

            <Block
              title="Приёмка"
              note={phase.uat.length > 0 ? 'пункт за пунктом, вашими словами' : undefined}
            >
              {phase.uat.length === 0 ? (
                <p className="m-0 px-4 py-3 text-[12.5px] text-tx2">
                  Списка приёмки нет. Он появится, когда фаза дойдёт до проверки.
                </p>
              ) : (
                <>
                  {phase.uat.map((item) => (
                    <UatRow
                      key={item.item}
                      item={item}
                      busy={uat.isPending && uat.variables?.item === item.item}
                      problem={uatProblem[item.item] || null}
                      onVerdict={(value, note) => verdict(item.item, value, note)}
                    />
                  ))}
                  {phase.uatDocument ? (
                    <ArtifactRow
                      artifact={phase.uatDocument}
                      onOpen={() => setViewing(phase.uatDocument as PhaseArtifact)}
                    />
                  ) : null}
                </>
              )}
            </Block>
          </div>
        ) : null}
      </div>

      {viewing ? <ArtifactViewer artifact={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}
