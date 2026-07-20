/**
 * events.mjs — the SSE event hub + the durable-commit event decorator: the Phase 9.6
 * SPA's live-hint foundation (Phase 9.5 Plan 08, Task 4; D-9.5-02/05 РЕВИЗИЯ 16.07.2026).
 *
 * ═══════════════════════ ABSORPTION NOTE (IDEA-level, zero code copied) ═══════════
 * This event VOCABULARY is our analog of Paperclip's heartbeat.run.* / agent.status
 * push vocabulary — IDEA-level absorption only; NO code is copied from their MIT tree.
 * If any LITERAL code is ever absorbed here (or in the 9.6 SPA), it takes the
 * THIRD-PARTY-LICENSES.md attribution step exactly as plan 9.5-03 did for the CAS
 * pattern. Nothing in this file derives from a third-party source.
 *
 * ═══════════════════════ HINT, NEVER TRUTH ═══════════════════════════════════════
 * The governing posture (RESEARCH State-of-the-Art): a push is an OPTIONAL HINT; the
 * durable queue + a poll of GET /api/state is the truth. So:
 *   - The hub holds ONLY live response handles + a monotonic per-boot event id. It holds
 *     NO task state. A daemon restart drops every connection and LOSES NOTHING — clients
 *     re-derive from GET /api/state (D-9.5-02 statelessness is preserved because truth
 *     never lives in the hub).
 *   - EMIT-AFTER-DURABLE-COMMIT: wrapAdapterWithEvents awaits the underlying durable call
 *     FIRST, then emits. A dropped emit only costs a client one poll of latency; it can
 *     never lose or reorder truth (the ordering test proves zero emits before the durable
 *     promise resolves).
 *   - EXPLICIT-PICK PAYLOADS: an event frame carries ONLY {id, event, taskId?, workerId?,
 *     status?, ts} — never titles, notes, diffs, tokens, or receipt bodies (T-9.5-35).
 *     The SPA fetches details via the auth'd read endpoints.
 *   - DoS BOUNDS: maxClients cap (→ the handler answers 503), a 25s heartbeat, and
 *     reap-on-write-failure keep stale handles from accumulating (T-9.5-36).
 *
 * The decorator's per-task «running» dedup map is HINT PLUMBING — loss-safe, never
 * consulted for truth (losing it only risks one extra task.running frame). The
 * statelessness law (no Map/Set) governs the tick (loop.mjs) and the composition root
 * (main.mjs), NOT this hint layer.
 *
 * Node built-ins only; clock + the timer functions are injectable for deterministic
 * tests. Zero deps; zero network beyond the response handles it is handed.
 */

/** The frozen event vocabulary — the SPA contract (9.6). Emitting an unlisted event is a no-op. */
export const EVENT_TYPES = Object.freeze([
  'task.queued',
  'task.claimed',
  'task.running',
  'task.awaiting_approval',
  'task.approved',
  'task.returned',
  'task.failed',
  'worker.presence',
  'spend.updated',
  'harness.updated', // D-9.5-09: a harness config/registry change hint (agents/skills/mcp)
])

/** Dedup window for the touch→task.running hint (mirrors the loop's 30s touch throttle). */
const RUNNING_DEDUP_MS = 30000

/** explicit-pick an event frame payload — NEVER titles/notes/diffs/tokens (T-9.5-35). */
function pickEvent(evt, id, tsMs) {
  const out = { id, event: evt.event, ts: new Date(tsMs).toISOString() }
  if (evt.taskId != null) out.taskId = String(evt.taskId)
  if (evt.workerId != null) out.workerId = String(evt.workerId)
  if (evt.status != null) out.status = String(evt.status)
  return out
}

/**
 * createEventHub({clock, maxClients, heartbeatMs, setTimer, clearTimer}) → the SSE hub.
 * Holds only live client handles + a per-boot monotonic id. addClient(res) writes the
 * SSE headers and returns a client handle, or `false` when at capacity (the handler then
 * answers 503). emit(evt) writes ONE frame to every client and reaps any handle that
 * fails to write. close() drops everything.
 *
 * @param {{clock?:()=>number, maxClients?:number, heartbeatMs?:number, setTimer?:Function, clearTimer?:Function}} [opts]
 */
