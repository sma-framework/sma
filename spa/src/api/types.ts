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

// ── the one-poll payload: GET /api/state ────────────────────────────────────────────

/** How much of an account's window is spent. `estimated` is honest, never decorative. */
export interface WindowBar {
  pct5h: number
  pctWeek: number
  estimated: boolean
  /** Set only while the window is shut. */
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
}

export interface WorkerRow {
  id: string
  lane: string | null
  account: string
  /** Present only while the worker holds a task. */
  taskId?: string
  branch?: string
  window: WindowBar
  /** Seconds since the running task last showed a sign of life. */
  pulseAgeSec?: number
  presence: Presence
}

/** What the checks said. Every field may be null: an unread receipt never guesses. */
export interface ReceiptSummary {
  testsPassed: number | null
  testsTotal: number | null
  tscClean: boolean | null
  guardClean: boolean | null
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
  workerId: string | null
  receipt: ReceiptSummary
  diffStat: string | null
  branch: string
  commits: string[]
  attempts: number
  /** What was promised when the task was accepted. Absent when nothing was promised. */
  acceptance?: string
  /** Present only on a task that did not make it. */
  failed?: FailureSummary
}

export interface SpendAccount {
  name: string
  pct5h: number
  pctWeek: number
}

export interface ApiFallback {
  todayEur: number
  monthEur: number
  capEur: number
  switchMode: 'subscription' | 'api'
}

export interface Spend {
  accounts: SpendAccount[]
  apiFallback: ApiFallback
}

/** One point of the cost history: one account on one day. */
export interface CostPoint {
  day: string
  account: string
  eur: number
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

export interface StatePayload {
  kpis: Kpis
  queue: QueueRow[]
  workers: WorkerRow[]
  done: DoneRow[]
  spend: Spend
  costs: Costs
  projects: ProjectRow[]
  activeProject: string | null
  machines: MachineRow[]
  federation: Federation
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

export interface HarnessPayload {
  agents: AgentCard[]
  skills: SkillCard[]
  mcp: McpCard[]
  drafts: DraftCard[]
}

export type DraftKind = 'agent' | 'skill' | 'mcp'

// ── live hints: GET /api/events ─────────────────────────────────────────────────────

/**
 * The fourteen kinds of doorbell. A frame says something changed; it never says what was
 * said. The window then re-reads the truth from the poll.
 */
export type EventName =
  | 'task.queued'
  | 'task.claimed'
  | 'task.running'
  | 'task.awaiting_approval'
  | 'task.approved'
  | 'task.returned'
  | 'task.failed'
  | 'worker.presence'
  | 'spend.updated'
  | 'harness.updated'
  | 'chat.reply'
  | 'machine.presence'
  | 'project.updated'
  | 'import.updated'

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

/** The wizard's half of pairing: a short-lived code a person carries to the other machine. */
export interface PairingCode {
  code: string
  expiresAt: string
}

// ── the conversation (declared routes, filled by their own work) ────────────────────

export interface ChatTurn {
  id: string
  role: 'human' | 'team'
  text: string
  ts: string
  /** A task the answer pointed at, so the card can be opened from the conversation. */
  taskRef?: string
  /** A task the answer offered to create. Nothing is created without a decision. */
  draft?: { title: string; lane: string | null; workerId: string | null }
}

export interface ChatReply {
  turn: ChatTurn
}

export interface ChatHistory {
  turns: ChatTurn[]
}

// ── bringing your own helpers in (declared routes, filled by their own work) ────────

export interface ImportCandidate {
  key: string
  kind: DraftKind
  title: string
  summary: string
  /** Where it came from, in plain words — never a path. */
  origin: string
  /** Set when something with this name already lives here. */
  collision?: string
}

export interface ImportScanResult {
  batchId: string
  candidates: ImportCandidate[]
}

export interface ImportEnrollResult {
  batchId: string
  enrolled: number
  drafts: DraftCard[]
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

export interface OnboardingResult {
  profilePath: string
  notes: string[]
  notesDir: string
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
}

export interface OkResult {
  ok: boolean
}
