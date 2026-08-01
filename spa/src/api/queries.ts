import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import * as api from './client'
import { ApiError } from './client'
import type { EnqueueInput } from './client'
import type {
  ChatHistory,
  DraftKind,
  HarnessPayload,
  ImportSelection,
  OnboardingState,
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
export const taskKey = (id: string) => ['task', id] as const
export const diffKey = (id: string) => ['diff', id] as const

/** How often the picture is re-read, and how long a fresh reading is trusted. */
export const STATE_POLL_MS = 3000
export const STATE_STALE_MS = 2000

/** A door that is declared but not filled in yet must not be knocked on repeatedly. */
function retryUnlessRefused(failureCount: number, error: unknown): boolean {
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

/** The whole picture, kept fresh. This is the truth every screen renders from. */
export function useStateQuery() {
  return useQuery<StatePayload>({
    queryKey: STATE_KEY,
    queryFn: () => api.getState(),
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

/** What has been said in the conversation. */
export function useChatHistoryQuery(enabled = true) {
  return useQuery<ChatHistory>({
    queryKey: CHAT_KEY,
    queryFn: () => api.getChatHistory(),
    enabled,
    staleTime: STATE_STALE_MS,
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATE_KEY })
      for (const key of alsoRefresh) void queryClient.invalidateQueries({ queryKey: key })
    },
  })
}

/** Put a new task in the queue. */
export function useEnqueue() {
  return useAction<EnqueueInput, Awaited<ReturnType<typeof api.enqueue>>>((input) => api.enqueue(input))
}

/** Accept finished work. */
export function useApprove() {
  return useAction<{ taskId: string; machine?: string }, Awaited<ReturnType<typeof api.approve>>>((input) =>
    api.approve(input.taskId, { machine: input.machine }),
  )
}

/** Send work back with a comment. */
export function useReturnTask() {
  return useAction<Parameters<typeof api.returnTask>[0], Awaited<ReturnType<typeof api.returnTask>>>((input) =>
    api.returnTask(input),
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

/** Switch one connection on or off. */
export function useToggleMcp() {
  return useAction<{ serverId: string; enabled: boolean }, Awaited<ReturnType<typeof api.toggleMcp>>>(
    (input) => api.toggleMcp(input.serverId, input.enabled),
    [HARNESS_KEY],
  )
}

/** Look at another project. */
export function useSelectProject() {
  return useAction<{ id: string }, Awaited<ReturnType<typeof api.selectProject>>>((input) =>
    api.selectProject(input.id),
  )
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
  return useMutation<Awaited<ReturnType<typeof api.sendChat>>, Error, { text: string; conversationId?: string }>({
    mutationFn: (input) => api.sendChat(input),
    onSuccess: () => {
      // The book has grown by two turns; a screen opened later reads them from it.
      void queryClient.invalidateQueries({ queryKey: CHAT_KEY, refetchType: 'none' })
    },
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
  return useAction<void, Awaited<ReturnType<typeof api.completeOnboarding>>>(
    () => api.completeOnboarding(),
    [ONBOARDING_KEY],
  )
}
