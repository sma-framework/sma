import type { DoneRow, PhaseIndexRow, PhaseStage, PhaseStageStatus, QueueRow, WorkerRow } from '../../api/types'

/**
 * units — «единица работы» as this screen means it, and the ONE place a reading of the
 * daemon becomes one.
 *
 * ═══════════════════ THE LIST IS A PROJECTION, NEVER A SECOND TRUTH ═══════════════════
 *
 * Every unit below is built from readings the window ALREADY holds — the state payload and
 * the phase index — and nothing here asks the daemon a question of its own. A list that asks
 * its own question is a second version of the truth, and the first day the two disagree is
 * the day the list stops being read.
 *
 * ═══════════════════════════ TWO KINDS, BECAUSE THERE ARE TWO ═════════════════════════
 *
 * The design this screen is built from shows three kinds of work: ИНЛАЙН, БАТЧ and ФАЗА.
 * Two of them exist in the engine and are built here:
 *   - ИНЛАЙН — one task on the queue, the thing «+ Новая задача» makes;
 *   - ФАЗА   — one phase of the pipeline, whose four stages are read off its own directory.
 * БАТЧ — one order fanned out into several backlog items and gathered back into one delivery —
 * has NO representation in the engine at all: no parent, no children, no gathering. It is
 * therefore NOT built here from something that merely resembles it. A kind painted out of
 * whatever was nearest is the failure this product spends its days undoing: the picture would
 * be a drawing of an engine rather than a reading of one. When batches exist, they arrive here
 * as a third kind and the row shape already carries them.
 *
 * ════════════════════════════ WHAT A RIBBON IS ALLOWED TO SAY ═════════════════════════
 *
 * The ribbon of segments is drawn ONLY where the system really keeps steps:
 *   - a phase has four stages, and each stage's status is read off the artefacts on disk;
 *   - a finished task has its attempts, and an attempt after the first means the one before
 *     it did not finish the work.
 * An inline task in flight has no steps in the engine — so it gets no ribbon, and the row
 * says what it does know instead. An invented ribbon reads exactly like a measured one, which
 * is why there is no path here for a segment that nothing measured.
 */

/** How a unit stands, in the five words this window uses everywhere. */
export type UnitState = 'run' | 'dec' | 'ok' | 'wait' | 'fail'

/** What a unit IS. The third kind (batch) joins this union when the engine grows one. */
export type UnitKind = 'inline' | 'phase'

/** Where a click on a unit goes. */
export type UnitTarget = { screen: 'task'; id: string } | { screen: 'phase'; id: string }

export interface WorkUnit {
  id: string
  kind: UnitKind
  title: string
  state: UnitState
  /** The second line: what this unit is MADE of, counted rather than guessed. */
  inner: string
  /** What happens next, or what it is waiting for — the sentence a person reads first. */
  next: string
  /** How long, when the reading carries a length. «—» when it does not, never a zero. */
  dur: string
  /** The step ribbon, empty when nothing measured any steps. */
  segs: UnitState[]
  target: UnitTarget
}

/** The words each state answers to, once, so no two rows disagree about what «ok» is called. */
export const STATE_WORD: Record<UnitState, string> = {
  run: 'Идёт',
  dec: 'Ждёт решения',
  ok: 'Готово',
  wait: 'Не начата',
  fail: 'Не получилось',
}

/** The kind badge, in the design's own words. */
export const KIND_WORD: Record<UnitKind, string> = {
  inline: 'ИНЛАЙН',
  phase: 'ФАЗА',
}

/**
 * Attention first, then movement, then the work that has not started, and the finished at the
 * bottom. A person opens this screen to find what is stuck on them, so what is stuck on them
 * cannot be below the fold.
 */
const RANK: Record<UnitState, number> = { dec: 0, run: 1, wait: 2, fail: 3, ok: 4 }

/** The four stages in the order a phase goes through them. */
const STAGES: PhaseStage[] = ['discuss', 'plan', 'execute', 'verify']

/** A stage's status in the vocabulary of this screen. */
const STAGE_STATE: Record<PhaseStageStatus, UnitState> = {
  none: 'wait',
  'in-progress': 'run',
  done: 'ok',
}

/**
 * WHY a queued task is not moving, in the founder's language. The daemon derives the code
 * from the same facts the tick runs on; this map only turns it into a sentence.
 */
const IDLE_WORDS: Record<string, string> = {
  pipeline_off: 'Конвейер выключен — задача не начнётся, пока не включите тумблер',
  windows_closed: 'Все окна подписок закрыты — ждёт окна (платный канал не настроен)',
  budget_stop: 'Платный канал исчерпан на месяц — ждёт окна подписки',
}

/** «6 ч 06 м» from a count of hours the daemon already waited out. */
function hoursLabel(hours: number | undefined): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return '—'
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
  if (whole === 0) return `${minutes} м`
  return minutes > 0 ? `${whole} ч ${String(minutes).padStart(2, '0')} м` : `${whole} ч`
}

/** «событие 12 с назад» — the one sign of life a running row carries. */
function pulseLabel(sec: number | undefined): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return null
  if (sec < 60) return `событие ${Math.round(sec)} с назад`
  const min = Math.floor(sec / 60)
  if (min < 60) return `событие ${min} мин назад`
  return `событие ${Math.floor(min / 60)} ч назад`
}

export interface UnitsInput {
  queue: QueueRow[]
  awaiting: QueueRow[]
  workers: WorkerRow[]
  done: DoneRow[]
  phases: PhaseIndexRow[]
  /** The project selector in the shell; null means «every project». */
  activeProject: string | null
  /** The machine filter, empty when there is only one machine to tell apart. */
  machine: string
  selfMachine: string
  /** How a finished row's clock is spelled — borrowed from the shell so every screen agrees. */
  clock: (iso: string | null) => string
}

