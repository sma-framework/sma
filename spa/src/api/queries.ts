import { QueryClient, useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import * as api from './client'
import { ApiError, isNotReady } from './client'
import type { EnqueueInput } from './client'
import { selectedProject, setSelectedProject } from './selected-project'
import type {
  AttemptLog,
  Backlog,
  ChatHistory,
  ChatConversations,
  CoordinationSnapshot,
  Diagnostics,
  DraftKind,
  HarnessPayload,
  ImportSelection,
  MemoryDrafts,
  MemoryLintReport,
  OnboardingState,
  PhaseCard,
  PhaseFolder,
  PhaseIndex,
  SearchResults,
  StatePayload,
  TaskDetail,
} from './types'

/**
 * queries.ts — how the window asks, and how often.
 *
 * There is ONE reading of the whole picture, on a steady rhythm, and every screen looks
 * at that same reading. Two screens can never disagree about what is going on, and ten
 * screens cost exactly one request every few seconds.
 *
 * Every row of that reading carries its project and its machine, so a screen showing one
 * project FILTERS the rows it already has. It does not ask a narrower question — that
 * would be a second reading, and a second reading is a second version of the truth.
 *
 * An action does not guess what it changed: it asks for the picture again, once, and the
 * next reading tells it. That is the only place a re-read is ordered by hand.
 */

/** The one reading everything else is derived from. */
export const STATE_KEY = ['state'] as const
export const HARNESS_KEY = ['harness'] as const
export const CHAT_KEY = ['chat'] as const
export const ONBOARDING_KEY = ['onboarding'] as const
/**
 * ГОЛОВА СЕМЕЙСТВА ЗАДАЧ — по тому же правилу, что и у фаз: обновление, заказанное на голове,
 * освежает КАЖДУЮ открытую карточку, и никому не приходится помнить, какие это были карточки.
 * Именно этого не хватало приёмке: «Одобрить» звало перечитать общую картину и не звало
 * перечитать саму карточку, на которой человек в этот момент смотрел.
 */
export const TASK_KEY = ['task'] as const
export const taskKey = (id: string) => ['task', id] as const
export const diffKey = (id: string) => ['diff', id] as const

/**
 * The keys of the V5.4 reads.
 *
 * Each family has a HEAD key and, where a read is about one thing, a key that extends it.
 * That is not decoration: a refresh ordered on the head refreshes the whole family, so an
 * answer to a question invalidates «the phases» and every phase card open at that moment,
 * without anything having to remember which cards those were.
 */
export const PHASE_KEY = ['phase'] as const
export const phaseIndexKey = ['phase', 'index'] as const
export const phaseKey = (id: string) => ['phase', id] as const
export const artifactKey = (path: string) => ['artifact', path] as const
/**
 * Папка фазы и один её файл — под тем же головным ключом, что и карточка.
 *
 * Обновление, заказанное на голове семейства, освежает и папку: каталог фазы меняется ровно
 * тогда, когда по фазе что-то произошло, и держать для него отдельную голову значило бы
 * помнить где-то ещё, что её тоже надо позвать.
 */
export const phaseFilesKey = (id: string) => ['phase', id, 'files'] as const
export const phaseFileKey = (id: string, path: string) => ['phase', id, 'files', path] as const
export const MEMORY_DRAFTS_KEY = ['memory', 'drafts'] as const
export const MEMORY_LINT_KEY = ['memory', 'lint'] as const
export const COORDINATION_KEY = ['coordination'] as const
export const BACKLOG_KEY = ['backlog'] as const
export const attemptKey = (id: string, tail: number) => ['attempt', id, tail] as const
export const searchKey = (q: string) => ['search', q] as const
export const DIAGNOSTICS_KEY = ['diagnostics'] as const

/** How often the picture is re-read, and how long a fresh reading is trusted. */
export const STATE_POLL_MS = 3000
export const STATE_STALE_MS = 2000

/**
 * A door that is declared but not filled in yet must not be knocked on repeatedly.
 *
 * That sentence has been here since the beginning and was not true: «not filled in yet» is
 * 501, and 501 is not below 500, so the only door the rule was written for was the one door
 * that kept being retried — three times, on every screen that asked, for as long as the slot
 * stayed empty. The whole release declares its addresses before it fills them, so that is a
 * lot of knocking on doors nobody is behind yet.
 *
 * `isNotReady` is asked rather than the number compared, because client.ts is where this
 * product decides what «not filled in yet» means, and a second copy of that decision is a
 * second thing to remember to change.
 */
function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  if (isNotReady(error)) return false // 501 — declared, not filled in: a refusal, not a fault
  if (error instanceof ApiError && error.status < 500) return false
  return failureCount < 2
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: retryUnlessRefused,
        refetchOnWindowFocus: false,
      },
    },
  })
}

// ── reading ─────────────────────────────────────────────────────────────────────────

