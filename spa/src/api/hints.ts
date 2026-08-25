import type { QueryClient } from '@tanstack/react-query'
import { openEvents } from './client'
import { listenToFrames } from './events'
import type { FrameSource } from './events'
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

/**
 * A bell that tells us about one task.
 *
 * ЭКСПОРТИРОВАН, ПОТОМУ ЧТО СПРАШИВАЮТ ДВОЕ. Кроме заплатки на общую картину, этот же список
 * читает карточка открытой задачи: ей надо знать, что колокол — ПРО ЗАДАЧУ, чтобы перечитать
 * своё состояние. Второй список тех же семи имён однажды разошёлся бы с этим, и разошёлся бы
 * молча — карточка перестала бы обновляться на одном имени, и это выглядело бы как «иногда не
 * работает».
 */
export const TASK_EVENTS = new Set([
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

/** Someone who wants to SEE the bells, not just their effect on the cached picture. */
export type FrameListener = (evt: EventFrame) => void

const listeners = new Set<FrameListener>()

/**
 * onFrame(listener) — watch the bells as they arrive, and stop watching by calling what is
 * returned.
 *
 * ONE CHANNEL, WHOEVER IS WATCHING. «Живой поток» shows the bells themselves rather than
 * their effect, but a second EventSource for it would be a second channel to the same
 * daemon — twice the sockets, twice the reconnects, and two orders of the same events on one
 * screen. So the live layer, which already owns the one connection, hands out a copy of what
 * it hears; a screen that watches nothing costs nothing, because there is nothing to open.
 *
 * A listener is told AFTER the cached picture has been patched, so a screen that reacts to a
 * bell by reading the cache reads the patched one. A listener that throws is ignored: a
 * broken watcher must not cost the window its live channel.
 */
export function onFrame(listener: FrameListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function tellListeners(evt: EventFrame): void {
  for (const listener of listeners) {
    try {
      listener(evt)
    } catch {
      // a watcher's own failure is its own; the channel stays open
    }
  }
}

/** A live channel, as this file uses one: something to subscribe to, and a way to end it. */
export type HintsChannel = FrameSource & { close(): void }

/**
 * subscribeHints(queryClient) — open the live channel and patch the cached picture as
 * bells arrive. Returns a handle; closing it closes the channel.
 *
 * A dropped channel costs one poll of latency and nothing else, so a failure here is
 * quiet by design: the window keeps working on the poll alone.
 *
 * `openChannel` is a SEAM and nothing more: the window always gets `openEvents()`. It exists
 * because the only honest proof that a bell reaches this function is to hand it a REAL stream
 * off the daemon's own socket and watch a listener fire — and a browser's EventSource cannot
 * be pointed at one from a test. The daemon injects its clock and its timers for the same
 * reason.
 */
export function subscribeHints(
  queryClient: QueryClient,
  { openChannel = openEvents }: { openChannel?: () => HintsChannel } = {},
): HintsHandle {
  let source: HintsChannel | null = null
  try {
    source = openChannel()
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
    tellListeners(evt)
  }

  // BY NAME, EVERY NAME. The daemon names every frame it writes, and a named frame never
  // reaches a `message` listener — see events.ts for the whole of that story and for why the
  // fix belongs here rather than in the daemon's frozen wire.
  const detach = listenToFrames(source, onFrame)

  const handle = source
  return {
    close() {
      detach()
      handle.close()
    },
  }
}
