/**
 * types.ts — the shape of everything the daemon says, written down once.
 *
 * These types are transcribed from the daemon's own read models, field by field. They
 * are not a wish list: if a field is here, the daemon puts it on the wire today, or the
 * route that will put it there is already declared and answers «not yet» until its own
 * work lands. That is the whole point — a screen cannot invent an endpoint or a field,
 * because it can only see what is described here.
 *
 * Where a route is declared but not yet filled, its types are marked as such in a
 * comment. Their shape is the contract the filling work must honour, not a guess made
 * by a screen at render time.
 */

import type { EventName } from './events'

// ── the one-poll payload: GET /api/state ────────────────────────────────────────────

/**
 * What is known about ONE subscription window — and it is never a percentage.
 *
 * The provider names the window, says whether it is still allowing work, and says when it
 * resets. It does not say how much of it is spent, so `pct` is null on every reading today and
 * the field exists only so that the day it sends a fraction the screen shows ITS number. A
 * window nothing has been heard about is `unknown`, which the screens render as «нет данных» —
 * never as a zero, because a zero bar is read as «the quota is free».
 */
export type WindowStatus = 'open' | 'exhausted' | 'unknown'

export interface WindowFact {
  status: WindowStatus
  /** When the provider said this window turns over. Null when nothing has been heard. */
  resetsAt: string | null
  /** The provider's own percentage, ONLY when it sent one. Null means it did not. */
  pct: number | null
  /**
   * When this reading was taken. A percentage with no hour on it is read as «now» — which is
   * how a week measured nineteen hours earlier passed for the current one on the board. The
   * moment travels rather than an age, because an age computed on the daemon is already wrong
   * by the time the screen draws it.
   */
  observedAt: string | null
  /**
   * Where this fact came from, when it was not the account's own reading. `terminal` means a
   * status line signed into this account's config directory reported it — the same
   * subscription, said by another mouth — and the screen names that instead of passing it off
   * as a measurement of the account's own work stream. Absent for an account's own reading.
   */
  source?: 'terminal'
}

export interface WindowBar {
  fiveHour: WindowFact
  week: WindowFact
  /** Set only while a refusal is standing — it outranks both windows above. */
  closedUntil?: string | null
}

/** What a worker is doing right now — derived from the window and the task, never stored. */
export type Presence = 'работает' | 'ждёт окно' | 'свободен'

export type TaskStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'approving'
  | 'approved'
  | 'returned'
  | 'completed'
  | 'failed'

export interface QueueRow {
  id: string
  title: string | null
  lane: string | null
  /**
   * Чей это проект — или `null`, когда строка своего проекта не называет.
   *
   * `null` значит РОВНО «неизвестен» и ничего больше. Прежде дверь подставляла сюда проект, на
   * который человек смотрел в эту секунду, и окно уверенно называло принадлежность, которой
   * никто не измерял. Теперь неизвестное приезжает неизвестным, а экран говорит это словами.
   */
  project: string | null
  machine: string
  provider?: string
  priority: number
  status: TaskStatus
  /** 1-based place in the queue, in the order the workers will take them. */
  position: number
  /** Present only when the task has waited longer than the configured patience. */
  agedForHours?: number
  /** ПОЧЕМУ очередь не движется — на queued-строке, когда её никто не заберёт: конвейер
   *  выключен / все окна закрыты без бюджета / платный канал исчерпан / её файлы заняты
   *  идущей работой. Отсутствует, когда задача секунды от запуска (разведка 11.08 — «Queued
   *  без причины» больше не бывает). Общая причина сильнее частной: пока выключен конвейер,
   *  строка стоит из-за тумблера, а не из-за файла. */
  idleReason?: 'pipeline_off' | 'windows_closed' | 'budget_stop' | 'files_busy'
  /**
   * ЧЕМ ИМЕННО ЗАНЯТА ЭТА СТРОКА: пути, которые она объявила и которые уже держит идущая
   * работа, и сама эта работа по имени.
   *
   * Очередь не выдаёт разом две работы про один файл — иначе обе отводятся от одной вершины и
   * приезжают на приёмку конфликтом (замерено 31.08.2026: пять готовых работ из шести не
   * слились с первого раза). Состав удержания едет сюда, потому что придержанная молча строка
   * неотличима от строки, которую вот-вот заберут: человек видит свободных работников и
   * стоящую задачу и идёт искать поломку там, где её нет.
   *
   * Присутствует ТОЛЬКО когда удержание есть; отсутствие — «её файлов никто не держит».
   */
  heldBy?: { files: string[]; holders: { id: string; title: string | null }[] }
  /**
   * КОГДА ЗАДАЧУ ВЗЯЛИ — и, отдельным фактом, когда в последний раз подтвердили аренду.
   *
   * Это два РАЗНЫХ вопроса, и до разделения очередь отвечала на оба одним значением: продление
   * аренды двигало ту же отметку, поэтому «идёт столько-то» у любой живой попытки сбрасывалось
   * в ноль каждую минуту. Длительность считается от первого, признак жизни — от второго.
   *
   * `null` там, где очередь не знает: у строки, ждущей работника, мерить нечего, а ноль в этом
   * поле экран нарисует как «только что началась» — утверждение о работе, которой нет.
   * Миллисекунды эпохи (число), как их отдаёт очередь.
   */
  claimedAt: number | null
  leaseRenewedAt: number | null
  /**
   * СТРОКА, О РАЗМЕРЕ КОТОРОЙ НЕ СКАЗАНО НИЧЕГО, — и потолок ходов, который она за это
   * получит.
   *
   * Потолок считается по объявленной работе: ни признаков успеха, ни оценки — работа объявлена
   * мелкой и уходит в процесс с базовым числом ходов. Направление ошибки правильное (никто не
   * выдаёт запас, которого не просили), но до сих пор оно было невидимым: человек узнавал
   * число уже красной карточкой, когда работа в него упёрлась. Здесь оно приходит вовремя —
   * пока строка ждёт работника и обещание ещё можно дописать.
   *
   * Присутствует ТОЛЬКО у ждущей работника строки без обещания; отсутствие означает, что
   * размер работы чем-то объявлен, а не что потолка нет.
   */
  noPromise?: { cap: number }
}

/**
 * СОСТОЯНИЕ ЭЛЕМЕНТА БАТЧА — статус очереди, сказанный словами сборки.
 *
 * Очередь отвечает на вопрос «где эта строка», сборка — на другой: «нужен ли тут человек».
 * Порядок громкости (первое из присутствующих и есть состояние батча): провал → ждёт решения
 * → идёт → не начат → готово. Провал стоит первым и НЕ считается закрытым элементом:
 * провалившийся кусок останавливает батч и спрашивает владельца, ничего не повторяется само.
 *
 * Шестое слово, `skipped`, статусом очереди не является вовсе: так сказал ВЛАДЕЛЕЦ о
 * сломавшемся куске («пропускаем»), и это более поздний факт о куске, чем всё, что о нём
 * знает очередь. Пропущенный кусок сборку не держит и в закрытие ей не мешает.
 */
export type BatchItemState =
  | 'failed'
  | 'awaiting_decision'
  | 'running'
  | 'waiting'
  | 'done'
  | 'skipped'

/** Слова самой сборки: те же плюс `cancelled` — владелец от сборки отказался. */
export type BatchState = BatchItemState | 'cancelled'

export interface BatchItem {
  id: string
  title: string | null
  /** Статус в очереди — тот же словарь, что у строки задачи. */
  status: TaskStatus
  state: BatchItemState
}

/**
 * ВОПРОС ВЛАДЕЛЬЦУ ПО ВСТАВШЕЙ СБОРКЕ. Есть ровно пока кусок сломан и владелец не ответил:
 * батч стоит, очередь не выдаёт ни одного его куска, никакого автоповтора не происходит.
 * Варианты приходят ИМЕНАМИ от движка, а не сочиняются экраном: кнопка, ответ которой не
 * принимает ни одна дверь, — это кнопка, которая молча ничего не делает.
 */
export interface BatchQuestion {
  itemId: string
  itemTitle: string | null
  text: string
  options: { id: 'skip' | 'retry' | 'cancel'; label: string }[]
}

/**
 * БАТЧ — третий вид единицы работы: одна постановка владельца и куски, на которые она
 * разошлась. Всё поле считается движком при каждом чтении и нигде не хранится: «что держит
 * сборку» — функция состояний элементов, а записанное значение было бы второй правдой о тех
 * же статусах.
 */
/**
 * ЧЕТЫРЕ ЧИСЛА ПОСТАВЩИКА — теми же именами, какими их пишет квитанция и отдаёт дверь.
 *
 * Второе написание этих имён на стороне окна — способ получить нули на ответе, который всё
 * сказал: `cacheRead`, прочитанный как `cache_read`, отсутствует совершенно честно на вид.
 *
 * ОТСУТСТВИЕ ЦЕЛИКОМ (`null` вместо этой записи) значит «мерить негде» и НЕ значит «ноль»:
 * каталога прогонов нет вовсе — чужая машина, проект не подключён. Ноль на этом месте назвал
 * бы бесплатной работу, которую никто не измерял, и это ровно та ложь, ради которой окно и
 * различает прочерк и ноль.
 */