/**
 * Чтение картины — с сужением по выбранному проекту.
 *
 * Вынесено из хука отдельной функцией по одной причине: это ПРОВОД, и провод должен быть
 * прогоняем без React. Сужение умели обе стороны с рождения — дверь читает `?project=`, клиент
 * умеет его построить, — и не звал никто; такой разрыв не должен уметь вернуться молча.
 *
 * Первое чтение вдобавок сеет зеркало: пока человек ничего не переключал, чем сузить, знает
 * только демон, и он это говорит в `activeProject`. Записываем ТОЛЬКО когда зеркало пусто —
 * иначе ответ, задержавшийся в полёте дольше, чем человек думал, переставил бы выбор назад.
 */
export async function stateQueryFn(): Promise<StatePayload> {
  const project = selectedProject()
  const payload = await api.getState(project ? { project } : {})
  if (!selectedProject() && payload.activeProject) setSelectedProject(payload.activeProject)
  return payload
}

/** The whole picture, kept fresh. This is the truth every screen renders from. */
export function useStateQuery() {
  return useQuery<StatePayload>({
    queryKey: STATE_KEY,
    queryFn: stateQueryFn,
    refetchInterval: STATE_POLL_MS,
    staleTime: STATE_STALE_MS,
  })
}

/** One task in full — opened only while its card is on screen. */
export function useTaskQuery(id: string | null) {
  return useQuery<TaskDetail>({
    queryKey: taskKey(id ?? ''),
    queryFn: () => api.getTask(id as string),
    enabled: !!id,
    staleTime: STATE_STALE_MS,
  })
}

/**
 * The changes one task made, as plain text. Read only while the card that shows them is
 * open, and left alone afterwards: a diff is finished work, it does not move under the eye.
 */
export function useDiffQuery(id: string | null) {
  return useQuery<string>({
    queryKey: diffKey(id ?? ''),
    queryFn: () => api.getDiff(id as string),
    enabled: !!id,
    staleTime: Infinity,
  })
}

/** The helpers, the skills, the connections, the drafts. Changes rarely; re-read on action. */
export function useHarnessQuery() {
  return useQuery<HarnessPayload>({
    queryKey: HARNESS_KEY,
    queryFn: () => api.getHarness(),
    staleTime: 30000,
  })
}

/**
 * Чтение книги разговора — с сужением по выбранному проекту, из того же зеркала и по тем же
 * причинам, что и чтение картины: провод должен быть прогоняем без React, а ключ чтения
 * остаётся ОДИН (`CHAT_KEY`) — перечитывание после смены проекта заказано инвалидацией того же
 * ключа, а не расщеплением кэша по проектам.
 *
 * Зеркало пустое — дверь спрашивают без сужения. Это «сужать нечем», а не «проект по
 * умолчанию»: книга приезжает целиком, включая ходы, у которых проекта нет вовсе.
 */
export async function chatHistoryQueryFn(): Promise<ChatHistory> {
  const project = selectedProject()
  return api.getChatHistory(project ? { project } : {})
}

/** What has been said in the conversation — of the project the window is looking at. */
export function useChatHistoryQuery(enabled = true) {
  return useQuery<ChatHistory>({
    queryKey: CHAT_KEY,
    queryFn: chatHistoryQueryFn,
    enabled,
    staleTime: STATE_STALE_MS,
  })
}

/**
 * ═══════════ СПИСОК РАЗГОВОРОВ И ОДНА ИЗ НИХ НА ЛЕНТЕ ═══════════
 *
 * Слово владельца 31.08: «почему разговор когда открываю у него нет истории? через раз
 * появляется, может нам разбить разговор на разные чаты?». Причина «через раз» была в том,
 * что окно читало книгу ЦЕЛИКОМ и показывало её одной лентой, а продолжало — последнюю нить;
 * всё остальное сказанное было не выбрать ничем, потому что выбирать было не из чего.
 *
 * Отсюда два чтения вместо одного, и граница между ними ровно та же, что в любом привычном
 * чате: СПИСОК бесед (кто есть) и ХОДЫ одной беседы (что в ней сказано). Ни то, ни другое
 * окно не считает само — иначе у списка и у ленты завелись бы две правды о том, какая беседа
 * последняя, и разошлись бы они молча.
 */
export const CHAT_LIST_KEY = ['chat', 'conversations'] as const

/**
 * Как часто список перечитывается сам. Живая точка обязана зажигаться и от хода, начатого НЕ
 * в этом окне — с телефона или во втором окне, — а колокола «беседа занялась» у демона нет и
 * заводить его ради точки не стоит. Свой ход красит точку мгновенно и без сети (экран знает
 * его сам), так что этот срок отвечает только за чужие ходы, и потому он неспешный.
 */
export const CHAT_LIST_POLL_MS = 10_000

/** Сколько ходов беседы окно поднимает, открывая её. Потолок двери — тот же. */
export const CHAT_THREAD_TURNS = 200

