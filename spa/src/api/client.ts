import type {
  ApproveResult,
  ChatHistory,
  ChatReply,
  DraftKind,
  EnqueueResult,
  ForgeResult,
  HarnessPayload,
  ImportEnrollResult,
  ImportScanResult,
  ImportSelection,
  MachinesPayload,
  OkResult,
  OnboardingResult,
  OnboardingState,
  PairingInvitation,
  ProjectsPayload,
  ProjectWriteResult,
  ReturnResult,
  StatePayload,
  TaskDetail,
  ToggleResult,
} from './types'

/**
 * client.ts — ONE function per door the daemon opens, and not a single door more.
 *
 * The daemon's list of addresses is closed and frozen. This file mirrors it exactly, so
 * a screen that needs something the daemon does not offer cannot quietly invent it: there
 * is simply no function to call. If a screen turns out to need a new address, that is a
 * conversation about the daemon's list, held before the screen is built — never a
 * surprise discovered at render time.
 *
 * Some doors are declared but not yet filled; those answer «not yet» (501). Call them
 * anyway and handle the refusal quietly with `isNotReady` — the screen behaves properly
 * on the day the door starts answering, with no rewiring.
 *
 * Authentication is the browser's session cookie, which the daemon set once. Nothing here
 * holds, reads or transports a token.
 */

