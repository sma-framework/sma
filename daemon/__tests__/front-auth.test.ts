/**
 * Tests for the roster front's auth + closed route table (Phase 9.5 Plan 08, Tasks 1 & 3).
 *
 * The FIRST sanctioned inbound surface must prove the inverted-notify posture:
 *   - token on EVERY route (the full FOURTEEN-route sweep → 401 unauthenticated),
 *   - the closed table (a non-allowlisted path → 404 with no route reflection; a bad
 *     dynamic id → 400), Object.keys(ROUTES).length === 14,
 *   - timing-safe token compare + the ?token= → HttpOnly-cookie bootstrap + a constant
 *     401 body (no oracle),
 *   - a per-remote failure-window rate limit (the 11th failure → 429).
 * Task 3 adds the action-endpoint cases: enqueue happy path, the double-approve CAS race
 * (one 200, one 409), and an oversized return note → 400.
 *
 * Handlers are driven directly through createFrontServer(...).handle with fake req/res
 * (no real socket), plus ONE real-listen smoke on an ephemeral port.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { request as httpRequest } from 'node:http'

import {
  createFrontServer,
  ROUTES,
  matchRoute,
} from '../src/front/server.mjs'
import {
  authed,
  tokenEquals,
  sessionCookie,
  parseCookies,
  createFailureLimiter,
  COOKIE_NAME,
} from '../src/front/auth.mjs'

const TOKEN = 'a'.repeat(64) // stand-in for randomBytes(32).toString('hex')

// ── fake req/res ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.1' } = o
  const payload =
    body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
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
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    setHeader(k: string, v: any) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: any) {
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

/** A cookie header carrying the valid session token. */
const authedCookie = () => ({ cookie: `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}` })
const bearer = () => ({ authorization: `Bearer ${TOKEN}` })

async function call(front: any, reqOpts: any) {
  const req = mkReq(reqOpts)
  const res = mkRes()
  await front.handle(req, res)
  return res
}

// The full frozen table as concrete {method, path} pairs (dynamic ids filled).
const ALL_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/api/state' },
  { method: 'GET', path: '/api/done' },
  { method: 'GET', path: '/api/task/R-1' },
  { method: 'GET', path: '/api/diff/R-1' },
  { method: 'GET', path: '/api/events' },
  { method: 'GET', path: '/api/harness' },
  { method: 'POST', path: '/api/enqueue' },
  { method: 'POST', path: '/api/approve' },
  { method: 'POST', path: '/api/return' },
  { method: 'POST', path: '/api/forge' },
  { method: 'POST', path: '/api/agent/toggle' },
  { method: 'POST', path: '/api/skill/assign' },
  { method: 'POST', path: '/api/mcp/toggle' },
]

// ── auth.mjs unit invariants ──

describe('auth.mjs — timing-safe token + cookie', () => {
  it('tokenEquals is true only for an equal, correct token and never throws on length mismatch', () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true)
    expect(tokenEquals('b'.repeat(64), TOKEN)).toBe(false)
    expect(tokenEquals('short', TOKEN)).toBe(false) // length mismatch → false, no throw
    expect(tokenEquals('', TOKEN)).toBe(false)
    expect(tokenEquals(TOKEN, '')).toBe(false)
  })

  it('authed accepts a Bearer header OR the session cookie, but NEVER a query string', () => {
    expect(authed({ headers: bearer() }, TOKEN)).toBe(true)
    expect(authed({ headers: authedCookie() }, TOKEN)).toBe(true)
    expect(authed({ headers: {} }, TOKEN)).toBe(false)
    // a wrong token in either place fails
    expect(authed({ headers: { authorization: 'Bearer nope' } }, TOKEN)).toBe(false)
  })

  it('sessionCookie is HttpOnly + SameSite=Strict; parseCookies round-trips it', () => {
    const setCookie = sessionCookie(TOKEN)
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    const jar = parseCookies(`${COOKIE_NAME}=${encodeURIComponent(TOKEN)}`)
    expect(jar[COOKIE_NAME]).toBe(TOKEN)
  })

  it('createFailureLimiter trips only after maxFailures is EXCEEDED (11th at default 10)', () => {
    let now = 1000
    const limiter = createFailureLimiter({ clock: () => now, windowMs: 60000, maxFailures: 10 })
    for (let i = 0; i < 10; i += 1) {
      limiter.record('x')
      expect(limiter.isLimited('x')).toBe(false)
    }
    limiter.record('x') // the 11th
    expect(limiter.isLimited('x')).toBe(true)
    // a different address is independent
    expect(limiter.isLimited('y')).toBe(false)
    // the window ages out
    now += 61000
    expect(limiter.isLimited('x')).toBe(false)
  })
})