export async function chatConversationsQueryFn(): Promise<ChatConversations> {
  const project = selectedProject()
  return api.getChatConversations(project ? { project } : {})
}

/** КАКИЕ РАЗГОВОРЫ БЫЛИ — свежий первым, с живой точкой у занятых. */
export function useChatConversationsQuery(enabled = true) {
  return useQuery<ChatConversations>({
    queryKey: CHAT_LIST_KEY,
    queryFn: chatConversationsQueryFn,
    enabled,
    staleTime: STATE_STALE_MS,
    refetchInterval: CHAT_LIST_POLL_MS,
  })
}

/**
 * Ходы ОДНОЙ беседы. Сужает дверь по имени нити — то самое сужение, которого экрану не
 * хватало: без него на ленту приезжали вперемешку все разговоры проекта.
 */
export function useConversationTurnsQuery(conversationId: string | undefined) {
  return useQuery<ChatHistory>({
    queryKey: [...CHAT_KEY, 'thread', conversationId ?? 'none'],
    queryFn: () => api.getChatHistory({ conversationId: conversationId as string, limit: CHAT_THREAD_TURNS }),
    enabled: Boolean(conversationId),
    staleTime: STATE_STALE_MS,
  })
}

/**
 * Имя беседы, данное рукой. Список перечитывается ПОСЛЕ удачи, а не оптимистично: имя
 * подрезается дверью по своему потолку, и показать нужно то, что легло, а не то, что набрали.
 */
export function useRenameConversation() {
  const queryClient = useQueryClient()
  return useMutation<{ id: string; title: string | null }, Error, { conversationId: string; title: string }>({
    mutationFn: (input) => api.renameConversation(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CHAT_LIST_KEY })
    },
  })
}

/**
 * Whether the household still needs setting up. Asked once at start; a door that is not
 * filled in yet simply means «nothing to set up» — the window opens as usual.
 */
export function useOnboardingQuery() {
  return useQuery<OnboardingState>({
    queryKey: ONBOARDING_KEY,
    queryFn: () => api.getOnboarding(),
    staleTime: Infinity,
    retry: false,
  })
}

// ── acting ──────────────────────────────────────────────────────────────────────────

/** Ровно то, что делает всякое удавшееся действие: заказывает одно перечитывание картины. */
export function refreshAfterAction(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  alsoRefresh: readonly (readonly unknown[])[] = [],
): void {
  void queryClient.invalidateQueries({ queryKey: STATE_KEY })
  for (const key of alsoRefresh) void queryClient.invalidateQueries({ queryKey: key })
}

/**
 * Every action ends the same way: ask for the picture again. One re-read, ordered once,
 * at the only moment we know for certain that something changed.
 */
function useAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  alsoRefresh: readonly (readonly unknown[])[] = [],
): UseMutationResult<TResult, Error, TInput> {
  const queryClient = useQueryClient()
  return useMutation<TResult, Error, TInput>({
    mutationFn: run,
    onSuccess: () => refreshAfterAction(queryClient, alsoRefresh),
  })
}

/** Put a new task in the queue. */
export function useEnqueue() {
  return useAction<EnqueueInput, Awaited<ReturnType<typeof api.enqueue>>>((input) => api.enqueue(input))
}

/**
 * Accept finished work. Собственное имя машины не посылается — своя машина = отсутствие ключа.
 *
 * КАРТОЧКА ОСВЕЖАЕТСЯ ВМЕСТЕ С КАРТИНОЙ. Приёмка меняет ровно то, на что человек смотрит в
 * момент нажатия, а перечитывалась только общая картина: состояние «принято/слито» появлялось
 * на карточке лишь после обновления страницы руками (живой клик владельца 25.08). Голова
 * семейства зовётся вторым ключом, а не именем одной задачи, потому что действие знает имя
 * только в момент вызова, а список ключей у этого помощника один на весь хук.
 */
export function useApprove() {
  return useAction<{ taskId: string; machine?: string }, Awaited<ReturnType<typeof api.approve>>>(
    (input) => api.approve(input.taskId, { machine: input.machine }),
    [TASK_KEY],
  )
}

/** Send work back with a comment. Собственное имя машины не посылается — своя машина = отсутствие ключа. */
export function useReturnTask() {
  return useAction<Parameters<typeof api.returnTask>[0], Awaited<ReturnType<typeof api.returnTask>>>(
    (input) => api.returnTask(input),
    [TASK_KEY],
  )
}

/**
 * Ответить по вставшей сборке: пропустить элемент, повторить его или отменить батч.
 *
 * Ответ меняет саму очередь, поэтому картина перечитывается ровно один раз — тем же способом,
 * каким её перечитывает всякое другое действие окна.
 */
export function useBatchDecide() {
  return useAction<Parameters<typeof api.batchDecide>[0], Awaited<ReturnType<typeof api.batchDecide>>>((input) =>
    api.batchDecide(input),
  )
}

