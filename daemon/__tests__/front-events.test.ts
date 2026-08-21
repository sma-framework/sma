/**
 * Tests for the SPA data foundation.
 *
 * The SPA consumes THREE seams built here — proven against THIS server with
 * zero SPA work:
 *   - the SSE hint hub (createEventHub): explicit-pick frames {id,event,taskId?,
 *     workerId?,status?,ts}, a capacity cap, reap-on-write-failure;
 *   - the emit-AFTER-durable-commit decorator (wrapAdapterWithEvents): the ordering test
 *     proves ZERO emits before the durable promise resolves;
 *   - the read models: GET /api/task/<id> timeline (attempts+receipts+commits+acceptance+
 *     reasonLabel) and costs.series riding GET /api/state.
 * Plus the handshake auth (a correct token in the QUERY STRING → 401), a 17th client →
 * 503, and a real ephemeral-port SSE smoke asserting the id/event/data frame.
 *
 * main.mjs (the composition root) is verified by grep only — NO test imports it.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

import { createEventHub, wrapAdapterWithEvents, EVENT_TYPES } from '../src/front/events.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState, parseReceiptSummary } from '../src/front/state.mjs'
import { TASK_STATUSES } from '../src/queue/adapter.mjs'
import { REASON_LABELS } from '../src/queue/adapter.mjs'

const TOKEN = 'e'.repeat(64)

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.1' } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: remote }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    chunks: [] as string[],
    ended: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    write(c: any) {
      res.chunks.push(String(c))
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

const bearer = () => ({ authorization: `Bearer ${TOKEN}` })
async function call(front: any, reqOpts: any) {
  const req = mkReq(reqOpts)
  const res = mkRes()
  await front.handle(req, res)
  return res
}

// ── EVENT_TYPES ──

describe('events.mjs — EVENT_TYPES', () => {
  it('is frozen and carries the full 9.6 vocabulary', () => {
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true)
    expect(EVENT_TYPES).toContain('task.queued')
    expect(EVENT_TYPES).toContain('worker.presence')
    expect(EVENT_TYPES).toContain('spend.updated')
  })

  it('the frozen vocabulary is EXACTLY twenty types with no duplicates', () => {
    // TWENTY since 10.08.2026: `ship.published` was being emitted by the release handler into
    // a vocabulary that did not contain it, so the hub dropped it and the one frame a person
    // would actually notice — «опубликовано» — never rang. Declaring it is the fix.
    expect(EVENT_TYPES).toHaveLength(20)
    expect(new Set(EVENT_TYPES).size).toBe(20)
    for (const t of ['chat.reply', 'machine.presence', 'project.updated', 'import.updated', 'ship.published']) {
      expect(EVENT_TYPES).toContain(t)
    }
  })

  /**
   * The five V5.4 types, declared in one revision AHEAD of the emit points that will use
   * them. This case is why the declaration cannot wait: `emit()` drops an unlisted type
   * SILENTLY, so a screen wired to a type nobody declared does not break loudly — it just
   * never updates, and the bug looks like a slow screen rather than a missing word.
   */
  it('the five V5.4 types are declared verbatim, so a later emit is not silently dropped', () => {
    for (const t of ['phase.stage', 'discussion.updated', 'memory.drafts', 'coordination.updated', 'ship.gate']) {
      expect(EVENT_TYPES, t).toContain(t)
      expect(emitOne({ event: t }).delivered, `${t} was dropped as unlisted`).toBe(1)
    }
    // and a near-miss is still nothing: the vocabulary is a list, not a prefix rule
    expect(emitOne({ event: 'phase.staged' }).delivered).toBe(0)
    expect(emitOne({ event: 'ship.gates' }).delivered).toBe(0)
  })
})

// ── the V5.1 types: a frame is a doorbell, never the message ──

/** Emit one event into a throwaway hub and return {raw, payload} of its frame. */
function emitOne(evt: any) {
  const chunks: string[] = []
  const res: any = { writeHead() {}, write: (c: string) => (chunks.push(c), true), end() {} }
  const hub = createEventHub({ clock: () => 7 })
  hub.addClient(res)
  const delivered = hub.emit(evt)
  const raw = chunks[1] ?? ''
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '))
  return { delivered, raw, payload: dataLine ? JSON.parse(dataLine.slice(6)) : null }
}

