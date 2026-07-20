/**
 * Tests for the SPA data foundation (Phase 9.5 Plan 08, Task 4; D-9.5-05 РЕВИЗИЯ).
 *
 * The Phase 9.6 SPA consumes THREE seams built here — proven against THIS server with
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
import { request as httpRequest } from 'node:http'

import { createEventHub, wrapAdapterWithEvents, EVENT_TYPES } from '../src/front/events.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState, parseReceiptSummary } from '../src/front/state.mjs'
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
    // titles / notes are NEVER on the wire (T-9.5-35)
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
    expect(emitted).toEqual([{ event: 'task.queued', taskId: 'T1' }])
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
    expect(out.task.acceptance).toBe('зелёные тесты') // «обещано» surfaces on the read (D-9.5-11)
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
            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toBe('text/event-stream')
            let buf = ''
            res.on('data', (c) => {
              buf += c.toString()
              if (buf.includes('event: task.queued')) resolve(buf)
            })
          },
        )
        req.on('error', reject)
        req.end()
        // emit AFTER the handshake is established
        setTimeout(() => hub.emit({ event: 'task.queued', taskId: 'SMOKE' }), 50)
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
