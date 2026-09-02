/**
 * events.mjs — the SSE event hub + the durable-commit event decorator: the live-hint
 * foundation the screens are built on.
 *
 * ═══════════════════════ ABSORPTION NOTE (IDEA-level, zero code copied) ═══════════
 * This event VOCABULARY is our analog of Paperclip's heartbeat.run.* / agent.status
 * push vocabulary — IDEA-level absorption only; NO code is copied from their MIT tree.
 * If any LITERAL code is ever absorbed here (or in the SPA), it takes the
 * THIRD-PARTY-LICENSES.md attribution step exactly as the CAS pattern did.
 * Nothing in this file derives from a third-party source.
 *
 * ═══════════════════════ HINT, NEVER TRUTH ════════════════════════════════════════
 * The governing posture (RESEARCH State-of-the-Art): a push is an OPTIONAL HINT; the
 * durable queue + a poll of GET /api/state is the truth. So:
 *   - The hub holds ONLY live response handles + a monotonic per-boot event id. It holds
 *     NO task state. A daemon restart drops every connection and LOSES NOTHING — clients
 *     re-derive from GET /api/state (statelessness is preserved because truth
 *     never lives in the hub).
 *   - EMIT-AFTER-DURABLE-COMMIT: wrapAdapterWithEvents awaits the underlying durable call
 *     FIRST, then emits. A dropped emit only costs a client one poll of latency; it can
 *     never lose or reorder truth (the ordering test proves zero emits before the durable
 *     promise resolves).
 *   - EXPLICIT-PICK PAYLOADS, PER TYPE. An event frame carries {id, event, ts} plus ONLY
 *     the fields its own type declares in EVENT_FIELDS — never titles, notes, diffs,
 *     tokens, or receipt bodies. A field that belongs to another type is
 *     dropped, so a hostile or careless emit cannot smuggle a payload through a frame
 *     shape. The SPA fetches details via the auth'd read endpoints.
 *     Two bans are ABSOLUTE and hold for every future type: the
 *     TEXT of a conversation turn never enters a frame (chat.reply carries a turn id and
 *     a status, never the reply), and a peer's TOKEN or URL never enters a frame
 *     (machine.presence carries a machine id and a boolean, never an address). A frame is
 *     a doorbell: it says something changed, never what was said. The V5.4 types were
 *     declared under exactly those bans and show what obeying them looks like:
 *     `discussion.updated` names the phase whose question is waiting and NOT the question,
 *     and `ship.gate` names the step that reported and NOT what it printed.
 *   - DoS BOUNDS: maxClients cap (→ the handler answers 503), a 25s heartbeat, and
 *     reap-on-write-failure keep stale handles from accumulating.
 *
 * The decorator's per-task «running» dedup map is HINT PLUMBING — loss-safe, never
 * consulted for truth (losing it only risks one extra task.running frame). The
 * statelessness law (no Map/Set) governs the tick (loop.mjs) and the composition root
 * (main.mjs), NOT this hint layer.
 *
 * Node built-ins only; clock + the timer functions are injectable for deterministic
 * tests. Zero deps; zero network beyond the response handles it is handed.
 */