/**
 * Остановить эшелон или снять останов.
 *
 * Приказ меняет поведение диспетчера, поэтому картина перечитывается тем же способом, что и
 * после всякого другого действия окна: строки волны обязаны сразу сказать «встала» — иначе
 * человек нажал и не увидел ничего.
 */
export function useHoldWave() {
  return useAction<Parameters<typeof api.holdWave>[0], Awaited<ReturnType<typeof api.holdWave>>>((input) =>
    api.holdWave(input),
  )
}

/**
 * Попросить систему вывести слова задачи по формулировке.
 *
 * Картина НЕ перечитывается, и это не забывчивость: дверь ничего не ставит, поэтому
 * перечитывать нечего. Обновление после вызова, который ничего не изменил, сказало бы
 * человеку, что где-то что-то произошло.
 */
export function useSuggestWords() {
  return useMutation<Awaited<ReturnType<typeof api.suggestTaskWords>>, Error, string>({
    mutationFn: (title: string) => api.suggestTaskWords(title),
  })
}

/**
 * Попросить систему разобрать фразу на состав батча.
 *
 * Картина не перечитывается по той же причине, что и у вывода слов: дверь ничего не ставит.
 * Обновление после вызова, который ничего не изменил, сказало бы человеку, что где-то что-то
 * произошло — а произошло только предложение, и оно у него на глазах.
 */
export function useSuggestBatch() {
  return useMutation<Awaited<ReturnType<typeof api.suggestBatch>>, Error, string>({
    mutationFn: (phrase: string) => api.suggestBatch(phrase),
  })
}

/** Завести батч. Вот ЭТО меняет очередь — поэтому картина перечитывается. */
export function useCreateBatch() {
  return useAction<Parameters<typeof api.createBatch>[0], Awaited<ReturnType<typeof api.createBatch>>>((input) =>
    api.createBatch(input),
  )
}

/** Поправить слова живой задачи — карточка перечитывается вместе с общей картиной. */
export function useTaskWords(taskId: string | null) {
  return useAction<Parameters<typeof api.setTaskWords>[0], Awaited<ReturnType<typeof api.setTaskWords>>>(
    (input) => api.setTaskWords(input),
    taskId ? [taskKey(taskId)] : [],
  )
}

/** Ask for a new helper or skill to be drafted. */
export function useForge() {
  return useAction<{ kind: DraftKind; description: string; slugHint?: string }, Awaited<ReturnType<typeof api.forge>>>(
    (input) => api.forge(input),
    [HARNESS_KEY],
  )
}

/** Switch one helper on or off. */
export function useToggleAgent() {
  return useAction<{ id: string; enabled: boolean }, Awaited<ReturnType<typeof api.toggleAgent>>>(
    (input) => api.toggleAgent(input.id, input.enabled),
    [HARNESS_KEY],
  )
}

/** Say which helpers know a skill. */
export function useAssignSkill() {
  return useAction<{ skillId: string; workerIds: string[] }, Awaited<ReturnType<typeof api.assignSkill>>>(
    (input) => api.assignSkill(input.skillId, input.workerIds),
    [HARNESS_KEY],
  )
}

/** Write a skill into this machine's store. The list re-reads, so the new card is the proof. */
export function useCreateSkill() {
  return useAction<{ id: string; description: string; body: string }, Awaited<ReturnType<typeof api.createSkill>>>(
    (input) => api.createSkill(input),
    [HARNESS_KEY],
  )
}

/** Switch one connection on or off. */
export function useToggleMcp() {
  return useAction<{ serverId: string; enabled: boolean }, Awaited<ReturnType<typeof api.toggleMcp>>>(
    (input) => api.toggleMcp(input.serverId, input.enabled),
    [HARNESS_KEY],
  )
}

/**
 * Connect the owner's own Telegram bot, mint it a fresh pairing code, or disconnect it.
 *
 * The picture is re-read after every one of the three, and that is not decoration: the state
 * a person acts on next — «ждёт код», the code itself, «подключён к чату N» — lives in the
 * harness payload, so an action that did not refresh it would leave the screen showing the
 * link as it was BEFORE the press.
 */
export function useTelegramLink() {
  return useAction<{ action: api.TelegramAction; botToken?: string }, Awaited<ReturnType<typeof api.connectTelegram>>>(
    (input) => api.connectTelegram(input.action, input.botToken),
    [HARNESS_KEY],
  )
}