export interface TokenSums {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface BatchRow {
  id: string
  title: string | null
  /** Чей это проект — или `null`, когда сборка своего проекта не называет (см. `QueueRow`). */
  project: string | null
  machine: string
  /**
   * Состояние самого громкого элемента; `done` — только когда каждый элемент произвёл или
   * пропущен владельцем; `cancelled` — владелец от сборки отказался.
   */
  state: BatchState
  items: BatchItem[]
  /** Какой элемент держит сборку и почему (его состояние и есть причина); `null` у закрытой. */
  holding: BatchItem | null
  /** Вопрос владельцу — только пока сборка стоит на сломавшемся куске. */
  question?: BatchQuestion
  /**
   * С КАКОГО МОМЕНТА СБОРКА СТОИТ И ЖДЁТ ВЫБОРА ВЛАДЕЛЬЦА, в миллисекундах эпохи. Есть ровно
   * пока она стоит, и это ДРУГОЕ событие, чем `requestedAt`: между просьбой и срывом лежит вся
   * работа, которую сборка успела сделать.
   *
   * ОТМЕТКА, А НЕ ДЛИТЕЛЬНОСТЬ (как `heldSince` у эшелона): «стоит столько-то» окно считает от
   * неё своими часами, поэтому число растёт между опросами, а не прыгает раз в опрос.
   *
   * ОТСУТСТВУЕТ там, где очередь не поставила отметку закрытия: ноль читался бы как «встала
   * только что» — ровно то заявление, из-за которого простой в 15 часов выглядел работой.
   */
  stalledSince?: number
  /**
   * КОГДА ВЛАДЕЛЕЦ ЭТО ПОПРОСИЛ — момент, записанный дверью батча, в миллисекундах эпохи.
   * `null` — сборка старше этого поля: отметка постановки в очередь выглядела бы так же и
   * врала бы на величину, которую никто не заметит.
   */
  requestedAt?: number | null
  /** Расход всей сборки: сумма по её кускам, по каждому — по всем подходам; `null` — не мерили. */
  tokens?: TokenSums | null
  /** Сколько ходов стоила сборка — подходы её кусков. Ноль здесь измерен, а не выдуман. */
  attempts?: number
}

/** Задача эшелона, названная по имени: из этих имён окно собирает фразу подтверждения. */
export interface WaveTask {
  id: string
  title: string | null
}

/**
 * ЭШЕЛОН — волна исполнения одной фазы: несколько планов идут разом, потом следующие несколько.
 *
 * Ряд считается движком при каждом чтении, кроме одного факта: ОСТАНОВ. Его ниоткуда не вывести
 * — это слово владельца, — поэтому он записан и читается из того же реестра, которому подчиняется
 * диспетчер. Второго места, где экран мог бы решить, что волна идёт, нет.
 *
 * `running` — те, кто доведёт текущий шаг и встанет; `waiting` — те, кто уже стоит и работнику
 * не выдан. Обе половины называются ПОИМЁННО: фраза подтверждения собирается из них, а не
 * печатается с числами внутри.
 */
export interface WaveRow {
  phase: string
  wave: string
  held: boolean
  /** Когда останов поставлен, в миллисекундах эпохи; `null` — реестр времени не назвал. */
  heldSince: number | null
  running: WaveTask[]
  waiting: WaveTask[]
  /** Проект эшелона — тот, который называет его СОБСТВЕННАЯ работа; `null`, когда её никто не назвал или она из разных проектов. */
  project: string | null
  machine: string
}

/**
 * ЧЕМ КОНЧИЛАСЬ ОДНА РАБОТА — закрытый словарь демона, который окно только переводит в слова.
 *
 * `approved` / `returned` — акты ЧЕЛОВЕКА, и приходят они со строки очереди; `completed` /
 * `failed` — слова самого подхода из леджера. Разница между «сделана» и «принята» здесь не
 * стилистическая: вторую произносит владелец, и окно не имеет права сказать её за него.
 */
export type WorkerHistoryOutcome =
  | 'approved'
  | 'returned'
  | 'failed'
  | 'awaiting'
  | 'running'
  | 'completed'

/** Одна работа в истории работника. */
export interface WorkerHistoryRow {
  taskId: string
  /** Название — со строки очереди; `null`, когда чтение эту строку уже не несёт. */
  title: string | null
  /**
   * Род работы: стадия ФАЗЫ или инлайн-задача. `null` — строки в чтении нет, и назвать род
   * некому: «неизвестно» и «инлайн-задача» — разные ответы, и второй был бы выдумкой.
   */
  kind: 'phase' | 'task' | null
  /** Номер фазы, когда род — фаза. */
  phase?: string
  outcome: WorkerHistoryOutcome
  /** Когда кончился последний подход по этой работе, в миллисекундах эпохи. */
  endedAt: number
}

export interface WorkerRow {
  id: string
  lane: string | null
  /**
   * КТО ЭТО ПО РОЛИ. `executor` — исполнитель: он и есть «работник» в прямом смысле, тот, кто
   * разбирает инлайн-задачи и куски сборок. Любое другое имя — специалист (`ai-researcher`,
   * `code-reviewer`, …), которого поднимает фаза, а на инлайн-задачу зовут поимённо.
   *
   * ПРИЕЗЖАЕТ СЧИТАННЫМ. Экран не выводит роль сам по `roleFile`: её читает маршрутизатор,
   * и второе мнение о том, кто здесь исполнитель, разошлось бы с маршрутом в первый же день.
   */
  role: string
  /** Разбирает ли он очередь ПРЯМО СЕЙЧАС: исполнитель, включён и не верхушка — все три сразу. */
  inQueue: boolean
  enabled: boolean
  account: string
  /**
   * Present only while the worker holds a task — the roster is the only list that names a
   * claimed one, so it carries what a screen needs to PLACE that task: its id, its own
   * name, and the project it belongs to. All three arrive together or not at all.
   */
  taskId?: string
  taskTitle?: string | null
  /** Проект взятой задачи — или `null`, когда она своего проекта не называет (см. `QueueRow`). */
  project?: string | null
  branch?: string
  /**
   * КОГДА ЭТУ ЗАДАЧУ ВЗЯЛИ, в миллисекундах эпохи. Ростер — единственный список, называющий
   * заклеймленную задачу (в `queue[]` лежат ждущие работника, в `awaiting[]` — ждущие человека),
   * поэтому «идёт столько-то» у бегущей единицы считается ТОЛЬКО отсюда. Приходит вместе с
   * `taskId` или не приходит вовсе.
   */
  taskClaimedAt?: number | null
  /**
   * ОСТАЛЬНЫЕ ПОПЫТКИ, КОТОРЫЕ ЭТОТ РАБОТНИК ДЕРЖИТ ОДНОВРЕМЕННО С `taskId`.
   *
   * Правило продукта — одна живая сессия на работника, и держит его захват. Поле существует
   * ровно на случай, когда правило всё-таки нарушено: пока его нет, всё в порядке. Раньше на
   * этом месте не было ничего, и карточка называла ПЕРВУЮ из двух попыток — то есть доска
   * оказывалась единственным местом, где двойной захват не виден.
   */
  alsoRunning?: Array<{
    taskId: string
    taskTitle?: string | null
    project?: string | null
    taskClaimedAt?: number | null
  }>
  /**
   * «Сделано / не получилось» за последние 30 дней, посчитанные демоном из леджера попыток.
   * ОТСУТСТВУЕТ, когда леджер прочитать не удалось (или демон старый): ноль на карточке
   * читается как «этот работник ничего не сделал» — это измерение, а «нет данных» — правда.
   * Пустой, но читаемый леджер даёт именно нули: каталог открыли, за период ничего не
   * завершилось, и это измерение.
   */
  stats30d?: { done: number; failed: number }
  /**
   * ЧТО ЭТОТ РАБОТНИК ВЁЛ ЗА ТОТ ЖЕ ПЕРИОД — работы, а не подходы: задача, переделанная трижды,
   * стоит одной строкой, и слово при ней — как она кончилась В ПОСЛЕДНИЙ РАЗ. Считается тем же
   * проходом по леджеру, что и `stats30d`, поэтому числа и список не могут разойтись.
   *
   * ОТСУТСТВУЕТ по тому же закону, что и числа: пустой список читается как «этот ничего не
   * вёл» — это утверждение, а нечитаемый леджер — отсутствие ответа. Список ограничен сверху
   * демоном: он едет в каждом опросе состояния.
   */
  history?: WorkerHistoryRow[]
  window: WindowBar
  /** Seconds since the running task last showed a sign of life. */
  pulseAgeSec?: number
  presence: Presence
  /**
   * Which machine the worker sits on. Present once more than one machine is in the
   * household — the merge tags every row on its way through the hub. A single machine
   * says nothing, because there is nothing to tell apart.
   */
  machine?: string
}

/** Одно твёрдое решение, которое принимает человек: имя машине, слова — человеку. */
export interface OrchestratorHardCall {
  id: string
  label: string
  words: string
}

/**
 * ОРКЕСТРАТОР — верхушка машины, и он приезжает СВОИМ ключом, а не строкой в `workers[]`.
 *
 * У него нет ни полосы, ни окна, ни «сделано за 30 дней»: всё это — свойства того, кто берёт
 * задачи, а он их не берёт. У него есть имя, одна строка о том, кто он, аккаунт, через который
 * он говорит (или `null`, когда говорить нечем), и поимённый список решений, которых он не
 * принимает. `null` вместо всего блока означает «роли на этой машине не заведено» — так
 * отвечает старый демон, и окно скажет это словами, а не нарисует пустую карточку.
 */
export interface OrchestratorRow {
  id: string
  name: string
  title: string
  account: string | null
  hardCalls: OrchestratorHardCall[]
}

/** What the checks said. Every field may be null: an unread receipt never guesses. */
export interface ReceiptSummary {
  testsPassed: number | null
  testsTotal: number | null
  tscClean: boolean | null
  guardClean: boolean | null
}

/**
 * The proof a finished attempt really left — the reference the tick wrote when its exit gate
 * opened, split into its parts. This is what a card can show TODAY: the four numbers above
 * have no producer in the daemon, so `ReceiptSummary` renders nothing on every real task
 * until a receipt learns to carry a parsed result.
 */
export interface ReceiptProof {
  kind: 'reverify' | 'artifact' | 'answer' | 'moot' | 'preflight' | 'forge' | 'gate' | 'other' | string
  /** The reference verbatim, as stored — never re-worded. */
  ref: string
  /** For a documentary stage: the file it committed, and that commit. */
  path?: string
  sha?: string
  /**
   * Для исхода «предмета нет» — ЧЕМ проверяли: коммит, закрывший жалобу, или файл, который
   * смотрели. Демон подтвердил эту ссылку сам, до того как выдал квитанцию, поэтому её можно
   * открыть и увидеть то же самое. Отсутствует у всех остальных видов доказательства.
   */
  evidence?: string
  /**
   * ═══════ «ГОТОВО» И «ГОТОВО, НО НИКТО НЕ ПЕРЕПРОВЕРЯЛ» — РАЗНЫЕ СЛОВА ═══════
   *
   * Поля ниже приходят только у `kind: 'gate'` — там, где квитанции нет вовсе и вердикт
   * вынес сам гейт: либо «новых красных рецептов не появилось», либо «в дереве нет
   * рецептов, которые можно перепроверить». `unverified` — та самая оговорка; `reason` —
   * причина одним словом, как её записал демон; `preexistingRed` и `newRed` — числа, из
   * которых вердикт и сложился, чтобы человеку было что прочитать, а не чему поверить.
   *
   * Все НЕОБЯЗАТЕЛЬНЫ и отсутствуют у попыток, чьё доказательство — обычная ссылка на
   * квитанцию. Отсутствие поля означает «этого не говорили», и рисовать его нечем.
   */
  unverified?: boolean
  reason?: string
  branch?: string
  base?: string
  commits?: number
  preexistingRed?: number
  newRed?: number
}

/**
 * Ходы попытки по роду: правки, запуски оболочки, чтение, прочее.
 *
 * Все четыре всегда присутствуют, и нули означают «не было», а не «неизвестно»: неизвестное
 * приезжает отсутствующим объектом целиком.
 */
export interface TurnKinds {
  edits: number
  runs: number
  reads: number
  other: number
}

/**
 * СКОЛЬКО ХОДОВ ЕЙ ДАЛИ, СКОЛЬКО ОНА ВЗЯЛА И НА ЧТО.
 *
 * `null` в любом поле — «не мерили», и рисовать вместо него ноль нельзя: ноль читается как
 * измерение. Весь объект отсутствует, когда попытка не записала о ходах ничего.
 */
export interface TurnSpend {
  cap: number | null
  used: number | null
  kinds: TurnKinds | null
}

/**
 * Одно из трёх действий, предложенных человеку под красной карточкой. `id` — имя, по которому
 * окно знает, чем это действие делается; `label` и `detail` — слова двери, экран их не сочиняет.
 */
export interface FailureAction {
  id: string
  label: string
  detail: string
}

/**
 * ПРЕДЛОЖЕНИЕ, А НЕ ПРИГОВОР. Приезжает только у тех концов, за которыми повтора нет по
 * устройству: такая работа стоит, пока человек не решит, и карточка обязана назвать ему
 * решение вместе с числами, по которым его принимают.
 */
export interface FailureOffer {
  turnsBurned: number | null
  cap: number | null
  kinds: TurnKinds | null
  actions: FailureAction[]
}

export interface FailureSummary {
  reason: string | null
  /** The reason in words, from the daemon's own closed vocabulary. */
  reasonLabel: string | null
  /**
   * Почему именно у ЭТОЙ попытки: чем отказал гейт и на чём она в последний раз споткнулась —
   * последняя ошибка из её собственной стенограммы. Подпись выше одинакова у всех отказов
   * этого рода, а эта строка — про одну попытку. `null` — строке реестра сказать нечего.
   */
  detail?: string | null
  attemptsCount: number
  /** На что ушли ходы последней попытки. Отсутствует, когда строка попытки об этом молчит. */
  spent?: TurnSpend | null
  /** Три названных действия и числа под ними — только там, где следующей попытки не будет. */
  offer?: FailureOffer
  /**
   * СЛЕДУЮЩАЯ ПОПЫТКА, КОТОРУЮ ОЧЕРЕДЬ СДЕЛАЕТ САМА: который это будет повтор и сколько их
   * отпущено. Поле есть, ПОКА повторы остаются, и исчезает, когда они кончились, — по нему
   * столбик и отличает работу, ждущую машину, от работы, ждущей человека. Считает его демон
   * (`awaitsAutoRetry`), а не экран: правило одно на обе стороны.
   */
  repeats?: { attempt: number; of: number }
}

export interface DoneRow {
  id: string
  title: string | null
  /** Чей это проект — или `null`, когда строка своего проекта не называет (см. `QueueRow`). */
  project: string | null
  machine: string
  finishedAt: string | null
  /**
   * СКОЛЬКО ЗАНЯЛО, в миллисекундах — от двух отметок подхода, который задачу ЗАКРЫЛ. Не от
   * первого подхода к последнему: между двумя попытками задача лежит в очереди, и называть это
   * время работой было бы неправдой.
   *
   * `null`, когда одной из отметок нет (строка, восстановленная задним числом; подход, чей конец
   * не записан). Ноль экран нарисует как «заняло нисколько» — это утверждение, а «мерить нечего»
   * — факт.
   */
  finishedDuration: number | null
  workerId: string | null
  receipt: ReceiptSummary
  /** Чем доказано — та же квитанция, что и на подходе карточки. Отсутствует, когда ссылки нет. */
  proof?: ReceiptProof | null
  /**
   * Счёт изменений ветки и её лента коммитов — ИЛИ `null`, что значит «у git ещё не
   * спрашивали».
   *
   * Дверь состояния перестала запускать git на пути ответа: холодный ответ на 136 закрытых
   * работах стоил 272 подпроцесса и полминуты, и всё это время окно не показывало ни очереди,
   * ни работников. История закрытой работы теперь досылается и приезжает следующим опросом, а
   * до тех пор поля молчат. `null`, а не `[]` и не `0`: пустой список означает «спросили и
   * узнали, что коммитов нет», и это ДРУГОЕ утверждение о чужой работе.
   */
  diffStat: string | null
  branch: string
  commits: string[] | null
  /** Ровно это молчание, названное словом: `true`, пока ответа git о работе ещё нет. */
  gitPending?: boolean
  attempts: number
  /**
   * What was promised when the task was accepted. Absent when nothing was promised.
   *
   * ОДНО ПОЛЕ, ДВА ВИДА — ровно как у карточки задачи, потому что это ОНО ЖЕ: дверь отдаёт
   * `acceptance` строки очереди как есть, а очередь хранит и одну строку, и список признаков.
   * Здесь стояло `string`, и это была неправда, которой проверяющий типов не мог возразить:
   * тип обещал строку, экран подставлял значение в текст, а приезжал массив — и три условия
   * приёмки склеивались в одно нечитаемое предложение. Читается поле ровно одним путём —
   * `acceptanceList` из shell/format.
   */
  acceptance?: string | string[]
  /** Present only on a task that did not make it. */
  failed?: FailureSummary
  /**
   * ПОСЛЕДНЕЕ СЛОВО ЧЕЛОВЕКА о работе, которую делать не будут: устарело, предмета нет,
   * сделано иначе. Есть ТОЛЬКО там, где слово сказано, и живёт рядом с `failed`, а не внутри:
   * закрыть словами можно и удачную строку («сделано иначе» — законный конец зелёной работы).
   */
  closed?: ClosedByPerson
}

/** Закрытый словарь исходов, которыми человек закрывает работу СЛОВАМИ, а не заходом. */
export type ClosingReason = 'obsolete' | 'no_subject' | 'done_otherwise'

/** Что именно человек сказал, закрывая строку. */
export interface ClosedByPerson {
  /** Исход из закрытого словаря; `null` — слово, которого этот словарь не знает. */
  reason: ClosingReason | string | null
  /** Подпись исхода словами двери; `null`, когда подписи для слова нет. */
  reasonLabel: string | null
  /** Текст человека — sha, ссылка, причина. `null`, когда сказано одним исходом. */
  note: string | null
}

/** One subscription on the spend strip: its name and the whole of its window bar. */
export interface SpendAccount extends WindowBar {
  name: string
}

/**
 * Платный канал в трёх числах — И ВСЕ ТРИ В ДОЛЛАРАХ, что и сказано их именами.
 *
 * Поставщик выставляет `total_cost_usd`, продукт курс НЕ пересчитывает, и потолок задаётся в
 * той же валюте. До уборки эти же доллары ехали в полях `todayEur/monthEur/capEur`: цифра,
 * названная евро, читается как евро, а потолок при этом сравнивался с долларами — то есть
 * порог остановки денег стоял не там, где думал человек. Сказать, что курса нет, — обязанность
 * экрана (`screens/costs/money.ts`, FX_NOTE), а не имени поля.
 *
 * `monthUsd` — КАЛЕНДАРНЫЙ месяц с первого числа, и это ровно то число, с которым правило
 * отката сравнивает потолок: у экрана и у порога остановки один источник (policy/spend.mjs).
 */
export interface ApiFallback {
  todayUsd: number
  monthUsd: number
  capUsd: number
  switchMode: 'subscription' | 'api'
}

/**
 * What this machine's OWN terminal last reported about its subscription windows.
 *
 * This is the one reading that carries a real percentage, and the one that counts the sessions
 * a person ran himself: the provider pipes it to the status line command of his terminal. It
 * stands apart from the accounts above because nothing in that payload names an account — it is
 * the terminal's subscription, said as exactly that and no more.
 *
 * `observed` false means nothing has ever been reported. `observed` true with a window at
 * `unknown` means a reading was taken and the window it described has since turned over —
 * then `observedAt` is what the screen says instead of a number.
 */
export interface TerminalWindows {
  observed: boolean
  observedAt: string | null
  fiveHour: WindowFact
  week: WindowFact
}

export interface Spend {
  accounts: SpendAccount[]
  terminal: TerminalWindows
  apiFallback: ApiFallback
}

/**
 * One point of the cost history: one account, on one day, in one lane.
 *
 * Both figures travel because both are true: a subscription session is paid for by the plan
 * and books no money, so tokens are what makes that work visible at all, while `usd` is the
 * API-fallback money — honestly zero when nothing was billed, and dollars because that is what
 * the provider bills and nothing here converts it.
 *
 * ЧЕТЫРЕ ЧИСЛА, ТЕМИ ЖЕ ИМЕНАМИ, КАКИМИ ИХ ЗНАЕТ КВИТАНЦИЯ (`TokenSums` выше): вход, выход,
 * чтение кэша, запись кэша. Одна колонка «Токены» складывала их в число, по которому нельзя
 * ни узнать причину дорогого дня, ни пересчитать цену: кэш стоит своих ставок.
 *
 * `apiEquivalentUsd` — сколько этот же расход стоил бы, если бы работа шла по API, по ценнику
 * платформы (scripts/sma/lib/pricing.mjs, один на командную строку и демона). Это СПРАВОЧНАЯ
 * цифра: работа идёт по подписке, которая уже оплачена, и складывать её с `usd` — значит
 * платить дважды на бумаге. Поле отдельное именно поэтому, и экран обязан назвать его словами.
 * `unpricedTokens` — токены, чью модель ценник не знает: с ними справочная цена занижена, и
 * это видно, а не скрыто.
 *
 * `taskId` is present when the point stands for the conversation's own lane: the daemon
 * books a turn under the reserved `chat-` prefix, and that prefix is how the screen finds
 * the «Разговор» line. `machine` appears once more than one machine is in the household.
 */
export interface CostPoint {
  day: string
  account: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  /** Модель, через которую прошло большинство токенов этой полосы за день; null — не названа. */
  model: string | null
  usd: number
  apiEquivalentUsd: number
  unpricedTokens: number
  taskId?: string
  machine?: string
}

export interface Costs {
  series: CostPoint[]
  apiFallback: ApiFallback
}

export interface ProjectTaskCounts {
  queued: number
  claimed: number
  awaiting_approval: number
  completed: number
  failed: number
  total: number
}

export interface ProjectRow {
  id: string
  name: string
  /**
   * Whether the entry names a folder on this machine at all. The default entry an install
   * mints carries a name and nothing else, so a project can be in the register and still be
   * unreadable — the screens say «не подключён» rather than naming a project they cannot open.
   * The path itself never travels.
   */
  connected: boolean
  taskCounts: ProjectTaskCounts
  /** Что в этом проекте открыто и не уехало — см. ProjectTrunk. */
  trunk: ProjectTrunk
}

/**
 * ЧТО В ПРОЕКТЕ НЕ ОТПРАВЛЕНО — состояние копии против её ствола, прочитанное у git.
 *
 * `status` — измерено ли это вообще, и почему нет. Только `measured` несёт числа; во всех
 * остальных исходах числа НЕ ПРИДУМЫВАЮТСЯ (null), а `note` говорит словами. Ноль на экране
 * читается как «всё отправлено», и для проекта без удалённого ствола это ложь.
 */
export interface ProjectTrunk {
  status: 'measured' | 'not-connected' | 'no-git' | 'no-remote' | 'detached' | 'unreadable'
  /** Слова вместо чисел — на всяком исходе, кроме измеренного. */
  note: string | null
  /** Ствол, на котором стоит копия. */
  branch: string | null
  /** С чем сравнивали — удалённый ствол по имени (origin/main), а не догадка о нём. */
  remote: string | null
  /** Сколько коммитов не отправлено на удалённый ствол. */
  unpushed: number | null
  /** Когда удалённый ствол двигался последний раз (ISO). */
  remoteMovedAt: string | null
  /** Есть ли незакоммиченное в дереве. */
  dirty: boolean | null
  /** Сколько веток задач ещё не слито в ствол. */
  unmergedBranches: number | null
}

export interface MachineRow {
  id: string
  title: string
  role: 'self' | 'peer'
  online: boolean
  /** How long ago a machine that is not this one was last heard from. */
  lastSeenSec?: number
}

/**
 * Which of the machines this one is. `hubReachable` is false only once something has
 * actually failed to reach the main machine — nothing is assumed unreachable.
 */
export interface Federation {
  role: 'standalone' | 'hub' | 'peer'
  hubReachable: boolean
}

export interface Kpis {
  workersBusy: number
  workersTotal: number
  queued: number
  awaitingApproval: number
  /**
   * СКОЛЬКО СБОРОК СТОИТ И ЖДЁТ ВЫБОРА ВЛАДЕЛЬЦА — своё число рядом с приёмкой, а не то же
   * самое другими словами.
   *
   * `awaitingApproval` считает ГОТОВУЮ работу, которую надо принять или вернуть. Здесь —
   * сборка, остановившаяся на сорвавшемся элементе: очередь не выдаёт больше ни одного её
   * куска, пока человек не скажет «пропустить / повторить / отменить». Это состояние было
   * видно ТОЛЬКО тому, кто открыл карточку самой сборки, — доска показывала ноль, и батч
   * простоял пятнадцать часов при полностью честном на вид экране.
   */
  batchesAwaitingDecision: number
  /**
   * СИНОНИМ, А НЕ ВТОРОЕ ЧИСЛО: это ровно `costs.apiFallback.todayUsd` — расход платного
   * канала за сегодня, — и человек читает его на «Расходах», в шапке, под словами «платный
   * канал сегодня». Под СВОИМ именем это поле не рисует никто, и рисовать не надо: вторая
   * цифра того же дня на втором экране — это и есть тот способ, каким два экрана однажды
   * разойдутся.
   *
   * Держится оно ради одного: у ключа `kpis` своя история слияния в федерации (хаб
   * складывает его отдельным проходом), и убрать поле с провода значило бы менять договор
   * между машинами ради опечатки в документации. На ОДНОЙ машине двух вычислений больше нет —
   * дверь берёт это значение из `spend.apiFallback.todayUsd`, а не считает второй раз.
   */
  spentTodayUsd: number
  windowsOpen: number
  /**
   * Сколько мест одновременной работы занято ПРЯМО СЕЙЧАС — счётом того, кто места и раздаёт.
   * `null` — демону нечем сказать (дом идущих попыток ему не подключён); ноль здесь означал бы
   * «все места свободны», то есть измерение, а не молчание.
   */
  seatsBusy: number | null
  /** Сколько мест всего — потолок одновременных попыток, тем же чтением настройки, что и у тика. */
  seatsTotal: number
  /**
   * Сколько занятых мест НЕ ВИДНО В СПИСКЕ РАБОТНИКОВ — попытки, чьей задачи нет ни в одних
   * руках на этой доске. Ноль — обычное состояние; всё, что больше, человек раньше читал как
   * ошибку экрана («занято 4, а работают двое»), хотя за разницей шли живые невидимые сессии.
   * `null` — дома идущих попыток нет, сказать нечем.
   */
  seatsUnlisted: number | null
}

// ── the routing policy, as the reading carries it ───────────────────────────────────
//
// These are PURE DERIVES OF THE CONFIG a person already keeps on the machine. There is no
// second place a rule could be written down, and therefore no way for the window to show a
// policy that disagrees with the one the runner obeys. It follows that the policy is a
// READING here: nothing in this file describes a door that changes it, because the daemon
// opens no such door — a rule is edited where it lives, in the configuration.

/** One lane of work and the workers riding it, in the order the config names them. */
export interface RulesLane {
  lane: string | null
  workers: string[]
}

/**
 * A worker's profile. A field the config does not carry is ABSENT rather than null — an
 * omitted model is «whatever the provider defaults to», which is not the same as «none».
 */
export interface RulesWorker {
  id: string
  lane: string | null
  /** The account NAME and nothing else: the account object never travels. */
  account: string
  provider?: string
  model?: string
  effort?: string
  enabled: boolean
  /** Роль работника — см. `WorkerRow.role`. */
  role: string
  /** Разбирает ли эта строка очередь: включённый специалист — не то же самое, что исполнитель. */
  inQueue: boolean
}

/** Where the paid channel stops. Present only when a budget is written down at all. */
export interface BudgetStops {
  monthlyApiCapUsd: number
  warnPct?: number
}

/**
 * Whether the work is riding the plans or the paid channel. Worked out ONCE, by the spend
 * strip, from the live windows — a rule that reported a different mode than the strip would
 * be worse than no rule at all.
 */
export interface SubApiSwitch {
  mode: 'subscription' | 'api'
  capUsd: number
  /** With no cap there is no paid channel to switch TO. */
  budgeted: boolean
}

/**
 * ОДНА НАСТРОЙКА, КОТОРАЯ ПРИМЕНИТСЯ ТОЛЬКО С НОВОГО ЗАПУСКА ДЕМОНА.
 *
 * Демон читает файл настроек один раз — на запуске, — и дальше живёт копией. У настроек от
 * этого два класса: те, что двигает дверь окна (действуют сразу), и те, что правятся руками
 * в файле (действуют со следующего запуска). На вид они одинаковы, и это молчание уже стоило
 * владельцу двух неверных выводов подряд: «записано и показано» было прочитано как «действует».
 *
 * Поэтому строка несёт ОБА значения. `running` — то, по которому машина работает прямо
 * сейчас; `onDisk` — то, что лежит в файле (или `null`, если файл прочитать не удалось, и
 * тогда `diverged` обязан быть `false`: расхождение — утверждение о файле).
 */
export interface RestartScopedSetting {
  /** Путь в файле настроек, той же записью, какой человек видит его в config.json. */
  id: string
  label: string
  /** Почему эта настройка не может примениться на лету — одной фразой, рядом с ней самой. */
  why: string
  /** Настройка называет себя сама: пометка едет на строке, а не подразумевается заголовком. */
  applies: 'restart'
  running: number | string | boolean | null
  onDisk: number | string | boolean | null
  diverged: boolean
}

export interface Rules {
  lanes: RulesLane[]
  workers: RulesWorker[]
  /**
   * Настройки второго класса, списком. Ключ необязателен ровно по той же причине, что и
   * `pipeline` выше: демон, собранный до появления этого списка, его не несёт, и рисовать
   * вместо него пустоту («таких настроек нет») было бы тем самым молчанием, против которого
   * список и заведён.
   */
  restartScoped?: RestartScopedSetting[]
  /**
   * The conveyor's own switch, READ. The daemon derives it with the same predicate the tick
   * is gated on, so the answer on the glass and the answer in the machine are one comparison.
   *
   * Optional because a daemon built before the switch existed does not carry the key at all —
   * and absent must NEVER be rendered as «running». That guess is the exact lie this field
   * was added to prevent, one layer down; a screen that meets `undefined` here is looking at
   * an older process and has to say so instead of picking a state for it.
   */
  pipeline?: { enabled: boolean }
  budgetStops?: BudgetStops
  subApiSwitch: SubApiSwitch
}

/**
 * One SUBSCRIPTION — deduped, because several workers ride one account.
 *
 * `machineId` is the law made visible: a subscription belongs to exactly one machine, and
 * federation aggregates views, never credentials. A peer's accounts arrive, if at all, in
 * the peer's own answer.
 */
export interface AccountEntry {
  name: string
  machineId: string
  windows: WindowBar
  workers: string[]
  /** The daytime account, flagged by whichever worker profile carries it. */
  dayPriorityOwner?: true
}

/**
 * A section a fresh machine has nothing to say about yet.
 *
 * Absent is a STATE, not an error and not an empty form: an install that has never written
 * a lesson has no corpus, and a payload that answered `{noteCount: 0, tags: []}` would be
 * claiming a shape that does not exist there. The screens read `absent` first and say so in
 * words, which is why every one of them has a real thing to show on its first day.
 */
export interface AbsentSection {
  absent: true
}

/** One theme of the corpus and how many notes carry it. */
export interface MemoryTagCount {
  tag: string
  count: number
}

/** A note by NAME only. The body is deliberately not in this contract — see below. */
export interface MemoryNotePointer {
  id: string
  title: string
}

/**
 * The corpus as a SURFACE: how much there is, what it is about, what moved recently.
 *
 * A note's body never travels. Reading a note is a terminal's job with the whole loader
 * behind it; a payload that carried note bodies would be a copy of the memory tree leaving
 * the machine every few seconds for no screen that asked for it. `coreSize` is the size in
 * bytes of the always-loaded index — the part the team reads before every piece of work.
 */
export interface MemorySurface {
  absent?: false
  noteCount: number
  coreSize: number
  tags: MemoryTagCount[]
  recent: MemoryNotePointer[]
}

export type MemorySection = MemorySurface | AbsentSection

// ── the CONNECTED project's memory ──────────────────────────────────
//
// A different question from `memory` above, which is the notebook of the repository this
// daemon serves. This one is a project the founder CONNECTED — its notebook is shown and,
// by founder decision, never edited from here. What can happen is a migration of an
// older-format notebook, and even that is preview-first and one file at a time.

/**
 * A note of a CONNECTED project, by NAME only — the same law the local corpus holds: the row
 * is a pointer, the body stays in the project. It is its own type rather than a reuse of
 * MemoryNotePointer because the two are pointers into different trees, and a screen that
 * could mix them up would be showing one project's lesson under another project's heading.
 */
export interface ProjectMemoryPointer {
  id: string
  title: string
}

/**
 * What a migration would do to ONE note, described without quoting it.
 *
 * There is no diff here on purpose. A diff is the note's body, and a body never travels.
 * What travels instead is a closed vocabulary: what the note would BECOME
 * (`disposition`), WHY in one code the screen renders in words (`reasonCode`), which
 * frontmatter keys would be dropped, how many lines would move, and whether the proposal
 * validates. `applicable` is the daemon's own answer to «can this one be applied at all».
 */
export interface ProjectMigrationFile {
  file: string
  disposition: 'v2-markup' | 'episode-archive' | 'skip'
  reasonCode: string
  droppedKeys: string[]
  changedLines: number
  errors: number
  warnings: number
  sensitive: boolean
  hasStub: boolean
  draftStatus: 'written' | 'kept-existing' | 'already-applied' | 'none'
  applicable: boolean
}

/** The whole preview: what it looked at, and how much of it could actually be applied. */
export interface ProjectMigration {
  total: number
  applicable: number
  files: ProjectMigrationFile[]
  /**
   * True when the corpus is larger than the daemon will preview on a poll. The preview then
   * runs over nothing at all: `files` is empty and `total` is 0 BY REFUSAL, not because there
   * was nothing to change. The screen has to say which it is.
   */
  truncated?: boolean
  /** How many notes the corpus holds, and the size a live preview is built up to. */
  corpusNotes?: number
  previewCap?: number
}

/**
 * A connected project's notebook as a SURFACE.
 *
 * `liveness` is the honest half of the contract. `live` means a watcher is running on THIS
 * project; `polling` means the view refreshes on an interval — because the watcher could not
 * be established, errored, or is still pointed at a project that is no longer the selected
 * one. The screen renders the two differently on purpose: a window that claims live and
 * shows stale is worse than one that never claimed it.
 *
 * `readOnly` is carried rather than assumed, so the boundary the screen states comes from the
 * payload and not from a belief about what the daemon happens to do today.
 */
export interface ProjectMemorySurface {
  absent?: false
  project: { id: string; name: string }
  liveness: 'live' | 'polling'
  readOnly: true
  noteCount: number
  coreSize: number
  tags: MemoryTagCount[]
  recent: ProjectMemoryPointer[]
  generation: 'v1' | 'v2' | 'mixed' | 'empty'
  migratable: boolean
  v1Count: number
  v2Count: number
  unreadableCount?: number
  migration?: ProjectMigration
}

export type ProjectMemorySection = ProjectMemorySurface | AbsentSection

/** One training of the snapshot: when it ran, over how much, and how it scored. */
export interface StyleTraining {
  date: string
  decisionsCount: number
  policyVersion?: number | string
  summary: string
}

/**
 * One decision the distillation mined, already redacted.
 *
 * Every field here is the content of a fenced block the miner's scrubber wrote. Text a human
 * typed around those fences went through no scrubber and therefore never reaches this type.
 */
export interface StyleDecision {
  id: string
  situation: string
  decision: string
  why: string
}

/**
 * One graded situation of the exam. DECLARED, NOT YET SERVED: the derive omits `examTable`
 * today because no durable artifact carries the per-situation answers — the exam is sat
 * blind and its answer key is never opened by a read model. This is the shape the filling
 * work must honour; until then the screen shows that the breakdown is not published.
 */
export interface StyleExamRow {
  situation: string
  assistant: string
  owner: string
  matched: boolean
}

/**
 * The owner's snapshot as METRICS and already-redacted quotes. A metric the artifacts do
 * not carry is OMITTED rather than invented: an install that has never been graded has no
 * `matchRate`, and a machine that has never been taught has no style at all.
 */
export interface StyleSnapshot {
  absent?: false
  policyVersion?: number | string
  matchRate?: number
  trainings: StyleTraining[]
  decisions: StyleDecision[]
  examTable?: StyleExamRow[]
}

export type StyleSection = StyleSnapshot | AbsentSection

/**
 * Одна РОЛЬ, которую человек может назвать, ставя задачу, — и всё, что окну нужно знать,
 * чтобы её предложить или честно объяснить, почему её в списке нет.
 *
 * Приезжает СЧИТАННЫМ из того же состава, по которому маршрутизатор выбирает работника: окно,
 * складывающее этот список само, стало бы вторым мнением о том, кто вообще может взять работу.
 */
export interface RoleOption {
  /** Каноническое имя — ровно то, что поедет на задаче полем `role`. */
  role: string
  /** Имя, под которым человек видит этого работника на «Агентах» (`sma-ai-researcher`). */
  title: string
  /** Исполнитель ли это — тот, кому едет задача, не назвавшая роли. */
  executor: boolean
  /** Сколько таких работников ВКЛЮЧЕНО сейчас. Ноль — «есть, но выключен»: звать некого. */
  ready: number
  /** Сколько их всего, включая выключенных. */
  total: number
}

export interface StatePayload {
  kpis: Kpis
  queue: QueueRow[]
  /**
   * The work that is finished but still owes a person a word. Same shape as a queue row;
   * the one that has waited longest comes first. The queue carries what waits for a
   * WORKER, so these rows live in their own list rather than inside it.
   */
  awaiting: QueueRow[]
  /**
   * Батчи: постановка, её элементы с состояниями и названный держащий элемент. Всегда
   * присутствует — пустой список там, где батчей нет (ключ, появляющийся только вместе с
   * данными, читается экраном как «такого не бывает»).
   */
  batches: BatchRow[]
  /**
   * Эшелоны исполнения: что за волны сейчас в работе и какие из них владелец остановил.
   * Всегда присутствует — пустой список там, где ни одна задача о волне не заявила и ни один
   * останов не стоит.
   */
  waves: WaveRow[]
  workers: WorkerRow[]
  /**
   * Кого можно назвать при постановке — состав машины, свёрнутый по ролям. Всегда присутствует
   * (пустой список на машине без работников).
   */
  roles: RoleOption[]
  /** Верхушка машины. `null` — роли на этой машине не заведено (или демон её ещё не знает). */
  orchestrator: OrchestratorRow | null
  done: DoneRow[]
  spend: Spend
  costs: Costs
  projects: ProjectRow[]
  activeProject: string | null
  machines: MachineRow[]
  federation: Federation
  rules: Rules
  accounts: AccountEntry[]
  memory: MemorySection
  style: StyleSection
  /** The CONNECTED project's notebook — absent on a daemon with no project connected. */
  projectMemory: ProjectMemorySection
  /** Где стоит дверь этого демона и кому она видна — опора экрана «Работать удалённо». */
  remoteAccess: RemoteAccess
}

// ── «Работать удалённо»: the fact, never the advice ─────────────────────────────────

/**
 * Кому видна дверь демона. `this_machine_only` — петля (умолчание продукта);
 * `named_address` — один названный адрес; `every_interface` — дикая карта, то есть КАЖДЫЙ
 * интерфейс машины, включая те, о которых человек не думал.
 */
export type RemoteReach = 'this_machine_only' | 'named_address' | 'every_interface'

/** Один сетевой адрес этой машины, узнанный по ДИАПАЗОНУ, а не по имени поставщика. */
export interface RemoteNetworkInterface {
  interface: string
  address: string
  family: 'IPv4' | 'IPv6' | string
  /** `mesh` — шифрованная приватная сеть (CGNAT / ULA); `lan` — обычная локальная сеть. */
  kind: 'mesh' | 'lan'
}

/**
 * Факт о доступности демона со второй машины. Токена не несёт ни в каком виде — именно
 * потому, что весь экран об этом: токен становится настоящим паролем ровно тогда, когда до
 * демона можно дотянуться не с этой машины.
 */
export interface RemoteAccess {
  bind: string
  port: number
  reach: RemoteReach
  visibleBeyondThisMachine: boolean
  privateNetwork: {
    /** Найден ли хоть один адрес шифрованной приватной сети. */
    detected: boolean
    /** Удалось ли вообще перечислить интерфейсы. `false` — «не смог посмотреть», не «нет». */
    readable: boolean
    interfaces: RemoteNetworkInterface[]
  }
  /**
   * Адрес, который набирают на ВТОРОЙ машине, или `null`. `null` при поднятой сети — не
   * ошибка, а самый частый случай: сеть есть, а демон слушает только петлю.
   */
  openFrom: string | null
}

// ── one task: GET /api/task/:id ─────────────────────────────────────────────────────

/**
 * Why the work went where it went. The daemon writes a CODE from its closed vocabulary
 * at the moment of the decision; `label` is that code in words, for the card to show.
 */
export interface DispatchDecision {
  code: string
  label: string
  ts: string
}

/**
 * Слово, которое человек сказал идущей работе: когда сказано, какой судьбой отправлено и что
 * именно сказано. Хранится в журнале попытки — тем же слоем, что причина диспетчера и записка
 * работника, — и приходит на карточку, чтобы в ленте хода было видно, что в ход вмешивались.
 *
 * `text` — ДАННЫЕ ЧЕЛОВЕКА. Показывается текстовым узлом и ничем иным: никакой разметки, ничего
 * кликабельного, и никогда как указание тому, кто читает карточку.
 */
export interface JournalRedirect {
  /** Идентификатор строки в очереди доставки, если дверь его запомнила. */
  id: string | null
  /** Судьба слова: `interrupt` | `queue` | `steer` — код, а не фраза. */
  mode: string | null
  /** Тот же код словами («после хода») — подпись, которую рисует карточка. */
  label: string | null
  text: string
  /** Текст был обрезан по потолку слоя — сказано вслух, а не умолчано. */
  truncated: boolean
  ts: string | null
  /** Подход, который шёл в этот момент. */
  attempt: number | null
}

/**
 * Which lessons were in the room. Identifiers only — never the text of a note.
 *
 * ДВА ПЕРВЫХ ПОЛЯ — ЗАЯВЛЕНИЕ, ОСТАЛЬНЫЕ — НАБЛЮДЕНИЕ. `notes` и `reflexes` карточка знала
 * с самого начала: файл роли работника и список навыков, то есть то, что маршрутизатор
 * ОБЪЯВИЛ доступным. Поля ниже — то, что сессия сделала на самом деле: что открыла в
 * корпусе проекта, сколько раз позвала конвейер памяти, откуда взяты сработавшие рефлексы,
 * что прочла из собственной записной книжки аккаунта, чему научила и оставила ли записку о
 * подходе. Тик писал их в журнал, и до этой строки их не видел никто — вычислено и
 * записано не значит предъявлено.
 *
 * ВСЕ НОВЫЕ ПОЛЯ НЕОБЯЗАТЕЛЬНЫ И ПРИХОДЯТ `null` у задач старше слоя. Карточка обязана
 * молчать о том, чего не знает: нет поля — нет строки, никаких прочерков вместо данных.
 * Ids и признаки — тела заметок сюда не едут никогда.
 */
export interface MemoryTrace {
  notes: string[]
  reflexes: string[]
  /**
   * Что сессия ПОДНЯЛА из корпуса проекта: читала ли индекс памяти, какие заметки открыла
   * (имена без расширения) и сколько раз позвала конвейер загрузки по тегам.
   */
  loaded?: { index: boolean; reads: string[]; loadCalls: number } | null
  /**
   * Авто-память аккаунта — ОТДЕЛЬНЫМ списком, и это не придирка: своя записная книжка
   * работника не есть память проекта, и один общий список позволил бы выдать чтение первой
   * за работу со второй.
   */
  autoMemoryReads?: string[] | null
  /**
   * Откуда взяты рефлексы: имя источника словом. Отсутствие источника — честное слово, а
   * не пустой список, который выдал бы себя за наблюдение.
   */
  reflexSource?: string | null
  /**
   * Чему попытка научила: путь записанной заметки, названная причина «урока нет» или
   * признак того, что не сказано ни того, ни другого.
   */
  lesson?: { written?: string; none?: string; missing?: boolean } | null
  /** Оставила ли попытка записку о подходе — признак словом, не текст записки. */
  approach?: string | null
}

/**
 * ЧТО ПРИЁМКА СПАСЛА ИЗ КОПИИ ДО ТОГО, КАК КОПИЯ ИСЧЕЗЛА.
 *
 * Работник пишет урок в корпус СВОЕЙ копии. На проектах, где `.claude/` отслеживается
 * git, слияние приносит заметку само; там, где корпус в игноре (как у этого продукта),
 * слияние не приносит ничего, и черновик надо вынести до уборки — иначе единственный
 * экземпляр урока уезжает вместе с удалённой копией.
 *
 * Поэтому запись отдельная, а не поле внутри уборки: «что доехало до корпуса» и «что
 * удалено с диска» — разные вопросы, случаются в разные моменты и проваливаются
 * независимо. Сложенные в один объект, они однажды объяснили бы пропавший урок удачным
 * удалением.
 */
export interface MemoryHarvest {
  /** Когда собирали. */
  at: string
  /** Через какую дверь — приёмка. */
  by: string
  /** В каком режиме живёт корпус проекта: под git или в игноре. */
  mode: string
  /** Черновики, вынесенные из копии, — путями внутри каталога черновиков. */
  copied: string[]
  /** Уроки, которые конвейер записи ДЕЙСТВИТЕЛЬНО впустил в корпус проекта. */
  applied: string[]
  /** Что положено черновиком и ждёт своей очереди — записка о подходе. */
  drafted: string[]
  /** Что конвейер не принял и почему — словами, без домыслов. */
  refused: Array<{ id: string; reason: string }>
  /** Приёмка попросила НЕ убирать копию: урок жив только в ней (черновики не удалось вынести). */
  skipCleanup?: boolean
  /** Собралось ли всё; `false` — что-то не принято или не вынесено (см. refused/skipCleanup). */
  ok: boolean
}

/**
 * ОДИН ПУНКТ ТОГО, ЧТО РАБОЧАЯ КОПИЯ ПОЛУЧИЛА ПЕРЕД РАБОТОЙ.
 *
 * Копия работника — не голый checkout: проект держит вне git свой слой (правила, хуки,
 * память), и без него работник теряет всё, чему его научили. Каждый пункт отчитывается
 * своей судьбой: `copy` — принесли файлами, `link` — подключили ссылкой (зависимости не
 * ставятся заново), `tracked` — уже в git и трогать нечего, `skipped` — не пустили
 * (секрет, ссылка наружу, ошибка — причина в `reason`), `absent` — в проекте не нашлось.
 * Строка `mode` намеренно открыта (`| string`): старая запись с неизвестным словом должна
 * показаться как есть, а не исчезнуть с карточки.
 */
export interface MaterializedEntry {
  path: string
  mode: 'copy' | 'link' | 'tracked' | 'skipped' | 'absent' | string
  /** Сколько файлов реально перенесли. `0` у пункта, который уже был на месте. */
  files?: number
  tracked?: number
  bytes?: number
  /** Куда ведёт ссылка — для `link`. */
  target?: string
  /** Ссылка уже стояла с прошлой провизии. */
  existing?: boolean
  /** Почему пункт пропущен — словом верба (`secret`, `link`, `error: …`). */
  reason?: string
}

/**
 * СЛЕД УБОРКИ: что было удалено, кем и когда.
 *
 * Откатываемость — не намерение, а запись: «откатить можно» и «видно, к чему откатывать» —
 * разные вещи. Уборка приходит отдельной строкой той же попытки, поэтому она может
 * отсутствовать (копия ещё на диске) и может быть неуспешной (`ok:false` + `error`) —
 * приёмку это не отменяет, но человек обязан узнать, что на диске осталось.
 */
export interface CleanupTrace {
  at: string
  /** Кто убрал: приёмка задачи или суточный обход закрытых. */
  by: string
  removedPath: string | null
  removedBranch: string | null
  /** Вершина удалённой ветки — точка, с которой работу ещё можно поднять. */
  branchTip?: string | null
  /** Какие ссылки сняли ПЕРЕД удалением копии (иначе git уходит по ним в цель). */
  unlinked?: Array<{ path: string; target?: string }>
  /** Что было потеряно при принудительной уборке — по именам, а не числом. */
  dirtyFiles?: string[]
  forced?: boolean
  ok: boolean
  error?: string
}

/**
 * ═══════════ ЛИЧНЫЙ СЛОЙ, ПОД КОТОРЫМ РАБОТАЛ РАБОТНИК ═══════════
 *
 * Две половины одного ответа, слитые в один объект на строке попытки. Зеркало говорит,
 * ЧТО положили в аккаунт работника перед запуском: файл инструкций (короткий отпечаток
 * либо «absent»), сколько событий хуков, сколько сужающих правил. Оно же честно
 * подписывает, чего не переносит вовсе — allow и defaultMode приезжают СЛОВАМИ
 * «not mirrored», а не числами: перенести их значило бы расширить права работника, и
 * число здесь солгало бы, будто их перенесли.
 *
 * Init-кадр сессии говорит вторую половину — что она ДЕЙСТВИТЕЛЬНО загрузила: папку
 * авто-памяти проекта, хуки старта, чужие подключения. Разница между «положили» и
 * «загрузилось» и есть то, ради чего это вообще показывают человеку.
 *
 * Поля init-половины необязательны: сессия могла их не назвать, а попытки, сделанные до
 * того, как строка научилась их нести, не знают ни одного. Карточка молчит о том, чего
 * не знает — прочерк вместо данных врёт не меньше выдуманного числа.
 */
export interface PersonalLayer {
  /** Отпечаток перенесённого файла инструкций, либо «absent» — файла у автора нет. */
  claudeMd: string | null
  /** Сколько событий хуков перенесено в аккаунт работника. */
  hooks: number
  /** Сужающие правила — числами; allow и defaultMode — словами «не зеркалится». */
  permissions: { deny: number; ask: number; allow: string; defaultMode: string }
  /** Плагины работника — из его профиля, а не из аккаунта автора. */
  plugins: string[]
  /** Состояние размещённых подключений claude.ai у работника: «disabled». */
  connectors: string
  /** Куда убрали прежние настройки аккаунта перед перезаписью. */
  backup?: string | null
  /** Папка авто-памяти проекта — одна на репозиторий; из init-кадра сессии. */
  autoMemoryDir?: string | null
  /** Сколько хуков старта сессия подняла на самом деле. */
  initHooks?: number
  /** Имена MCP-серверов, которые сессия загрузила. */
  initMcpServers?: string[]
  /** Сколько инструментов размещённых подключений claude.ai оказалось в сессии. */
  initClaudeAiTools?: number
  /** Плагины, которые назвала сама сессия. */
  initPlugins?: string[]
  /** Режим разрешений, с которым сессия поднялась. */
  permissionMode?: string | null
}

/** Файл MCP, с которым запускали эту попытку, и серверы, включённые в нём. */
export interface McpConfig {
  path: string
  servers: string[]
}

/**
 * Вердикт пятёрки квитанций терминального паритета — сводка, а не пересказ.
 *
 * `fulfilled` из `total` — сколько квитанций выполнено; `warn` — сколько выполнено С
 * НАЗВАННОЙ ГРАНИЦЕЙ (у прав это единственный возможный лучший исход: до процесса доезжает
 * только список инструментов); `failed` — имена тех, что не выполнены, чтобы человеку было
 * что искать, а не только чего недосчитаться. `ok` — сколько прошло без оговорок.
 */
export interface ParitySummary {
  fulfilled: number
  total: number
  warn: number
  ok: number
  failed: string[]
}

/**
 * Одна запись из ответа git на диапазон «база..ветка»: что случилось с файлом и как он
 * называется. `from` есть только у переименования — это ПРЕЖНЕЕ имя, и с точки зрения
 * человека, который откатывает, того пути больше нет.
 */
export interface AttemptFile {
  /** Как git назвал изменение: `M`, `A`, `D`, `R100`, `C75`… — как записано, без перевода. */
  status: string
  path: string
  from?: string
}

/**
 * Противоречие свёрнутой записи: одна попытка, два несовместимых терминальных исхода.
 * Победитель не выбирается — названы ОБА, в порядке записи, и сколько строк сложилось.
 */
export interface AttemptConflict {
  outcomes: string[]
  rows: number
}

/**
 * Что дверь сдачи развела без человека: путь и КАКИМ способом. `how` — слово развода
 * (`union` — оба дописанных абзаца целы, `regenerate`/`rederive` — производное пересобрано,
 * `measured`/`union+measured` — числа замера устарели у обеих сторон и взята одна из них),
 * а не оценка: карточка называет способ, а не хвалит его.
 */
export interface AttemptSyncResolved {
  file: string
  how: string
}

/**
 * Сведена ли ветка попытки с нынешней вершиной ПЕРЕД сдачей — и если нет, что именно осталось
 * в споре. Пишется дверью сдачи в копии работника, куда приёмщику уже не заглянуть: копию
 * после приёмки выметают, и без этого поля вопрос «почему приёмка не прошла» остался бы без
 * ответа ровно тогда, когда его задают.
 *
 * `unmerged` несёт ИМЕНА и ЧИСЛО — ни строчки содержимого: тело конфликта может нести секрет,
 * а приёмщику нужно знать, куда смотреть, а не что там написано.
 */
export interface AttemptSync {
  trunk: string
  behind: number | null
  synced: boolean
  resolved?: AttemptSyncResolved[]
  unmerged?: { count: number; files: string[]; detail: string | null }
}

export interface TaskAttempt {
  attempt: number | null
  workerId: string | null
  provider: string | null
  startedAt: string | null
  endedAt: string | null
  outcome: string | null
  failureReason: string | null
  reasonLabel: string | null
  receipt: ReceiptSummary | null
  /** The durable proof this attempt left. Absent when the row carries no reference. */
  proof?: ReceiptProof | null
  /**
   * What the worker chose, and what it turned down. Declared here now; the card's
   * three-layer view is filled when the task read model starts carrying it.
   */
  approachNote?: string
  /**
   * ═══════════ ГДЕ РАБОТАЛИ И К ЧЕМУ ОТКАТЫВАТЬ ═══════════
   *
   * Шесть полей ниже — точка отката попытки и след её уборки. Работник пишет только в свою
   * копию на своей ветке, отведённой от известного коммита; `base` и есть тот коммит, а
   * `worktreePath` — место, где всё это лежало. Без них «откатить можно» остаётся словами:
   * человеку нечего назвать команде.
   *
   * Все шесть НЕОБЯЗАТЕЛЬНЫ и приходят `null` у попыток, сделанных до того, как строка
   * попытки научилась их нести. Карточка обязана молчать о том, чего не знает: нет поля —
   * нет строки, никаких прочерков вместо данных.
   */
  base?: string | null
  branch?: string | null
  worktreePath?: string | null
  /**
   * ═══════════ ЧЕМ ВЕРНУТЬСЯ В СЕССИЮ ЭТОГО ПОДХОДА ═══════════
   *
   * `sessionId` — идентификатор сессии, в которой шла попытка, и он приезжает ТОЛЬКО пригодным
   * к продолжению: форму проверяет дверь тем же предикатом, каким её проверяет сборщик
   * аргументов запуска. `accountDir` — каталог аккаунта, под которым работник шёл; сессия лежит
   * в НЁМ, и без него команда, набранная в своём терминале, честно не найдёт ничего.
   *
   * `null` У ИДУЩЕЙ ПОПЫТКИ И У СТАРЫХ. Строка попытки пишется, когда попытка ЗАКАНЧИВАЕТСЯ,
   * поэтому у живой сессии идентификатора ещё нет; попытки старше этих полей молчат так же.
   * Молчание здесь — «мы этого не знаем», и панели возврата тогда нет вовсе.
   */
  sessionId?: string | null
  accountDir?: string | null
  /** Что копия получила перед работой — по пунктам манифеста проекта. */
  materialized?: MaterializedEntry[] | null
  /** Сколько заняла подготовка копии, мс. */
  provisionMs?: number | null
  /** Убрана ли копия — и если да, то когда, кем и с какими потерями. */
  cleanup?: CleanupTrace | null
  /** Под каким личным слоем шла эта попытка. null — попытка его не знает. */
  personalLayer?: PersonalLayer | null
  /** С каким файлом MCP её запускали. null — попытка его не знает. */
  mcpConfig?: McpConfig | null
  /**
   * Что приёмка вынесла из копии в корпус проекта — и что конвейер записи отклонил.
   * `null` у попытки, которую ещё не принимали, и у всех, что были до сбора: судьба урока
   * читается по этому полю, а не по отсутствию файла где-то на диске.
   */
  memoryHarvest?: MemoryHarvest | null
  /**
   * Каталог прогона этой попытки в подключённом проекте — четыре файла, по которым паритет
   * ДОКАЗЫВАЕТСЯ, а не утверждается. `null` у попытки, которая его не оставила.
   */
  runDir?: string | null
  /**
   * Вердикт пятёрки, посчитанный тиком тем же модулем, что и команда проверки. `null` —
   * «никто не проверял», и это не то же самое, что «проверено и в порядке».
   */
  parity?: ParitySummary | null
  /**
   * Свелась ли ветка этой попытки с вершиной до сдачи. `null` — «попытка об этом молчит»
   * (сдана до появления поля, либо сводить было нечего), и это НЕ то же самое, что «свелась».
   */
  sync?: AttemptSync | null
  /**
   * Сколько сессия собиралась, прежде чем сказать первое слово: `ms` — измерение, `words` — то,
   * что читается без пересчёта в голове. До первого кадра у идущей работы есть один признак
   * жизни — её вывод, поэтому подготовка песочницы и повисший процесс выглядели снаружи
   * одинаково. `null` — «попытка об этом молчит», и это НЕ «стартовала мгновенно».
   */
  sessionStart?: { ms: number | null; words: string } | null
  /**
   * ═══════ ЧТО ЭТА ПОПЫТКА ИЗМЕНИЛА И ЧТО ПОСЛЕ НЕЁ ИСЧЕЗЛО ═══════
   *
   * Список берётся из ответа git на диапазон «база..ветка», а не из наблюдения за
   * инструментами: правку, сделанную командой оболочки, наблюдение не видит по конструкции.
   * Исчезнувшее идёт ОТДЕЛЬНЫМ списком: цена ошибки несимметрична, и человек обязан видеть,
   * что файл был удалён, а не изменён. Счётчики говорят, сколько путей срезал потолок, —
   * молча урезанный список врёт.
   *
   * Все НЕОБЯЗАТЕЛЬНЫ и приходят `null` у попыток, сделанных до того, как строка попытки
   * научилась их нести. `null` — «попытка этого не знает»; пустой список означал бы
   * «спросили git, и ничего не менялось», а это другое утверждение.
   */
  files?: AttemptFile[] | null
  deletions?: string[] | null
  filesOverflow?: number | null
  deletionsOverflow?: number | null
  /**
   * Противоречие в записи этой попытки. `null` — противоречия нет. Заполнено — на экране
   * это показывается КАК противоречие, с обоими исходами: молчаливый выбор победителя и
   * есть та аномалия, ради которой поле заведено.
   */
  conflict?: AttemptConflict | null
  /**
   * ЧТО СТОИТ ПРЯМО СЕЙЧАС И ЖДЁТ ВАС. Опасный вызов внутри живой попытки физически стоит
   * на месте, пока человек не решит; после кнопки продолжается ТА ЖЕ сессия тем же вызовом.
   * Бывает только у ИДУЩЕЙ попытки — законченная уже ничего не ждёт, у неё всегда `null`.
   */
  ticket?: WaitingTicket | null
  /**
   * УПРЁТСЯ ЛИ ОДОБРЕНИЕ ЭТОГО ВЫЗОВА В СТЕНУ. Мягкая граница остановила вызов и спросила
   * человека; жёсткая — отказ, уехавший в аргументы запуска, — работнику недоступна вовсе,
   * и одобрение её не откроет. Поле говорит это ЗАРАНЕЕ, до нажатия.
   *
   * ОТСУТСТВИЕ ОЗНАЧАЕТ «НЕ ЗНАЕМ», А НЕ «БЕЗОПАСНО». Дверь отдаёт поле только тогда,
   * когда ответ ей известен; чего она не знает, о том молчит — ложное успокоение хуже
   * молчания, а ложное предупреждение обесценивает настоящее.
   */
  approvalWall?: ApprovalWall | null
  /**
   * КОНСПЕКТ ПЕРЕДАЧИ, ОСТАВЛЕННЫЙ ЭТОЙ ПОПЫТКОЙ. Тот же файл, слово в слово, который поедет
   * текстом в промпт следующего подхода: человек видит РОВНО то, что получит работник, а не
   * пересказ. Один файл, два читателя — в этом весь смысл того, что конспект лежит файлом.
   *
   * ОТСУТСТВИЕ ПОЛЯ ОЗНАЧАЕТ «ФАЙЛА НЕТ», а не «конспект пуст»: первая попытка предшественника
   * не имеет, и задача старше этого файла — тоже. Если передавать было нечего, это сказано
   * СЛОВАМИ внутри самого конспекта, потому что «нечего передать» — тоже сведение.
   */
  continuationSummary?: ContinuationSummary
  /**
   * СНИМОК КОНТЕКСТА, С КОТОРЫМ ЭТА ПОПЫТКА УШЛА В РАБОТУ. Тот же текст, слово в слово,
   * который работник получил блоком данных в промпте и файлом в своей копии: человек видит,
   * что подходу ДАЛИ, а не что написано на строке задачи сейчас.
   *
   * ЭТО ИСТОРИЧЕСКАЯ ПРАВДА ПОДХОДА, и после того как человек допишет слова задачи, она
   * честно разойдётся со строкой. Расхождение — весь смысл поля: подход сорвался с тем
   * контекстом, который у него был.
   *
   * ОТСУТСТВИЕ ПОЛЯ ОЗНАЧАЕТ «ФАЙЛА НЕТ» — снимка не было вовсе или попытка старше этого
   * файла. Пустая строка утверждала бы, что человеку было что сказать и он промолчал.
   */
  taskContext?: string
}

/**
 * Конспект передачи как он лежит на диске. `truncated` — упёрся ли текст в потолок при ЗАПИСИ;
 * читатель ничего не режет сам, иначе обрезка у окна и у промпта разъехалась бы молча.
 */
export interface ContinuationSummary {
  text: string
  truncated: boolean
}

/**
 * Ответ на вопрос «упрётся ли одобрение». `blocked` — упрётся, и `action` называет то
 * человеческое действие, которое работнику запрещено. `clear` — не упрётся. Третьего
 * состояния («не знаем») здесь нет по конструкции: оно приезжает отсутствием поля.
 *
 * `source` — откуда ответ: `spawn-args` (то, что действительно уехало в процесс этой
 * попытки) или `lane-envelope` (объявление полосы, запасной источник).
 */
export interface ApprovalWall {
  state: 'blocked' | 'clear'
  action: string
  source: string
}

/**
 * Билет: остановленный вызов, у которого есть идентификатор, команда словами и объявленный
 * срок. Срок не бесконечен — по его истечении вызов ОТКАЗЫВАЕТСЯ, и это видно на карточке.
 */
export interface WaitingTicket {
  id: string
  status: string
  tool: string | null
  command: string | null
  /** Класс опасности, как его назвал классификатор работника. */
  class?: string | null
  /** Почему это опасно — словами, теми же, что и в отказе. */
  reason?: string | null
  seenAt?: string | null
  deadlineAt?: string | null
}

/**
 * КВИТАНЦИЯ СЛИЯНИЯ СЛОВАМИ: ветка → итоговый коммит, гонялись ли тесты и с каким исходом.
 *
 * `testsPassed` — ТРИ состояния, а не два: `true` — прогон был и зелёный, `false` — был и
 * красный, `null` — прогонщика не нашлось вовсе, и тогда рядом стоит `testsNote` с
 * объяснением. «Не гонялись» и «не прошли» — разные предложения, и экран обязан их
 * различать: слить их в одно значило бы подписать зелёным то, чего никто не проверял.
 */
export interface MergeReceiptWords {
  branch: string | null
  sha: string | null
  testsPassed: boolean | null
  testsNote: string | null
  /**
   * Имена упавших тестов, как их назвал прогонятель. Пусто — имён он не назвал, и экран
   * говорит именно это: выдуманное имя отправляет человека чинить не тот тест.
   */
  failedTests?: string[]
  /**
   * Где лежит отчёт красного прогона. Полный набор при живых соседних сессиях умеет
   * краснеть ложно, и отличить такой красный от настоящего можно только по отчёту —
   * поэтому путь стоит на карточке словами. `null` — отчёта не сохранилось.
   */
  report?: string | null
}

/**
 * СЛЕД ПРИЁМКИ. Приёмщиков два: человек нажимает дверь окна, терминал проводит ритуал сам по
 * стоящему добро. Различать их — весь смысл записи: без имени приёмщика «принято» остаётся
 * словом, а проверить приёмщика человеку нечем.
 */
export interface AcceptanceRecord {
  by: 'human' | 'terminal'
  /** Минута приёмки. `null` — «когда, не записано»; экран говорит это словами. */
  at: string | null
  /** Какое окно приняло, когда приёмщик — терминал. У человеческой приёмки `null`. */
  terminal: string | null
  merge: MergeReceiptWords
}

/** Сколько было кругов возврата и какие слова от них уцелели. */
export interface ReturnRounds {
  rounds: number
  notes: string[]
}

/**
 * СКОЛЬКО ХОДОВ ЭТОЙ РАБОТЕ ДАДУТ НА СЛЕДУЮЩЕМ ЗАПУСКЕ — и по каким признакам столько.
 *
 * Считается от ОБЪЯВЛЕННЫХ полей задачи (оценка, число пунктов обещания, его длина) и от
 * потолков, которые у неё уже сгорели. Приезжает готовым: и число, и слово размера ставит
 * дверь, потому что второй словарь на замкнутый список слов разошёлся бы с первым молча.
 *
 * `cap: null` — «честного числа больше нет»: всё, что мы готовы оплатить, уже сгорело, и
 * следующий ход принадлежит человеку. Это не ноль и не «неизвестно».
 */
export interface TurnPlan {
  size: 'small' | 'standard' | 'large'
  sizeLabel: string
  cap: number | null
  ceiling: number
  escalatedFrom: number | null
  signals: { storyPoints: number | null; criteria: number; promiseChars: number } | null
}

export interface TaskDetail {
  task: {
    id: string
    title: string | null
    lane: string | null
    status: TaskStatus | null
    attempt: number | null
    /**
     * В КАКОМ ПРОЕКТЕ ЛЕЖИТ ЭТА РАБОТА — тот штамп, который стоит на СТРОКЕ. Из него карточка
     * берёт значение переключателя проекта: переставляя задачу, человек читает отсюда, откуда
     * он её переставляет.
     *
     * `null` — строка своего проекта не называет, и это измерение, а не пропуск: подставить
     * сюда активный выбор окна значило бы записать за задачей принадлежность, которой никто
     * не мерил. Поля НЕТ ВОВСЕ у демона постарше — тогда окно ищет ответ в общей картине
     * (`taskProjectOf`), а не делает вид, что получило `null`.
     */
    project?: string | null
    /** Что это за работа, словами. `null`, когда слов у задачи нет. */
    description: string | null
    /**
     * Что обещано. ОДНО поле, ДВА вида: одна строка (так написана всякая запись, сделанная
     * до появления списка) или список признаков. Экран читает его ровно одним путём —
     * `acceptanceList` — и на «массив это или строка» дважды не ветвится.
     */
    acceptance: string | string[] | null
    /**
     * Потолок ходов, который эта работа получит на следующем запуске, и признаки, по которым
     * он такой. Отсутствует у демона постарше — тогда карточка о потолке молчит, а не рисует
     * выдуманное число.
     */
    turnPlan?: TurnPlan | null
    /**
     * ═══════ ЧЕМ ОТМЕНЯЕТСЯ ПРИНЯТАЯ РАБОТА ═══════
     *
     * Отпечаток коммита слияния и путь репозитория, в котором слияние произошло. Слияние
     * всегда идёт без ускоренной перемотки, поэтому у коммита слияния ровно два родителя,
     * первый — основная ветка, и одной этой команды достаточно, чтобы отменить приёмку
     * целиком.
     *
     * `null` — «этого не записано», и тогда карточка о слиянии молчит. Отпечаток из
     * СОРОКА знаков появляется у работ, принятых начиная с этой версии; у более старых
     * приёмок в записи лежит короткий, из семи, — квитанция не переписывается, и экран
     * говорит об этом словами, а не делает вид, что знает больше.
     */
    mergeSha?: string | null
    mergeRepo?: string | null
    /**
     * Расход задачи: четыре числа поставщика, сложенные по ВСЕМ её подходам. Цену человек
     * платит за задачу, а не за подход, — поэтому сумма, а не последняя попытка.
     *
     * `null` (или отсутствие поля у демона постарше) значит «мерить было негде», и это НЕ
     * ноль: измеренный ноль приходит четырьмя нулями. Карточка обязана различать их словами.
     */
    tokens?: TokenSums | null
  }
  attempts: TaskAttempt[]
  branch: string
  commits: string[]
  returnedNotes: string[]
  /**
   * КЕМ И КОГДА РАБОТА ПРИНЯТА — и что при этом сказала квитанция слияния.
   *
   * `null` (или отсутствие поля у демона постарше) значит «записи об этом нет», и окно
   * обязано сказать это словами. Приёмщик по умолчанию был бы худшим из ответов: он
   * выглядит как знание, а проверять по нему нечего.
   */
  accepted?: AcceptanceRecord | null
  /**
   * Круги возврата: сколько раз работу отправляли обратно и какими словами. Слов может быть
   * меньше, чем кругов, — колонка решения помнит только последнюю записку.
   */
  returns?: ReturnRounds
  /**
   * The decision journal: why the work was routed as it was, and which lessons were
   * loaded. The per-attempt note lives on the attempt itself. Declared now so the card
   * is typed against one contract from its first line; carried by the read model when
   * the task route starts serving it.
   */
  journal?: {
    dispatcher: DispatchDecision[]
    memoryTrace: MemoryTrace
    /** Поправки человека по ходу работы. Нет поля вовсе — демон старше слоя. */
    redirects?: JournalRedirect[]
  }
}

// ── the roster of helpers: GET /api/harness ─────────────────────────────────────────

export interface AgentCard {
  id: string
  title: string
  lane: string | null
  provider: string | null
  model?: string
  effort?: string
  enabled: boolean
  roleFile?: string
  /** Роль — см. `WorkerRow.role`. */
  role: string
  /** Исполнитель ли это, то есть работник в прямом смысле, а не агент, зовомый внутри фазы. */
  executor: boolean
  can: string[]
  cannot: string[]
}

/**
 * Where a skill was found. 'project' — the tree the daemon serves. 'machine' — this machine's
 * own skill library, which is reachable no matter which project is active.
 */
export type SkillSource = 'project' | 'machine'

export interface SkillCard {
  id: string
  title: string
  /** The one-line frontmatter description, capped by the daemon. '' when the file has none. */
  description: string
  /** Which store this card came out of — always shown, never guessed on this side. */
  source: SkillSource
  assignedTo: string[]
  /** Named when something about this card is worth saying out loud (e.g. a shadowed twin). */
  problem: string | null
}

/**
 * One of the two places the daemon looked for skills, as it actually looked: the path, whether
 * that directory exists at all, and how many skills came out of it. This is what an empty list
 * says out loud — «нет навыков» without a place is indistinguishable from «нет такой функции».
 */
export interface SkillStore {
  source: SkillSource
  path: string
  present: boolean
  count: number
}

/** Connection cards carry the NAMES of their settings and whether each is filled in. */
export interface McpCard {
  id: string
  title: string
  purposeRu: string
  enabled: boolean
  envStatus: Record<string, '[set]' | '[unset]'>
}

export interface DraftCard {
  id: string
  title: string | null
  kind: DraftKind | null
  draftPath: string | null
  status: TaskStatus
}

/** Where a definition came from: it arrived with SMA, or the user brought it. */
export type StockOrigin = 'sma' | 'yours'

/**
 * WHICH STORE a definition was found in — the served tree, or this machine's own swarm. The
 * same two words a skill's source uses, and deliberately a separate type: the two screens read
 * different keys off the payload and a shared alias would hide the day one of them grows a
 * third store.
 */
export type AgentSource = 'project' | 'machine'

/**
 * One of the two places the daemon looked for agent definitions, as it actually looked. The
 * SkillStore twin, one screen over, and it exists for the same reason: an empty roster that
 * cannot name where it looked is indistinguishable from a product that has no agents.
 */
export interface AgentStore {
  source: AgentSource
  path: string
  present: boolean
  count: number
}

/**
 * What is known about a newer shipped version. 'unknown' means nobody has ever accepted a
 * version of this one, so there is nothing to compare against — it is never dressed up as
 * 'current'. 'not-shipped' is the user's own agent, which SMA does not ship updates for.
 */
export type StockUpdate = 'current' | 'available' | 'unknown' | 'not-shipped'

/**
 * One member of the team that arrived with the install, or one the user brought. Mirrors
 * the daemon's readStockTeam entry exactly: if this file and the daemon disagree, the
 * daemon is right and this file is wrong.
 */
export interface StockTeamCard {
  id: string
  title: string
  description: string
  tools: string[]
  enabled: boolean
  /** Which store this definition came out of — always shown, never guessed on this side. */
  source: AgentSource
  origin: StockOrigin
  forked: boolean
  stockUpdate: StockUpdate
  /**
   * The role this definition holds, normalized the way the ROUTER normalizes it — `sma-planner`
   * and `planner` are one role, and the window never spells it a second way.
   */
  role: string
  /**
   * Does the conveyor call this role by itself, without anyone naming it in the task? True for
   * the executors and the planner. It arrives DECIDED: the same answer decides what the
   * «включить тех, кто нужен сейчас» switch acts on, and a second opinion computed here is how
   * a button and its own caption come to mean different sets.
   */
  pipeline: boolean
  /** A definition that could not be read, or a twin that was shadowed — named, not hidden. */
  problem: string | null
}

/**
 * The three states of the owner's own Telegram bot, and the whole vocabulary this screen
 * renders. 'off' — nothing connected. 'awaiting_code' — a token is stored and the chat has
 * not proved itself yet. 'linked' — a chat sent the pairing code back and was written down.
 */
export type TelegramLinkStatus = 'off' | 'awaiting_code' | 'linked'

/**
 * What the window is told about the link — and note what is NOT here: the bot token.
 *
 * `tokenTail` is four characters, enough to recognise WHICH bot is connected and useless for
 * anything else; the daemon's read model never puts the whole value in this object, so there
 * is no field on this screen that could leak it into a screenshot or a console. `code` is the
 * pairing code the owner is looking at right now — short-lived by construction, and null once
 * its ten minutes are over (a dead code shown as if it worked is worse than none).
 */
export interface TelegramLink {
  status: TelegramLinkStatus
  tokenTail: string | null
  code: string | null
  expiresAt: number | null
  codeExpired: boolean
  chat: { id: string; title: string | null } | null
}

export interface HarnessPayload {
  agents: AgentCard[]
  skills: SkillCard[]
  /** The two stores, as they were walked — the words an empty skills list explains itself with. */
  skillStores: SkillStore[]
  mcp: McpCard[]
  drafts: DraftCard[]
  stockTeam: StockTeamCard[]
  /** The two stores, as they were walked — the words an empty roster explains itself with. */
  agentStores: AgentStore[]
  telegram: TelegramLink
}

export type DraftKind = 'agent' | 'skill' | 'mcp'

// ── live hints: GET /api/events ─────────────────────────────────────────────────────

/**
 * The kinds of doorbell, and the one place they are written down.
 *
 * A frame says something changed; it never says what was said. The window then re-reads the
 * truth from the poll.
 *
 * The names themselves live in `events.ts` — beside the subscription that has to use every
 * one of them, and nowhere else. They were transcribed here once and the two copies drifted
 * within days: the daemon declared a bell for a finished release, this union never learned
 * it, and the window could not have shown that bell even after the subscription was fixed.
 * So the union is now DERIVED from the list that is actually subscribed to, and that list is
 * checked against the daemon's frozen vocabulary by a test on the daemon's side.
 */
export type { EventName }

/**
 * Every field a frame may carry, and no field it may not.
 *
 * The omissions below are the design, not an oversight: `discussion.updated` names the phase
 * and NOT the question, `ship.gate` names the step and NOT what the step printed. A frame
 * reaches whatever has the channel open; the text behind it is fetched from the authenticated
 * endpoint by whoever is entitled to read it.
 */
export interface EventFrame {
  id: number
  event: EventName
  ts: string
  taskId?: string
  workerId?: string
  status?: string
  turnId?: string
  machineId?: string
  online?: boolean
  projectId?: string
  batchId?: string
  count?: number
  /** `phase.stage`, `discussion.updated` — which phase moved. */
  phase?: string
  /** `phase.stage` — which stage it moved to; `chat.stage` — where the live turn is. */
  stage?: string
  /** `chat.stage` — the order the frames were written in, so a late one is not applied. */
  seq?: number
  /** `ship.gate` — which step of the gate reported. */
  step?: string
  /** `ship.published` — the version that went out. Never a token, never a url. */
  version?: string
  /** `seats.full` — сколько мест занято в тот момент, когда в месте было отказано. */
  inFlight?: number
  /** `seats.full` — сколько их всего, тем же чтением настройки, по которому вынесен отказ. */
  cap?: number
}

// ── projects and machines (declared routes, filled by their own work) ───────────────

export interface ProjectsPayload {
  projects: ProjectRow[]
  activeProject: string | null
}

export interface MachineDetail extends MachineRow {
  accounts: SpendAccount[]
  projects: { id: string; name: string }[]
}

export interface MachinesPayload {
  machines: MachineDetail[]
  federation: Federation
}

/**
 * The wizard's half of pairing: ONE invitation and the words a person carries with it.
 *
 * `instruction` is TEXT the daemon wrote for a human to read and retype on the other
 * machine — never a script this window runs. Everything secret in it is a placeholder
 * except the invitation itself, which is the whole point of showing it. The invitation
 * works once and expires; `expiresSec` is how long it has left at the moment it was minted.
 */
export interface PairingInvitation {
  pairingToken: string
  instruction: string
  expiresSec: number
}

// ── the conversation ────────────────────────────────────────────────────────────────

/**
 * How a question was READ. The engine's own closed vocabulary, never a screen's guess.
 *
 * The four work-putting kinds are answered by dictionary rather than by a session: a sentence
 * that already names its lane — or names a stage of a phase — has been thought about by the
 * person who wrote it. What comes back is still only a draft.
 */
export type ChatTurnKind =
  | 'fail-reason'
  | 'spend'
  | 'status'
  | 'free'
  | 'stage'
  | 'task-prod'
  | 'task-research'
  | 'task-debug'
  /** «да» человека: согласие с последним черновиком — единственный ход, который ставит задачу. */
  | 'consent'

/**
 * What an answer IS: a fact taken from the read models, prose from the free lane, a
 * PROPOSED task, a task ACTUALLY PUT IN after the person said «да» ('created' — the card
 * beside it is a real queue row, not an offer), or a turn the person ENDED with the Стоп
 * button ('stopped' — the text they sent comes back to the composer, never an apology for a
 * "failure" they ordered). Приёмки среди них нет: одобрение — рука человека на кнопке.
 */
export type ChatAnswerKind = 'fact' | 'text' | 'draft' | 'decision' | 'created' | 'stopped'

/** The grey link-card an answer carries beside its sentence. */
export interface ChatTaskRef {
  id: string | null
  title: string | null
  status: TaskStatus | null
  /** The status in the daemon's own words, so the card and the screens never disagree. */
  statusLabel: string | null
}

/**
 * What a drafted piece of work IS, beyond its title. Absent on an ordinary task, which says
 * nothing extra about itself. `stage` is the one kind whose confirmation is NOT the task
 * door: it carries a GOAL — which stage of which phase — and the phase cycle's own door
 * decides the lane and the command.
 */
export type ChatDraftData =
  | { kind: 'debug' }
  | { kind: 'stage'; stage: PhaseStage; phase: string }

/**
 * A task the answer OFFERS to create. It is a proposal and nothing else: the conversation
 * has no path to the queue.
 *
 * A draft arrives one of two ways, and the pair below says which. A SESSION proposes a
 * `worker`, checked against the roster before it left the daemon, and the screen takes that
 * worker's lane. A sentence that already named its own lane is read by dictionary and
 * proposes the `lane` directly — the thing a roster pick could never express.
 */
export interface ChatDraft {
  title: string
  /** The proposed worker, by id. Absent on a draft the dictionary built. */
  worker?: string
  /** The lane the work belongs to. Absent on a draft a session built. */
  lane?: string
  mode: string
  /** Что это за работа, словами — выведено системой, поправимо человеком. */
  description?: string
  /** What must become true for the work to count as done — the same one field, as a list. */
  acceptance?: string[]
  data?: ChatDraftData
}

/**
 * A document a reply mentioned, offered as a path the artefact door will take.
 *
 * The chat guarantees NOTHING about it: it recognised something that plainly looks like a
 * document under the one root that door opens, and dropped everything it was unsure of.
 * Whether the path may be read is answered by the door, once, for every screen.
 */
export interface ChatAttachment {
  rel: string
}

/** One line of the spend answer: a share of the window's tokens, in whole percent. */
export interface ChatSpendShare {
  id: string
  label: string
  percent: number
}

/** Where an answer sends the reader for the full picture. */
export interface ChatAnswerLink {
  screen: string
  label: string
}

/**
 * A task the answer says is READY TO BE DECIDED. A proposal and nothing else: the buttons the
 * screen builds out of it press the ordinary approve/return doors, and the title is the
 * daemon's own registry word for the task — never the model's prose.
 */
export interface ChatDecision {
  taskId: string | null
  title: string | null
  /** Подсказка к возврату — что доделать, если человек решит вернуть. */
  note?: string
}

export interface ChatAnswer {
  kind: ChatAnswerKind
  text: string
  taskRef?: ChatTaskRef
  draft?: ChatDraft
  decision?: ChatDecision
  spend?: ChatSpendShare[]
  link?: ChatAnswerLink
  /** Documents this reply named — at most five, and only ever the reply's own. */
  attachments?: ChatAttachment[]
}

/** What POST /api/chat answers: the conversation it belongs to, and the answer itself. */
export interface ChatReply {
  conversationId: string
  kind: ChatTurnKind | null
  answer: ChatAnswer
}

/**
 * One stored turn of the transcript. The book records WHAT WAS SAID; the truth about the
 * park is the reading, always re-read. A stored answer keeps its task card and its draft,
 * but not the spend breakdown — those figures are re-read from «Расходы», never replayed.
 */
export interface ChatTurn {
  ts: string | null
  conversationId: string | null
  /**
   * Проект, при котором ход сказан. `null` — ход «без проекта»: он сказан до появления поля
   * или при невыбранном проекте, и ни в одну проектную нить не подмешивается.
   */
  project: string | null
  role: 'user' | 'assistant'
  kind: string | null
  text: string
  taskRef?: ChatTaskRef
  draft?: ChatDraft
  decision?: ChatDecision
  /** The documents that reply named. Kept, because a stored reply still points at them. */
  attachments?: ChatAttachment[]
}

export interface ChatHistory {
  turns: ChatTurn[]
}

/**
 * Одна БЕСЕДА книги — строка списка слева.
 *
 * Список собирается дверью из той же книги, поэтому здесь нет ни одного поля, которое окно
 * могло бы посчитать иначе, чем дверь. `title` — `null` значит «без имени», а не «имя ещё не
 * приехало»: показывать надо именно это, а не выдуманный порядковый номер.
 */
export interface ChatConversation {
  id: string
  /** Имя, данное рукой; нет такого — первые слова разговора; нет и их — `null`. */
  title: string | null
  /** Когда в беседе говорили в последний раз. По нему же — порядок списка. */
  lastTs: string | null
  turns: number
  project: string | null
  /** В беседе ПРЯМО СЕЙЧАС идёт ход — из реестра демона, а не из книги. */
  active: boolean
}

export interface ChatConversations {
  conversations: ChatConversation[]
}

// ── bringing your own helpers in (declared routes, filled by their own work) ────────

/**
 * What the scanner found a thing to BE. Only the first two can be taken automatically;
 * `unknown` and `rules` travel with a reason and are moved by hand, on purpose.
 */
export type ImportKind = 'agent' | 'skill' | 'unknown' | 'rules'

/** Something already answers to this name here — and it is never quietly overwritten. */
export interface ImportCollision {
  /** What holds the name: a roster worker, a definition of the park, or a file on the path. */
  existingKind: string
  /** A free name the scanner checked for us. Null when even the suffixes are taken. */
  suggestion: string | null
}

export interface ImportCandidate {
  kind: ImportKind
  /** Null when the foreign file's name does not reduce to a usable one. */
  slug: string | null
  name: string
  summary: string
  /** Where it came from, in plain words — never a path. */
  source: string
  /** Why it cannot be taken automatically. Carried by `unknown` and `rules`. */
  reason?: string
  collision?: ImportCollision
}

/** A part of the estate that has nothing to offer, and says why in words. */
export interface ImportNotReady {
  id: string
  title: string
  reason: string
}

export interface ImportScanResult {
  format: string
  candidates: ImportCandidate[]
  notReady: ImportNotReady[]
}

/**
 * ONE chosen candidate. `overrideSlug` is accepted ONLY for a candidate the scan marked
 * with a collision, and the daemon checks the name again at the moment of writing — a
 * rename that arrived on anything else is a refusal, not a silent rewrite.
 */
export interface ImportSelection {
  slug: string
  kind: string
  overrideSlug?: string
}

/** One thing the forge's own lint had to say about an imported definition. */
export interface ImportLintFinding {
  name: string
  detail: string
}

/**
 * What happened to ONE chosen definition. A refusal travels here, per item: one taken name
 * neither buries the batch nor stops the rest from landing.
 */
export interface ImportDraftResult {
  kind: string | null
  slug: string | null
  /** `awaiting_approval` when it landed as a draft; `refused` or `manual` when it did not. */
  status: string
  /** Where the draft now lives in the project, relative to its root. */
  path?: string
  reason?: string
  /** Present when the item was taken in under another name. */
  renamedFrom?: string
  lint?: { ok: boolean; findings: ImportLintFinding[] }
  receiptRef?: string
}

export interface ImportEnrollResult {
  drafts: ImportDraftResult[]
}

// ── the first run (declared routes, filled by their own work) ───────────────────────

export interface OnboardingQuestion {
  key: string
  title: string
  question: string
  hint: string
  step: number
  index: number
  optional: boolean
}

export interface OnboardingStep {
  step: number
  label: string
  answered: number
  total: number
  current: boolean
}

export interface OnboardingTopic {
  step: number
  key: string
  title: string
  question: string
  hint: string
  added: boolean
}

export interface OnboardingReadyLine {
  lead: string
  tail: string
  done: boolean
}

export interface OnboardingState {
  needed: boolean
  done: boolean
  /**
   * Whether the first run is closed because a person asked to be left alone for now, rather
   * than because the interview ran. `needed` is false either way; this says which it was.
   */
  declined: boolean
  finished: boolean
  step: number
  questionIndex: number
  question: OnboardingQuestion | null
  answers: Record<string, string>
  visited: Record<string, boolean>
  totalAnswered: number
  totalQuestions: number
  steps: OnboardingStep[]
  extraTopics: OnboardingTopic[]
  ready: OnboardingReadyLine[]
}

/**
 * What closing the first run answers: that it is done, and how many starter notes were
 * seeded. Deliberately NOT the profile's path or the notes' contents — the door reports the
 * outcome, and what was written is read where it lives, by whoever has the right to read it.
 */
export interface OnboardingResult {
  done: boolean
  notes: number
  /** True when the first run was DEFERRED: nothing was written into the project at all. */
  deferred?: boolean
}

// ── what the action routes answer ───────────────────────────────────────────────────

export interface EnqueueResult {
  ok: boolean
  id: string
  coalesced: boolean
  /**
   * В КАКОЙ ПРОЕКТ ЗАДАЧА УЕХАЛА — тот штамп, который дверь реально записала на строку, или
   * `null`, когда на демоне не выбрано ни одного проекта. Ставится он ровно один раз, при
   * создании, и переключением активного проекта задним числом не чинится — поэтому ответ
   * двери и есть единственный момент, когда промах ещё дёшево увидеть.
   *
   * Необязательное: демон постарше этого поля отвечает без него, и окно не обязано считать
   * такой ответ ошибкой.
   */
  project?: string | null
}

export interface ApproveResult {
  ok: boolean
  taskId: string
  merged: boolean
  receipt?: unknown
  softDenied?: boolean
  /**
   * ПОЧЕМУ НЕ ПРИНЯЛОСЬ — код для ветвления экрана и фраза для человека. Есть ровно у отказа:
   * успех себя не объясняет. Необязательные оба, потому что демон постарше слов ещё не
   * говорит, и окно не имеет права упасть, разговаривая с ним.
   */
  reasonCode?: string
  reason?: string
  /**
   * ЧЕМ КОНЧИЛАСЬ ПОСАДКА — вторая половина одного нажатия. Слияние вносит ветку, посадка
   * делает вершину ЗЕЛЁНОЙ: гоняет полный набор, когда квитанция работника этого дерева уже
   * не описывает, и штампует числа значка, квитанции и карты отдельным коммитом. Поле
   * необязательное, потому что демон постарше о посадке ещё не знает, а окно не имеет права
   * упасть, разговаривая с ним.
   */
  landing?: {
    stamped?: boolean
    committed?: boolean
    /**
     * Гонялся ли полный набор ЗДЕСЬ. Ложь значит «квитанция работника описывала это же
     * дерево» — второго поля об одном факте окну не нужно, и оно бы разошлось с первым.
     */
    ran?: boolean
    sha?: string | null
    tests?: number | null
    files?: number | null
    /** Что сказали сторожа значка и чисел ПОСЛЕ штампа. Ноль и ноль — вершина зелёная. */
    badgeViolations?: number | null
    numbersViolations?: number | null
    reason?: string
  }
}

export interface ReturnResult {
  ok: boolean
  taskId: string
  attempt: number
  /**
   * ЧТО ВСТАЛО В ОЧЕРЕДЬ ВМЕСТО ЗАКРЫТОЙ РАБОТЫ — только у обратного ребра графа фаз.
   *
   * Обычный возврат ставит ТУ ЖЕ задачу следующим подходом, и `taskId` выше её и называет.
   * Возврат С АДРЕСАТОМ закрывает работу насовсем и ставит ДРУГУЮ, своим номером: `taskId`
   * там — номер закрытого чертежа, и окно, читающее одно поле вместо двух, следило бы за
   * работой, которая больше никуда не поедет. Поля отсутствуют, когда адресата не называли.
   */
  stageTaskId?: string
  phase?: string
  stage?: PhaseStage
}

export interface ForgeResult {
  ok: boolean
  id: string
  kind: DraftKind
}

export interface ToggleResult {
  ok: boolean
  agent?: { id: string; enabled: boolean }
  skill?: { id: string; assignedTo: string[] }
  mcp?: { id: string; enabled: boolean }
  /**
   * The reserved-target branch: how many roster entries the switch touched, and WHICH set it
   * was aimed at — the whole shipped team, or only the roles the conveyor calls by itself.
   */
  stockTeam?: { enabled: boolean; scope?: 'all' | 'pipeline'; agents: number }
}

export interface OkResult {
  ok: boolean
}

/**
 * What the create-a-skill door answers: the file it actually wrote. The PATH is the proof —
 * a screen that says «создан» on a status code alone would say it just as cheerfully about a
 * write that never happened.
 */
export interface SkillCreateResult extends OkResult {
  skill?: { id: string; source: SkillSource; path: string }
}

/**
 * What the two project-writing doors answer: the entry as it now stands, with the id the
 * DAEMON minted. A screen that wants to look at what it just added reads the id from here —
 * it never invents one, because minting the id is the register's own business.
 */
export interface ProjectWriteResult extends OkResult {
  project?: { id: string; name: string }
}

// ═══════════════ the conveyor, the workbench and the release gate ═══════════════
//
// Everything below belongs to the addresses declared in one revision and filled one at a
// time. Six of them answer TODAY — the account door, the conveyor switch, the money stop,
// the model assignment, the diagnostics block and the update door — and their shapes are
// transcribed from the handlers that serve them, field by field, like every shape above.
//
// The rest answer «not yet» (501). Their shapes are written here FIRST, and that is the
// point of declaring the whole layer in one go: a screen is built against the shape once,
// the door is filled by its own work, and neither half has to guess what the other meant.
// A shape here is therefore a CONTRACT on the filling work, not a wish — if a door ends up
// answering something else, this file is what changes, in that door's own commit.

/** The stages a phase goes through. A closed vocabulary; a name outside it is refused. */
export type PhaseStage = 'discuss' | 'plan' | 'design' | 'execute' | 'verify'

/**
 * Where a stage stands, read off the artefacts on disk rather than remembered. A stage is
 * `done` because its document exists, which is why the answer survives a restart of anything.
 *
 * `skipped` — фаза, чья работа началась ещё до того, как ступень появилась в дороге. Чертежа
 * у неё нет и не будет, и требовать его задним числом означало бы объявить незавершёнными все
 * закрытые фазы проекта. Это НЕ `none`: второе значит «ждём документа».
 */
export type PhaseStageStatus = 'none' | 'in-progress' | 'done' | 'skipped'

/** One phase as the index lists it. */
export interface PhaseIndexRow {
  id: string
  name: string
  stages: Record<PhaseStage, PhaseStageStatus>
  /**
   * Стоит ли в роадмапе галочка человека «эта фаза закрыта» — ТРЕТИЙ источник о готовности
   * рядом с диском (`stages`) и очередью, и единственный, где говорит сам человек.
   *
   * Необязательное: процесс демона, поднятый до появления поля, отвечает без него, и молчание
   * читается как «галочки не стоит» — а не как закрытая фаза.
   */
  roadmapClosed?: boolean
  /** Questions this phase parked and nobody has answered yet. */
  open: number
  /** Questions already answered — the pair is «N открыто / M отвечено», counted, never stored. */
  answered: number
}

/** What the reserved `index` segment of the phase card route answers. */
export interface PhaseIndex {
  phases: PhaseIndexRow[]
}

/** One thing a person may pick when a stage stops to ask. */
export interface PhaseQuestionOption {
  id: string
  label: string
}

/**
 * One question a stage parked for the founder.
 *
 * An OPEN question is a record with no answer — that is the whole of the definition, and it
 * is why `answer` is optional rather than a second field saying «open». The identifier comes
 * from the question's own area, never from its position in a list: reordering the areas would
 * otherwise route an answer quietly into somebody else's question.
 */
export interface PhaseQuestion {
  id: string
  area: string
  question: string
  options: PhaseQuestionOption[]
  /** Absent, null or empty while the question is still waiting. */
  answer?: string | null
  /** The parked round this answer would wake, when there is one. */
  taskId?: string
}

/**
 * A document of the phase, by its name and by the path the artefact door will accept —
 * relative, and rooted where that door's only permitted root is. Nothing here is a place on
 * the founder's disk.
 */
export interface PhaseArtifact {
  name: string
  path: string
}

/**
 * One line of a phase's acceptance, and what a person said about it.
 *
 * `item` is the line's NUMBER as the acceptance document writes it — the address the whole
 * workflow already uses for a test, and the one thing about a line that does not change when
 * somebody rewords it. `name` is that same line's title, carried because a column of numbers
 * is not something a person can answer; it was added by the door that fills this shape, which
 * is exactly what the note above says to do when a door answers more than was guessed for it.
 */
export interface PhaseUatItem {
  item: string
  name?: string
  verdict: 'pass' | 'fail' | null
  note?: string
}

/**
 * ОДИН ПЛАН ФАЗЫ — документ и то, что он говорит о себе сам.
 *
 * `wave` — волна исполнения из шапки плана; `null` у плана, который волну не назвал. `status` —
 * слово из шапки, иначе `done`, когда рядом лежит сводка (то же правило, которым считается
 * прогресс фазы на карте), иначе `null`: «нет данных» — это отдельный ответ, и экран говорит
 * его словами, а не рисует план готовым, потому что никто не сказал обратного. Особое слово
 * «не прочитан» означает ровно то, что написано: файл есть, открыть его не удалось.
 */
export interface PhasePlan extends PhaseArtifact {
  wave: number | null
  status: string | null
  title: string | null
}

/** Волна исполнения фазы: её номер (или `null` у не размещённых) и планы этой волны. */
export interface PhaseWave {
  wave: number | null
  plans: PhasePlan[]
}

/** One phase in full: where it stands, what it asked, and what it left behind. */
export interface PhaseCard {
  id: string
  name: string
  stages: Record<PhaseStage, PhaseStageStatus>
  questions: PhaseQuestion[]
  plans: PhaseArtifact[]
  /**
   * ТЕ ЖЕ ПЛАНЫ, но в том виде, в каком фаза РАБОТАЕТ: волнами, по возрастанию, не назвавшие
   * волну — в хвосте. `plans` выше остаётся плоским списком: из него строятся ссылки на
   * документы, и экрану, которому нужна колонка, не приходится собирать её обратно из дерева.
   */
  waves: PhaseWave[]
  summaries: PhaseArtifact[]
  uat: PhaseUatItem[]
  /**
   * The acceptance document itself, when the phase keeps one — so a screen can open the whole
   * record through the artefact door instead of only the lines parsed out of it. It is also
   * the ONE answer to «which file is this phase's acceptance»: the door that writes a verdict
   * takes it from here rather than looking the directory up a second time.
   */
  uatDocument?: PhaseArtifact
  /**
   * О ЧЁМ ЭТА ФАЗА, СЛОВАМИ ЕЁ СОБСТВЕННОГО ДОКУМЕНТА — первый абзац её контекста, а когда
   * контекста ещё нет, абзац роадмапа под её заголовком. `source` едет вместе с текстом,
   * потому что «это из контекста фазы» и «это из роадмапа» — разные по весу утверждения.
   *
   * `null` (или отсутствие поля у демона постарше) значит РОВНО «сказать нечем», и экран
   * говорит это словами: пустое место читается как поломка.
   */
  description?: PhaseDescription | null
  /** Расход фазы: сумма по её задачам, по каждой — по всем подходам; `null` — мерить негде. */
  tokens?: TokenSums | null
  /** Чем фаза меряется, кроме расхода: задачи, ходы, момент старта. `null` — не у кого спросить. */
  work?: PhaseWork | null
  /**
   * ЧЕРТЁЖ, КОТОРЫЙ ЖДЁТ СЛОВА ЧЕЛОВЕКА — номером строки очереди, и ничем больше.
   *
   * Поле ОТСУТСТВУЕТ, когда ждать нечего: чертежа не рисовали, он ещё в работе или его уже
   * подтвердили. Ворота на карточке открываются той же дверью приёмки, что и всякая работа,
   * а дверь эта generic по номеру задачи — поэтому номер и есть всё, что окну нужно знать.
   * Демон постарше поля не отдаёт вовсе, и панель ворот тогда просто не рисуется.
   */
  designTask?: { id: string }
}

/** Откуда взяты слова описания фазы: её собственный контекст или роадмап. */
export type PhaseDescriptionSource = 'context' | 'roadmap'

export interface PhaseDescription {
  text: string
  source: PhaseDescriptionSource
}

/**
 * Сколько у фазы задач, сколько закрыто, сколько подходов на них потрачено и когда за неё
 * взялись впервые. Считано по ТЕМ ЖЕ строкам, по которым сложены токены, — иначе окошко
 * показателей назвало бы одну фазу двумя разными объёмами работы.
 *
 * `startedAt` — миллисекунды эпохи первого ВЗЯТИЯ задачи в работу; `null` — ни одну ещё не
 * брали, и это прочерк, а не сегодняшняя полночь.
 */
export interface PhaseWork {
  tasks: number
  done: number
  attempts: number
  startedAt: number | null
}

/**
 * Одна запись папки фазы: файл или подкаталог, как они лежат на диске.
 *
 * `path` — путь ВНУТРИ каталога фазы, ровно в том написании, какое принимает дверь: экран
 * отдаёт его назад нетронутым, а не собирает из кусков. Второе написание одного пути — это
 * второй ответ на вопрос, который у двери один.
 *
 * `size` у файла — байты, `null` — «размер спросить не удалось», а не ноль. У каталога размера
 * нет вовсе; `children` пуст и у пустого каталога, и у того, что глубже потолка обхода.
 */
export interface PhaseFileNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number | null
  children?: PhaseFileNode[]
}