/**
 * The frozen event vocabulary — the SPA contract. TWENTY-TWO types (re-frozen 2026-08-28, when
 * the house of running attempts got a bell of its own; the count before that was twenty-one, and
 * the list has only ever grown by declaration — the V5.4 revision of 2026-08-06, the fourteen of
 * 2026-08-01 and the ten before them). Emitting an unlisted
 * event is a no-op — which is precisely why the whole
 * vocabulary is declared HERE, in one revision, ahead of the emit points: a type that has not
 * been declared does not fail loudly when someone emits it, it is silently dropped, and the
 * screen that was waiting for it simply never updates.
 *
 * The «hint, never truth» contract is UNCHANGED by the revision. Every new type announces
 * that something changed and names only WHICH thing, by identifier; the client re-reads the
 * auth'd endpoint to learn what actually happened.
 */
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
  'harness.updated', // a harness config/registry change hint (agents/skills/mcp)
  'chat.reply', // a conversation turn finished (the TEXT rides the read model)
  'machine.presence', // a peer went online/offline (never its url, never its token)
  'project.updated', // the project registry changed
  'import.updated', // a batch of import drafts was produced
  // ── the V5.4 five (declared here, emitted by the plans that fill their screens) ──
  'phase.stage', // a phase moved to another stage (the stage NAME, never its contents)
  'discussion.updated', // a discussion question is waiting (the TEXT rides the read model)
  'memory.drafts', // the memory drafts changed — which ones is a read, not a frame
  'coordination.updated', // a claim or a session moved (never a glob, never a path)
  'ship.gate', // a release gate step reported (the step id, never its output)
  // Declared 10.08.2026, after the release handler was found emitting it into a vocabulary
  // that did not contain it — so the hub dropped it silently and «опубликовано» never rang
  // on any screen. That silent drop is exactly what the note above this list warns about.
  'ship.published', // a release went out (its VERSION, never a token, never a url)
  // ── the conversation's own progress, declared 25.08.2026 ──
  //
  // A CHUNK OF PROGRESS, NEVER A CHUNK OF THE REPLY. The owner asked for the answer to
  // arrive in pieces through THIS door rather than through a new one. What travels is the
  // STAGE a turn is at — a short name out of a closed dictionary the daemon owns — and a
  // sequence number, because the two absolute bans above are not negotiable for a new type
  // any more than they were for `chat.reply`: this stream is written to EVERY open client,
  // and the words of a conversation belong to the one who asked for them. The prose still
  // rides the answer of the request that asked.
  'chat.stage',
  // МЕСТ БОЛЬШЕ НЕТ, объявлено 28.08.2026. Отказ в месте — единственное решение демона, из-за
  // которого задача НЕ едет при полной тишине во всех остальных списках: очередь не двинулась,
  // работник не сменил занятость, ни одна задача не поменяла состояние. Пока это жило только в
  // журнале, снаружи потолок был неотличим от поломки — и ошибку в его настройке нечем было
  // уличить. Кадр несёт два числа, занято и всего, и ничего кроме них.
  'seats.full',
])

/**
 * EVENT_FIELDS — the per-type explicit pick. A frame carries {id, event, ts} plus ONLY
 * the fields listed here for its own type; everything else on the emitted object is
 * dropped. Every entry is an IDENTIFIER, a short status, a boolean or a count — never
 * free text, never a secret, never an address.
 */
const EVENT_FIELDS = Object.freeze({
  'task.queued': ['taskId', 'workerId', 'status'],
  'task.claimed': ['taskId', 'workerId', 'status'],
  'task.running': ['taskId', 'workerId', 'status'],
  'task.awaiting_approval': ['taskId', 'workerId', 'status'],
  'task.approved': ['taskId', 'workerId', 'status'],
  'task.returned': ['taskId', 'workerId', 'status'],
  'task.failed': ['taskId', 'workerId', 'status'],
  'worker.presence': ['taskId', 'workerId', 'status'],
  'spend.updated': ['taskId', 'workerId', 'status'],
  'harness.updated': ['taskId', 'workerId', 'status'],
  'chat.reply': ['turnId', 'status'], // NEVER the message text
  'machine.presence': ['machineId', 'online'], // NEVER the peer url or token
  'project.updated': ['projectId'],
  'import.updated': ['batchId', 'count'],
  // The V5.4 five. Every field below is an IDENTIFIER or a short enumerated name, and the
  // omissions are the design: `discussion.updated` does NOT carry the question, so the text a
  // person is about to be asked cannot reach a screen that is merely open — it is fetched from
  // the auth'd endpoint by whoever is entitled to read it. `ship.gate` does NOT carry the
  // gate's output for the same reason a receipt body never rode a frame: a failing gate's
  // output is the most quotable thing in the system.
  'phase.stage': ['taskId', 'phase', 'stage'],
  'discussion.updated': ['phase'], // NEVER the question
  'memory.drafts': [], // a pure doorbell: something in the drafts moved, go and look
  'coordination.updated': [], // likewise — who claimed what is a read, never a frame
  'ship.gate': ['taskId', 'step'], // NEVER the gate's output
  'ship.published': ['version'], // the version string and nothing else
  // The turn this is about, WHERE it is (a name from CHAT_STAGES — an enumerated word, the
  // same class of field as `phase.stage`'s stage), and the order the frames were written in.
  // NEVER a syllable of the question or of the reply.
  'chat.stage': ['turnId', 'stage', 'seq'],
  // Два числа и ничего больше: сколько мест занято прямо сейчас и сколько их всего. Ни имени
  // задачи, которой отказали, ни работника — кто именно ждёт, читается с экрана по опросу.
  'seats.full': ['inFlight', 'cap'],
})