/**
 * Смена проекта целиком, одной функцией и без React: сказать двери, записать выбор в зеркало
 * (это делает сам вызов двери, и только при её согласии) и заказать перечитывание картины.
 *
 * Порядок здесь и есть смысл. Перечитывание заказывается ПОСЛЕ того, как зеркало переставлено:
 * запрос стартует заново и берёт из зеркала уже новый проект. Если бы перечитывание заказали
 * раньше, окно перечитало бы старое сужение и врало бы до следующего опроса — ровно тот
 * симптом, из-за которого затевалась эта работа.
 *
 * Вынесено из хука, чтобы провод «выбор → перечитывание» проверялся прогоном, а не чтением
 * обработчика успеха: обработчик можно переписать, и разрыв вернётся молча.
 *
 * Вместе с картиной перечитывается КНИГА РАЗГОВОРА: у нового проекта своя беседа, и книга,
 * оставшаяся от прежнего, — это чужая нить на экране, который уже про другое.
 */
export async function selectProjectAndRefresh(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  id: string,
): Promise<Awaited<ReturnType<typeof api.selectProject>>> {
  const result = await api.selectProject(id)
  // Книга И её оглавление: у другого проекта другие беседы, и список слева обязан смениться
  // вместе с лентой — иначе окно предложило бы вернуться в разговор, которого здесь нет.
  refreshAfterAction(queryClient, [CHAT_KEY, CHAT_LIST_KEY])
  return result
}

/**
 * КЛЮЧ СМЕНЫ ПРОЕКТА — чтобы про неё знал не только переключатель.
 *
 * Состояние действия принадлежит тому хуку, который его завёл, и до сих пор про идущую смену
 * знал ровно один компонент — сам переключатель. Между тем белеет от неё СОДЕРЖИМОЕ, а оно
 * живёт в раме, у другого хука. Именованный ключ — единственный способ спросить «идёт ли смена
 * прямо сейчас» из другого места, не заводя второго источника правды рядом с первым.
 */
export const PROJECT_SELECT_KEY = ['project', 'select'] as const

/** Look at another project. */
export function useSelectProject() {
  const queryClient = useQueryClient()
  return useMutation<Awaited<ReturnType<typeof api.selectProject>>, Error, { id: string }>({
    mutationKey: PROJECT_SELECT_KEY,
    mutationFn: (input) => selectProjectAndRefresh(queryClient, input.id),
  })
}

/**
 * На какой проект идёт смена прямо сейчас — или `null`, если ни на какой.
 *
 * Спрашивается у общей книги действий по ключу выше, поэтому рама узнаёт о смене ровно то же и
 * ровно тогда же, что и переключатель, — без провода между ними и без второго состояния,
 * которое однажды разошлось бы с первым.
 */
export function useProjectSwitchId(): string | null {
  const pending = useMutationState({
    filters: { mutationKey: PROJECT_SELECT_KEY, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id?: string } | undefined)?.id ?? null,
  })
  // Смена одна за раз — переключатель не принимает второго нажатия, — но книга отдаёт список, и
  // последняя запись честнее первой: она про то нажатие, которое было позже.
  return pending.length > 0 ? (pending[pending.length - 1] ?? null) : null
}

/** Take a folder into the register of projects. */
export function useAddProject() {
  return useAction<{ path: string; name?: string }, Awaited<ReturnType<typeof api.addProject>>>((input) =>
    api.addProject(input),
  )
}

/** Give a project a better name. */
export function useRenameProject() {
  return useAction<{ id: string; name: string }, Awaited<ReturnType<typeof api.renameProject>>>((input) =>
    api.renameProject(input.id, input.name),
  )
}

/** Connect a machine, and let one go. */
export function usePairMachine() {
  return useAction<void, Awaited<ReturnType<typeof api.pairMachine>>>(() => api.pairMachine())
}

export function useAddMachine() {
  return useAction<{ code: string; title?: string }, Awaited<ReturnType<typeof api.addMachine>>>((input) =>
    api.addMachine(input),
  )
}

export function useRemoveMachine() {
  return useAction<{ id: string }, Awaited<ReturnType<typeof api.removeMachine>>>((input) =>
    api.removeMachine(input.id),
  )
}

/**
 * Say something to the team lead.
 *
 * A turn is the ONE action in the window that does not re-read the picture afterwards:
 * a conversation changes nothing about the park, and asking every screen to refresh
 * because a question was asked would be a poll with extra steps. The transcript is not
 * re-read either — the answer came back in the response, and the screen already has it.
 */
export function useSendChat() {
  const queryClient = useQueryClient()
  return useMutation<
    Awaited<ReturnType<typeof api.sendChat>>,
    Error,
    { text: string; conversationId?: string; turnId?: string; taskId?: string }
  >({
    mutationFn: (input) => api.sendChat(input),
    onSuccess: () => {
      // The book has grown by two turns; a screen opened later reads them from it.
      void queryClient.invalidateQueries({ queryKey: CHAT_KEY, refetchType: 'none' })
      // СПИСОК — другое дело, и он перечитывается СЕЙЧАС: ход, начавший новую беседу, обязан
      // появиться слева строкой немедленно, а у продолженной — сдвинуться время последней
      // реплики. Это не «обновить картину парка»: разговор по-прежнему ничего в нём не меняет.
      void queryClient.invalidateQueries({ queryKey: CHAT_LIST_KEY })
    },
  })
}

