import type {
  BatchItemState,
  BatchRow,
  BatchState,
  DoneRow,
  PhaseIndexRow,
  PhaseStage,
  PhaseStageStatus,
  QueueRow,
  WorkerRow,
} from '../../api/types'
import { plural } from '../../shell/format'

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
 * ═══════════════════════════ ТРИ ВИДА, ПОТОМУ ЧТО ИХ ТРИ ═════════════════════════════
 *
 * The design this screen is built from shows three kinds of work: ИНЛАЙН, БАТЧ and ФАЗА.
 * All three exist in the engine now and all three are built here:
 *   - ИНЛАЙН — one task on the queue, the thing «+ Новая задача» makes;
 *   - БАТЧ   — one order fanned out into several pieces and gathered back into one delivery;
 *   - ФАЗА   — one phase of the pipeline, whose four stages are read off its own directory.
 *
 * БАТЧ WAS ABSENT HERE UNTIL THE ENGINE GREW ONE, and that was the whole point: a kind painted
 * out of whatever was nearest reads exactly like a measured one, and the picture would have
 * been a drawing of an engine rather than a reading of one. It arrives now as a PROJECTION of
 * the row the daemon computes at every read (`batches[]`) — the request, its pieces with their
 * states, and the piece that is holding the assembly. Nothing about it is assembled here out of
 * loose tasks that merely look related, and an empty `batches[]` means no batch rows at all,
 * never an empty placeholder saying a batch might be somewhere.
 *
 * ══════════════════ ЭЛЕМЕНТ БАТЧА — НЕ СТРОКА ВЕРХНЕГО УРОВНЯ ═════════════════════════
 *
 * A piece of a batch is a real row of the queue, so it arrives in `queue`/`awaiting`/`done` and
 * on a worker — and it is deliberately NOT drawn as its own line. This list is «Задачи ·
 * верхний уровень»: one order of the owner is ONE unit of work, and its four pieces standing
 * next to it would count the same work twice, in the list and in every counter above it. The
 * pieces are read inside the batch, where they say what they are pieces OF.
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
 *
 * ═══════════════════════ ТРИ РАЗНЫХ ВОПРОСА О ВРЕМЕНИ ═══════════════════════
 *
 * Строка отвечает на один из них и никогда не подменяет его другим:
 *   - СКОЛЬКО ИДЁТ (последняя колонка) — от отметки захвата до сейчас у бегущей задачи, и
 *     от двух отметок закрывшего подхода у завершённой;
 *   - СКОЛЬКО ЖДЁТ (в предложении) — возраст ожидания у строки, которая никуда не идёт;
 *   - СКОЛЬКО НАЗАД БЫЛО СОБЫТИЕ (в предложении) — признак жизни, а не длительность.
 * Ни у одного из трёх нет ответа «0»: отсутствие отметки говорится прочерком или словами.
 */

/**
 * How a unit stands, in the words this window uses everywhere.
 *
 * ПОЧЕМУ СЛОВ СЕМЬ, А НЕ ПЯТЬ. Пять первых — про то, где работа стоит сама. Два последних
 * появились вместе с батчем и принадлежат не работе, а ВЛАДЕЛЬЦУ: «пропущен» — это его слово о
 * сломавшемся куске, «отменён» — его слово обо всей сборке. Ни то, ни другое не переводится в
 * пятёрку без вранья: пропущенный кусок, показанный «не начат», обещает работу, которой не
 * будет, а отменённая сборка, показанная «не получилось», обвиняет работника в решении
 * человека. Словарь окна растёт ровно настолько, насколько вырос словарь движка.
 */
export type UnitState = 'run' | 'dec' | 'ok' | 'wait' | 'fail' | 'skip' | 'off'

/** What a unit IS — all three kinds of the accepted design, now that the engine has all three. */
export type UnitKind = 'inline' | 'batch' | 'phase'