/** A refusal from the daemon, carrying its status so a caller can tell them apart. */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(detail || `запрос отклонён (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/** A door that exists but is not filled in yet. Screens treat this as «пока нельзя». */
export function isNotReady(err: unknown): boolean {
  return err instanceof ApiError && err.status === 501
}

/** Nobody is signed in any more — the window has to send the person back to the door. */
export function isSignedOut(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}

/** Two people acted on the same task at the same moment; the other one won. */
export function isRaceLost(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

async function failure(res: Response): Promise<never> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 500)
  } catch {
    detail = ''
  }
  throw new ApiError(res.status, detail)
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return failure(res)
  return (await res.json()) as T
}

async function getText(path: string): Promise<string> {
  const res = await fetch(path, { method: 'GET', credentials: 'same-origin' })
  if (!res.ok) return failure(res)
  return await res.text()
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return failure(res)
  return (await res.json()) as T
}

/**
 * The daemon accepts only the fields it names for each action; anything else is refused
 * outright. So an optional field is left out entirely rather than sent as empty.
 */
function withOptional(
  base: Record<string, unknown>,
  optional: Record<string, unknown | undefined>,
): Record<string, unknown> {
  const out = { ...base }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

// ── what is going on ────────────────────────────────────────────────────────────────

/**
 * The whole picture in one read. This is the TRUTH: everything else on this page is a
 * hint that something changed. `project` narrows the tasks to one project.
 */
export function getState(opts: { project?: string } = {}): Promise<StatePayload> {
  const q = opts.project ? `?project=${encodeURIComponent(opts.project)}` : ''
  return getJson<StatePayload>(`/api/state${q}`)
}

/** Just the finished work — the same rows the full read carries. */
export function getDone(): Promise<{ done: StatePayload['done'] }> {
  return getJson<{ done: StatePayload['done'] }>('/api/done')
}

/** One task, in full: every attempt, what the checks said, what came back. */
export function getTask(id: string): Promise<TaskDetail> {
  return getJson<TaskDetail>(`/api/task/${encodeURIComponent(id)}`)
}

/** The changes one task made, as plain text. */
export function getDiff(id: string): Promise<string> {
  return getText(`/api/diff/${encodeURIComponent(id)}`)
}

/** The helpers, the skills, the connections and the drafts waiting for a decision. */
export function getHarness(): Promise<HarnessPayload> {
  return getJson<HarnessPayload>('/api/harness')
}

/**
 * The live channel. It rings; it never tells. Opening it is the caller's business to
 * close — see hints.ts, which is the only place in the window that opens it.
 */
export function openEvents(): EventSource {
  return new EventSource('/api/events', { withCredentials: true })
}

// ── giving work and judging it ──────────────────────────────────────────────────────

export interface EnqueueInput {
  title: string
  lane: string
  provider?: string
  model?: string
  effort?: string
  priority?: number
  /** Another machine, by its name here. Absent means this one. */
  machine?: string
}

/** Put a new task in the queue. The text becomes a task's title — never a command. */
export function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  return postJson<EnqueueResult>(
    '/api/enqueue',
    withOptional({ title: input.title, lane: input.lane }, {
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      priority: input.priority,
      machine: input.machine,
    }),
  )
}

/** Accept finished work. Only a person ever calls this. */
export function approve(taskId: string, opts: { machine?: string } = {}): Promise<ApproveResult> {
  return postJson<ApproveResult>('/api/approve', withOptional({ taskId }, { machine: opts.machine }))
}

/** Send work back with a comment. The comment travels as text, never as an instruction. */
export function returnTask(input: {
  taskId: string
  note: string
  title?: string
  lane?: string
  machine?: string
}): Promise<ReturnResult> {
  return postJson<ReturnResult>(
    '/api/return',
    withOptional({ taskId: input.taskId, note: input.note }, {
      title: input.title,
      lane: input.lane,
      machine: input.machine,
    }),
  )
}

/** Ask for a new helper or skill to be drafted. A draft is never switched on by itself. */
export function forge(input: { kind: DraftKind; description: string; slugHint?: string }): Promise<ForgeResult> {
  return postJson<ForgeResult>(
    '/api/forge',
    withOptional({ kind: input.kind, description: input.description }, { slugHint: input.slugHint }),
  )
}

/**
 * The reserved id that means «the whole team that came with SMA», not one helper. It goes
 * through the SAME door a single helper does — the daemon reads it as the team switch — so
 * turning the pipeline on is one act and not a new kind of request.
 */
export const STOCK_TEAM_TARGET = '__stock-team__'

/** Switch one helper on or off. The reserved id above switches the whole shipped team. */
export function toggleAgent(id: string, enabled: boolean): Promise<ToggleResult> {
  return postJson<ToggleResult>('/api/agent/toggle', { id, enabled })
}

/** Say which helpers know a skill. */
export function assignSkill(skillId: string, workerIds: string[]): Promise<ToggleResult> {
  return postJson<ToggleResult>('/api/skill/assign', { skillId, workerIds })
}

/** Switch one connection on or off. */
export function toggleMcp(serverId: string, enabled: boolean): Promise<ToggleResult> {
  return postJson<ToggleResult>('/api/mcp/toggle', { serverId, enabled })
}

// ── projects ────────────────────────────────────────────────────────────────────────

/** Every project this machine knows, and which one is being looked at. */
export function getProjects(): Promise<ProjectsPayload> {
  return getJson<ProjectsPayload>('/api/projects')
}

/** Take a folder into the register of projects. The id comes back minted by the daemon. */
export function addProject(input: { path: string; name?: string }): Promise<ProjectWriteResult> {
  return postJson<ProjectWriteResult>('/api/project/add', withOptional({ path: input.path }, { name: input.name }))
}

/** Give a project a better name. */
export function renameProject(id: string, name: string): Promise<ProjectWriteResult> {
  return postJson<ProjectWriteResult>('/api/project/rename', { id, name })
}

/** Look at another project. */
export function selectProject(id: string): Promise<OkResult> {
  return postJson<OkResult>('/api/project/select', { id })
}

// ── machines ────────────────────────────────────────────────────────────────────────

/** Every machine in the household, with what each one is doing. */
export function getMachines(): Promise<MachinesPayload> {
  return getJson<MachinesPayload>('/api/machines')
}

/**
 * Mint the ONE short-lived invitation a person carries to the machine being connected.
 *
 * It takes nothing, and the daemon refuses a body with any field in it at all. Rightly so:
 * an invitation is minted by this household for this household, so there is nothing a
 * caller could have to say about it. The joining machine gets its name on its own side,
 * when it introduces itself.
 */
export function pairMachine(): Promise<PairingInvitation> {
  return postJson<PairingInvitation>('/api/machine/pair', {})
}

/** Take a machine that answered the code into the household. */
export function addMachine(input: { code: string; title?: string }): Promise<OkResult> {
  return postJson<OkResult>('/api/machine/add', withOptional({ code: input.code }, { title: input.title }))
}

/** Let a machine go. */
export function removeMachine(id: string): Promise<OkResult> {
  return postJson<OkResult>('/api/machine/remove', { id })
}

// ── the conversation ────────────────────────────────────────────────────────────────

/**
 * Say something to the team lead. It reads and suggests; it starts nothing by itself.
 *
 * The turn carries the conversation it belongs to and nothing else. It does NOT carry the
 * project: a conversation is about the household, the daemon accepts no such field, and a
 * question narrowed by the window's current filter would answer about half the park while
 * looking like it answered about all of it.
 */
export function sendChat(input: { text: string; conversationId?: string }): Promise<ChatReply> {
  return postJson<ChatReply>('/api/chat', withOptional({ text: input.text }, { conversationId: input.conversationId }))
}

/** What has been said so far. */
export function getChatHistory(opts: { limit?: number } = {}): Promise<ChatHistory> {
  const q = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : ''
  return getJson<ChatHistory>(`/api/chat/history${q}`)
}

// ── bringing your own helpers in ────────────────────────────────────────────────────

/**
 * Look through the project for helpers and skills that already live there.
 *
 * The body is EMPTY by contract, and that is the whole of the answer to «read me another
 * folder»: the estate that is scanned is the project this daemon serves, so there is no
 * field a caller could point somewhere else. The scan writes nothing — calling it twice
 * is calling it once.
 */
export function scanImport(): Promise<ImportScanResult> {
  return postJson<ImportScanResult>('/api/import/scan', {})
}

/** Turn the chosen ones into drafts. They wait for a decision like every other draft. */
export function enrollImport(input: { selections: ImportSelection[] }): Promise<ImportEnrollResult> {
  return postJson<ImportEnrollResult>('/api/import/enroll', { selections: input.selections })
}

// ── the first run ───────────────────────────────────────────────────────────────────

/** Whether the household still needs setting up, and where the conversation stands. */
export function getOnboarding(): Promise<OnboardingState> {
  return getJson<OnboardingState>('/api/onboarding')
}

/** Record one answer and move on. An empty answer is a skip, not a failure. */
export function answerOnboarding(input: { step: number; key: string; text: string }): Promise<OnboardingState> {
  return postJson<OnboardingState>('/api/onboarding/answer', {
    step: input.step,
    key: input.key,
    text: input.text,
  })
}

/**
 * Close the first run.
 *
 * Two ways out, one door. By default the answers become the saved profile and the first
 * lessons — the writing exit. With `later`, the first run is simply set aside: the daemon
 * remembers on its own side that this person asked to be left alone, and NOTHING is written
 * into the project — no profile, no notes, not even the draft, so the interview can be picked
 * up later exactly where it stopped.
 */
export function completeOnboarding(opts: { later?: boolean } = {}): Promise<OnboardingResult> {
  return postJson<OnboardingResult>('/api/onboarding/complete', opts.later ? { later: true } : {})
}
