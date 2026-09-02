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
 * ПОЧЕМУ СЛОВ ВОСЕМЬ, А НЕ ПЯТЬ. Пять первых — про то, где работа стоит сама. Два появились
 * вместе с батчем и принадлежат не работе, а ВЛАДЕЛЬЦУ: «пропущен» — это его слово о
 * сломавшемся куске, «отменён» — его слово обо всей сборке. Ни то, ни другое не переводится в
 * пятёрку без вранья: пропущенный кусок, показанный «не начат», обещает работу, которой не
 * будет, а отменённая сборка, показанная «не получилось», обвиняет работника в решении
 * человека. Словарь окна растёт ровно настолько, насколько вырос словарь движка.
 *
 * ВОСЬМОЕ — «НА ПАУЗЕ», И ОНО ОТДЕЛЯЕТ ДВИЖЕНИЕ ОТ НАЧАТОСТИ. Пока слов было семь, «Идёт»
 * означало у фазы «начата и не закончена», и фаза с тремя пройденными стадиями и ни одной
 * запущенной носила его — рядом с собственным предложением «Ни одна стадия сейчас не
 * запущена». Строка спорила сама с собой в одном кадре, и никакой оттенок этого не лечит:
 * два ответа на один вопрос лечатся вторым словом, а не вторым цветом.
 */
export type UnitState = 'run' | 'pause' | 'dec' | 'ok' | 'wait' | 'fail' | 'skip' | 'off'

/** What a unit IS — all three kinds of the accepted design, now that the engine has all three. */
export type UnitKind = 'inline' | 'batch' | 'phase'

/**
 * ЧТО ИМЕННО ЖДЁТ ЧЕЛОВЕКА — и что он может с этим сделать, словами.
 *
 * Стоит ТОЛЬКО на единице в состоянии `dec`: это единственное состояние, про которое известно,
 * что работа лежит на человеке. Три поля отвечают на три разных вопроса — «сколько ждёт»,
 * «что случилось» и «что теперь» — и ни одно не подменяет другое.
 *
 * `age` пуст, когда возраста никто не мерил: очередь кладёт его только строке, ждущей дольше
 * настроенного терпения, и «0 мин» здесь читалось бы как измерение, которого не делали.
 */
export interface WaitWords {
  /** «41 МИН» / «6 Ч» — голосом столбика. Пусто, когда чтение возраста не несёт. */
  age: string
  /** ЧТО ждёт: одно предложение о том, почему работа стоит на человеке. */
  what: string
  /** ЧТО сделать — призыв, а не кнопка: карточка ОТКРЫВАЕТСЯ, решение принимается внутри неё. */
  cta: string
}

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
  /**
   * Слова ожидания — только у `dec`-единицы, и `undefined` у всех остальных.
   *
   * Это не второе мнение о состоянии, а его развёрнутая речь для столбика «ЖДУТ ВАС»: единица,
   * которая на человеке НЕ стоит, этих слов не имеет вовсе, поэтому янтарную карточку нельзя
   * нарисовать там, где никто никого не ждёт.
   */
  wait?: WaitWords
  target: UnitTarget
}

