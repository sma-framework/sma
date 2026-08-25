import { useState } from 'react'
import { useDecisionAnswer, usePhaseQuery, usePhaseStage, usePhaseUat, useStateQuery } from '../../api/queries'
import type {
  PhaseArtifact,
  PhaseCard,
  PhasePlan,
  PhaseStage,
  PhaseStageStatus,
  PhaseUatItem,
  PhaseWave,
  WaveRow,
} from '../../api/types'
import { DecisionCard, EMPTY_DRAFT } from '../../shell/DecisionCard'
import type { DecisionDraft } from '../../shell/DecisionCard'
import { EntitySummary } from '../../shell/EntitySummary'
import { LiveTimer } from '../../shell/LiveTimer'
import { currentStage, phaseStats } from '../../shell/stats'
import { ArtifactViewer } from './ArtifactViewer'
import { PhaseFolderView } from './PhaseFolder'
import {
  doorWords,
  isOpen,
  progressOf,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGE_WHAT,
  STATUS_WORD,
  stageWords,
} from './shared'

/**
 * PhaseCardView — one phase in full: four stages, the gates between them, and what is inside
 * whichever stage a person opened.
 *
 * ═══════════════════════ ONE READING, EVERYTHING OVER IT ═══════════════════════
 *
 * Everything on this card — where each stage stands, what was asked, which documents exist,
 * which plans belong to which wave, what a person said about each line of acceptance — comes
 * out of ONE reading of the phase. The screen asks nothing else and derives nothing on its own:
 * the daemon works all of it out off the directory at read time, with the same map its own exit
 * gate closes a stage on. A second opinion computed here is exactly how a screen ends up calling
 * a stage finished while the machine is still failing it.
 *
 * ═══════════════ ЧЕТЫРЕ СТАДИИ, ТРИ ВОРОТ, И ЧТО ТРЕБУЕТСЯ ОТ ЧЕЛОВЕКА ═══════════════
 *
 * Фаза читается как дорога: стадия — ворота — стадия. Ворота называют, что требуется ОТ
 * ЧЕЛОВЕКА, чтобы работа поехала дальше, — потому что это единственное место, где фаза может
 * встать насовсем, и человек должен видеть это, не открывая ничего.
 *
 * Счётчик вопросов стоит на ОДНИХ воротах, а не на всех: дверь не говорит, какая стадия
 * припарковала вопрос, поэтому число ставится рядом с той стадией, которая сейчас идёт (а если
 * не идёт ни одна — у первых ворот). Написать одно и то же число трижды значило бы сказать, что
 * вопросов втрое больше.
 *
 * ═══════════════════════════ NOTHING STARTS BY ITSELF ═══════════════════════════
 *
 * Every act on this card is a click: starting a stage, answering a question, recording a
 * verdict. There is no effect that acts, nothing retries an act, and nothing chooses an option
 * on a person's behalf. A stage is started as a TASK in the queue — the same queue as every
 * other piece of work — so what changes on screen is the picture of the work, not this card.
 *
 * ═══════════════════════════ КАРТОЧКУ БЕРУТ ВЗАЙМЫ ═══════════════════════════
 *
 * Этот вид открывают ДВА экрана: список фаз и список задач. Поэтому путь входа приезжает
 * сюда пропсом (`trail`), а не выдумывается здесь: крошки обязаны вести назад ровно туда,
 * откуда человек пришёл, а карточка сама этого знать не может и не должна.
 */

/** Одна крошка пути: как называется и куда возвращает. Без обработчика — это «вы здесь». */
export interface PhaseCrumb {
  label: string
  onClick?: () => void
}

/** Тон состояния — одна запись на весь вид: цвет никогда не единственный носитель смысла. */
const TONE: Record<'ok' | 'run' | 'dec' | 'wait' | 'fail', { dot: string; seg: string; word: string }> = {
  ok: { dot: 'bg-green', seg: 'bg-green', word: 'text-ok-tx' },
  run: { dot: 'bg-blue', seg: 'bg-blue', word: 'text-blue' },
  dec: { dot: 'bg-warn', seg: 'bg-warn', word: 'text-warn-tx' },
  wait: { dot: 'bg-tx3', seg: '', word: 'text-tx3' },
  fail: { dot: 'bg-err', seg: 'bg-err', word: 'text-err-tx' },
}