/**
 * Папка фазы целиком: чей это каталог, как он называется относительно проекта и что в нём есть.
 *
 * `truncated` — «показано не всё»: дерево упёрлось в собственный потолок. Экран обязан сказать
 * это словами, потому что молча оборванный список читается как «больше ничего нет».
 */
export interface PhaseFolder {
  phase: string
  root: string
  entries: PhaseFileNode[]
  truncated: boolean
}

/** Starting a stage puts a task in the queue, and the answer names it. */
export interface PhaseStageResult extends OkResult {
  taskId: string
  phase: string
  stage: PhaseStage
}

/**
 * What recording an answer says back: the counts as they now stand, and — only when this
 * answer was the LAST open one — the task the round woke.
 */
export interface DecisionAnswerResult extends OkResult {
  open: number
  answered: number
  taskId?: string
}

export interface PhaseUatResult extends OkResult {
  phase: string
  item: string
  verdict: 'pass' | 'fail'
}

/**
 * One lesson waiting for a yes.
 *
 * `preview` is the change itself as text, because a person agreeing to a lesson is agreeing
 * to what it says and not to its title. `targetFile` is the note's name in the corpus.
 */
export interface MemoryDraftRow {
  id: string
  targetFile: string
  preview: string
  age: string
  /**
   * The draft's own declared kind, as data out of the file. The window does not interpret it —
   * it shows it, so a row that this door cannot apply says which door it belongs to.
   */
  kind?: string
  /**
   * Whether the APPLY door in front of this list is the one that owns this draft. A corpus
   * keeps drafts of more than one kind and each has its own door; a button that is always going
   * to be refused should be off, and say why, rather than teach that by failing.
   */
  applicable?: boolean
}