/** Where a click on a unit goes. */
export type UnitTarget =
  | { screen: 'task'; id: string }
  | { screen: 'batch'; id: string }
  | { screen: 'phase'; id: string }

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
  /**
   * ДВИЖЕТСЯ ЛИ ЧТО-ТО ПРЯМО СЕЙЧАС — только для пульса точки, и это не то же самое, что «Идёт».
   *
   * Фаза, у которой три стадии из четырёх пройдены, а четвёртая не запущена, идёт (она начата и
   * не закончена), но в эту секунду не движется НИЧЕГО. Пульсирующая точка — заявление о живом
   * движении, и ставить её там значило бы обещать работу, которой нет.
   */
  live: boolean
  target: UnitTarget
}

/** The words each state answers to, once, so no two rows disagree about what «ok» is called. */
export const STATE_WORD: Record<UnitState, string> = {
  run: 'Идёт',
  dec: 'Ждёт решения',
  ok: 'Готово',
  wait: 'Не начата',
  fail: 'Не получилось',
  skip: 'Пропущен',
  off: 'Отменён',
}

/** The kind badge, in the design's own words. */
export const KIND_WORD: Record<UnitKind, string> = {
  inline: 'ИНЛАЙН',
  batch: 'БАТЧ',
  phase: 'ФАЗА',
}

/**
 * Attention first, then movement, then the work that has not started, and the finished at the
 * bottom. A person opens this screen to find what is stuck on them, so what is stuck on them
 * cannot be below the fold.
 */
const RANK: Record<UnitState, number> = { dec: 0, run: 1, wait: 2, fail: 3, ok: 4, skip: 5, off: 6 }

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

/**
 * «6 ч 06 м» / «47 м» / «—» — ОДНА запись длительности на весь список.
 *
 * `—` там, где мерить нечего. Это не украшение: ноль в этой колонке человек читает как
 * «только что началась», то есть как утверждение о работе, а «нечего мерить» — это факт об
 * ОТСУТСТВИИ отметки. Поэтому отрицательная и нечисловая разница тоже дают прочерк, а не
 * подогнанный ноль.
 */
function spanLabel(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60000)
  const whole = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (whole === 0) return `${totalMinutes} м`
  return minutes > 0 ? `${whole} ч ${String(minutes).padStart(2, '0')} м` : `${whole} ч`
}

/**
 * СКОЛЬКО ЖДЁТ — та же длительность, но в предложении, а не в колонке: «41 мин», «6 ч».
 *
 * Возвращает `null`, когда очередь возраст не назвала. Очередь кладёт `agedForHours` ТОЛЬКО
 * на строку, которая ждёт дольше настроенного терпения, — то есть отсутствие поля означает
 * «ждёт немного», а не «ждёт ноль», и предложение тогда строится без числа вовсе.
 */
export function waitWords(hours: number | undefined): string | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return null
  if (hours < 1) return `${Math.round(hours * 60)} мин`
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
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
  /** Сборки, как их посчитал демон при этом же чтении состояния. Пусто — батчей нет. */
  batches: BatchRow[]
  phases: PhaseIndexRow[]
  /** The project selector in the shell; null means «every project». */
  activeProject: string | null
  /** The machine filter, empty when there is only one machine to tell apart. */
  machine: string
  selfMachine: string
  /** How a finished row's clock is spelled — borrowed from the shell so every screen agrees. */
  clock: (iso: string | null) => string
  /**
   * СЕЙЧАС, в миллисекундах — второй конец отрезка «идёт столько-то».
   *
   * Он приходит СНАРУЖИ, а не берётся здесь, потому что весь этот файл — чистая проекция:
   * функция, читающая часы внутри себя, даёт разный ответ на одних и тех же данных, и её
   * нельзя ни сравнить, ни проверить. Экран пересчитывает проекцию на каждом опросе состояния
   * и подставляет часы там.
   */
  now: number
}

/**
 * СКОЛЬКО ИДЁТ — от отметки захвата до «сейчас», и `null`, если отметки нет.
 *
 * Отметка захвата пережила продление аренды (очередь развела «когда взяли» и «когда
 * подтвердили жизнь» в два разных поля), поэтому у длинной живой попытки это по-прежнему часы,
 * а не секунды с последнего продления.
 */