type Tone = keyof typeof TONE

const STAGE_TONE: Record<PhaseStageStatus, Tone> = { none: 'wait', 'in-progress': 'run', done: 'ok' }

/**
 * Слова, которыми план называет своё состояние в собственной шапке, — и ТОЛЬКО известные.
 *
 * Незнакомое слово показывается ровно так, как его сказала дверь: словарь здесь переводит наши
 * собственные, а не решает за чужой документ, что он имел в виду. `null` — это «нет данных», и
 * это отдельный ответ, а не «готов, раз никто не возразил».
 */
const PLAN_WORD: Record<string, string> = {
  done: 'готов',
  complete: 'готов',
  completed: 'готов',
  'in-progress': 'идёт',
  running: 'идёт',
  blocked: 'заблокирован',
  draft: 'черновик',
}

const PLAN_DONE = new Set(['done', 'complete', 'completed'])

function planIsDone(plan: PhasePlan): boolean {
  return plan.status != null && PLAN_DONE.has(plan.status.toLowerCase())
}

function planWord(plan: PhasePlan): string {
  if (plan.status == null) return 'нет данных'
  return PLAN_WORD[plan.status.toLowerCase()] ?? plan.status
}

function planTone(plan: PhasePlan): Tone {
  if (plan.status == null) return 'wait'
  const word = plan.status.toLowerCase()
  if (PLAN_DONE.has(word)) return 'ok'
  if (word === 'in-progress' || word === 'running') return 'run'
  if (word === 'blocked') return 'fail'
  return 'wait'
}

/** «закрыта» / «закрыто 2 из 5» — посчитано по планам волны, ничего сверх посчитанного. */
function waveMeta(plans: PhasePlan[]): string {
  if (plans.length === 0) return 'планов нет'
  const done = plans.filter(planIsDone).length
  if (done === plans.length) return 'закрыта'
  if (done === 0 && plans.every((p) => p.status == null)) return 'о статусах нет данных'
  return `закрыто ${done} из ${plans.length}`
}

/** Лента отрезков. Отрезок, которого никто не мерил, — контур, а не заливка. */
function Ribbon({ segs }: { segs: Tone[] }) {
  if (segs.length === 0) return null
  return (
    <div className="mt-2 flex h-1.5 items-stretch gap-[3px]">
      {segs.map((s, i) => (
        <div
          key={i}
          className={`flex-1 rounded-[2px] ${s === 'wait' ? 'border border-dashed border-bd2' : TONE[s].seg}`}
        />
      ))}
    </div>
  )
}