export interface MemoryDrafts {
  drafts: MemoryDraftRow[]
}

/** Applying ONE draft. There is no door that applies them all — deliberately. */
export interface MemoryApplyResult extends OkResult {
  draftId: string
  receipt: string
}

export interface MemoryIndexResult extends OkResult {
  receipt: string
  notes?: number
}

export interface MemoryLintFinding {
  rule: string
  severity: 'critical' | 'warning'
  note: string
  /** The note's own name in the corpus — a name, never a path. */
  file: string
}

export interface MemoryLintReport {
  ok: boolean
  critical: number
  warnings: number
  findings: MemoryLintFinding[]
  /**
   * The list was cut, and the counts above are still the whole truth. A panel that showed a
   * bounded list beside an unbounded number without saying so would read as an arithmetic bug.
   */
  truncated?: boolean
}

/** A terminal that has this checkout open right now. */
export interface CoordinationSession {
  id: string
  title: string
  age: string
}

/** A scope somebody reserved before changing it. */
export interface CoordinationClaim {
  name: string
  globs: string[]
  desc: string
  age: string
}

/** Two reservations over the same ground. Nobody may ignore one of these in silence. */
export interface CoordinationCollision {
  a: string
  b: string
  overlap: string[]
}

export interface CoordinationSnapshot {
  sessions: CoordinationSession[]
  claims: CoordinationClaim[]
  collisions: CoordinationCollision[]
}