function sinceClaim(claimedAt: number | null | undefined, now: number): number | null {
  if (typeof claimedAt !== 'number' || !Number.isFinite(claimedAt) || claimedAt <= 0) return null
  const ms = now - claimedAt
  return ms > 0 ? ms : null
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
  // «Не начата» принадлежит фазе, у которой не пройдено НИ ОДНОЙ стадии. Пройденная стадия —
  // это уже начало: живая проверка показала восемь фаз со словом «Не начата» и тремя закрытыми
  // стадиями в той же строке, и строка спорила сама с собой прямо на экране.
  const started = running || doneCount > 0
  const state: UnitState =
    row.open > 0 ? 'dec' : doneCount === STAGES.length ? 'ok' : started ? 'run' : 'wait'

  const answered = row.answered > 0 ? ` · отвечено вопросов: ${row.answered}` : ''
  const inner = `пройдено ${doneCount} из ${STAGES.length} стадий${answered}`
  const next =
    row.open > 0
      ? `Ждёт вас: ${row.open} ${row.open === 1 ? 'вопрос' : 'вопроса'} на стадиях фазы`
      : state === 'ok'
        ? 'Все четыре стадии пройдены'
        : running
          ? 'Стадия идёт — вопросов к вам нет'
          : started
            ? 'Ни одна стадия сейчас не запущена — фаза ждёт следующей'
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
    live: running,
    target: { screen: 'phase', id: row.id },
  }
}

/**
 * Слова сборки, переведённые в слова строки. Перевод, а не второе мнение: состояние куска
 * считает движок, здесь оно только называется на языке списка.
 */
export const BATCH_ITEM_TONE: Record<BatchItemState, UnitState> = {
  failed: 'fail',
  awaiting_decision: 'dec',
  running: 'run',
  waiting: 'wait',
  done: 'ok',
  skipped: 'skip',
}

const BATCH_TONE: Record<BatchState, UnitState> = { ...BATCH_ITEM_TONE, cancelled: 'off' }

/**
 * ЧТО ДЕРЖИТ СБОРКУ — состоянием держащего куска, потому что его состояние И ЕСТЬ причина.
 * Движок называет кусок; предложение здесь только произносит его состояние по-человечески.
 */
const HOLD_WORDS: Record<BatchItemState, string> = {
  failed: 'не получилось — сборка стоит и ждёт вашего слова',
  awaiting_decision: 'ждёт вашего решения',
  running: 'идёт',
  waiting: 'ещё не начат',
  done: 'закрыт',
  skipped: 'пропущен вашим решением',
}

/**
 * ОДИН ЗАПРОС ВЛАДЕЛЬЦА, РАЗОШЕДШИЙСЯ НА КУСКИ, — как одна строка списка.
 *
 * Чистая проекция ряда `batches[]`: ни одного собственного вопроса к демону и ни одного числа,
 * которого нет в ряду. Лента повторяет состояния кусков ПО ПОРЯДКУ — в том самом, в котором
 * очередь их выдаёт, — а не рисуется по их количеству: лента, собранная из числа элементов,
 * читается как замер и им не является.
 */
