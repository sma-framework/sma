/**
 * events.ts — every name the daemon rings, and the single act of subscribing to them.
 *
 * ═══════════════ A NAMED FRAME IS NOT A «message» ═══════════════════════════════════
 *
 * The daemon writes each frame as `id: …` + `event: <name>` + `data: …`. By the server-sent
 * events specification a frame whose `event` field is non-empty is dispatched to the
 * listeners registered under THAT NAME, and the default `message` listener is not called at
 * all. The window had exactly one listener, and it was `message` — so from the day the hub
 * started naming its frames the live channel delivered NOTHING. Every screen quietly fell
 * back to the three-second poll and «Живой поток» read «Пока тихо» forever, on a daemon that
 * was ringing perfectly well. That is the expensive shape of defect the daemon's own list
 * warns about beside itself: it looks like «медленно», never like «сломано».
 *
 * ═══════════════ TWO WAYS OUT, AND WHY THIS IS THE ONE ══════════════════════════════
 *
 * The daemon could instead write a SECOND, unnamed copy of every frame, which the existing
 * `message` listener would pick up. It is rejected: the event vocabulary is FROZEN, and the
 * freeze covers the wire, not just the list of names — a duplicate copy doubles the bytes on
 * every connection, doubles what any other reader of the stream sees, and leaves the window
 * still unable to subscribe to one kind of bell without taking all of them. The side that
 * read the contract wrong is THIS side, so this is the side that changes: the window
 * subscribes BY NAME, to every name the daemon declares, and the daemon is not touched at all.
 *
 * ═══════════════ THE LIST IS A MIRROR, AND IT IS GUARDED ════════════════════════════
 *
 * The array below is the daemon's frozen vocabulary transcribed, in its order. A name that
 * is missing here is a bell that reaches the window and is dropped on the floor — the very
 * failure this file exists to end — so it is not left to care: a test on the daemon's side
 * asserts this array equals the daemon's own `EVENT_TYPES` exactly, and a new bell declared
 * there turns the suite red until it is written here.
 *
 * ═══════════════ THIS MODULE IMPORTS NOTHING ════════════════════════════════════════
 *
 * Deliberately. The wire test drives `listenToFrames` from the daemon's suite against a real
 * stream off a real socket, so this file has to load with no React, no query client and no
 * DOM behind it. Keep it that way.
 */
export const EVENT_NAMES = [
  'task.queued',
  'task.claimed',
  'task.running',
  'task.awaiting_approval',
  'task.approved',
  'task.returned',
  'task.failed',
  'worker.presence',
  'spend.updated',
  'harness.updated',
  'chat.reply',
  'machine.presence',
  'project.updated',
  'import.updated',
  // ── the five that came with the conveyor of phases ──
  'phase.stage',
  'discussion.updated',
  'memory.drafts',
  'coordination.updated',
  'ship.gate',
  // A release went out. Declared on the daemon's side after the release handler was found
  // ringing a bell its own vocabulary did not contain; it is here so the window hears it.
  'ship.published',
] as const

/**
 * The kinds of doorbell, as a type. Derived FROM the list above rather than written twice:
 * a screen that watches for a bell the daemon really rings cannot be written unless the name
 * is in the mirror, and the mirror is the thing the daemon's test checks. One source, one
 * guard.
 */
export type EventName = (typeof EVENT_NAMES)[number]

/**
 * The little of an `EventSource` this wiring actually uses. Narrow on purpose: it lets the
 * wire test hand in a stand-in that parses a real stream exactly as a browser does, without
 * a browser.
 */
export interface FrameSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
}

/**
 * listenToFrames(source, onFrame) — hear EVERY declared bell on one handler. Returns the
 * undo, which detaches exactly what was attached.
 *
 * One handler over many names, and not one handler per name: what a frame IS travels inside
 * its own `data`, so the caller reads the name from the payload it already parses, and this
 * function stays the one place that knows the subscription is by name at all.
 */
export function listenToFrames(
  source: FrameSource,
  onFrame: (event: MessageEvent<string>) => void,
): () => void {
  for (const name of EVENT_NAMES) source.addEventListener(name, onFrame)
  return () => {
    for (const name of EVENT_NAMES) source.removeEventListener(name, onFrame)
  }
}