describe('events.mjs — the four hint types leak nothing', () => {
  it('chat.reply carries the turn id and status ONLY — never the text of the reply', () => {
    const secret = 'мой пароль от банка — hunter2'
    const { delivered, raw, payload } = emitOne({
      event: 'chat.reply',
      turnId: 'C-42',
      status: 'done',
      text: secret,
      message: secret,
      reply: secret,
    })
    expect(delivered).toBe(1)
    expect(payload).toEqual({ id: 1, event: 'chat.reply', ts: new Date(7).toISOString(), turnId: 'C-42', status: 'done' })
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain('hunter2')
  })

  it('machine.presence carries the machine id and a boolean ONLY — never the peer url or token', () => {
    const token = 'f'.repeat(64)
    const { raw, payload } = emitOne({
      event: 'machine.presence',
      machineId: 'mac-mini',
      online: false,
      token,
      url: 'http://192.168.1.50:7777',
    })
    expect(payload).toEqual({ id: 1, event: 'machine.presence', ts: new Date(7).toISOString(), machineId: 'mac-mini', online: false })
    expect(raw).not.toContain(token)
    expect(raw).not.toContain('192.168.1.50')
  })

  it('project.updated carries the project id; import.updated carries the batch id + count', () => {
    const p = emitOne({ event: 'project.updated', projectId: 'postgres', path: '/home/me/secret-dir' })
    expect(p.payload.projectId).toBe('postgres')
    expect(p.raw).not.toContain('secret-dir')

    const i = emitOne({ event: 'import.updated', batchId: 'IMP-3', count: 7, files: ['/home/me/.claude/agents/x.md'] })
    expect(i.payload).toMatchObject({ batchId: 'IMP-3', count: 7 })
    expect(i.raw).not.toContain('.claude/agents')
  })

  /**
   * The V5.4 five under the SAME two absolute bans. These are asserted on the FRAME rather
   * than by reading EVENT_FIELDS, because what the file declares matters only insofar as it
   * is what leaves the process — and the pick is the thing that decides that.
   */
  it('the five V5.4 types carry identifiers ONLY — the question, the note and the output stay behind', () => {
    const secret = 'вопрос основателю: переносим ли шифрование, и пароль тут же — hunter2'
    const ts = new Date(7).toISOString()

    // a stage move names the stage, never what happened in it
    const stage = emitOne({ event: 'phase.stage', taskId: 'R-4', phase: '12', stage: 'uat', note: secret, title: secret })
    expect(stage.payload).toEqual({ id: 1, event: 'phase.stage', ts, taskId: 'R-4', phase: '12', stage: 'uat' })
    expect(stage.raw).not.toContain('hunter2')

    // a waiting discussion names the phase, NEVER the question
    const disc = emitOne({ event: 'discussion.updated', phase: '12', question: secret, text: secret })
    expect(disc.payload).toEqual({ id: 1, event: 'discussion.updated', ts, phase: '12' })
    expect(disc.raw).not.toContain('hunter2')

    // a release gate names the step, NEVER what the step printed
    const gate = emitOne({ event: 'ship.gate', taskId: 'R-4', step: 'tests', output: secret, log: secret })
    expect(gate.payload).toEqual({ id: 1, event: 'ship.gate', ts, taskId: 'R-4', step: 'tests' })
    expect(gate.raw).not.toContain('hunter2')

    // and the two pure doorbells carry nothing at all beyond the envelope
    for (const event of ['memory.drafts', 'coordination.updated']) {
      const { payload, raw } = emitOne({ event, path: '/home/me/.claude/memory', note: secret, files: [secret] })
      expect(payload, event).toEqual({ id: 1, event, ts })
      expect(raw, event).not.toContain('hunter2')
      expect(raw, event).not.toContain('.claude/memory')
    }
  })

  it('a field belonging to another type is dropped, and an unlisted type is still a no-op', () => {
    // taskId is legal on task.* frames — it is NOT legal on a chat.reply frame
    const { payload } = emitOne({ event: 'chat.reply', turnId: 'C-1', taskId: 'R-1', workerId: 'max-1' })
    expect(payload.taskId).toBeUndefined()
    expect(payload.workerId).toBeUndefined()
    expect(emitOne({ event: 'chat.replies', turnId: 'C-1' }).delivered).toBe(0)
    expect(emitOne({ event: 'machine.token', machineId: 'x' }).delivered).toBe(0)
  })
})

// ── createEventHub ──