// ── the closed route table ──

describe('server.mjs — the closed FOURTEEN-route table', () => {
  it('the frozen table has EXACTLY fourteen routes (D-9.5-09)', () => {
    expect(Object.keys(ROUTES)).toHaveLength(14)
    expect(Object.isFrozen(ROUTES)).toBe(true)
  })

  it('matchRoute resolves the dynamic ids and rejects a bad id shape', () => {
    expect(matchRoute('GET', '/api/task/R-123')).toMatchObject({ handler: 'handleTask', params: { id: 'R-123' } })
    expect(matchRoute('GET', '/api/diff/BL-9')).toMatchObject({ handler: 'handleDiff', params: { id: 'BL-9' } })
    expect(matchRoute('GET', '/api/task/bad$id')).toEqual({ badId: true })
    expect(matchRoute('GET', `/api/task/${'x'.repeat(65)}`)).toEqual({ badId: true })
    expect(matchRoute('GET', '/api/exec')).toBeNull()
  })
})

describe('server.mjs — auth gate on every route', () => {
  const front = createFrontServer({ config: { token: TOKEN } })

  it('EVERY one of the fourteen routes returns 401 unauthenticated (the five 501 stubs included)', async () => {
    // A distinct remote per call so the failure-window limiter never masks a 401 as a 429.
    let n = 0
    for (const r of ALL_ROUTES) {
      const res = await call(front, { method: r.method, url: r.path, remote: `10.1.0.${n++}` })
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(401)
    }
  })

  it('the 401 body is a CONSTANT — no route reflection, no reason oracle', async () => {
    const a = await call(front, { url: '/api/state', remote: '10.2.0.1' })
    const b = await call(front, { url: '/', headers: { authorization: 'Bearer wrong' }, remote: '10.2.0.2' })
    expect(a.statusCode).toBe(401)
    expect(b.statusCode).toBe(401)
    expect(a.body).toBe(b.body) // identical body regardless of the failure cause
  })

  it('a non-allowlisted path → 404 (closed table); a bad dynamic id → 400', async () => {
    expect((await call(front, { url: '/api/exec', remote: '10.3.0.1' })).statusCode).toBe(404)
    expect((await call(front, { method: 'POST', url: '/api/anything', remote: '10.3.0.2' })).statusCode).toBe(404)
    expect((await call(front, { url: '/api/diff/bad$id', remote: '10.3.0.3' })).statusCode).toBe(400)
    expect((await call(front, { url: `/api/task/${'x'.repeat(65)}`, remote: '10.3.0.4' })).statusCode).toBe(400)
  })
})