/** Fields serialised as a boolean / a number; everything else is stringified. */
const BOOLEAN_FIELDS = new Set(['online'])
const NUMBER_FIELDS = new Set(['count', 'seq', 'inFlight', 'cap'])

/** Dedup window for the touch→task.running hint (mirrors the loop's 30s touch throttle). */
const RUNNING_DEDUP_MS = 30000

/** explicit-pick an event frame payload — NEVER titles/notes/diffs/tokens. */
function pickEvent(evt, id, tsMs) {
  const out = { id, event: evt.event, ts: new Date(tsMs).toISOString() }
  for (const field of EVENT_FIELDS[evt.event] || []) {
    const v = evt[field]
    if (v == null) continue
    if (BOOLEAN_FIELDS.has(field)) out[field] = Boolean(v)
    else if (NUMBER_FIELDS.has(field)) out[field] = Number(v)
    else out[field] = String(v)
  }
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
    const res = client.res
    // A dead socket does not throw on write — Node buffers into the void and reports the
    // failure asynchronously, so a closed tab passed for a live one and held its slot
    // until the cap answered 503 (the D1 finding, 11.08.2026). Ask the stream what it is
    // before trusting the write; the try/catch below still covers streams that DO throw.
    if (res.destroyed || res.writableEnded) return false
    try {
      res.write(text)
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
      if (!writeTo(c, ': hb\n\n')) drop(c) // reap-on-write-failure
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
 *   parkForPerson      → task.failed + spend.updated + worker.presence (the ending that will
 *                        not be retried announces itself exactly as loudly as the one that will)
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
      emit({ event: 'task.queued', taskId: task && task.id, status: 'queued' })
      return r
    },
    async claimNext(workerId, opts) {
      const t = await adapter.claimNext(workerId, opts)
      if (t) {
        emit({ event: 'task.claimed', taskId: t.id, workerId, status: 'claimed' })
        emit({ event: 'worker.presence', workerId })
      }
      return t
    },
    async assignWorker(taskId, workerId) {
      if (typeof adapter.assignWorker !== 'function') return false
      const ok = await adapter.assignWorker(taskId, workerId)
      // The claim frame above names the DAEMON, because that is who checked the task out of
      // the queue. This is the frame that names the worker a person can see, so a live
      // screen stops showing «свободен» beside a worker that is mid-attempt.
      if (ok) {
        emit({ event: 'task.claimed', taskId, workerId, status: 'claimed' })
        emit({ event: 'worker.presence', workerId })
      }
      return ok
    },
    /**
     * СТРОКА ВЕРНУЛАСЬ В ОЧЕРЕДЬ, НЕ ПРОЖИВ ПОПЫТКИ — и экран обязан услышать об этом так же
     * громко, как о захвате. Названо здесь, а не оставлено развороту `...adapter` выше, по той
     * же причине, что и парковка ниже: метод, прошедший насквозь, ДВИГАЕТ долговременную строку
     * и не объявляет ничего — доска продолжала бы рисовать работу за занятым работником до
     * следующего опроса, то есть ровно ту картину, ради устранения которой возврат и заведён.
     *
     * Кадр — обычная постановка: строка снова ждёт работника, и никакого шестого состояния у
     * неё нет. Присутствие работника пересчитывается тем же кадром — он больше её не держит.
     */
    async releaseClaim(taskId, opts) {
      if (typeof adapter.releaseClaim !== 'function') return false
      const ok = await adapter.releaseClaim(taskId, opts)
      if (ok) {
        emit({ event: 'task.queued', taskId, status: 'queued' })
        emit({ event: 'worker.presence', taskId })
        lastRunning.delete(taskId)
      }
      return ok
    },
    // THE FENCING TOKEN TRAVELS THROUGH THIS DECORATOR, and that is why the options object is
    // named here instead of being dropped. This wrapper is what the daemon actually holds: the
    // composition root hands the tick THIS object, not the backend. A wrapper that forwarded
    // only the arguments it happened to care about would compute a token, carry it through the
    // whole attempt, and lose it one call short of the seam that judges it — the refusal would
    // still work in every test of the backend and never once in the running daemon. That class
    // of fault has already cost this product a day, and it is cheapest to close in the wrapper
    // rather than to discover later on a live queue.
    async touch(taskId, opts) {
      const ok = await adapter.touch(taskId, opts)
      if (ok) {
        const now = clock()
        const prev = lastRunning.get(taskId)
        if (prev == null || now - prev >= RUNNING_DEDUP_MS) {
          lastRunning.set(taskId, now)
          // A touch does not MOVE the row — it says the claim is alive. The status travels
          // anyway and equals what the row already is, so a client that missed the claim
          // frame still converges instead of waiting for the next poll.
          emit({ event: 'task.running', taskId, status: 'claimed' })
        }
      }
      return ok
    },
    async complete(taskId, result) {
      const r = await adapter.complete(taskId, result)
      emit({ event: 'task.awaiting_approval', taskId, status: 'awaiting_approval' })
      emit({ event: 'spend.updated', taskId })
      emit({ event: 'worker.presence', taskId })
      lastRunning.delete(taskId)
      return r
    },
    async fail(taskId, reason, opts) {
      const r = await adapter.fail(taskId, reason, opts)
      // `status` is the QUEUE status and nothing else. It carried the failure REASON here
      // until now — a word from a different vocabulary («no_receipt») that a client would
      // have written into the row as though it were a state. The reason is on the read
      // model, where it has a label; the frame says only that the row is now failed.
      emit({ event: 'task.failed', taskId, status: 'failed' })
      emit({ event: 'spend.updated', taskId })
      emit({ event: 'worker.presence', taskId })
      lastRunning.delete(taskId)
      return r
    },
    /**
     * THE OTHER ENDING OF A FAILED ATTEMPT — the one that will NOT be retried, so the screen
     * has to hear about it exactly as loudly as about the retryable one.
     *
     * Named here rather than left to the `...adapter` spread above for one reason: a method
     * that passed through unwrapped would move the durable row and announce NOTHING, so a live
     * board would go on showing work as running until the next poll. This wrapper is what the
     * composition root hands the tick — the same lesson the fencing token left on `touch`.
     *
     * The frames are the failure's own, and deliberately so: the row IS failed (the closed
     * five-status vocabulary has no sixth word for «parked»), and what makes this ending
     * different is the reason on the card, which the read model already carries with its
     * подпись. A private event here would be a second vocabulary for one state.
     */
    async parkForPerson(taskId, reason, opts) {
      if (typeof adapter.parkForPerson !== 'function') return false
      const r = await adapter.parkForPerson(taskId, reason, opts)
      emit({ event: 'task.failed', taskId, status: 'failed' })
      emit({ event: 'spend.updated', taskId })
      emit({ event: 'worker.presence', taskId })
      lastRunning.delete(taskId)
      return r
    },
  }
}