describe('createEventHub — SSE frames + capacity + explicit-pick', () => {
  it('opens with a comment and emits explicit-pick id/event/data frames (hostile extras dropped)', () => {
    const chunks: string[] = []
    const res: any = { writeHead() {}, write: (c: string) => (chunks.push(c), true) }
    const hub = createEventHub({ clock: () => 1000 })
    hub.addClient(res)
    expect(chunks[0]).toBe(': ok\n\n')

    hub.emit({ event: 'task.queued', taskId: 'T1', workerId: 'w1', title: 'SECRET', note: 'leak', status: 'queued' })
    const frame = chunks[1]
    expect(frame.startsWith('id: 1\n')).toBe(true)
    expect(frame).toContain('event: task.queued\n')
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6)
    const payload = JSON.parse(dataLine)
    expect(payload).toEqual({
      id: 1,
      event: 'task.queued',
      ts: new Date(1000).toISOString(),
      taskId: 'T1',
      workerId: 'w1',
      status: 'queued',
    })
    // titles / notes are NEVER on the wire
    expect(payload.title).toBeUndefined()
    expect(payload.note).toBeUndefined()
  })

  it('an unlisted event type is a no-op; ids are monotonic', () => {
    const chunks: string[] = []
    const res: any = { writeHead() {}, write: (c: string) => (chunks.push(c), true) }
    const hub = createEventHub({ clock: () => 5 })
    hub.addClient(res)
    expect(hub.emit({ event: 'not.a.real.event', taskId: 'x' })).toBe(0)
    hub.emit({ event: 'task.claimed', taskId: 'A' })
    hub.emit({ event: 'task.failed', taskId: 'B' })
    const ids = chunks.filter((c) => c.startsWith('id: ')).map((c) => c.split('\n')[0])
    expect(ids).toEqual(['id: 1', 'id: 2'])
  })

  it('caps clients at maxClients (a further addClient → false → the handler answers 503)', () => {
    const hub = createEventHub({ maxClients: 2 })
    const mk = () => ({ writeHead() {}, write: () => true, end() {} }) as any
    expect(hub.addClient(mk())).toBeTruthy()
    expect(hub.addClient(mk())).toBeTruthy()
    expect(hub.addClient(mk())).toBe(false)
    expect(hub.size).toBe(2)
  })

  it('frees the slot when the tab closes — the 17th window must NOT see 503 (D1, live QA 11.08)', async () => {
    const hub = createEventHub({ maxClients: 1 })
    const front = createFrontServer({ config: { token: TOKEN }, deps: { hub } })
    // The first window subscribes and fills the only slot.
    const res1 = mkRes()
    const closeHandlers: Array<() => void> = []
    res1.on = (evt: string, cb: () => void) => {
      if (evt === 'close') closeHandlers.push(cb)
      return res1
    }
    await front.handle(mkReq({ url: '/api/events', headers: bearer() }), res1)
    expect(hub.size).toBe(1)
    expect(closeHandlers.length).toBe(1) // the route DID register disconnect cleanup
    // The tab closes. Before the fix nothing happened here — the handle leaked forever.
    closeHandlers[0]()
    expect(hub.size).toBe(0)
    // The next window takes the freed slot instead of 503.
    const res2 = mkRes()
    await front.handle(mkReq({ url: '/api/events', headers: bearer() }), res2)
    expect(res2.statusCode).toBe(200)
    expect(hub.size).toBe(1)
  })

  it('reaps a destroyed handle even though its write does not throw (Node buries dead-socket writes)', () => {
    const hub = createEventHub({})
    const zombie: any = { writeHead() {}, write: () => true, end() {}, destroyed: false }
    hub.addClient(zombie)
    expect(hub.size).toBe(1)
    zombie.destroyed = true // the socket died; write() would still "succeed" silently
    hub.emit({ event: 'task.queued', taskId: 'T' })
    expect(hub.size).toBe(0)
  })

  it('reaps a client whose write throws (stale-handle DoS guard)', () => {
    const hub = createEventHub({})
    const dead: any = {
      writeHead() {},
      write() {
        throw new Error('EPIPE')
      },
      end() {},
    }
    hub.addClient(dead) // the opening write already fails → reaped on the next emit
    hub.emit({ event: 'task.queued', taskId: 'T' })
    expect(hub.size).toBe(0)
  })
})

// ── wrapAdapterWithEvents — emit AFTER the durable commit ──