/** Одна стадия дороги: номер, слово состояния, название и лента того, что в ней измерено. */
function StageCard({
  stage,
  index,
  status,
  segs,
  picked,
  onPick,
}: {
  stage: PhaseStage
  index: number
  status: PhaseStageStatus
  segs: Tone[]
  picked: boolean
  onPick: () => void
}) {
  const tone = TONE[STAGE_TONE[status]]
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={picked}
      className={`min-w-0 flex-1 rounded-[10px] border px-3 py-2.5 text-left ${
        picked ? 'border-blue bg-blue-s' : 'border-bd bg-card hover:border-bd2'
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-tx3 uppercase tabular-nums">
          Стадия {index + 1}
        </span>
        <span className="flex-1" />
        <span className={`text-[10.5px] font-semibold ${tone.word}`}>{STATUS_WORD[status]}</span>
      </span>
      <span className="mt-1 block text-[13px] font-semibold text-tx">{STAGE_LABEL[stage]}</span>
      <Ribbon segs={segs} />
    </button>
  )
}

/** Ворота между стадиями: что требуется от человека, чтобы работа поехала дальше. */
function Gate({ text, tone }: { text: string; tone: Tone }) {
  return (
    <div className="flex w-[86px] flex-none flex-col items-center justify-center gap-1.5 px-1">
      <span
        aria-hidden
        className={`h-2.5 w-2.5 rotate-45 border ${
          tone === 'wait' ? 'border-bd2 bg-card' : `border-transparent ${TONE[tone].seg}`
        }`}
      />
      <span className={`text-center text-[9.5px] leading-[1.25] ${tone === 'dec' ? 'text-warn-tx' : 'text-tx3'}`}>
        {text}
      </span>
    </div>
  )
}

/** Один план внутри волны: как называется, что о себе говорит, открывается кликом. */
function PlanCard({ plan, onOpen }: { plan: PhasePlan; onOpen: () => void }) {
  const tone = planTone(plan)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1 rounded-[7px] border border-bd bg-card px-2.5 py-2 text-left hover:border-blue"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${TONE[tone].dot}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-tx">
          {plan.title ?? plan.name}
        </span>
      </span>
      <span className={`text-[10.5px] ${TONE[tone].word}`}>{planWord(plan)}</span>
    </button>
  )
}

/** Одна волна исполнения: её планы, сгруппированные дверью, и что о ней посчитано. */
function WaveColumn({
  wave,
  stop,
  onOpenPlan,
}: {
  wave: PhaseWave
  stop?: WaveRow
  onOpenPlan: (plan: PhasePlan) => void
}) {
  return (
    <div className="min-w-[180px] flex-1">
      <div className="flex items-baseline justify-between gap-2 px-0.5 pb-1.5">
        <span className="text-[11.5px] font-semibold text-tx">
          {wave.wave === null ? 'Волна не названа' : `Волна ${wave.wave}`}
        </span>
        <span className="text-[10.5px] text-tx3 tabular-nums">{waveMeta(wave.plans)}</span>
      </div>
      {/* ОСТАНОВЛЕНА — сказано словами прямо на волне, и сказано ровно то, что происходит: новой
          работы этой волны никто не получит, а живая доводит текущий шаг. Приказ читается из
          того же реестра, которому подчиняется диспетчер, поэтому «встала» здесь структурно не
          может разойтись с тем, что делает движок. */}
      {stop?.held ? (
        <div className="mb-1.5 rounded-[7px] border border-warn/40 bg-warn-s px-2 py-1.5">
          <div className="font-mono text-[10px] font-semibold text-warn-tx uppercase">волна остановлена</div>
          <p className="m-0 mt-0.5 text-[10.5px] leading-[1.4] text-tx2">
            {stop.running.length > 0
              ? `${stop.running.length === 1 ? 'Задача доводит' : 'Задачи доводят'} текущий шаг и ${
                  stop.running.length === 1 ? 'встаёт' : 'встают'
                } · ждут: ${stop.waiting.length}`
              : `Ждут выдачи: ${stop.waiting.length} · ничего не выдаётся`}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5 rounded-[9px] border border-bd bg-surf p-2">
        {wave.plans.length === 0 ? (
          <p className="m-0 px-1 py-1 text-[11.5px] text-tx3">Планов в этой волне нет.</p>
        ) : (
          wave.plans.map((plan) => (
            <PlanCard key={plan.path} plan={plan} onOpen={() => onOpenPlan(plan)} />
          ))
        )}
      </div>
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

/** «1 вопрос ждёт вас» / «2 вопроса ждут вас» — счётчик, который читается вслух. */
function questionsWaiting(n: number): string {
  const tail = n % 10
  const teen = n % 100
  if (tail === 1 && teen !== 11) return `${n} вопрос ждёт вас`
  if (tail >= 2 && tail <= 4 && (teen < 12 || teen > 14)) return `${n} вопроса ждут вас`
  return `${n} вопросов ждут вас`
}

/**
 * ЧТО ТРЕБУЕТСЯ ОТ ЧЕЛОВЕКА на каждых воротах — постоянная правила фазового цикла, не замер.
 *
 * Планирование стоит особняком: планировщик и проверяющий планов работают без человека, и это
 * сказано словами, чтобы отсутствие числа на этих воротах не читалось как «данные потерялись».
 */
const GATE_NEED = ['ответить на вопросы обсуждения', 'человек не требуется', 'ответить на вопросы исполнения']

/**
 * Отрезки ленты стадии — ТОЛЬКО там, где движок реально хранит шаги этой стадии.
 *
 * У планирования шагов нет: список планов — это количество документов, а не пройденный путь, и
 * нарисованная из него лента читалась бы как измеренная.
 */
function stageSegs(stage: PhaseStage, phase: PhaseCard, waves: PhaseWave[]): Tone[] {
  if (stage === 'discuss') return phase.questions.map((q) => (isOpen(q) ? 'dec' : 'ok'))
  if (stage === 'execute') {
    return waves.map((w) => {
      const done = w.plans.filter(planIsDone).length
      return done === w.plans.length && w.plans.length > 0 ? 'ok' : done > 0 ? 'run' : 'wait'
    })
  }
  if (stage === 'verify') {
    return phase.uat.map((u) => (u.verdict === 'pass' ? 'ok' : u.verdict === 'fail' ? 'fail' : 'wait'))
  }
  return []
}

export function PhaseCardView({
  id,
  onBack,
  backLabel = '← Все фазы',
  trail = [],
}: {
  id: string
  onBack: () => void
  /** Слово на кнопке возврата — оно называет место, откуда пришли, а не «назад вообще». */
  backLabel?: string
  /** Крошки предков: их даёт тот, кто открыл карточку, потому что только он знает путь. */
  trail?: PhaseCrumb[]
}) {
  const card = usePhaseQuery(id)
  const startStage = usePhaseStage()
  const answer = useDecisionAnswer()
  const uat = usePhaseUat()
  // Останов эшелона — факт ДВИЖКА, а не карточки фазы: он живёт в реестре, которому подчиняется
  // диспетчер, и приезжает сюда тем же рядом состояния, каким его читает окно разговора.
  const state = useStateQuery()

  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({})
  const [viewing, setViewing] = useState<PhaseArtifact | null>(null)
  const [stageProblem, setStageProblem] = useState<string | null>(null)
  const [answerProblem, setAnswerProblem] = useState<Record<string, string>>({})
  const [uatProblem, setUatProblem] = useState<Record<string, string>>({})
  /** Какую стадию человек раскрыл сам. `null` — ещё не выбирал, показываем ту, что идёт. */
  const [picked, setPicked] = useState<PhaseStage | null>(null)

  const phase = card.data
  const questions = phase?.questions ?? []
  const open = questions.filter(isOpen)
  const counts = progressOf(questions)

  // Процесс демона, поднятый до того, как карточка научилась отдавать волны, отвечает без них.
  // Это нормальное состояние, а не поломка: волны тогда честно пусты, и стадия исполнения
  // говорит об этом словами вместо того, чтобы собрать их из чего попало.
  const waves: PhaseWave[] = Array.isArray(phase?.waves) ? phase.waves : []
  const planCount = waves.reduce((n, w) => n + w.plans.length, 0)

  /**
   * Приказ об этой волне, если он есть. Карточка фазы читает планы С ДИСКА, а останов — факт
   * ОЧЕРЕДИ, поэтому он приезжает рядом состояния, а не этой же дверью: два ответа на «стоит ли
   * волна» разошлись бы в первую же секунду после нажатия.
   */
  const stopOf = (w: PhaseWave): WaveRow | undefined =>
    w.wave === null
      ? undefined
      : (state.data?.waves ?? []).find((r) => r.phase === String(id) && r.wave === String(w.wave))

  /**
   * Стадия на глазу: выбранная человеком, иначе та, на которой фаза стоит.
   *
   * ПРАВИЛО «ГДЕ СЕЙЧАС ФАЗА» ЖИВЁТ В ОДНОМ МЕСТЕ (`currentStage`) — им же считается «стадия N
   * из 4» в окошке показателей. Пока правил было два, число и раскрытая стадия могли назвать
   * разные стадии одной фазы, и человек читал бы это как ошибку экрана.
   */
  const stage: PhaseStage = picked ?? (phase ? currentStage(phase.stages) : STAGE_ORDER[0])

  /**
   * ФАЗА НЕ НАЗЫВАЕТ СЕБЯ ЗАКРЫТОЙ, ПОКА НЕ ЗАКРЫТЫ ПРОВЕРКА И ПРИЁМКА.
   *
   * Пройденные стадии исполнения — это не «фаза сделана»: правило закрытия требует стадии
   * проверки и одобренной приёмки, и пока хоть одно не выполнено, шапка говорит «не закрыта» и
   * называет, чего именно не хватает.
   */
  const uatPassed = phase ? phase.uat.filter((u) => u.verdict === 'pass').length : 0
  const verifyDone = phase?.stages.verify === 'done'
  const acceptanceClosed = !!phase && phase.uat.length > 0 && uatPassed === phase.uat.length
  const closed = !!verifyDone && acceptanceClosed
  const phaseWord = closed
    ? 'Закрыта'
    : counts.open > 0
      ? 'Не закрыта · ждёт решения'
      : phase && STAGE_ORDER.some((s) => phase.stages[s] === 'in-progress')
        ? 'Не закрыта · идёт'
        : 'Не закрыта'
  const phaseWhy = closed
    ? null
    : !verifyDone
      ? `стадия «${STAGE_LABEL.verify}» не пройдена`
      : phase && phase.uat.length === 0
        ? 'списка приёмки нет — приёмка не закрыта'
        : `приёмка: одобрено ${uatPassed} из ${phase?.uat.length ?? 0}`

  /**
   * О ЧЁМ ЭТА ФАЗА — словами ЕЁ СОБСТВЕННОГО ДОКУМЕНТА. Абзац и его источник приезжают дверью;
   * окно не пересказывает и не сокращает, а называет, откуда слова взяты: «из контекста фазы» и
   * «из роадмапа» — разные по весу утверждения.
   *
   * Нет ни того, ни другого — так и сказано словами. Пустое место на карточке читается как
   * «экран не дочитал», а фаза без описания — нормальное состояние, а не поломка.
   */
  const describe: { text: string; source: string | null } = phase?.description
    ? {
        text: phase.description.text,
        source:
          phase.description.source === 'context'
            ? 'из документа обсуждения этой фазы'
            : 'из роадмапа — своего документа обсуждения у фазы пока нет',
      }
    : {
        text: 'Описания нет: ни документа обсуждения, ни строки роадмапа про эту фазу окно не нашло.',
        source: null,
      }

  /**
   * Ворота, на которых стоит счётчик вопросов, — те, что за идущей стадией. Число вопросов у
   * двери одно на всю фазу: она не говорит, какая стадия его припарковала, и написать его на
   * всех воротах значило бы утроить его.
   */
  const runningIdx = phase ? STAGE_ORDER.findIndex((s) => phase.stages[s] === 'in-progress') : -1
  const countGate = counts.open > 0 ? Math.min(runningIdx < 0 ? 0 : runningIdx, GATE_NEED.length - 1) : -1

  /**
   * Путь: предки, потом сама фаза, потом открытый документ.
   *
   * ПОКА ОТКРЫТ ДОКУМЕНТ, КРОШКИ — АДРЕС, А НЕ РУЛЬ, и это не забывчивость. Документ читается
   * поверх карточки, за затемнением, которое ловит клики: так живая проверка и показала —
   * крошка под затемнением не нажимается вовсе. Кликабельная крошка, до которой нельзя
   * дотянуться, хуже некликабельной: она обещает дорогу, которой нет. Документ закрывается
   * своими тремя способами (крестик, Esc, клик по затемнению), и крошки снова становятся рулём.
   */
  const crumbs: PhaseCrumb[] = [
    ...trail.map((c) => (viewing ? { label: c.label } : c)),
    { label: phase?.name ?? 'Открываю…' },
    ...(viewing ? [{ label: viewing.name }] : []),
  ]

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
        <nav aria-label="Путь" className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px]">
          {crumbs.map((crumb, i) => (
            <span key={`${crumb.label}:${i}`} className="flex min-w-0 items-center gap-1.5">
              {crumb.onClick ? (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  className="max-w-[220px] truncate text-blue-d hover:underline"
                >
                  {crumb.label}
                </button>
              ) : (
                <span className="max-w-[360px] truncate font-semibold text-tx">{crumb.label}</span>
              )}
              {i < crumbs.length - 1 ? (
                <span aria-hidden className="text-tx3">
                  /
                </span>
              ) : null}
            </span>
          ))}
        </nav>
        {/* Живое время фазы — от первого взятия её задачи в работу. Закрытая фаза не тикает:
            растущее число на закрытой работе утверждает, что она всё ещё идёт. Открытые вопросы
            владельцу — это ожидание ЧЕЛОВЕКА, и чип говорит об этом цветом. */}
        <LiveTimer
          state={closed ? 'idle' : counts.open > 0 ? 'waiting' : 'running'}
          since={phase?.work?.startedAt ?? null}
        />
        <span
          className={`flex-none rounded-[8px] px-2.5 py-1 text-[11.5px] font-semibold ${
            closed ? 'bg-ok-s text-ok-tx' : counts.open > 0 ? 'bg-warn-s text-warn-tx' : 'bg-blue-s text-blue-d'
          }`}
        >
          {phaseWord}
        </span>
        <button
          type="button"
          onClick={onBack}
          className="flex-none rounded-[8px] border border-bd2 px-3 py-1.5 text-[12px] text-tx2 hover:text-tx"
        >
          {backLabel}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
        {card.isLoading ? <p className="m-0 text-[13px] text-tx2">Открываю фазу…</p> : null}
        {card.isError ? (
          <p className="m-0 text-[13px] text-err-tx">
            Фаза не открылась. Ничего с ней не случилось — попробуйте ещё раз.
          </p>
        ) : null}

        {phase ? (
          <div className="flex max-w-[1040px] flex-col gap-4">
            {/* Описание и показатели — пара, принятая владельцем 25.08. Строки-дубля с теми же
                числами под заголовком нет: числа живут в окошке, и только там. Почему фаза не
                закрыта, сказано ТАМ ЖЕ, рядом с числами, которые это объясняют. */}
            <EntitySummary
              describeTitle="Описание фазы"
              text={describe.text}
              source={describe.source}
              note={
                phaseWhy
                  ? `Фаза не закрыта: ${phaseWhy}. Пройденные стадии исполнения этого не отменяют.`
                  : null
              }
              stats={phaseStats(phase, Date.now())}
            />

            {/* Дорога фазы: стадия — ворота — стадия. Ворота называют, что требуется от вас. */}
            <div className="flex items-stretch">
              {STAGE_ORDER.map((s, i) => (
                <span key={s} className="flex min-w-0 flex-1 items-stretch">
                  <StageCard
                    stage={s}
                    index={i}
                    status={phase.stages[s]}
                    segs={stageSegs(s, phase, waves)}
                    picked={s === stage}
                    onPick={() => setPicked(s)}
                  />
                  {i < GATE_NEED.length ? (
                    <Gate
                      text={
                        i === countGate
                          ? questionsWaiting(counts.open)
                          : i === 0 && counts.open === 0 && counts.answered > 0
                            ? `вы ответили на ${counts.answered}`
                            : GATE_NEED[i]
                      }
                      tone={i === countGate ? 'dec' : phase.stages[STAGE_ORDER[i]] === 'done' ? 'ok' : 'wait'}
                    />
                  ) : null}
                </span>
              ))}
            </div>

            {/* ПАПКА ФАЗЫ — то, что фаза оставила на диске, без посредничества проекции. Стоит
                перед стадией, как в макете: сначала «что тут вообще есть», потом работа со
                стадией. Предпросмотр — текст и только текст. */}
            <PhaseFolderView id={id} />

            <Block
              title={`Стадия ${STAGE_ORDER.indexOf(stage) + 1} · ${STAGE_LABEL[stage]}`}
              note={STAGE_WHAT[stage]}
            >
              <div className="flex items-center gap-3 border-b border-bd px-4 py-2.5">
                <span className={`text-[11.5px] font-semibold ${TONE[STAGE_TONE[phase.stages[stage]]].word}`}>
                  {STATUS_WORD[phase.stages[stage]]}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => start(stage)}
                  disabled={phase.stages[stage] === 'in-progress' || startStage.isPending}
                  className="flex-none rounded-[9px] border border-bd2 px-[15px] py-1.5 text-[12px] font-semibold text-tx2 hover:border-blue hover:text-blue-d disabled:opacity-50"
                >
                  {phase.stages[stage] === 'in-progress'
                    ? 'Идёт'
                    : phase.stages[stage] === 'done'
                      ? 'Пройти заново'
                      : 'Запустить'}
                </button>
              </div>

              {stageProblem ? (
                <p className="m-0 border-b border-bd px-4 py-2.5 text-[12px] text-err-tx">{stageProblem}</p>
              ) : null}

              {stage === 'discuss' ? (
                <div className="flex flex-col gap-3 p-4">
                  <p className="m-0 text-[11.5px] text-tx3">
                    {questions.length === 0
                      ? 'вопросов не было'
                      : `${counts.open} открыто / ${counts.answered} отвечено`}
                  </p>
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
              ) : null}

              {stage === 'plan' ? (
                phase.plans.length === 0 ? (
                  <p className="m-0 px-4 py-3 text-[12.5px] text-tx2">
                    Планов пока нет — их пишет эта стадия.
                  </p>
                ) : (
                  <>
                    <p className="m-0 border-b border-bd px-4 py-2 text-[11.5px] text-tx3">
                      планов: {phase.plans.length} · открываются здесь же, читать в терминале не нужно
                    </p>
                    {phase.plans.map((a) => (
                      <ArtifactRow key={a.path} artifact={a} onOpen={() => setViewing(a)} />
                    ))}
                  </>
                )
              ) : null}

              {stage === 'execute' ? (
                <div className="flex flex-col gap-4 p-4">
                  <p className="m-0 text-[11.5px] text-tx3">
                    {waves.length === 0
                      ? `Волн не видно: карточка фазы их не назвала. Сами планы открываются на стадии «${STAGE_LABEL.plan}».`
                      : `волн: ${waves.length} · планов: ${planCount} · план открывается кликом`}
                  </p>
                  {waves.length > 0 ? (
                    <div className="flex flex-wrap items-start gap-3">
                      {waves.map((w) => (
                        <WaveColumn
                          key={w.wave === null ? 'без волны' : w.wave}
                          wave={w}
                          stop={stopOf(w)}
                          onOpenPlan={(plan) => setViewing(plan)}
                        />
                      ))}
                    </div>
                  ) : null}
                  {phase.summaries.length > 0 ? (
                    <div className="overflow-hidden rounded-[9px] border border-bd">
                      <p className="m-0 border-b border-bd bg-surf px-4 py-2 text-[11.5px] text-tx3">
                        итоги: {phase.summaries.length}
                      </p>
                      {phase.summaries.map((a) => (
                        <ArtifactRow key={a.path} artifact={a} onOpen={() => setViewing(a)} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {stage === 'verify' ? (
                phase.uat.length === 0 ? (
                  <p className="m-0 px-4 py-3 text-[12.5px] text-tx2">
                    Списка приёмки нет. Он появится, когда фаза дойдёт до проверки.
                  </p>
                ) : (
                  <>
                    <p className="m-0 border-b border-bd px-4 py-2 text-[11.5px] text-tx3">
                      пункт за пунктом, вашими словами · одобрено {uatPassed} из {phase.uat.length}
                    </p>
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
                )
              ) : null}
            </Block>
          </div>
        ) : null}
      </div>

      {viewing ? <ArtifactViewer artifact={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}