/** Clearing somebody else's reservation. The reason is not optional — it is the evidence. */
export interface ClaimClearResult extends OkResult {
  claim: string
  receipt: string
}

/**
 * One line of the backlog, as the file has it.
 *
 * The identifier is DATA read out of the project's own file — the window does not know what
 * the letters before the number mean and must never grow an opinion about them.
 */
export interface BacklogRow {
  id: string
  title: string
  ageLine: string
  /** Первая фраза строки — то, чем она поедет в очередь заголовком. Считает демон, не окно. */
  headline: string
  /** Число, на котором строка встанет в очереди: срочность строки, размер — вторым ключом. */
  priority: number
  /** Почему часовой скан её не берёт, словами человека. Пусто — возьмёт. */
  notReady: string
}

export interface Backlog {
  rows: BacklogRow[]
}

/** Taking a backlog line into the queue. The line itself is not removed: the file is a hand. */
export interface BacklogPromoteResult extends OkResult {
  id: string
  taskId: string
}

/**
 * One part of what a worker's frame MEANT: which tool it used, what it handed to a subagent,
 * whether a result came back ok. Built by the daemon off the parsed frame — the screen only
 * renders it as text, exactly as it renders the raw line.
 */
export interface AttemptLogSummaryPart {
  kind:
    | 'tool'
    | 'mcp'
    | 'skill'
    | 'handoff'
    | 'tool_result'
    | 'text'
    | 'thinking'
    | 'session'
    | 'apikey'
    | 'denied'
    | 'progress'
    | 'result'
    | 'limit'
    | string
  tool?: string
  detail?: string
  subagent?: string
  ok?: boolean
}