/** Стоп для живого хода — судьба самого хода приедет ответом send-запроса (kind: 'stopped'). */
export function useStopChat() {
  return useMutation<{ stopped: boolean }, Error, { turnId: string }>({
    mutationFn: (input) => api.stopChat(input),
  })
}

/**
 * Руль бегущей задачи: поправка с объявленной судьбой — сказать сейчас / перебить сейчас /
 * после хода. Третья судьба не убивает никого: слово входит в идущий ход на ближайшей
 * границе вызова инструмента, а если инструментов больше не будет — остаётся ждать и едет
 * продолжением, той же сессией. Граница названа у самой двери (`client.ts`), и окно
 * повторяет её человеку словами, а не обещает больше, чем канал доставляет.
 */
export function useRedirectTask() {
  return useMutation<
    Awaited<ReturnType<typeof api.redirectTask>>,
    Error,
    { taskId: string; text: string; mode: 'interrupt' | 'queue' | 'steer' }
  >({
    mutationFn: (input) => api.redirectTask(input),
  })
}

/**
 * «Отменить задачу» — терминальная остановка. СВОЯ мутация, а не режим руля.
 *
 * Руль требует непустого текста: повесив на него отмену, мы заставили бы человека печатать,
 * чтобы остановить пожар. И картина после отмены перечитывается, как после всякого действия,
 * меняющего очередь: колокол об остановке демон не звонит (его словарь событий — зеркало,
 * которое сверяется буква-в-букву и правится отдельным решением), поэтому окно узнаёт правду
 * перечитыванием, а не намёком.
 */
export function useCancelTask(taskId: string | null) {
  return useAction<{ taskId: string }, Awaited<ReturnType<typeof api.cancelTask>>>(
    (input) => api.cancelTask(input),
    taskId ? [taskKey(taskId)] : [],
  )
}

/**
 * «Закрыть словами» — последнее слово о работе, которую делать не будут.
 *
 * КАРТОЧКА ОСВЕЖАЕТСЯ ВМЕСТЕ С КАРТИНОЙ, ровно как у приёмки: человек нажимает, глядя на эту
 * карточку, и она обязана сказать «закрыта» сама, а не после обновления страницы руками.
 * Колокола об этом демон не звонит (его словарь событий — зеркало, сверяемое буква-в-букву),
 * поэтому правду окно узнаёт перечитыванием — тем же способом, что и после отмены.
 */
export function useCloseTaskWithWords(taskId: string | null) {
  return useAction<Parameters<typeof api.closeTaskWithWords>[0], Awaited<ReturnType<typeof api.closeTaskWithWords>>>(
    (input) => api.closeTaskWithWords(input),
    taskId ? [taskKey(taskId)] : [TASK_KEY],
  )
}

/**
 * «Одобрить вызов» / «Отказать» — решение по билету, которым стоит живая сессия.
 * Ходит СУЩЕСТВУЮЩЕЙ дверью переписки и всегда в режиме `queue`: режим прерывания убил бы
 * ровно ту сессию, которую билет держит. Список маршрутов демона не меняется.
 */
export function useDecideToolTicket() {
  return useMutation<
    Awaited<ReturnType<typeof api.decideToolTicket>>,
    Error,
    { taskId: string; ticketId: string; decision: 'approve' | 'deny'; reason?: string }
  >({
    mutationFn: (input) => api.decideToolTicket(input),
  })
}

/** Look through the project for helpers that already live there, and take them in. */
export function useScanImport() {
  return useAction<void, Awaited<ReturnType<typeof api.scanImport>>>(() => api.scanImport())
}

export function useEnrollImport() {
  return useAction<{ selections: ImportSelection[] }, Awaited<ReturnType<typeof api.enrollImport>>>(
    (input) => api.enrollImport(input),
    [HARNESS_KEY],
  )
}

/** The first run: one answer at a time, then the profile. */
export function useAnswerOnboarding() {
  return useAction<{ step: number; key: string; text: string }, OnboardingState>(
    (input) => api.answerOnboarding(input),
    [ONBOARDING_KEY],
  )
}

export function useCompleteOnboarding() {
  return useAction<{ later?: boolean } | void, Awaited<ReturnType<typeof api.completeOnboarding>>>(
    (input) => api.completeOnboarding(input ?? {}),
    [ONBOARDING_KEY],
  )
}

// ═══════ the conveyor, the workbench, the release — one hook per door ═══════
//
// Declared in one go, for the same reason the addresses were: this file, client.ts and
// types.ts are SHARED, so a screen that had to add its own line here would collide with
// every neighbour being built the same week. From here on a screen owns its folder and
// nothing else, and the folders can be built in any order and at the same time.
//
// A hook declared is not a request made. Nothing below runs until a screen MOUNTS it, and
// the doors that are not filled in yet have no screen mounting them — so the window makes
// no traffic towards an empty room. On the day a door starts answering, the screen that
// was written against its shape needs no rewiring; and until then, a 501 is a refusal
// rather than a fault, so even a mounted read stops after one knock.

