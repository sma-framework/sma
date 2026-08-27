// ФОРМА РЕШЕНИЯ — из того самого файла, который читает хук в процессе работника. Файл
// намеренно не имеет ни одного импорта (ни узловых встроенных, ни демона), поэтому он
// одинаково ложится и в сборку окна, и в хук: договорённость двух процессов о строке
// живёт в одном месте, а не в двух похожих.
import { formatDecision } from '../../../scripts/sma/lib/tool-decision.mjs'

import type {
  AccountAddResult,
  AgentModelResult,
  ApproveResult,
  AttemptLog,
  Backlog,
  BacklogPromoteResult,
  BudgetSetResult,
  CancelTaskResult,
  ChatHistory,
  ChatReply,
  ClaimClearResult,
  CoordinationSnapshot,
  DecisionAnswerResult,
  Diagnostics,
  DraftKind,
  EnqueueResult,
  ForgeResult,
  HarnessPayload,
  ImportEnrollResult,
  ImportScanResult,
  ImportSelection,
  MachinesPayload,
  MemoryApplyResult,
  MemoryDrafts,
  MemoryIndexResult,
  MemoryLintReport,
  OkResult,
  OnboardingResult,
  OnboardingState,
  PairingInvitation,
  PhaseCard,
  PhaseFolder,
  PhaseIndex,
  PhaseStage,
  PhaseStageResult,
  PhaseUatResult,
  PipelineToggleResult,
  ProjectsPayload,
  ProjectWriteResult,
  ReturnResult,
  SearchResults,
  ShipGateReport,
  ShipPublishResult,
  StatePayload,
  TaskDetail,
  TelegramLink,
  ToggleResult,
  UpdateReport,
} from './types'
import { setSelectedProject } from './selected-project'

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

/**
 * ОЖИДАНИЕ, КОТОРОЕ КОНЧИЛОСЬ: дверь не ответила за отведённый срок.
 *
 * Без срока запрос живёт столько, сколько живёт сокет браузера, — минуты. Живая приёмка
 * 26.08 измерила, чего это стоит: клик «Одобрить», сделанный в замирание демона, молча
 * лежал в очереди браузера и выстрелил через минуты — когда человек уже считал его
 * пропавшим и принял ДРУГОЕ решение. Опоздавший клик победил человека.
 *
 * Отменённый запрос — это ЧЕСТНОЕ НЕИЗВЕСТНО, не «не дошло»: демон мог уже держать его в
 * своей очереди и исполнить после того, как окно перестало ждать. Поэтому слова об этой
 * ошибке никогда не говорят «попробуйте ещё раз» — они велят сначала посмотреть на карточку.
 */
export class DeadlineError extends Error {
  constructor(seconds: number) {
    super(`окно не дождалось ответа за ${seconds} с`)
    this.name = 'DeadlineError'
  }
}

/** Само ожидание кончилось — в отличие от отказа, у которого есть статус и причина. */
export function isDeadline(err: unknown): boolean {
  return err instanceof DeadlineError
}

/**
 * Чтение может подождать полминуты — дольше человек сам уходит со страницы. Действию
 * даётся дольше всех: за дверью приёмки стоит слияние с прогоном тестов, и легитимные
 * три минуты нельзя объявлять просрочкой — иначе окно бросит работающую приёмку.
 */
const GET_DEADLINE_MS = 30_000
const POST_DEADLINE_MS = 180_000

async function fetchWithDeadline(path: string, init: RequestInit, deadlineMs: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deadlineMs)
  try {
    return await fetch(path, { ...init, signal: ctl.signal })
  } catch (err) {
    // Своя отмена получает своё имя; чужие сетевые ошибки проходят как были.
    if (ctl.signal.aborted) throw new DeadlineError(Math.round(deadlineMs / 1000))
    throw err
  } finally {
    clearTimeout(timer)
  }
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
  const res = await fetchWithDeadline(
    path,
    {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
    GET_DEADLINE_MS,
  )
  if (!res.ok) return failure(res)
  return (await res.json()) as T
}