export function createEventHub({
  clock = Date.now,
  maxClients = 16,
  heartbeatMs = 25000,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  const clients = new Set() // { res } — live response handles ONLY (no task state)
  let nextId = 1
  let heartbeat = null

  function writeTo(client, text) {
    try {
      client.res.write(text)
      return true
    } catch {
      return false
    }
  }

  function drop(client) {
    clients.delete(client)
    try {
      if (typeof client.res.end === 'function') client.res.end()
    } catch {
      /* the socket is already gone */
    }
    stopHeartbeatIfIdle()
  }

  function beat() {
    for (const c of [...clients]) {
      if (!writeTo(c, ': hb\n\n')) drop(c) // reap-on-write-failure (T-9.5-36)
    }
  }
  function startHeartbeat() {
    if (!heartbeat && clients.size > 0) {
      heartbeat = setTimer(beat, heartbeatMs)
      if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref()
    }
  }
  function stopHeartbeatIfIdle() {
    if (heartbeat && clients.size === 0) {
      clearTimer(heartbeat)
      heartbeat = null
    }
  }

  return {
    get size() {
      return clients.size
    },
    /** addClient(res) → client handle | false (at capacity → the caller answers 503). */
    addClient(res) {
      if (clients.size >= maxClients) return false
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        })
      } catch {
        /* a fake/real res that cannot take headers is dropped below on first write */
      }
      const client = { res }
      clients.add(client)
      writeTo(client, ': ok\n\n') // open the stream
      startHeartbeat()
      return client
    },
    removeClient(client) {
      if (client) drop(client)
    },
    /** emit(evt) — write ONE SSE frame to every client AFTER a durable commit. Returns
     *  the number of clients delivered. An unlisted event type is a no-op. */
    emit(evt) {
      if (!evt || !EVENT_TYPES.includes(evt.event)) return 0
      const payload = pickEvent(evt, nextId, clock())
      nextId += 1
      const text = `id: ${payload.id}\nevent: ${payload.event}\ndata: ${JSON.stringify(payload)}\n\n`
      let delivered = 0
      for (const c of [...clients]) {
        if (writeTo(c, text)) delivered += 1
        else drop(c)
      }
      return delivered
    },
    close() {
      for (const c of [...clients]) drop(c)
      stopHeartbeatIfIdle()
    },
  }
}

/**
 * wrapAdapterWithEvents(adapter, hub, {clock}) → a QueueAdapter decorator that emits a
 * live HINT after each durable transition COMMITS. Every method awaits the underlying
 * durable call FIRST, then emits — so no event can precede the truth it announces (the
 * ordering test). The wrapped adapter is handed to BOTH the tick and the front at the
 * composition root, so a transition emits regardless of which side caused it.
 *
 *   enqueue            → task.queued
 *   claimNext(≠null)   → task.claimed + worker.presence
 *   touch              → task.running (deduped per task; hint plumbing, never truth)
 *   complete           → task.awaiting_approval + spend.updated + worker.presence
 *   fail               → task.failed + spend.updated + worker.presence
 *
 * @param {object} adapter a conforming QueueAdapter
 * @param {{emit:Function}} hub the event hub (or any {emit})
 * @param {{clock?:()=>number}} [opts]
 * @returns {object} the decorated adapter
 */
export function wrapAdapterWithEvents(adapter, hub, { clock = Date.now } = {}) {
  const lastRunning = new Map() // taskId -> last running-hint ms (loss-safe; never truth)
  const emit = (evt) => {
    try {
      if (hub && typeof hub.emit === 'function') hub.emit(evt)
    } catch {
      /* a hint failure never affects the durable path */
    }
  }

  return {
    ...adapter,
    async enqueue(task) {
      const r = await adapter.enqueue(task)
      emit({ event: 'task.queued', taskId: task && task.id })
      return r
    },
    async claimNext(workerId, opts) {
      const t = await adapter.claimNext(workerId, opts)
      if (t) {
        emit({ event: 'task.claimed', taskId: t.id, workerId })
        emit({ event: 'worker.presence', workerId })
      }
      return t
    },
    async touch(taskId) {
      const ok = await adapter.touch(taskId)
      if (ok) {
        const now = clock()
        const prev = lastRunning.get(taskId)
        if (prev == null || now - prev >= RUNNING_DEDUP_MS) {
          lastRunning.set(taskId, now)
          emit({ event: 'task.running', taskId })
        }
      }
      return ok
    },
    async complete(taskId, result) {
      const r = await adapter.complete(taskId, result)
      emit({ event: 'task.awaiting_approval', taskId })
      emit({ event: 'spend.updated', taskId })
      emit({ event: 'worker.presence', taskId })
      lastRunning.delete(taskId)
      return r
    },
    async fail(taskId, reason) {
      const r = await adapter.fail(taskId, reason)
      emit({ event: 'task.failed', taskId, status: reason })
      emit({ event: 'spend.updated', taskId })
      emit({ event: 'worker.presence', taskId })
      lastRunning.delete(taskId)
      return r
    },
  }
}