function batchUnit(row: BatchRow): WorkUnit {
  const items = row.items ?? []
  const n = items.length
  const closed = items.filter((i) => i.state === 'done').length
  const skipped = items.filter((i) => i.state === 'skipped').length
  const state = BATCH_TONE[row.state] ?? 'wait'
  const holding = row.holding

  const inner =
    n === 0
      ? 'элементов нет'
      : `${n} ${plural(n, 'элемент', 'элемента', 'элементов')} · закрыто ${closed} из ${n}${
          skipped > 0 ? ` · пропущено ${skipped}` : ''
        }`

  const next =
    row.state === 'cancelled'
      ? 'Сборка отменена вами — незапущенные элементы вынуты из очереди'
      : row.question
        ? `Ждёт вас: «${row.question.itemTitle ?? row.question.itemId}» не получилось — пропустить, повторить или отменить`
        : holding
          ? `Держит «${holding.title ?? holding.id}» — ${HOLD_WORDS[holding.state]}`
          : n === 0
            ? 'Постановка записана, а элементов у неё нет — держать сборку нечему'
            : 'Все элементы закрыты — сборка готова'

  return {
    id: row.id,
    kind: 'batch',
    title: row.title ?? 'Без названия',
    state,
    inner,
    next,
    // У СБОРКИ НЕТ СВОИХ ОТМЕТОК ВРЕМЕНИ: очередь мерит попытки кусков, а не батч, и сложить их
    // в одну длительность значило бы назвать работой и то время, что сборка просто ждала.
    // Прочерк — это отсутствие отметки, а не ноль.
    dur: '—',
    segs: items.map((i) => BATCH_ITEM_TONE[i.state] ?? 'wait'),
    live: items.some((i) => i.state === 'running'),
    target: { screen: 'batch', id: row.id },
  }
}

/**
 * A task waiting for a worker, or waiting for a person. Both ride the same row shape.
 *
 * ПОСЛЕДНЯЯ КОЛОНКА ОТВЕЧАЕТ НА ВОПРОС «СКОЛЬКО ИДЁТ», И ТОЛЬКО НА НЕГО. Ждущая строка не
 * идёт никуда, поэтому там прочерк, а возраст ожидания уезжает в предложение — туда, где он
 * и отвечает на свой собственный вопрос («ждёт вас 41 мин»). До этого в колонке длительности
 * стоял возраст ожидания, и строка, которой никто не занимался, читалась как работающая час.
 */
function queueUnit(row: QueueRow, awaiting: boolean): WorkUnit {
  const idle = row.idleReason ? IDLE_WORDS[row.idleReason] : null
  const waited = waitWords(row.agedForHours)
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
      ? waited
        ? `Ждёт вас ${waited}: открыть и принять или вернуть с комментарием`
        : 'Ждёт вас: открыть и принять или вернуть с комментарием'
      : waited
        ? `${idle ?? 'Ждёт свободного работника'} · ждёт ${waited}`
        : (idle ?? 'Ждёт свободного работника'),
    dur: '—',
    segs: [],
    live: false,
    target: { screen: 'task', id: row.id },
  }
}

/**
 * The work in flight. The roster is the ONLY list that names a claimed task, so a running
 * unit is built from the worker holding it — never sifted out of the queue, which never
 * carried a claimed row and answers «пусто» to anyone who asks it for one.
 */
function runningUnit(worker: WorkerRow, now: number): WorkUnit {
  const pulse = pulseLabel(worker.pulseAgeSec)
  const running = sinceClaim(worker.taskClaimedAt, now)
  return {
    id: worker.taskId as string,
    kind: 'inline',
    title: worker.taskTitle ?? 'Без названия',
    state: 'run',
    // Отметки захвата у ростера может не быть (строка, взятая процессом старее самого поля).
    // Тогда это говорится словами прямо в строке: «нет данных» — это ответ, а не пустое место.
    inner: running === null ? `в работе у «${worker.id}» · когда взяли — нет данных` : `в работе у «${worker.id}»`,
    next: pulse ? `Идёт: ${pulse}` : 'Идёт — работник ещё не подал признака жизни',
    dur: spanLabel(running),
    segs: [],
    live: true,
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
    // Длительность закрытой задачи меряется по подходу, который её ЗАКРЫЛ: между попытками
    // задача лежит в очереди, и называть это время работой было бы неправдой. Одной отметки
    // мало — очередь тогда отвечает «нечего мерить», и это прочерк, а не ноль.
    dur: spanLabel(row.finishedDuration),
    segs,
    live: false,
    target: { screen: 'task', id: row.id },
  }
}