/**
 * WHAT THE WHOLE ATTEMPT ADDED UP TO — counted by the daemon over every stored row and not
 * over the tail on screen, so the figures stay true on a transcript whose beginning was cut.
 *
 * `session` is the vendor's own sentence about the finished session (its cost counter and the
 * number of turns) and is shown as exactly that — never as a claim about which channel paid.
 * `subscriptionWindow` says the vendor reported a subscription window during this attempt,
 * which is the one channel fact the stream itself carries.
 */
export interface AttemptDigest {
  /** Rows the daemon could read — the length of the human story, never a census of the stream. */
  steps: number
  calls: number
  tools: { name: string; count: number }[]
  toolsMore: number
  filesRead: string[]
  filesReadMore: number
  filesChanged: string[]
  filesChangedMore: number
  commands: number
  skills: string[]
  connections: string[]
  agents: string[]
  handoffs: number
  failures: number
  denied: number
  session: string | null
  /** The billed credential the vendor named for this session, when it named one at all. */
  apiKey: string | null
  subscriptionWindow: boolean
}

/**
 * One line a worker printed, with the one fact about it that matters on screen.
 *
 * `summary` is present when the daemon could read the frame — then it is what a person is
 * shown. Absent means the line was not a frame it understands, and `line` (the raw text) is
 * the answer, which is what this log has always shown.
 */