async function getText(path: string): Promise<string> {
  const res = await fetchWithDeadline(path, { method: 'GET', credentials: 'same-origin' }, GET_DEADLINE_MS)
  if (!res.ok) return failure(res)
  return await res.text()
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithDeadline(
    path,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    },
    POST_DEADLINE_MS,
  )
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
  /** Что это за работа, словами. Необязательно: задача одним заголовком остаётся законной. */
  description?: string
  /** Что обещано. Одно поле, два вида: одна строка или список признаков. */
  acceptance?: string | string[]
  /** Another machine, by its name here. Absent means this one. */
  machine?: string
}

/**
 * Put a new task in the queue. The text becomes a task's title — never a command.
 * Собственное имя машины сюда не передаётся: своя машина — это отсутствие ключа (withOptional
 * опускает undefined), и тогда дверь выполняет работу здесь, а не ищет федерацию.
 */
export function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  return postJson<EnqueueResult>(
    '/api/enqueue',
    withOptional({ title: input.title, lane: input.lane }, {
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      priority: input.priority,
      description: input.description,
      acceptance: input.acceptance,
      machine: input.machine,
    }),
  )
}

/** Что система вывела по формулировке: черновик слов задачи. */
export interface SuggestedWords {
  ok: boolean
  /** Какой вид работы опознан по словам владельца («fix», «research», …, «unknown»). */
  kind: string
  /** Что система поняла — одной фразой, чтобы промах был виден до нажатия. */
  text: string
  draft: { description: string; acceptance: string[] }
}

/**
 * Попросить систему вывести слова задачи по формулировке.
 *
 * ЭТА ДВЕРЬ НИЧЕГО НЕ СТАВИТ. Она отвечает черновиком, который владелец правит и отправляет
 * сам — предложение и постановка это два нажатия, а не одно.
 */
export function suggestTaskWords(title: string): Promise<SuggestedWords> {
  return postJson<SuggestedWords>('/api/task/suggest', { title })
}

/**
 * Поправить слова живой задачи. Задача, чья работа уже закончилась, отвечает отказом:
 * переписывать обещание после того, как по нему судили, нельзя.
 */
export function setTaskWords(input: {
  taskId: string
  description?: string
  acceptance?: string | string[]
}): Promise<{ ok: boolean; taskId: string }> {
  return postJson('/api/task/words', withOptional({ taskId: input.taskId }, {
    description: input.description,
    acceptance: input.acceptance,
  }))
}

/**
 * Accept finished work. Only a person ever calls this.
 * Собственное имя машины сюда не передаётся — своя машина — это отсутствие ключа.
 */
export function approve(taskId: string, opts: { machine?: string } = {}): Promise<ApproveResult> {
  return postJson<ApproveResult>('/api/approve', withOptional({ taskId }, { machine: opts.machine }))
}

/**
 * Send work back with a comment. The comment travels as text, never as an instruction.
 * Собственное имя машины сюда не передаётся — своя машина — это отсутствие ключа.
 */
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

/**
 * СЛОВО ВЛАДЕЛЬЦА ПО ВСТАВШЕЙ СБОРКЕ — единственный выход из её молчания.
 *
 * Сломавшийся кусок останавливает батч и задаёт вопрос: пропустить его, повторить или отменить
 * сборку. Пока владелец не ответил, очередь не выдаёт ни одного куска и ничего не повторяется
 * само. Три слова приезжают в окно ИМЕНАМИ от движка и той же тройкой принимаются здесь —
 * кнопка, ответ которой не принимает ни одна дверь, это кнопка, которая молча ничего не делает.
 * `itemId` не нужен только отмене: она про всю сборку, а не про кусок.
 */
export function batchDecide(input: {
  batchId: string
  decision: 'skip' | 'retry' | 'cancel'
  itemId?: string
}): Promise<{ ok: boolean; batchId: string; decision: string; itemId?: string }> {
  return postJson('/api/batch/decide', withOptional({ batchId: input.batchId, decision: input.decision }, {
    itemId: input.itemId,
  }))
}

/**
 * Одна запись предложенного состава. Природа названа в самой записи и не выводится экраном:
 * `backlog` — существующая строка бэклога (её слова взяты из файла), `subtask` — кусок фразы
 * владельца. `why` есть у каждой: подбор по словам ошибается, а молчаливый подбор ошибается
 * незаметно — промах обязан быть виден ДО подтверждения состава.
 */