/**
 * РАЗДЕЛИТЬ СТРОКИ НА «ЭТОГО ПРОЕКТА» И «ПРОЕКТ НЕИЗВЕСТЕН» — и не потерять вторые.
 *
 * Дверь больше не домысливает принадлежность: строка, которая своего проекта не называет,
 * приходит с `project: null`. Прежний фильтр `r.project === activeProject` такую строку молча
 * выбрасывал — и работа, которую видел человек до этой правки, исчезала бы с экрана.
 *
 * Здесь два исхода, и оба честные. `mine` — строки, которые проект назвали, и это он. `unknown` —
 * строки, которые не назвали никакого: их поставили раньше, чем задача вообще научилась знать
 * свой проект. Приписать их текущему — выдуманная принадлежность; спрятать — невидимая работа.
 * Поэтому они едут отдельной группой и называются словами.
 *
 * Когда проект не выбран, отличать нечего: сужения нет, всё идёт одним списком.
 */
export function splitByProject<T extends { project?: string | null }>(
  rows: T[],
  activeProject: string | null,
): { mine: T[]; unknown: T[] } {
  if (!activeProject) return { mine: [...rows], unknown: [] }
  const mine: T[] = []
  const unknown: T[] = []
  for (const r of rows) {
    if (r.project == null || r.project === '') unknown.push(r)
    else if (r.project === activeProject) mine.push(r)
  }
  return { mine, unknown }
}

/**
 * Every unit of work the window can see right now, in the order a person reads them.
 *
 * Both filters — project and machine — are a sieve over rows already in hand, never a
 * narrower question asked of the daemon.
 *
 * Сито проекта остаётся здесь и после того, как дверь научилась сужать сама: две проверки одной
 * правды дешевле, чем одна, а строку чужого проекта, доехавшую сюда по любой причине, экран
 * показывать не должен. Строки без проекта это сито отбрасывает — их собирает `splitByProject`
 * и показывает отдельной группой.
 */
export function buildUnits(input: UnitsInput): WorkUnit[] {
  const { activeProject, machine, selfMachine } = input
  const mine = <T extends { project?: string | null; machine: string }>(rows: T[]): T[] =>
    rows.filter((r) => (!activeProject || r.project === activeProject) && (!machine || r.machine === machine))

  const batches = input.batches ?? []
  // КУСКИ СБОРКИ ЧИТАЮТСЯ ВНУТРИ НЕЁ, а не рядом с ней. Сито строится по ВСЕМ сборкам, а не
  // только по видимым: кусок носит проект своей сборки, поэтому вместе с ней он и так уходит
  // из-под фильтра — а строится сито до фильтра, чтобы кусок никогда не остался в списке
  // сиротой, чья сборка отсеялась.
  const inBatch = new Set<string>()
  for (const b of batches) for (const i of b.items ?? []) inBatch.add(i.id)
  const loose = <T extends { id: string }>(rows: T[]): T[] => rows.filter((r) => !inBatch.has(r.id))

  const running = input.workers
    .filter(
      (w) =>
        !!w.taskId &&
        !inBatch.has(w.taskId) &&
        (!activeProject || w.project === activeProject) &&
        (!machine || (w.machine ?? selfMachine) === machine),
    )
    .map((w) => runningUnit(w, input.now))

  const units: WorkUnit[] = [
    // Phases are not filtered by machine: a phase belongs to the project, not to a machine.
    ...input.phases.map(phaseUnit),
    ...mine(batches).map(batchUnit),
    ...loose(mine(input.awaiting)).map((r) => queueUnit(r, true)),
    ...running,
    ...loose(mine(input.queue)).map((r) => queueUnit(r, false)),
    ...loose(mine(input.done)).map((r) => doneUnit(r, input.clock)),
  ]

  return units.sort((a, b) => RANK[a.state] - RANK[b.state])
}

/** The figures over the list, counted off the units themselves so they cannot disagree. */
export function countUnits(units: WorkUnit[]): Record<UnitState, number> {
  const out: Record<UnitState, number> = { run: 0, dec: 0, ok: 0, wait: 0, fail: 0, skip: 0, off: 0 }
  for (const u of units) out[u.state] += 1
  return out
}