export interface AttemptLogLine {
  ts: string
  line: string
  /**
   * Строку пришлось обрезать по потолку ряда. Ключа нет вовсе, когда строка целая: раньше
   * обрезка была молчаливой, и читатель принимал часть за целое, не имея ни одного признака,
   * по которому это можно заметить.
   */
  truncated?: boolean
  /** Сколько знаков было ДО обрезки (после сплющивания переводов строк). Только у обрезанного ряда. */
  originalLength?: number
  subagent: boolean
  /**
   * WHICH delegation this line belongs to — 1, 2, 3… in the order the groups first appear.
   * The daemon turns the vendor's opaque parent id into this ordinal at its door, so a burst
   * of eleven lines from one subagent reads as one voice instead of eleven interruptions.
   * Absent on a line the parent spoke itself.
   */
  group?: number
  summary?: AttemptLogSummaryPart[]
}

/**
 * The tail of one attempt. `truncated` says the beginning was cut, so the screen can say so
 * rather than let a person read a middle as if it were a start. No session identifier rides
 * this payload.
 */
export interface AttemptLog {
  lines: AttemptLogLine[]
  truncated: boolean
  /** The roll-up of the whole attempt. Null when nothing in the log could be read. */
  digest?: AttemptDigest | null
  /** The worker's own note about how it approached the task, when it left one. */
  note: string | null
  /**
   * КТО БЫЛ В СЕССИИ — исполнитель первым, затем делегации в порядке, в каком они заговорили.
   * Считается по ВСЕМУ журналу попытки, а не по хвосту выше: делегация, чьи строки не попали в
   * окно, иначе исчезла бы из дерева, а длина исполнителя мерилась бы от случайного места.
   * Пустой список — попытка ещё ничего не напечатала.
   */
  roles: AttemptRole[]
  /** Сколько голосов не поместилось в список — переполнение называется, а не срезается молча. */
  rolesMore: number
}