describe('server.mjs — the ?token= bootstrap', () => {
  const front = createFrontServer({ config: { token: TOKEN } })

  it('GET /?token=<correct> → 302 to / + an HttpOnly SameSite=Strict cookie', async () => {
    const res = await call(front, { url: `/?token=${TOKEN}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(res.headers['set-cookie']).toMatch(/HttpOnly/)
    expect(res.headers['set-cookie']).toMatch(/SameSite=Strict/)
  })

  it('GET /?token=<wrong> → 401 (constant body, no cookie set)', async () => {
    const res = await call(front, { url: '/?token=wrong', remote: '10.9.9.9' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('an authed GET / (cookie) serves the placeholder page; a Bearer GET / too', async () => {
    const viaCookie = await call(front, { url: '/', headers: authedCookie() })
    expect(viaCookie.statusCode).toBe(200)
    expect(viaCookie.headers['content-type']).toMatch(/text\/html/)
    const viaBearer = await call(front, { url: '/', headers: bearer() })
    expect(viaBearer.statusCode).toBe(200)
  })
})

describe('server.mjs — failure-window rate limit (V2)', () => {
  it('ten unauthenticated failures → 401 each; the 11th from the same address → 429', async () => {
    let now = 5000
    const front = createFrontServer({ config: { token: TOKEN }, deps: { clock: () => now } })
    for (let i = 0; i < 10; i += 1) {
      const res = await call(front, { url: '/api/state', remote: '10.0.0.42' })
      expect(res.statusCode, `failure ${i + 1}`).toBe(401)
      now += 100
    }
    const eleventh = await call(front, { url: '/api/state', remote: '10.0.0.42' })
    expect(eleventh.statusCode).toBe(429)
    // a different address is unaffected
    const other = await call(front, { url: '/api/state', remote: '10.0.0.99' })
    expect(other.statusCode).toBe(401)
  })
})

// ── one real-listen smoke on an ephemeral port ──

describe('server.mjs — real-listen smoke', () => {
  it('binds an ephemeral port and serves an authed GET / over a real socket', async () => {
    const front = createFrontServer({ config: { token: TOKEN, bind: '127.0.0.1' } })
    await new Promise<void>((resolve) => front.server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = front.server.address() as any
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } },
          (res) => {
            res.resume()
            resolve(res.statusCode || 0)
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => front.server.close(() => resolve()))
    }
  })
})

// ── Task 3: the action endpoints (enqueue / approve / return) ──

/** A stateful fake execSql that models ONE task row's status for the CAS transitions.
 *  casTransition builds params as [to, ...extraVals, id, from(, dispatchedAt)]; with no
 *  dispatchedAt (the approve/return path here) `from` is the last param and `to` is first. */
function makeCasExec(initialStatus: string) {
  const state = { status: initialStatus }
  const exec = async (_sql: string, params: any[]) => {
    const to = params[0]
    const from = params[params.length - 1]
    if (state.status === from) {
      state.status = to
      return { rows: [{ id: 'row' }] }
    }
    return { rows: [] }
  }
  ;(exec as any).state = state
  return exec
}

describe('server.mjs — POST /api/enqueue', () => {
  it('validates + enqueues a roster task with a minted R-<epochMs> id and source roster', async () => {
    const enqueued: any[] = []
    const adapter = { enqueue: async (t: any) => { enqueued.push(t); return { id: t.id, coalesced: false } } }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, clock: () => 1234 } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { title: 'сделай отчёт', lane: 'prod' },
    })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.ok).toBe(true)
    expect(out.id).toBe('R-1234')
    expect(enqueued[0]).toMatchObject({ id: 'R-1234', source: 'roster', title: 'сделай отчёт', lane: 'prod' })
  })

  it('rejects a body with a bad content-type (400) and an invalid task (400)', async () => {
    const adapter = { enqueue: async () => ({ id: 'x' }) }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter } })
    const noCt = await call(front, { method: 'POST', url: '/api/enqueue', headers: bearer(), body: 'title=x' })
    expect(noCt.statusCode).toBe(400)
    const badLane = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { title: 'x', lane: 'not-a-lane' },
    })
    expect(badLane.statusCode).toBe(400)
  })
})

describe('server.mjs — POST /api/approve (CAS + merge verb)', () => {
  it('runs the merge verb on the worktree branch; a double approve → one 200, one 409', async () => {
    const casExec = makeCasExec('awaiting_approval')
    const mergeCalls: any[] = []
    const verbRunner = async (o: any) => {
      mergeCalls.push(o)
      return { merged: true, testsPassed: true, branch: o.branch, receipt: { branch: o.branch, testsPassed: true } }
    }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { casExec, verbRunner, repoDir: '/repo' } })

    const first = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-77' },
    })
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.body).merged).toBe(true)
    // the merge verb ran on wt/<taskId> (grep-visible: verbRunner + branch)
    expect(mergeCalls[0].branch).toBe('wt/R-77')

    const second = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-77' },
    })
    expect(second.statusCode).toBe(409) // lost the CAS race — surfaced honestly
  })

  it('a bad taskId → 400', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { casExec: makeCasExec('awaiting_approval'), verbRunner: async () => ({ merged: true }) },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'bad id!' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('server.mjs — POST /api/return (re-queue with the comment)', () => {
  it('re-enqueues with source return, the note, and attempt+1', async () => {
    const enqueued: any[] = []
    const adapter = {
      list: async () => [{ id: 'R-5', attempt: 2, status: 'awaiting_approval' }],
      enqueue: async (t: any) => { enqueued.push(t); return { id: t.id } },
    }
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter, casExec: makeCasExec('awaiting_approval') },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/return',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-5', note: 'переделай вывод' },
    })
    expect(res.statusCode).toBe(200)
    expect(enqueued[0]).toMatchObject({ id: 'R-5', source: 'return', note: 'переделай вывод', attempt: 3 })
  })

  it('an oversized note (> 2000) → 400', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { list: async () => [], enqueue: async () => ({}) }, casExec: makeCasExec('awaiting_approval') },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/return',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-5', note: 'x'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── Plan 11: the five D-9.5-09 harness handlers (the frozen 14-route table unchanged) ──

const jsonHeaders = () => ({ ...bearer(), 'content-type': 'application/json' })

describe('server.mjs — the harness routes still fill the FROZEN fourteen (no route added)', () => {
  it('the five harness routes are handlers, not 501 stubs; the table is still exactly 14', () => {
    expect(Object.keys(ROUTES)).toHaveLength(14)
    for (const r of ['GET /api/harness', 'POST /api/forge', 'POST /api/agent/toggle', 'POST /api/skill/assign', 'POST /api/mcp/toggle']) {
      expect(ROUTES[r]).toBeTruthy()
    }
  })
})

describe('server.mjs — GET /api/harness', () => {
  it('returns the readHarness explicit-pick payload', async () => {
    const readHarness = async () => ({ agents: [{ id: 'creator', enabled: true }], skills: [], mcp: [], drafts: [] })
    const loadMcpRegistry = () => ({ servers: [] })
    const front = createFrontServer({ config: { token: TOKEN }, deps: { readHarness, loadMcpRegistry } })
    const res = await call(front, { url: '/api/harness', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).agents[0].id).toBe('creator')
  })
})

describe('server.mjs — POST /api/forge', () => {
  it('enqueues a lane-forge task with the description intact, minted F-<epochMs>, → 202', async () => {
    const enqueued: any[] = []
    const adapter = { enqueue: async (t: any) => { enqueued.push(t); return { id: t.id } } }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, clock: () => 999 } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/forge',
      headers: jsonHeaders(),
      body: { kind: 'agent', description: 'сделай агента, который парсит Twitter' },
    })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).id).toBe('F-999')
    expect(enqueued[0]).toMatchObject({ id: 'F-999', source: 'roster', lane: 'forge', forge: { kind: 'agent', description: 'сделай агента, который парсит Twitter' } })
  })

  it('a description over 2000 chars → 400; a kind outside DRAFT_KINDS → 400', async () => {
    const adapter = { enqueue: async () => ({ id: 'x' }) }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, clock: () => 1 } })
    const big = await call(front, { method: 'POST', url: '/api/forge', headers: jsonHeaders(), body: { kind: 'agent', description: 'x'.repeat(2001) } })
    expect(big.statusCode).toBe(400)
    const badKind = await call(front, { method: 'POST', url: '/api/forge', headers: jsonHeaders(), body: { kind: 'bogus', description: 'ok' } })
    expect(badKind.statusCode).toBe(400)
  })
})

describe('server.mjs — POST /api/agent/toggle', () => {
  it('an unknown id with no definition file → 404 (the applier error maps)', async () => {
    const applyAgentToggle = () => {
      const e: any = new Error('no definition file')
      e.name = 'MissingDefinitionFileError'
      throw e
    }
    const front = createFrontServer({ config: { token: TOKEN, workers: [] }, deps: { applyAgentToggle } })
    const res = await call(front, { method: 'POST', url: '/api/agent/toggle', headers: jsonHeaders(), body: { id: 'ghost', enabled: true } })
    expect(res.statusCode).toBe(404)
  })

  it('a non-boolean enabled → 400', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: { applyAgentToggle: () => ({ workers: [] }) } })
    const res = await call(front, { method: 'POST', url: '/api/agent/toggle', headers: jsonHeaders(), body: { id: 'max-2', enabled: 'yes' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('server.mjs — POST /api/skill/assign', () => {
  it('more than 16 workerIds → 400', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: { applySkillAssign: () => ({ workers: [] }) } })
    const workerIds = Array.from({ length: 17 }, (_, i) => `w-${i}`)
    const res = await call(front, { method: 'POST', url: '/api/skill/assign', headers: jsonHeaders(), body: { skillId: 'twitter-digest', workerIds } })
    expect(res.statusCode).toBe(400)
  })
})

describe('server.mjs — POST /api/mcp/toggle (RCE-closed)', () => {
  it('a smuggled `command` key → 400 BEFORE any applier call (zero applier invocations)', async () => {
    const applierCalls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        loadMcpRegistry: () => ({ servers: [{ id: 'twitter', enabled: false }] }),
        applyMcpToggle: (a: any) => { applierCalls.push(a); return { servers: [] } },
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/mcp/toggle',
      headers: jsonHeaders(),
      body: { serverId: 'twitter', enabled: true, command: 'rm -rf /' },
    })
    expect(res.statusCode).toBe(400)
    expect(applierCalls).toHaveLength(0) // the applier was NEVER reached
  })

  it('a clean boolean toggle → 200 with the updated slice', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        loadMcpRegistry: () => ({ servers: [{ id: 'twitter', enabled: false }] }),
        applyMcpToggle: () => ({ servers: [{ id: 'twitter', enabled: true }] }),
      },
    })
    const res = await call(front, { method: 'POST', url: '/api/mcp/toggle', headers: jsonHeaders(), body: { serverId: 'twitter', enabled: true } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).mcp).toEqual({ id: 'twitter', enabled: true })
  })
})