/** Every phase of the project, and where each stands. Read on the screen that shows them. */
export function usePhaseIndexQuery(enabled = true) {
  return useQuery<PhaseIndex>({
    queryKey: phaseIndexKey,
    queryFn: () => api.getPhaseIndex(),
    enabled,
    staleTime: STATE_STALE_MS,
  })
}

/** One phase in full — read only while its card is open. */
export function usePhaseQuery(id: string | null) {
  return useQuery<PhaseCard>({
    queryKey: phaseKey(id ?? ''),
    queryFn: () => api.getPhase(id as string),
    enabled: !!id,
    staleTime: STATE_STALE_MS,
  })
}

/**
 * One document, as text. A finished document does not move under the eye, so it is read once
 * and then left alone — the same treatment a diff gets, and for the same reason.
 */
/** Папка фазы: что лежит в её каталоге. Читается вместе с карточкой и стареет так же. */
export function usePhaseFilesQuery(id: string | null) {
  return useQuery<PhaseFolder>({
    queryKey: phaseFilesKey(id ?? ''),
    queryFn: () => api.getPhaseFiles(id as string),
    enabled: !!id,
    staleTime: STATE_STALE_MS,
  })
}

/**
 * Один файл папки фазы, текстом.
 *
 * В отличие от документа, файл рабочего каталога МОЖЕТ измениться под глазом — его правят из
 * терминала, пока окно открыто, — поэтому он стареет как всё остальное, а не читается один раз
 * навсегда.
 */
export function usePhaseFileQuery(id: string | null, path: string | null) {
  return useQuery<string>({
    queryKey: phaseFileKey(id ?? '', path ?? ''),
    queryFn: () => api.getPhaseFile(id as string, path as string),
    enabled: !!id && !!path,
    staleTime: STATE_STALE_MS,
  })
}

export function useArtifactQuery(path: string | null) {
  return useQuery<string>({
    queryKey: artifactKey(path ?? ''),
    queryFn: () => api.getArtifact(path as string),
    enabled: !!path,
    staleTime: Infinity,
  })
}

/** The lessons waiting for a yes. */
export function useMemoryDraftsQuery(enabled = true) {
  return useQuery<MemoryDrafts>({
    queryKey: MEMORY_DRAFTS_KEY,
    queryFn: () => api.getMemoryDrafts(),
    enabled,
    staleTime: 30000,
  })
}

/** What the corpus's own checker says. Changes only when the corpus does. */
export function useMemoryLintQuery(enabled = true) {
  return useQuery<MemoryLintReport>({
    queryKey: MEMORY_LINT_KEY,
    queryFn: () => api.getMemoryLint(),
    enabled,
    staleTime: 30000,
  })
}

/**
 * Who else has this checkout open, and where two of them overlap.
 *
 * Kept on the steady rhythm rather than read once: a collision that appears while a person is
 * looking at the screen is precisely the thing this screen exists to show, and a stale «всё
 * чисто» is worse here than anywhere else in the window.
 */
export function useCoordinationQuery(enabled = true) {
  return useQuery<CoordinationSnapshot>({
    queryKey: COORDINATION_KEY,
    queryFn: () => api.getCoordination(),
    enabled,
    refetchInterval: STATE_POLL_MS,
    staleTime: STATE_STALE_MS,
  })
}

/** The project's backlog file, as rows. It changes when a person edits the file. */
export function useBacklogQuery(enabled = true) {
  return useQuery<Backlog>({
    queryKey: BACKLOG_KEY,
    queryFn: () => api.getBacklog(),
    enabled,
    staleTime: 30000,
  })
}

/** How much of an attempt's tail is asked for by default. The daemon owns the ceiling. */
export const ATTEMPT_TAIL_DEFAULT = 200

/** The tail of one attempt, while its log is on screen — a running attempt keeps writing. */
export function useAttemptQuery(id: string | null, tail: number = ATTEMPT_TAIL_DEFAULT) {
  return useQuery<AttemptLog>({
    queryKey: attemptKey(id ?? '', tail),
    queryFn: () => api.getAttempt(id as string, { tail }),
    enabled: !!id,
    refetchInterval: STATE_POLL_MS,
    staleTime: STATE_STALE_MS,
  })
}

/**
 * One question, every corpus. An empty question asks nothing at all — the daemon would answer
 * an empty list, and a request whose answer is known is a request not worth making.
 */
export function useSearchQuery(q: string) {
  const query = q.trim()
  return useQuery<SearchResults>({
    queryKey: searchKey(query),
    queryFn: () => api.getSearch(query),
    enabled: query.length > 0,
    staleTime: STATE_STALE_MS,
  })
}