/**
 * ОДИН ГОЛОС В СЕССИИ ПОПЫТКИ — исполнитель или подагент, которому он отдал часть работы.
 *
 * `name` у исполнителя всегда `null`: журнал попытки знает строки, а не то, какой работник
 * держит задачу — имя работника живёт в ростере и в двери задачи. У подагента `name` — то, как
 * его назвал исполнитель в момент запуска; `null` означает, что делегация есть, а имени к ней
 * никто не приложил (а не «подагент №2»).
 *
 * `durationMs` — ТОЛЬКО когда у голоса есть две читаемые отметки времени; одна отметка (или
 * нечитаемые) дают `null`, потому что ноль экран нарисует как «заняло нисколько».
 * `steps` — сколько строк этого голоса демон сумел прочитать, не перепись потока.
 * `detail` — одна строка о деле: последнее, что этот голос делал, словами.
 */
export interface AttemptRole {
  role: 'executor' | 'subagent'
  name: string | null
  /** Модель, которую объявила сессия этого голоса. `null` — поток её не назвал. */
  model: string | null
  steps: number
  durationMs: number | null
  detail: string | null
}

/** One check of the release gate, and what it said. */
export interface ShipGateCheck {
  step: string
  ok: boolean
  detail: string | null
}

/** A gate run: the task carrying it, the checks so far, and the receipt a green run leaves. */
export interface ShipGateReport {
  ok: boolean
  taskId: string
  checks: ShipGateCheck[]
  receipt?: string
}

/**
 * The most dangerous act in the product, and its answer. It is reachable only with a green
 * gate's receipt AND the exact version string, both checked by the daemon.
 */
export interface ShipPublishResult extends OkResult {
  version: string
  receipt: string
}

/** Which corpus a hit came out of. */
export type SearchKind = 'screen' | 'task' | 'note' | 'rule' | 'agent' | 'attempt'

/**
 * Where a hit leads: a place in the WINDOW, never a place on disk. Whichever field is set
 * is the one the result opens with.
 */
export interface SearchRef {
  screen?: string
  taskId?: string
  noteId?: string
  attemptId?: string
}

/** One answer to one question, along the axis «what is it / when is it needed / where is it». */
export interface SearchHit {
  kind: SearchKind
  title: string
  hint: string
  ref: SearchRef
}

export interface SearchResults {
  hits: SearchHit[]
}

/**
 * Whether the environment variable an account names is populated on its own machine.
 *
 * This is as much as anything outside that machine is ever told about a credential: not the
 * value, and not even the NAME of the variable holding it. The daemon collapses both to one
 * of these two words before the answer leaves the process.
 */
export type SecretState = '[set]' | '[unset]'

/** One subscription as the settings side of the window knows it. */
export interface AccountProfile {
  id: string
  lane: string
  /** A subscription that exists is not yet a subscription that may be spent. */
  enabled: boolean
  token: SecretState
}

/**
 * What taking on an account answers.
 *
 * `enabled` is `false` and cannot be anything else — the door has no field to ask otherwise,
 * because between «this account exists» and «this account may be spent» stands a human
 * logging it in. That login is the one step with no headless form, so the answer carries the
 * SCENARIO in separate parts and the screen composes the line: the founder's machine may be
 * Windows, macOS or Linux and each spells «set this variable» differently.
 */
export interface AccountAddResult extends OkResult {
  id: string
  enabled: false
  login: {
    env: Record<string, string>
    cmd: string
    /** The NAME of the variable the token will live in. A name is not a secret. */
    tokenEnv: string
  }
}

/** The conveyor's own switch. Off is a state the window must render as off — there is no third. */
export interface PipelineToggleResult extends OkResult {
  pipeline: { enabled: boolean }
}

/**
 * The money stop. It is machine-wide, because that is the only stop this product reads;
 * `lane` exists so the screen may say which, and its one legal value says «the machine».
 */
export interface BudgetSetResult extends OkResult {
  budget: { lane: string; limit: number }
}

/** The one part of a worker's session that does not come from the project checkout. */
export interface AgentModelResult extends OkResult {
  agent: { id: string; model: string | null; effort: string | null }
}

/**
 * The four facts — and ONLY these four — that the feedback window may quote.
 *
 * The reader of this block is a public issue on the internet, so the list is short by
 * construction on the daemon's side and short by transcription here. Nothing may be added to
 * it on the screen either: not the project's name, not the current route, not a task title.
 * `version` is null when the stamp could not be read — an honest nothing, never the path it
 * failed on.
 */
export interface Diagnostics {
  version: string | null
  platform: string
  release: string
  node: string
}

/** One place a version was looked for, and what looking there said. */
export interface UpdateSource {
  id: string
  version: string | null
  verdict: string
}

/**
 * The update door's answer. By default it is a REPORT and nothing has been written: an
 * update never starts by itself, and the applying half runs only on an explicit word in the
 * request. Versions and verdicts ride this shape; paths never do.
 */
export interface UpdateReport {
  ok: boolean
  dryRun: boolean
  installed: string | null
  sources: UpdateSource[]
  /** Present only on an applied run. */
  applied?: { ran: boolean; exitCode: number | null }
  /** Present only when an applied run succeeded. */
  receipt?: string
}

/**
 * Ответ двери отмены задачи. Три разных факта, а не один «успех»: окно превращает их в
 * РАЗНЫЕ фразы, потому что человеку важно, умер ли процесс, а не только закрылась ли строка.
 *
 *   killed        — под задачей был живой работник, и ему сказано умереть.
 *   attemptClosed — попытка успела закрыться в отведённый срок (true), не успела (false),
 *                   или убивать было нечего вовсе (null). «Не закрылась» и «нечего было
 *                   закрывать» — разные утверждения, и склеивать их в false нельзя.
 *   cancelled     — очередь закрыла строку. false — честное «останавливать было нечего»:
 *                   хранилище не отличает неизвестную задачу от уже закрытой, и выдумывать
 *                   здесь различие, которого у него нет, значило бы соврать.
 */
export interface CancelTaskResult {
  cancelled: boolean
  killed: boolean
  attemptClosed: boolean | null
}

/**
 * Ответ двери «закрыть словами». Дверь либо записала последнее слово, либо отказала СЛОВАМИ
 * (409 у живой работы, 409 у строки, о которой слово уже сказано) — успех здесь ровно один и
 * не притворяется двумя.
 */
export interface CloseTaskResult {
  ok: boolean
  taskId: string
  reason: ClosingReason | string
  note: string | null
}