export interface BreakdownItem {
  kind: 'backlog' | 'subtask'
  /** Идентификатор строки бэклога — только у записи бэклога. */
  id?: string
  title: string
  why: string
}

/**
 * Уточняющий вопрос системы вместо состава. Постановка у нас — дискуссия, и «из чего это
 * состоит?» законный её ход; выдуманный состав — нет. Форма вариантов не сочиняет: их список
 * приходит от двери и сегодня пуст, то есть ответ даётся своими словами.
 */
export interface BreakdownQuestion {
  id: string
  area?: string
  question: string
  context?: string
  options: { id: string; label: string }[]
}

/** Что система предложила по фразе: черновик состава батча либо вопрос о нём. */
export interface SuggestedBatch {
  ok: boolean
  /** Что система поняла — одной фразой, чтобы промах был виден до подтверждения. */
  text: string
  question: BreakdownQuestion | null
  draft: { title: string; items: BreakdownItem[] }
}

/**
 * Попросить систему разобрать фразу на состав батча.
 *
 * ЭТА ДВЕРЬ НИЧЕГО НЕ СТАВИТ — она отвечает черновиком, а батч заводит соседняя дверь по
 * отдельному нажатию владельца. Предложение и постановка это два действия, а не одно.
 */
export function suggestBatch(phrase: string): Promise<SuggestedBatch> {
  return postJson<SuggestedBatch>('/api/batch/suggest', { phrase })
}

/**
 * Завести батч: одна фраза владельца и элементы, которые она называет. Элемент — либо
 * идентификатор строки бэклога, либо своя подзадача текстом; оба вида законны в одном списке.
 */