describe('wrapAdapterWithEvents — ordering: zero emits before the durable call resolves', () => {
  it('holds the emit until the underlying durable promise resolves', async () => {
    let release: () => void = () => {}
    const durable: any = {
      enqueue: () =>
        new Promise((r) => {
          release = () => r({ id: 'x', coalesced: false })
        }),
    }
    const emitted: any[] = []
    const hub = { emit: (e: any) => emitted.push(e) }
    const wrapped = wrapAdapterWithEvents(durable, hub)

    const p = wrapped.enqueue({ id: 'T1' })
    await Promise.resolve() // flush microtasks — the durable promise is still pending
    expect(emitted).toHaveLength(0)
    release()
    await p
    expect(emitted).toEqual([{ event: 'task.queued', taskId: 'T1', status: 'queued' }])
  })

  it('each durable transition emits its hint set after committing; touch dedups', async () => {
    let now = 0
    const emitted: any[] = []
    const durable: any = {
      enqueue: async () => ({ id: 'T', coalesced: false }),
      claimNext: async () => ({ id: 'T' }),
      touch: async () => true,
      complete: async () => true,
      fail: async () => true,
    }
    const hub = { emit: (e: any) => emitted.push(e.event) }
    const wrapped = wrapAdapterWithEvents(durable, hub, { clock: () => now })

    await wrapped.claimNext('w1', {})
    expect(emitted).toEqual(['task.claimed', 'worker.presence'])

    emitted.length = 0
    await wrapped.touch('T') // first running hint at t=0
    now = 1000
    await wrapped.touch('T') // within 30s dedup window → no second emit
    expect(emitted).toEqual(['task.running'])

    emitted.length = 0
    await wrapped.complete('T', { receiptRef: 'x' })
    expect(emitted).toEqual(['task.awaiting_approval', 'spend.updated', 'worker.presence'])

    emitted.length = 0
    await wrapped.fail('T', 'tests_red')
    expect(emitted).toEqual(['task.failed', 'spend.updated', 'worker.presence'])
  })

  /**
   * ЭТО ДЕЛО ПРО ПРОВОД, А НЕ ПРО ВЫЧИСЛЕНИЕ.
   *
   * Жетон попытки, который очередь выдаёт при захвате, обязан ДОЕХАТЬ до того шва, который его
   * судит. Но между тиком и бэкендом стоит эта обёртка — и именно её держит демон: корень
   * сборки отдаёт циклу ЕЁ, а не бэкенд. Обёртка, пересылающая только те аргументы, которые ей
   * самой интересны, потеряла бы жетон за один вызов до проверки: отказ работал бы во всех
   * делах бэкенда и не работал бы ни разу в живом демоне.
   *
   * Поэтому дело утверждает не «жетон где-то есть», а РОВНО ТО ЗНАЧЕНИЕ в аргументах вызова,
   * дошедшего до бэкенда.
   */
  it('the attempt token reaches the durable adapter through this wrapper — every closing seam', async () => {
    const calls: any[] = []
    const durable: any = {
      enqueue: async () => ({ id: 'T', coalesced: false }),
      claimNext: async () => ({ id: 'T', attemptToken: 'tok-from-claim' }),
      touch: async (...args: any[]) => {
        calls.push(['touch', ...args])
        return true
      },
      complete: async (...args: any[]) => {
        calls.push(['complete', ...args])
        return true
      },
      fail: async (...args: any[]) => {
        calls.push(['fail', ...args])
        return true
      },
    }
    const wrapped = wrapAdapterWithEvents(durable, { emit: () => {} }, { clock: () => 0 })

    const claimed = await wrapped.claimNext('w1', {})
    expect(claimed.attemptToken).toBe('tok-from-claim') // обёртка не съела его и на выдаче

    await wrapped.touch('T', { attemptToken: claimed.attemptToken })
    await wrapped.complete('T', { receiptRef: 'x', attemptToken: claimed.attemptToken })
    await wrapped.fail('T', 'tests_red', { attemptToken: claimed.attemptToken })

    expect(calls).toEqual([
      ['touch', 'T', { attemptToken: 'tok-from-claim' }],
      ['complete', 'T', { receiptRef: 'x', attemptToken: 'tok-from-claim' }],
      ['fail', 'T', 'tests_red', { attemptToken: 'tok-from-claim' }],
    ])
  })

  /**
   * THE CLASS LOCK. `hub.emit` drops an unlisted type SILENTLY — by design, so a hostile emit
   * cannot invent a frame shape. The cost of that design is that a TYPO or an undeclared new
   * type is invisible: the code emits, the hub swallows, and the screen waiting for it simply
   * never updates. That is exactly how `ship.published` came to be emitted for a whole release
   * without ringing anywhere.
   *
   * So this reads the SOURCE of every module that emits and asserts each name it emits is in
   * the vocabulary. A static read is the only way to see this: no runtime test exercises every
   * emit site, and the ones that do would pass either way — silence is the failure mode.
   */
  it('every event name emitted anywhere in the daemon is DECLARED — an undeclared one is dropped in silence', () => {
    // ONLY the hub's own doors: `emit({event})` and `emitSafe(deps, {event})`. The outbound
    // report edge (report.mjs) speaks a DIFFERENT vocabulary through `report({event})` — it
    // is not this hub and must not be judged by this list.
    const roots = ['../src/front/server.mjs', '../src/front/events.mjs', '../src/loop.mjs', '../src/main.mjs']
    const emitted = new Set<string>()
    const CALL = /\bemit(?:Safe)?\(\s*(?:deps\s*,\s*)?\{[^}]*?event:\s*([^,}]+)/g
    for (const rel of roots) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
      for (const m of src.matchAll(CALL)) {
        for (const lit of String(m[1]).matchAll(/'([a-z][a-z.]*)'/g)) emitted.add(lit[1])
      }
    }
    expect(emitted.size).toBeGreaterThan(5) // the scan itself must not silently find nothing
    for (const name of emitted) {
      expect(EVENT_TYPES, `«${name}» is emitted but not declared — the hub drops it and no screen ever learns`).toContain(
        name,
      )
    }
  })

  it('every task frame carries the QUEUE status — and a failure carries «failed», not its reason', async () => {
    const frames: any[] = []
    const durable = {
      enqueue: async () => ({ id: 'T1' }),
      claimNext: async () => ({ id: 'T1' }),
      touch: async () => true,
      complete: async () => true,
      fail: async () => true,
    }
    const wrapped = wrapAdapterWithEvents(durable, { emit: (e: any) => frames.push(e) }, { clock: () => 0 })

    await wrapped.enqueue({ id: 'T1' })
    await wrapped.claimNext('w1', {})
    await wrapped.touch('T1')
    await wrapped.complete('T1', { receiptRef: 'x' })
    await wrapped.fail('T1', 'no_receipt')

    const statusOf = (name: string) => frames.find((f) => f.event === name).status
    expect(statusOf('task.queued')).toBe('queued')
    expect(statusOf('task.claimed')).toBe('claimed')
    expect(statusOf('task.running')).toBe('claimed') // a touch does not move the row
    expect(statusOf('task.awaiting_approval')).toBe('awaiting_approval')

    // THE LOCK. Until 10.08 this frame carried the failure REASON in the status field — a
    // word from another vocabulary that the screen would have written into the row as a
    // state. The reason belongs to the read model, where it has a label.
    expect(statusOf('task.failed')).toBe('failed')
    expect(JSON.stringify(frames)).not.toContain('no_receipt')

    // and every status a frame carries is one the queue itself can hold
    for (const f of frames.filter((x) => x.event.startsWith('task.'))) {
      expect(TASK_STATUSES).toContain(f.status)
    }
  })
})