/**
 * The four facts a bug report may quote. They change only when the install does, so this is
 * read once and kept — and it is deliberately NOT retried into silence: a person who cannot
 * open the feedback window cannot report the bug that broke it.
 */
export function useDiagnosticsQuery(enabled = true) {
  return useQuery<Diagnostics>({
    queryKey: DIAGNOSTICS_KEY,
    queryFn: () => api.getDiagnostics(),
    enabled,
    staleTime: Infinity,
  })
}

/** Start a stage of a phase. It becomes a task, so the picture is what changes. */
export function usePhaseStage() {
  return useAction<Parameters<typeof api.postPhaseStage>[0], Awaited<ReturnType<typeof api.postPhaseStage>>>(
    (input) => api.postPhaseStage(input),
    [PHASE_KEY],
  )
}

/** Say what one line of acceptance looked like. */
export function usePhaseUat() {
  return useAction<Parameters<typeof api.postPhaseUat>[0], Awaited<ReturnType<typeof api.postPhaseUat>>>(
    (input) => api.postPhaseUat(input),
    [PHASE_KEY],
  )
}

/**
 * Answer one parked question. The whole phase family is re-read afterwards, because the
 * counts on the index move with every answer and the card the person is looking at moves too.
 */
export function useDecisionAnswer() {
  return useAction<Parameters<typeof api.postDecisionAnswer>[0], Awaited<ReturnType<typeof api.postDecisionAnswer>>>(
    (input) => api.postDecisionAnswer(input),
    [PHASE_KEY],
  )
}

/** Agree to ONE lesson. */
export function useMemoryApply() {
  return useAction<{ draftId: string }, Awaited<ReturnType<typeof api.postMemoryApply>>>(
    (input) => api.postMemoryApply(input),
    [MEMORY_DRAFTS_KEY, MEMORY_LINT_KEY],
  )
}

/** Rebuild the index over the corpus. */
export function useMemoryIndex() {
  return useAction<void, Awaited<ReturnType<typeof api.postMemoryIndex>>>(() => api.postMemoryIndex(), [
    MEMORY_LINT_KEY,
  ])
}

/** Release somebody else's reservation, with the reason that justified it. */
export function useClaimClear() {
  return useAction<{ claim: string; reason: string }, Awaited<ReturnType<typeof api.postClaimClear>>>(
    (input) => api.postClaimClear(input),
    [COORDINATION_KEY],
  )
}

/** Put a backlog line into the queue. */
export function useBacklogPromote() {
  return useAction<Parameters<typeof api.postBacklogPromote>[0], Awaited<ReturnType<typeof api.postBacklogPromote>>>(
    (input) => api.postBacklogPromote(input),
    [BACKLOG_KEY],
  )
}

/** Run the release gate. */
export function useShipGate() {
  return useAction<void, Awaited<ReturnType<typeof api.postShipGate>>>(() => api.postShipGate())
}

/** Publish, with both proofs. */
export function useShipPublish() {
  return useAction<Parameters<typeof api.postShipPublish>[0], Awaited<ReturnType<typeof api.postShipPublish>>>(
    (input) => api.postShipPublish(input),
  )
}

/** Take on a subscription. It arrives switched off, and the harness is what changed. */
export function useAccountAdd() {
  return useAction<Parameters<typeof api.postAccountAdd>[0], Awaited<ReturnType<typeof api.postAccountAdd>>>(
    (input) => api.postAccountAdd(input),
    [HARNESS_KEY],
  )
}

/** The conveyor's switch. */
export function usePipelineToggle() {
  return useAction<{ enabled: boolean }, Awaited<ReturnType<typeof api.postPipelineToggle>>>(
    (input) => api.postPipelineToggle(input.enabled),
    [HARNESS_KEY],
  )
}

/** The money stop. */
export function useBudgetSet() {
  return useAction<{ limit: number }, Awaited<ReturnType<typeof api.postBudgetSet>>>(
    (input) => api.postBudgetSet(input.limit),
    [HARNESS_KEY],
  )
}

/** A model, an effort, or both, for one helper. */
export function useAgentModel() {
  return useAction<Parameters<typeof api.postAgentModel>[0], Awaited<ReturnType<typeof api.postAgentModel>>>(
    (input) => api.postAgentModel(input),
    [HARNESS_KEY],
  )
}

/**
 * Ask about a newer version, or take it.
 *
 * The same hook does both, because the daemon's door does: `confirm` is the whole of the
 * difference, and splitting it into two hooks would put the decision «is this the one that
 * writes» in the window, where it does not belong. The diagnostics are re-read afterwards —
 * an applied update is exactly the moment the version a person would quote changes.
 */
export function useUpdateRun() {
  return useAction<{ confirm: boolean }, Awaited<ReturnType<typeof api.postUpdateRun>>>(
    (input) => api.postUpdateRun(input.confirm),
    [DIAGNOSTICS_KEY, HARNESS_KEY],
  )
}
