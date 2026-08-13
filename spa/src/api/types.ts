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
  project: string
  machine: string
  provider?: string
  priority: number
  status: TaskStatus
  /** 1-based place in the queue, in the order the workers will take them. */
  position: number
  /** Present only when the task has waited longer than the configured patience. */
  agedForHours?: number
  /** ПОЧЕМУ очередь не движется — на queued-строке, когда её никто не заберёт: конвейер
   *  выключен / все окна закрыты без бюджета / платный канал исчерпан. Отсутствует, когда
   *  задача секунды от запуска (разведка 11.08 — «Queued без причины» больше не бывает). */
  idleReason?: 'pipeline_off' | 'windows_closed' | 'budget_stop'
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
}

export interface WorkerRow {
  id: string
  lane: string | null
  account: string
  /**
   * Present only while the worker holds a task — the roster is the only list that names a
   * claimed one, so it carries what a screen needs to PLACE that task: its id, its own
   * name, and the project it belongs to. All three arrive together or not at all.
   */
  taskId?: string
  taskTitle?: string | null
  project?: string
  branch?: string
  /**
   * КОГДА ЭТУ ЗАДАЧУ ВЗЯЛИ, в миллисекундах эпохи. Ростер — единственный список, называющий
   * заклеймленную задачу (в `queue[]` лежат ждущие работника, в `awaiting[]` — ждущие человека),
   * поэтому «идёт столько-то» у бегущей единицы считается ТОЛЬКО отсюда. Приходит вместе с
   * `taskId` или не приходит вовсе.
   */
  taskClaimedAt?: number | null
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
  kind: 'reverify' | 'artifact' | 'answer' | 'preflight' | 'forge' | 'other' | string
  /** The reference verbatim, as stored — never re-worded. */
  ref: string
  /** For a documentary stage: the file it committed, and that commit. */
  path?: string
  sha?: string
}

export interface FailureSummary {
  reason: string | null
  /** The reason in words, from the daemon's own closed vocabulary. */
  reasonLabel: string | null
  attemptsCount: number
}

export interface DoneRow {
  id: string
  title: string | null
  project: string
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
  diffStat: string | null
  branch: string
  commits: string[]
  attempts: number
  /** What was promised when the task was accepted. Absent when nothing was promised. */
  acceptance?: string
  /** Present only on a task that did not make it. */
  failed?: FailureSummary
}

/** One subscription on the spend strip: its name and the whole of its window bar. */
export interface SpendAccount extends WindowBar {
  name: string
}

export interface ApiFallback {
  todayEur: number
  monthEur: number
  capEur: number
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
 * and books no euros, so tokens are what makes that work visible at all, while `eur` is the
 * API-fallback money — honestly zero when nothing was billed.
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
  eur: number
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
  spentTodayEur: number
  windowsOpen: number
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
}

/** Where the paid channel stops. Present only when a budget is written down at all. */
export interface BudgetStops {
  monthlyApiCapEur: number
  warnPct?: number
}

/**
 * Whether the work is riding the plans or the paid channel. Worked out ONCE, by the spend
 * strip, from the live windows — a rule that reported a different mode than the strip would
 * be worse than no rule at all.
 */
export interface SubApiSwitch {
  mode: 'subscription' | 'api'
  capEur: number
  /** With no cap there is no paid channel to switch TO. */
  budgeted: boolean
}

export interface Rules {
  lanes: RulesLane[]
  workers: RulesWorker[]
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

export interface StatePayload {
  kpis: Kpis
  queue: QueueRow[]
  /**
   * The work that is finished but still owes a person a word. Same shape as a queue row;
   * the one that has waited longest comes first. The queue carries what waits for a
   * WORKER, so these rows live in their own list rather than inside it.
   */
  awaiting: QueueRow[]
  workers: WorkerRow[]
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

/** Which lessons were in the room. Identifiers only — never the text of a note. */
export interface MemoryTrace {
  notes: string[]
  reflexes: string[]
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
}

export interface TaskDetail {
  task: {
    id: string
    title: string | null
    lane: string | null
    status: TaskStatus | null
    attempt: number | null
    acceptance: string | null
  }
  attempts: TaskAttempt[]
  branch: string
  commits: string[]
  returnedNotes: string[]
  /**
   * The decision journal: why the work was routed as it was, and which lessons were
   * loaded. The per-attempt note lives on the attempt itself. Declared now so the card
   * is typed against one contract from its first line; carried by the read model when
   * the task route starts serving it.
   */
  journal?: {
    dispatcher: DispatchDecision[]
    memoryTrace: MemoryTrace
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
  can: string[]
  cannot: string[]
}

export interface SkillCard {
  id: string
  title: string
  assignedTo: string[]
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
  origin: StockOrigin
  forked: boolean
  stockUpdate: StockUpdate
  /** A definition that could not be read — named, so it is visible instead of missing. */
  problem: string | null
}

export interface HarnessPayload {
  agents: AgentCard[]
  skills: SkillCard[]
  mcp: McpCard[]
  drafts: DraftCard[]
  stockTeam: StockTeamCard[]
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
  /** `phase.stage` — which stage it moved to. */
  stage?: string
  /** `ship.gate` — which step of the gate reported. */
  step?: string
  /** `ship.published` — the version that went out. Never a token, never a url. */
  version?: string
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

/**
 * What an answer IS: a fact taken from the read models, prose from the free lane, a
 * PROPOSED task, or a turn the person ENDED with the Стоп button ('stopped' — the text
 * they sent comes back to the composer, never an apology for a "failure" they ordered).
 * Only the draft grows a button, and that button is a person's.
 */
export type ChatAnswerKind = 'fact' | 'text' | 'draft' | 'stopped'

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
  /** What must become true for the work to count as done. */
  acceptance?: string
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

export interface ChatAnswer {
  kind: ChatAnswerKind
  text: string
  taskRef?: ChatTaskRef
  draft?: ChatDraft
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
  role: 'user' | 'assistant'
  kind: string | null
  text: string
  taskRef?: ChatTaskRef
  draft?: ChatDraft
  /** The documents that reply named. Kept, because a stored reply still points at them. */
  attachments?: ChatAttachment[]
}

export interface ChatHistory {
  turns: ChatTurn[]
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
}

export interface ApproveResult {
  ok: boolean
  taskId: string
  merged: boolean
  receipt?: unknown
  softDenied?: boolean
}

export interface ReturnResult {
  ok: boolean
  taskId: string
  attempt: number
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
  /** The reserved «whole shipped team» branch: how many roster entries the switch touched. */
  stockTeam?: { enabled: boolean; agents: number }
}

export interface OkResult {
  ok: boolean
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

/** The four stages a phase goes through. A closed vocabulary; a fifth name is refused. */
export type PhaseStage = 'discuss' | 'plan' | 'execute' | 'verify'

/**
 * Where a stage stands, read off the artefacts on disk rather than remembered. A stage is
 * `done` because its document exists, which is why the answer survives a restart of anything.
 */
export type PhaseStageStatus = 'none' | 'in-progress' | 'done'

/** One phase as the index lists it. */
export interface PhaseIndexRow {
  id: string
  name: string
  stages: Record<PhaseStage, PhaseStageStatus>
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