// ── GET /api/events — handshake auth ──

describe('server.mjs — GET /api/events handshake', () => {
  it('a CORRECT token in the query string → 401 (no token in query after bootstrap)', async () => {
    const hub = createEventHub({})
    const front = createFrontServer({ config: { token: TOKEN }, deps: { hub } })
    const res = await call(front, { url: `/api/events?token=${TOKEN}`, remote: '10.5.0.1' })
    expect(res.statusCode).toBe(401)
  })

  it('unauthenticated → 401 before any stream headers', async () => {
    const hub = createEventHub({})
    const front = createFrontServer({ config: { token: TOKEN }, deps: { hub } })
    const res = await call(front, { url: '/api/events', remote: '10.5.0.2' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).not.toBe('text/event-stream')
  })

  it('an authed handshake → 200 text/event-stream; a 17th concurrent client → 503', async () => {
    const hub = createEventHub({ maxClients: 1 })
    const front = createFrontServer({ config: { token: TOKEN }, deps: { hub } })
    const first = await call(front, { url: '/api/events', headers: bearer() })
    expect(first.statusCode).toBe(200)
    expect(first.headers['content-type']).toBe('text/event-stream')
    const second = await call(front, { url: '/api/events', headers: bearer() })
    expect(second.statusCode).toBe(503)
  })
})

// ── GET /api/task/<id> — the timeline read model ──

describe('server.mjs — GET /api/task/<id> timeline', () => {
  const adapter = {
    list: async () => [
      { id: 'R-9', title: 'ночная задача', lane: 'prod', status: 'awaiting_approval', attempt: 2, acceptance: 'зелёные тесты' },
    ],
  }
  const ledger = (id: string) =>
    id === 'R-9'
      ? [
          { attempt: 1, workerId: 'max-1', outcome: 'failed', failureReason: 'tests_red', receiptRef: { testsPassed: 3, testsTotal: 5 } },
          { attempt: 2, workerId: 'max-1', outcome: 'completed', receiptRef: { testsPassed: 5, testsTotal: 5, tscClean: true } },
        ]
      : []
  const execGit = () => 'abc1234 first\ndef5678 second'
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: { adapter, ledger, execGit, parseReceiptSummary },
  })

  it('returns the attempts + receipts + commits timeline incl. acceptance and reasonLabel', async () => {
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.task.acceptance).toBe('зелёные тесты') // «обещано» surfaces on the read
    expect(out.attempts).toHaveLength(2)
    expect(out.attempts[0].failureReason).toBe('tests_red')
    expect(out.attempts[0].reasonLabel).toBe(REASON_LABELS['tests_red']) // from adapter.mjs REASON_LABELS
    expect(out.attempts[0].receipt.testsPassed).toBe(3)
    expect(out.attempts[1].receipt.tscClean).toBe(true)
    expect(out.branch).toBe('wt/R-9')
    expect(out.commits).toEqual(['abc1234 first', 'def5678 second'])
  })

  it('an unknown id → 404', async () => {
    const res = await call(front, { url: '/api/task/R-404', headers: bearer() })
    expect(res.statusCode).toBe(404)
  })
})

