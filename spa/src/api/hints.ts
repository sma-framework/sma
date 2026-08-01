import type { QueryClient } from '@tanstack/react-query'
import { openEvents } from './client'
import { STATE_KEY } from './queries'
import type { EventFrame, StatePayload } from './types'

/**
 * hints.ts — the live layer, and the one rule that governs it.
 *
 * ═══════════════════ A HINT IS NOT THE TRUTH. THE POLL IS THE TRUTH. ═══════════════
 *
 * The daemon rings a bell when something changes. The bell carries a name and an
 * identifier — never a title, never a message, never an address. So a bell can be
 * BELIEVED only as far as «something moved»: it is applied to the cached picture as a
 * small, honest patch, so the screen answers immediately, and the next poll — which is
 * the truth — silently corrects anything the patch got wrong.
 *
 * Re-fetching on every bell is forbidden. It would put the window back to a request per
 * event, which is exactly the cost the hint layer exists to avoid, and it would make a
 * flood of bells into a flood of requests. The patch is free; the correction is already
 * scheduled. A bell we cannot patch is simply ignored — the poll will bring it.
 *
 * The patch is a pure function over the cached picture: it copies what it changes and
 * never edits in place, so React sees a new object and re-renders exactly once.
 */

/** A bell that tells us about one task. */
const TASK_EVENTS = new Set([
  'task.queued',
  'task.claimed',
  'task.running',
  'task.awaiting_approval',
  'task.approved',
  'task.returned',
  'task.failed',
])

/**
 * applyHint(old, evt) → the cached picture with the one thing this bell knows moved.
 * Pure. Returns the SAME object when there is nothing it can honestly change — the poll
 * will bring the rest within seconds.
 */
export function applyHint(old: StatePayload, evt: EventFrame): StatePayload {
  if (!old || !evt) return old

  if (TASK_EVENTS.has(evt.event) && evt.taskId) {
    const status = evt.status
    if (!status) return old
    const index = old.queue.findIndex((row) => row.id === evt.taskId)
    if (index < 0) return old
    const row = old.queue[index]
    if (row.status === status) return old
    const queue = old.queue.slice()
    queue[index] = { ...row, status: status as StatePayload['queue'][number]['status'] }
    return { ...old, queue }
  }

  if (evt.event === 'machine.presence' && evt.machineId && typeof evt.online === 'boolean') {
    const index = old.machines.findIndex((m) => m.id === evt.machineId)
    if (index < 0) return old
    const machine = old.machines[index]
    if (machine.online === evt.online) return old
    const machines = old.machines.slice()
    machines[index] = { ...machine, online: evt.online }
    return { ...old, machines }
  }

  // Everything else — a spend change, a helper switched, a conversation turn, a batch of
  // drafts — announces itself without saying what changed. There is nothing to patch,
  // and nothing to fetch: the poll already knows how to find out.
  return old
}

export interface HintsHandle {
  close(): void
}

/**
 * subscribeHints(queryClient) — open the live channel and patch the cached picture as
 * bells arrive. Returns a handle; closing it closes the channel.
 *
 * A dropped channel costs one poll of latency and nothing else, so a failure here is
 * quiet by design: the window keeps working on the poll alone.
 */
export function subscribeHints(queryClient: QueryClient): HintsHandle {
  let source: EventSource | null = null
  try {
    source = openEvents()
  } catch {
    return { close() {} }
  }

  const onFrame = (msg: MessageEvent<string>) => {
    let evt: EventFrame
    try {
      evt = JSON.parse(msg.data) as EventFrame
    } catch {
      return
    }
    queryClient.setQueryData<StatePayload>(STATE_KEY, (old) => (old ? applyHint(old, evt) : old))
  }

  source.addEventListener('message', onFrame)

  const handle = source
  return {
    close() {
      handle.removeEventListener('message', onFrame)
      handle.close()
    },
  }
}