/** The words each state answers to, once, so no two rows disagree about what «ok» is called. */
export const STATE_WORD: Record<UnitState, string> = {
  run: 'Идёт',
  // «Начата и стоит»: работа позади есть, а сейчас не движется НИЧЕГО. Ровно то, о чём говорит
  // непульсирующая точка рядом, — теперь об этом говорит и слово.
  pause: 'На паузе',
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
const RANK: Record<UnitState, number> = { dec: 0, run: 1, pause: 2, wait: 3, fail: 4, ok: 5, skip: 6, off: 7 }

/** The stages in the order a phase goes through them. */
const STAGES: PhaseStage[] = ['discuss', 'plan', 'design', 'execute', 'verify']

/** A stage's status in the vocabulary of this screen. */
const STAGE_STATE: Record<PhaseStageStatus, UnitState> = {
  none: 'wait',
  'in-progress': 'run',
  done: 'ok',
  // фаза старше самой ступени: её ждать не надо и «готово» о ней сказать нельзя
  skipped: 'skip',
}

/**
 * WHY a queued task is not moving, in the founder's language. The daemon derives the code
 * from the same facts the tick runs on; this map only turns it into a sentence.
 */
const IDLE_WORDS: Record<string, string> = {
  pipeline_off: 'Конвейер выключен — задача не начнётся, пока не включите тумблер',
  windows_closed: 'Все окна подписок закрыты — ждёт окна (платный канал не настроен)',
  budget_stop: 'Платный канал исчерпан на месяц — ждёт окна подписки',
  // Запасные слова: состав удержания приезжает отдельным полем и говорит точнее — но код
  // причины без состава (строка старее поля) обязан оставаться предложением, а не пустотой.
  files_busy: 'Её файлы заняты идущей работой — пойдёт следующей, а не одновременно',
}

/** Сколько путей называется в строке. Остальные названы числом, а не отброшены молча. */
const HELD_FILES_SHOWN = 2

/**
 * heldWords(held) → «Ждёт файла: … — его держит «…»» или `null`, когда никто ничего не держит.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНОЕ ПРЕДЛОЖЕНИЕ, А НЕ ЯРЛЫК. Очередь придерживает работу, чьи объявленные
 * файлы уже заняты идущей: две работы про один файл — это не «параллельно», а «последовательно
 * с ручным разводом в конце». Но человек, читающий «в очереди · место 3» при свободных
 * работниках, идёт искать поломку там, где её нет. Названные файл и держатель отвечают сразу
 * на оба вопроса — почему стоит и когда пойдёт: как только освободится названная работа.
 */
function heldWords(held: QueueRow['heldBy']): string | null {
  const files = held?.files ?? []
  if (files.length === 0) return null
  const shown = files.slice(0, HELD_FILES_SHOWN).join(' · ')
  const rest = files.length - Math.min(files.length, HELD_FILES_SHOWN)
  const first = held?.holders?.[0]
  const who = first ? `«${first.title ?? first.id}»` : 'идущая работа'
  const more = (held?.holders?.length ?? 0) - 1
  return (
    `Ждёт своей очереди к файлам: ${shown}${rest ? ` … ещё ${rest}` : ''} — ` +
    `их держит ${who}${more > 0 ? ` и ещё ${more}` : ''}`
  )
}

/**
 * «6 ч 06 м» / «47 м» / «—» — ОДНА запись длительности на весь список.
 *
 * `—` там, где мерить нечего. Это не украшение: ноль в этой колонке человек читает как
 * «только что началась», то есть как утверждение о работе, а «нечего мерить» — это факт об
 * ОТСУТСТВИИ отметки. Поэтому отрицательная и нечисловая разница тоже дают прочерк, а не
 * подогнанный ноль.
 */
export function spanLabel(ms: number | null | undefined): string {
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

/**
 * «41 МИН» / «6 Ч» — тот же возраст ожидания, но голосом янтарной карточки: покрупнее и
 * покороче, потому что в столбике он стоит первым и читается раньше имени.
 *
 * Пустая строка — это «возраста никто не назвал», и карточка тогда не пишет его вовсе. Ноль
 * здесь был бы утверждением «ждёт нисколько», которого никто не измерял.
 */
export function ageLabel(hours: number | undefined): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return ''
  if (hours < 1) return `${Math.round(hours * 60)} МИН`
  return `${Math.floor(hours)} Ч`
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
 *
 * ═══════════ ТРИ ИСТОЧНИКА О ГОТОВНОСТИ, И НИ ОДИН НЕ ВЫИГРЫВАЕТ МОЛЧА ═══════════
 *
 * О том, закрыта ли фаза, говорят трое: ДИСК (артефакты стадий — замер), РОАДМАП (галочка
 * человека — его слово о работе целиком) и ОЧЕРЕДЬ (запущено ли что-то прямо сейчас). Раньше
 * строка знала двоих и мешала их в одно слово; отсюда обе жалобы этой карточки:
 *
 *   — «ИДЁТ» ОЗНАЧАЛО «НАЧАТА», а не «движется», и стояло над собственным предложением «Ни
 *     одна стадия сейчас не запущена». Теперь движение — это `running`, и только оно; начатая,
 *     но никуда не идущая фаза называется «На паузе», ровно как и выглядит её мёртвая точка.
 *
 *   — ГАЛОЧКА РОАДМАПА ДО КАРТОЧКИ НЕ ДОЕЗЖАЛА. Фаза, закрытая человеком до появления ступеней
 *     или чужим инструментом, показывалась незавершённой НАВСЕГДА: документа, которого никто не
 *     напишет, диск не дождётся. Теперь галочка закрывает фазу — и расхождение с диском
 *     НАЗЫВАЕТСЯ СЛОВАМИ прямо на строке. Молча предпочесть один источник другому значит
 *     спрятать спор, а не разрешить его: человек имеет право видеть, что слово о закрытии —
 *     из роадмапа, а числа — с диска.
 *
 * ВОПРОС ГАЛОЧКОЙ НЕ ЗАКРЫВАЕТСЯ. Открытый вопрос задан ЧЕЛОВЕКУ и никем не отвечен; крестик в
 * другом файле — это слово о работе, а не ответ на вопрос. Поэтому `dec` по-прежнему первый.
 */
function phaseUnit(row: PhaseIndexRow): WorkUnit {
  const segs = STAGES.map((s) => STAGE_STATE[row.stages[s]])
  const doneCount = segs.filter((s) => s === 'ok').length
  // ДАЛЬШЕ ЭТА СТАДИЯ НЕ ПОЙДЁТ — пройдена ИЛИ пропущена, и по этому числу фаза называется
  // закрытой. Ступень рисования появилась позже, чем начались работы, и у старой фазы её не
  // будет никогда: счёт, знающий одно слово «пройдена», держал бы каждую закрытую фазу дома в
  // «идёт» вечно — ждущей чертежа, которого никто не нарисует.
  const settledCount = segs.filter((s) => s === 'ok' || s === 'skip').length
  const running = segs.some((s) => s === 'run')
  // «Не начата» принадлежит фазе, у которой не пройдено НИ ОДНОЙ стадии. Пройденная стадия —
  // это уже начало: живая проверка показала восемь фаз со словом «Не начата» и тремя закрытыми
  // стадиями в той же строке, и строка спорила сама с собой прямо на экране.
  const started = running || doneCount > 0
  const closedOnDisk = settledCount === STAGES.length
  // Молчание двери — это «галочки не стоит»: демон старее самого поля отвечает без него, и
  // объявить закрытым то, о чём никто ничего не сказал, было бы выдумкой, а не чтением.
  const closedInRoadmap = row.roadmapClosed === true
  const disagreement = closedInRoadmap && !closedOnDisk
  const state: UnitState =
    row.open > 0
      ? 'dec'
      : closedOnDisk || closedInRoadmap
        ? 'ok'
        : running
          ? 'run'
          : started
            ? 'pause'
            : 'wait'

  const answered = row.answered > 0 ? ` · отвечено вопросов: ${row.answered}` : ''
  // ЧИСЛО СТАДИЙ НИГДЕ НЕ НАПИСАНО ЦИФРОЙ — оно считается по списку. Слово «четыре» стояло тут
  // словом и разошлось с дорогой ровно в тот день, когда дорога стала длиннее.
  //
  // При расхождении состав называет ОБА источника: «закрыта» без «на диске столько-то» было бы
  // тем же спором, только спрятанным.
  const inner = disagreement
    ? `закрыта в роадмапе · на диске пройдено ${doneCount} из ${STAGES.length} стадий${answered}`
    : `пройдено ${doneCount} из ${STAGES.length} стадий${answered}`
  const next =
    row.open > 0
      ? `Ждёт вас: ${row.open} ${row.open === 1 ? 'вопрос' : 'вопроса'} на стадиях фазы`
      : disagreement
        ? `Закрыта в роадмапе, а диск этого не подтверждает: пройдено ${doneCount} из ${STAGES.length}. Слово о закрытии — из роадмапа, числа — с диска.`
        : state === 'ok'
          ? 'Все стадии пройдены'
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
    // Возраста вопроса фазы указатель не называет — поэтому в карточке его нет вовсе, а не
    // «0 мин». Слова же о том, ЧТО ждёт, у фазы есть: их считает сама дверь.
    wait:
      row.open > 0
        ? {
            age: '',
            what: `${row.open} ${plural(row.open, 'вопрос', 'вопроса', 'вопросов')} к вам на стадиях фазы — без ответа фаза дальше не пойдёт`,
            cta: 'Ответить на вопросы →',
          }
        : undefined,
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
    // Слово сборки принадлежит владельцу и произносится ВНУТРИ неё: столбик называет, что
    // именно встало, и зовёт открыть, а «пропустить · повторить · бросить» — это уже три
    // разных решения, и нажимаются они на карточке, где видно, о чём они.
    //
    // СОРВАВШАЯСЯ СБОРКА ЖДЁТ ТАК ЖЕ, КАК СПРОСИВШАЯ. Движок называет её `failed`, а вопроса
    // при ней может не быть вовсе — и до этой строки такая сборка молча уходила в «Готово»
    // вместе со всеми своими невыданными элементами. Живая мера 31.08: сборка из девяти работ
    // стояла закрытой на первой упавшей, восемь остальных очередь не выдавала, и человек читал
    // это как готовую работу. Ждёт она человека одинаково — стоит и одинаково.
    wait:
      state === 'dec' || state === 'fail'
        ? {
            age: '',
            what: row.question
              ? `«${row.question.itemTitle ?? row.question.itemId}» не получилось — сборка стоит на этом элементе`
              : holding
                ? `Сборка стоит: «${holding.title ?? holding.id}» ${HOLD_WORDS[holding.state]}`
                : 'Сборка ждёт вашего решения',
            cta: 'Открыть: пропустить · повторить · бросить →',
          }
        : undefined,
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
  // СОСТАВ УДЕРЖАНИЯ ГОВОРИТ ТОЧНЕЕ КОДА ПРИЧИНЫ — но только там, где дверь назвала причиной
  // именно его. Приоритет уже разрешён у двери: при выключенном конвейере стоит ВСЯ очередь, и
  // «ждёт файла» поверх этого было бы правдой, отвечающей не на тот вопрос. Второе мнение об
  // этом здесь разошлось бы с первым в первый же день.
  const held = row.idleReason === 'files_busy' ? heldWords(row.heldBy) : null
  const idle = held ?? (row.idleReason ? IDLE_WORDS[row.idleReason] : null)
  const waited = waitWords(row.agedForHours)
  // ЧЕМ ЭТА РАБОТА ОБЪЯВЛЕНА — И ЧТО ЕЙ ЗА ЭТО ДОСТАНЕТСЯ. Строка без единого признака успеха
  // объявлена мелкой и уйдёт в процесс с базовым потолком ходов; число считает дверь (своё
  // здесь было бы вторым мнением о том, с чем работник уйдёт в процесс), а окно ставит его в ту
  // же строчку, где стоит место в очереди, — потому что это ровно тот миг, когда обещание ещё
  // можно дописать одним нажатием.
  const promiseless = row.noPromise ? `без обещания: потолок ${row.noPromise.cap}` : null
  return {
    id: row.id,
    kind: 'inline',
    title: row.title ?? 'Без названия',
    state: awaiting ? 'dec' : 'wait',
    inner: awaiting
      ? 'ждёт вашего решения'
      : row.status === 'returned'
        ? 'возвращена вами'
        : promiseless
          ? `в очереди · место ${row.position} · ${promiseless}`
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
    // ЧТО ждёт — из статуса самой строки, а не одним общим «ждёт решения»: подход, дошедший до
    // приёмки, и строка, вернувшаяся к человеку иначе, — разные новости, и решают по ним разное.
    // Чего очередь не знает (что именно сделал работник), карточка не выдумывает: это лежит на
    // карточке задачи, куда она и открывается.
    wait: awaiting
      ? {
          age: ageLabel(row.agedForHours),
          what:
            row.status === 'awaiting_approval'
              ? 'Работа сделана и лежит на приёмке: работник остановился и не решает за вас'
              : 'Задача стоит на вашем слове — сама она дальше не пойдёт',
          cta: 'Открыть: одобрить или вернуть →',
        }
      : undefined,
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
function doneUnit(row: DoneRow, clock: (iso: string | null) => string, stillWaits = true): WorkUnit {
  const failed = !!row.failed
  // ЧЕЛОВЕК УЖЕ СКАЗАЛ СВОЁ СЛОВО — и второй раз его не спрашивают. Работа, остановленная
  // рукой, закрыта решением, а не поломкой: звать за ней обратно значило бы наполнить столбик
  // ожидания тем, чего никто не ждёт — а на этой машине таких строк двадцать восемь из
  // пятидесяти трёх. Всякая ДРУГАЯ поломка человека ждёт, и `columnOf` ставит её к нему.
  const stoppedByHand = row.failed?.reason === 'manual'
  // …И ТО ЖЕ САМОЕ С ДРУГОЙ СТОРОНЫ: за этой поломкой стоит не человек, а очередь — она сама
  // поставит работу заново, и номер повтора едет прямо на строке. Пока он есть, звать человека
  // не за чем: он открыл бы карточку, чтобы нажать то, что и так произойдёт через минуту.
  const repeatsItself = !!row.failed?.repeats
  const attempts = Number.isFinite(row.attempts) && row.attempts > 0 ? row.attempts : 1
  // An attempt after the first exists BECAUSE the one before it did not finish the work.
  const segs: UnitState[] = Array.from({ length: attempts }, (_, i) =>
    i === attempts - 1 ? (failed ? 'fail' : 'ok') : 'fail',
  )
  // «БЕЗ КОММИТОВ» — ЭТО ИЗМЕРЕНИЕ, И ЕГО НЕ ВЫВОДЯТ ИЗ МОЛЧАНИЯ. Дверь состояния перестала
  // спрашивать git на пути ответа (холодная сборка выдачи стоила 272 подпроцесса), поэтому
  // лента коммитов приезжает досылкой — следующим опросом. Пока её нет, строка говорит, что
  // она ещё считается: приговор «работа не оставила коммитов» до ответа git был бы обвинением.
  // `== null` ловит и «дверь сказала null», и «строка про коммиты вообще молчит»: оба случая
  // означают одно — ответа git нет, и оба обязаны звучать одинаково.
  const commits = row.gitPending || row.commits == null ? null : row.commits.length
  const commitsWord =
    commits === null ? 'коммиты ещё считаются' : commits === 0 ? 'без коммитов' : `коммитов: ${commits}`
  return {
    id: row.id,
    kind: 'inline',
    title: row.title ?? 'Без названия',
    state: failed ? 'fail' : 'ok',
    inner: `${attempts} ${attempts === 1 ? 'подход' : 'подхода'} · ${commitsWord}`,
    next: failed
      ? repeatsItself
        ? // ЧТО БУДЕТ ДАЛЬШЕ, А НЕ ТОЛЬКО ЧТО СЛУЧИЛОСЬ. Строка, которая поедет снова сама,
          // обязана сказать это вслух: иначе красная карточка выглядит как та, что стоит
          // насмерть, и человек идёт делать руками уже сделанное.
          `${row.failed?.reasonLabel ?? 'Не получилось'} · повторится сама: попытка ${row.failed?.repeats?.attempt} из ${row.failed?.repeats?.of}`
        : (row.failed?.reasonLabel ?? 'Не получилось — причина не записана')
      : `Закрыта в ${clock(row.finishedAt)}`,
    // Длительность закрытой задачи меряется по подходу, который её ЗАКРЫЛ: между попытками
    // задача лежит в очереди, и называть это время работой было бы неправдой. Одной отметки
    // мало — очередь тогда отвечает «нечего мерить», и это прочерк, а не ноль.
    dur: spanLabel(row.finishedDuration),
    segs,
    live: false,
    // ЧТО ИМЕННО ОТ ЧЕЛОВЕКА НУЖНО — рядом с поломкой, а не в журнале попытки. Столбик
    // ожидания рисует янтарную карточку только тому, кому есть что сказать, и это же условие
    // решает, попадёт ли строка в него вообще: поломка без слов осталась бы немым красным
    // прямоугольником, за которым человек всё равно идёт разбирать леджер руками.
    wait:
      failed && !stoppedByHand && !repeatsItself && stillWaits
        ? {
            age: '',
            what: row.failed?.reasonLabel ?? 'Не получилось — причина не записана',
            cta: 'Открыть: разобрать и поставить обратно в очередь →',
          }
        : undefined,
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

  // ПОЛОМКА, ЗА КОТОРУЮ УЖЕ ВЗЯЛИСЬ, БОЛЬШЕ НИКОГО НЕ ЖДЁТ.
  //
  // Закрытая строка живёт вечно, а работа продолжается под своим или новым номером — и до этой
  // строки столбик ожидания звал человека к каждой такой поломке ещё раз, хотя решение по ней
  // уже принято. Живой замер 31.08: пятнадцать карточек в «ЖДУТ ВАС», из которых настоящей
  // была ОДНА; остальные — вчерашние срывы, чью работу в тот же день переставили обратно в
  // очередь. Столбик, зовущий туда, где идти некуда, перестают читать целиком.
  //
  // «Уже взялись» — это не догадка: та же работа стоит в очереди, идёт у работника, ждёт
  // приёмки, или закрылась удачей позже. Сравнение по номеру И по названию нарочно: возврат
  // сохраняет номер, а поставленная заново работа приходит с новым, неся прежнее название.
  const takenUp = new Set<string>()
  for (const r of [...input.queue, ...input.awaiting]) {
    takenUp.add(r.id)
    if (r.title) takenUp.add(r.title)
  }
  for (const w of input.workers) {
    if (w.taskId) takenUp.add(w.taskId)
    if (w.taskTitle) takenUp.add(w.taskTitle)
  }
  for (const d of input.done) if (!d.failed && d.title) takenUp.add(d.title)
  const stillWaits = (r: DoneRow): boolean => !takenUp.has(r.id) && !(r.title ? takenUp.has(r.title) : false)

  const units: WorkUnit[] = [
    // Phases are not filtered by machine: a phase belongs to the project, not to a machine.
    ...input.phases.map(phaseUnit),
    ...mine(batches).map(batchUnit),
    ...loose(mine(input.awaiting)).map((r) => queueUnit(r, true)),
    ...running,
    ...loose(mine(input.queue)).map((r) => queueUnit(r, false)),
    ...loose(mine(input.done)).map((r) => doneUnit(r, input.clock, stillWaits(r))),
  ]

  return units.sort((a, b) => RANK[a.state] - RANK[b.state])
}

/**
 * ═══════════════════ СТОЛБИКИ ПО СТАДИЯМ — ТОЖЕ ПРОЕКЦИЯ, А НЕ ВТОРАЯ ПРАВДА ═══════════════════
 *
 * Раскладка по столбикам считается ЗДЕСЬ, над теми же единицами, и ни одного нового вопроса к
 * демону не задаёт. Поэтому её можно проверить прогоном на голых данных — а вёрстка остаётся
 * вёрсткой: столбик, чья принадлежность живёт только в разметке, проверяется глазом и ровно
 * поэтому расходится с правдой молча.
 *
 * СТОЛБИК — ЭТО ГДЕ РАБОТА СТОИТ НА ДОРОГЕ, А НЕ ЧТО С НЕЙ ПРОИСХОДИТ. Второе говорит сама
 * карточка своим словом и точкой: фаза, у которой стадия «Исполнение» ещё не запущена, стоит
 * в «Исполнении» и при этом честно пишет «Не начата». Если бы столбик отвечал ещё и за
 * состояние, у столбиков было бы вдвое больше смыслов, и первый же спор двух смыслов человек
 * прочитал бы как ошибку экрана.
 */
export type BoardColumn = 'discuss' | 'plan' | 'design' | 'execute' | 'verify' | 'you' | 'done'

/** Слева направо — так, как работа идёт. Порядок объявлен один раз и здесь. */
export const BOARD_COLUMNS: BoardColumn[] = [
  'discuss',
  'plan',
  'design',
  'execute',
  'verify',
  'you',
  'done',
]

/** Заголовки столбиков — в словах принятого макета. */
export const COLUMN_WORD: Record<BoardColumn, string> = {
  discuss: 'Обсуждение',
  plan: 'Планирование',
  design: 'Дизайн',
  execute: 'Исполнение',
  verify: 'Проверка',
  you: 'ЖДУТ ВАС',
  done: 'Готово',
}

/**
 * Стадии фазы — и столько же первых столбиков. Список стоит рядом со `STAGES` и в том же
 * порядке НАРОЧНО: стадия N фазы и есть столбик N, и связь эта проверяется прогоном.
 *
 * ДИЗАЙН ПОЛУЧИЛ СВОЙ СТОЛБИК, А НЕ УГОЛОК В «ПЛАНИРОВАНИИ», и это решение, а не следствие.
 * Свернуть его к соседу означало бы: две разные стадии стоят в одном месте доски, инвариант
 * «стадия N и есть столбик N» перестаёт быть равенством, а человек, увидевший фазу в
 * «Планировании», не может сказать, чего она ждёт — плана или чертежа. Столбик шире доски
 * стоит дешевле, чем место на доске, о котором надо спрашивать.
 */
const STAGE_COLUMN: BoardColumn[] = ['discuss', 'plan', 'design', 'execute', 'verify']

/**
 * В КАКОМ СТОЛБИКЕ СТОИТ ЕДИНИЦА.
 *
 * Три правила, по убыванию громкости:
 *
 *   1. Ждёт человека (`dec`) — «ЖДУТ ВАС», чем бы она ни была занята. Работа, стоящая на
 *      человеке, не должна отыскиваться среди движущейся: в этом весь смысл столбика.
 *   2. Фаза — по СВОЕЙ стадии: идущая, если такая есть, иначе первая непройденная. Стадии
 *      фаза несёт лентой (`segs`), считанной с её собственных артефактов, поэтому здесь
 *      ничего не домысливается. Все пройдены — «Готово».
 *   3. Инлайн и батч стадий не имеют вовсе: у них одна дорога — исполнение. Поэтому идущая и
 *      ждущая работника единица стоят в «Исполнении», а всё закрытое — в «Готово».
 *
 * ЗАКРЫТОЕ — ЭТО ok, skip и off: пропущенное и брошенное закрыты ЧЕЛОВЕКОМ, и дальше сами они
 * не пойдут. Своё слово каждая карточка несёт при себе (`STATE_WORD`).
 *
 * А «НЕ ПОЛУЧИЛОСЬ» — НЕ ЗАКРЫТО, И «ГОТОВО» ЕМУ НЕ МЕСТО. Раньше в «Готово» падало всё, что
 * не идёт и не ждёт работника, — поломки вместе с удачами. Замер 31.08: из ста тридцати шести
 * строк «Готово» пятьдесят три оказались упавшими, а сборка из девяти работ, вставшая на
 * первой, лежала там же со словом «Готово» на карточке. Столбик обещает человеку сделанное, и
 * обещание надо держать.
 *
 * ПРИЗНАК — НЕ СЛОВО «fail», А НАЛИЧИЕ СЛОВ ОЖИДАНИЯ. Так правило остаётся одним: в «ЖДУТ ВАС»
 * стоит ровно то, чему есть что сказать человеку, и столбик не наполняется тем, чего никто не
 * ждёт, — работа, остановленная его же рукой, слов ожидания не получает и остаётся закрытой
 * (см. `stoppedByHand`).
 */
export function columnOf(unit: WorkUnit): BoardColumn {
  if (unit.state === 'dec') return 'you'
  if (unit.state === 'fail' && unit.wait) return 'you'
  if (unit.kind === 'phase' && unit.segs.length === STAGES.length) {
    // ЗАКРЫТАЯ ФАЗА СТОИТ В «ГОТОВО», ЧЕМ БЫ ЕЁ НИ ЗАКРЫЛИ. Диск и роадмап могут расходиться о
    // стадиях (об этом карточка говорит словами), но место и слово расходиться не имеют права:
    // «Готово» в столбике «Проверка» — тот же спор, только переехавший из строки в раскладку.
    if (unit.state === 'ok') return 'done'
    const running = unit.segs.indexOf('run')
    // ПЕРВАЯ, КОТОРАЯ ЕЩЁ ПОЙДЁТ. Пропущенная стадия — закрытая: её никто не ждёт и ждать
    // некому. Поиск, знающий одно слово «пройдена», ставил бы всякую фазу старше ступени
    // рисования в столбик «Дизайн» — навсегда, включая закрытые, — и человек читал бы это как
    // «дом ждёт от меня семь чертежей».
    const at = running !== -1 ? running : unit.segs.findIndex((s) => s !== 'ok' && s !== 'skip')
    return at === -1 ? 'done' : STAGE_COLUMN[at]
  }
  // Стоящая на паузе работа НЕ закрыта — в «Готово» ей нельзя: столбик обещает человеку
  // сделанное. (У инлайна и сборки паузы не бывает вовсе — стадий у них нет; ветка эта
  // достаётся фазе, чей ряд стадий пришёл короче дороги.)
  return unit.state === 'run' || unit.state === 'pause' || unit.state === 'wait' ? 'execute' : 'done'
}

export interface BoardColumnView {
  key: BoardColumn
  title: string
  units: WorkUnit[]
}

/**
 * Столбики в их порядке — и пустой столбик остаётся столбиком.
 *
 * Пустое «Планирование», убранное с экрана, двигало бы соседей при каждом опросе состояния:
 * человек читает доску по МЕСТУ, и место, которое переезжает, приходится искать заново.
 */
export function buildBoard(units: WorkUnit[]): BoardColumnView[] {
  const byColumn = new Map<BoardColumn, WorkUnit[]>(BOARD_COLUMNS.map((c) => [c, []]))
  for (const u of units) byColumn.get(columnOf(u))?.push(u)
  return BOARD_COLUMNS.map((key) => ({ key, title: COLUMN_WORD[key], units: byColumn.get(key) ?? [] }))
}

/** Счётчики шапки — по столбикам, посчитанные по тем же единицам, что в них и лежат. */
export function countColumns(units: WorkUnit[]): Record<BoardColumn, number> {
  const out: Record<BoardColumn, number> = {
    discuss: 0,
    plan: 0,
    design: 0,
    execute: 0,
    verify: 0,
    you: 0,
    done: 0,
  }
  for (const u of units) out[columnOf(u)] += 1
  return out
}