/**
 * One phase of the pipeline as a unit of work.
 *
 * A phase that parked a question for a person is `dec` NO MATTER what its stages are doing —
 * the whole point of the row is that the person is the thing it is waiting for.
 */
function phaseUnit(row: PhaseIndexRow): WorkUnit {
  const segs = STAGES.map((s) => STAGE_STATE[row.stages[s]])
  const doneCount = segs.filter((s) => s === 'ok').length
  const running = segs.some((s) => s === 'run')
  const state: UnitState = row.open > 0 ? 'dec' : doneCount === STAGES.length ? 'ok' : running ? 'run' : 'wait'

  const answered = row.answered > 0 ? ` · отвечено вопросов: ${row.answered}` : ''
  const inner = `пройдено ${doneCount} из ${STAGES.length} стадий${answered}`
  const next =
    row.open > 0
      ? `Ждёт вас: ${row.open} ${row.open === 1 ? 'вопрос' : 'вопроса'} на стадиях фазы`
      : state === 'ok'
        ? 'Все четыре стадии пройдены'
        : running
          ? 'Стадия идёт — вопросов к вам нет'
          : 'Не начата'

  return {
    id: row.id,
    kind: 'phase',
    title: row.name,
    state,
    inner,
    next,
    dur: '—',
    segs,
    target: { screen: 'phase', id: row.id },
  }
}

/** A task waiting for a worker, or waiting for a person. Both ride the same row shape. */
function queueUnit(row: QueueRow, awaiting: boolean): WorkUnit {
  const idle = row.idleReason ? IDLE_WORDS[row.idleReason] : null
  return {
    id: row.id,
    kind: 'inline',
    title: row.title ?? 'Без названия',
    state: awaiting ? 'dec' : 'wait',
    inner: awaiting
      ? 'ждёт вашего решения'
      : row.status === 'returned'
        ? 'возвращена вами'
        : `в очереди · место ${row.position}`,
    next: awaiting
      ? 'Открыть и принять или вернуть с комментарием'
      : (idle ?? 'Ждёт свободного работника'),
    dur: hoursLabel(row.agedForHours),
    segs: [],
    target: { screen: 'task', id: row.id },
  }
}

/**
 * The work in flight. The roster is the ONLY list that names a claimed task, so a running
 * unit is built from the worker holding it — never sifted out of the queue, which never
 * carried a claimed row and answers «пусто» to anyone who asks it for one.
 */
function runningUnit(worker: WorkerRow): WorkUnit {
  const pulse = pulseLabel(worker.pulseAgeSec)
  return {
    id: worker.taskId as string,
    kind: 'inline',
    title: worker.taskTitle ?? 'Без названия',
    state: 'run',
    inner: `в работе у «${worker.id}»`,
    next: pulse ? `Идёт: ${pulse}` : 'Идёт — работник ещё не подал признака жизни',
    dur: '—',
    segs: [],
    target: { screen: 'task', id: worker.taskId as string },
  }
}

/** A finished task: its attempts are the only steps this engine really kept. */
function doneUnit(row: DoneRow, clock: (iso: string | null) => string): WorkUnit {
  const failed = !!row.failed
  const attempts = Number.isFinite(row.attempts) && row.attempts > 0 ? row.attempts : 1
  // An attempt after the first exists BECAUSE the one before it did not finish the work.
  const segs: UnitState[] = Array.from({ length: attempts }, (_, i) =>
    i === attempts - 1 ? (failed ? 'fail' : 'ok') : 'fail',
  )
  const commits = row.commits?.length ?? 0
  return {
    id: row.id,
    kind: 'inline',
    title: row.title ?? 'Без названия',
    state: failed ? 'fail' : 'ok',
    inner: `${attempts} ${attempts === 1 ? 'подход' : 'подхода'} · ${commits === 0 ? 'без коммитов' : `коммитов: ${commits}`}`,
    next: failed
      ? (row.failed?.reasonLabel ?? 'Не получилось — причина не записана')
      : `Закрыта в ${clock(row.finishedAt)}`,
    dur: '—',
    segs,
    target: { screen: 'task', id: row.id },
  }
}

/**
 * Every unit of work the window can see right now, in the order a person reads them.
 *
 * Both filters — project and machine — are a sieve over rows already in hand, never a
 * narrower question asked of the daemon.
 */
export function buildUnits(input: UnitsInput): WorkUnit[] {
  const { activeProject, machine, selfMachine } = input
  const mine = <T extends { project: string; machine: string }>(rows: T[]): T[] =>
    rows.filter((r) => (!activeProject || r.project === activeProject) && (!machine || r.machine === machine))

  const running = input.workers
    .filter(
      (w) =>
        !!w.taskId &&
        (!activeProject || w.project === activeProject) &&
        (!machine || (w.machine ?? selfMachine) === machine),
    )
    .map(runningUnit)

  const units: WorkUnit[] = [
    // Phases are not filtered by machine: a phase belongs to the project, not to a machine.
    ...input.phases.map(phaseUnit),
    ...mine(input.awaiting).map((r) => queueUnit(r, true)),
    ...running,
    ...mine(input.queue).map((r) => queueUnit(r, false)),
    ...mine(input.done).map((r) => doneUnit(r, input.clock)),
  ]

  return units.sort((a, b) => RANK[a.state] - RANK[b.state])
}

/** The four figures over the list, counted off the units themselves so they cannot disagree. */
export function countUnits(units: WorkUnit[]): { run: number; dec: number; ok: number; wait: number; fail: number } {
  const out = { run: 0, dec: 0, ok: 0, wait: 0, fail: 0 }
  for (const u of units) out[u.state] += 1
  return out
}