// ── the two git doors read the CONNECTED project's tree ──

/**
 * THE DIRECTORY, ASSERTED ON THE WIRE. Both doors used to pass `config.repoDir` — the
 * directory the daemon PROCESS was launched in. The task branch lives in the project the
 * founder connected, so on an install where the two differ git was asked about a revision
 * that is not in that tree: the timeline came back with an empty commit list and the diff
 * door answered 404 for work sitting on a branch one directory away. The timeline also named
 * the trunk `main` outright, which is an exception on every project whose trunk is called
 * anything else.
 */
describe('server.mjs — /api/task and /api/diff run git where the branch actually lives', () => {
  const adapter = { list: async () => [{ id: 'R-9', title: 'ночная', lane: 'prod', status: 'completed', attempt: 1 }] }

  it('the timeline asks the connected project, and asks it without naming a trunk branch', async () => {
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN, repoDir: '/launch-dir' },
      deps: {
        adapter,
        ledger: () => [],
        repoDir: '/launch-dir',
        phaseCycleDir: () => '/connected/project',
        execGit: (args: string[], opts?: any) => {
          calls.push({ args, opts })
          return 'abc1234 первый'
        },
      },
    })

    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })

    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts).toMatchObject({ cwd: '/connected/project' })
    expect(calls[0].args.join(' ')).not.toContain('main')
    expect(JSON.parse(res.body).commits).toEqual(['abc1234 первый'])
  })

  it('the diff door reads the connected project — and 404s only when git really cannot show the branch', async () => {
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN, repoDir: '/launch-dir' },
      deps: {
        adapter,
        repoDir: '/launch-dir',
        phaseCycleDir: () => '/connected/project',
        execGit: (args: string[], opts?: any) => {
          calls.push({ args, opts })
          // the real failure mode: a tree that does not hold the branch throws
          if (opts?.cwd !== '/connected/project') throw new Error('unknown revision wt/R-9')
          return 'diff --git a/x b/x'
        },
      },
    })

    const res = await call(front, { url: '/api/diff/R-9', headers: bearer() })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('diff --git')
    expect(calls[0].opts).toMatchObject({ cwd: '/connected/project' })
  })

  it('a daemon wired with no connected project keeps reading the served tree (regression)', async () => {
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN, repoDir: '/served' },
      deps: {
        adapter,
        ledger: () => [],
        execGit: (args: string[], opts?: any) => {
          calls.push({ args, opts })
          return ''
        },
      },
    })

    await call(front, { url: '/api/task/R-9', headers: bearer() })

    expect(calls[0].opts).toMatchObject({ cwd: '/served' })
  })
})