export function createBatch(input: {
  title: string
  items: string[]
  lane?: string
}): Promise<{ ok: boolean; id: string; items: string[] }> {
  return postJson('/api/batch', withOptional({ title: input.title, items: input.items }, { lane: input.lane }))
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

/** The three words the Telegram door answers to — the door's own vocabulary, mirrored. */
export type TelegramAction = 'connect' | 'code' | 'disconnect'

/**
 * Connect the owner's own bot, re-issue its pairing code, or let it go.
 *
 * THE TOKEN TRAVELS ONE WAY. It goes out in the body of `connect` and never comes back: the
 * answer is the same read model the harness carries, whose token field is four characters
 * long. There is no argument to this function, and no shape of its result, that reads a
 * credential back out of the daemon — by the time the window could ask, the whole value is
 * already gone from every payload the door knows how to build.
 */
export function connectTelegram(action: TelegramAction, botToken?: string): Promise<OkResult & { telegram: TelegramLink }> {
  return postJson<OkResult & { telegram: TelegramLink }>(
    '/api/connection/telegram',
    withOptional({ action }, { botToken: action === 'connect' ? botToken : undefined }),
  )
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

/**
 * Look at another project.
 *
 * The choice is mirrored into `selected-project` only AFTER the daemon has accepted it: the
 * owner of this fact is the daemon's config, and a mirror running ahead of its subject would
 * narrow the next reading by a project the daemon never switched to. A refused call leaves the
 * mirror exactly as it was.
 */
export function selectProject(id: string): Promise<OkResult> {
  return postJson<OkResult>('/api/project/select', { id }).then((res) => {
    setSelectedProject(id)
    return res
  })
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
 * PROJECT — и это не значит, что ход проекту не принадлежит: принадлежит, и записан вместе с
 * ним. Имя ставит ДВЕРЬ из конфига (тем же `doorProject`, которым штампуется задача), потому
 * что проект хода — это то, на что человек смотрел, а не поле, которое волен назвать
 * вызывающий. Сужается по нему ЧТЕНИЕ книги (`getChatHistory`), а не эта отправка.
 */
export function sendChat(input: {
  text: string
  conversationId?: string
  turnId?: string
  /**
   * Карточка, С КОТОРОЙ открыт разговор — ИДЕНТИФИКАТОР и ничего больше.
   *
   * Снимок состояния собирает дверь по своему же реестру: то, что прислало бы окно, было бы
   * вторым рассказом о задаче рядом с карточкой, и разошлись бы они молча.
   */
  taskId?: string
}): Promise<ChatReply> {
  return postJson<ChatReply>(
    '/api/chat',
    withOptional(
      { text: input.text },
      { conversationId: input.conversationId, turnId: input.turnId, taskId: input.taskId },
    ),
  )
}

/**
 * Стоп for a live chat turn. The turn id is CLIENT-minted and travels with the send, so
 * this door has a name for the turn before the send answers. `stopped: false` is an honest
 * «уже нечего останавливать», not an error.
 */
export function stopChat(input: { turnId: string }): Promise<{ stopped: boolean }> {
  return postJson<{ stopped: boolean }>('/api/chat/stop', { turnId: input.turnId })
}

/**
 * The steering wheel for a running task: a typed correction with a DECLARED fate.
 *
 * 'interrupt' kills the live child and the same session resumes with the correction;
 * 'queue' lets the current run finish and the correction rides the continuation;
 * 'steer' hands the word to the RUNNING turn and kills nothing at all.
 *
 * WHAT THE THIRD FATE HONESTLY DELIVERS, AND WHERE IT STOPS. The word reaches a live turn
 * on the next TOOL-CALL BOUNDARY — that is the one moment the running session takes an
 * outside word, and there is no other. So: a turn that goes on to call a tool gets the word
 * mid-flight, in the same session, with everything it already holds in mind; a turn that
 * makes no further tool call finishes without it, and the word stays waiting and rides the
 * continuation instead. Both endings are the same session and neither loses the word.
 *
 * That boundary is stated wherever this fate is offered to a person, and it is stated as a
 * boundary rather than softened into «доедет». Promising more than the channel delivers
 * would make the third fate a quieter version of the first — which is the exact substitution
 * this door was extended to avoid.
 *
 * `live` in the answer says whether anything was actually killed right now — for the third
 * fate it is honestly false, because nothing was.
 *
 * A worker whose lane has no tool-call boundary of ours gets a 400 from the door with the
 * two fates that DO reach it. Those words are the door's own; the window shows them as-is.
 */
export function redirectTask(input: {
  taskId: string
  text: string
  mode: 'interrupt' | 'queue' | 'steer'
}): Promise<{ accepted: boolean; id: string; mode: string; live: boolean }> {
  return postJson('/api/redirect', { taskId: input.taskId, text: input.text, mode: input.mode })
}

/**
 * «Отменить задачу» — терминальная остановка работы человеком.
 *
 * СВОЙ ВЫЗОВ, А НЕ РЕЖИМ РУЛЯ. Повесить отмену на дверь поправки было нельзя: та требует
 * НЕПУСТОГО текста, то есть заставляла бы человека что-нибудь напечатать, чтобы остановить
 * пожар. Остановка — это не поправка курса: после неё курса не будет вовсе.
 *
 * ОТВЕТ ЧИТАЕТСЯ ТРЕМЯ ФАКТАМИ, а не одним. Дверь сначала убивает живого ребёнка и лишь
 * потом закрывает строку, поэтому «убили» и «закрыли» — разные вещи, и окно обязано уметь
 * сказать обе.
 */
export function cancelTask(input: { taskId: string }): Promise<CancelTaskResult> {
  return postJson<CancelTaskResult>('/api/task/cancel', { taskId: input.taskId })
}

/**
 * «Одобрить вызов» / «Отказать» — решение по билету, которым СТОИТ живая сессия.
 *
 * ЧЕРЕЗ ДВЕРЬ, КОТОРАЯ УЖЕ ЕСТЬ. Новой двери у демона для этого не заводится: решение —
 * это строка, а доставлять строку живой задаче руль уже умеет. Список маршрутов не меняется
 * ни на одну запись, и сторож соседнего проекта не задевается вовсе.
 *
 * СТРОКА СОБИРАЕТСЯ ПРОИЗВОДИТЕЛЕМ ПРОДУКТА, а не склеивается здесь. Хук на той стороне
 * разбирает её своим разборщиком из ТОГО ЖЕ файла — договорённость двух процессов о форме
 * не имеет права жить в двух местах.
 *
 * И РЕЖИМ ВСЕГДА `queue`, НИКОГДА `interrupt`. Прерывание убивает живого ребёнка, то есть
 * «Одобрить» уничтожило бы ровно ту сессию, которую билет держит, и смысл билета исчез бы.
 * Режим здесь ЗАШИТ, а не принят параметром: у этого пути не должно существовать второго
 * значения, которое кто-нибудь однажды передаст.
 */
export function decideToolTicket(input: {
  taskId: string
  ticketId: string
  decision: 'approve' | 'deny'
  reason?: string
}): Promise<{ accepted: boolean; id: string; mode: string; live: boolean }> {
  return redirectTask({
    taskId: input.taskId,
    text: formatDecision({ ticketId: input.ticketId, decision: input.decision, reason: input.reason }),
    mode: 'queue',
  })
}

/**
 * «Останови волну 2» — приказ об ОДНОМ эшелоне ОДНОЙ фазы, и адрес всегда обе половины.
 *
 * Ждущие задачи этой волны перестают выдаваться, живые получают поправку «после хода»:
 * доводят текущий шаг и встают, не теряя сессии. `already` говорит честно, что реестр не
 * изменился — второе нажатие той же кнопки ничего нового не значит.
 */
export function holdWave(input: {
  phase: string
  wave: string | number
  action: 'hold' | 'release'
}): Promise<{ ok: boolean; phase: string; wave: string; action: string; already: boolean }> {
  return postJson('/api/wave/hold', { phase: input.phase, wave: String(input.wave), action: input.action })
}

/**
 * What has been said so far — сужено проектом, если он назван.
 *
 * Слово владельца: «разговор по разным проектам тоже разный должен быть». Сужает ДВЕРЬ, а не
 * окно: она читает книгу и знает, при каком проекте сказан каждый ход. Без `project` дверь
 * отдаёт книгу целиком — это честное «сужать нечем», а не «покажи всё на всякий случай».
 */
export function getChatHistory(opts: { limit?: number; project?: string } = {}): Promise<ChatHistory> {
  const parts = [
    ...(opts.limit ? [`limit=${encodeURIComponent(String(opts.limit))}`] : []),
    ...(opts.project ? [`project=${encodeURIComponent(opts.project)}`] : []),
  ]
  return getJson<ChatHistory>(`/api/chat/history${parts.length ? `?${parts.join('&')}` : ''}`)
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

// ── the conveyor of phases ──────────────────────────────────────────────────────────

/**
 * The reserved segment that means «all of them» on the phase card's own address.
 *
 * The index of phases rides the CARD's route rather than a route of its own — the daemon
 * admits this one literal where an identifier goes, exactly as the toggle door admits one
 * reserved id for «the whole shipped team». It is written down here, once, so that a screen
 * asking for the index cannot spell it differently from the daemon that answers.
 */
export const PHASE_INDEX_SEGMENT = 'index'

/** Every phase of the project, and where each one stands. */
export function getPhaseIndex(): Promise<PhaseIndex> {
  return getJson<PhaseIndex>(`/api/phase/${PHASE_INDEX_SEGMENT}`)
}

/** One phase in full: its stages, its questions, its plans and what they concluded. */
export function getPhase(id: string): Promise<PhaseCard> {
  return getJson<PhaseCard>(`/api/phase/${encodeURIComponent(id)}`)
}

/** Start a stage of a phase. It becomes a task in the queue like any other work. */
export function postPhaseStage(input: { phase: string; stage: PhaseStage }): Promise<PhaseStageResult> {
  return postJson<PhaseStageResult>('/api/phase/stage', { phase: input.phase, stage: input.stage })
}

/** Say what one line of a phase's acceptance looked like to a person. */
export function postPhaseUat(input: {
  phase: string
  item: string
  verdict: 'pass' | 'fail'
  note?: string
}): Promise<PhaseUatResult> {
  return postJson<PhaseUatResult>(
    '/api/phase/uat',
    withOptional({ phase: input.phase, item: input.item, verdict: input.verdict }, { note: input.note }),
  )
}

/**
 * Answer one parked question.
 *
 * The answer is recorded first and only then, if it was the last one open, does the round it
 * was blocking wake up. So answering is always safe to do: nothing starts because a person
 * typed, only because a person FINISHED.
 */
export function postDecisionAnswer(input: {
  phase: string
  questionId: string
  taskId?: string
  optionId?: string
  freeText?: string
}): Promise<DecisionAnswerResult> {
  return postJson<DecisionAnswerResult>(
    '/api/decision/answer',
    withOptional({ phase: input.phase, questionId: input.questionId }, {
      taskId: input.taskId,
      optionId: input.optionId,
      freeText: input.freeText,
    }),
  )
}

/**
 * Read one document of the project, as plain text.
 *
 * The path travels RELATIVE and the daemon accepts exactly one root; rendering is the
 * screen's business, so what comes back is text and never markup.
 */
export function getArtifact(path: string): Promise<string> {
  return getText(`/api/artifact?path=${encodeURIComponent(path)}`)
}

/**
 * Папка одной фазы: её каталог как дерево имён.
 *
 * Содержимого файлов здесь нет — дерево это оглавление, и файл читается отдельным вопросом
 * ниже. Так экран не тянет весь каталог ради одного открытого файла.
 */
export function getPhaseFiles(id: string): Promise<PhaseFolder> {
  return getJson<PhaseFolder>(`/api/phase/${encodeURIComponent(id)}/files`)
}

/**
 * Один файл папки фазы, ТЕКСТОМ.
 *
 * Путь берётся из дерева и едет к двери нетронутым: дверь принимает ровно одно написание пути
 * и на всякое другое отвечает одним и тем же отказом — собирать путь на экране значило бы
 * заводить второе написание.
 */
export function getPhaseFile(id: string, path: string): Promise<string> {
  return getText(`/api/phase/${encodeURIComponent(id)}/files?file=${encodeURIComponent(path)}`)
}

// ── the memory workbench ────────────────────────────────────────────────────────────

/** The lessons waiting for a yes, each with the change it proposes. */
export function getMemoryDrafts(): Promise<MemoryDrafts> {
  return getJson<MemoryDrafts>('/api/memory/drafts')
}

/**
 * Agree to ONE lesson. There is no function here that applies them all, because there is no
 * such door — a corpus changed by one click nobody read is a corpus nobody trusts.
 */
export function postMemoryApply(input: { draftId: string }): Promise<MemoryApplyResult> {
  return postJson<MemoryApplyResult>('/api/memory/apply', { draftId: input.draftId, accept: true })
}

/** Rebuild the index over the corpus. */
export function postMemoryIndex(): Promise<MemoryIndexResult> {
  return postJson<MemoryIndexResult>('/api/memory/index', {})
}

/** What the corpus's own checker says about it. */
export function getMemoryLint(): Promise<MemoryLintReport> {
  return getJson<MemoryLintReport>('/api/memory/lint')
}

// ── who else is working here ────────────────────────────────────────────────────────

/** The terminals open on this checkout, what they reserved, and where two of them overlap. */
export function getCoordination(): Promise<CoordinationSnapshot> {
  return getJson<CoordinationSnapshot>('/api/coordination')
}

/** Release somebody else's reservation. The reason is required: it is the evidence, not a label. */
export function postClaimClear(input: { claim: string; reason: string }): Promise<ClaimClearResult> {
  return postJson<ClaimClearResult>('/api/claim/clear', { claim: input.claim, reason: input.reason })
}

// ── the backlog ─────────────────────────────────────────────────────────────────────

/** The project's own backlog file, read as rows. */
export function getBacklog(): Promise<Backlog> {
  return getJson<Backlog>('/api/backlog')
}

/** Put a backlog line into the queue. The line stays in the file — that file is a hand, not a store. */
export function postBacklogPromote(input: { id: string; lane: string; title?: string }): Promise<BacklogPromoteResult> {
  return postJson<BacklogPromoteResult>(
    '/api/backlog/promote',
    withOptional({ id: input.id, lane: input.lane }, { title: input.title }),
  )
}

// ── watching one attempt ────────────────────────────────────────────────────────────

/** The tail of one attempt's log. `tail` asks for a length; the daemon owns the ceiling. */
export function getAttempt(id: string, opts: { tail?: number } = {}): Promise<AttemptLog> {
  const q = opts.tail ? `?tail=${encodeURIComponent(String(opts.tail))}` : ''
  return getJson<AttemptLog>(`/api/attempt/${encodeURIComponent(id)}${q}`)
}

// ── the release ─────────────────────────────────────────────────────────────────────

/** Run the gate. It reports its steps as they finish; this answers with the run itself. */
export function postShipGate(): Promise<ShipGateReport> {
  return postJson<ShipGateReport>('/api/ship/gate', {})
}

/**
 * Publish — the most dangerous act this product can perform, and the only one that asks for
 * two separate proofs: the receipt of a GREEN gate run, and the version string typed out in
 * full. Both are checked by the daemon; neither is a checkbox.
 */
export function postShipPublish(input: { gateReceipt: string; confirm: string }): Promise<ShipPublishResult> {
  return postJson<ShipPublishResult>('/api/ship/publish', {
    gateReceipt: input.gateReceipt,
    confirm: input.confirm,
  })
}

// ── one question, every corpus ──────────────────────────────────────────────────────

/** Ask once and hear from every corpus at once. An empty question is an empty answer. */
export function getSearch(q: string): Promise<SearchResults> {
  return getJson<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`)
}

// ── the machine itself: accounts, the conveyor, the money, the models ───────────────

/**
 * Take on a subscription.
 *
 * What crosses this door is the NAME of the environment variable that holds the token, never
 * the token. The account arrives switched off and the answer says so, together with the login
 * a human then runs in his own terminal — the daemon does not run it, and could not.
 */
export function postAccountAdd(input: {
  id: string
  lane: string
  configDir: string
  oauthTokenEnv: string
  spendLogsDir?: string
}): Promise<AccountAddResult> {
  return postJson<AccountAddResult>(
    '/api/account/add',
    withOptional(
      {
        id: input.id,
        lane: input.lane,
        configDir: input.configDir,
        oauthTokenEnv: input.oauthTokenEnv,
      },
      { spendLogsDir: input.spendLogsDir },
    ),
  )
}

/**
 * The conveyor's switch. `enabled` is strictly a word — the daemon refuses `"true"` and `1`,
 * because a truthy string shown as «on» over a machine that is not running is the exact lie
 * this switch exists to prevent.
 */
export function postPipelineToggle(enabled: boolean): Promise<PipelineToggleResult> {
  return postJson<PipelineToggleResult>('/api/pipeline/toggle', { enabled })
}

/**
 * The reserved `lane` of the money stop, meaning «the whole machine».
 *
 * There is exactly one budget stop in this product and it is machine-wide. The field exists
 * so the screen can say WHICH stop it is setting; any other value is refused, rather than
 * written as a limit nothing would ever consult.
 */
export const BUDGET_SCOPE_ALL = 'all'

/** How much of the founder's money the machine may spend on the paid channel in a month. */
export function postBudgetSet(limit: number): Promise<BudgetSetResult> {
  return postJson<BudgetSetResult>('/api/budget/set', { lane: BUDGET_SCOPE_ALL, limit })
}

/** Assign a model, or an effort, or both, to one helper. Clearing one back is not an act yet. */
export function postAgentModel(input: { agent: string; model?: string; effort?: string }): Promise<AgentModelResult> {
  return postJson<AgentModelResult>(
    '/api/agent/model',
    withOptional({ agent: input.agent }, { model: input.model, effort: input.effort }),
  )
}

// ── the house of the system ─────────────────────────────────────────────────────────

/**
 * The four facts a bug report may quote.
 *
 * The window must send EXACTLY what this returns and nothing else — not the project's name,
 * not the current screen, not a task title. The four exist because the destination is a
 * public issue, and the daemon's guard covers the daemon's half only.
 */
export function getDiagnostics(): Promise<Diagnostics> {
  return getJson<Diagnostics>('/api/diagnostics')
}

/**
 * Ask about a newer version, and — only on an explicit `true` — take it.
 *
 * `confirm` is required either way. `false` compares versions and writes nothing; `true` runs
 * the ordinary installer, which is the one write path there is. Nothing here happens on a
 * timer, at boot, or by itself.
 */
export function postUpdateRun(confirm: boolean): Promise<UpdateReport> {
  return postJson<UpdateReport>('/api/update/run', { confirm })
}