// ── GET /api/state — costs.series ──

describe('server.mjs — costs.series rides GET /api/state', () => {
  it('carries a 14-day per-account/per-day series + the api-fallback carry-over', async () => {
    // The daemon config (token + workers + budget) is the server `config`, not a dep.
    const config = {
      token: TOKEN,
      workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }],
      budget: { monthlyApiCapEur: 40 },
    }
    const usageSeries = () => [
      { account: 'max-1', day: '2026-07-01', tokensIn: 100, tokensOut: 50, eur: 0.3 },
      { account: 'max-1', day: '2026-07-02', tokensIn: 200, tokensOut: 90, eur: 0.6 },
    ]
    const front = createFrontServer({
      config,
      deps: {
        deriveState,
        adapter: { list: async () => [] },
        windows: () => ({ pct5h: 0, pctWeek: 0, estimated: true }),
        usageSeries,
        clock: () => 1_700_000_000_000,
      },
    })
    const res = await call(front, { url: '/api/state', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.costs.series).toHaveLength(2)
    expect(out.costs.series[0]).toMatchObject({ account: 'max-1', day: '2026-07-01' })
    expect(out.costs.apiFallback.capEur).toBe(40)
  })
})

// ── real ephemeral-port SSE smoke ──

/**
 * WHY THIS TEST SYNCHRONIZES ON THE RESPONSE AND NOT ON A CLOCK.
 *
 * It used to emit on a fixed `setTimeout(…, 50)` after `req.end()`, commented
 * "emit AFTER the handshake is established" — a hope, not a guarantee. The
 * handshake costs 20–24 ms on this machine idle, so the whole assertion rested on
 * a ~2× margin: double the latency and the emit lands while the hub still has
 * ZERO clients, the frame is never written, the promise never settles, and the
 * case dies on the 30s testTimeout with a message that names nothing. Measured
 * with the emit moved inside that window (probe, 05.08):
 *
 *   emitDelay 0ms  -> handshake 24ms, clients at emit 0 -> no frame, timeout
 *   emitDelay 1ms  -> handshake 23ms, clients at emit 0 -> no frame, timeout
 *   emitDelay 50ms -> handshake 20ms, clients at emit 1 -> frame
 *
 * The server registers the subscriber BEFORE it answers (`handleEvents` calls
 * `hub.addClient(res)` and addClient writes the head), so "the client has the
 * response head" is proof that the hub already holds it. Emitting from the
 * response callback is therefore race-free at any machine speed — and `emit`
 * returns the delivered-client count, so a zero is reported as a zero instead of
 * being waited out.
 */
describe('server.mjs — real-listen SSE smoke', () => {
  it('streams an id/event/data frame over a real socket', async () => {
    const hub = createEventHub({})
    const front = createFrontServer({ config: { token: TOKEN, bind: '127.0.0.1' }, deps: { hub } })
    await new Promise<void>((resolve) => front.server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = front.server.address() as any
    try {
      const frame = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/api/events', method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } },
          (res) => {
            try {
              expect(res.statusCode).toBe(200)
              expect(res.headers['content-type']).toBe('text/event-stream')
            } catch (e) {
              reject(e) // an assertion thrown in here would otherwise hang to the test timeout
              return
            }
            let buf = ''
            res.on('data', (c) => {
              buf += c.toString()
              if (buf.includes('event: task.queued')) resolve(buf)
            })
            res.on('error', reject)
            // The head is in hand, so hub.addClient(res) has already run.
            const delivered = hub.emit({ event: 'task.queued', taskId: 'SMOKE' })
            if (delivered !== 1) reject(new Error(`hub.emit reached ${delivered} clients, expected 1`))
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(frame).toMatch(/id: \d+/)
      expect(frame).toMatch(/event: task\.queued/)
      expect(frame).toMatch(/data: \{.*"taskId":"SMOKE".*\}/)
    } finally {
      hub.close()
      await new Promise<void>((resolve) => front.server.close(() => resolve()))
    }
  })
})
